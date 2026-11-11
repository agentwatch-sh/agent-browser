// The Playwright MCP inside the service, behind the MCP port (contract C11, "The MCP inside the service" and the MCP path;
// docs/contracts/mcp-allow-list.md and its vectors; C12's `status.mcp` and the hello's `mcp_token`; stage 1d part 2b,
// board ab-v16.94.5). The pinned `@playwright/mcp` answers `initialize` and `tools/list` with no browser, so these tests
// start no Chrome, no Xvfb and no display: the MCP's own CDP connection goes to the relay of test/fake-bridge.ts, whose
// fake peer reader says that the peer is this process (the service's own pid), so only a ticket admits it. Every token
// here is a made-up test value; every folder is a temp folder of the test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NOT_READY } from "../src/relay/model.ts";
import { PeerGate, sessionRefusal, type PeerReader } from "../src/relay/peer.ts";
import { checkCall, checkList, filterTools, LIST_FILE, NEVER_CAPABILITIES, readAllowList, refusePath, RULES, RUN_CODE, SERVICE_TOOLS, speaksOfPath, type AllowList, type PinnedTool } from "../src/service/mcp/allow-list.ts";
import { mcpConfig, openMcpServer, SERVER_SIDE_CAPABILITIES, type Message } from "../src/service/mcp/session.ts";
import { ticketOf, TICKET_MS, Tickets } from "../src/service/mcp/ticket.ts";
import { MCP_ANSWER, MCP_MAX_BODY, MCP_SESSIONS_PER_SCOPE, MCP_SESSIONS_PER_SERVICE, McpTransport, scopeFolder } from "../src/service/mcp/transport.ts";
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

test("the format's calls: each pinned tool's call passes or gets its answer; the service's own tools wait for stage 1e (-32601 now)", () => {
  const real = (map: Record<string, string> = {}) => (p: string) => map[p] ?? p;
  let n = 0;
  for (const c of V.calls) {
    const service = Object.hasOwn(SERVICE_TOOLS, c.call.name);
    const got = checkCall(V.list, c.call, V.folder, real(c.realpath));
    if (service) { assert.deepEqual(got, { code: -32601, message: `Not available in the agent browser: ${c.call.name}` }, `${c.note}: stage 1e serves it`); continue; }
    n++;
    assert.deepEqual(got, c.answer === "pass" ? null : c.answer, c.note);
  }
  assert.ok(n >= 10);
  // A call whose arguments are no object, and a path value that is no string.
  assert.deepEqual(checkCall(V.list, { name: "browser_navigate", arguments: ["x"] }, V.folder), { code: -32602, message: "Not available in the agent browser: the arguments of browser_navigate must be a JSON object" });
  assert.deepEqual(checkCall(V.list, { name: "browser_take_screenshot", arguments: { filename: 5 } }, V.folder), refusePath("filename", V.folder));
  // tools/list: only the list's tools (and no service tool before stage 1e).
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
/** A plain HTTP server in front of the transport: the path's scope is the connection's scope (the port's admission is tested in service-mcp-port.test.ts). */
async function front(t: McpTransport): Promise<Http> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const scope = /^\/mcp\/([^/?]+)/.exec(req.url ?? "")?.[1] ?? "none";
    void t.request(req, res, scope);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { server, url: (scope) => `http://127.0.0.1:${port}/mcp/${scope}`, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}
type Reply = { status: number; sid: string | null; body: any; text: string; headers: Headers };
async function post(url: string, body: unknown, sid?: string, extra: Record<string, string> = {}): Promise<Reply> {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(sid ? { "Mcp-Session-Id": sid } : {}), ...extra }, body: typeof body === "string" ? body : JSON.stringify(body) });
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
    assert.deepEqual(p.status(), { mcp: { state: "none", address: null } });
    assert.deepEqual(p.features(), []);
    await p.open({ url: (s) => `ws+unix:///x.sock:/devtools/browser/${s}`, readiness: ready });
    assert.deepEqual(p.status(), { mcp: { state: "ready", address: `127.0.0.1:${p.mcpPort!.port}` } });
    assert.deepEqual(p.features(), ["mcp_token"]);
    await p.close();
    const log: string[] = [];
    const f = new McpPart({ listen: { failed: "the MCP port's socket: systemd passed no socket named agent-browser-mcp.socket" }, stateFolder: dir, log: (l) => log.push(l) });
    await f.open({ url: (s) => s, readiness: ready });
    assert.deepEqual([f.status(), f.features()], [{ mcp: { state: "failed", address: null } }, []]);
    assert.ok(log.some((l) => l.startsWith("mcp: the MCP port cannot open, so the service serves no MCP: the MCP port's socket")));
    const mac = new McpPart({ listen: { port: 0 }, stateFolder: dir, log: () => {}, port: { platform: "darwin" } });
    await mac.open({ url: (s) => s, readiness: ready });
    assert.deepEqual([mac.status().mcp, mac.features()], [{ state: "closed", address: `127.0.0.1:${mac.mcpPort!.port}` }, []]);
    await mac.close();
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
    for (const s of secrets) assert.deepEqual([s].filter((x) => `${text}\n${s}`.includes(x)), [s], "the twin: a planted secret is found");
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
    await w.open("s1");
    await new Promise((r) => setTimeout(r, 500));
    await w.stop();
    console.log("DONE");`;
  try {
    const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => execFile(process.execPath, ["--input-type=module", "-e", script, `${dir}/`], { cwd: ROOT, timeout: 50_000 }, (e, stdout, stderr) => (e ? reject(e) : resolve({ stdout, stderr }))));
    assert.match(stdout, /DONE/);
    assert.ok(!stdout.includes(CANARY) && !stderr.includes(CANARY), "no canary on the service's own output");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("step 8 of the MCP path reads the model: the number of sites of the scope's list, or null for a scope that the line does not name or gives no list", { timeout: 30_000 }, async () => {
  const h = await harness({ peerCheck: new PeerGate({ reader: selfReader(), uid: 1001 }) } as any);
  try {
    await h.ready({ t: "allowlist", lists: { a: ["a.example", "b.example"], e: [] }, scopes: { "web-1": "a", "web-2": "e", "web-3": null }, default: null });
    const m = h.relay.model as any;
    assert.deepEqual(["web-1", "web-2", "web-3", "web-4"].map((s) => m.sitesOf(s)), [2, 0, null, null]);
  } finally { await h.close(); }
});
