// Connection diagnostics and the notify hook (ported from vedlo's diagnostics.test.ts). The
// transports and processes here are private fixtures: they never start Chrome, and a notify
// command writes only into this test's temp folder.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { CHROME_BETA_BIN } from "../src/agent.ts";
import { AgentBrowser } from "../src/browser.ts";
import { commands } from "../src/commands.ts";
import { browserTarget, lastProxyAttempt, localBrowserStatus, notifyBrowserStatus, proxyLogPath, recordProxyAttempt } from "../src/diagnostics.ts";
import { resolveOptions, stateDir, type Settings } from "../src/options.ts";
import { runProxy, startProxy } from "../src/proxy.ts";
import { consumer, type Consumer } from "./helpers.ts";

let c: Consumer, s: Settings;

before(() => {
  c = consumer(["example.org"]);
  s = resolveOptions(c.options({ chromeBin: "/fixture/Google Chrome Beta" }));
  stateDir(s);
});
after(() => c.remove());

const records = () => (existsSync(proxyLogPath(s)) ? readFileSync(proxyLogPath(s), "utf8") : "").split("\n")
  .flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });

function fakeChild() {
  const child = Object.assign(new EventEmitter(), {
    pid: 424242, exitCode: null as number | null, signalCode: null as string | null,
    unref() {}, kill(signal: string) { child.signalCode = signal; child.emit("exit", null, signal); return true; },
  });
  return child;
}

test("refused upstream records a parent attempt, child attempt, endpoint, target, step and child exit", async () => {
  const upstream = "ws://127.0.0.1:9/devtools/browser/unavailable";
  await assert.rejects(startProxy(s, upstream, 3000));
  const rows = records();
  const start = rows.find((row) => row.phase === "parent-start");
  assert.ok(start, "the parent records an attempt before spawning its child");
  assert.equal(start.upstream, upstream);
  assert.match(start.target, /agent.*Chrome Beta/);
  const child = rows.find((row) => row.attempt === start.attempt && row.phase === "child-connect");
  assert.ok(child, "the child records its handshake before waiting");
  assert.equal(child.upstream, upstream);
  assert.ok(rows.some((row) => row.attempt === start.attempt && row.phase === "child-error"));
  assert.ok(rows.some((row) => row.attempt === start.attempt && row.phase === "parent-exit" && row.code === 1));
  assert.doesNotMatch(readFileSync(proxyLogPath(s), "utf8"), /approval pending|approve its prompt/);
});

test("existing-only connection refuses before any endpoint or new proxy attempt", async () => {
  const before = readFileSync(proxyLogPath(s), "utf8");
  await assert.rejects(AgentBrowser.connect({ ...s, endpoint: "ws://127.0.0.1:9/devtools/browser/must-not-connect" }, { existingOnly: true }), /no usable existing Chrome proxy/);
  assert.equal(readFileSync(proxyLogPath(s), "utf8"), before);
});

test("a failed spawn reports its step and records the error instead of claiming approval", async () => {
  const child = fakeChild();
  await assert.rejects(startProxy(s, "ws://fixture/spawn", 500, { spawn: (() => {
    queueMicrotask(() => child.emit("error", new Error("ENOENT fixture")));
    return child;
  }) as never }), /proxy spawn failed: ENOENT fixture/);
  const row = lastProxyAttempt(s);
  assert.equal(row?.phase, "parent-spawn-error");
  assert.match(row?.detail ?? "", /ENOENT fixture/);
  assert.equal(row?.approval, "unknown");
});

test("a signal exit is distinct from an exit code and records its exact signal", async () => {
  const child = fakeChild();
  await assert.rejects(startProxy(s, "ws://fixture/signal", 500, { spawn: (() => {
    queueMicrotask(() => { child.signalCode = "SIGABRT"; child.emit("exit", null, "SIGABRT"); });
    return child;
  }) as never }), /proxy exited with SIGABRT/);
  assert.equal(lastProxyAttempt(s)?.phase, "parent-exit");
  assert.equal(lastProxyAttempt(s)?.signal, "SIGABRT");
  assert.equal(lastProxyAttempt(s)?.code, null);
});

test("startup timeout stops only its own child and retains approval uncertainty", async () => {
  const child = fakeChild(), signals: string[] = [];
  child.kill = (signal) => { signals.push(signal); child.signalCode = signal; child.emit("exit", null, signal); return true; };
  await assert.rejects(startProxy(s, "ws://fixture/pending", 500, { spawn: (() => child) as never }), /startup timed out.*approval status unknown/);
  assert.deepEqual(signals, ["SIGTERM"]);
  assert.ok(records().some((row) => row.phase === "parent-timeout" && row.child === 424242));
});

test("the child's upstream handshake has a deadline and logs connection failure before ready", async () => {
  const held = new Set<import("node:net").Socket>();
  const http = createServer();
  http.on("connection", (socket) => { held.add(socket); socket.on("close", () => held.delete(socket)); });
  http.on("upgrade", () => {}); // A silent peer has no approval evidence.
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  try {
    const port = (http.address() as { port: number }).port;
    await assert.rejects(runProxy(s, `ws://127.0.0.1:${port}`, { attempt: "held-handshake", timeoutMs: 30 }), /handshake.*timed out/i);
    assert.equal(lastProxyAttempt(s)?.phase, "child-error");
    assert.equal(lastProxyAttempt(s)?.attempt, "held-handshake");
    assert.match(lastProxyAttempt(s)?.detail ?? "", /approval status unknown/);
  } finally {
    for (const socket of held) socket.destroy();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }
});

test("target names the running channel, and labels the configured channel when no process is found", () => {
  const beta = resolveOptions({ ...s, chromeBin: CHROME_BETA_BIN });
  assert.match(browserTarget(beta, () => `  42 ${CHROME_BETA_BIN} --user-data-dir=${s.profileDir}`), /agent browser on Google Chrome Beta \(pid 42\)/);
  assert.match(browserTarget(s, () => ""), /configured binary Google Chrome Beta; running channel unknown/);
  assert.equal(browserTarget({ ...s, mode: "personal" }, () => { throw new Error("must not inspect processes"); }), "personal Chrome: operator's Chrome");
});

test("local diagnosis distinguishes no Chrome, no endpoint, and an endpoint without an approved proxy", async () => {
  const target = () => "agent Chrome fixture";
  assert.match(await localBrowserStatus(s, { target, pid: () => undefined, endpoint: async () => undefined }), /no running Chrome found/);
  assert.match(await localBrowserStatus(s, { target, pid: () => 42, endpoint: async () => undefined }), /Chrome pid 42; no live DevTools endpoint/);
  const result = await localBrowserStatus(s, { target, pid: () => 42, endpoint: async () => "ws://fixture" });
  assert.match(result, /DevTools endpoint found; proxy not connected; approval status unknown/);
  assert.match(result, /last attempt .*held-handshake: child-error/);
  assert.match(result, /run agent-browser tabs to connect/);
});

test("status without a proxy never opens the configured upstream or starts Chrome", async () => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => upstream.once("listening", () => resolve()));
  let connections = 0;
  upstream.on("connection", (socket) => { connections++; socket.close(); });
  try {
    const r = await commands.status({ ...s, endpoint: `ws://127.0.0.1:${(upstream.address() as { port: number }).port}`, noLaunch: true });
    assert.equal(connections, 0);
    assert.equal(r.connected, false);
    assert.match(r.detail ?? "", /proxy not connected.*approval status unknown/);
    assert.equal(r.notification, null);
    await assert.rejects(commands.status(s, { notify: true }), /needs a notify hook/);
  } finally { await new Promise<void>((resolve) => upstream.close(() => resolve())); }
});

test("existing-only status reuses a private approved proxy", async () => {
  const server = createServer(), wss = new WebSocketServer({ server });
  wss.on("connection", (client) => client.on("message", (data) => {
    const msg = JSON.parse(String(data));
    client.send(JSON.stringify({ id: msg.id, result: msg.method === "Browser.getVersion" ? { product: "FixtureChrome/1" } : { targetInfos: [] } }));
  }));
  await new Promise<void>((resolve) => server.listen(s.socketPath, resolve));
  try {
    const r = await commands.status(s);
    assert.equal(r.connected, true);
    assert.equal(r.product, "FixtureChrome/1");
    assert.equal(r.allowedTabs, 0);
    assert.deepEqual(r.allowlist, ["example.org"]);
  } finally {
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("the notify hook: one attempt, as a callback or as a command, and an uncertain transport reported truthfully", async () => {
  const got: string[] = [];
  assert.deepEqual(await notifyBrowserStatus(s, "approval status unknown", (m) => { got.push(m); }), { delivery: "queued", detail: "notification queued" });
  assert.deepEqual(got, ["agent-browser connection needs attention: approval status unknown"]);
  assert.match((await notifyBrowserStatus(s, "x", () => { throw new Error("transport"); })).detail, /unconfirmed.*outcome unknown/);
  assert.match((await notifyBrowserStatus(s, "x", undefined)).detail, /no notify hook configured/);

  const out = join(c.dir, "notified.txt"), stdinOut = join(c.dir, "notified-stdin.txt");
  const write = "const fs = require('node:fs'); fs.writeFileSync(process.argv[1], process.argv[2]); fs.writeFileSync(process.argv[3], fs.readFileSync(0, 'utf8'));";
  const r = await notifyBrowserStatus(s, "pending", { command: [process.execPath, "-e", write, out, "inbox: {message}", stdinOut] });
  assert.deepEqual(r, { delivery: "queued", detail: "notification queued" });
  assert.equal(readFileSync(out, "utf8"), "inbox: agent-browser connection needs attention: pending", "{message} is replaced in argv");
  assert.equal(readFileSync(stdinOut, "utf8"), "agent-browser connection needs attention: pending", "and the message is on stdin");
  assert.match((await notifyBrowserStatus(s, "x", { command: [process.execPath, "-e", "process.exit(6)"] })).detail, /unconfirmed \(exit 6\)/);
  assert.match((await notifyBrowserStatus(s, "x", { command: [join(c.dir, "no-such-program")] })).detail, /unconfirmed \(ENOENT; outcome unknown/);
});

test("diagnosis keeps the failure cause after its child's termination record", async () => {
  const row = { attempt: "causal-timeout", target: "agent Chrome fixture", upstream: "ws://fixture" };
  recordProxyAttempt(s, { ...row, phase: "parent-timeout", detail: "upstream handshake timed out; approval status unknown" });
  recordProxyAttempt(s, { ...row, phase: "parent-exit", code: null, signal: "SIGTERM" });
  const deps = { target: () => "fixture", pid: () => undefined, endpoint: async () => undefined };
  assert.match(await localBrowserStatus(s, deps), /parent-timeout.*signal=SIGTERM.*upstream handshake timed out/);
  const refused = { ...row, attempt: "causal-refusal" };
  recordProxyAttempt(s, { ...refused, phase: "child-error", detail: "upstream handshake failed: ECONNREFUSED" });
  recordProxyAttempt(s, { ...refused, phase: "parent-exit", code: 1, signal: null });
  assert.match(await localBrowserStatus(s, deps), /child-error.*exit=1.*ECONNREFUSED/);
});

test("a configured endpoint override remains unverified and cannot borrow a profile channel", async () => {
  const o = resolveOptions({ ...s, endpoint: "ws://127.0.0.1:9/devtools/browser/stale-override" });
  const target = browserTarget(o, () => `42 ${CHROME_BETA_BIN} --user-data-dir=${o.profileDir}`);
  assert.match(target, /endpoint override.*channel unknown/);
  assert.doesNotMatch(target, /agent browser on Google Chrome Beta/);
  const result = await localBrowserStatus(o, { pid: () => undefined, endpoint: async () => { throw new Error("must not probe the profile for an override"); } });
  assert.match(result, /endpoint override configured \(unverified\)/);
  assert.doesNotMatch(result, /DevTools endpoint found|no running Chrome found/);
});

test("Chrome's instant 403 (no prompt) is named, with the fix, in the log and in the caller's error", async () => {
  const other = consumer(["example.org"]);
  const t = resolveOptions(other.options({ chromeBin: "/fixture/Google Chrome Beta" }));
  stateDir(t);
  // What Chrome Beta 158 answers when this Chrome run holds an earlier refusal: at once, no prompt.
  const http = createServer();
  http.on("upgrade", (_req, socket) => { socket.end("HTTP/1.1 403 Forbidden\r\nContent-Type: text/html\r\nContent-Length: 19\r\n\r\nConnection rejected"); });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  try {
    const upstream = `ws://127.0.0.1:${(http.address() as { port: number }).port}/devtools/browser/fixture`;
    await assert.rejects(runProxy(t, upstream, { attempt: "refused", timeoutMs: 5000 }), /403/);
    assert.match(lastProxyAttempt(t)?.detail ?? "", /refused the connection without a prompt.*run `agent-browser quit`, then `agent-browser launch`, and click Allow/);
    assert.equal(lastProxyAttempt(t)?.approval, "refused", "the evidence is recorded: refused, not unknown");
    await assert.rejects(startProxy(t, upstream, 20_000),
      /proxy exited with 1 before its socket was ready: upstream handshake failed: Unexpected server response: 403: Chrome refused the connection without a prompt/);
    // Through the library and the CLI: the cause and its fix, not "enable remote debugging".
    await assert.rejects(AgentBrowser.connect({ ...t, endpoint: upstream }), (e: Error) =>
      e.name === "ChromeUnreachableError" && /refused the connection without a prompt/.test(e.message) && !/enable\s+remote debugging/.test(e.message));
  } finally {
    await new Promise<void>((resolve) => http.close(() => resolve()));
    other.remove();
  }
});
