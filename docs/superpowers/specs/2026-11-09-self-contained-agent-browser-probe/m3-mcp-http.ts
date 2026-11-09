// M3 (board ab-v16.93): the standard Playwright MCP (@playwright/mcp) started from code inside one process, pointed at
// a CDP endpoint, and served over HTTP (Streamable HTTP, the MCP SDK's server transport) on a Unix socket at the path
// /mcp/<scope>. Linux only; the probe's own headless Chromium with a temp profile; one local page (a.localhost).
//
//   PW_MCP_DIR=<a scratch folder with @playwright/mcp, @modelcontextprotocol/sdk and ws installed> \
//   flock <heavy.lock> timeout 1500 node m3-mcp-http.ts
//
// Part A: plain HTTP requests (curl --unix-socket) call initialize, tools/list, browser_navigate and browser_snapshot;
// a request with an Origin header gets a 403. Part B: the same calls through the stdio shim (m3-shim.mjs), as a local
// MCP client would make them. Part C: the same server object behind a small transport of the probe's own, with no
// MCP SDK package; that transport refuses browser_run_code_unsafe and drops it from tools/list. Each part gets a fresh Chromium: the probe's CDP endpoint is a plain pipe bridge for one
// client at a time (agent-browser's relay serves many). It writes results/m3.json.

import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { harnessGuard } from "../../../../test/live/guard.ts";

if (process.platform !== "linux") throw new Error("M3 runs on Linux only");
const PW = process.env.PW_MCP_DIR;
if (!PW) throw new Error("PW_MCP_DIR must name the scratch folder with @playwright/mcp");
const req = createRequire(join(PW, "package.json"));
const { createConnection } = req("@playwright/mcp");
const { StreamableHTTPServerTransport } = req("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { WebSocketServer } = req("ws");
const CHROMIUM = process.env.CHROMIUM ?? "/usr/bin/chromium";
const HERE = fileURLToPath(new URL(".", import.meta.url));
const SCOPE = "m3";
const result: Record<string, unknown> = {
  chromium: execFileSync(CHROMIUM, ["--version"], { encoding: "utf8" }).trim(), node: process.version,
  playwrightMcp: req("@playwright/mcp/package.json").version, playwrightCore: req("playwright-core/package.json").version,
  mcpSdk: JSON.parse(readFileSync(join(PW, "node_modules/@modelcontextprotocol/sdk/package.json"), "utf8")).version,
};
const mem = () => Math.round(process.memoryUsage().rss / 1024 / 1024);
result.rssMiBAtStart = mem();

const guard = await harnessGuard("m3-mcp-http");
const run = mkdtempSync(join(tmpdir(), "ab-m3-"));
const agentSock = join(run, "agent.sock");

// ------------------------------------------------------------------ a local site
const site = createServer((rq, rs) => {
  rs.writeHead(200, { "Content-Type": "text/html" }).end(`<!doctype html><title>M3 page</title><h1>Hello from a.localhost</h1><p id="ua"></p><button onclick="this.textContent='clicked'">Go</button><script>document.getElementById('ua').textContent = 'webdriver=' + navigator.webdriver</script>`);
});
await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
const SITE = `http://a.localhost:${(site.address() as { port: number }).port}/`;

// ------------------------------------------------------------------ a Chromium with a CDP endpoint on a Unix socket
async function startChrome(name: string): Promise<{ endpoint: string; stop: () => Promise<void> }> {
  const dir = join(run, name);
  mkdirSync(join(dir, "home"), { recursive: true });
  const chrome = spawn(CHROMIUM, ["--headless=new", "--remote-debugging-pipe", `--user-data-dir=${join(dir, "profile")}`, "--no-first-run",
    "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-default-apps",
    "--password-store=basic", "about:blank"], { env: { PATH: process.env.PATH, HOME: join(dir, "home"), LANG: "C.UTF-8" }, stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  guard.track(chrome.pid, `Chromium-${name}`);
  const sock = join(dir, "cdp.sock");
  const server = createServer();
  await new Promise<void>((r) => { const u = process.umask(0o077); server.listen(sock, () => { process.umask(u); r(); }); });
  const wss = new WebSocketServer({ server });
  let client: any = null, buf = "";
  (chrome.stdio[3] as Writable).on("error", () => {});
  (chrome.stdio[4] as Readable).on("error", () => {});
  (chrome.stdio[4] as Readable).setEncoding("utf8").on("data", (d: string) => {
    buf += d;
    for (let i; (i = buf.indexOf("\0")) >= 0;) { const m = buf.slice(0, i); buf = buf.slice(i + 1); if (client?.readyState === 1) client.send(m); }
  });
  wss.on("connection", (ws: any) => { client = ws; ws.on("message", (m: Buffer) => (chrome.stdio[3] as Writable).write(String(m) + "\0")); });
  return {
    endpoint: `ws+unix://${sock}:/devtools/browser/${SCOPE}`,
    stop: async () => {
      wss.close();
      server.close();
      chrome.kill("SIGTERM");
      await new Promise((r) => { const t = setTimeout(r, 10000); chrome.once("exit", () => { clearTimeout(t); r(null); }); });
      if (chrome.exitCode === null && chrome.signalCode === null) chrome.kill("SIGKILL");
    },
  };
}

// ------------------------------------------------------------------ the service's MCP door: HTTP on a Unix socket
let cdpEndpoint = "";
const sessions = new Map<string, any>();
let createMs: number[] = [];
async function onMcp(rq: IncomingMessage, rs: ServerResponse) {
  // A browser always sends Origin on a cross-origin request: a web page never reaches the MCP (C11's first check).
  if (rq.headers.origin !== undefined) return void rs.writeHead(403, { "Content-Type": "text/plain" }).end("A web page cannot connect to the agent browser.");
  const m = /^\/mcp\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/.exec(new URL(rq.url ?? "/", "http://agent").pathname);
  if (!m) return void rs.writeHead(404, { "Content-Type": "text/plain" }).end("Not found. Use /mcp/<scope>.");
  let body = "";
  for await (const c of rq) body += c;
  const parsed = body ? JSON.parse(body) : undefined;
  const sid = rq.headers["mcp-session-id"] as string | undefined;
  let transport = sid ? sessions.get(sid) : undefined;
  if (!transport) {
    if (sid || parsed?.method !== "initialize") return void rs.writeHead(404, { "Content-Type": "text/plain" }).end("No such MCP session.");
    const t0 = performance.now();
    // The standard Playwright MCP, from code: its usual tools, against the scope's CDP endpoint.
    const server = await createConnection({ browser: { cdpEndpoint }, outputDir: join(run, "mcp-out") });
    transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), enableJsonResponse: true,
      onsessioninitialized: (id: string) => sessions.set(id, transport), onsessionclosed: (id: string) => sessions.delete(id) });
    await server.connect(transport);
    createMs.push(performance.now() - t0);
  }
  await transport.handleRequest(rq, rs, parsed);
}
const door = createServer((rq, rs) => { onMcp(rq, rs).catch((e) => { if (!rs.headersSent) rs.writeHead(500).end(String(e?.message ?? e)); }); });
await new Promise<void>((r) => { const u = process.umask(0o077); door.listen(agentSock, () => { process.umask(u); r(); }); });

// ------------------------------------------------------------------ part C's door: the service's own small transport
// No MCP SDK package: the server object of createConnection needs only a transport with start, send and close.
// JSON answers only; a message of the server that answers no request (a notification) is counted and dropped.
class OwnTransport {
  onmessage?: (m: any) => void; onclose?: () => void; onerror?: (e: Error) => void;
  dropped = 0;
  private waiting = new Map<unknown, (m: any) => void>();
  async start() {}
  async close() { this.onclose?.(); }
  async send(m: any) {
    const w = m && m.id !== undefined && ("result" in m || "error" in m) ? this.waiting.get(m.id) : undefined;
    if (w) { this.waiting.delete(m.id); w(m); } else this.dropped++;
  }
  request(m: any): Promise<any> {
    if (m.id === undefined) { this.onmessage?.(m); return Promise.resolve(null); }
    return new Promise((r) => { this.waiting.set(m.id, r); this.onmessage?.(m); });
  }
}
const ownSock = join(run, "agent-own.sock");
const UNSAFE = "browser_run_code_unsafe";
const own = new Map<string, OwnTransport>();
async function onOwn(rq: IncomingMessage, rs: ServerResponse) {
  if (rq.headers.origin !== undefined) return void rs.writeHead(403, { "Content-Type": "text/plain" }).end("A web page cannot connect to the agent browser.");
  if (!/^\/mcp\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(new URL(rq.url ?? "/", "http://agent").pathname)) return void rs.writeHead(404).end();
  if (rq.method === "DELETE") { const t = own.get(rq.headers["mcp-session-id"] as string); if (t) { own.delete(rq.headers["mcp-session-id"] as string); await t.close(); } return void rs.writeHead(t ? 200 : 404).end(); }
  let body = "";
  for await (const c of rq) body += c;
  const msg = JSON.parse(body);
  let sid = rq.headers["mcp-session-id"] as string | undefined;
  let t = sid ? own.get(sid) : undefined;
  if (!t) {
    if (sid || msg.method !== "initialize") return void rs.writeHead(404, { "Content-Type": "text/plain" }).end("No such MCP session.");
    const t0 = performance.now();
    const server = await createConnection({ browser: { cdpEndpoint }, outputDir: join(run, "mcp-out-own") });
    t = new OwnTransport();
    await server.connect(t);
    createMs.push(performance.now() - t0);
    sid = randomUUID();
    own.set(sid, t);
  }
  // The service's rule: browser_run_code_unsafe runs arbitrary JavaScript in the server's process (its own
  // description says so), here the service's process: it never reaches the server, and tools/list drops it.
  if (msg.method === "tools/call" && msg.params?.name === UNSAFE) return void rs.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": sid }).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Not available in the agent browser: ${UNSAFE}` } }));
  const answer = await t.request(msg);
  if (answer?.result?.tools) answer.result.tools = answer.result.tools.filter((x: any) => x.name !== UNSAFE);
  if (answer === null) return void rs.writeHead(202, { "Mcp-Session-Id": sid }).end();
  rs.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": sid }).end(JSON.stringify(answer));
}
const ownDoor = createServer((rq, rs) => { onOwn(rq, rs).catch((e) => { if (!rs.headersSent) rs.writeHead(500).end(String(e?.message ?? e)); }); });
await new Promise<void>((r) => { const u = process.umask(0o077); ownDoor.listen(ownSock, () => { process.umask(u); r(); }); });

// ------------------------------------------------------------------ part A: plain HTTP requests with curl
function curl(body: object | null, opts: { sid?: string; origin?: string; method?: string; sock?: string } = {}): Promise<{ status: number; sid?: string; body: any; ms: number }> {
  const args = ["-s", "-m", "120", "-D", "-", "--unix-socket", opts.sock ?? agentSock, "-X", opts.method ?? "POST", "-H", "Content-Type: application/json", "-H", "Accept: application/json, text/event-stream"];
  if (opts.sid) args.push("-H", `Mcp-Session-Id: ${opts.sid}`);
  if (opts.origin) args.push("-H", `Origin: ${opts.origin}`);
  if (body) args.push("--data-binary", JSON.stringify(body));
  args.push(`http://agent-browser/mcp/${SCOPE}`);
  const t0 = performance.now();
  return new Promise((resolve, reject) => execFile("curl", args, { encoding: "utf8", maxBuffer: 1 << 26 }, (e, out) => {
    if (e) return reject(e);
    const [head, ...rest] = out.split("\r\n\r\n");
    const text = rest.join("\r\n\r\n");
    const status = Number(/^HTTP\/[\d.]+ (\d+)/.exec(head)?.[1]);
    const sid = /^mcp-session-id: (.+)$/im.exec(head)?.[1]?.trim();
    let parsed: any = text;
    try { parsed = JSON.parse(text); } catch { /* text */ }
    resolve({ status, sid, body: parsed, ms: +(performance.now() - t0).toFixed(1) });
  }));
}
const textOf = (r: any) => (r?.result?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "m3-curl", version: "0" } } };

let chromeA: Awaited<ReturnType<typeof startChrome>> | null = null, chromeB: Awaited<ReturnType<typeof startChrome>> | null = null, chromeC: Awaited<ReturnType<typeof startChrome>> | null = null;
let shim: ChildProcess | null = null;
try {
  chromeA = await startChrome("a");
  cdpEndpoint = chromeA.endpoint;
  const A: Record<string, unknown> = {};
  const origin = await curl(INIT, { origin: "http://evil.localhost" });
  A.originRefused = { status: origin.status, body: origin.body };
  const init = await curl(INIT);
  const sid = init.sid!;
  A.initialize = { status: init.status, ms: init.ms, server: init.body?.result?.serverInfo, protocolVersion: init.body?.result?.protocolVersion, sessionId: !!sid };
  const notif = await curl({ jsonrpc: "2.0", method: "notifications/initialized" }, { sid });
  A.initialized = { status: notif.status };
  const list = await curl({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { sid });
  const names: string[] = (list.body?.result?.tools ?? []).map((t: any) => t.name);
  A.toolsList = { status: list.status, ms: list.ms, count: names.length, names };
  result.rssMiBAfterInit = mem();
  const nav = await curl({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "browser_navigate", arguments: { url: SITE } } }, { sid });
  const navText = textOf(nav.body);
  A.browserNavigate = { status: nav.status, ms: nav.ms, isError: !!nav.body?.result?.isError, sawTitle: navText.includes("M3 page"), sawWebdriverFalse: navText.includes("webdriver=false"), excerpt: navText.split("\n").slice(0, 6).join(" | ").slice(0, 400) };
  const snap = await curl({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "browser_snapshot", arguments: {} } }, { sid });
  A.browserSnapshot = { status: snap.status, ms: snap.ms, sawHeading: textOf(snap.body).includes("Hello from a.localhost") };
  const nav2: number[] = [];
  for (let i = 0; i < 10; i++) nav2.push((await curl({ jsonrpc: "2.0", id: 10 + i, method: "tools/call", params: { name: "browser_navigate", arguments: { url: `${SITE}?n=${i}` } } }, { sid })).ms);
  A.navigateTen = { msEach: nav2 };
  A.unknownSessionHeader = (await curl({ jsonrpc: "2.0", id: 5, method: "tools/list" }, { sid: "no-such-session" })).status;
  const del = await curl(null, { sid, method: "DELETE" });
  A.deleteSession = { status: del.status };
  result.partA = A;
  result.rssMiBAfterPartA = mem();
  await chromeA.stop(); chromeA = null;

  // ------------------------------------------------------------------ part B: the stdio shim
  chromeB = await startChrome("b");
  cdpEndpoint = chromeB.endpoint;
  shim = spawn(process.execPath, [join(HERE, "m3-shim.mjs"), "--socket", agentSock, "--path", `/mcp/${SCOPE}`], { stdio: ["pipe", "pipe", "inherit"] });
  guard.track(shim.pid, "shim");
  const waiting = new Map<number, (m: any) => void>();
  let sbuf = "";
  shim.stdout!.setEncoding("utf8").on("data", (d: string) => { sbuf += d; for (let i; (i = sbuf.indexOf("\n")) >= 0;) { const m = JSON.parse(sbuf.slice(0, i)); sbuf = sbuf.slice(i + 1); waiting.get(m.id)?.(m); } });
  const rpc = (id: number, method: string, params?: object) => new Promise<{ m: any; ms: number }>((resolve) => {
    const t0 = performance.now();
    waiting.set(id, (m) => resolve({ m, ms: +(performance.now() - t0).toFixed(1) }));
    shim!.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const B: Record<string, unknown> = {};
  const i2 = await rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "m3-shim-client", version: "0" } });
  B.initialize = { ms: i2.ms, server: i2.m.result?.serverInfo };
  shim.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const l2 = await rpc(2, "tools/list");
  B.toolsList = { ms: l2.ms, count: l2.m.result?.tools?.length };
  const n2 = await rpc(3, "tools/call", { name: "browser_navigate", arguments: { url: SITE } });
  B.browserNavigate = { ms: n2.ms, isError: !!n2.m.result?.isError, sawTitle: textOf(n2.m).includes("M3 page") };
  const s2 = await rpc(4, "tools/call", { name: "browser_snapshot", arguments: {} });
  const ref = (/button[^\n]*\[ref=([^\]]+)\]/.exec(textOf(s2.m)) ?? [])[1];
  B.browserSnapshot = { ms: s2.ms, isError: !!s2.m.result?.isError, buttonRef: ref ?? null };
  const c2 = await rpc(5, "tools/call", { name: "browser_click", arguments: { element: "Go button", target: ref ?? "none" } });
  B.browserClick = { ms: c2.ms, isError: !!c2.m.result?.isError, sawClicked: textOf(c2.m).includes("clicked"), excerpt: c2.m.result?.isError ? textOf(c2.m).slice(0, 300) : undefined };
  const shimStatus = readFileSync(`/proc/${shim.pid}/status`, "latin1");
  B.shimRssKiB = Number(/VmRSS:\s+(\d+)/.exec(shimStatus)?.[1]);
  result.partB = B;
  if (shim.exitCode === null) { shim.stdin!.end(); shim.kill("SIGTERM"); }
  await chromeB.stop(); chromeB = null;

  // ------------------------------------------------------------------ part C: the service's own transport, no SDK
  chromeC = await startChrome("c");
  cdpEndpoint = chromeC.endpoint;
  const C: Record<string, unknown> = {};
  const i3 = await curl(INIT, { sock: ownSock });
  const sid3 = i3.sid!;
  C.initialize = { status: i3.status, ms: i3.ms, server: i3.body?.result?.serverInfo };
  C.initialized = (await curl({ jsonrpc: "2.0", method: "notifications/initialized" }, { sid: sid3, sock: ownSock })).status;
  const l3 = await curl({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { sid: sid3, sock: ownSock });
  C.toolsList = { status: l3.status, ms: l3.ms, count: l3.body?.result?.tools?.length, hasUnsafe: (l3.body?.result?.tools ?? []).some((x: any) => x.name === UNSAFE) };
  const u3 = await curl({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: UNSAFE, arguments: { code: "async (page) => 1" } } }, { sid: sid3, sock: ownSock });
  C.unsafeRefused = { status: u3.status, error: u3.body?.error?.message ?? null };
  const n3 = await curl({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "browser_navigate", arguments: { url: SITE } } }, { sid: sid3, sock: ownSock });
  C.browserNavigate = { status: n3.status, ms: n3.ms, isError: !!n3.body?.result?.isError, sawTitle: textOf(n3.body).includes("M3 page") };
  C.originRefused = (await curl(INIT, { sock: ownSock, origin: "http://evil.localhost" })).status;
  C.droppedServerMessages = [...own.values()].reduce((a, t) => a + t.dropped, 0);
  C.deleteSession = (await curl(null, { sid: sid3, sock: ownSock, method: "DELETE" })).status;
  result.partC = C;
  result.createConnectionMs = createMs.map((x) => +x.toFixed(1));
  result.rssMiBAtEnd = mem();
  result.ok = true;
} catch (e) {
  result.ok = false;
  result.error = (e as Error).stack ?? String(e);
} finally {
  if (shim && shim.exitCode === null) { shim.stdin?.end(); shim.kill("SIGTERM"); }
  await chromeA?.stop();
  await chromeB?.stop();
  await chromeC?.stop();
  door.close(); ownDoor.close(); site.close();
  writeFileSync(new URL("./results/m3.json", import.meta.url), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
  rmSync(run, { recursive: true, force: true });
  process.exit(result.ok ? 0 : 1);
}
