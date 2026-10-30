// The multiplexing proxy (ported from vedlo's proxy, proxy-race and proxy-errors tests). Upstreams are
// the fake Chrome or bare WebSocket servers on 127.0.0.1; every proxy here is this test's own child.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, connect } from "node:net";
import { statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { CDPConnection } from "../src/cdp.ts";
import { AgentBrowser } from "../src/browser.ts";
import { ChromeUnreachableError } from "../src/errors.ts";
import { resolveOptions, stateDir, type Settings } from "../src/options.ts";
import { isOwnProxy, proxyInfo, proxyUrl, startProxy, stopProxy } from "../src/proxy.ts";
import { FakeChrome } from "./fake-chrome.ts";
import { consumer, type Consumer } from "./helpers.ts";

let fake: FakeChrome, c: Consumer, s: Settings;

before(async () => {
  fake = await FakeChrome.start();
  c = consumer();
  s = resolveOptions(c.options());
  await startProxy(s, fake.ws, 20_000);
});

after(async () => {
  stopProxy(s);
  await fake?.close();
  c?.remove();
});

const alive = (path: string) => new Promise<boolean>((resolve) => {
  const sock = connect(path);
  sock.once("connect", () => { sock.destroy(); resolve(true); });
  sock.once("error", () => resolve(false));
});

/** A consumer whose proxy is stopped and whose folder is removed when `fn` ends. */
async function withConsumer(fn: (s: Settings) => Promise<void>) {
  const other = consumer();
  const settings = resolveOptions(other.options());
  stateDir(settings);
  try { await fn(settings); }
  finally {
    stopProxy(settings);
    for (let i = 0; i < 50 && await alive(settings.socketPath); i++) await new Promise((r) => setTimeout(r, 20));
    other.remove();
  }
}

async function attachBlank(conn: CDPConnection) {
  const { targetId } = await conn.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await conn.send("Target.attachToTarget", { targetId, flatten: true });
  return { targetId, sessionId };
}

test("the socket and the state folder are private to the user", () => {
  assert.equal(statSync(s.socketPath).mode & 0o777, 0o600);
  assert.equal(statSync(s.stateDir).mode & 0o777, 0o700);
  assert.equal(proxyInfo(s)?.upstream, fake.ws);
});

test("two clients share one upstream and get only their own session events", async () => {
  const a = await CDPConnection.connect(proxyUrl(s));
  const b = await CDPConnection.connect(proxyUrl(s));
  const sa = await attachBlank(a);
  const sb = await attachBlank(b);
  const seenByB: string[] = [];
  b.on("Runtime.consoleAPICalled", (_, sid) => seenByB.push(sid!));
  await a.send("Runtime.enable", {}, sa.sessionId);
  await b.send("Runtime.enable", {}, sb.sessionId);
  const got = a.waitForEvent("Runtime.consoleAPICalled", { sessionId: sa.sessionId });
  await a.send("Runtime.evaluate", { expression: "console.log('hi')" }, sa.sessionId);
  assert.equal((await got).args[0].value, "hi");
  // ids are remapped independently: both clients can use the same request ids
  const [ra, rb] = await Promise.all([
    a.send("Runtime.evaluate", { expression: "1+1", returnByValue: true }, sa.sessionId),
    b.send("Runtime.evaluate", { expression: "2+2", returnByValue: true }, sb.sessionId),
  ]);
  assert.equal(ra.result.value, 2);
  assert.equal(rb.result.value, 4);
  assert.ok(!seenByB.includes(sa.sessionId));
  assert.equal(fake.connections, 1, "one upstream connection for both clients");
  await a.send("Target.closeTarget", { targetId: sa.targetId });
  await b.send("Target.closeTarget", { targetId: sb.targetId });
  await a.close();
  await b.close();
});

test("a session Chrome attaches through a client's session (a page's worker) belongs to that client only", async () => {
  const a = await CDPConnection.connect(proxyUrl(s));
  const b = await CDPConnection.connect(proxyUrl(s));
  try {
    const sa = await attachBlank(a);
    await attachBlank(b);
    const page = fake.pages.get(sa.targetId)!;
    page.workers.push("http://127.0.0.1/worker.js");
    const seenByB: string[] = [];
    b.on("Target.attachedToTarget", () => seenByB.push("attached"));
    b.on("Network.requestWillBeSent", () => seenByB.push("request"));
    const attached = a.waitForEvent("Target.attachedToTarget", { sessionId: sa.sessionId });
    await a.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sa.sessionId);
    const child = (await attached).sessionId as string;
    await a.send("Network.enable", {}, child);
    const request = a.waitForEvent("Network.requestWillBeSent", { sessionId: child });
    fake.traffic(page, { url: "http://127.0.0.1/api/calc" }, { worker: true });
    assert.equal((await request).request.url, "http://127.0.0.1/api/calc", "the worker's events reach the client that owns the page's session");
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(seenByB, [], "and no other client");
    await a.send("Target.closeTarget", { targetId: sa.targetId });
  } finally {
    await a.close();
    await b.close();
  }
});

test("a departing client's sessions are detached upstream", async () => {
  const a = await CDPConnection.connect(proxyUrl(s));
  const { targetId } = await attachBlank(a);
  await a.close();
  const b = await CDPConnection.connect(proxyUrl(s));
  await new Promise((r) => setTimeout(r, 200));
  const { targetInfos } = await b.send("Target.getTargets");
  assert.equal(targetInfos.find((x: { targetId: string }) => x.targetId === targetId).attached, false);
  await b.send("Target.closeTarget", { targetId });
  await b.close();
});

test("a live socket is never removed by another proxy startup", () => withConsumer(async (t) => {
  const server = createServer((sock) => sock.end());
  await new Promise<void>((resolve) => server.listen(t.socketPath, resolve));
  try {
    await startProxy(t, "ws://127.0.0.1:9/devtools/browser/unused", 1_000);
    assert.equal(await alive(t.socketPath), true);
    assert.equal(proxyInfo(t), undefined, "no second proxy was started");
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}));

test("startup reuses a peer socket that wins while the new child connects upstream", () => withConsumer(async (t) => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => upstream.once("listening", () => resolve()));
  const peer = createServer((socket) => socket.end());
  let connections = 0;
  upstream.on("connection", () => {
    connections++;
    // Bind before the child receives its WebSocket open event. Its second socket check sees the peer.
    peer.listen(t.socketPath);
  });
  const port = (upstream.address() as { port: number }).port;
  try {
    await startProxy(t, `ws://127.0.0.1:${port}`, 10_000);
    assert.equal(await alive(t.socketPath), true);
    assert.equal(connections, 1);
    assert.equal(proxyInfo(t), undefined, "the peer has no child-owned metadata");
  } finally {
    if (peer.listening) await new Promise<void>((resolve) => peer.close(() => resolve()));
    for (const client of upstream.clients) client.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
}));

for (const mode of ["agent", "personal"] as const) {
  test(`proxy startup failure identifies ${mode} Chrome`, () => withConsumer(async (t) => {
    await assert.rejects(startProxy({ ...t, mode }, "ws://127.0.0.1:9/devtools/browser/unavailable", 3_000), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, new RegExp(`chrome proxy did not start \\(${mode} Chrome:`));
      assert.match(error.message, /chrome-proxy\.log/);
      if (mode === "agent") assert.doesNotMatch(error.message, /personal Chrome/);
      return true;
    });
  }));

  test(`an unreachable ${mode} Chrome is reported with the consumer's own command, and nothing is launched`, () => withConsumer(async (t) => {
    const opts = { ...t, mode, endpoint: "ws://127.0.0.1:9/devtools/browser/unavailable", commandName: "vedlo browser", noLaunch: true, allow: ["example.org"] };
    await assert.rejects(AgentBrowser.connect(opts), (error: unknown) => {
      assert.ok(error instanceof ChromeUnreachableError);
      assert.match(error.message, new RegExp(`Could not reach Chrome \\(mode ${mode}\\)`));
      assert.match(error.message, /chrome:\/\/inspect\/#remote-debugging/);
      assert.match(error.message, mode === "agent" ? /vedlo browser launch/ : /vedlo browser --mode personal connect/);
      return true;
    });
  }));
}

test("simultaneous callers elect one proxy and one upstream connection", () => withConsumer(async (t) => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => upstream.once("listening", () => resolve()));
  let connections = 0;
  upstream.on("connection", () => { connections++; });
  const port = (upstream.address() as { port: number }).port;
  try {
    writeFileSync(t.socketPath, "stale socket pathname");
    await Promise.all(Array.from({ length: 4 }, () => startProxy(t, `ws://127.0.0.1:${port}`, 10_000)));
    assert.equal(await alive(t.socketPath), true);
    assert.equal(connections, 1);
    assert.ok(proxyInfo(t)?.pid);
  } finally {
    stopProxy(t);
    for (const client of upstream.clients) client.close();
    upstream.close();
  }
}));

test("the proxy exits when its Chrome closes the connection, and removes its socket", () => withConsumer(async (t) => {
  const own = await FakeChrome.start();
  await startProxy(t, own.ws, 10_000);
  const pid = proxyInfo(t)!.pid;
  await own.close();
  for (let i = 0; i < 100 && await alive(t.socketPath); i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(await alive(t.socketPath), false);
  let running = true;
  for (let i = 0; i < 100 && running; i++) { try { process.kill(pid, 0); await new Promise((r) => setTimeout(r, 20)); } catch { running = false; } }
  assert.equal(running, false, "the proxy process is gone");
  assert.equal(proxyInfo(t), undefined);
}));

test("stop signals only this consumer's own proxy, never a process that took a stale pid", () => withConsumer(async (t) => {
  const { spawn } = await import("node:child_process");
  const stranger = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  try {
    writeFileSync(join(t.stateDir, "chrome-proxy.json"), JSON.stringify({ pid: stranger.pid, upstream: "ws://stale" }));
    assert.equal(isOwnProxy(t, stranger.pid!), false);
    assert.equal(stopProxy(t), false, "a stale pid file names someone else's process");
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(stranger.exitCode, null, "and that process was not signalled");
    assert.equal(stranger.signalCode, null);
  } finally { stranger.kill("SIGKILL"); }
}));
