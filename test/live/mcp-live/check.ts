// The live checks of the MCP port (board ab-v16.94.13; stage 1d's live checks; C11, "The MCP path" and "The MCP inside
// the service"; C12, status's mcp and the hello's mcp_token). It runs the real service as test/live/service-use/check.ts
// does: `agent-browser service --test --test-mcp-port 0`, in temp folders only (state, tools, run, lists), on one
// display, under the harness guard (test/live/README.md, rules 1 and 2), and it is the service's "daemon" on the control
// door. The Chrome is a copy of the box's Chromium in the temp tools folder, installed by the service's own installer
// from the local stand-in of Google's index (test/chrome-fixture.ts; nothing is downloaded). Pages are *.localhost pages
// of a local server of this process only. The MCP client is the MCP SDK's own Client and StreamableHTTPClientTransport
// from the pinned playwright-core's bundle, in this process (a root of the test session), with a test token that this
// run makes: the token goes only into the requests' Authorization header (and, in --serve, into a 0600 file); never into
// argv, a log line or the terminal.
//
// The rows (the board's points):
//   7. status.mcp ready at the port of --test-mcp-port; the daemon that connects at the service's start gets mcp_token in
//      its first hello;
//   2. a real page through the MCP: browser_navigate to a test page on the list, browser_snapshot, a click and a typed
//      text, browser_take_screenshot into <state>/mcp/<scope>/, browser_file_upload of a file of that folder and of a
//      folder (as the tool allows);
//   5. the roots: a client's own roots handler is never asked, its roots/list request and its list_changed notification
//      never reach the MCP, and a relative file name lands in the scope's folder;
//   3. the MCP's ticket connection on the agent door: a process outside the session gets the session's 403 with a
//      made-up ticket and with none; a page off the list is refused; the endpoint closes the ticket's connection, and
//      the next tool call connects again once (no loop); no answer and no log line holds "ticket=";
//   4. the session limit: 4 MCP sessions for each scope; a client that reconnects with no DELETE (as measured);
//   6. memory: 20 rounds of real pages, a full-page screenshot and a large response body; the service's RSS (the
//      worker is a thread of the service);
//   7. the restart: the service stops and starts again on the same port; the daemon that connects at once gets
//      mcp_token in its first hello; the old MCP session gets the 404 of an unknown session, and a new one works;
//   8. after the session: no pw-* socket, no Playwright server registry entry, no TCP listener of the service but the
//      MCP port; the scope's folder after its session ends.
//
// --serve MINUTES (at most 60; the lead's point 1, real Claude Code and Codex clients by hand): the same service with
// one test scope and one test token; it prints the MCP URL, the path of a 0600 file that holds the token, the header that
// a client sends it in and the test page's URL; it serves until SIGINT, SIGTERM or MINUTES, then stops and removes
// everything. The MCP port admits a client only under a root of the test session: --root PID (one or more; for example
// the pid of the shell that starts the clients, `echo $$`).
//
// It never touches another Chrome, Xvfb, profile or folder: it signals only the pids that its run started, and its own
// code removes its temp folders at its end. Run it under the box's heavy lock:
//   flock <heavy.lock> timeout 1500 node test/live/mcp-live/check.ts --display 171
//   flock <heavy.lock> timeout 3700 node test/live/mcp-live/check.ts --display 171 --serve 30 --root <pid>

import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { connect, type Socket } from "node:net";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { GOOGLE_SOURCE, GoogleChromeTools } from "../../../src/service/unit/google-chrome.ts";
import { makeChromeRepo } from "../../chrome-fixture.ts";
import { harnessGuard, reservedDisplay } from "../guard.ts";
import { acceptedAt, boundedGrowth, holdsTicket, refOf, rssKib, tcpListeners, unixSockets } from "./measure.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const BIN = join(ROOT, "bin", "agent-browser.js");
const sdk = createRequire(import.meta.url)(join(ROOT, "node_modules", "playwright-core", "lib", "utilsBundle.js"));
const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const args = (k: string) => process.argv.flatMap((a, i) => (a === k ? [process.argv[i + 1]] : []));
const fail2 = (why: string): never => { process.stderr.write(`mcp-live: ${why}\n`); process.exit(2); };
const display = Number(arg("--display") ?? "171");
// The other jobs' displays on taylor now (169, 172 to 175), so this check takes none of them.
const refused = reservedDisplay(display, "--display") ?? ([169, 172, 173, 174, 175].includes(display) ? `--display names :${display}, another job's display` : null);
if (!Number.isSafeInteger(display) || refused) fail2(refused ?? "--display must be a number");
if (existsSync(`/tmp/.X11-unix/X${display}`) || existsSync(`/tmp/.X${display}-lock`)) fail2(`:${display} is in use; this check runs on a free display only`);
const serveRaw = arg("--serve");
const serveMin = serveRaw === undefined ? null : Number(serveRaw);
if (serveMin !== null && (!Number.isSafeInteger(serveMin) || serveMin < 1 || serveMin > 60)) fail2("--serve takes a whole number of minutes from 1 to 60");
const extraRoots = args("--root").map(Number);
if (extraRoots.some((p) => !Number.isSafeInteger(p) || p < 2)) fail2("--root takes a pid");
if (serveMin !== null && extraRoots.length === 0) fail2("--serve needs --root PID: the MCP port admits a client only under a root of the test session (for example the shell that starts the clients: echo $$)");
if (serveMin === null && extraRoots.length) fail2("--root goes with --serve");
const CHROMIUM_TREE = "/usr/lib/chromium";
const SCOPE = "live-1";

const t0 = Date.now();
const log = (s: string) => process.stdout.write(`[${((Date.now() - t0) / 1000).toFixed(1)} s] ${s}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: { step: string; ok: boolean; note: string }[] = [];
/** A row: pass or fail, with its measured note. A failed row ends the run (the rows after it depend on its state). */
const check = (step: string, ok: boolean, note = "") => { results.push({ step, ok, note }); log(`${ok ? "PASS" : "FAIL"} ${step}${note ? `: ${note}` : ""}`); if (!ok) throw new Error(`${step} failed${note ? `: ${note}` : ""}`); };
/** A row whose failure leaves the next rows' state as it is: the run goes on, and it exits 1 at its end. */
const soft = (step: string, ok: boolean, note = "") => { results.push({ step, ok, note }); log(`${ok ? "PASS" : "FAIL"} ${step}${note ? `: ${note}` : ""}`); };
const until = async (what: string, f: () => boolean, ms: number) => { const end = Date.now() + ms; while (!f()) { if (Date.now() > end) throw new Error(`${what}: not in ${ms / 1000} s`); await sleep(100); } };

/** The start time (field 22), the parent and the command line of a pid, or null. */
function proc(pid: number): { start: number; ppid: number; argv: string[] } | null {
  try {
    const st = readFileSync(`/proc/${pid}/stat`, "latin1");
    const f = st.slice(st.lastIndexOf(")") + 2).split(" ");
    if (["Z", "X"].includes(f[0])) return null;
    return { start: Number(f[19]), ppid: Number(f[1]), argv: readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean) };
  } catch { return null; }
}
const me = proc(process.pid)!;
const roots = [{ pid: process.pid, start: me.start }];
for (const pid of extraRoots) { const p = proc(pid); if (!p) fail2(`--root ${pid}: no such process`); roots.push({ pid, start: p!.start }); }

const guard = await harnessGuard("mcp-live");
const dir = mkdtempSync(join(tmpdir(), "ab-mcp-live-"));
const run = join(dir, "run"), state = join(dir, "state"), tools = join(dir, "tools"), lists = join(dir, "lists");
const folder = join(state, "mcp", SCOPE);
mkdirSync(run, { mode: 0o700 });
mkdirSync(lists, { mode: 0o700 });
const started = new Map<number, number>(); // pid -> start time: every process of this run that may need a signal
let service: ChildProcess | null = null;
let serviceErr = "";
/** The log of every service of the run (serviceErr is the last one's). */
let allErr = "";
let repo: ReturnType<typeof makeChromeRepo> | null = null;
function track(pid: number | null | undefined, name: string): void {
  if (!pid || started.has(pid)) return;
  const p = proc(pid);
  if (p) { started.set(pid, p.start); guard.track(pid, name); }
}
/** The Xvfb of the unit record now, or null. */
const recordXvfb = () => { try { return JSON.parse(readFileSync(join(state, "unit.json"), "utf8")).xvfb_pid as number | null; } catch { return null; } };

// ------------------------------------------------------------------ the test pages (*.localhost of this process only)
const BIG_BYTES = 4 * 1024 * 1024;
const big = JSON.stringify({ filler: "x".repeat(BIG_BYTES - 16) });
/** The hosts that the server got a request for. */
const served = new Set<string>();
const FORM = `<!doctype html><title>form of app.localhost</title>
<h1>The live check's form</h1>
<button id="b" onclick="document.getElementById('out').textContent='pressed '+(++window.n)">Press me</button>
<label>Your text <input id="t" oninput="document.getElementById('typed').textContent='typed: '+this.value"></label>
<p id="out">not pressed</p><p id="typed">typed: </p>
<label>One file <input type="file" id="f"></label>
<label>A folder <input type="file" id="d" webkitdirectory multiple></label>
<pre id="files">no file</pre>
<script>window.n=0;
const show=(input)=>{const fs=[...input.files];Promise.all(fs.map(f=>f.text().then(t=>(f.webkitRelativePath||f.name)+' ('+f.size+' bytes): '+t.slice(0,60)))).then(l=>{document.getElementById('files').textContent='chosen by '+input.id+': '+l.join(' | ')})};
document.getElementById('f').onchange=(e)=>show(e.target);document.getElementById('d').onchange=(e)=>show(e.target);</script>`;
const LONG = `<!doctype html><title>long page</title><body style="margin:0">${Array.from({ length: 120 }, (_, i) => `<div style="height:100px;background:hsl(${i * 3},60%,${40 + (i % 5) * 8}%)">row ${i}</div>`).join("")}</body>`;
const BIG_PAGE = `<!doctype html><title>big body</title><p id="n">loading</p><script>fetch('/big.json').then(r=>r.text()).then(t=>{document.getElementById('n').textContent='got '+t.length+' bytes'})</script>`;
const http = createServer((req, res) => {
  const host = String(req.headers.host ?? "").split(":")[0];
  served.add(host);
  const path = (req.url ?? "/").split("?")[0];
  const page = (body: string, type = "text/html") => res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" }).end(body);
  if (path === "/form") return page(FORM);
  if (path === "/long") return page(LONG);
  if (path === "/big") return page(BIG_PAGE);
  if (path === "/big.json") return page(big, "application/json");
  if (path === "/favicon.ico") return res.writeHead(404).end();
  page(`<!doctype html><title>page of ${host}</title><p>${host}</p>`);
});

// ------------------------------------------------------------------ the control door (this process is the daemon)
type Door = { s: Socket; lines: any[]; next: (want: (l: any) => boolean, ms?: number) => Promise<any>; send: (o: object) => void };
function door(): Promise<Door> {
  return new Promise((resolve, reject) => {
    const s = connect(join(run, "control.sock"));
    const lines: any[] = [];
    let buf = "";
    const waiters: { want: (l: any) => boolean; done: (l: any) => void }[] = [];
    s.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const l = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); lines.push(l);
        // Every Chrome and Xvfb that a start at a use makes is this run's: the guard and the cleanup get them at once.
        if (l.t === "ev" && l.ev === "ready") { track(l.chrome_pid, "chrome"); track(recordXvfb(), "xvfb"); }
        for (const w of [...waiters]) if (w.want(l)) { waiters.splice(waiters.indexOf(w), 1); w.done(l); }
      }
    });
    s.on("error", reject);
    s.once("connect", () => resolve({
      s, lines, send: (o) => s.write(JSON.stringify(o) + "\n"),
      next: (want, ms = 30_000) => { const hit = lines.find(want); if (hit) return Promise.resolve(hit); return new Promise((done, fail) => { const w = { want, done: (l: any) => { clearTimeout(t); done(l); } }; waiters.push(w); const t = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); fail(new Error(`no such line in ${ms} ms: ${JSON.stringify(lines.slice(-5))}`)); }, ms); }); },
    }));
  });
}
let n = 0;
const req = async (d: Door, op: string, by: object, fields: object = {}, ms = 30_000) => { const id = `q${++n}`; d.send({ t: "req", id, op, by, ...fields }); return d.next((l) => l.t === "res" && l.id === id, ms); };
const TOKEN = { kind: "token", user: "live", via: "cli" }, DAEMON = { kind: "daemon", user: "live", via: "daemon" };
// The run's own test token of the MCP path, and its fingerprint (C12: set_sessions carries only that).
const TOKEN_MCP = `abt1_${randomBytes(32).toString("base64url")}`;
const SESSION = { scope: SCOPE, repo: "local/test", roots, cgroup: null, lifetime_id: "lt-live", mcp_token: createHash("sha256").update(TOKEN_MCP, "ascii").digest("hex") };
const config = (d: Door) => req(d, "config", { kind: "daemon", user: "live", via: "config" }, { enabled: true, control: true, chrome_bin: null, chrome_args: [], display_size: "1280x900", idle_stop_minutes: 10 });

/**
 * Start the service, and connect as its daemon as soon as its control door takes a connection (before its "ready" log
 * line): the first hello is the one of a daemon that connects at the service's start. Then config and set_sessions.
 */
async function startService(mcpPort: number): Promise<{ d: Door; hello: any; early: boolean }> {
  serviceErr = "";
  service = spawn(process.execPath, [BIN, "service", "--test", "--test-display", String(display), "--agent-door", join(run, "cdp.sock"), "--control-door", join(run, "control.sock"),
    "--daemon-command", join(dir, "daemon-command.json"), "--lists-folder", lists, "--state-folder", state, "--tools-dir", tools, "--test-chrome-source", join(dir, "source.json"), "--test-mcp-port", String(mcpPort)], { stdio: ["ignore", "ignore", "pipe"] });
  track(service.pid, "service");
  service.stderr!.on("data", (d) => {
    serviceErr += d;
    allErr += d;
    // --serve: the MCP path's own lines (C11's log rule: a session's number, a scope, a method and a result; never a
    // token, an id, an argument or a payload), so that the lead sees the clients' sessions come and go.
    if (serveMin !== null) for (const l of String(d).split("\n")) if (l.includes("mcp: ")) log(`service: ${l.trim()}`);
  });
  let d: Door | null = null;
  for (let i = 0; i < 600 && !d; i++) {
    if (service.exitCode !== null) break;
    if (existsSync(join(run, "control.sock"))) d = await door().catch(() => null);
    if (!d) await sleep(20);
  }
  if (!d) throw new Error(`the control door did not open: ${serviceErr.slice(-800)}`);
  const early = !serviceErr.includes("service: ready");
  const hello = await d.next((l) => l.t === "hello");
  if (hello.side !== "service") throw new Error(`no hello: ${JSON.stringify(d.lines)}`);
  d.send({ t: "hello", v: 1, side: "daemon", version: "live", features: [] });
  const cfg = await config(d);
  if (!cfg.ok) throw new Error(`config: ${JSON.stringify(cfg)}`);
  const s0 = await req(d, "set_sessions", DAEMON, { sessions: [], remote: [], box: { hosts: ["box.localhost"], cookie_names: [] } });
  if (!s0.ok) throw new Error(`set_sessions: ${JSON.stringify(s0)}`);
  const ss = await req(d, "set_sessions", DAEMON, { sessions: [SESSION], remote: [], box: { hosts: ["box.localhost"], cookie_names: [] } });
  if (!ss.ok) throw new Error(`set_sessions: ${JSON.stringify(ss)}`);
  await until("the service's ready line", () => serviceErr.includes("service: ready"), 15_000);
  return { d, hello, early };
}
async function stopService(): Promise<number | null> {
  const s = service;
  if (!s || s.exitCode !== null) return s?.exitCode ?? null;
  const exited = new Promise<number | null>((r) => s.once("exit", (c) => r(c)));
  s.kill("SIGTERM");
  return Promise.race([exited, sleep(15_000).then(() => { s.kill("SIGKILL"); return -1; })]);
}

// ------------------------------------------------------------------ the MCP clients (the SDK's own, in this process)
/** Every answer that the MCP path gave this run (the texts of the tool results and the raw bodies): the ticket scan reads them. */
const answers: string[] = [];
let mcpUrl = "";
type Client = { client: any; transport: any; sid: () => string; call: (name: string, a?: Record<string, unknown>) => Promise<{ text: string; isError: boolean; images: number }> };
async function mcpClient(name: string, own?: { capabilities: object; onRoots: () => void }): Promise<Client> {
  const client = new sdk.Client({ name, version: "0" }, own ? { capabilities: own.capabilities } : {});
  if (own) client.setRequestHandler(sdk.ListRootsRequestSchema, async () => { own.onRoots(); return { roots: [{ uri: "file:///nonexistent/client-root", name: "the client's own root" }] }; });
  const transport = new sdk.StreamableHTTPClientTransport(new URL(mcpUrl), { requestInit: { headers: { Authorization: `Bearer ${TOKEN_MCP}` } } });
  await client.connect(transport);
  return {
    client, transport, sid: () => transport.sessionId as string,
    call: async (tool, a = {}) => {
      let r;
      // A refusal of the transport (a path outside the folder, for example) is a JSON-RPC error: the SDK throws it.
      try { r = await client.callTool({ name: tool, arguments: a }, undefined, { timeout: 120_000 }); }
      catch (e) { const text = String((e as Error)?.message ?? e); answers.push(text); return { text, isError: true, images: 0 }; }
      answers.push(JSON.stringify(r));
      const text = (r.content as { type: string; text?: string }[]).filter((c) => c.type === "text").map((c) => c.text).join("\n");
      // The pinned MCP gives a tool's failure as a "### Error" section, also with no isError.
      return { text, isError: r.isError === true || /^### Error/m.test(text), images: (r.content as { type: string }[]).filter((c) => c.type === "image").length };
    },
  };
}
/** One raw POST of the MCP path, with the run's token: its status, its session id and its body. */
async function raw(body: object, sid?: string, method = "POST"): Promise<{ status: number; sid: string | null; text: string }> {
  const r = await fetch(mcpUrl, { method, headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${TOKEN_MCP}`, ...(sid ? { "Mcp-Session-Id": sid } : {}) }, ...(method === "POST" ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60_000) });
  const text = await r.text();
  answers.push(text);
  return { status: r.status, sid: r.headers.get("mcp-session-id"), text };
}
const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mcp-live-raw", version: "0" } } };

// ------------------------------------------------------------------ the reads of /proc
const unixNow = () => unixSockets(readFileSync("/proc/net/unix", "utf8"));
/** The open connections of the agent door: the server ends that its listener accepted (the MCP's ticket connections; this check opens no other). */
const doorConns = () => acceptedAt(unixNow(), join(run, "cdp.sock"));
const myUid = statSync("/proc/self").uid;
const tcpListen = () => [...tcpListeners(readFileSync("/proc/net/tcp", "utf8")), ...tcpListeners(readFileSync("/proc/net/tcp6", "utf8"))].filter((l) => l.uid === myUid);
/** The socket inodes that each readable process of this user holds (a process that is not dumpable, such as the service, is not readable). */
function socketOwners(): Map<number, number> {
  const out = new Map<number, number>();
  for (const e of readdirSync("/proc")) {
    if (!/^\d+$/.test(e)) continue;
    let fds: string[];
    try { fds = readdirSync(`/proc/${e}/fd`); } catch { continue; }
    for (const fd of fds) { try { const m = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${e}/fd/${fd}`)); if (m) out.set(Number(m[1]), Number(e)); } catch {} }
  }
  return out;
}
const rss = (pid: number) => rssKib(readFileSync(`/proc/${pid}/status`, "utf8"));
const mib = (k: number | null) => (k === null ? "?" : `${(k / 1024).toFixed(1)} MiB`);
/** The entries of a folder, or [] when it is not there (read only). */
const entries = (p: string) => { try { return readdirSync(p); } catch { return []; } };
const PW_REGISTRY = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "ms-playwright", "b");
const pwSockets = () => entries("/tmp").filter((e) => e.startsWith("pw-")).sort();

/** A process outside the session's tree (setsid -f: its parent exits, so it is no child of this check) asks the agent door for an upgrade. */
async function outsider(target: string): Promise<{ pid: number; ppid: number; status: number; body: string }> {
  const out = join(dir, `outsider-${randomBytes(4).toString("hex")}.json`);
  const code = `const http=require("node:http"),fs=require("node:fs");const [sock,path,out]=process.argv.slice(1);
const done=(status,body)=>{const st=fs.readFileSync("/proc/self/stat","latin1");const ppid=Number(st.slice(st.lastIndexOf(")")+2).split(" ")[1]);fs.writeFileSync(out+".tmp",JSON.stringify({pid:process.pid,ppid,status,body}));fs.renameSync(out+".tmp",out);process.exit(0)};
setTimeout(()=>{const r=http.request({socketPath:sock,path,headers:{Connection:"Upgrade",Upgrade:"websocket","Sec-WebSocket-Version":"13","Sec-WebSocket-Key":"bGl2ZS1jaGVjay1rZXktMQ=="}});
r.on("response",(res)=>{let b="";res.on("data",(x)=>{b+=x});res.on("end",()=>done(res.statusCode,b))});r.on("upgrade",(res,s)=>{s.destroy();done(101,"")});r.on("error",(e)=>done(0,e.message));r.end()},500);
setTimeout(()=>done(-1,"no answer in 10 s"),10000);`;
  const p = spawn("setsid", ["-f", process.execPath, "-e", code, join(run, "cdp.sock"), target, out], { stdio: "ignore" });
  await new Promise((r) => p.once("exit", r));
  await until("the outsider's answer", () => existsSync(out), 15_000);
  const got = JSON.parse(readFileSync(out, "utf8"));
  track(got.pid, "outsider");
  return got;
}
/** True when `pid` is `root` or under it (its parent chain). */
function under(pid: number, root: number): boolean {
  for (let p = pid, i = 0; p > 1 && i < 64; i++) { if (p === root) return true; const x = proc(p); if (!x) return false; p = x.ppid; }
  return false;
}

let code = 0;
try {
  // The expected command of this "daemon": its resolved interpreter and its command line from argv[1] on.
  const argv = readFileSync("/proc/self/cmdline", "utf8").split("\0").filter((x, i, a) => i < a.length - 1 || x !== "");
  writeFileSync(join(dir, "daemon-command.json"), JSON.stringify({ v: 1, interpreter: realpathSync(process.execPath), args: argv.slice(1) }), { mode: 0o600 });
  // The stand-in of Google's index: its chrome answers --version and otherwise runs the Chromium binary next to it.
  repo = makeChromeRepo({ version: "158.0.7100.1-1", chrome: `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "Google Chrome 158.0.7100.1 "; exit 0; fi\nexec "$(dirname "$0")/chromium" "$@"\n` });
  writeFileSync(join(dir, "source.json"), JSON.stringify({ repo: repo.repo, key: repo.keyFile, fingerprints: [repo.fingerprint] }));
  chmodSync(dir, 0o700);
  const installer = new GoogleChromeTools({ tools, source: { ...GOOGLE_SOURCE, repo: repo.repo, keyFile: repo.keyFile, fingerprints: [repo.fingerprint] }, log: (l) => log(`installer: ${l}`) });
  const copy = await installer.ensure();
  for (const e of readdirSync(CHROMIUM_TREE)) cpSync(join(CHROMIUM_TREE, e), join(copy.binary, "..", e), { recursive: true, force: true });
  check("the copy of Google Chrome 158.0.7100.1-1 in the temp tools folder holds the Chromium tree", existsSync(join(copy.binary, "..", "chromium")) && statSync(copy.binary).isFile());
  writeFileSync(join(lists, "local.test.json"), JSON.stringify({ allow: ["app.localhost"], repo: "local/test" }), { mode: 0o600 });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
  const port = (http.address() as { port: number }).port;
  const page = (path: string, host = "app.localhost") => `http://${host}:${port}${path}`;

  // What runs before the service: the registry, the pw-* entries and this user's TCP listeners (point 8 compares).
  const registry0 = new Set(entries(PW_REGISTRY)), pw0 = new Set(pwSockets());
  const pwUnix0 = new Set(unixNow().filter((s) => /\/pw-/.test(s.path)).map((s) => s.inode));
  const listen0 = new Set(tcpListen().map((l) => l.inode));

  // ---------------------------------------------------------------- point 7: status.mcp ready, the first hello's mcp_token
  let { d, hello, early } = await startService(0);
  const st7 = (await req(d, "status", DAEMON)).data;
  const mcpAddress = st7.mcp?.address as string;
  const mcpPort = Number(mcpAddress?.split(":")[1]);
  mcpUrl = `http://${mcpAddress}/mcp/${SCOPE}`;
  check("7. status.mcp is ready at 127.0.0.1 and the port of --test-mcp-port 0", st7.mcp?.state === "ready" && /^127\.0\.0\.1:\d+$/.test(mcpAddress ?? ""), JSON.stringify(st7.mcp));
  check("7. the daemon that connects at the service's start gets mcp_token in its first hello", Array.isArray(hello.features) && hello.features.includes("mcp_token"), `features ${JSON.stringify(hello.features)}; it connected ${early ? "before" : "after"} the service's ready line`);
  const rss0 = rss(service!.pid!);

  if (serveMin !== null) {
    // ---------------------------------------------------------------- --serve: the lead's real clients, by hand
    const tokenFile = join(dir, "mcp-token");
    writeFileSync(tokenFile, TOKEN_MCP, { mode: 0o600 });
    log(`serve: the MCP URL: ${mcpUrl}`);
    log(`serve: the token's file (mode 0600): ${tokenFile}`);
    log("serve: a client sends the token in the HTTP header  Authorization: Bearer <the token's file's content>");
    log(`serve: the test page: ${page("/form")} (on the list: app.localhost; off the list: ${page("/", "other.localhost")})`);
    log(`serve: the session's roots: ${roots.map((r) => `${r.pid} (${(proc(r.pid)?.argv ?? [])[0] ?? "?"})`).join(", ")}: a client runs under one of them`);
    log(`serve: serving for ${serveMin} min; SIGINT or SIGTERM ends it`);
    await new Promise<void>((resolve) => { const t = setTimeout(resolve, serveMin! * 60_000); for (const s of ["SIGINT", "SIGTERM"] as const) process.once(s, () => { clearTimeout(t); log(`serve: ${s}: stopping`); resolve(); }); });
    // A Ctrl-C in the terminal reaches the service too (the same process group): it stops by itself then.
    if (service!.exitCode === null) { const b = await req(d, "stop", TOKEN, {}, 30_000).catch((e: Error) => ({ ok: false, error: e.message })); log(`serve: stop: ${b.ok ? "ok" : JSON.stringify(b)}`); }
    d.s.end();
    log(`serve: the service's stop: exit ${await stopService()}`);
  } else {
    // ---------------------------------------------------------------- point 2: a real page through the MCP
    const a = await mcpClient("mcp-live-a");
    const n2 = await a.call("browser_navigate", { url: page("/form") });
    check("2. browser_navigate (the first tool call starts Chrome) opens the test page of the list", !n2.isError && n2.text.includes("form of app.localhost"), n2.text.slice(0, 160).replace(/\n/g, " "));
    const conns2 = doorConns();
    soft("3. the MCP's browser is one connection of the service's own on the agent door (its ticket's; this check opens none)", conns2.length === 1, `connections of cdp.sock: ${conns2.length}`);
    const snap = await a.call("browser_snapshot");
    const bRef = refOf(snap.text, "button", "Press me"), tRef = refOf(snap.text, "textbox", "Your text");
    soft("2. browser_snapshot gives the page's elements with their references", !snap.isError && !!bRef && !!tRef, `button ${bRef}, textbox ${tRef}`);
    const c2 = await a.call("browser_click", { element: "the Press me button", target: bRef ?? "#b" });
    const ty = await a.call("browser_type", { element: "the Your text box", target: tRef ?? "#t", text: "typed by the MCP" });
    const after = await a.call("browser_snapshot");
    soft("2. a click and a typed text reach the page (its script shows both)", !c2.isError && !ty.isError && after.text.includes("pressed 1") && after.text.includes("typed: typed by the MCP"), after.text.split("\n").filter((l) => /pressed|typed:/.test(l)).map((l) => l.trim()).join(" ").slice(0, 160));
    const shot = await a.call("browser_take_screenshot", { filename: join(folder, "shot.png") });
    const png = existsSync(join(folder, "shot.png")) ? readFileSync(join(folder, "shot.png")) : Buffer.alloc(0);
    soft("2. browser_take_screenshot writes a PNG into <state>/mcp/<scope>/", !shot.isError && png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), `${png.length} bytes; ${shot.images} image item(s) in the answer`);
    writeFileSync(join(folder, "upload.txt"), "a file of the live check");
    const chooser = await a.call("browser_click", { element: "the One file input", target: "#f" });
    const up = await a.call("browser_file_upload", { paths: [join(folder, "upload.txt")] });
    const upSnap = await a.call("browser_snapshot");
    soft("2. browser_file_upload of a file of the scope's folder: the page reads its name and content", !up.isError && upSnap.text.includes("chosen by f: upload.txt (24 bytes): a file of the live check"),
      `the click's answer ${/file chooser/i.test(chooser.text) ? "names the file chooser" : "names no file chooser"}; ${upSnap.text.split("\n").find((l) => l.includes("chosen by"))?.trim().slice(0, 120) ?? up.text.slice(0, 160)}`);
    mkdirSync(join(folder, "updir"));
    writeFileSync(join(folder, "updir", "one.txt"), "first of the folder");
    writeFileSync(join(folder, "updir", "two.txt"), "second of the folder");
    await a.call("browser_click", { element: "the A folder input", target: "#d" });
    const upd = await a.call("browser_file_upload", { paths: [join(folder, "updir")] });
    // A refused upload leaves the MCP's file chooser open (its modal state): browser_file_upload with no paths cancels it.
    const cancel = upd.isError ? await a.call("browser_file_upload", {}) : null;
    const updSnap = await a.call("browser_snapshot");
    const dirLine = updSnap.text.split("\n").find((l) => l.includes("chosen by d: ")) ?? "";
    const folderOk = /updir\/one\.txt/.test(dirLine) && /updir\/two\.txt/.test(dirLine);
    soft("2. browser_file_upload of a folder of the scope's folder (as measured; the row needs a clear answer and a working session after it)", (folderOk || (upd.isError && cancel !== null && !cancel.isError)) && !updSnap.isError,
      folderOk ? `the page got the folder: ${dirLine.trim().slice(0, 140)}` : `the agent browser refused it: ${upd.text.slice(0, 110).replace(/\n/g, " ")}; the cancel of the chooser ${cancel?.isError ? "failed" : "worked"}, and the next snapshot ${updSnap.isError ? "failed" : "worked"}`);

    // ---------------------------------------------------------------- point 5: the roots
    let asked = 0;
    const r5 = await mcpClient("mcp-live-roots", { capabilities: { roots: { listChanged: true } }, onRoots: () => { asked++; } });
    await r5.client.sendRootsListChanged();
    const own = await raw({ jsonrpc: "2.0", id: 77, method: "roots/list" }, r5.sid());
    const rel = await r5.call("browser_take_screenshot", { filename: "relative-shot.png" });
    await sleep(1000);
    soft("5. a relative file name lands in the scope's folder (the MCP's root is the service's answer)", !rel.isError && existsSync(join(folder, "relative-shot.png")), rel.text.slice(0, 120).replace(/\n/g, " "));
    soft("5. a client's own roots never reach the MCP: its roots handler is never asked, its roots/list request is refused, its list_changed notification is dropped", asked === 0 && (own.status !== 200 || own.text.includes('"error"')),
      `the client's handler was asked ${asked} times; its roots/list got ${own.status} ${own.text.slice(0, 140)}`);
    const out5 = await r5.call("browser_take_screenshot", { filename: "../outside.png" });
    soft("5. a path outside the scope's folder is refused before the MCP", out5.isError && !existsSync(join(state, "mcp", "outside.png")), out5.text.slice(0, 200));
    await r5.transport.terminateSession();
    await r5.client.close();

    // ---------------------------------------------------------------- point 3: the ticket, a page off the list, the closes and the reconnects
    const forged = randomBytes(32).toString("base64url");
    const o1 = await outsider(`/devtools/browser/${SCOPE}?ticket=${forged}`);
    const o2 = await outsider(`/devtools/browser/${SCOPE}`);
    soft("3. a process outside the session gets the session's 403 with a made-up ticket and with none (a ticket from another pid admits nothing)", o1.status === 403 && o2.status === 403 && !under(o1.pid, process.pid) && /not in it/.test(o1.body),
      `pids ${o1.pid}, ${o2.pid} (parent ${o1.ppid}, not under this check); ${o1.status} and ${o2.status}: ${o1.body.slice(0, 100)}`);
    const off = await a.call("browser_navigate", { url: page("/", "other.localhost") });
    soft("3. a page off the test list is refused: the page server never gets its host", !served.has("other.localhost") && !off.text.includes("page of other.localhost"), off.text.slice(0, 200).replace(/\n/g, " "));
    // The endpoint closes the ticket's connection: the stop op (C12) stops Chrome, and the endpoint closes each connection
    // (1001, "The agent browser stopped"). A sampler records every connection of the agent door while it runs.
    const seen = new Set<number>(doorConns());
    const sampler = setInterval(() => { for (const i of doorConns()) seen.add(i); }, 50);
    const fresh3 = (base: Set<number>) => [...seen].filter((i) => !base.has(i));
    const before3 = new Set(seen);
    const mark3 = d.lines.length;
    const b3 = await req(d, "stop", TOKEN, {}, 30_000);
    await d.next((l) => l.t === "ev" && l.ev === "stopped" && d.lines.indexOf(l) >= mark3, 30_000);
    await until("the ticket's connection to close", () => doorConns().length === 0, 15_000);
    await sleep(3000);
    const quiet = fresh3(before3).length;
    const re = await a.call("browser_navigate", { url: page("/form") });
    await sleep(5000);
    const newConns = fresh3(before3);
    soft("3. after the endpoint closed the ticket's connection (1001 at the stop op), the MCP connects again only at the next tool call, once (no loop)", b3.ok === true && quiet === 0 && newConns.length === 1 && !re.isError && re.text.includes("form of app.localhost") && doorConns().length === 1,
      `new connections: ${quiet} in the 3 s with no call, ${newConns.length} after the next tool call (sampled every 50 ms; Chrome started again for it); the call: ${re.text.slice(0, 80).replace(/\n/g, " ")}`);
    clearInterval(sampler);

    // ---------------------------------------------------------------- point 4: the session limit and the reconnect with no DELETE
    // Client a holds one MCP session. A client that reconnects with no DELETE: the SDK's own close() sends none.
    const left: string[] = [];
    let refusedAt = 0, sdkRefusal = "";
    for (let i = 1; i <= 4; i++) {
      try {
        const c = await mcpClient(`mcp-live-again-${i}`);
        left.push(c.sid());
        await c.client.close();
      } catch (e) { refusedAt = i; sdkRefusal = String((e as Error)?.message ?? e); answers.push(sdkRefusal); break; }
    }
    const fifth = await raw({ ...INIT, params: { ...INIT.params, clientInfo: { name: "mcp-live-raw-fifth", version: "0" } } });
    await sleep(5000);
    const pings = await Promise.all(left.map((s) => raw({ jsonrpc: "2.0", id: 5, method: "ping" }, s)));
    soft("4. the limit of 4 MCP sessions for each scope: with one open, 3 more initialize, the next gets the 503 of C11", left.length === 3 && refusedAt === 4 && fifth.status === 503 && /at most 4 MCP sessions/.test(fifth.text),
      `the SDK client's error: ${sdkRefusal.slice(0, 160)}; a raw initialize: ${fifth.status} ${fifth.text.slice(0, 120)}`);
    soft("4. a client that reconnects with no DELETE leaves its old MCP sessions open (measured: each still answers a ping after 5 s, and they hold the limit until a DELETE)", pings.length === 3 && pings.every((p) => p.status === 200), `${left.length} old sessions answer ping: ${pings.map((p) => p.status).join(", ")}`);
    const del = await raw({}, left[0], "DELETE");
    const again = await raw({ ...INIT, params: { ...INIT.params, clientInfo: { name: "mcp-live-after-delete", version: "0" } } });
    soft("4. a DELETE of one old session frees its place: the next initialize passes", del.status === 200 && again.status === 200, `DELETE ${del.status}, initialize ${again.status}`);
    for (const s of [...left.slice(1), again.sid].filter((x): x is string => !!x)) await raw({}, s, "DELETE");

    // ---------------------------------------------------------------- point 6: memory
    const sPid = service!.pid!;
    const rssA = rss(sPid);
    const samples: (number | null)[] = [rssA];
    let bodyLen = 0, shotBytes = 0, images = 0, errors6 = 0, firstErr6 = "";
    for (let i = 1; i <= 20; i++) {
      const steps = [
        await a.call("browser_navigate", { url: page("/long") }),
        await a.call("browser_take_screenshot", { filename: join(folder, "full.png"), fullPage: true }),
        await a.call("browser_navigate", { url: page("/big") }),
        await a.call("browser_wait_for", { text: `got ${big.length} bytes` }),
      ];
      images += steps[1].images;
      shotBytes = existsSync(join(folder, "full.png")) ? statSync(join(folder, "full.png")).size : 0;
      const list = await a.call("browser_network_requests", { static: false, filter: "big\\.json" });
      const idx = list.text.split("\n").map((l) => /^\s*(\d+)\. .*\/big\.json/.exec(l)?.[1]).find(Boolean);
      const body = await a.call("browser_network_request", { index: Number(idx ?? 1), part: "response-body" });
      bodyLen = body.text.length;
      for (const x of [...steps, list, body]) if (x.isError) { errors6++; firstErr6 ||= x.text.slice(0, 160).replace(/\n/g, " "); }
      samples.push(rss(sPid));
    }
    const g = samples.every((x) => x !== null) ? boundedGrowth(samples as number[]) : { ok: false, first: NaN, second: NaN };
    const memoryEnd = /passed its heap limit/.test(serviceErr);
    // browser_close (C11: the MCP connects again at the next tool after it), after the memory rounds: its result does not
    // touch them. The sampler records the agent door's connections again.
    const seenC = new Set<number>(doorConns());
    const samplerC = setInterval(() => { for (const i of doorConns()) seenC.add(i); }, 50);
    const keep = doorConns();
    const bc = await a.call("browser_close");
    await sleep(3000);
    const closedConn = doorConns().length === 0;
    const quietClose = [...seenC].filter((i) => !keep.includes(i)).length;
    const re2 = await a.call("browser_navigate", { url: page("/form") });
    await sleep(3000);
    clearInterval(samplerC);
    const afterClose = [...seenC].filter((i) => !keep.includes(i));
    soft("3. after browser_close the next tool call works and connects at most once (no loop); measured: whether browser_close ends the ticket's connection", !bc.isError && afterClose.length <= 1 && !re2.isError && re2.text.includes("form of app.localhost"),
      `browser_close: ${bc.text.slice(0, 60).replace(/\n/g, " ")}; the connection ${closedConn ? "closed" : "stayed open"} (${keep.length} before); new connections: ${quietClose} with no call, ${afterClose.length} after the next tool call; the call: ${re2.text.slice(0, 120).replace(/\n/g, " ")}`);
    await a.transport.terminateSession();
    await a.client.close();
    await sleep(5000);
    const rssEnd = rss(sPid);
    soft("6. memory: 20 rounds of a full-page screenshot and a large response body; nothing grows without a bound", g.ok && !memoryEnd && errors6 === 0,
      `the service's RSS: ${mib(rss0)} before any MCP session, ${mib(rssA)} with the worker before the rounds, ${mib(samples[10])} after 10, ${mib(samples[20])} after 20 (+${g.first} MiB, then +${g.second} MiB), ${mib(rssEnd)} 5 s after the worker's stop; the full-page PNG ${shotBytes} bytes, ${images} image items in 20 answers; the response body's answer ${bodyLen} characters (the body ${big.length} bytes); ${errors6} tool errors${firstErr6 ? ` (the first: ${firstErr6})` : ""}`);

    // ---------------------------------------------------------------- point 7: the restart on the same port
    const old = await mcpClient("mcp-live-before-restart");
    await old.call("browser_tabs", { action: "list" });
    const oldSid = old.sid();
    const mark7 = d.lines.length;
    const b7 = await req(d, "stop", TOKEN, {}, 30_000);
    await d.next((l) => l.t === "ev" && l.ev === "stopped" && d.lines.indexOf(l) >= mark7, 30_000).catch(() => null);
    d.s.end();
    const exit7 = await stopService();
    ({ d, hello, early } = await startService(mcpPort));
    const st7b = (await req(d, "status", DAEMON)).data;
    soft("7. the restart (--test: the service's stop, then a start on the same port; in production systemd's socket keeps the port): the daemon that connects at once gets mcp_token in its first hello, and status.mcp is ready at the same address",
      b7.ok === true && exit7 === 0 && hello.features?.includes("mcp_token") && st7b.mcp?.state === "ready" && st7b.mcp?.address === mcpAddress, `exit ${exit7}; it connected ${early ? "before" : "after"} the ready line; ${JSON.stringify(st7b.mcp)}`);
    const stale = await raw({ jsonrpc: "2.0", id: 6, method: "ping" }, oldSid);
    await old.client.close().catch(() => {});
    const fresh = await mcpClient("mcp-live-after-restart");
    const n7 = await fresh.call("browser_navigate", { url: page("/form") });
    soft("7. after the restart the old MCP session gets the 404 of an unknown session, and a new one opens the page (Chrome starts at its use)", stale.status === 404 && !n7.isError && n7.text.includes("form of app.localhost"), `${stale.status} ${stale.text.slice(0, 80)}`);

    // ---------------------------------------------------------------- point 8: after the session
    const listenNow = tcpListen().filter((l) => !listen0.has(l.inode) && l.port !== port);
    const owners = socketOwners();
    const others = listenNow.filter((l) => owners.has(l.inode));
    const theService = listenNow.filter((l) => !owners.has(l.inode));
    const unixDoors = unixNow().filter((s) => s.listens && s.path.startsWith(dir)).map((s) => s.path.slice(dir.length + 1)).sort();
    soft("8. while a session runs: no TCP listener of the service but the MCP port; its Unix listeners are its doors in its run folder", theService.length === 1 && theService[0].port === mcpPort,
      `new TCP listeners of this user: ${listenNow.map((l) => l.port).join(", ") || "none"} (${others.length} of another, readable process); the service's Unix listeners: ${unixDoors.join(", ")}`);
    await fresh.transport.terminateSession();
    await fresh.client.close();
    await until("the worker's connections to close", () => doorConns().length === 0, 15_000).catch(() => {});
    const registryNew = entries(PW_REGISTRY).filter((e) => !registry0.has(e));
    const pwNew = pwSockets().filter((e) => !pw0.has(e));
    const pwUnix = unixNow().filter((s) => /\/pw-/.test(s.path) && !pwUnix0.has(s.inode)).length;
    soft("8. after the MCP sessions end: no connection of the agent door, no pw-* socket, no new Playwright server registry entry", doorConns().length === 0 && pwNew.length === 0 && pwUnix === 0 && registryNew.length === 0,
      `connections of cdp.sock: ${doorConns().length}; pw-* in /tmp: ${pwNew.length} new; new Unix sockets with /pw-: ${pwUnix}; new registry entries: ${registryNew.length}`);
    const before8 = existsSync(folder) ? readdirSync(folder).sort() : [];
    const e8 = await req(d, "session_ended", DAEMON, { scope: SCOPE });
    await until("the scope's folder to go", () => !existsSync(folder), 15_000).catch(() => {});
    soft("8. the scope's folder stays while its session lives, and goes with its files when the session ends", e8.ok === true && before8.length > 0 && !existsSync(folder) && /mcp: the folder of scope live-1 is emptied \(its session ended\)/.test(serviceErr),
      `it held ${before8.length} entries (${before8.join(", ").slice(0, 160)}); after session_ended: ${existsSync(folder) ? "still there" : "gone"}`);
    const ticketLeak = answers.filter(holdsTicket).length + allErr.split("\n").filter(holdsTicket).length;
    soft("3. no answer of the MCP path and no log line of the run holds \"ticket=\"", ticketLeak === 0, `${answers.length} answers and ${allErr.split("\n").length} log lines of both services read; ${ticketLeak} hold it`);

    const b9 = await req(d, "stop", TOKEN, {}, 30_000);
    d.s.end();
    const exit9 = await stopService();
    soft("the service's stop removes its sockets", b9.ok === true && exit9 === 0 && !existsSync(join(run, "control.sock")) && !existsSync(join(run, "cdp.sock")) && !existsSync(join(run, "link.sock")));
    soft("the display is free again", !existsSync(`/tmp/.X11-unix/X${display}`));
  }
} catch (e) {
  code = 1;
  log(`FAIL: ${(e as Error).message}`);
  if (serviceErr) log(`the service's log (end):\n${serviceErr.slice(-3000)}`);
} finally {
  await stopService();
  http.close();
  // Only the pids that this run started, with their recorded start times: SIGTERM, then SIGKILL.
  for (const sig of ["SIGTERM", "SIGKILL"] as const) {
    for (const [pid, start] of started) if (proc(pid)?.start === start) { try { process.kill(pid, sig); } catch {} }
    await sleep(2000);
  }
  const leftover = [...started].filter(([pid, start]) => proc(pid)?.start === start).map(([pid]) => pid);
  repo?.close();
  rmSync(dir, { recursive: true, force: true });
  log(`cleanup: ${leftover.length ? `still running: ${leftover.join(", ")}` : "no process of this run runs"}; the temp folder is ${existsSync(dir) ? "still there" : "removed"}`);
  if (leftover.length) code = 1;
  process.stdout.write(`${JSON.stringify({ passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length + (code && results.every((r) => r.ok) ? 1 : 0), seconds: Math.round((Date.now() - t0) / 1000) })}\n`);
  process.exit(code);
}
