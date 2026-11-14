// The Playwright MCP inside the service, behind the MCP port (contract C11, "The MCP inside the service" and the MCP path;
// docs/contracts/mcp-allow-list.md and its vectors; C12's `status.mcp` and the hello's `mcp_token`; stage 1d part 2b,
// board ab-v16.94.5). The pinned `@playwright/mcp` answers `initialize` and `tools/list` with no browser, so these tests
// start no Chrome, no Xvfb and no display: the MCP's own CDP connection goes to the relay of test/fake-bridge.ts, whose
// fake peer reader says that the peer is this process (the service's own pid), so only a ticket admits it. Every token
// here is a made-up test value; every folder is a temp folder of the test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NOT_READY } from "../src/relay/model.ts";
import { PeerGate, sessionRefusal, type PeerReader } from "../src/relay/peer.ts";
import { checkCall, checkList, fileString, filterTools, LIST_FILE, NEVER_CAPABILITIES, readAllowList, realFolder, refusePath, RULES, RUN_CODE, SERVICE_TOOLS, speaksOfPath, type AllowList, type PinnedTool } from "../src/service/mcp/allow-list.ts";
import { mcpConfig, openMcpServer, SERVER_SIDE_CAPABILITIES, type Message } from "../src/service/mcp/session.ts";
import { ticketOf, TICKET_MS, Tickets } from "../src/service/mcp/ticket.ts";
import { MCP_ANSWER, MCP_ANSWERS, MCP_MAX_BODY, MCP_SESSIONS_PER_SCOPE, MCP_SESSIONS_PER_SERVICE, McpTransport, scopeFolder } from "../src/service/mcp/transport.ts";
import { MCP_HEAP_MB, ScopeWorker } from "../src/service/mcp/workers.ts";
import { harness, lineOf, raw, until } from "./fake-bridge.ts";
import { ROOT } from "./helpers.ts";

const V = JSON.parse(readFileSync(new URL("./vectors/mcp-allow-list.json", import.meta.url), "utf8"));
const ALLOW_MD = readFileSync(join(ROOT, "docs/contracts/mcp-allow-list.md"), "utf8");
const PKG = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const PIN: string = PKG.dependencies["@playwright/mcp"];
const LIST = readAllowList();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: { roots: { listChanged: true }, sampling: {} }, clientInfo: { name: "test-client", version: "0" } } };

/** The pinned version's own tools/list with the service's fixed configuration (no browser: the getter is never called). */
async function pinnedToolsList(): Promise<{ tools: PinnedTool[]; init: Message; getterCalls: number }> {
  const got: Message[] = [];
  let getterCalls = 0;
  const s = await openMcpServer({ list: LIST, folder: "/nonexistent-test-folder/mcp/t/", context: async () => { getterCalls++; throw new Error("no browser in this test"); }, answer: (m) => got.push(m) });
  try {
    s.deliver(INIT);
    await until(() => got.find((m) => m.id === 1), "initialize's answer");
    s.deliver({ jsonrpc: "2.0", method: "notifications/initialized" });
    s.deliver({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const list = await until(() => got.find((m) => m.id === 2), "tools/list's answer");
    return { tools: (list.result as { tools: PinnedTool[] }).tools.map((t) => ({ name: t.name, inputSchema: t.inputSchema })), init: got.find((m) => m.id === 1)!, getterCalls };
  } finally { await s.close(); }
}

// ------------------------------------------------------------------ item 2: the allow list and its test

test("the allow list's test: the pinned version's tools/list (names and input schemas, no browser) is the list file's, with no rule broken", { timeout: 60_000 }, async () => {
  const { tools, init, getterCalls } = await pinnedToolsList();
  assert.equal(LIST.version, PIN, "the list is the pin's");
  assert.deepEqual(checkList(LIST, tools, PIN), [], "the list holds every rule of the format");
  assert.equal(getterCalls, 0, "initialize and tools/list need no CDP connection");
  assert.equal(Object.keys(LIST.tools).length, 24, "the 24 tools of M3's part C");
  assert.deepEqual(Object.keys(LIST.refused), [RUN_CODE]);
  assert.equal((init.result as any).serverInfo.version, PKG.dependencies["playwright-core"], "the MCP of the pinned playwright-core");
  for (const c of LIST.capabilities) assert.ok(!NEVER_CAPABILITIES.includes(c), c);
});

test("the allow list's test fails at any change: a changed schema, a new tool, a tool gone, a path key not marked, a capability that is never on", { timeout: 60_000 }, async () => {
  const { tools } = await pinnedToolsList();
  const nav = tools.find((t) => t.name === "browser_navigate")!;
  const changed = tools.map((t) => (t === nav ? { ...t, inputSchema: { ...t.inputSchema, properties: { ...(t.inputSchema.properties as object), headers: { type: "object" } } } } : t));
  assert.deepEqual(checkList(LIST, changed, PIN), [RULES.schema], "a schema change");
  assert.deepEqual(checkList(LIST, [...tools, { name: "browser_install", inputSchema: { type: "object", properties: {} } }], PIN), [RULES.once], "a new tool");
  assert.deepEqual(checkList(LIST, tools.filter((t) => t.name !== "browser_hover"), PIN), [RULES.once], "a tool gone");
  const unmarked: AllowList = { ...LIST, tools: { ...LIST.tools, browser_take_screenshot: { ...LIST.tools.browser_take_screenshot, paths: [] } } };
  assert.deepEqual(checkList(unmarked, tools, PIN), [RULES.pathKey], "a key that speaks of a file and is not in paths");
  assert.deepEqual(checkList({ ...LIST, capabilities: [...LIST.capabilities, "storage"] }, tools, PIN), [RULES.capabilities]);
  assert.deepEqual(checkList({ ...LIST, version: "0.0.0" }, tools, PIN), [RULES.version]);
  // browser_take_screenshot's `type` speaks of the file name, so it is left out of keys.
  assert.ok(speaksOfPath("type", (tools.find((t) => t.name === "browser_take_screenshot")!.inputSchema.properties as any).type));
  assert.ok(!LIST.tools.browser_take_screenshot.keys.includes("type"));
});

test("the format's vectors: the example list holds, each bad list breaks exactly its rule, and service_tools is exactly the format's value", () => {
  assert.deepEqual(checkList(V.list, V.pinnedTools, V.pin), []);
  assert.ok(V.badLists.length >= 11);
  for (const b of V.badLists) assert.deepEqual(checkList(b.list, b.pinnedTools ?? V.pinnedTools, V.pin), [b.breaks], b.note);
  const block = /They are exactly these two, in every list:\s*```json\s*(\{.*?\})\s*```/s.exec(ALLOW_MD)?.[1];
  assert.ok(block, "the format's value of service_tools");
  assert.deepEqual(SERVICE_TOOLS, JSON.parse(block!));
  assert.deepEqual(LIST.service_tools, SERVICE_TOOLS, "the list file holds the format's service_tools");
});

test("the format's calls: each pinned tool's call passes or gets its answer; checkCall refuses the service's own tools (-32601: no call of one reaches the MCP), which the transport answers itself (test/service-mcp-sign-in.test.ts)", () => {
  const real = (map: Record<string, string> = {}) => (p: string) => map[p] ?? p;
  let n = 0;
  for (const c of V.calls) {
    const service = Object.hasOwn(SERVICE_TOOLS, c.call.name);
    const got = checkCall(V.list, c.call, V.folder, real(c.realpath));
    if (service) { assert.deepEqual(got, { code: -32601, message: `Not available in the agent browser: ${c.call.name}` }, `${c.note}: the MCP's code never serves it`); continue; }
    n++;
    assert.deepEqual(got, c.answer === "pass" ? null : c.answer, c.note);
  }
  assert.ok(n >= 10);
  // A call whose arguments are no object, and a path value that is no string.
  assert.deepEqual(checkCall(V.list, { name: "browser_navigate", arguments: ["x"] }, V.folder), { code: -32602, message: "Not available in the agent browser: the arguments of browser_navigate must be a JSON object" });
  assert.deepEqual(checkCall(V.list, { name: "browser_take_screenshot", arguments: { filename: 5 } }, V.folder), refusePath("filename", V.folder));
  // tools/list of the MCP: only the list's tools (the transport adds the service's own tools for a local admission).
  assert.deepEqual(filterTools(V.list, V.pinnedTools).map((t: any) => t.name), Object.keys(V.list.tools));
});

// ------------------------------------------------------------------ item 6: the path rule on a real disk

test("the path rule: each path argument passes only inside <state>/mcp/<scope>/ after realpath; no link leaves the folder", () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-mcp-paths-"));
  try {
    const state = join(dir, "state"), folder = scopeFolder(state, "web-1"), other = scopeFolder(state, "web-10");
    mkdirSync(folder, { recursive: true }); mkdirSync(other, { recursive: true }); mkdirSync(join(dir, "outside"));
    writeFileSync(join(folder, "a.pdf"), "test file");
    writeFileSync(join(dir, "outside", "b.pdf"), "test file");
    symlinkSync(join(dir, "outside", "b.pdf"), join(folder, "link.pdf"));
    symlinkSync(join(dir, "outside"), join(folder, "out"));
    const up = (paths: string[]) => checkCall(LIST, { name: "browser_file_upload", arguments: { paths } }, folder);
    const shot = (filename: string) => checkCall(LIST, { name: "browser_take_screenshot", arguments: { filename, scale: "css" } }, folder);
    const no = (key: string) => refusePath(key, folder);
    assert.equal(up([join(folder, "a.pdf")]), null, "a file in the folder");
    assert.equal(shot("shot.png"), null, "a relative name: in the folder (the MCP's root)");
    assert.equal(shot(join(folder, "new", "shot.png")), null, "a file that does not exist yet, in the folder");
    assert.deepEqual(up([join(folder, "a.pdf"), join(dir, "outside", "b.pdf")]), no("paths"), "one path outside");
    assert.deepEqual(up([join(folder, "link.pdf")]), no("paths"), "a link in the folder to a file outside");
    assert.deepEqual(shot(join(folder, "out", "x.png")), no("filename"), "a new file under a linked folder");
    assert.deepEqual(shot(join(folder, "..", "web-10", "x.png")), no("filename"), "a .. that leaves the folder");
    assert.deepEqual(shot(join(other, "x.png")), no("filename"), "another scope's folder with the same start");
    assert.deepEqual(shot("../web-10/x.png"), no("filename"), "a relative name that leaves the folder");
    assert.deepEqual(shot(folder), no("filename"), "the folder itself is no file");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------ item 4: the server object and its configuration

test("the fixed configuration of C11: the capabilities named, no file access outside the roots, the scope's output folder, a 30 s action timeout, no page tools; the context through the getter", () => {
  const c = mcpConfig(LIST, "/s/mcp/web-1/") as any;
  assert.deepEqual(c.capabilities, LIST.capabilities);
  assert.equal(c.allowUnrestrictedFileAccess, false);
  assert.equal(c.outputDir, "/s/mcp/web-1/");
  assert.deepEqual(c.timeouts, { action: 30_000 });
  assert.equal(c.webmcp, false);
  assert.equal(c.browser.isolated, false, "the default context");
  assert.equal(c.browser.cdpEndpoint, undefined, "no endpoint in the configuration: the getter connects with the ticket");
  assert.deepEqual(SERVER_SIDE_CAPABILITIES, { roots: {} });
});

test("the MCP never launches or downloads a browser: a tool call goes only to the context getter; no child process, no launch and no browser download run", { timeout: 60_000 }, async () => {
  const cp = await import("node:child_process");
  const { createRequire } = await import("node:module");
  const pw = createRequire(join(ROOT, "src/service/mcp/session.ts"))("playwright-core");
  const calls: string[] = [];
  const keep: [object, string, unknown][] = [];
  const spy = (o: any, k: string) => { keep.push([o, k, o[k]]); o[k] = (...a: unknown[]) => { calls.push(k); throw new Error(`the test refuses ${k}`); }; };
  for (const k of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) spy(cp.default, k);
  for (const k of ["launch", "launchPersistentContext", "launchServer", "connect"]) spy(pw.chromium, k);
  const dir = mkdtempSync(join(tmpdir(), "ab-mcp-nolaunch-"));
  const got: Message[] = [];
  let getter = 0;
  try {
    const s = await openMcpServer({ list: LIST, folder: dir, context: async () => { getter++; throw new Error("the test's endpoint refuses the connection"); }, answer: (m) => got.push(m) });
    s.deliver(INIT);
    await until(() => got.find((m) => m.id === 1));
    s.deliver({ jsonrpc: "2.0", method: "notifications/initialized" });
    for (const [id, name, args] of [[3, "browser_navigate", { url: "https://a.example/" }], [4, "browser_snapshot", {}], [5, "browser_tabs", { action: "list" }]] as const) {
      s.deliver({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
      const a = await until(() => got.find((m) => m.id === id), `${name}'s answer`, 20_000);
      assert.equal((a.result as any).isError, true, `${name}: the tool's error, no fallback`);
    }
    await s.close();
    assert.ok(getter >= 3, "each tool asked the getter");
    assert.deepEqual(calls, [], "no child process and no launch");
  } finally {
    for (const [o, k, v] of keep) (o as any)[k] = v;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("under Node's permission model with reads only (no write, no network, no child process, no worker), the MCP answers initialize, tools/list and each tool call through the getter alone", { skip: process.platform !== "linux", timeout: 60_000 }, async () => {
  const { execFile } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "ab-mcp-perm-"));
  const script = `
    const { openMcpServer } = await import(${JSON.stringify(join(ROOT, "src/service/mcp/session.ts"))});
    const { readAllowList } = await import(${JSON.stringify(join(ROOT, "src/service/mcp/allow-list.ts"))});
    const got = [];
    const s = await openMcpServer({ list: readAllowList(), folder: process.argv[1], context: async () => { throw new Error("the test's getter: no browser"); }, answer: (m) => got.push(m) });
    const wait = async (id) => { for (let i = 0; i < 400 && !got.some((m) => m.id === id); i++) await new Promise((r) => setTimeout(r, 25)); };
    s.deliver(${JSON.stringify(INIT)}); await wait(1);
    s.deliver({ jsonrpc: "2.0", method: "notifications/initialized" });
    s.deliver({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }); await wait(2);
    let id = 10;
    for (const [name, args] of [["browser_navigate", { url: "https://a.example/" }], ["browser_snapshot", {}], ["browser_take_screenshot", { scale: "css" }], ["browser_tabs", { action: "list" }], ["browser_file_upload", {}]]) {
      s.deliver({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }); await wait(id);
    }
    await s.close();
    console.log(JSON.stringify(got));`;
  try {
    const out = await new Promise<string>((resolve, reject) => execFile(process.execPath, ["--permission", "--allow-fs-read=*", "--input-type=module", "-e", script, `${dir}/`], { cwd: ROOT, timeout: 50_000 }, (e, stdout, stderr) => (e ? reject(new Error(`${e.message}\n${stderr}`)) : resolve(stdout))));
    const got = JSON.parse(out.trim().split("\n").pop()!) as Message[];
    assert.equal((got.find((m) => m.id === 2)!.result as any).tools.length, 25, "the pinned tools/list");
    const calls = got.filter((m) => (m.id as number) > 10);
    assert.equal(calls.length, 5);
    for (const c of calls) {
      const text = JSON.stringify(c.result);
      assert.ok(text.includes("the test's getter: no browser"), `the getter's error: ${text}`);
      assert.ok(!/ERR_ACCESS_DENIED|Access to this API/.test(text), `no write, network, child process or worker: ${text}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the MCP's request of the client's roots is answered with the scope's folder; a client's own capabilities never reach it", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-mcp-roots-"));
  const got: Message[] = [];
  const traced: [Message, Message][] = [];
  try {
    const s = await openMcpServer({ list: LIST, folder: `${dir}/`, context: async () => { throw new Error("no browser"); }, answer: (m) => got.push(m), trace: (q, a) => traced.push([q, a]) });
    // A client that names no roots of its own: the server still sees the roots capability, and asks for them.
    s.deliver({ ...INIT, params: { ...INIT.params, capabilities: { sampling: {}, elicitation: {} } } });
    await until(() => got.find((m) => m.id === 1));
    s.deliver({ jsonrpc: "2.0", method: "notifications/initialized" });
    // A file outside the folder: the MCP's own guardrail refuses it with the folder as its root (the transport refuses first in the service).
    s.deliver({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "browser_console_messages", arguments: { level: "info", filename: "/etc/test-not-there.txt" } } });
    const a = await until(() => got.find((m) => m.id === 7), "the answer", 20_000);
    assert.equal((a.result as any).isError, true);
    assert.ok(!got.some((m) => typeof m.method === "string"), "no request of the server went to the client");
    const roots = traced.filter(([q]) => q.method === "roots/list");
    assert.equal(roots.length, 1, "the server asked for the roots once, at its first tool");
    assert.deepEqual((roots[0][1].result as any).roots, [{ uri: `file://${dir}/`, name: "agent-browser" }], "the scope's folder is the MCP's root");
    assert.deepEqual(traced.filter(([q]) => q.method !== "roots/list"), [], "no other request of the server (no sampling, no elicitation)");
    await s.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------ item 5: the ticket

test("a ticket: one time, for its scope, from the service's own pid, within its life; the query holds it", () => {
  let now = 1000;
  const t = new Tickets({ now: () => now, pid: 4242 });
  const a = t.mint("web-1");
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(t.take(a, "web-1", 4242), true);
  assert.equal(t.take(a, "web-1", 4242), false, "one time");
  const b = t.mint("web-1");
  assert.equal(t.take(b, "web-2", 4242), false, "another scope");
  assert.equal(t.take(b, "web-1", 4242), false, "a wrong use burns it");
  const c = t.mint("web-1");
  assert.equal(t.take(c, "web-1", 4243), false, "another pid");
  const d = t.mint("web-1");
  now += TICKET_MS;
  assert.equal(t.take(d, "web-1", 4242), false, "its life is over");
  assert.equal(ticketOf(`/devtools/browser/web-1?ticket=${a}`), a);
  assert.equal(ticketOf("/devtools/browser/web-1"), null);
  assert.equal(ticketOf(`/devtools/browser/web-1?ticket=${a}&ticket=${a}`), null, "two tickets: none");
});

/** A relay of fake-bridge.ts whose fake peer reader says that each peer is `pid` (this process: the service's own). */
function selfReader(pid = process.pid): PeerReader {
  return { form: "stat", peer: () => ({ pid, uid: 1001, pidfd: null, start: 77 }), proc: (p) => (p === pid ? { ppid: 1, start: 77, state: "S" } : null), cgroup: () => null, poll: () => 0, fdinfoPid: () => null, close: () => {} };
}
const LINE2 = { t: "allowlist", lists: { a: ["a.example"] }, scopes: { "web-1": "a", "web-2": "a" }, default: null };

test("the agent door takes the service's own pid only with a live ticket of the scope; every other rule of C11 still applies; a ticket from another pid admits nothing", { timeout: 30_000 }, async () => {
  const tickets = new Tickets();
  const h = await harness({ peerCheck: new PeerGate({ reader: selfReader(), uid: 1001 }), tickets } as any);
  try {
    // Not ready yet: the readiness 503 comes before the ticket, and the ticket stays live.
    const early = tickets.mint("web-1");
    const r0 = await raw(`${h.url("web-1")}?ticket=${early}`);
    assert.equal(r0.status, 503);
    await h.ready(LINE2);
    const r1 = await raw(h.url("web-1"));
    assert.deepEqual([r1.status, r1.body], [403, sessionRefusal(process.pid)], "the own pid with no ticket");
    const r2 = await raw(`${h.url("web-1")}?ticket=${tickets.mint("web-2")}`);
    assert.deepEqual([r2.status, r2.body], [403, sessionRefusal(process.pid)], "a ticket of another scope");
    const r3 = await raw(`${h.url("web-1")}?ticket=${early}`);
    assert.ok(r3.ws, "the live ticket of the scope admits the connection");
    assert.equal(h.relay.model.connectionCount, 1);
    r3.ws!.close();
    const r4 = await raw(`${h.url("web-1")}?ticket=${early}`);
    assert.deepEqual([r4.status, r4.body], [403, sessionRefusal(process.pid)], "the same ticket again");
    const r5 = await raw(`${h.url("web-3")}?ticket=${tickets.mint("web-3")}`);
    assert.deepEqual([r5.status, r5.body], [503, NOT_READY.noList], "a scope that the line does not name: the 503 before the ticket");
    const r6 = await raw(`${h.url("web-1")}?ticket=${tickets.mint("web-1")}`, { Origin: "https://a.example" });
    assert.equal(r6.status, 403, "an Origin header: the 403 before the ticket");
  } finally { await h.close(); }
  // Another pid with a live ticket: the walk decides (it reaches no root here), and the ticket is gone.
  const t2 = new Tickets();
  const h2 = await harness({ peerCheck: new PeerGate({ reader: selfReader(process.pid + 100000), uid: 1001 }), tickets: t2 } as any);
  try {
    await h2.ready(LINE2);
    const r = await raw(`${h2.url("web-1")}?ticket=${t2.mint("web-1")}`);
    assert.deepEqual([r.status, r.body], [403, sessionRefusal(process.pid + 100000)]);
    assert.equal(t2.size, 0, "the ticket is gone");
  } finally { await h2.close(); }
});

// ------------------------------------------------------------------ item 3: the transport

type Http = { url: (scope: string) => string; server: Server; close: () => Promise<void> };
/**
 * A plain HTTP server in front of the transport: the path's scope is the connection's scope, and each request has the
 * port's admission `local` (the port's admission is tested in service-mcp-port.test.ts; a remote admission in
 * service-mcp-sign-in.test.ts).
 */
async function front(t: McpTransport): Promise<Http> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const scope = /^\/mcp\/([^/?]+)/.exec(req.url ?? "")?.[1] ?? "none";
    void t.request(req, res, scope, undefined, "local");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { server, url: (scope) => `http://127.0.0.1:${port}/mcp/${scope}`, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}
type Reply = { status: number; sid: string | null; body: any; text: string; headers: Headers };
async function post(url: string, body: unknown, sid?: string, extra: Record<string, string> = {}): Promise<Reply> {
  // A request that gets no answer fails the test in 30 s (review-115 note 7: no request may wait with no end).
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(sid ? { "Mcp-Session-Id": sid } : {}), ...extra }, body: typeof body === "string" ? body : JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  const text = await r.text();
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : null; } catch {}
  return { status: r.status, sid: r.headers.get("mcp-session-id"), body: parsed, text, headers: r.headers };
}
async function init(url: string): Promise<string> {
  const r = await post(url, INIT);
  assert.equal(r.status, 200, r.text);
  assert.match(r.sid ?? "", /^[0-9a-f]{32}$/);
  await post(url, { jsonrpc: "2.0", method: "notifications/initialized" }, r.sid!);
  return r.sid!;
}

async function withTransport(o: { perScope?: number; perService?: number; ticketUrl?: (scope: string) => string | null; worker?: any } = {}, f: (x: { t: McpTransport; h: Http; dir: string; log: string[] }) => Promise<void>): Promise<void> {
  // (A worker of the test's own: { heapMb, entry, openWaitMs }.)
  const dir = mkdtempSync(join(tmpdir(), "ab-mcp-transport-"));
  const log: string[] = [];
  const t = new McpTransport({ list: LIST, stateFolder: join(dir, "state"), ticketUrl: o.ticketUrl ?? (() => null), log: (l) => log.push(l), perScope: o.perScope, perService: o.perService, worker: o.worker });
  const h = await front(t);
  try { await f({ t, h, dir, log }); } finally { await h.close(); await t.stop(); rmSync(dir, { recursive: true, force: true }); }
}

test("the transport: initialize gives an Mcp-Session-Id and a JSON answer; tools/list holds only the list's tools; ping; notifications get 202; GET 405; DELETE 200 then 404", { timeout: 60_000 }, async () => {
  await withTransport({}, async ({ t, h, dir }) => {
    const r = await post(h.url("web-1"), INIT);
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") ?? "", /^application\/json/);
    assert.equal(r.body.result.serverInfo.version, PKG.dependencies["playwright-core"]);
    const sid = r.sid!;
    assert.equal((await post(h.url("web-1"), { jsonrpc: "2.0", method: "notifications/initialized" }, sid)).status, 202);
    const list = await post(h.url("web-1"), { jsonrpc: "2.0", id: 2, method: "tools/list" }, sid);
    const names = list.body.result.tools.map((x: any) => x.name);
    assert.deepEqual([...names].sort(), Object.keys(LIST.tools).sort(), "the list's 24 tools, no other");
    assert.ok(!names.includes(RUN_CODE));
    assert.deepEqual((await post(h.url("web-1"), { jsonrpc: "2.0", id: 3, method: "ping" }, sid)).body, { jsonrpc: "2.0", id: 3, result: {} });
    assert.deepEqual((await post(h.url("web-1"), { jsonrpc: "2.0", id: 4, method: "resources/list" }, sid)).body.error, { code: -32601, message: MCP_ANSWER.methodNotFound });
    const get = await fetch(h.url("web-1"), { headers: { "Mcp-Session-Id": sid } });
    assert.equal(get.status, 405);
    assert.equal(get.headers.get("allow"), "POST, DELETE");
    await get.text();
    assert.equal(t.size("web-1"), 1);
    const del = await fetch(h.url("web-1"), { method: "DELETE", headers: { "Mcp-Session-Id": sid } });
    assert.equal(del.status, 200);
    await del.text();
    assert.equal(t.size(), 0);
    const after = await post(h.url("web-1"), { jsonrpc: "2.0", id: 5, method: "tools/list" }, sid);
    assert.equal(after.status, 404, "an ended session");
    assert.deepEqual(after.body.error, { code: -32001, message: MCP_ANSWER.unknownSession });
    await until(() => t.workerOf("web-1") === undefined, "the worker stops with its last session");
    assert.equal(statSync(join(dir, "state", "mcp", "web-1")).mode & 0o777, 0o700, "the scope's folder, 0700");
  });
});

test("the transport: no id gets 400; an unknown id and an id of another scope get the 404 of an unknown MCP session; a batch, a bad JSON and a large body are refused", { timeout: 60_000 }, async () => {
  await withTransport({}, async ({ h }) => {
    const a = await init(h.url("web-1"));
    const b = await init(h.url("web-2"));
    const noId = await post(h.url("web-1"), { jsonrpc: "2.0", id: 1, method: "tools/list" });
    assert.deepEqual([noId.status, noId.body.error.message], [400, MCP_ANSWER.noSessionId]);
    for (const [scope, sid] of [["web-1", b], ["web-2", a], ["web-1", "f".repeat(32)]] as const) {
      const r = await post(h.url(scope), { jsonrpc: "2.0", id: 1, method: "tools/list" }, sid);
      assert.deepEqual([r.status, r.body.error], [404, { code: -32001, message: MCP_ANSWER.unknownSession }], `${scope} with ${sid === a ? "web-1's" : sid === b ? "web-2's" : "an unknown"} id`);
    }
    const del = await fetch(h.url("web-1"), { method: "DELETE", headers: { "Mcp-Session-Id": b } });
    assert.equal(del.status, 404, "a DELETE with another scope's id");
    await del.text();
    assert.equal((await post(h.url("web-1"), INIT, a)).status, 400, "an initialize with an id");
    assert.deepEqual((await post(h.url("web-1"), [{ jsonrpc: "2.0", id: 1, method: "ping" }], a)).body.error, { code: -32600, message: MCP_ANSWER.batch });
    assert.deepEqual((await post(h.url("web-1"), "{not json", a)).body.error, { code: -32700, message: MCP_ANSWER.parse });
    const big = await post(h.url("web-1"), JSON.stringify({ jsonrpc: "2.0", id: 9, method: "ping", params: { pad: "x".repeat(MCP_MAX_BODY) } }), a).catch(() => null);
    if (big) assert.equal(big.status, 413);
    // Both sessions still answer.
    assert.equal((await post(h.url("web-1"), { jsonrpc: "2.0", id: 2, method: "ping" }, a)).status, 200);
    assert.equal((await post(h.url("web-2"), { jsonrpc: "2.0", id: 2, method: "ping" }, b)).status, 200);
  });
});

test("the transport refuses a tools/call of another tool, with another key or with a path outside the folder before it reaches the MCP's code", { timeout: 60_000 }, async () => {
  await withTransport({}, async ({ t, h, dir, log }) => {
    const sid = await init(h.url("web-1"));
    const w = t.workerOf("web-1")!;
    const seen: string[] = [];
    const real = w.request.bind(w);
    w.request = (s, m) => { seen.push(String(m.method)); return real(s, m); };
    const call = (id: number, name: string, args: unknown) => post(h.url("web-1"), { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }, sid);
    const folder = scopeFolder(join(dir, "state"), "web-1");
    const cases: [string, unknown, { code: number; message: string }][] = [
      [RUN_CODE, { code: "async (page) => 1" }, { code: -32601, message: `Not available in the agent browser: ${RUN_CODE}` }],
      ["browser_install", {}, { code: -32601, message: "Not available in the agent browser: browser_install" }],
      ["browser_sign_in", { name: "x" }, { code: -32601, message: "Not available in the agent browser: browser_sign_in" }],
      ["browser_navigate", { url: "https://a.example/", headers: { cookie: "x" } }, { code: -32602, message: "Not available in the agent browser: the argument headers of browser_navigate" }],
      ["browser_take_screenshot", { type: "jpeg", scale: "css" }, { code: -32602, message: "Not available in the agent browser: the argument type of browser_take_screenshot" }],
      ["browser_file_upload", { paths: ["/etc/hostname"] }, { code: -32602, message: `Not available in the agent browser: paths must name a file in the session's folder ${folder}` }],
      ["browser_snapshot", { filename: "../web-2/x.md" }, { code: -32602, message: `Not available in the agent browser: filename must name a file in the session's folder ${folder}` }],
    ];
    let id = 10;
    for (const [name, args, want] of cases) {
      const r = await call(++id, name, args);
      assert.deepEqual([r.status, r.body], [200, { jsonrpc: "2.0", id, error: want }], name);
    }
    assert.deepEqual(seen, [], "no refused call reached the worker");
    // A call that the list allows reaches the MCP: no browser here, so the tool answers its own error.
    const ok = await call(++id, "browser_tabs", { action: "list" });
    assert.equal(ok.body.result.isError, true);
    assert.deepEqual(seen, ["tools/call"]);
    assert.ok(log.some((l) => l === "mcp: MCP session 1 (scope web-1): a tools/call refused (-32602)"));
    assert.ok(!log.join("\n").includes("/etc/hostname") && !log.join("\n").includes("a.example"), "no argument in the log");
  });
});

test("at most 4 MCP sessions for each scope and 32 for each service (first values): one more initialize gets 503 with C11's text", { timeout: 90_000 }, async () => {
  assert.equal(MCP_SESSIONS_PER_SCOPE, 4);
  assert.equal(MCP_SESSIONS_PER_SERVICE, 32);
  await withTransport({}, async ({ t, h }) => {
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push(await init(h.url("web-1")));
    const fifth = await post(h.url("web-1"), INIT);
    assert.deepEqual([fifth.status, fifth.body], [503, { jsonrpc: "2.0", id: 1, error: { code: -32000, message: MCP_ANSWER.perScope } }]);
    assert.equal(t.size("web-1"), 4);
    // Another scope still gets its own.
    await init(h.url("web-2"));
    // One session ends: the scope has room again.
    const del = await fetch(h.url("web-1"), { method: "DELETE", headers: { "Mcp-Session-Id": ids[0] } });
    await del.text();
    await init(h.url("web-1"));
  });
  // The service's limit, with a test value of 2 (32 workers would hold several GiB).
  await withTransport({ perService: 2 }, async ({ h }) => {
    await init(h.url("web-1"));
    await init(h.url("web-2"));
    const third = await post(h.url("web-3"), INIT);
    assert.deepEqual([third.status, third.body.error], [503, { code: -32000, message: MCP_ANSWER.perService }]);
  });
});

test("endSessions (C11's close at a change, C12's session_ended, OP4): the scope's MCP sessions end, a waiting request gets the ended error, the next one the 404; other scopes go on", { timeout: 60_000 }, async () => {
  let release: (() => void) | null = null;
  await withTransport({ ticketUrl: () => { return null; } }, async ({ t, h }) => {
    const a = await init(h.url("web-1"));
    const b = await init(h.url("web-2"));
    // A waiting request: hold the worker's answer.
    const w = t.workerOf("web-1")!;
    const real = w.request.bind(w);
    w.request = (s, m) => (m.method === "tools/list" ? new Promise((r) => { release = () => r(null); void real(s, m); }) : real(s, m));
    const waiting = post(h.url("web-1"), { jsonrpc: "2.0", id: 7, method: "tools/list" }, a);
    await until(() => release !== null);
    t.endSessions("web-1");
    release!();
    const r = await waiting;
    assert.deepEqual([r.status, r.body], [200, { jsonrpc: "2.0", id: 7, error: { code: -32603, message: MCP_ANSWER.ended } }]);
    assert.equal((await post(h.url("web-1"), { jsonrpc: "2.0", id: 8, method: "ping" }, a)).status, 404);
    assert.equal((await post(h.url("web-2"), { jsonrpc: "2.0", id: 8, method: "ping" }, b)).status, 200, "the other scope goes on");
    assert.equal(t.size("web-1"), 0);
  });
});

// ------------------------------------------------------------------ item 7: the memory bound

test("each scope's worker has the heap limit of C11 (512 MiB), an environment of its own and no output in the service's log", { timeout: 60_000 }, async () => {
  assert.equal(MCP_HEAP_MB, 512);
  const dir = mkdtempSync(join(tmpdir(), "ab-mcp-heap-"));
  const log: string[] = [];
  const w = new ScopeWorker("web-1", { list: LIST, folder: `${dir}/`, ticketUrl: () => null, ended: () => {}, log: (l) => log.push(l) });
  try {
    assert.equal(w.worker.resourceLimits?.maxOldGenerationSizeMb, 512);
    const h = await w.heap();
    assert.ok(h && h.limit > 400 * 1024 * 1024 && h.limit < 700 * 1024 * 1024, `the worker's heap limit: ${h?.limit}`);
  } finally { await w.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("a worker that passes its heap limit ends with its MCP sessions: their clients get the memory error, then the 404; the service and the other scopes go on", { timeout: 90_000 }, async () => {
  // A test worker that takes each message as the real one does, and fills its heap at a tools/call (a small limit).
  const entry = new URL("./fixtures/mcp-heap-worker.ts", import.meta.url);
  await withTransport({ worker: { heapMb: 24, entry } }, async ({ t, h, log }) => {
    const a = await init(h.url("web-1"));
    const b = await init(h.url("web-2"));
    const r = await post(h.url("web-1"), { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "browser_snapshot", arguments: {} } }, a);
    assert.deepEqual([r.status, r.body], [200, { jsonrpc: "2.0", id: 5, error: { code: -32603, message: MCP_ANSWER.memory } }]);
    assert.equal((await post(h.url("web-1"), { jsonrpc: "2.0", id: 6, method: "ping" }, a)).status, 404, "its sessions are gone");
    assert.equal((await post(h.url("web-2"), { jsonrpc: "2.0", id: 6, method: "ping" }, b)).status, 200, "the other scope goes on");
    assert.ok(log.includes("mcp: the MCP worker of scope web-1 ended (it passed its heap limit); its MCP sessions end"), log.join("\n"));
    await init(h.url("web-1"));
    assert.equal(t.size("web-1"), 1, "a new session gets a new worker");
  });
});

// ------------------------------------------------------------------ items 4 and 5 together: the MCP's own CDP connection

test("the MCP's Playwright connects back to the agent door with a one-time ticket of its scope: the relay admits it as the service's own pid, and the model serves it", { timeout: 90_000 }, async () => {
  const tickets = new Tickets();
  const r = await harness({ peerCheck: new PeerGate({ reader: selfReader(), uid: 1001 }), tickets } as any);
  try {
    await r.ready(LINE2);
    await withTransport({ ticketUrl: (scope) => `${r.url(scope)}?ticket=${tickets.mint(scope)}` }, async ({ t, h, log }) => {
      const sid = await init(h.url("web-1"));
      const call = post(h.url("web-1"), { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "browser_tabs", arguments: { action: "list" } } }, sid);
      await until(() => r.relay.model.connectionCount === 1, "the MCP's connection at the agent door", 30_000);
      assert.equal(tickets.size, 0, "the ticket is used up");
      const got = await call;
      assert.equal(got.status, 200);
      assert.ok(got.body.result, "the tool answers");
      assert.ok(!got.text.includes("ticket"), "no ticket in the tool's answer (review-115 note 10)");
      for (const [id, name, args] of [[10, "browser_navigate", { url: "http://a.example/" }], [11, "browser_snapshot", {}], [12, "browser_tabs", { action: "list" }]] as const) {
        const a = await post(h.url("web-1"), { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }, sid);
        assert.ok(a.body.result && !a.text.includes("ticket"), `${name}: no ticket in its answer`);
      }
      assert.ok(!r.logs.join("\n").includes("ticket=") && !log.join("\n").includes("ticket"), "no ticket in a log");
      // The session's end closes its browser connection.
      t.endSessions("web-1");
      await until(() => r.relay.model.connectionCount === 0, "the connection closes with the session", 20_000);
    });
  } finally { await r.close(); }
});

// ------------------------------------------------------------------ item 8: the wiring, off by default

test("--test-mcp-port takes 0 (a free port that the kernel picks) or a port from 1024 to 65535, and nothing else", async () => {
  const { testMcpPort } = await import("../src/service/main.ts");
  for (const ok of ["0", "1024", "47311", "65535"]) assert.equal(testMcpPort(ok), Number(ok));
  for (const bad of ["", "-1", "80", "1023", "65536", "x", "1e3", " 4000"]) assert.throws(() => testMcpPort(bad), /--test-mcp-port must be 0/, bad);
});

test("the MCP part: status's mcp and the hello's mcp_token follow the port: none before it opens, ready with its address, failed when the take failed, closed on the Mac", { timeout: 30_000 }, async () => {
  const { McpPart } = await import("../src/service/mcp/part.ts");
  const dir = mkdtempSync(join(tmpdir(), "ab-mcp-part-"));
  const ready = () => ({ controlOff: false, notReady: null, sites: 1 });
  try {
    const p = new McpPart({ listen: { port: 0 }, stateFolder: dir, log: () => {} });
    try {
      assert.deepEqual(p.status(), { mcp: { state: "none", address: null } });
      assert.deepEqual(p.features(), []);
      await p.open({ url: (s) => `ws+unix:///x.sock:/devtools/browser/${s}`, readiness: ready });
      assert.deepEqual(p.status(), { mcp: { state: "ready", address: `127.0.0.1:${p.mcpPort!.port}` } });
      assert.deepEqual(p.features(), ["mcp_token"]);
    } finally { await p.close(); }
    const log: string[] = [];
    const f = new McpPart({ listen: { failed: "the MCP port's socket: systemd passed no socket named agent-browser-mcp.socket" }, stateFolder: dir, log: (l) => log.push(l) });
    await f.open({ url: (s) => s, readiness: ready });
    assert.deepEqual([f.status(), f.features()], [{ mcp: { state: "failed", address: null } }, []]);
    assert.ok(log.some((l) => l.startsWith("mcp: the MCP port cannot open, so the service serves no MCP: the MCP port's socket")));
    const mac = new McpPart({ listen: { port: 0 }, stateFolder: dir, log: () => {}, port: { platform: "darwin" } });
    try {
      await mac.open({ url: (s) => s, readiness: ready });
      assert.deepEqual([mac.status().mcp, mac.features()], [{ state: "closed", address: `127.0.0.1:${mac.mcpPort!.port}` }, []]);
    } finally { await mac.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the MCP part end to end from this process: the real reader admits this process under its own root with its token, and the transport's worker answers initialize and tools/list", { skip: process.platform !== "linux", timeout: 60_000 }, async () => {
  const { McpPart } = await import("../src/service/mcp/part.ts");
  const { createHash } = await import("node:crypto");
  const { parseStat } = await import("../src/relay/peer.ts");
  const dir = mkdtempSync(join(tmpdir(), "ab-mcp-e2e-"));
  const token = "abt1_" + Buffer.from("test, not a token: the part end to end", "latin1").toString("base64url");
  const p = new McpPart({ listen: { port: 0 }, stateFolder: dir, log: () => {} });
  try {
    const self = parseStat(readFileSync(`/proc/${process.pid}/stat`, "latin1"))!;
    // A set_sessions before the open: the part gives it to the port at the open.
    p.setSessions({ sessions: [{ scope: "t-e2e", repo: null, roots: [{ pid: process.pid, start: self.start }], cgroup: null, lifetime_id: null, mcp_token: createHash("sha256").update(token, "latin1").digest("hex") }] } as any);
    await p.open({ url: (s) => s, readiness: () => ({ controlOff: false, notReady: null, sites: 1 }) });
    const url = `http://127.0.0.1:${p.mcpPort!.port}/mcp/t-e2e`;
    const r = await post(url, INIT, undefined, { Authorization: `Bearer ${token}` });
    assert.equal(r.status, 200, r.text);
    const sid = r.sid!;
    await post(url, { jsonrpc: "2.0", method: "notifications/initialized" }, sid, { Authorization: `Bearer ${token}` });
    const l = await post(url, { jsonrpc: "2.0", id: 2, method: "tools/list" }, sid, { Authorization: `Bearer ${token}` });
    assert.equal(l.body.result.tools.length, 24);
    const noToken = await post(url, { jsonrpc: "2.0", id: 3, method: "tools/list" }, sid);
    assert.equal(noToken.status, 401, "every request needs the token");
    // session_ended: the connection closes and the MCP sessions end.
    p.sessionEnded("t-e2e");
    assert.equal(p.mcpTransport!.size(), 0);
  } finally { await p.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("the service with the MCP option (stage 1d part 2b): the port opens after the agent door, status gives ready and its address, the hello lists mcp_token, step 8 reads the model and config's control; without it, none", { skip: process.platform !== "linux", timeout: 60_000 }, async () => {
  const { startService } = await import("../src/service/service.ts");
  const dir = mkdtempSync(join(tmpdir(), "ab-mcp-svc-"));
  try {
    const s = await startService({ agentDoor: join(dir, "cdp.sock"), controlDoor: join(dir, "control.sock"), daemonCommand: join(dir, "daemon-command.json"), log: () => {}, mainPid: async () => null, lists: { listsFolder: join(dir, "lists"), stateFolder: join(dir, "state") }, mcp: { listen: { port: 0 } } });
    try {
      const st = s.state.status() as any;
      assert.equal(st.mcp.state, "ready");
      assert.match(st.mcp.address, /^127\.0\.0\.1:\d+$/);
      assert.deepEqual((s.state.hello as any).features, ["mcp_token"]);
      // Step 8 reads the model (no link here: its 503) and config's control (off: its 503), for this process under its own root.
      const { createHash } = await import("node:crypto");
      const { parseStat } = await import("../src/relay/peer.ts");
      const token = "abt1_" + Buffer.from("test, not a token: the service's step 8", "latin1").toString("base64url");
      const self = parseStat(readFileSync(`/proc/${process.pid}/stat`, "latin1"))!;
      await s.state.handle({ t: "req", id: "q1", op: "set_sessions", by: "daemon", sessions: [{ scope: "web-1", repo: null, roots: [{ pid: process.pid, start: self.start }], cgroup: null, lifetime_id: null, mcp_token: createHash("sha256").update(token, "latin1").digest("hex") }], remote: [], box: { hosts: [], cookie_names: [] } } as any);
      const url = `http://${st.mcp.address}/mcp/web-1`;
      const r1 = await post(url, INIT, undefined, { Authorization: `Bearer ${token}` });
      assert.deepEqual([r1.status, r1.text], [503, NOT_READY.link], "the model's not-ready text");
      await s.state.handle({ t: "req", id: "q2", op: "config", by: "daemon", enabled: true, control: false } as any);
      const r2 = await post(url, INIT, undefined, { Authorization: `Bearer ${token}` });
      assert.deepEqual([r2.status, r2.text], [503, "The agent browser is off: the operator turned agent control off."], "control off");
      // The agent door: the service's own pid gets the model's 503 first (C11's order), as any client.
      const r = await raw(s.agent.url("web-1"));
      assert.deepEqual([r.status, r.body], [503, NOT_READY.link]);
    } finally { await s.stop(); }
    const s2 = await startService({ agentDoor: join(dir, "cdp2.sock"), controlDoor: join(dir, "control2.sock"), daemonCommand: join(dir, "daemon-command.json"), log: () => {}, mainPid: async () => null, lists: { listsFolder: join(dir, "lists"), stateFolder: join(dir, "state") } });
    try {
      assert.deepEqual((s2.state.status() as any).mcp, { state: "none", address: null });
      assert.deepEqual((s2.state.hello as any).features, []);
      assert.equal(s2.mcp, null);
    } finally { await s2.stop(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------ the log rule (C11, C12; the token design, section 12)

const CANARY = `abt1_${"C".repeat(43)}`;
test("the log rule: the MCP path's log holds no token, fingerprint, tool argument, URL path, payload or MCP session id, and the worker's output never reaches it; each scan finds its planted twin", { skip: process.platform !== "linux", timeout: 60_000 }, async () => {
  const { McpPart } = await import("../src/service/mcp/part.ts");
  const { createHash } = await import("node:crypto");
  const { parseStat } = await import("../src/relay/peer.ts");
  const dir = mkdtempSync(join(tmpdir(), "ab-mcp-log-"));
  const log: string[] = [];
  const print = createHash("sha256").update(CANARY, "latin1").digest("hex");
  const p = new McpPart({ listen: { port: 0 }, stateFolder: dir, log: (l) => log.push(l) });
  const secrets = [CANARY, print, "https://canary.example/secret-path", "canary-file.png", "canary-payload-value"];
  try {
    const self = parseStat(readFileSync(`/proc/${process.pid}/stat`, "latin1"))!;
    p.setSessions({ sessions: [{ scope: "t-log", repo: null, roots: [{ pid: process.pid, start: self.start }], cgroup: null, lifetime_id: "lt-canary-test-value", mcp_token: print }] } as any);
    await p.open({ url: (s) => s, readiness: () => ({ controlOff: false, notReady: null, sites: 1 }) });
    const url = `http://127.0.0.1:${p.mcpPort!.port}/mcp/t-log?q=canary-payload-value`;
    const auth = { Authorization: `Bearer ${CANARY}` };
    const r = await post(url, INIT, undefined, auth);
    const sid = r.sid!;
    secrets.push(sid);
    await post(url, { jsonrpc: "2.0", method: "notifications/initialized" }, sid, auth);
    await post(url, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "browser_navigate", arguments: { url: "https://canary.example/secret-path", headers: { cookie: "canary-payload-value" } } } }, sid, auth);
    await post(url, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "browser_take_screenshot", arguments: { filename: "/etc/canary-file.png", scale: "css" } } }, sid, auth);
    await post(url, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "browser_navigate", arguments: { url: "https://canary.example/secret-path" } } }, sid, auth);
    await post(url, "{canary-payload-value", sid, auth);
    await post(url, { jsonrpc: "2.0", id: 5, method: "ping" }, sid, { Authorization: "Bearer abt1_canary-payload-value" });
    await fetch(url, { method: "DELETE", headers: { "Mcp-Session-Id": sid, ...auth } }).then((x) => x.text());
    p.sessionEnded("t-log");
    const text = log.join("\n");
    assert.ok(log.some((l) => l.startsWith("mcp: MCP session 1 of scope t-log begins")) && log.some((l) => l.includes("a tools/call refused")), "the scan reads the MCP path's lines");
    assert.deepEqual(secrets.filter((s) => text.includes(s)), [], "no secret in the log");
    // The twins: the same scan over the log with one secret planted finds exactly that secret (review-115 note 11).
    for (const s of secrets) assert.deepEqual(secrets.filter((x) => `${text}\n${s}`.includes(x)), [s], "the twin: a planted secret is found");
  } finally { await p.close(); rmSync(dir, { recursive: true, force: true }); }
  // The worker's own output: read by the service (a stream of its own), never in its log.
  const dir2 = mkdtempSync(join(tmpdir(), "ab-mcp-out-"));
  const log2: string[] = [];
  const w = new ScopeWorker("t-out", { list: LIST, folder: `${dir2}/`, ticketUrl: () => null, ended: () => {}, log: (l) => log2.push(l), heapMb: 32, entry: new URL("./fixtures/mcp-heap-worker.ts", import.meta.url) });
  let out = "";
  w.worker.stdout.on("data", (d) => (out += d));
  w.worker.stderr.on("data", (d) => (out += d));
  try {
    assert.equal(await w.open("s1"), null);
    await until(() => out.includes("worker stderr"), "the worker's output");
    assert.ok(out.includes(CANARY), "the output stream holds what the worker wrote (the twin)");
    assert.ok(!log2.join("\n").includes(CANARY), "the service's log does not");
  } finally { await w.stop(); rmSync(dir2, { recursive: true, force: true }); }
});

test("the worker's environment is its own: no variable of the service's environment (DEBUG, PLAYWRIGHT_*, a test variable) reaches it", { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-mcp-env-"));
  process.env.AB_TEST_PARENT_ONLY = "a test value";
  const w = new ScopeWorker("t-env", { list: LIST, folder: `${dir}/`, ticketUrl: () => null, ended: () => {}, log: () => {}, heapMb: 32, entry: new URL("./fixtures/mcp-heap-worker.ts", import.meta.url) });
  try {
    const keys = await new Promise<string[]>((resolve) => { w.worker.on("message", (m: any) => { if (m.t === "env") resolve(m.keys); }); w.worker.postMessage({ t: "env" }); });
    assert.ok(Object.keys(process.env).length > keys.length);
    assert.deepEqual(keys.filter((k) => k === "AB_TEST_PARENT_ONLY" || k === "DEBUG" || k.startsWith("PLAYWRIGHT") || k === "NODE_OPTIONS" || k === "HOME"), []);
    assert.deepEqual(keys.sort(), ["LANG", "PATH"]);
  } finally { delete process.env.AB_TEST_PARENT_ONLY; await w.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("the worker's standard output and error never reach the service's own (the journal): a service process whose worker writes a canary prints none", { timeout: 60_000 }, async () => {
  const { execFile } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "ab-mcp-stdout-"));
  const script = `
    const { ScopeWorker } = await import(${JSON.stringify(join(ROOT, "src/service/mcp/workers.ts"))});
    const { readAllowList } = await import(${JSON.stringify(join(ROOT, "src/service/mcp/allow-list.ts"))});
    const w = new ScopeWorker("t-out", { list: readAllowList(), folder: process.argv[1], ticketUrl: () => null, ended: () => {}, log: (l) => console.error(l), heapMb: 32, entry: new URL(${JSON.stringify(new URL("./fixtures/mcp-heap-worker.ts", import.meta.url).href)}) });
    let seen = 0;
    w.worker.stdout.on("data", (d) => (seen += d.length));
    const opened = await w.open("s1");
    await new Promise((r) => setTimeout(r, 500));
    await w.stop();
    console.log(JSON.stringify({ opened, seen }));`;
  try {
    const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => execFile(process.execPath, ["--input-type=module", "-e", script, `${dir}/`], { cwd: ROOT, timeout: 50_000 }, (e, stdout, stderr) => (e ? reject(e) : resolve({ stdout, stderr }))));
    const got = JSON.parse(stdout.trim().split("\n").pop()!);
    assert.equal(got.opened, null, "the worker ran (a Node flag of the service's command line, here --input-type, does not reach it)");
    assert.ok(got.seen > 0, "the worker wrote its canary: the service read it (the twin)");
    assert.ok(!stdout.includes(CANARY) && !stderr.includes(CANARY), "no canary on the service's own output");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("step 8 of the MCP path reads the model: the number of sites of the scope's list, or null for a scope that the line does not name or gives no list", { timeout: 30_000 }, async () => {
  const h = await harness({ peerCheck: new PeerGate({ reader: selfReader(), uid: 1001 }) } as any);
  try {
    await h.ready({ t: "allowlist", lists: { a: ["a.example", "b.example"], e: [] }, scopes: { "web-1": "a", "web-2": "e", "web-3": null, "web-5": "a" }, default: null });
    const m = h.relay.model as any;
    assert.deepEqual(["web-1", "web-2", "web-3", "web-4"].map((s) => m.sitesOf(s)), [2, 0, null, null]);
    // A scope that an end_scope ended (C10), while the line still names it: no list.
    h.fake.line({ t: "end_scope", scope: "web-5" });
    await until(() => m.noList("web-5"), "the end of web-5");
    assert.equal(m.sitesOf("web-5"), null);
  } finally { await h.close(); }
});

// ------------------------------------------------------------------ review-115 (the fix round)

const FIXTURE = new URL("./fixtures/mcp-heap-worker.ts", import.meta.url);

test("review-115 B1: the service opens its MCP path before its control door: while the MCP's open waits, no control door exists; then every hello lists mcp_token", { skip: process.platform !== "linux", timeout: 60_000 }, async () => {
  const { startService } = await import("../src/service/service.ts");
  const { existsSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "ab-mcp-order-"));
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  try {
    const started = startService({ agentDoor: join(dir, "cdp.sock"), controlDoor: join(dir, "control.sock"), daemonCommand: join(dir, "daemon-command.json"), log: () => {}, mainPid: async () => null, lists: { listsFolder: join(dir, "lists"), stateFolder: join(dir, "state") }, mcp: { listen: { port: 0 }, openGate: gate } });
    let s: Awaited<typeof started> | null = null;
    try {
      await sleep(500);
      const early = existsSync(join(dir, "control.sock"));
      release();
      s = await started;
      assert.equal(early, false, "no control door (so no hello) before the MCP's open ends");
      assert.equal(existsSync(join(dir, "control.sock")), true);
      assert.deepEqual((s.state.hello as any).features, ["mcp_token"], "the first hello already lists mcp_token");
      assert.equal((s.state.status() as any).mcp.state, "ready");
    } finally { release(); s ??= await started.catch(() => null); await s?.stop(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("review-115 B1: an MCP open that fails (its port in use) leaves the hello with no mcp_token and status.mcp failed, from the first hello on", { skip: process.platform !== "linux", timeout: 60_000 }, async () => {
  const { startService } = await import("../src/service/service.ts");
  const dir = mkdtempSync(join(tmpdir(), "ab-mcp-fail-"));
  const busy = createServer(() => {});
  await new Promise<void>((r) => busy.listen(0, "127.0.0.1", r));
  try {
    const s = await startService({ agentDoor: join(dir, "cdp.sock"), controlDoor: join(dir, "control.sock"), daemonCommand: join(dir, "daemon-command.json"), log: () => {}, mainPid: async () => null, lists: { listsFolder: join(dir, "lists"), stateFolder: join(dir, "state") }, mcp: { listen: { port: (busy.address() as { port: number }).port } } });
    try {
      assert.deepEqual((s.state.status() as any).mcp, { state: "failed", address: null });
      assert.deepEqual((s.state.hello as any).features, []);
    } finally { await s.stop(); }
  } finally { busy.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("review-115 B2: an initialize whose MCP session cannot be made gets the 503 of C11: the open passes its time, the session ends during the open, the worker passes its heap limit during the open, the service stops", { timeout: 90_000 }, async () => {
  const notOpened = { jsonrpc: "2.0", id: 1, error: { code: -32000, message: MCP_ANSWER.notOpened } };
  await withTransport({ worker: { heapMb: 24, entry: FIXTURE, openWaitMs: 400 } }, async ({ t, h }) => {
    const late = await post(h.url("slow-open"), INIT);
    assert.deepEqual([late.status, late.body], [503, notOpened], "the open passes its time");
    const ending = post(h.url("slow-open"), INIT);
    await until(() => t.size("slow-open") === 1, "the session in its open");
    t.endSessions("slow-open");
    const ended = await ending;
    assert.deepEqual([ended.status, ended.body], [503, notOpened], "endSessions during the open");
    const oom = await post(h.url("oom-open"), INIT);
    assert.deepEqual([oom.status, oom.body], [503, notOpened], "the worker's memory end during the open");
    assert.equal(t.size(), 0);
    await t.stop();
    const stopped = await post(h.url("web-1"), INIT);
    assert.deepEqual([stopped.status, stopped.body], [503, notOpened], "the service stops");
  });
});

test("review-115 B2: a body that is no JSON-RPC message gets 400 Invalid Request, and a GET gets the 405 with C11's text", { timeout: 60_000 }, async () => {
  await withTransport({}, async ({ h }) => {
    const sid = await init(h.url("web-1"));
    for (const body of [{ id: 1, method: "ping" }, { jsonrpc: "1.0", id: 1, method: "ping" }, 5, "x", null]) {
      const r = await post(h.url("web-1"), JSON.stringify(body), sid);
      assert.deepEqual([r.status, r.body], [400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: MCP_ANSWER.invalid } }], JSON.stringify(body));
    }
    const get = await fetch(h.url("web-1"), { headers: { "Mcp-Session-Id": sid } });
    assert.deepEqual([get.status, await get.json()], [405, { jsonrpc: "2.0", id: null, error: { code: -32000, message: MCP_ANSWER.noStream } }]);
    const withId = await post(h.url("web-1"), INIT, sid);
    assert.deepEqual([withId.status, withId.body.error], [400, { code: -32600, message: MCP_ANSWER.initializeWithId }]);
  });
});

test("review-115 B3: only initialize, ping, tools/list and tools/call and the two notifications reach the MCP: another request, another notification and a client's answer never reach the worker", { timeout: 60_000 }, async () => {
  await withTransport({}, async ({ t, h }) => {
    const sid = await init(h.url("web-1"));
    const w = t.workerOf("web-1")!;
    const seen: string[] = [];
    const req = w.request.bind(w), note = w.notify.bind(w);
    w.request = (s, m) => { seen.push(`request ${String(m.method)}`); return req(s, m); };
    w.notify = (s, m) => { seen.push(`notify ${String(m.method ?? "an answer")}`); note(s, m); };
    const other = await post(h.url("web-1"), { jsonrpc: "2.0", id: 4, method: "resources/list" }, sid);
    assert.deepEqual([other.status, other.body], [200, { jsonrpc: "2.0", id: 4, error: { code: -32601, message: MCP_ANSWER.methodNotFound } }]);
    for (const m of [{ jsonrpc: "2.0", method: "notifications/roots/list_changed" }, { jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: 1, progress: 1 } }, { jsonrpc: "2.0", id: 0, result: { roots: [{ uri: "file:///etc/" }] } }, { jsonrpc: "2.0", id: 1, error: { code: -1, message: "x" } }]) {
      assert.equal((await post(h.url("web-1"), m, sid)).status, 202, JSON.stringify(m));
    }
    assert.deepEqual(seen, [], "nothing of these reached the worker");
    await post(h.url("web-1"), { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 99 } }, sid);
    assert.equal((await post(h.url("web-1"), { jsonrpc: "2.0", id: 5, method: "ping" }, sid)).status, 200);
    assert.deepEqual(seen, ["notify notifications/cancelled", "request ping"], "the allowed ones reach it (the spy reads)");
  });
});

test("review-115 note 7: an id that is no string and no integer gets 400 Invalid Request, an id of a request that still waits gets C11's -32600; neither reaches the worker or leaves a request waiting", { timeout: 60_000 }, async () => {
  await withTransport({}, async ({ t, h }) => {
    const sid = await init(h.url("web-1"));
    const w = t.workerOf("web-1")!;
    const seen: unknown[] = [];
    let hold: (() => void) | null = null;
    const req = w.request.bind(w);
    // The spy holds the first request with the id "slow" until the test lets it go.
    w.request = (s, m) => { seen.push(m.id); return m.id === "slow" && hold === null ? new Promise((r) => { hold = () => void req(s, m).then(r); }) : req(s, m); };
    for (const id of [null, 1.5, true, { a: 1 }, [1]]) {
      const r = await post(h.url("web-1"), { jsonrpc: "2.0", id, method: "ping" }, sid);
      assert.deepEqual([r.status, r.body], [400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: MCP_ANSWER.invalid } }], JSON.stringify(id));
    }
    const first = post(h.url("web-1"), { jsonrpc: "2.0", id: "slow", method: "ping" }, sid);
    await until(() => hold !== null, "the first request waits");
    const dup = await post(h.url("web-1"), { jsonrpc: "2.0", id: "slow", method: "tools/list" }, sid);
    assert.deepEqual([dup.status, dup.body], [400, { jsonrpc: "2.0", id: "slow", error: { code: -32600, message: MCP_ANSWER.duplicateId } }]);
    hold!();
    assert.deepEqual((await first).body, { jsonrpc: "2.0", id: "slow", result: {} }, "the first request keeps its own answer");
    assert.deepEqual(seen, ["slow"], "only the first reached the worker");
    // The id is free again after its answer.
    assert.equal((await post(h.url("web-1"), { jsonrpc: "2.0", id: "slow", method: "ping" }, sid)).status, 200);
  });
});

test("review-115 note 2: <state>/mcp and <state>/mcp/<scope> are made with mode 0700, and a link in their place makes the path rule refuse each path argument", { skip: process.platform !== "linux", timeout: 60_000 }, async () => {
  await withTransport({}, async ({ h, dir }) => {
    const sid = await init(h.url("web-1"));
    const state = join(dir, "state"), folder = scopeFolder(state, "web-1");
    assert.equal(statSync(join(state, "mcp")).mode & 0o777, 0o700);
    assert.equal(statSync(folder).mode & 0o777, 0o700);
    const shot = (id: number) => post(h.url("web-1"), { jsonrpc: "2.0", id, method: "tools/call", params: { name: "browser_take_screenshot", arguments: { filename: "x.png", scale: "css" } } }, sid);
    const refused = { code: -32602, message: `Not available in the agent browser: filename must name a file in the session's folder ${folder}` };
    // The scope's folder becomes a link to a folder of the test.
    const { renameSync } = await import("node:fs");
    mkdirSync(join(dir, "elsewhere"));
    renameSync(folder, join(dir, "moved"));
    symlinkSync(join(dir, "elsewhere"), folder.slice(0, -1));
    assert.deepEqual((await shot(2)).body.error, refused, "the scope's folder is a link");
    const nav = await post(h.url("web-1"), { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "browser_tabs", arguments: { action: "list" } } }, sid);
    assert.ok(nav.body.result, "a call with no path argument still passes");
  });
  // <state>/mcp itself a link.
  const dir = mkdtempSync(join(tmpdir(), "ab-mcp-link-"));
  try {
    const state = join(dir, "state");
    mkdirSync(join(dir, "elsewhere", "web-1"), { recursive: true, mode: 0o700 });
    mkdirSync(state);
    symlinkSync(join(dir, "elsewhere"), join(state, "mcp"));
    const folder = scopeFolder(state, "web-1");
    assert.deepEqual(checkCall(LIST, { name: "browser_snapshot", arguments: { filename: "s.md" } }, folder, undefined, [join(state, "mcp"), folder]), refusePath("filename", folder));
    assert.equal(checkCall(LIST, { name: "browser_snapshot", arguments: { filename: "s.md" } }, join(dir, "elsewhere", "web-1/"), undefined, [join(dir, "elsewhere"), join(dir, "elsewhere", "web-1")]), null, "the same call with real folders passes");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("review-115 notes 5, 6 and 9: the list test reads strings in anyOf, oneOf, items and nested properties, fails at a shape that it cannot read, a required key left out of keys and a key _meta; tools/list shows only the list's keys", { timeout: 60_000 }, async () => {
  const { tools } = await pinnedToolsList();
  const withProp = (prop: unknown, rule?: Partial<{ keys: string[]; paths: string[] }>) => {
    const pinned = tools.map((t) => (t.name === "browser_wait_for" ? { ...t, inputSchema: { ...t.inputSchema, properties: { ...(t.inputSchema.properties as object), extra: prop } } } : t));
    const r = LIST.tools.browser_wait_for;
    const list: AllowList = { ...LIST, tools: { ...LIST.tools, browser_wait_for: { keys: rule?.keys ?? [...r.keys, "extra"], paths: rule?.paths ?? [], schema: pinned.find((t) => t.name === "browser_wait_for")!.inputSchema } } };
    return checkList(list, pinned, PIN);
  };
  assert.deepEqual(withProp({ anyOf: [{ type: "string", description: "The file to read" }, { type: "null" }] }), [RULES.pathKey], "a nullable string in anyOf");
  assert.deepEqual(withProp({ oneOf: [{ type: "string" }, { type: "number" }], description: "A path" }), [RULES.pathKey], "oneOf under a description that speaks of a path");
  assert.deepEqual(withProp({ type: "object", properties: { where: { type: "string", description: "the folder" } } }), [RULES.pathKey], "a nested property");
  assert.deepEqual(withProp({ type: "array", items: { type: "object", properties: { file: { type: "string" } } } }), [RULES.pathKey], "a property of the items");
  assert.deepEqual(withProp({ type: "object", additionalProperties: { type: "string", description: "a file name" } }), [RULES.pathKey], "additionalProperties");
  assert.deepEqual(withProp({ type: ["string", "null"], description: "a directory" }), [RULES.pathKey], "a type list");
  assert.deepEqual(withProp({ $ref: "#/definitions/x" }), [RULES.shape], "a shape that the test cannot read");
  assert.deepEqual(withProp({}), [RULES.shape], "a schema with no type");
  assert.deepEqual(withProp({ type: "object", patternProperties: { ".*": { type: "string", description: "a file" } } }), [RULES.shape], "a keyword that the test does not know, with a type");
  assert.deepEqual(withProp({ anyOf: [{ type: "string" }, { type: "null" }], description: "a colour" }), [], "a string that speaks of no file");
  assert.deepEqual(withProp({ anyOf: [{ type: "string", description: "The file to read" }] }, { keys: [...LIST.tools.browser_wait_for.keys, "extra"], paths: ["extra"] }), [], "marked as a path");
  // A required key left out of keys.
  const shot = LIST.tools.browser_take_screenshot;
  assert.deepEqual(checkList({ ...LIST, tools: { ...LIST.tools, browser_take_screenshot: { ...shot, keys: shot.keys.filter((k) => k !== "scale") } } }, tools, PIN), [RULES.required]);
  // _meta: a list that names it fails, and a call with it is refused.
  const nav = LIST.tools.browser_navigate;
  assert.ok(checkList({ ...LIST, tools: { ...LIST.tools, browser_navigate: { ...nav, keys: [...nav.keys, "_meta"] } } }, tools, PIN).includes(RULES.meta));
  assert.deepEqual(checkCall(LIST, { name: "browser_navigate", arguments: { url: "https://a.example/", _meta: { cwd: "/" } } }, "/s/mcp/web-1/"), { code: -32602, message: "Not available in the agent browser: the argument _meta of browser_navigate" });
  // tools/list: each tool's input schema with only its keys, and only their required entries.
  const listed = filterTools(LIST, tools);
  const s = listed.find((t) => t.name === "browser_take_screenshot")!.inputSchema as any;
  assert.deepEqual(Object.keys(s.properties).sort(), [...shot.keys].sort());
  assert.ok(!("type" in s.properties), "the refused key type is not shown");
  assert.deepEqual(s.required, ["scale"]);
  for (const t of listed) assert.deepEqual(Object.keys((t.inputSchema as any).properties ?? {}).sort(), [...LIST.tools[t.name].keys].sort(), t.name);
});

// ------------------------------------------------------------------ board ab-v16.94.12: review-115b and review-115's note 3
//
// The new exports of this task (the shape check, the folder rule, the cancelled answer) are read through dynamic imports,
// so that each test fails alone on the code before it (the tests that failed first).

const TRANSPORT = "../src/service/mcp/transport.ts";
const tabs = (id: unknown) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "browser_tabs", arguments: { action: "list" } } });
const cancelNote = (requestId: unknown) => ({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId, reason: "the test cancels it" } });
const answerOf = (name: string) => ((MCP_ANSWERS as Record<string, { code: number; text: string }>)[name] ?? { code: NaN, text: `no answer ${name} in the code` });

/** A front whose requests carry the port's browser gate (the start at a use), which the test holds. */
async function gatedFront(t: McpTransport, gate: () => Promise<boolean>): Promise<Http> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const scope = /^\/mcp\/([^/?]+)/.exec(req.url ?? "")?.[1] ?? "none";
    void t.request(req, res, scope, gate, "local");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { server, url: (scope) => `http://127.0.0.1:${port}/mcp/${scope}`, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

test("review-115b P1: the list test has no exception for a string with enum or const: an enum string that speaks of a file, in keys and not in paths, breaks the rule of file and path keys", { timeout: 60_000 }, async () => {
  const { tools } = await pinnedToolsList();
  const shot = LIST.tools.browser_take_screenshot;
  const type = (tools.find((t) => t.name === "browser_take_screenshot")!.inputSchema.properties as any).type;
  assert.ok(type.type === "string" && Array.isArray(type.enum), "the pinned type of browser_take_screenshot is an enum string");
  assert.deepEqual(checkList({ ...LIST, tools: { ...LIST.tools, browser_take_screenshot: { ...shot, keys: [...shot.keys, "type"] } } }, tools, PIN), [RULES.pathKey], "type in keys and not in paths");
  assert.deepEqual(checkList({ ...LIST, tools: { ...LIST.tools, browser_take_screenshot: { ...shot, keys: [...shot.keys, "type"], paths: [...shot.paths, "type"] } } }, tools, PIN), [], "type in keys and in paths");
  // The rule reads an enum and a const string as any string.
  assert.equal(fileString("format", { type: "string", enum: ["png", "jpeg"], description: "The format of the file" }), true, "an enum string that speaks of a file");
  assert.equal(fileString("mode", { type: "string", const: "x", description: "the folder's mode" }), true, "a const string that speaks of a folder");
  assert.equal(fileString("format", { type: "string", enum: ["png", "jpeg"], description: "An image format" }), false, "an enum string that speaks of no file");
  // The format's vector of this case.
  const b = V.badLists.find((x: any) => x.note.startsWith("an enum string that speaks of a file"));
  assert.ok(b, "the vector");
  assert.deepEqual(checkList(b.list, b.pinnedTools, V.pin), [RULES.pathKey]);
});

test("review-115b P2: a client that closes its connection while its tool call waits: the MCP gets notifications/cancelled, the id is free at once, and the call no longer counts as a use", { timeout: 60_000 }, async () => {
  await withTransport({}, async ({ t, h }) => {
    const sid = await init(h.url("web-1"));
    const w = t.workerOf("web-1")!;
    const seen: string[] = [];
    const req = w.request.bind(w), note = w.notify.bind(w);
    // The MCP never answers a cancelled request: the spy holds the first call with the id 7 for good.
    w.request = (s, m) => { seen.push(`request ${String(m.method)} ${JSON.stringify(m.id)}`); return m.id === 7 && m.method === "tools/call" ? new Promise(() => {}) : req(s, m); };
    w.notify = (s, m) => { seen.push(`notify ${String(m.method)} ${JSON.stringify((m.params as any)?.requestId)}`); note(s, m); };
    const ac = new AbortController();
    const first = fetch(h.url("web-1"), { method: "POST", headers: { "Content-Type": "application/json", "Mcp-Session-Id": sid }, body: JSON.stringify(tabs(7)), signal: ac.signal }).then(() => "answered", () => "closed");
    await until(() => seen.includes("request tools/call 7"), "the call reaches the worker");
    assert.equal(t.activity().calls, 1, "the call counts as a use");
    ac.abort();
    assert.equal(await first, "closed");
    await until(() => seen.includes("notify notifications/cancelled 7"), "the MCP gets the cancel");
    const again = await post(h.url("web-1"), { jsonrpc: "2.0", id: 7, method: "ping" }, sid);
    assert.deepEqual([again.status, again.body], [200, { jsonrpc: "2.0", id: 7, result: {} }], "the id is free at once: no duplicate 400");
    assert.equal(t.activity().calls, 0, "the cancelled call counts no more");
  });
});

test("review-115b's note: a client's own notifications/cancelled of a waiting request reaches the MCP, frees the id at once, and the request's open POST gets C11's cancelled answer", { timeout: 60_000 }, async () => {
  await withTransport({}, async ({ t, h }) => {
    const sid = await init(h.url("web-1"));
    const w = t.workerOf("web-1")!;
    const seen: string[] = [];
    const req = w.request.bind(w), note = w.notify.bind(w);
    w.request = (s, m) => { seen.push(`request ${String(m.method)} ${JSON.stringify(m.id)}`); return m.id === "c1" && m.method === "tools/call" ? new Promise(() => {}) : req(s, m); };
    w.notify = (s, m) => { seen.push(`notify ${String(m.method)} ${JSON.stringify((m.params as any)?.requestId)}`); note(s, m); };
    const wd = w as typeof w & { drop?: (s: string, id: unknown) => void };
    const drop = wd.drop?.bind(w);
    wd.drop = (s, id) => { seen.push(`drop ${JSON.stringify(id)}`); drop?.(s, id); };
    const first = post(h.url("web-1"), tabs("c1"), sid);
    await until(() => seen.includes('request tools/call "c1"'), "the call reaches the worker");
    assert.equal((await post(h.url("web-1"), cancelNote("c1"), sid)).status, 202);
    const got = await Promise.race([first, sleep(5000).then(() => null)]);
    assert.ok(got !== null, "the open POST gets an answer");
    const want = answerOf("cancelled");
    assert.deepEqual([got.status, got.body], [200, { jsonrpc: "2.0", id: "c1", error: { code: -32800, message: want.text } }]);
    assert.ok(seen.includes('notify notifications/cancelled "c1"'), "the cancel reached the MCP");
    assert.ok(seen.includes('drop "c1"'), "the worker drops the call's wait (an answer that still came would find none)");
    assert.equal((await post(h.url("web-1"), { jsonrpc: "2.0", id: "c1", method: "ping" }, sid)).status, 200, "the id is free");
    assert.equal(t.activity().calls, 0);
  });
});

test("review-115b P2: a tool call that waits for the start at a use holds its id (a request with that id gets the duplicate 400 at once, and the call keeps its own answer); a cancel during that wait frees the id, and the call gets the cancelled answer when the wait ends and never reaches the MCP", { timeout: 60_000 }, async () => {
  await withTransport({}, async ({ t }) => {
    let open: ((v: boolean) => void) | null = null;
    let waits = 0;
    const g = await gatedFront(t, () => { waits++; return new Promise<boolean>((r) => { open = r; }); });
    try {
      const sid = await init(g.url("web-1"));
      const w = t.workerOf("web-1")!;
      const seen: string[] = [];
      const req = w.request.bind(w);
      w.request = (s, m) => { seen.push(`${String(m.method)} ${JSON.stringify(m.id)}`); return req(s, m); };
      const call = post(g.url("web-1"), tabs(9), sid);
      await until(() => waits === 1, "the call waits for the browser");
      const dup = await post(g.url("web-1"), { jsonrpc: "2.0", id: 9, method: "ping" }, sid);
      assert.deepEqual([dup.status, dup.body], [400, { jsonrpc: "2.0", id: 9, error: { code: -32600, message: MCP_ANSWER.duplicateId } }]);
      open!(true); open = null;
      const r = await call;
      assert.deepEqual([r.status, r.body.id, r.body.result?.isError], [200, 9, true], "the call's own answer (the tool's error: no browser here)");
      const call2 = post(g.url("web-1"), tabs(10), sid);
      await until(() => waits === 2, "the second call waits for the browser");
      assert.equal((await post(g.url("web-1"), cancelNote(10), sid)).status, 202);
      assert.equal((await post(g.url("web-1"), { jsonrpc: "2.0", id: 10, method: "ping" }, sid)).status, 200, "the id is free at once");
      open!(true);
      const r2 = await call2;
      assert.deepEqual([r2.status, r2.body], [200, { jsonrpc: "2.0", id: 10, error: { code: -32800, message: answerOf("cancelled").text } }]);
      assert.deepEqual(seen, ["tools/call 9", "ping 10"], "the cancelled call never reached the MCP");
    } finally { await g.close(); }
  });
});

test("review-115b P2: the pinned MCP gives no answer to a request that its client cancelled, so the transport frees the id itself", { timeout: 60_000 }, async () => {
  const got: Message[] = [];
  let release: (() => void) | null = null;
  const s = await openMcpServer({ list: LIST, folder: "/nonexistent-test-folder/mcp/t/", context: () => new Promise((_, reject) => { release = () => reject(new Error("no browser in this test")); }), answer: (m) => got.push(m) });
  try {
    s.deliver(INIT);
    await until(() => got.find((m) => m.id === 1), "initialize's answer");
    s.deliver({ jsonrpc: "2.0", method: "notifications/initialized" });
    s.deliver(tabs(2));
    await until(() => release !== null, "the call waits for its browser");
    s.deliver(cancelNote(2));
    await sleep(100);
    release!();
    s.deliver({ jsonrpc: "2.0", id: 3, method: "ping" });
    await until(() => got.find((m) => m.id === 3), "the ping's answer");
    await sleep(300);
    assert.equal(got.filter((m) => m.id === 2).length, 0, "no answer for the cancelled call");
  } finally { await s.close(); }
});

test("review-115b P3: the MCP's own JSON-RPC error passes with HTTP 200, as its result does", { timeout: 60_000 }, async () => {
  await withTransport({}, async ({ h }) => {
    const sid = await init(h.url("web-1"));
    const r = await post(h.url("web-1"), { jsonrpc: "2.0", id: 5, method: "tools/list", params: { cursor: 5 } }, sid);
    assert.equal(r.status, 200);
    assert.equal(r.body.id, 5);
    assert.equal(r.body.error.code, -32603, "the MCP's own error of a cursor that is no string");
    assert.ok(!Object.values(MCP_ANSWERS).some((a) => a.text === r.body.error.message), "no answer of the transport's own table");
  });
});

/** Bodies that are JSON but no message of the MCP's shapes (C11; review-115b P4). */
const BAD_SHAPES: unknown[] = [
  { jsonrpc: "2.0" },
  { jsonrpc: "2.0", id: 3 },
  { jsonrpc: "2.0", id: 3, result: {}, error: { code: 1, message: "x" } },
  { jsonrpc: "2.0", result: {} },
  { jsonrpc: "2.0", id: null, result: {} },
  { jsonrpc: "2.0", method: 5 },
  { jsonrpc: "2.0", id: 4, method: null },
  { jsonrpc: "2.0", id: 2 ** 53, method: "ping" },
  { jsonrpc: "2.0", id: -(2 ** 53), method: "ping" },
  { jsonrpc: "2.0", id: 4, method: "ping", foo: 1 },
  { jsonrpc: "2.0", method: "notifications/initialized", foo: 1 },
  { jsonrpc: "2.0", id: 4, result: {}, foo: 1 },
  { jsonrpc: "2.0", id: 4, method: "ping", params: "x" },
  { jsonrpc: "2.0", id: 4, method: "ping", params: [] },
  { jsonrpc: "2.0", id: 4, method: "ping", params: null },
  { jsonrpc: "2.0", method: "notifications/cancelled", params: 7 },
  { jsonrpc: "2.0", id: 4, method: "ping", params: { _meta: 5 } },
  { jsonrpc: "2.0", id: 4, method: "ping", params: { _meta: { progressToken: 1.5 } } },
  { jsonrpc: "2.0", id: 4, method: "ping", params: { _meta: { "io.modelcontextprotocol/related-task": { taskId: 5 } } } },
  { ...tabs(4), result: {} },
];

test("review-115b P4: a body that is JSON but no message of the MCP's three shapes, also an id that is no safe integer, gets 400 Invalid Request with or without a session id and never reaches the MCP; each shape that it takes gets the MCP's answer", { timeout: 60_000 }, async () => {
  await withTransport({}, async ({ t, h }) => {
    const sid = await init(h.url("web-1"));
    const w = t.workerOf("web-1")!;
    const seen: string[] = [];
    const req = w.request.bind(w), note = w.notify.bind(w);
    w.request = (s, m) => { seen.push(JSON.stringify(m)); return req(s, m); };
    w.notify = (s, m) => { seen.push(JSON.stringify(m)); note(s, m); };
    for (const b of BAD_SHAPES) {
      for (const id of [sid, undefined]) {
        const r = await post(h.url("web-1"), JSON.stringify(b), id);
        assert.deepEqual([r.status, r.body], [400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: MCP_ANSWER.invalid } }], `${JSON.stringify(b)} ${id ? "with" : "without"} a session id`);
      }
    }
    assert.deepEqual(seen, [], "no such body reached the worker");
    // The shapes that the transport takes at their edges: the MCP answers each one.
    for (const [id, params] of [[6, {}], [7, { x: 1 }], [8, { _meta: { progressToken: "p" } }], [9, { _meta: { progressToken: 3, "io.modelcontextprotocol/related-task": { taskId: "t" } } }], [2 ** 53 - 1, undefined], [-(2 ** 53 - 1), undefined]] as [number, unknown][]) {
      const r = await post(h.url("web-1"), { jsonrpc: "2.0", id, method: "ping", ...(params === undefined ? {} : { params }) }, sid);
      assert.deepEqual([r.status, r.body], [200, { jsonrpc: "2.0", id, result: {} }], `ping ${id}`);
    }
  });
  const { messageShape } = await import(TRANSPORT) as { messageShape?: (m: unknown) => string | null };
  assert.equal(typeof messageShape, "function", "the transport's shape check");
  for (const b of BAD_SHAPES) assert.equal(messageShape!(b), null, JSON.stringify(b));
  assert.deepEqual([tabs(1), { jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", id: "a", result: {} }, { jsonrpc: "2.0", id: 0, error: { code: 1, message: "x" } }].map((m) => messageShape!(m)), ["request", "notification", "answer", "answer"]);
});

test("review-115b P4: the pinned MCP gives no answer to a message of another shape (an extra member, a params that is no object, a _meta that is no object), so the transport refuses such a body", { timeout: 60_000 }, async () => {
  const got: Message[] = [];
  const s = await openMcpServer({ list: LIST, folder: "/nonexistent-test-folder/mcp/t/", context: async () => { throw new Error("no browser in this test"); }, answer: (m) => got.push(m) });
  try {
    s.deliver(INIT);
    await until(() => got.find((m) => m.id === 1), "initialize's answer");
    s.deliver({ jsonrpc: "2.0", method: "notifications/initialized" });
    const odd: Message[] = [{ jsonrpc: "2.0", id: 2, method: "ping", foo: 1 }, { jsonrpc: "2.0", id: 3, method: "ping", params: "x" }, { jsonrpc: "2.0", id: 4, method: "ping", params: { _meta: 5 } }];
    for (const m of odd) s.deliver(m);
    s.deliver({ jsonrpc: "2.0", id: 5, method: "ping", params: { _meta: { progressToken: "p" } } });
    await until(() => got.find((m) => m.id === 5), "the answer of a ping of the MCP's shape");
    await sleep(300);
    assert.deepEqual(got.filter((m) => [2, 3, 4].includes(m.id as number)), [], "no answer for a message of another shape");
  } finally { await s.close(); }
});

test("review-115 note 3: the scope's folder goes with its files once its worker stopped (dropScope), and a later session of that name starts with an empty folder; keepScopes removes the folder of each scope that it does not name; a link goes as a link", { skip: process.platform !== "linux", timeout: 60_000 }, async () => {
  const tr = await import(TRANSPORT) as { removeScopeFolder?: (state: string, scope: string) => unknown };
  const holds: (() => void)[] = [];
  await withTransport({}, async ({ t, h, dir, log }) => { try {
    const x = t as McpTransport & { dropScope?: (scope: string, why: string) => Promise<void>; keepScopes?: (named: ReadonlySet<string>) => Promise<void> };
    assert.equal(typeof x.dropScope, "function", "the transport's dropScope");
    const state = join(dir, "state"), mcp = join(state, "mcp"), folder = scopeFolder(state, "web-1");
    /** Hold the stop of the scope's worker until the test lets it go. */
    const holdStop = () => {
      const w = t.workerOf("web-1")!;
      const real = w.stop.bind(w);
      let go!: () => void;
      const gate = new Promise<void>((r) => { go = r; });
      w.stop = () => gate.then(real);
      holds.push(go);
      return go;
    };
    await init(h.url("web-1"));
    writeFileSync(join(folder, "shot.png"), "a test file of an earlier session");
    let go = holdStop();
    const dropping = x.dropScope!("web-1", "its session ended");
    await sleep(200);
    assert.ok(existsSync(join(folder, "shot.png")), "the folder waits for the worker's stop");
    go();
    await dropping;
    assert.equal(existsSync(folder), false, "the folder and its file are gone");
    assert.equal(t.size("web-1"), 0);
    assert.equal(t.workerOf("web-1"), undefined);
    assert.ok(log.includes("mcp: the folder of scope web-1 is emptied (its session ended)"), log.join("\n"));
    await x.dropScope!("web-7", "a test");
    assert.ok(!log.some((l) => l.includes("web-7")), "no log line for a scope with no folder");
    // A new MCP session of the scope before the worker's stop keeps the folder.
    await init(h.url("web-1"));
    writeFileSync(join(folder, "kept.png"), "a test file");
    go = holdStop();
    const dropping2 = x.dropScope!("web-1", "its session ended");
    await sleep(100);
    await init(h.url("web-1"));
    go();
    await dropping2;
    assert.ok(existsSync(join(folder, "kept.png")), "a new MCP session meanwhile keeps the folder");
    await x.dropScope!("web-1", "its session ended");
    await init(h.url("web-1"));
    assert.deepEqual(readdirSync(folder), [], "a later session of the same name: an empty folder");
    // No name that is no scope: `..` would be the state folder.
    assert.deepEqual(tr.removeScopeFolder!(state, ".."), { removed: false, why: null });
    assert.ok(existsSync(join(state, "mcp")), "the state folder stays");
    await init(h.url("web-2"));
    mkdirSync(join(mcp, "old-1"));
    writeFileSync(join(mcp, "old-1", "f.pdf"), "a test file");
    mkdirSync(join(mcp, "not a scope"));
    await x.keepScopes!(new Set(["web-1"]));
    assert.deepEqual(readdirSync(mcp).sort(), ["not a scope", "web-1"], "the named scope and a name that is no scope stay");
    assert.equal(t.size("web-2"), 0, "a scope that set_sessions does not name: its MCP sessions end");
    assert.equal(t.size("web-1"), 1, "the named scope's MCP session goes on");
    // A link in a scope's place goes as a link; its target and the target's file stay.
    mkdirSync(join(dir, "target"));
    writeFileSync(join(dir, "target", "keep.txt"), "a test file");
    symlinkSync(join(dir, "target"), join(mcp, "web-3"));
    await x.dropScope!("web-3", "a test");
    assert.equal(existsSync(join(mcp, "web-3")), false);
    assert.equal(readFileSync(join(dir, "target", "keep.txt"), "utf8"), "a test file");
  } finally { for (const go of holds) go(); } }); // a held stop always ends, so no worker outlives the test
  // <state>/mcp itself a link: nothing goes.
  const dir = mkdtempSync(join(tmpdir(), "ab-mcp-drop-"));
  try {
    const state = join(dir, "state");
    mkdirSync(join(dir, "elsewhere", "web-1"), { recursive: true });
    writeFileSync(join(dir, "elsewhere", "web-1", "f.txt"), "a test file");
    mkdirSync(state);
    symlinkSync(join(dir, "elsewhere"), join(state, "mcp"));
    assert.deepEqual(tr.removeScopeFolder!(state, "web-1"), { removed: false, why: "<state>/mcp is a link or no folder of the service's user" });
    assert.deepEqual(tr.removeScopeFolder!(state, ".."), { removed: false, why: null }, "no name that is no scope");
    assert.ok(existsSync(join(dir, "elsewhere", "web-1", "f.txt")), "nothing through the link");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("review-115 note 3: the MCP part removes a scope's folder at session_ended and at a set_sessions that does not name the scope (sessions and remote both name); the service does it at C12's session_ended and set_sessions", { skip: process.platform !== "linux", timeout: 60_000 }, async () => {
  const { McpPart } = await import("../src/service/mcp/part.ts");
  const dir = mkdtempSync(join(tmpdir(), "ab-mcp-part-drop-"));
  const item = (scope: string) => ({ scope, repo: null, roots: [], cgroup: null, lifetime_id: null, mcp_token: null });
  const snap = (sessions: string[], remote: string[] = []) => ({ sessions: sessions.map(item), remote: remote.map((scope) => ({ scope, box: "b", list: "l", mcp_token: null })), box: { hosts: [], cookie_names: [] } }) as any;
  try {
    const mcp = join(dir, "mcp");
    for (const s of ["a-1", "b-1", "r-1"]) { mkdirSync(join(mcp, s), { recursive: true }); writeFileSync(join(mcp, s, "f.txt"), "a test file"); }
    const p = new McpPart({ listen: { port: 0 }, stateFolder: dir, log: () => {} });
    try {
      await p.open({ url: (s) => s, readiness: () => ({ controlOff: false, notReady: null, sites: 1 }) });
      p.setSessions(snap(["a-1"], ["r-1"]));
      await until(() => !existsSync(join(mcp, "b-1")), "the folder of a scope that set_sessions does not name");
      assert.deepEqual(readdirSync(mcp).sort(), ["a-1", "r-1"]);
      p.sessionEnded("a-1");
      await until(() => !existsSync(join(mcp, "a-1")), "the folder at session_ended");
      assert.deepEqual(readdirSync(mcp), ["r-1"]);
    } finally { await p.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
  // Through the service: C12's set_sessions and session_ended reach the part.
  const { startService } = await import("../src/service/service.ts");
  const sdir = mkdtempSync(join(tmpdir(), "ab-mcp-svc-drop-"));
  try {
    const state = join(sdir, "state"), mcp = join(state, "mcp");
    for (const s of ["web-1", "web-9"]) { mkdirSync(join(mcp, s), { recursive: true }); writeFileSync(join(mcp, s, "f.txt"), "a test file"); }
    const svc = await startService({ agentDoor: join(sdir, "cdp.sock"), controlDoor: join(sdir, "control.sock"), daemonCommand: join(sdir, "daemon-command.json"), log: () => {}, mainPid: async () => null, lists: { listsFolder: join(sdir, "lists"), stateFolder: state }, mcp: { listen: { port: 0 } } });
    try {
      await svc.state.handle({ t: "req", id: "q1", op: "set_sessions", by: "daemon", ...snap(["web-1"]) } as any);
      await until(() => !existsSync(join(mcp, "web-9")), "set_sessions: the folder of web-9 goes");
      assert.ok(existsSync(join(mcp, "web-1", "f.txt")), "a named scope keeps its files");
      await svc.state.handle({ t: "req", id: "q2", op: "session_ended", by: "daemon", scope: "web-1" } as any);
      await until(() => !existsSync(join(mcp, "web-1")), "session_ended: the folder of web-1 goes");
    } finally { await svc.stop(); }
  } finally { rmSync(sdir, { recursive: true, force: true }); }
});

test("board ab-v16.94.14 note 5: session_ended through a control door: the door logs and writes its answer first, and the scope's folder goes after it, with its files", { skip: process.platform !== "linux", timeout: 60_000 }, async () => {
  const { startService } = await import("../src/service/service.ts");
  const { ControlDoor } = await import("../src/service/control.ts");
  const { daemonClient, DAEMON_HELLO } = await import("./fake-daemon.ts");
  const dir = mkdtempSync(join(tmpdir(), "ab-mcp-door-drop-"));
  const logs: string[] = [];
  try {
    const state = join(dir, "state"), mcp = join(state, "mcp");
    for (const s of ["web-1", "web-2"]) { mkdirSync(join(mcp, s), { recursive: true }); writeFileSync(join(mcp, s, "f.txt"), "a test file"); }
    const svc = await startService({ agentDoor: join(dir, "cdp.sock"), controlDoor: join(dir, "control.sock"), daemonCommand: join(dir, "daemon-command.json"), log: (l) => logs.push(l), mainPid: async () => null, lists: { listsFolder: join(dir, "lists"), stateFolder: state }, mcp: { listen: { port: 0 } } });
    // The service's own control door admits only the daemon (service-admission.test.ts tests that admission); a second
    // control door over the service's own handler, with an admission that admits this test, carries the request.
    const door = await ControlDoor.open({ path: join(dir, "door.sock"), handler: svc.state, log: (l) => logs.push(l), admit: async () => ({ ok: true }) });
    try {
      const c = await daemonClient(join(dir, "door.sock"));
      await c.next((l) => l.t === "hello");
      c.send(DAEMON_HELLO);
      c.send({ t: "req", id: "e", op: "session_ended", by: { kind: "daemon", user: "ann", via: "daemon" }, scope: "web-1" });
      assert.equal((await c.answer("e")).ok, true);
      await until(() => !existsSync(join(mcp, "web-1")), "the folder of web-1 goes");
      const answered = logs.indexOf("control: session_ended by daemon ann via daemon: ok");
      const removed = logs.indexOf("mcp: the folder of scope web-1 is emptied (its session ended)");
      assert.ok(answered >= 0 && removed > answered, `the removal comes after the answer:\n${logs.join("\n")}`);
      assert.ok(existsSync(join(mcp, "web-2", "f.txt")), "another scope keeps its files");
      c.end();
    } finally { await door.stop(); await svc.stop(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("review-115b's note: a request at the MCP port before the service's agent door opens gets the 503 of a link that is down", { skip: process.platform !== "linux", timeout: 60_000 }, async () => {
  const { startService } = await import("../src/service/service.ts");
  const { createHash } = await import("node:crypto");
  const { parseStat } = await import("../src/relay/peer.ts");
  const dir = mkdtempSync(join(tmpdir(), "ab-mcp-early-"));
  const token = "abt1_" + Buffer.from("test, not a token: before the agent door", "latin1").toString("base64url");
  const self = parseStat(readFileSync(`/proc/${process.pid}/stat`, "latin1"))!;
  let during: { status: number; text: string; agentDoor: boolean; controlDoor: boolean } | null = null;
  try {
    const s = await startService({
      agentDoor: join(dir, "cdp.sock"), controlDoor: join(dir, "control.sock"), daemonCommand: join(dir, "daemon-command.json"), log: () => {}, mainPid: async () => null,
      lists: { listsFolder: join(dir, "lists"), stateFolder: join(dir, "state") },
      mcp: {
        listen: { port: 0 },
        afterOpen: async (part) => {
          part.setSessions({ sessions: [{ scope: "web-1", repo: null, roots: [{ pid: process.pid, start: self.start }], cgroup: null, lifetime_id: null, mcp_token: createHash("sha256").update(token, "latin1").digest("hex") }], remote: [], box: { hosts: [], cookie_names: [] } } as any);
          const r = await post(`http://127.0.0.1:${part.mcpPort!.port}/mcp/web-1`, INIT, undefined, { Authorization: `Bearer ${token}` });
          during = { status: r.status, text: r.text, agentDoor: existsSync(join(dir, "cdp.sock")), controlDoor: existsSync(join(dir, "control.sock")) };
        },
      },
    });
    try {
      assert.deepEqual(during, { status: 503, text: NOT_READY.link, agentDoor: false, controlDoor: false }, "the 503 of a link that is down, before the doors open");
      assert.ok(existsSync(join(dir, "cdp.sock")), "then the agent door opens");
    } finally { await s.stop(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("review-115b's note: the path rule's real folder is a folder of the service's own user: the same folder for another uid, or a folder of root, refuses each path argument", () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-mcp-uid-"));
  try {
    const uid = process.getuid!();
    const folder = scopeFolder(dir, "web-1");
    mkdirSync(folder, { recursive: true });
    assert.equal(realFolder(dir), true);
    assert.equal(realFolder(dir, uid), true);
    assert.equal(realFolder(dir, uid + 1), false, "the same folder for another uid");
    if (uid !== 0) assert.equal(realFolder("/"), false, "a real folder of root");
    const shot = { name: "browser_take_screenshot", arguments: { filename: "x.png", scale: "css" } };
    assert.equal(checkCall(LIST, shot, folder, undefined, [join(dir, "mcp"), folder]), null);
    if (uid !== 0) assert.deepEqual(checkCall(LIST, shot, folder, undefined, ["/", folder]), refusePath("filename", folder), "a folder of another user");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("review-115b's note: tools/list drops the required entry of each key that keys leaves out; only a list that the format's test refuses makes this filter act, so the test gives filterTools such a list", () => {
  const pinned = [{ name: "t_one", inputSchema: { type: "object", properties: { a: { type: "string" }, b: { type: "number" } }, required: ["a", "b"] } }];
  const list: AllowList = { ...LIST, tools: { t_one: { keys: ["a"], paths: [], schema: pinned[0].inputSchema } }, refused: { browser_run_code_unsafe: "x" } };
  assert.ok(checkList(list, pinned, PIN).includes(RULES.required), "the format's test refuses this list");
  const shown = filterTools(list, pinned)[0].inputSchema as any;
  assert.deepEqual([Object.keys(shown.properties), shown.required], [["a"], ["a"]]);
  // With the real list each required key is in keys (the format's test), so the filter keeps each entry.
  const real = filterTools(LIST, [{ name: "browser_take_screenshot", inputSchema: { type: "object", properties: { scale: {}, type: {} }, required: ["scale", "type"] } }])[0].inputSchema as any;
  assert.deepEqual(real.required, ["scale"], "a required key that keys leaves out (type) is dropped");
});

// ------------------------------------------------------------------ board ab-v16.94.12: review-121's fix round

type Dropper = McpTransport & { dropScope: (scope: string, why: string) => Promise<void>; keepScopes: (named: ReadonlySet<string>) => Promise<void> };
/** Hold a worker's stop until the test lets it go; `holds` gets the release, so a test's finally ends each held stop. */
function holdStop(w: ScopeWorker, holds: (() => void)[]): () => void {
  const real = w.stop.bind(w);
  let go!: () => void;
  const gate = new Promise<void>((r) => { go = r; });
  w.stop = () => gate.then(real);
  holds.push(go);
  return go;
}

test("review-121 B1: a tool call that waits for the start at a use, whose MCP session a DELETE ends while another MCP session of the scope stays, gets its session's end answer; its id and the use count are free, and it never reaches the MCP", { timeout: 60_000 }, async () => {
  await withTransport({}, async ({ t }) => {
    const opens: ((v: boolean) => void)[] = [];
    const g = await gatedFront(t, () => new Promise<boolean>((r) => { opens.push(r); }));
    try {
      const a = await init(g.url("web-1"));
      const b = await init(g.url("web-1"));
      const w = t.workerOf("web-1")!;
      const seen: string[] = [];
      const req = w.request.bind(w);
      w.request = (s, m) => { seen.push(`${String(m.method)} ${JSON.stringify(m.id)}`); return req(s, m); };
      const call = post(g.url("web-1"), tabs(11), a);
      await until(() => opens.length === 1, "the call waits for the browser");
      const del = await fetch(g.url("web-1"), { method: "DELETE", headers: { "Mcp-Session-Id": a } });
      assert.equal(del.status, 200);
      await del.text();
      assert.equal(t.size("web-1"), 1, "the MCP session B stays, and with it the worker");
      opens[0](true);
      const r = await Promise.race([call, sleep(5000).then(() => null)]);
      assert.ok(r !== null, "the waiting POST gets its answer");
      assert.deepEqual([r.status, r.body], [200, { jsonrpc: "2.0", id: 11, error: { code: -32603, message: MCP_ANSWER.ended } }]);
      assert.equal(t.activity().calls, 0, "no use count stays");
      assert.deepEqual(seen, [], "the call never reached the MCP");
      assert.equal((await post(g.url("web-1"), { jsonrpc: "2.0", id: 11, method: "ping" }, b)).status, 200, "B goes on");
    } finally { for (const o of opens) o(true); await g.close(); }
  });
});

test("review-121 note 2: the pinned MCP ignores a cancel with a falsy requestId or with params that fail its schema (a reason that is no string): it answers the call", { timeout: 60_000 }, async () => {
  const got: Message[] = [];
  const releases: (() => void)[] = [];
  const s = await openMcpServer({ list: LIST, folder: "/nonexistent-test-folder/mcp/t/", context: () => new Promise((_, reject) => { releases.push(() => reject(new Error("no browser in this test"))); }), answer: (m) => got.push(m) });
  try {
    s.deliver(INIT);
    await until(() => got.find((m) => m.id === 1), "initialize's answer");
    s.deliver({ jsonrpc: "2.0", method: "notifications/initialized" });
    for (const [id, cancel] of [[0, { requestId: 0, reason: "a test" }], ["", { requestId: "", reason: "a test" }], [5, { requestId: 5, reason: 5 }]] as [string | number, Message][]) {
      const n = releases.length;
      s.deliver(tabs(id));
      await until(() => releases.length > n, `the call ${JSON.stringify(id)} waits for its browser`);
      s.deliver({ jsonrpc: "2.0", method: "notifications/cancelled", params: cancel });
      await sleep(100);
      releases.at(-1)!();
      await until(() => got.find((m) => m.id === id), `the MCP's answer to the call ${JSON.stringify(id)}: the cancel was ignored`);
    }
  } finally { await s.close(); }
});

test("review-121 note 2: a cancel that the MCP ignores frees nothing: a client that closes its tool call with the id 0, or that cancels with a reason that is no string, keeps the id busy until the MCP's answer (the call is no use after its client's close: board ab-v16.94.14, O1)", { timeout: 60_000 }, async () => {
  await withTransport({}, async ({ t, h }) => {
    const url = h.url("web-1");
    const sid = await init(url);
    const w = t.workerOf("web-1")!;
    const answers = new Map<unknown, (m: Message) => void>();
    const seen: string[] = [];
    const req = w.request.bind(w), note = w.notify.bind(w);
    // The spy stands for the MCP: it answers a tool call only when the test says so.
    w.request = (s, m) => (m.method === "tools/call" ? new Promise((r) => { answers.set(m.id, r); }) : req(s, m));
    w.notify = (s, m) => { seen.push(`notify ${String(m.method)} ${JSON.stringify((m.params as any)?.requestId)}`); note(s, m); };
    const ac = new AbortController();
    const closed = fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "Mcp-Session-Id": sid }, body: JSON.stringify(tabs(0)), signal: ac.signal }).then(() => "answered", () => "closed");
    await until(() => answers.has(0), "the call with the id 0 reaches the MCP");
    ac.abort();
    assert.equal(await closed, "closed");
    await sleep(200);
    assert.ok(!seen.some((x) => x.startsWith("notify notifications/cancelled")), "no cancel that the MCP would ignore");
    assert.equal((await post(url, { jsonrpc: "2.0", id: 0, method: "ping" }, sid)).status, 400, "the id 0 stays busy");
    assert.equal(t.activity().calls, 0, "the call runs on in the MCP, but it is no use after its client's close (O1)");
    answers.get(0)!({ jsonrpc: "2.0", id: 0, result: { content: [] } });
    assert.equal((await post(url, { jsonrpc: "2.0", id: 0, method: "ping" }, sid)).status, 200, "then the id is free");
    const call = post(url, tabs(8), sid);
    await until(() => answers.has(8), "the call with the id 8 reaches the MCP");
    assert.equal((await post(url, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 8, reason: 5 } }, sid)).status, 202);
    assert.equal((await post(url, { jsonrpc: "2.0", id: 8, method: "ping" }, sid)).status, 400, "a cancel whose reason is no string frees nothing");
    answers.get(8)!({ jsonrpc: "2.0", id: 8, result: { content: [{ type: "text", text: "the MCP's own answer" }] } });
    const r = await call;
    assert.deepEqual([r.status, r.body], [200, { jsonrpc: "2.0", id: 8, result: { content: [{ type: "text", text: "the MCP's own answer" }] } }], "the call gets the MCP's answer");
  });
});

test("board ab-v16.94.14 O1: a tool call with the id 0 or \"\" whose client closes its connection is no use from that close on (no cancel goes to the MCP); its id stays busy until the MCP's answer or the end of its MCP session", { timeout: 60_000 }, async () => {
  await withTransport({}, async ({ t, h }) => {
    const url = h.url("web-1");
    let sid = await init(url);
    const w = t.workerOf("web-1")!;
    const answers = new Map<unknown, (m: Message | null) => void>();
    const seen: string[] = [];
    const req = w.request.bind(w), note = w.notify.bind(w), close = w.close.bind(w);
    // The spy stands for the MCP: it answers a tool call only when the test says so (a browser_evaluate whose script
    // never settles), and the end of the MCP session gives each call that waits null, as the worker's close does.
    w.request = (s, m) => (m.method === "tools/call" ? new Promise((r) => { answers.set(m.id, r); }) : req(s, m));
    w.notify = (s, m) => { seen.push(String(m.method)); note(s, m); };
    w.close = (s) => { for (const r of answers.values()) r(null); close(s); };
    const ping = async (id: unknown) => (await post(url, { jsonrpc: "2.0", id, method: "ping" }, sid)).status;
    const leave = async (id: unknown) => {
      const ac = new AbortController();
      const p = fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "Mcp-Session-Id": sid }, body: JSON.stringify(tabs(id)), signal: ac.signal }).then(() => "answered", () => "closed");
      await until(() => answers.has(id), `the call with the id ${JSON.stringify(id)} reaches the MCP`);
      assert.equal(t.activity().calls, 1, "the call is a use while its client waits");
      const before = performance.now();
      ac.abort();
      assert.equal(await p, "closed");
      await until(() => t.activity().calls === 0, "the client's close ends the use");
      const quiet = t.activity().quietFor;
      assert.ok(quiet <= performance.now() - before, "the use ended at the close: the quiet time counts from it");
    };
    // The id 0: the call runs on in the MCP, but it is no use; the MCP's answer frees the id.
    await leave(0);
    assert.equal(await ping(0), 400, "the id 0 stays busy");
    answers.get(0)!({ jsonrpc: "2.0", id: 0, result: { content: [] } });
    assert.equal(await ping(0), 200, "the MCP's answer frees the id");
    assert.equal(t.activity().calls, 0);
    // The id "": the end of its MCP session (a DELETE) frees it.
    await leave("");
    assert.equal(await ping(""), 400, "the id \"\" stays busy");
    assert.ok(!seen.includes("notifications/cancelled"), "no cancel that the MCP would ignore");
    assert.equal((await fetch(url, { method: "DELETE", headers: { "Mcp-Session-Id": sid } })).status, 200);
    assert.equal(t.size("web-1"), 0);
    assert.equal(t.activity().calls, 0, "no use count stays");
    sid = await init(url);
    assert.equal(await ping(""), 200, "a new MCP session takes the id \"\"");
  });
});

test("review-121 B4: the service's own stop removes no MCP folder: a stop during a drop that waits for the worker's stop keeps the folder and its files", { timeout: 60_000 }, async () => {
  const holds: (() => void)[] = [];
  await withTransport({}, async ({ t, h, dir }) => {
    try {
      const folder = scopeFolder(join(dir, "state"), "web-1");
      await init(h.url("web-1"));
      writeFileSync(join(folder, "f.png"), "a test file");
      const go = holdStop(t.workerOf("web-1")!, holds);
      const dropping = (t as Dropper).dropScope("web-1", "its session ended");
      await sleep(100);
      await t.stop();
      go();
      await dropping;
      assert.ok(existsSync(join(folder, "f.png")), "the service's stop removes no folder");
    } finally { for (const go of holds) go(); }
  });
});

test("review-121 note 4: the folder goes only after every worker of the scope that is still stopping has stopped, not only the last one", { timeout: 60_000 }, async () => {
  const holds: (() => void)[] = [];
  await withTransport({}, async ({ t, h, dir }) => {
    try {
      const url = h.url("web-1");
      const folder = scopeFolder(join(dir, "state"), "web-1");
      const a = await init(url);
      writeFileSync(join(folder, "f.png"), "a test file");
      const w1 = t.workerOf("web-1")!;
      const go1 = holdStop(w1, holds);
      const del = await fetch(url, { method: "DELETE", headers: { "Mcp-Session-Id": a } });
      await del.text();
      await init(url);
      const w2 = t.workerOf("web-1")!;
      assert.notEqual(w1, w2, "a second worker while the first one stops");
      const go2 = holdStop(w2, holds);
      const dropping = (t as Dropper).dropScope("web-1", "its session ended");
      go2();
      await sleep(300);
      assert.ok(existsSync(join(folder, "f.png")), "the first worker still stops: the folder stays");
      go1();
      await dropping;
      assert.equal(existsSync(folder), false);
    } finally { for (const go of holds) go(); }
  });
});

test("review-121 B2 and note 6: a removal that fails gets a log line with the scope and the error's code only, never a path: a folder that the service cannot empty, a plain file of a scope's name (it stays), a <state>/mcp that is a link; each scan finds its planted twin", { skip: process.platform !== "linux" || process.getuid!() === 0, timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-mcp-drop-fail-"));
  const log: string[] = [];
  const state = join(dir, "state"), mcp = join(state, "mcp"), locked = join(mcp, "web-1", "locked");
  const t = new McpTransport({ list: LIST, stateFolder: state, ticketUrl: () => null, log: (l) => log.push(l) }) as Dropper;
  const state2 = join(dir, "state2");
  const t2 = new McpTransport({ list: LIST, stateFolder: state2, ticketUrl: () => null, log: (l) => log.push(l) }) as Dropper;
  try {
    // A folder that the service cannot empty: a folder in it with no write right.
    mkdirSync(locked, { recursive: true });
    writeFileSync(join(locked, "f.png"), "a test file");
    chmodSync(locked, 0o500);
    let twin = "";
    try { rmSync(join(mcp, "web-1"), { recursive: true }); } catch (e) { twin = (e as Error).message; }
    assert.ok(twin.includes(dir), "the twin: the error's own message holds the path");
    await t.dropScope("web-1", "its session ended");
    assert.ok(existsSync(join(locked, "f.png")), "the file stays");
    assert.deepEqual(log, ["mcp: the folder of scope web-1 is not emptied (EACCES)"]);
    // A plain file of a scope's name: no folder, so it stays.
    writeFileSync(join(mcp, "web-2"), "a test file");
    await t.dropScope("web-2", "its session ended");
    assert.ok(existsSync(join(mcp, "web-2")), "a plain file stays");
    assert.equal(log.at(-1), "mcp: the folder of scope web-2 is not emptied (it is no folder)");
    // <state>/mcp a link: nothing goes, and the line says so.
    mkdirSync(join(dir, "elsewhere", "web-3"), { recursive: true });
    writeFileSync(join(dir, "elsewhere", "web-3", "f.txt"), "a test file");
    mkdirSync(state2);
    symlinkSync(join(dir, "elsewhere"), join(state2, "mcp"));
    await t2.dropScope("web-3", "its session ended");
    assert.equal(log.at(-1), "mcp: the folder of scope web-3 is not emptied (<state>/mcp is a link or no folder of the service's user)");
    await t2.keepScopes(new Set());
    assert.equal(log.at(-1), "mcp: no scope's folder is emptied (<state>/mcp is a link or no folder of the service's user)");
    assert.ok(existsSync(join(dir, "elsewhere", "web-3", "f.txt")));
    // The scan: no line holds a path; the twin above shows that the error's message would.
    const all = log.join("\n");
    assert.ok(!all.includes(dir) && !all.includes(tmpdir()) && !all.includes(twin), all);
  } finally {
    try { chmodSync(locked, 0o700); } catch {}
    await t.stop(); await t2.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("board ab-v16.94.14 N2 and N3: keepScopes logs a failed lstat of <state>/mcp with a code other than ENOENT, as dropScope does, and a failed readdir, each with the error's code only; no <state>/mcp gets no line; each scan finds its planted twin", { skip: process.platform !== "linux" || process.getuid!() === 0, timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-mcp-keep-fail-"));
  const log: string[] = [];
  const make = (state: string) => new McpTransport({ list: LIST, stateFolder: state, ticketUrl: () => null, log: (l) => log.push(l) }) as Dropper;
  // No <state>/mcp (ENOENT): no MCP session made it yet, so no line.
  const none = make(join(dir, "state-none"));
  // A state folder that is a plain file: the lstat of <state>/mcp fails with ENOTDIR.
  writeFileSync(join(dir, "state-file"), "a test file");
  const file = make(join(dir, "state-file"));
  // A <state>/mcp with no read right: its readdir fails with EACCES.
  const mcp = join(dir, "state-locked", "mcp");
  mkdirSync(join(mcp, "web-1"), { recursive: true });
  writeFileSync(join(mcp, "web-1", "f.txt"), "a test file");
  const locked = make(join(dir, "state-locked"));
  try {
    await none.keepScopes(new Set());
    await none.dropScope("web-1", "its session ended");
    assert.deepEqual(log, [], "no <state>/mcp: no line");
    let twin1 = "";
    try { lstatSync(join(dir, "state-file", "mcp")); } catch (e) { twin1 = (e as Error).message; }
    assert.ok(twin1.includes(dir), "the twin: the lstat error's own message holds the path");
    await file.keepScopes(new Set());
    assert.deepEqual(log, ["mcp: no scope's folder is emptied (ENOTDIR)"], "N2: the failed lstat gets its line");
    await file.dropScope("web-1", "its session ended");
    assert.equal(log.at(-1), "mcp: the folder of scope web-1 is not emptied (ENOTDIR)", "dropScope's line of the same case");
    chmodSync(mcp, 0o300);
    let twin2 = "";
    try { readdirSync(mcp); } catch (e) { twin2 = (e as Error).message; }
    assert.ok(twin2.includes(dir), "the twin: the readdir error's own message holds the path");
    await locked.keepScopes(new Set());
    assert.equal(log.at(-1), "mcp: no scope's folder is emptied (EACCES)", "the failed readdir gets its line");
    assert.ok(existsSync(join(mcp, "web-1", "f.txt")), "nothing goes");
    assert.equal(log.length, 3);
    const all = log.join("\n");
    assert.ok(!all.includes(dir) && !all.includes(tmpdir()) && !all.includes(twin1) && !all.includes(twin2), all);
  } finally {
    try { chmodSync(mcp, 0o700); } catch {}
    await none.stop(); await file.stop(); await locked.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("review-121 note 7: a link inside a scope's folder goes as a link (its target stays); a name with a slash and an empty name are no scope, and nothing goes", { skip: process.platform !== "linux", timeout: 60_000 }, async () => {
  const { removeScopeFolder } = await import(TRANSPORT) as { removeScopeFolder: (state: string, scope: string) => unknown };
  const dir = mkdtempSync(join(tmpdir(), "ab-mcp-drop-names-"));
  try {
    const state = join(dir, "state"), mcp = join(state, "mcp");
    mkdirSync(join(mcp, "web-1"), { recursive: true });
    mkdirSync(join(dir, "target"));
    writeFileSync(join(dir, "target", "keep.txt"), "a test file");
    symlinkSync(join(dir, "target"), join(mcp, "web-1", "inside"));
    removeScopeFolder(state, "web-1");
    assert.equal(existsSync(join(mcp, "web-1")), false, "the folder goes, with the link in it");
    assert.equal(readFileSync(join(dir, "target", "keep.txt"), "utf8"), "a test file", "the link's target stays");
    mkdirSync(join(mcp, "a", "b"), { recursive: true });
    writeFileSync(join(mcp, "a", "b", "f.txt"), "a test file");
    removeScopeFolder(state, "a/b");
    assert.ok(existsSync(join(mcp, "a", "b", "f.txt")), "a name with a slash is no scope");
    removeScopeFolder(state, "");
    assert.ok(existsSync(join(mcp, "a", "b", "f.txt")), "an empty name is no scope: <state>/mcp stays");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("review-121 note 8: the list test reads an enum or a const of strings with no type as a string", () => {
  assert.equal(fileString("format", { enum: ["png", "jpeg"], description: "The format of the file" }), true, "an untyped enum of strings that speaks of a file");
  assert.equal(fileString("mode", { const: "x", description: "the folder's mode" }), true, "an untyped const string that speaks of a folder");
  assert.equal(fileString("count", { enum: [1, 2], description: "the files' count" }), false, "an untyped enum of numbers is no string");
  assert.equal(fileString("format", { enum: ["png"], description: "An image format" }), false, "a string that speaks of no file");
});
