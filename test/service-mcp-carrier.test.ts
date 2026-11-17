// The carrier and the remote admission on the agent door (stage 5 T4, board ab-v16.94.7.5; the plan
// docs/superpowers/plans/2026-11-16-stage-5-remote-scopes.md, task T4; contract C11, "The remote MCP path (stage 5)";
// C12, the hello's feature remote_scopes). The remote path's tests run the relay's endpoint with a fake carrier (an
// injected carrier rule), the real remote admission and the real MCP transport with its test worker
// (test/fixtures/mcp-answer-worker.ts: no Playwright, no browser). The carrier rule's vectors run the real rule (the
// control door's rules 1 to 4 with the gateway's pid and command file) with real processes of this test: a fake gateway
// (the "job"), its direct child and a grandchild. Every folder is a temp folder of the test, and every token a made-up
// test value.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { PassThrough, Writable } from "node:stream";
import { FROM_PAGE, NOT_FOUND, REMOTE_ONLY_MCP, startRelay, type Relay } from "../src/relay/endpoint.ts";
import { selfTest, sessionRefusal } from "../src/relay/peer.ts";
import { loadPidfdOpen } from "../src/service/admission.ts";
import * as ADM from "../src/service/admission.ts";
import { readAllowList } from "../src/service/mcp/allow-list.ts";
import { MCP_TEXT, WWW_AUTHENTICATE, type McpReadiness } from "../src/service/mcp/admission.ts";
import type { McpHandler } from "../src/service/mcp/port.ts";
import { MCP_ANSWER, McpTransport } from "../src/service/mcp/transport.ts";

const LIST = readAllowList();
const FIXTURE = new URL("./fixtures/mcp-answer-worker.ts", import.meta.url);
const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test-client", version: "0" } } };
const NODE = realpathSync(process.execPath);
const linux = process.platform === "linux";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The plan's new first 401 of the remote MCP path (C11, "The remote MCP path"). */
const NEEDS_REMOTE_TOKEN = "The agent browser of this box needs the session's remote connection token. agentwatch adds it to each session that it launches while its box has the browser grant.";
/** The remote MCP path's own Host 403 (C11, check 2; board ab-v16.94.7.9): only `Host: localhost` passes there. */
const REMOTE_BAD_HOST = "The agent browser's remote MCP path admits only the Host localhost.";
const fp = (token: string) => createHash("sha256").update(token, "latin1").digest("hex");
/** Made-up test tokens of the remote form, and a local session's. */
const TOKEN = { a: `abt1_${"a".repeat(43)}`, b: `abt1_${"b".repeat(43)}`, a2: `abt1_${"c".repeat(43)}`, local: `abt1_${"d".repeat(43)}` };
const ITEM = { a: { scope: "box1/web-9", box: "box1", list: "grant-box1", mcp_token: fp(TOKEN.a) }, b: { scope: "box2/web-9", box: "box2", list: "grant-box2", mcp_token: fp(TOKEN.b) } };
const LOCAL = { scope: "web-1", repo: "owner/repo", roots: [], cgroup: null, lifetime_id: null, mcp_token: fp(TOKEN.local) };
const snapshot = (remote: object[], sessions: object[] = [LOCAL]) => ({ t: "req" as const, id: "s", op: "set_sessions", by: { kind: "daemon", user: "ann", via: "daemon" } as never, sessions, remote, box: { hosts: [], cookie_names: [] } });
const READY: McpReadiness = { controlOff: false, notReady: null, sites: 1 };

// ------------------------------------------------------------------ a raw HTTP client on the agent door's socket

type Answer = { status: number; headers: Record<string, string>; body: string };
/** One connection; `ask` sends one request and reads its answer (Content-Length, or the body up to the close). */
class Raw {
  private buf = Buffer.alloc(0);
  private wake: (() => void) | null = null;
  closed = false;
  readonly s: Socket;
  private constructor(s: Socket) {
    this.s = s;
    s.on("data", (d: Buffer) => { this.buf = Buffer.concat([this.buf, d]); this.wake?.(); });
    s.on("close", () => { this.closed = true; this.wake?.(); });
    s.on("error", () => {});
  }
  static open(path: string): Promise<Raw> {
    return new Promise((resolve, reject) => { const s = connect(path); s.once("connect", () => resolve(new Raw(s))); s.once("error", reject); });
  }
  private async more(): Promise<void> {
    if (this.closed) throw new Error("the connection closed");
    await new Promise<void>((r) => { this.wake = () => { this.wake = null; r(); }; });
  }
  async ask(text: string, ms = 30_000): Promise<Answer> {
    this.s.write(text);
    const end = Date.now() + ms;
    let head = -1;
    while ((head = this.buf.indexOf("\r\n\r\n")) < 0) { if (Date.now() > end) throw new Error("no answer"); await this.more(); }
    const lines = this.buf.subarray(0, head).toString("latin1").split("\r\n");
    const status = Number(lines[0].split(" ")[1]);
    const headers: Record<string, string> = {};
    for (const l of lines.slice(1)) { const i = l.indexOf(":"); headers[l.slice(0, i).toLowerCase()] = l.slice(i + 1).trim(); }
    const len = headers["content-length"] !== undefined ? Number(headers["content-length"]) : null;
    if (headers["transfer-encoding"] === "chunked") {
      // The endpoint's plain answers (Node's chunked framing): each chunk up to the last one of size 0.
      let at = head + 4, body = "";
      for (;;) {
        let nl: number;
        while ((nl = this.buf.indexOf("\r\n", at)) < 0) await this.more();
        const size = parseInt(this.buf.subarray(at, nl).toString("latin1"), 16);
        while (this.buf.length < nl + 2 + size + 2) await this.more();
        body += this.buf.subarray(nl + 2, nl + 2 + size).toString("utf8");
        at = nl + 2 + size + 2;
        if (size === 0) break;
      }
      this.buf = this.buf.subarray(at);
      return { status, headers, body };
    }
    if (len !== null) {
      while (this.buf.length < head + 4 + len) await this.more();
      const body = this.buf.subarray(head + 4, head + 4 + len).toString("utf8");
      this.buf = this.buf.subarray(head + 4 + len);
      return { status, headers, body };
    }
    while (!this.closed) await this.more().catch(() => {});
    const body = this.buf.subarray(head + 4).toString("utf8");
    this.buf = Buffer.alloc(0);
    return { status, headers, body };
  }
  /** Resolves when the service closed this connection (or false after `ms`). */
  async closes(ms = 2000): Promise<boolean> {
    const end = Date.now() + ms;
    while (!this.closed && Date.now() < end) await Promise.race([this.more().catch(() => {}), sleep(50)]);
    return this.closed;
  }
  end(): void { this.s.destroy(); }
}
/** A request's text: the method, the path, exactly the given header lines (Host: localhost unless `host` says else), and a JSON body. */
function rq(method: string, path: string, o: { host?: string[]; auth?: string | null; origin?: string; sid?: string; body?: unknown; upgrade?: boolean } = {}): string {
  const body = o.body === undefined ? "" : JSON.stringify(o.body);
  const lines = [`${method} ${path} HTTP/1.1`];
  for (const h of o.host ?? ["localhost"]) lines.push(`Host: ${h}`);
  if (o.auth) lines.push(`Authorization: Bearer ${o.auth}`);
  if (o.origin) lines.push(`Origin: ${o.origin}`);
  if (o.sid) lines.push(`Mcp-Session-Id: ${o.sid}`);
  if (o.upgrade) lines.push("Connection: Upgrade", "Upgrade: websocket", "Sec-WebSocket-Version: 13", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==");
  if (body) lines.push("Content-Type: application/json", `Content-Length: ${Buffer.byteLength(body)}`);
  else if (method === "POST") lines.push("Content-Length: 0");
  return `${lines.join("\r\n")}\r\n\r\n${body}`;
}
const call = (id: number, name: string, args: Record<string, unknown> = {}) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

// ------------------------------------------------------------------ the rig: the relay with a fake carrier rule

type Rig = {
  dir: string; sock: string; relay: Relay; transport: McpTransport; logs: string[];
  /** Each call of the handler: its method, scope and admission word. */
  calls: { method: string; scope: string; admission: string | undefined }[];
  /** The scopes whose MCP sessions the handler ended. */
  ended: string[];
  /** The next connections' carrier verdict (read at each accept). */
  carrier: { now: boolean; pid: number };
  readiness: { now: McpReadiness };
  remote: any;
};
async function withRig(o: { switchOff?: boolean }, f: (r: Rig) => Promise<void>): Promise<void> {
  const REMOTE = await import("../src/service/mcp/remote.ts");
  const dir = mkdtempSync(join(tmpdir(), "ab-carrier-"));
  const sock = join(dir, "cdp.sock"), logs: string[] = [];
  const transport = new McpTransport({ list: LIST, stateFolder: join(dir, "state"), ticketUrl: () => null, log: (l) => logs.push(l), worker: { heapMb: 64, entry: FIXTURE } });
  const calls: Rig["calls"] = [], ended: string[] = [];
  const handler: McpHandler = {
    request: (req, res, scope, browser, admission) => { calls.push({ method: req.method ?? "", scope, admission }); return transport.request(req, res, scope, browser, admission); },
    endSessions: (scope) => { ended.push(scope); transport.endSessions(scope); },
  };
  const carrier = { now: false, pid: 4242 };
  const readiness = { now: READY };
  const remote = new REMOTE.RemoteMcp({ handler, readiness: () => readiness.now, log: (l: string) => logs.push(l) });
  remote.setSessions(snapshot([ITEM.a, ITEM.b]));
  const output = new Writable({ write(_c, _e, done) { done(); } });
  const relay = await startRelay({
    socket: sock, input: new PassThrough(), output, log: (l: string) => logs.push(l),
    ...(o.switchOff ? {} : { carrier: { rule: async () => (carrier.now ? { ok: true as const, pid: carrier.pid } : { ok: false as const, reason: "rule 2 failed (a test peer)" }), request: (req: any, res: any) => remote.request(req, res) } }),
  } as never);
  try { await f({ dir, sock, relay, transport, logs, calls, ended, carrier, readiness, remote }); }
  finally { await relay.stop(); await transport.stop(); rmSync(dir, { recursive: true, force: true }); }
}
/** A connection of the carrier (the rule says yes at its accept), or of another peer. */
async function conn(r: Rig, carrier = true): Promise<Raw> {
  r.carrier.now = carrier;
  const c = await Raw.open(r.sock);
  await sleep(20);
  return c;
}
const json = (a: Answer) => { try { return JSON.parse(a.body); } catch { return null; } };

// ------------------------------------------------------------------ check 1: the method and the path

test("T4: the right token of a listed remote scope passes, with the admission word remote, to the transport (initialize, then a tool call on the MCP session)", { timeout: 60_000 }, async () => {
  await withRig({}, async (r) => {
    const c = await conn(r);
    const init = await c.ask(rq("POST", "/mcp/box1/web-9", { auth: TOKEN.a, body: INIT }));
    assert.equal(init.status, 200, init.body);
    const sid = init.headers["mcp-session-id"];
    assert.match(sid ?? "", /^[0-9a-f]{32}$/);
    const snap = await c.ask(rq("POST", "/mcp/box1/web-9", { auth: TOKEN.a, sid, body: call(2, "browser_snapshot") }));
    assert.equal(snap.status, 200, snap.body);
    assert.match(json(snap)?.result?.content?.[0]?.text ?? "", /mcp-remote\/box1\/web-9\/$/, "the remote scope's own folder");
    assert.deepEqual(r.calls.map((x) => [x.method, x.scope, x.admission]), [["POST", "box1/web-9", "remote"], ["POST", "box1/web-9", "remote"]]);
    const del = await c.ask(rq("DELETE", "/mcp/box1/web-9", { auth: TOKEN.a, sid }));
    assert.ok(del.status < 300, `${del.status} ${del.body}`);
    c.end();
  });
});

test("T4: check 1: a GET of a listed remote scope gets the local transport's 405 (noStream, Allow: POST, DELETE); a GET of a path that is no listed remote scope, a local scope, /mcp alone and a path of no scope get the 404", { timeout: 30_000 }, async () => {
  await withRig({}, async (r) => {
    let c = await conn(r);
    const get = await c.ask(rq("GET", "/mcp/box1/web-9", { auth: TOKEN.a }));
    assert.equal(get.status, 405);
    assert.equal(get.headers.allow, "POST, DELETE");
    assert.equal(json(get)?.error?.message, MCP_ANSWER.noStream);
    assert.equal(c.closed, false, "the 405 keeps the connection");
    for (const [method, path] of [["GET", "/mcp/box3/web-9"], ["POST", "/mcp/web-1"], ["POST", "/mcp"], ["GET", "/mcp"], ["POST", "/mcp/box1/web-9/x"], ["POST", "/mcp/box1/../web-9"], ["POST", "/devtools/browser/web-1"], ["POST", "/"]] as const) {
      if (c.closed) c = await conn(r);
      const a = await c.ask(rq(method, path, { auth: method === "POST" ? TOKEN.local : undefined, body: method === "POST" ? INIT : undefined }));
      assert.equal(a.status, 404, `${method} ${path}: ${a.body}`);
      assert.equal(a.body, MCP_TEXT.notFound, `${method} ${path}`);
      assert.ok(await c.closes(), `${method} ${path}: a refusal closes the connection`);
    }
    assert.deepEqual(r.calls.map((x) => [x.method, x.scope]), [["GET", "box1/web-9"]], "only the 405 reached the transport");
    c.end();
  });
});

// ------------------------------------------------------------------ check 2: no Origin, exactly one Host: localhost

test("T4: check 2: an Origin gets the endpoint's 403; no Host, two Host lines and any Host but localhost get the remote path's own Host 403, not the MCP port's (before the token)", { timeout: 30_000 }, async () => {
  assert.notEqual(REMOTE_BAD_HOST, MCP_TEXT.badHost, "the MCP port's text names 127.0.0.1:<port> and localhost:<port>");
  await withRig({}, async (r) => {
    const cases: [string, Parameters<typeof rq>[2], string][] = [
      ["an Origin", { auth: TOKEN.a, origin: "https://a.example", body: INIT }, FROM_PAGE],
      ["no Host", { host: [], auth: TOKEN.a, body: INIT }, REMOTE_BAD_HOST],
      ["two Host lines", { host: ["localhost", "localhost"], auth: TOKEN.a, body: INIT }, REMOTE_BAD_HOST],
      ["Host localhost:80", { host: ["localhost:80"], auth: TOKEN.a, body: INIT }, REMOTE_BAD_HOST],
      ["Host 127.0.0.1", { host: ["127.0.0.1"], auth: TOKEN.a, body: INIT }, REMOTE_BAD_HOST],
      ["an Origin and no token", { origin: "https://a.example", body: INIT }, FROM_PAGE],
    ];
    for (const [name, o, body] of cases) {
      const c = await conn(r);
      const a = await c.ask(rq("POST", "/mcp/box1/web-9", o));
      assert.deepEqual([a.status, a.body], [403, body], name);
      assert.ok(await c.closes(), `${name}: the connection closes`);
    }
    assert.deepEqual(r.calls, [], "no request reached the transport");
  });
});

// ------------------------------------------------------------------ check 3: the token of the remote item

test("T4: check 3: no bearer gets the new first 401; a wrong token, a token of another remote scope, a local scope's token and a POST of a remote scope that is not listed get the third 401; each 401 has the WWW-Authenticate header", { timeout: 30_000 }, async () => {
  await withRig({}, async (r) => {
    const cases: [string, string, string | null, string][] = [
      ["no bearer", "/mcp/box1/web-9", null, NEEDS_REMOTE_TOKEN],
      ["a wrong token", "/mcp/box1/web-9", `abt1_${"z".repeat(43)}`, MCP_TEXT.unknownToken],
      ["the token of another remote scope", "/mcp/box1/web-9", TOKEN.b, MCP_TEXT.unknownToken],
      ["a local scope's token", "/mcp/box1/web-9", TOKEN.local, MCP_TEXT.unknownToken],
      ["a remote scope that is not listed", "/mcp/box3/web-9", TOKEN.a, MCP_TEXT.unknownToken],
    ];
    for (const [name, path, auth, body] of cases) {
      const c = await conn(r);
      const a = await c.ask(rq("POST", path, { auth, body: INIT }));
      assert.deepEqual([a.status, a.body], [401, body], name);
      assert.equal(a.headers["www-authenticate"], WWW_AUTHENTICATE, name);
      assert.ok(await c.closes(), `${name}: the connection closes`);
    }
    // A DELETE needs the token too.
    const c = await conn(r);
    const d = await c.ask(rq("DELETE", "/mcp/box1/web-9", { auth: TOKEN.b, sid: "0".repeat(32) }));
    assert.deepEqual([d.status, d.body], [401, MCP_TEXT.unknownToken], "a DELETE with another scope's token");
    assert.deepEqual(r.calls, [], "no request reached the transport");
    for (const l of r.logs) for (const t of [...Object.values(TOKEN), ...Object.values(TOKEN).map(fp)]) assert.ok(!l.includes(t), `a log line holds a token or a fingerprint: ${l}`);
  });
});

test("T4: two remote scopes on one carrier connection: each request needs its own scope's token (the check runs at each request)", { timeout: 60_000 }, async () => {
  await withRig({}, async (r) => {
    const c = await conn(r);
    const a = await c.ask(rq("POST", "/mcp/box1/web-9", { auth: TOKEN.a, body: INIT }));
    const b = await c.ask(rq("POST", "/mcp/box2/web-9", { auth: TOKEN.b, body: INIT }));
    assert.deepEqual([a.status, b.status], [200, 200], `${a.body} ${b.body}`);
    assert.equal(c.closed, false, "one connection carries both");
    const cross = await c.ask(rq("POST", "/mcp/box2/web-9", { auth: TOKEN.a, sid: b.headers["mcp-session-id"], body: call(3, "browser_snapshot") }));
    assert.deepEqual([cross.status, cross.body], [401, MCP_TEXT.unknownToken], "box1's token on box2's path");
    assert.deepEqual(r.calls.map((x) => x.scope), ["box1/web-9", "box2/web-9"]);
    c.end();
  });
});

test("T4: a snapshot that changes a remote item's token, or drops it, ends its MCP sessions, and the next request gets the 401; the other item's MCP session goes on", { timeout: 60_000 }, async () => {
  await withRig({}, async (r) => {
    const c = await conn(r);
    const sa = (await c.ask(rq("POST", "/mcp/box1/web-9", { auth: TOKEN.a, body: INIT }))).headers["mcp-session-id"];
    const sb = (await c.ask(rq("POST", "/mcp/box2/web-9", { auth: TOKEN.b, body: INIT }))).headers["mcp-session-id"];
    assert.equal(r.transport.size("box1/web-9"), 1);
    r.remote.setSessions(snapshot([{ ...ITEM.a, mcp_token: fp(TOKEN.a2) }, ITEM.b]));
    assert.deepEqual(r.ended, ["box1/web-9"], "the changed token ends box1's MCP sessions");
    await sleep(50);
    assert.equal(r.transport.size("box1/web-9"), 0);
    const old = await c.ask(rq("POST", "/mcp/box1/web-9", { auth: TOKEN.a, sid: sa, body: call(4, "browser_snapshot") }));
    assert.deepEqual([old.status, old.body], [401, MCP_TEXT.unknownToken], "the old token");
    const c2 = await conn(r);
    assert.equal((await c2.ask(rq("POST", "/mcp/box1/web-9", { auth: TOKEN.a2, body: INIT }))).status, 200, "the new token");
    assert.equal((await c2.ask(rq("POST", "/mcp/box2/web-9", { auth: TOKEN.b, sid: sb, body: call(5, "browser_snapshot") }))).status, 200, "box2 goes on");
    r.remote.setSessions(snapshot([{ ...ITEM.a, mcp_token: fp(TOKEN.a2) }]));
    assert.deepEqual(r.ended, ["box1/web-9", "box2/web-9"], "the drop ends box2's MCP sessions");
    const dropped = await c2.ask(rq("POST", "/mcp/box2/web-9", { auth: TOKEN.b, sid: sb, body: call(6, "browser_snapshot") }));
    assert.deepEqual([dropped.status, dropped.body], [401, MCP_TEXT.unknownToken], "a dropped item's next request");
    c.end(); c2.end();
  });
});

// ------------------------------------------------------------------ check 4: the readiness

test("T4: check 4: control off and a service that is not ready get the 503s of step 8, after the token", { timeout: 30_000 }, async () => {
  await withRig({}, async (r) => {
    r.readiness.now = { controlOff: true, notReady: null, sites: 1 };
    let c = await conn(r);
    let a = await c.ask(rq("POST", "/mcp/box1/web-9", { auth: TOKEN.a, body: INIT }));
    assert.deepEqual([a.status, a.body], [503, MCP_TEXT.controlOff]);
    c = await conn(r);
    a = await c.ask(rq("POST", "/mcp/box1/web-9", { auth: TOKEN.b, body: INIT }));
    assert.equal(a.status, 401, "the token comes first");
    r.readiness.now = { controlOff: false, notReady: "The agent browser is not ready yet (a test text).", sites: 1 };
    c = await conn(r);
    a = await c.ask(rq("POST", "/mcp/box1/web-9", { auth: TOKEN.a, body: INIT }));
    assert.deepEqual([a.status, a.body], [503, "The agent browser is not ready yet (a test text)."]);
    assert.deepEqual(r.calls, []);
  });
});

// ------------------------------------------------------------------ the carrier gets nothing else; other peers stay local

test("T4: the carrier's CDP upgrade gets the 403 (T2's text for a remote scope, the session's 403 for a local scope)", { timeout: 30_000 }, async () => {
  await withRig({}, async (r) => {
    for (const [path, body] of [["/devtools/browser/box1/web-9", REMOTE_ONLY_MCP], ["/devtools/browser/web-1", sessionRefusal(r.carrier.pid)]] as const) {
      const c = await conn(r);
      const a = await c.ask(rq("GET", path, { upgrade: true }));
      assert.deepEqual([a.status, a.body], [403, body], path);
      c.end();
    }
    assert.equal(r.relay.model.connectionCount, 0);
  });
});

test("T4: a peer that is not the carrier keeps today's answers on the agent door: the endpoint's 404 for /mcp/<box>/<session>, with no call of the transport", { timeout: 30_000 }, async () => {
  await withRig({}, async (r) => {
    for (const path of ["/mcp/box1/web-9", "/mcp/web-1", "/mcp"]) {
      const c = await conn(r, false);
      const a = await c.ask(rq("POST", path, { auth: TOKEN.a, body: INIT }));
      assert.deepEqual([a.status, a.body], [404, NOT_FOUND], path);
      c.end();
    }
    assert.deepEqual(r.calls, []);
  });
});

test("T4: with the switch off (no carrier) the agent door is as today: /mcp/<box>/<session> gets the endpoint's 404", { timeout: 30_000 }, async () => {
  await withRig({ switchOff: true }, async (r) => {
    r.carrier.now = true;
    const c = await Raw.open(r.sock);
    const a = await c.ask(rq("POST", "/mcp/box1/web-9", { auth: TOKEN.a, body: INIT }));
    assert.deepEqual([a.status, a.body], [404, NOT_FOUND]);
    c.end();
    assert.deepEqual(r.calls, []);
  });
});

// ------------------------------------------------------------------ the hello's remote_scopes, the status's remote, N4

test("T4: the MCP part lists remote_scopes beside mcp_token only while its carrier rule can run; on the Mac a dropped remote name whose case twin lives (nameEnded) ends its own MCP sessions (N4)", { timeout: 30_000 }, async () => {
  const { McpPart } = await import("../src/service/mcp/part.ts");
  const dir = mkdtempSync(join(tmpdir(), "ab-carrier-part-"));
  try {
    for (const carrier of [false, true]) {
      const p = new McpPart({ listen: { port: 0 }, stateFolder: join(dir, "state"), log: () => {}, list: LIST, ...({ carrier } as object) } as never);
      try {
        assert.deepEqual(p.features(), [], "no port yet");
        await p.open({ url: (s) => `ws+unix:///x:/devtools/browser/${s}`, readiness: () => READY });
        assert.deepEqual(p.features(), carrier ? ["mcp_token", "remote_scopes"] : ["mcp_token"], `carrier ${carrier}`);
        if (carrier) {
          const ended: string[] = [];
          const t = p.mcpTransport!;
          const orig = t.endSessions.bind(t);
          t.endSessions = (s: string) => { ended.push(s); orig(s); };
          (p as any).nameEnded("box1/Web-9");
          (p as any).nameEnded("web-1");
          assert.deepEqual(ended, ["box1/Web-9"], "the remote name's MCP sessions end; a local name's end stays as before");
        }
      } finally { await p.close(); }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("T4: status's remote comes only with the hello's remote_scopes (C12's feature rule)", async () => {
  const { Stage1a } = await import("../src/service/service.ts");
  for (const feature of [false, true]) {
    const s = new Stage1a({ agentDoor: { url: (x) => x, state: () => ({ form: "pidfd" }) }, parts: [{ ops: {}, features: () => (feature ? ["remote_scopes"] : []) }] });
    s.handle(snapshot([ITEM.a]) as never);
    const st = s.status();
    if (feature) assert.deepEqual(st.remote, [{ scope: ITEM.a.scope, box: "box1", list: "grant-box1", mcp_token: true }]);
    else assert.equal(Object.hasOwn(st, "remote"), false, "no key remote without the feature");
  }
});

// ------------------------------------------------------------------ the carrier rule's vectors (real processes)

/** The fake gateway (the "job"): `self` connects itself; `child` starts a direct child that connects; `grand` a child that starts a grandchild that connects. */
const CHILD = `const net=require("node:net"),{spawn}=require("node:child_process");const [sock,mode]=process.argv.slice(1);
if(mode==="fork"){process.stdout.write(JSON.stringify({pid:process.pid,fork:true})+"\\n");spawn(process.execPath,["-e",require("node:fs").readFileSync("/proc/self/cmdline","latin1").split("\\0")[2],sock,"leaf"],{stdio:"inherit"});setInterval(()=>{},1000)}
else{process.stdout.write(JSON.stringify({pid:process.pid})+"\\n");const s=net.connect(sock);s.on("error",()=>{});setInterval(()=>{},1000)}`;
const GATEWAY = `const net=require("node:net"),{spawn}=require("node:child_process");const [sock,child]=process.argv.slice(1);
process.stdout.write(JSON.stringify({gateway:process.pid})+"\\n");
require("node:readline").createInterface({input:process.stdin}).on("line",(l)=>{
  if(l==="self"){const s=net.connect(sock);s.on("error",()=>{})}
  if(l==="child")spawn(process.execPath,["-e",child,sock,"leaf"],{stdio:["ignore","inherit","inherit"]});
  if(l==="grand")spawn(process.execPath,["-e",child,sock,"fork"],{stdio:["ignore","inherit","inherit"]});
});`;

test("T4: the carrier rule's vectors (the control door's rules 1 to 4 with the gateway's pid and command file, and their own texts): the job's pid and its direct child with the command line pass; a grandchild, a wrong command and no job are refused", { skip: !linux, timeout: 60_000 }, async () => {
  const carrierAdmission = (ADM as any).carrierAdmission as (d: ADM.AdmissionDeps) => (s: Socket) => Promise<{ ok: boolean; pid?: number; reason?: string }>;
  assert.equal(typeof carrierAdmission, "function", "admission.ts has the carrier rule");
  const dir = mkdtempSync(join(tmpdir(), "ab-carrier-rule-"));
  const sock = join(dir, "door.sock"), file = join(dir, "gateway-command.json");
  const kids: ChildProcess[] = [], pids: number[] = [];
  let server: Server | null = null;
  try {
    const t = await selfTest(join(dir, "cdp.sock"));
    if ("failed" in t) throw new Error(`the self-test failed: ${t.failed}`);
    const main = { pid: null as number | null };
    const admit = carrierAdmission({ reader: t.reader, pidfd: await loadPidfdOpen(), mainPid: async () => main.pid, commandFile: file });
    const verdicts: { ok: boolean; pid?: number; reason?: string }[] = [];
    server = createServer((s) => { void admit(s).then((v) => verdicts.push(v)); });
    await new Promise<void>((r) => server!.listen(sock, r));
    const g = spawn(process.execPath, ["-e", GATEWAY, sock, CHILD], { stdio: ["pipe", "pipe", "inherit"] });
    kids.push(g);
    const lines: any[] = [];
    createInterface({ input: g.stdout! }).on("line", (l) => { const x = JSON.parse(l); lines.push(x); if (x.pid) pids.push(x.pid); });
    const until = async (f: () => boolean) => { for (let i = 0; i < 200 && !f(); i++) await sleep(25); assert.ok(f(), "in time"); };
    await until(() => lines.some((l) => l.gateway));
    const gw = lines.find((l) => l.gateway).gateway as number;
    const expect = (args: string[]) => writeFileSync(file, JSON.stringify({ v: 1, interpreter: NODE, args }), { mode: 0o600 });
    const next = async (line: string) => { const n = verdicts.length; g.stdin!.write(`${line}\n`); await until(() => verdicts.length > n); return verdicts[n]; };
    const childArgs = ["-e", CHILD, sock, "leaf"];

    main.pid = gw;
    expect(["-e", GATEWAY, sock, CHILD]);
    assert.deepEqual(await next("self"), { ok: true, pid: gw }, "the job's pid with the gateway's command");
    expect(childArgs);
    const child = await next("child");
    assert.equal(child.ok, true, JSON.stringify(child));
    assert.ok(child.pid !== gw && pids.includes(child.pid!), "the direct child");
    const grand = await next("grand");
    assert.deepEqual(grand, { ok: false, reason: ADM.carrierRefused(2, "its parent is not the gateway job's pid") }, "a grandchild");
    expect(["-e", CHILD, sock, "other"]);
    assert.deepEqual(await next("child"), { ok: false, reason: ADM.carrierRefused(3, "its command line is not the gateway's command") }, "a wrong command");
    main.pid = null;
    expect(childArgs);
    assert.deepEqual(await next("child"), { ok: false, reason: ADM.CARRIER_NO_PID }, "no job");
    // The texts are the carrier's own, never the control door's.
    assert.match(ADM.carrierRefused(2, "x"), /^The agent door's carrier is only the gateway's process: rule 2 failed \(x\)\.$/);
    assert.equal(ADM.CARRIER_NO_PID, "The agent door cannot read the pid of the gateway's job, so it has no carrier.");
  } finally {
    for (const pid of pids) try { process.kill(pid, "SIGKILL"); } catch {}
    for (const k of kids) k.kill("SIGKILL");
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T4: the switch on the command line: --gateway-label and --gateway-command go together; --test-gateway-pid goes with --test and --gateway-command, never with --gateway-label; SERVICE_USAGE names them", async () => {
  const { SERVICE_USAGE, gatewayOption } = await import("../src/service/main.ts") as any;
  assert.match(SERVICE_USAGE, /\[--gateway-label LABEL --gateway-command FILE\]/);
  assert.match(SERVICE_USAGE, /\[--test-gateway-pid PID\]/);
  assert.equal(typeof gatewayOption, "function");
  assert.equal(gatewayOption({}, false), null, "no switch: no carrier");
  assert.deepEqual(gatewayOption({ "gateway-label": "sh.agentwatch.gateway", "gateway-command": "/c/gateway-command.json" }, false), { label: "sh.agentwatch.gateway", commandFile: "/c/gateway-command.json", testPid: null });
  assert.throws(() => gatewayOption({ "gateway-label": "x" }, false), /--gateway-label goes with --gateway-command/);
  assert.throws(() => gatewayOption({ "gateway-command": "/c/f.json" }, false), /--gateway-command goes with --gateway-label/);
  assert.throws(() => gatewayOption({ "test-gateway-pid": "12", "gateway-command": "/c/f.json" }, false), /--test-gateway-pid goes with --test/);
  assert.throws(() => gatewayOption({ "test-gateway-pid": "12", "gateway-command": "/c/f.json", "gateway-label": "x" }, true), /--test-gateway-pid does not go with --gateway-label/);
  assert.throws(() => gatewayOption({ "test-gateway-pid": "x1", "gateway-command": "/c/f.json" }, true), /--test-gateway-pid must be a pid/);
  assert.deepEqual(gatewayOption({ "test-gateway-pid": "12", "gateway-command": "/c/f.json" }, true), { label: null, commandFile: "/c/f.json", testPid: 12 });
});
