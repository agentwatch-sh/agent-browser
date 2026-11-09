// The input probe of board task ab-t30.1 (docs/research/2026-11-09-click-box-input-signals.md). Not part of `npm test`.
// Linux only, in a private Xvfb that it starts, with Chromium processes of its own and local pages only.
//
//   node docs/research/2026-11-09-click-box-input-signals/probe.ts --out-dir DIR --playwright DIR
//        [--display 168] [--chrome /usr/bin/chromium] [--only xinput,cdp-raw,agent-browser,agent-browser-no-x,playwright]
//
// Each scenario starts its own Chromium on a new profile (removed at the scenario's end) with recorder.html (beside this
// file) on a local server (rec.localhost; the click-box stand-in in a frame of box.localhost). The page sends every input
// record to the server. The scenarios are the input paths of the doc:
//   xinput              real X input through the X server (xdotool: XTEST), as a mouse and a keyboard give it; no CDP
//                       session on the page
//   cdp-raw             CDP Input calls of our own: what CDP can and cannot set (the relay's raw material)
//   agent-browser       agent-browser's own commands in a window of its own (ab-v16.26: src/input.ts), with the X pointer
//   agent-browser-no-x  the same without the X pointer (as over agentwatch's relay)
//   playwright          vanilla Playwright over CDP: each input action, what the page sees, and the CDP calls it sends
//   playwright-extra    more Playwright input actions and options (the review of the first runs): mouse.dblclick,
//                       modifiers, the right and middle buttons, clickCount, a click's delay, focus, blur, dispatchEvent,
//                       selectText, touchscreen.tap, the old locator.type, and the script focus of pressSequentially and press
//   file-mode           (only with --only) part B's use: the page opened as a file, task 1 (10 trials) and task 5 (2 rounds)
//                       by X input, "Save JSON", and analyze.ts on the saved file
// Chromium runs with --remote-debugging-pipe; a small bridge (a WebSocket server on a Unix socket in a short temporary
// folder of its own, removed at the end) serves
// the pipe to the clients and records every CDP message with its time (the trace of each Playwright action). Chromium
// opens no debugging port. No page of the network is reachable: the host resolver maps every host but the two local ones to
// nothing, and the proxy is a closed local port.
//
// One harness at a time and nothing left after its end (test/live/README.md): the harness guard, and the scenarios end
// only the processes that this script started, by their pids. It writes DIR/run-XXXXXX/results.json; analyze.ts reads it.

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import WebSocket, { WebSocketServer } from "ws";
import { AgentBrowser } from "../../../src/browser.ts";
import { CDPConnection } from "../../../src/cdp.ts";
import { commands } from "../../../src/commands.ts";
import type { BrowserOptions } from "../../../src/options.ts";
import { harnessGuard, reservedDisplay } from "../../../test/live/guard.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({ options: { "out-dir": { type: "string" }, chrome: { type: "string" }, display: { type: "string" }, only: { type: "string" }, playwright: { type: "string" } } });
function refuse(message: string): never { process.stderr.write(`${message}\n`); process.exit(2); }
if (!values["out-dir"]) refuse("usage: node probe.ts --out-dir DIR --playwright DIR [--display 168] [--chrome /usr/bin/chromium] [--only a,b]");
if (process.platform !== "linux") refuse(`linux only, in a private Xvfb (this is ${process.platform})`);
const CHROME = values.chrome ?? "/usr/bin/chromium", DISPLAY = Number(values.display ?? 168);
if (!Number.isInteger(DISPLAY) || DISPLAY < 1) refuse("--display is a positive whole number");
const reserved = reservedDisplay(DISPLAY, "--display");
if (reserved) refuse(reserved);
const ALL = ["xinput", "cdp-raw", "agent-browser", "agent-browser-no-x", "playwright", "playwright-extra"];
const ONLY = values.only ? values.only.split(",") : ALL;
for (const n of ONLY) if (![...ALL, "file-mode"].includes(n)) refuse(`no scenario ${n}; known: ${ALL.join(", ")}, file-mode`);
if (ONLY.some((n) => n.startsWith("playwright")) && !values.playwright) refuse("the playwright scenario needs --playwright DIR (a folder whose node_modules has playwright-core)");
const OUT = resolve(values["out-dir"]!);
mkdirSync(OUT, { recursive: true });
const RUN = mkdtempSync(join(OUT, "run-"));
const SOCKS = mkdtempSync(join(tmpdir(), "cbp-"));
process.on("exit", () => rmSync(SOCKS, { recursive: true, force: true }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const now = () => Math.round((performance.timeOrigin + performance.now()) * 1000) / 1000;
const say = (line: string) => process.stderr.write(`${new Date().toISOString().slice(11, 23)} ${line}\n`);

// ------------------------------------------------------------------ Xvfb (own display, own X authority)
const field = (b: Buffer) => { const n = Buffer.alloc(2); n.writeUInt16BE(b.length); return Buffer.concat([n, b]); };
const xauth = join(RUN, "Xauthority");
writeFileSync(xauth, Buffer.concat([Buffer.from([0xff, 0xff]), field(Buffer.alloc(0)), field(Buffer.from(String(DISPLAY))),
  field(Buffer.from("MIT-MAGIC-COOKIE-1")), field(randomBytes(16))]), { mode: 0o600 });
const children: ChildProcess[] = [];
process.on("exit", () => { for (const c of children.reverse()) if (c.exitCode === null && c.signalCode === null) c.kill("SIGTERM"); });
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => process.exit(130));
const harness = await harnessGuard("click-box-input");
if (existsSync(`/tmp/.X11-unix/X${DISPLAY}`)) refuse(`display :${DISPLAY} is in use; pass --display N`);
const SCREEN = { w: 1920, h: 1080 };
const xvfb = spawn("Xvfb", [`:${DISPLAY}`, "-auth", xauth, "-nolisten", "tcp", "-screen", "0", `${SCREEN.w}x${SCREEN.h}x24`], { stdio: "ignore" });
children.push(xvfb);
harness.track(xvfb.pid, "Xvfb");
for (let i = 0; i < 50 && !existsSync(`/tmp/.X11-unix/X${DISPLAY}`) && xvfb.exitCode === null; i++) await sleep(100);
await sleep(300);
if (xvfb.exitCode !== null) refuse(`Xvfb did not start on :${DISPLAY}`);
const XENV: NodeJS.ProcessEnv = { ...process.env, DISPLAY: `:${DISPLAY}`, XAUTHORITY: xauth };
delete XENV.WAYLAND_DISPLAY; delete XENV.XDG_SESSION_TYPE;
// agent-browser's own commands reach the X pointer of this run's Xvfb only (input.ts, xAccess): never another display.
process.env.DISPLAY = `:${DISPLAY}`; process.env.XAUTHORITY = xauth; delete process.env.WAYLAND_DISPLAY;
say(`Xvfb :${DISPLAY} pid ${xvfb.pid}; run folder ${RUN}`);

// ------------------------------------------------------------------ the local server: the recorder, the box, the log
type Rec = Record<string, unknown> & { e: string; f?: string; t?: number };
let scenarioName = "none";
const recs: Record<string, Rec[]> = {};
const HTML = readFileSync(join(HERE, "recorder.html"), "utf8");
const piece = (re: RegExp) => { const m = re.exec(HTML); if (!m) throw new Error(`recorder.html has no ${re}`); return m[1]; };
const BOX_HTML = `<!doctype html><html><head><meta charset=utf-8><title>box</title></head><body>${piece(/<template id="box-html">([\s\S]*?)<\/template>/)}`
  + `<script>${piece(/<script id="core">([\s\S]*?)<\/script>/)}</script><script>${piece(/<script type="text\/plain" id="box-ui">([\s\S]*?)<\/script>/)}</script></body></html>`;
const server = createServer((req, res) => {
  const host = String(req.headers.host ?? "");
  if (req.method === "POST" && req.url === "/log") {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      try { const list = JSON.parse(body) as Rec[]; (recs[scenarioName] ??= []).push(...list.map((r) => ({ ...r, srv: Date.now() }))); } catch { /* a broken beacon */ }
      res.writeHead(204).end();
    });
    return;
  }
  const path = (req.url ?? "/").split("?")[0];
  if (path === "/recorder.html" && host.startsWith("rec.localhost")) { res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(HTML); return; }
  if (path === "/box.html" && host.startsWith("box.localhost")) { res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(BOX_HTML); return; }
  if (path === "/blank.html") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<!doctype html><title>blank</title><p>blank"); return; }
  res.writeHead(404).end();
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const PORT = (server.address() as { port: number }).port;
const REC_URL = (label: string) => `http://rec.localhost:${PORT}/recorder.html?sink=1&run=${label}&box=${encodeURIComponent(`http://box.localhost:${PORT}/box.html`)}`;

// ------------------------------------------------------------------ Chromium over a pipe, and the bridge with its trace
const BASE_ARGS = ["--remote-debugging-pipe", "--no-first-run", "--no-default-browser-check", "--ozone-platform=x11", "--password-store=basic",
  "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-default-apps", "--disable-backgrounding-occluded-windows",
  "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE rec.localhost , EXCLUDE box.localhost", "--proxy-server=http://127.0.0.1:9",
  "--proxy-bypass-list=rec.localhost;box.localhost", "--window-position=0,0", "--window-size=1280,1000"];

type Trace = { t: number; d: ">" | "<" | "e"; id?: number; m?: string; s?: string; p?: unknown; err?: string };
type Client = { ws: WebSocket; sessions: Set<string> };
/** Keep a CDP params object small: long strings (Playwright's injected script) are cut. */
function trim(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return v.length > 160 ? `${v.slice(0, 120)}...(${v.length} chars)` : v;
  if (Array.isArray(v)) return depth > 4 ? `[${v.length} items]` : v.slice(0, 20).map((x) => trim(x, depth + 1));
  if (v && typeof v === "object") { const o: Record<string, unknown> = {}; for (const [k, x] of Object.entries(v)) o[k] = depth > 4 ? "..." : trim(x, depth + 1); return o; }
  return v;
}
class Chromium {
  readonly proc: ChildProcess;
  readonly dir: string;
  readonly sock: string;
  readonly cdpUrl: string;
  readonly trace: Trace[] = [];
  private buf = "";
  private next = 1;
  private pending = new Map<number, { c?: Client; id: number; method: string }>();
  private owner = new Map<string, Client>();
  private clients = new Set<Client>();
  private autoAttacher?: Client;
  private wss?: WebSocketServer;
  private http = createServer();
  constructor(name: string, urls: string[]) {
    this.dir = join(RUN, `profile-${name}`);
    mkdirSync(this.dir, { recursive: true });
    const fd = openSync(join(RUN, `chrome-${name}.log`), "a");
    this.proc = spawn(CHROME, [...BASE_ARGS, `--user-data-dir=${this.dir}`, ...urls], { env: XENV, stdio: ["ignore", fd, fd, "pipe", "pipe"] });
    children.push(this.proc);
    harness.track(this.proc.pid, "Chromium");
    // agent-browser takes agent mode's endpoint form only (ws+unix://); the run folder's path is too long for a socket.
    this.sock = join(SOCKS, `${name}.sock`);
    this.cdpUrl = `ws+unix://${this.sock}:/devtools/browser/probe`;
    const read = this.proc.stdio[4] as Readable;
    read.setEncoding("utf8");
    read.on("data", (d: string) => {
      this.buf += d;
      for (let i; (i = this.buf.indexOf("\0")) >= 0;) { const m = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1); this.fromChrome(m); }
    });
  }
  async listen(): Promise<void> {
    this.wss = new WebSocketServer({ server: this.http, perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
    this.wss.on("connection", (ws) => {
      const c: Client = { ws, sessions: new Set() };
      this.clients.add(c);
      ws.on("message", (data) => this.fromClient(c, String(data)));
      ws.on("close", () => this.leave(c));
    });
    await new Promise<void>((r) => this.http.listen(this.sock, r));
  }
  private toChrome(m: object) { (this.proc.stdio[3] as Writable).write(JSON.stringify(m) + "\0"); }
  private fromClient(c: Client, raw: string) {
    const m = JSON.parse(raw);
    if (m.method === "Target.setAutoAttach" && !m.sessionId) this.autoAttacher = m.params?.autoAttach ? c : undefined;
    const gid = this.next++;
    this.pending.set(gid, { c, id: m.id, method: m.method });
    this.trace.push({ t: now(), d: ">", id: gid, m: m.method, ...(m.sessionId ? { s: m.sessionId.slice(0, 6) } : {}), ...(m.params ? { p: trim(m.params) } : {}) });
    this.toChrome({ ...m, id: gid });
  }
  private fromChrome(raw: string) {
    const m = JSON.parse(raw);
    if (typeof m.id === "number") {
      this.trace.push({ t: now(), d: "<", id: m.id, ...(m.error ? { err: String(m.error.message).slice(0, 120) } : {}) });
      const p = this.pending.get(m.id);
      this.pending.delete(m.id);
      if (!p?.c) return;
      if (p.method === "Target.attachToTarget" && m.result?.sessionId) { this.owner.set(m.result.sessionId, p.c); p.c.sessions.add(m.result.sessionId); }
      if (p.c.ws.readyState === WebSocket.OPEN) p.c.ws.send(JSON.stringify({ ...m, id: p.id }));
      return;
    }
    this.trace.push({ t: now(), d: "e", m: m.method, ...(m.sessionId ? { s: m.sessionId.slice(0, 6) } : {}) });
    if (m.method === "Target.attachedToTarget") {
      const parent = m.sessionId ? this.owner.get(m.sessionId) : this.autoAttacher;
      if (parent) { this.owner.set(m.params.sessionId, parent); if (!m.sessionId) parent.sessions.add(m.params.sessionId); }
    }
    if (m.method === "Target.detachedFromTarget") { const o = this.owner.get(m.params.sessionId); o?.sessions.delete(m.params.sessionId); this.owner.delete(m.params.sessionId); }
    const to = m.sessionId ? this.owner.get(m.sessionId) : (m.method === "Target.attachedToTarget" ? this.autoAttacher : undefined);
    for (const c of to ? [to] : this.clients) if (c.ws.readyState === WebSocket.OPEN) c.ws.send(raw);
  }
  private leave(c: Client) {
    this.clients.delete(c);
    for (const s of c.sessions) { this.pending.set(this.next, { id: 0, method: "detach" }); this.toChrome({ id: this.next++, method: "Target.detachFromTarget", params: { sessionId: s } }); }
    if (this.autoAttacher === c) {
      this.autoAttacher = undefined;
      this.pending.set(this.next, { id: 0, method: "x" }); this.toChrome({ id: this.next++, method: "Target.setAutoAttach", params: { autoAttach: false, waitForDebuggerOnStart: false, flatten: true } });
    }
  }
  async stop(): Promise<void> {
    this.wss?.close(); this.http.close();
    if (this.proc.exitCode === null && this.proc.signalCode === null) {
      this.proc.kill("SIGTERM"); // our own child, by its pid: never a Chrome that this script did not start
      for (let i = 0; i < 50 && this.proc.exitCode === null && this.proc.signalCode === null; i++) await sleep(100);
    }
    if (this.proc.exitCode === null && this.proc.signalCode === null) {
      this.proc.kill("SIGKILL");
      for (let i = 0; i < 20 && this.proc.exitCode === null && this.proc.signalCode === null; i++) await sleep(100);
    }
    // The scenario's own temporary profile goes with its Chrome.
    rmSync(this.dir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ the page's layout and the screen
const own = () => recs[scenarioName] ?? [];
const lastOf = (e: string, f = "top") => own().filter((r) => r.e === e && (r.f ?? "top") === f).at(-1) as Record<string, any> | undefined;
async function loaded(ms = 15_000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (lastOf("layout") && lastOf("state", "box")) return;
  throw new Error("the recorder page (or its box) did not load");
}
type Pt = { x: number; y: number };
/** The middle of an element (client CSS px), from the page's latest layout record. In the box: a point of the box's own page. */
function centre(id: string, dx = 0.5, dy = 0.5): Pt {
  const r = lastOf("layout")?.r?.[id] as number[] | undefined;
  if (!r) throw new Error(`no layout for ${id}`);
  return { x: r[0] + r[2] * dx, y: r[1] + r[3] * dy };
}
/** The box's square (#cb at 16,20 size 24 in the box's page) in the top page's client px. */
const boxSquare = (): Pt => { const b = lastOf("layout")!.r.box as number[]; return { x: b[0] + 28, y: b[1] + 32 }; };
/** The page's content origin on the screen (Chrome draws its own frame: no window manager on this Xvfb). */
function origin(): Pt {
  const g = lastOf("state")!;
  const side = Math.round((g.ow - g.iw) / 2);
  return { x: g.wx + side, y: g.wy + g.oh - g.ih - side };
}
async function relayout() { await evalTop("window.__recorder.layout('probe')"); await sleep(400); }
let evalTop: (expr: string) => Promise<void> = async () => {};

// ------------------------------------------------------------------ marks and steps
type Mark = { name: string; t0: number; t1: number; ok: boolean; error?: string; note?: unknown };
const marks: Record<string, Mark[]> = {};
async function step(name: string, fn: () => Promise<unknown>, limitMs = 20_000, settle = 700): Promise<void> {
  const t0 = now();
  let ok = true, error: string | undefined, note: unknown;
  let timer: NodeJS.Timeout | undefined;
  try { note = await Promise.race([fn(), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`no end in ${limitMs / 1000} s`)), limitMs); })]); }
  catch (e) { ok = false; error = String((e as Error).message ?? e).split("\n")[0].slice(0, 200); }
  finally { clearTimeout(timer); }
  const t1 = now();
  (marks[scenarioName] ??= []).push({ name, t0, t1, ok, ...(error ? { error } : {}), ...(note !== undefined ? { note } : {}) });
  say(`${scenarioName}: ${name} ${ok ? "ok" : `FAILED: ${error}`} (${Math.round(t1 - t0)} ms)`);
  await sleep(settle);
}

// ------------------------------------------------------------------ xdotool: X input through the X server (XTEST)
const xdo = (...args: string[]) => execFileSync("xdotool", args, { env: XENV, encoding: "utf8", timeout: 20_000 }).trim();
function chromeWindow(pid: number, title = "Input recorder"): string {
  for (const id of xdo("search", "--onlyvisible", "--pid", String(pid)).split("\n").filter(Boolean)) {
    try { if (xdo("getwindowname", id).startsWith(title)) return id; } catch { /* gone */ }
  }
  throw new Error(`no window titled "${title}"`);
}
const xPointer = (): Pt => { const v = Object.fromEntries(xdo("getmouselocation", "--shell").split("\n").map((l) => l.split("="))); return { x: Number(v.X), y: Number(v.Y) }; };
/**
 * A pointer path to a client point of the page, as one xdotool process (exact sleeps): minimum-jerk speed, a bend, and
 * `hz` moves a second (a mouse reports at 125 to 1000 Hz). Returns the number of X moves.
 */
function xPath(to: Pt, ms: number, hz: number, bend = 30): number {
  const o = origin(), from = xPointer(), end = { x: Math.round(o.x + to.x), y: Math.round(o.y + to.y) };
  const n = Math.max(2, Math.round((ms / 1000) * hz)), args: string[] = [];
  let last = from;
  for (let i = 1; i <= n; i++) {
    const s = i / n, e = s * s * s * (10 - 15 * s + 6 * s * s);
    const p = i === n ? end : { x: Math.round(from.x + (end.x - from.x) * e + Math.sin(Math.PI * s) * bend), y: Math.round(from.y + (end.y - from.y) * e - Math.sin(Math.PI * s) * bend * 0.4) };
    if (p.x === last.x && p.y === last.y) { args.push("sleep", String(1 / hz)); continue; }
    args.push("mousemove", String(p.x), String(p.y), "sleep", String(1 / hz));
    last = p;
  }
  xdo(...args);
  return n;
}
const xPress = (holdMs: number) => xdo("mousedown", "1", "sleep", String(holdMs / 1000), "mouseup", "1");

// ------------------------------------------------------------------ the scenarios
const traces: Record<string, Trace[]> = {};
async function startChrome(name: string, urls: string[]): Promise<Chromium> {
  const c = new Chromium(name, urls);
  traces[name] = c.trace;
  await c.listen();
  return c;
}
const TEXT = "Hello world, 42!";

const SCENARIOS: Record<string, () => Promise<Record<string, unknown>>> = {
  // ---------------------------------------------------------------- c: real X input (XTEST), no CDP session on the page
  async xinput() {
    const c = await startChrome("xinput", [REC_URL("xinput")]);
    try {
      await loaded();
      const win = chromeWindow(c.proc.pid!);
      xdo("windowraise", win); xdo("windowfocus", win); await sleep(500);
      // The page cannot be asked for a new layout without CDP: the probe scrolls only at the end, and reads the scroll's
      // layout record (the page writes one 120 ms after each scroll).
      evalTop = async () => {};
      xdo("mousemove", "900", "700"); await sleep(400);
      await step("idle 2 s", () => sleep(2000));
      await step("path 125 Hz to #b, press 80 ms", async () => { xPath(centre("b"), 450, 125); await sleep(120); xPress(80); });
      await step("path 1000 Hz to #hov (hover)", async () => { xPath(centre("hov"), 450, 1000); await sleep(400); });
      await step("path 60 Hz to #chk, press 100 ms", async () => { xPath(centre("chk"), 450, 60); await sleep(150); xPress(100); });
      await step("jump to #b, xdotool click (no path)", async () => { const o = origin(), p = centre("b"); xdo("mousemove", String(Math.round(o.x + p.x)), String(Math.round(o.y + p.y)), "click", "1"); });
      await step("path to #f, press, xdotool type --delay 120", async () => { xPath(centre("f", 0.8), 400, 125); await sleep(120); xPress(80); await sleep(300); xdo("type", "--delay", "120", TEXT); });
      await step("key rollover: h down, e down, h up, e up", async () => {
        xdo("keydown", "h", "sleep", "0.07", "keydown", "e", "sleep", "0.03", "keyup", "h", "sleep", "0.06", "keyup", "e");
      });
      await step("Shift held for two capitals: Shift down, A, B, Shift up", async () => {
        xdo("keydown", "Shift_L", "sleep", "0.05", "key", "a", "sleep", "0.1", "key", "b", "sleep", "0.05", "keyup", "Shift_L");
      });
      await step("key Return", async () => { xdo("key", "Return"); });
      await step("path 125 Hz into the box, press 85 ms on its square", async () => { xPath(boxSquare(), 600, 125); await sleep(150); xPress(85); });
      await step("wheel: 8 notches down, 90 ms apart", async () => { xPath({ x: 600, y: 600 }, 400, 125); await sleep(200); xdo("click", "--repeat", "8", "--delay", "90", "5"); await sleep(400); });
      await step("wheel to #far, path, press", async () => {
        for (let i = 0; i < 30; i++) {
          const far = lastOf("layout")!.r.far as number[];
          const ih = lastOf("layout")!.ih as number;
          if (far[1] > 100 && far[1] < ih - 100) break;
          xdo("click", "--repeat", "3", "--delay", "80", "5"); await sleep(400);
        }
        xPath(centre("far"), 500, 125); await sleep(150); xPress(80);
      });
      return { window: win };
    } finally { await c.stop(); }
  },

  // ---------------------------------------------------------------- CDP Input calls of our own
  async "cdp-raw"() {
    const c = await startChrome("cdp-raw", [REC_URL("cdp-raw")]);
    let cdp: CDPConnection | undefined;
    try {
      await loaded();
      const win = chromeWindow(c.proc.pid!);
      xdo("windowraise", win); xdo("windowfocus", win); await sleep(500);
      cdp = await CDPConnection.connect(c.cdpUrl);
      const targets = (await cdp.send("Target.getTargets")).targetInfos as { targetId: string; type: string; url: string }[];
      const page = targets.find((t) => t.type === "page" && t.url.includes("recorder.html"))!;
      const frames = targets.filter((t) => t.type === "iframe").map((t) => t.url.replace(/:\d+/, ":PORT"));
      const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
      const send = (m: string, p: object) => cdp!.send(m, p, sessionId);
      evalTop = async (expression) => { await send("Runtime.evaluate", { expression }); };
      // The state of both frames again, after the layout (the box's own sizes are 0 while it loads).
      await evalTop("window.__recorder.state()");
      const mv = (p: Pt, extra: object = {}) => send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y, button: "none", buttons: 0, ...extra });
      const line = (a: Pt, b: Pt, n: number) => Array.from({ length: n }, (_, i) => ({ x: Math.round(a.x + ((b.x - a.x) * (i + 1)) / n), y: Math.round(a.y + ((b.y - a.y) * (i + 1)) / n) }));
      await step("idle 2 s", () => sleep(2000));
      await step("30 moves, each awaited, 16 ms apart", async () => { for (const p of line({ x: 700, y: 600 }, centre("b"), 30)) { await mv(p); await sleep(16); } });
      await step("40 moves sent at once (not awaited), 1 ms apart", async () => {
        const ps: Promise<unknown>[] = [];
        for (const p of line(centre("b"), centre("hov"), 40)) { ps.push(mv(p)); await sleep(1); }
        await Promise.all(ps);
      });
      await step("40 moves at once with timestamp params 8 ms apart", async () => {
        const t0 = Date.now() / 1000, ps: Promise<unknown>[] = [];
        line(centre("hov"), centre("b"), 40).forEach((p, i) => ps.push(mv(p, { timestamp: t0 + i * 0.008 })));
        await Promise.all(ps);
      });
      await step("moves at fractional points (x.25, y.75)", async () => { for (let i = 0; i < 5; i++) { await mv({ x: 300.25 + i * 3, y: 400.75 + i * 2 }); await sleep(16); } });
      await step("mouse press with force 0.5, tiltX 15, tiltY -10, twist 30, tangentialPressure 0.2", async () => {
        const p = centre("b");
        await mv(p, { tiltX: 15, tiltY: -10, twist: 30 });
        await send("Input.dispatchMouseEvent", { type: "mousePressed", x: p.x, y: p.y, button: "left", buttons: 1, clickCount: 1, force: 0.5, tiltX: 15, tiltY: -10, twist: 30, tangentialPressure: 0.2 });
        await sleep(80);
        await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: p.x, y: p.y, button: "left", buttons: 0, clickCount: 1 });
      });
      await step("pen press (pointerType pen, force 0.3, tilt)", async () => {
        const p = centre("hov");
        await mv(p, { pointerType: "pen", tiltX: 20, tiltY: 5 });
        await send("Input.dispatchMouseEvent", { type: "mousePressed", x: p.x, y: p.y, button: "left", buttons: 1, clickCount: 1, force: 0.3, pointerType: "pen", tiltX: 20, tiltY: 5 });
        await sleep(80);
        await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: p.x, y: p.y, button: "left", buttons: 0, clickCount: 1, pointerType: "pen" });
      });
      await step("press with no move before it (at #chk)", async () => {
        const p = centre("chk");
        await send("Input.dispatchMouseEvent", { type: "mousePressed", x: p.x, y: p.y, button: "left", buttons: 1, clickCount: 1, force: 0.5 });
        await sleep(80);
        await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: p.x, y: p.y, button: "left", buttons: 0, clickCount: 1 });
      });
      await step("focus #f by a press", async () => {
        const p = centre("f", 0.9);
        await mv(p);
        await send("Input.dispatchMouseEvent", { type: "mousePressed", x: p.x, y: p.y, button: "left", buttons: 1, clickCount: 1, force: 0.5 });
        await sleep(80);
        await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: p.x, y: p.y, button: "left", buttons: 0, clickCount: 1 });
      });
      const key = (type: string, k: { key: string; code: string; kc: number; text?: string; loc?: number; mods?: number; rep?: boolean }) =>
        send("Input.dispatchKeyEvent", { type, key: k.key, code: k.code, windowsVirtualKeyCode: k.kc, nativeVirtualKeyCode: k.kc, modifiers: k.mods ?? 0,
          ...(k.text && type === "keyDown" ? { text: k.text, unmodifiedText: k.text } : {}), ...(k.loc ? { location: k.loc } : {}), ...(k.rep ? { autoRepeat: true } : {}) });
      const SHIFT = { key: "Shift", code: "ShiftLeft", kc: 16, loc: 1 };
      await step("Shift keydown, H (modifiers 8), Shift up: a person's capital", async () => {
        await key("rawKeyDown", { ...SHIFT, mods: 8 }); await sleep(60);
        await key("keyDown", { key: "H", code: "KeyH", kc: 72, text: "H", mods: 8 }); await sleep(70);
        await key("keyUp", { key: "H", code: "KeyH", kc: 72, mods: 8 }); await sleep(40);
        await key("keyUp", SHIFT);
      });
      await step("key rollover: h down, e down, h up, e up", async () => {
        await key("keyDown", { key: "h", code: "KeyH", kc: 72, text: "h" }); await sleep(70);
        await key("keyDown", { key: "e", code: "KeyE", kc: 69, text: "e" }); await sleep(30);
        await key("keyUp", { key: "h", code: "KeyH", kc: 72 }); await sleep(60);
        await key("keyUp", { key: "e", code: "KeyE", kc: 69 });
      });
      await step("auto-repeat: a down, 3 repeats, up", async () => {
        await key("keyDown", { key: "a", code: "KeyA", kc: 65, text: "a" });
        for (let i = 0; i < 3; i++) { await sleep(33); await key("keyDown", { key: "a", code: "KeyA", kc: 65, text: "a", rep: true }); }
        await sleep(30); await key("keyUp", { key: "a", code: "KeyA", kc: 65 });
      });
      await step("insertText", () => send("Input.insertText", { text: "xyz" }));
      await step("wheel deltaY 100, 53, 120 at a point", async () => {
        const p = { x: 600, y: 600 };
        await mv(p);
        for (const dy of [100, 53, 120]) { await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: p.x, y: p.y, deltaX: 0, deltaY: dy }); await sleep(120); }
        await sleep(300);
        await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: p.x, y: p.y, deltaX: 0, deltaY: -273 });
        await sleep(300);
      });
      await relayout();
      await step("moves into the box and a press on its square", async () => {
        for (const p of line({ x: 600, y: 300 }, boxSquare(), 20)) { await mv(p); await sleep(16); }
        const p = boxSquare();
        await send("Input.dispatchMouseEvent", { type: "mousePressed", x: p.x, y: p.y, button: "left", buttons: 1, clickCount: 1, force: 0.5 });
        await sleep(80);
        await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: p.x, y: p.y, button: "left", buttons: 0, clickCount: 1 });
      });
      return { frames: frames };
    } finally { await cdp?.close().catch(() => {}); await c.stop(); }
  },

  // ---------------------------------------------------------------- a: agent-browser's own commands, a window of its own
  async "agent-browser"() { return agentBrowser("agent-browser", true); },
  async "agent-browser-no-x"() { return agentBrowser("agent-browser-no-x", false); },

  // ---------------------------------------------------------------- b and d: vanilla Playwright over CDP
  async playwright() {
    const pw = createRequire(join(resolve(values.playwright!), "package.json"))("playwright-core");
    const c = await startChrome("playwright", [REC_URL("playwright")]);
    let browser: any;
    try {
      await loaded();
      const win = chromeWindow(c.proc.pid!);
      xdo("windowraise", win); xdo("windowfocus", win); await sleep(500);
      xdo("mousemove", "900", "700"); await sleep(300);
      browser = await pw.chromium.connectOverCDP(c.cdpUrl, { timeout: 15_000 });
      const page = browser.contexts()[0].pages().find((p: any) => p.url().includes("recorder.html"));
      if (!page) throw new Error("Playwright sees no recorder page");
      evalTop = async (expression) => { await page.evaluate(expression); };
      const t = { timeout: 8000 };
      const file = join(RUN, "upload.txt");
      writeFileSync(file, "upload\n");
      await step("idle 2 s", () => sleep(2000));
      await step("page.click('#b')", () => page.click("#b", t));
      await step("locator('#b').click()", () => page.locator("#b").click(t));
      await step("locator('#b').dblclick()", () => page.locator("#b").dblclick(t));
      await step("locator('#hov').hover()", () => page.locator("#hov").hover(t));
      await step("mouse.move(x, y)", () => page.mouse.move(700, 600));
      await step("mouse.move(x, y, { steps: 20 })", () => page.mouse.move(centre("b").x, centre("b").y, { steps: 20 }));
      await step("mouse.down(); mouse.up()", async () => { await page.mouse.down(); await page.mouse.up(); });
      await step("mouse.click(x, y)", () => page.mouse.click(centre("chk").x, centre("chk").y));
      await step("mouse.click(x, y, { delay: 80 })", () => page.mouse.click(centre("chk").x, centre("chk").y, { delay: 80 }));
      await step("locator('#f').click(); keyboard.type(text)", async () => { await page.locator("#f").click(t); await page.keyboard.type(TEXT); });
      await step("keyboard.type(text, { delay: 100 })", () => page.keyboard.type(TEXT, { delay: 100 }));
      await step("locator('#f').fill(text)", () => page.locator("#f").fill(TEXT, t));
      await step("locator('#f').clear()", () => page.locator("#f").clear(t));
      await step("locator('#f').pressSequentially(text)", () => page.locator("#f").pressSequentially(TEXT, t));
      await step("locator('#f').press('Enter')", () => page.locator("#f").press("Enter", t));
      await step("keyboard.press('Shift+A')", () => page.keyboard.press("Shift+A"));
      await step("keyboard.down('Shift'); press('KeyB'); up('Shift')", async () => { await page.keyboard.down("Shift"); await page.keyboard.press("KeyB"); await page.keyboard.up("Shift"); });
      await step("keyboard.insertText('héllo')", () => page.keyboard.insertText("héllo"));
      await step("locator('#ta').fill('two\\nlines')", () => page.locator("#ta").fill("two\nlines", t));
      await step("locator('#chk').check()", () => page.locator("#chk").check(t));
      await step("locator('#chk').setChecked(false)", () => page.locator("#chk").setChecked(false, t));
      await step("locator('#sel').selectOption('b')", () => page.locator("#sel").selectOption("b", t));
      await step("locator('#file').setInputFiles(file)", () => page.locator("#file").setInputFiles(file, t));
      await step("locator('#drag').dragTo(locator('#drop'))", () => page.locator("#drag").dragTo(page.locator("#drop"), t));
      await step("locator('#b').tap()", () => page.locator("#b").tap(t));
      await step("frameLocator('#box').locator('#cb').click()", () => page.frameLocator("#box").locator("#cb").click(t));
      await step("mouse.wheel(0, 600)", () => page.mouse.wheel(0, 600));
      await step("mouse.wheel(0, -600)", () => page.mouse.wheel(0, -600));
      await step("locator('#far').scrollIntoViewIfNeeded()", () => page.locator("#far").scrollIntoViewIfNeeded(t));
      await step("page.evaluate(scrollTo(0, 0))", () => page.evaluate("scrollTo(0, 0)"));
      await step("locator('#far').click()", () => page.locator("#far").click(t));
      return { playwright: require_version(values.playwright!) };
    } finally { await browser?.close().catch(() => {}); await c.stop(); }
  },

  async "playwright-extra"() {
    const pw = createRequire(join(resolve(values.playwright!), "package.json"))("playwright-core");
    const c = await startChrome("playwright-extra", [REC_URL("playwright-extra")]);
    let browser: any;
    try {
      await loaded();
      const win = chromeWindow(c.proc.pid!);
      xdo("windowraise", win); xdo("windowfocus", win); await sleep(500);
      xdo("mousemove", "900", "700"); await sleep(300);
      browser = await pw.chromium.connectOverCDP(c.cdpUrl, { timeout: 15_000 });
      const page = browser.contexts()[0].pages().find((p: any) => p.url().includes("recorder.html"));
      if (!page) throw new Error("Playwright sees no recorder page");
      evalTop = async (expression) => { await page.evaluate(expression); };
      const t = { timeout: 8000 };
      await step("idle 2 s", () => sleep(2000));
      await step("page.mouse.dblclick(x, y)", () => page.mouse.dblclick(centre("b").x, centre("b").y));
      await step("locator('#b').click({ modifiers: ['Shift'] })", () => page.locator("#b").click({ ...t, modifiers: ["Shift"] }));
      await step("locator('#b').dblclick({ modifiers: ['Alt'] })", () => page.locator("#b").dblclick({ ...t, modifiers: ["Alt"] }));
      await step("locator('#b').click({ button: 'right' })", () => page.locator("#b").click({ ...t, button: "right" }));
      await step("locator('#b').click({ button: 'middle' })", () => page.locator("#b").click({ ...t, button: "middle" }));
      await step("locator('#b').click({ clickCount: 3 })", () => page.locator("#b").click({ ...t, clickCount: 3 }));
      await step("locator('#b').click({ delay: 80 })", () => page.locator("#b").click({ ...t, delay: 80 }));
      await step("locator('#ta').focus()", () => page.locator("#ta").focus(t));
      await step("locator('#ta').blur()", () => page.locator("#ta").blur(t));
      await step("locator('#b').dispatchEvent('click')", () => page.locator("#b").dispatchEvent("click", undefined, t));
      await step("locator('#f').selectText()", () => page.locator("#f").selectText(t));
      await step("page.touchscreen.tap(x, y)", () => page.touchscreen.tap(centre("b").x, centre("b").y));
      // The script focus of the typing actions: #b has the focus first, so the field has none.
      await step("locator('#b').click() (the focus leaves the field)", () => page.locator("#b").click(t));
      await step("locator('#f').pressSequentially('abc') into a field with no focus", () => page.locator("#f").pressSequentially("abc", t));
      await step("locator('#b').click() (the focus leaves the field) ", () => page.locator("#b").click(t));
      await step("locator('#ta').press('a') into a field with no focus", () => page.locator("#ta").press("a", t));
      await step("locator('#b').click() (the focus leaves the field)  ", () => page.locator("#b").click(t));
      await step("locator('#f').type('xyz') (the old name of pressSequentially)", () => page.locator("#f").type("xyz", t));
      return { playwright: require_version(values.playwright!) };
    } finally { await browser?.close().catch(() => {}); await c.stop(); }
  },
};

/** Part B's use of the page, checked: a file:// page with its sandboxed box, X input, the download, the analysis. */
async function fileMode(): Promise<Record<string, unknown>> {
  const c = await startChrome("file-mode", [`file://${join(HERE, "recorder.html")}`]);
  let cdp: CDPConnection | undefined;
  try {
    cdp = await CDPConnection.connect(c.cdpUrl);
    const downloads = join(RUN, "downloads");
    mkdirSync(downloads, { recursive: true });
    await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads });
    let page: { targetId: string } | undefined;
    for (let i = 0; i < 50 && !page; i++, await sleep(200)) page = ((await cdp.send("Target.getTargets")).targetInfos as { targetId: string; type: string; url: string }[]).find((t) => t.type === "page" && t.url.endsWith("recorder.html"));
    if (!page) throw new Error("no recorder page");
    await sleep(1500);
    // The probe reads the places of the page's elements through a session of its own (a person sees them).
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
    const rectOf = async (expr: string): Promise<Pt> => {
      const v = (await cdp!.send("Runtime.evaluate", { expression: `(() => { const r = (${expr}).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`, returnByValue: true }, sessionId)).result.value as number[];
      return { x: v[0], y: v[1] };
    };
    const g = (await cdp.send("Runtime.evaluate", { expression: "({ wx: screenX, wy: screenY, ow: outerWidth, oh: outerHeight, iw: innerWidth, ih: innerHeight })", returnByValue: true }, sessionId)).result.value;
    (recs[scenarioName] ??= []).push({ f: "top", e: "state", ...g });
    const win = chromeWindow(c.proc.pid!);
    xdo("windowraise", win); xdo("windowfocus", win); await sleep(500);
    xdo("mousemove", "900", "700"); await sleep(300);
    const click = async (p: Pt) => { xPath(p, 400, 125); await sleep(120); xPress(85); await sleep(400); };
    await step("task 1: ten trials by X input", async () => {
      await click(await rectOf("document.getElementById('t1')"));
      for (let i = 0; i < 10; i++) {
        await click(await rectOf("document.getElementById('start')"));
        const b = await rectOf("document.getElementById('box')");
        await click({ x: b.x - 150 + 28, y: b.y - 32.5 + 32 });
        await sleep(800);
      }
    }, 60_000);
    await step("task 5: two rounds of Tab and Space by X input", async () => {
      await click(await rectOf("document.getElementById('t5')"));
      for (let i = 0; i < 2; i++) {
        await click(await rectOf("document.getElementById('start')"));
        await sleep(300); xdo("key", "Tab"); await sleep(300); xdo("key", "space"); await sleep(1200);
      }
    });
    await step("save JSON", async () => { await click(await rectOf("document.getElementById('save')")); await sleep(1500); });
    const { readdirSync } = await import("node:fs");
    const files = readdirSync(downloads).filter((f) => f.endsWith(".json"));
    if (!files.length) throw new Error("no saved JSON file");
    const saved = JSON.parse(readFileSync(join(downloads, files[0]), "utf8"));
    const count = (f: string, e?: string) => saved.records.filter((r: Rec) => r.f === f && (!e || r.e === e)).length;
    const analysis = execFileSync(process.execPath, [join(HERE, "analyze.ts"), join(downloads, files[0])], { encoding: "utf8", timeout: 30_000 });
    return { file: files[0].replace(/\d{4}-\d\d-\d\dT[\d-]+Z/, "TIME"), records: saved.records.length, frames: saved.frames.length,
      top: count("top"), box: count("box"), boxMoves: count("box", "pointermove"), boxChecked: count("box", "box-checked"), trials: saved.records.filter((r: Rec) => r.e === "task" && r.what === "trial").length,
      boxState: saved.records.find((r: Rec) => r.f === "box" && r.e === "state") ? "yes" : "no", analysis: analysis.split("\n").filter((l) => /^\| (1-clickbox|5-keys-to-box)/.test(l)) };
  } finally { await cdp?.close().catch(() => {}); await c.stop(); }
}

function require_version(dir: string): string {
  try { return JSON.parse(readFileSync(join(resolve(dir), "node_modules", "playwright-core", "package.json"), "utf8")).version; } catch { return "?"; }
}

async function agentBrowser(name: string, x: boolean): Promise<Record<string, unknown>> {
  const c = await startChrome(name, [`http://rec.localhost:${PORT}/blank.html`]);
  try {
    const stateDir = join(RUN, `state-${name}`);
    const o: BrowserOptions = { stateDir, cdpUrl: c.cdpUrl, allow: ["rec.localhost", "box.localhost"], commandName: "click-box probe",
      log: (l) => say(/^agent-browser\b/.test(l) ? l : `agent-browser: ${l}`), ...(x ? {} : { display: { xdotool: false } }) };
    await sleep(1500);
    xdo("mousemove", "900", "700");
    await commands.open(o, { url: REC_URL(name), name: "rec" });
    await loaded();
    // The blank page's window comes back over the recorder's, as another agent's or the operator's window: agent-browser's
    // first input then brings the recorder's window forward (Page.bringToFront), and the real pointer event of that
    // activation lets it verify its display and use the X pointer (src/input.ts, Hands.begin).
    const blank = chromeWindow(c.proc.pid!, "blank");
    xdo("windowraise", blank); xdo("windowfocus", blank); await sleep(500);
    const raw = await CDPConnection.connect(c.cdpUrl);
    const targets = (await raw.send("Target.getTargets")).targetInfos as { targetId: string; type: string; url: string }[];
    const page = targets.find((t) => t.type === "page" && t.url.includes("recorder.html"))!;
    const { sessionId } = await raw.send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
    // The probe's own reads of the layout go through a session of its own (agent-browser's isolated world is its own).
    evalTop = async (expression) => { await raw.send("Runtime.evaluate", { expression }, sessionId); };
    try {
      await step("idle 2 s", () => sleep(2000));
      await step("click #b", () => commands.click(o, { tab: "rec", target: "#b" }));
      await step("hover #hov", () => commands.hover(o, { tab: "rec", target: "#hov" }));
      await step("type --into #f", () => commands.type(o, { tab: "rec", text: TEXT, into: "#f" }));
      await step("press Enter", () => commands.press(o, { tab: "rec", key: "Enter" }));
      await relayout();
      await step("clickAt the box's square (library Tab.clickAt)", async () => {
        const b = await AgentBrowser.connect(o);
        try { const tab = await b.find("rec"); const p = boxSquare(); await tab.clickAt(p.x, p.y); } finally { await b.disconnect().catch(() => {}); }
      });
      await step("click #far (the wheel brings it into view)", () => commands.click(o, { tab: "rec", target: "#far" }), 30_000);
    } finally { await raw.close().catch(() => {}); }
    let pointer: unknown = null;
    try { pointer = JSON.parse(readFileSync(join(stateDir, "pointer.json"), "utf8")).display ?? null; } catch { /* none */ }
    return { xPointer: x, pointerDisplay: pointer };
  } finally { await c.stop(); }
}

// ------------------------------------------------------------------ run
const product = execFileSync(CHROME, ["--version"], { encoding: "utf8" }).trim();
const out: Record<string, unknown> = { chrome: product, display: DISPLAY, screen: SCREEN, playwright: values.playwright ? require_version(values.playwright) : null, scenarios: {} };
for (const name of ONLY) {
  scenarioName = name;
  say(`--- ${name}`);
  let notes: Record<string, unknown> = {}, error: string | undefined;
  const t0 = now();
  try { notes = name === "file-mode" ? await fileMode() : await SCENARIOS[name](); }
  catch (e) { error = String((e as Error).stack ?? e).slice(0, 600); say(`${name}: ERROR ${error}`); }
  await sleep(500);
  (out.scenarios as Record<string, unknown>)[name] = { t0, t1: now(), notes, error, marks: marks[name] ?? [], recs: recs[name] ?? [], trace: traces[name] ?? [] };
}
writeFileSync(join(RUN, "results.json"), JSON.stringify(out) + "\n");
say(`wrote ${join(RUN, "results.json")}`);
server.close();
process.exit(0);
