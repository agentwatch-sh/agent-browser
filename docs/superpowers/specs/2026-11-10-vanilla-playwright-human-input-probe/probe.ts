// The probe of board task ab-t30.6 (docs/superpowers/specs/2026-11-10-vanilla-playwright-human-input-design.md, section
// 17). Not part of `npm test`. Linux only, in a private Xvfb that it starts (display 169 by default), with Chromium
// processes of its own and local pages only.
//
//   node probe.ts --out-dir DIR --playwright DIR [--display 169] [--chrome /usr/bin/chromium] [--only source,stage]
//
// It uses the recorder page of the input research (docs/research/2026-11-09-click-box-input-signals/recorder.html) on a
// local server (rec.localhost, with the click-box stand-in in a frame of box.localhost), and that research's analyze.ts
// reads its results.json. The scenarios:
//   source  the event source: the same planned paths (src/record.ts planMove, sampled every 8 ms: a 125 Hz mouse) as real
//           X input (XTEST: one `xdotool -` script) and as CDP moves that are sent at 125 Hz without a wait for each
//           answer, with the `timestamp` parameter in whole ms, with a fractional `timestamp`, and with none; a move to
//           the point where the pointer is
//   stage   vanilla Playwright through a prototype of the input stage: a bridge that turns Playwright's input calls into a
//           person's input (paths at 125 Hz with whole-ms timestamps, a pause and a press, held answers, keys with a
//           person's timing, a Shift key for capitals, rollover, typed keys for a short fill, wheel notches of 120 px, a
//           wheel scroll in place of DOM.scrollIntoViewIfNeeded, a click in place of Playwright's script focus, and the
//           hover path before the hit-target check)
// Chromium runs with --remote-debugging-pipe; the bridge serves the pipe as a WebSocket on a Unix socket in a short
// temporary folder of its own (removed at the end) and records each CDP message with its time. Chromium opens no
// debugging port. No page of the network is reachable: the host resolver maps every host but the two local ones to
// nothing, and the proxy is a closed local port. One harness at a time and nothing left after its end
// (test/live/README.md): the harness guard; the probe ends only the processes that it started, by their pids, and removes
// each scenario's profile.

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
import { charKey, planMove, pointAt, seededRandom } from "../../../../src/record.ts";
import { harnessGuard, reservedDisplay } from "../../../../test/live/guard.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const RECORDER = join(HERE, "../../../research/2026-11-09-click-box-input-signals/recorder.html");
const { values } = parseArgs({ options: { "out-dir": { type: "string" }, chrome: { type: "string" }, display: { type: "string" }, only: { type: "string" }, playwright: { type: "string" } } });
function refuse(message: string): never { process.stderr.write(`${message}\n`); process.exit(2); }
if (!values["out-dir"] || !values.playwright) refuse("usage: node probe.ts --out-dir DIR --playwright DIR [--display 169] [--chrome /usr/bin/chromium] [--only source,stage]");
if (process.platform !== "linux") refuse(`linux only, in a private Xvfb (this is ${process.platform})`);
const CHROME = values.chrome ?? "/usr/bin/chromium", DISPLAY = Number(values.display ?? 169);
if (!Number.isInteger(DISPLAY) || DISPLAY < 1) refuse("--display is a positive whole number");
const reserved = reservedDisplay(DISPLAY, "--display");
if (reserved) refuse(reserved);
const ALL = ["source", "stage"];
const ONLY = values.only ? values.only.split(",") : ALL;
for (const n of ONLY) if (!ALL.includes(n)) refuse(`no scenario ${n}; known: ${ALL.join(", ")}`);
const OUT = resolve(values["out-dir"]!);
mkdirSync(OUT, { recursive: true });
const RUN = mkdtempSync(join(OUT, "run-"));
const SOCKS = mkdtempSync(join(tmpdir(), "t306-"));
process.on("exit", () => rmSync(SOCKS, { recursive: true, force: true }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const now = () => Math.round((performance.timeOrigin + performance.now()) * 1000) / 1000;
const say = (line: string) => process.stderr.write(`${new Date().toISOString().slice(11, 23)} ${line}\n`);
const pw = createRequire(join(resolve(values.playwright!), "package.json"))("playwright-core");
const PW_VERSION = JSON.parse(readFileSync(join(resolve(values.playwright!), "node_modules/playwright-core/package.json"), "utf8")).version as string;

// ------------------------------------------------------------------ Xvfb (own display, own X authority)
const field = (b: Buffer) => { const n = Buffer.alloc(2); n.writeUInt16BE(b.length); return Buffer.concat([n, b]); };
const xauth = join(RUN, "Xauthority");
writeFileSync(xauth, Buffer.concat([Buffer.from([0xff, 0xff]), field(Buffer.alloc(0)), field(Buffer.from(String(DISPLAY))),
  field(Buffer.from("MIT-MAGIC-COOKIE-1")), field(randomBytes(16))]), { mode: 0o600 });
const children: ChildProcess[] = [];
process.on("exit", () => { for (const c of children.reverse()) if (c.exitCode === null && c.signalCode === null) c.kill("SIGTERM"); });
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => process.exit(130));
const harness = await harnessGuard("t30-6-input-stage");
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
say(`Xvfb :${DISPLAY} pid ${xvfb.pid}; run folder ${RUN}`);

// ------------------------------------------------------------------ the local server: the recorder, the box, the log
type Rec = Record<string, any> & { e: string; f?: string; t?: number };
let scenarioName = "none";
const recs: Record<string, Rec[]> = {};
const HTML = readFileSync(RECORDER, "utf8");
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
  res.writeHead(404).end();
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const PORT = (server.address() as { port: number }).port;
const REC_URL = (label: string) => `http://rec.localhost:${PORT}/recorder.html?sink=1&run=${label}&box=${encodeURIComponent(`http://box.localhost:${PORT}/box.html`)}`;

// ------------------------------------------------------------------ the layout (the page's own records) and X input
type Pt = { x: number; y: number };
const own = () => recs[scenarioName] ?? [];
const lastOf = (e: string, f = "top") => own().filter((r) => r.e === e && (r.f ?? "top") === f).at(-1) as Record<string, any> | undefined;
async function loaded(ms = 15_000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (lastOf("layout") && lastOf("state", "box")) return;
  throw new Error("the recorder page (or its box) did not load");
}
function centre(id: string, dx = 0.5, dy = 0.5): Pt {
  const r = lastOf("layout")?.r?.[id] as number[] | undefined;
  if (!r) throw new Error(`no layout for ${id}`);
  return { x: r[0] + r[2] * dx, y: r[1] + r[3] * dy };
}
function origin(): Pt {
  const g = lastOf("state")!;
  const side = Math.round((g.ow - g.iw) / 2);
  return { x: g.wx + side, y: g.wy + g.oh - g.ih - side };
}
const xdo = (args: string[], input?: string) => execFileSync("xdotool", args, { env: XENV, encoding: "utf8", timeout: 20_000, ...(input !== undefined ? { input } : {}) }).trim();
function chromeWindow(pid: number, title = "Input recorder"): string {
  for (const id of xdo(["search", "--onlyvisible", "--pid", String(pid)]).split("\n").filter(Boolean)) {
    try { if (xdo(["getwindowname", id]).startsWith(title)) return id; } catch { /* gone */ }
  }
  throw new Error(`no window titled "${title}"`);
}

// ------------------------------------------------------------------ marks and steps
type Mark = { name: string; t0: number; t1: number; ok: boolean; error?: string; note?: unknown };
const marks: Record<string, Mark[]> = {};
async function step(name: string, fn: () => Promise<unknown>, limitMs = 20_000, settle = 700): Promise<void> {
  const t0 = now();
  let ok = true, error: string | undefined, note: unknown;
  let timer: NodeJS.Timeout | undefined;
  try { note = await Promise.race([fn(), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`no end in ${limitMs / 1000} s`)), limitMs); })]); }
  catch (e) { ok = false; error = String((e as Error).message ?? e).split("\n")[0].slice(0, 240); }
  finally { clearTimeout(timer); }
  const t1 = now();
  (marks[scenarioName] ??= []).push({ name, t0, t1, ok, ...(error ? { error } : {}), ...(note !== undefined ? { note } : {}) });
  say(`${scenarioName}: ${name} ${ok ? "ok" : `FAILED: ${error}`} (${Math.round(t1 - t0)} ms)`);
  await sleep(settle);
}

// ------------------------------------------------------------------ the planned path (one generator: src/record.ts)
const SAMPLE_MS = 8; // a 125 Hz mouse
/** A path from `from` to `to` in whole px: planMove's legs (ghost-cursor's curve, Fitts's time, an overshoot past 500 px), one point each 8 ms, no point that does not move. */
async function plan(from: Pt, to: Pt, random: () => number, width = 24): Promise<{ p: Pt; at: number }[]> {
  const a = { x: Math.round(from.x), y: Math.round(from.y) }, b = { x: Math.round(to.x), y: Math.round(to.y) };
  const legs = await planMove(a, b, width, random);
  if (!legs.length) return [];
  const total = legs.reduce((s, l) => s + l.ms, 0), out: { p: Pt; at: number }[] = [];
  let last = a;
  for (let t = SAMPLE_MS; t < total + SAMPLE_MS; t += SAMPLE_MS) {
    const q = t >= total ? b : pointAt(legs, t), p = { x: Math.round(q.x), y: Math.round(q.y) };
    if (p.x === last.x && p.y === last.y) continue;
    out.push({ p, at: Math.min(t, Math.ceil(total / SAMPLE_MS) * SAMPLE_MS) });
    last = p;
  }
  if (!out.length || out[out.length - 1].p.x !== b.x || out[out.length - 1].p.y !== b.y) out.push({ p: b, at: (out.at(-1)?.at ?? 0) + SAMPLE_MS });
  return out;
}
const between = (random: () => number, a: number, b: number) => a + (b - a) * random();

// ------------------------------------------------------------------ Chromium over a pipe, the bridge, and the stage
const BASE_ARGS = ["--remote-debugging-pipe", "--no-first-run", "--no-default-browser-check", "--ozone-platform=x11", "--password-store=basic",
  "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-default-apps", "--disable-backgrounding-occluded-windows",
  "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE rec.localhost , EXCLUDE box.localhost", "--proxy-server=http://127.0.0.1:9",
  "--proxy-bypass-list=rec.localhost;box.localhost", "--window-position=0,0", "--window-size=1280,1000"];
type Trace = { t: number; d: ">" | "<" | "e" | "s"; id?: number; m?: string; s?: string; p?: unknown; err?: string; held?: number };
type Client = { ws: WebSocket; sessions: Set<string> };
type Msg = { id: number; method: string; sessionId?: string; params?: any };
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
  stage: Stage | null = null;
  /** The type of each session's target (page, iframe), from the attach events. */
  readonly types = new Map<string, string>();
  private buf = "";
  private next = 1;
  private pending = new Map<number, { c?: Client; id?: number; method: string; sessionId?: string; done?: (m: any) => void; recv?: number }>();
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
  /** A client's call goes to Chrome now; its answer goes back to the client. */
  forward(c: Client, m: Msg, recv = now()) {
    const gid = this.next++;
    this.pending.set(gid, { c, id: m.id, method: m.method, sessionId: m.sessionId, recv });
    this.toChrome({ ...m, id: gid });
  }
  /** The stage's own call: never seen by a client. */
  call(method: string, params: object, sessionId?: string): Promise<any> {
    const gid = this.next++;
    this.trace.push({ t: now(), d: "s", id: gid, m: method, ...(sessionId ? { s: sessionId.slice(0, 6) } : {}), p: trim(params) });
    return new Promise((resolve, reject) => {
      this.pending.set(gid, { method, done: (m) => (m.error ? reject(new Error(String(m.error.message))) : resolve(m.result)) });
      this.toChrome({ id: gid, method, params, ...(sessionId ? { sessionId } : {}) });
    });
  }
  /** The stage answers a client's call itself. */
  answer(c: Client, m: Msg, result: object, recv: number) {
    this.trace.push({ t: now(), d: "<", id: -m.id, m: m.method, held: Math.round((now() - recv) * 10) / 10 });
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify({ id: m.id, ...(m.sessionId ? { sessionId: m.sessionId } : {}), result }));
  }
  private fromClient(c: Client, raw: string) {
    const m = JSON.parse(raw) as Msg, recv = now();
    if (m.method === "Target.setAutoAttach" && !m.sessionId) this.autoAttacher = m.params?.autoAttach ? c : undefined;
    this.trace.push({ t: recv, d: ">", id: m.id, m: m.method, ...(m.sessionId ? { s: m.sessionId.slice(0, 6) } : {}), ...(m.params ? { p: trim(m.params) } : {}) });
    if (this.stage && m.sessionId && this.types.get(m.sessionId) === "page") { this.stage.enqueue(c, m, recv); return; }
    this.forward(c, m, recv);
  }
  private fromChrome(raw: string) {
    const m = JSON.parse(raw);
    if (typeof m.id === "number") {
      const p = this.pending.get(m.id);
      this.pending.delete(m.id);
      if (p?.done) { p.done(m); return; }
      if (!p?.c) return;
      this.trace.push({ t: now(), d: "<", id: p.id, m: p.method, ...(m.error ? { err: String(m.error.message).slice(0, 120) } : {}), ...(p.recv ? { held: Math.round((now() - p.recv) * 10) / 10 } : {}) });
      if (p.method === "Target.attachToTarget" && m.result?.sessionId) { this.owner.set(m.result.sessionId, p.c); p.c.sessions.add(m.result.sessionId); }
      if (p.c.ws.readyState === WebSocket.OPEN) p.c.ws.send(JSON.stringify({ ...m, id: p.id }));
      return;
    }
    if (m.method === "Target.attachedToTarget") {
      this.types.set(m.params.sessionId, m.params.targetInfo?.type ?? "?");
      const parent = m.sessionId ? this.owner.get(m.sessionId) : this.autoAttacher;
      if (parent) { this.owner.set(m.params.sessionId, parent); if (!m.sessionId) parent.sessions.add(m.params.sessionId); }
    }
    if (m.method === "Target.detachedFromTarget") { const o = this.owner.get(m.params.sessionId); o?.sessions.delete(m.params.sessionId); this.owner.delete(m.params.sessionId); }
    const to = m.sessionId ? this.owner.get(m.sessionId) : (m.method === "Target.attachedToTarget" ? this.autoAttacher : undefined);
    for (const c of to ? [to] : this.clients) if (c.ws.readyState === WebSocket.OPEN) c.ws.send(raw);
  }
  private leave(c: Client) {
    this.clients.delete(c);
    for (const s of c.sessions) { this.pending.set(this.next, { method: "detach" }); this.toChrome({ id: this.next++, method: "Target.detachFromTarget", params: { sessionId: s } }); }
    if (this.autoAttacher === c) {
      this.autoAttacher = undefined;
      this.pending.set(this.next, { method: "x" }); this.toChrome({ id: this.next++, method: "Target.setAutoAttach", params: { autoAttach: false, waitForDebuggerOnStart: false, flatten: true } });
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
    rmSync(this.dir, { recursive: true, force: true }); // the scenario's own temporary profile goes with its Chrome
  }
}

/**
 * Playwright's serialized call argument (`serializeAsCallArgument`, playwright-core 1.65.0), the small part that the
 * stage reads: a string, a number or a boolean as itself, undefined and null as `{v}`, a handle as `{h: index}`, an array
 * as `{a: [...]}`, an object as `{o: [{k, v}]}`.
 */
function decode(v: any, handles: string[]): unknown {
  if (v === null || typeof v !== "object") return v;
  if ("v" in v) return v.v === "null" ? null : undefined;
  if ("h" in v) return { handle: handles[v.h] };
  if ("a" in v) return (v.a as any[]).map((x) => decode(x, handles));
  if ("o" in v) return Object.fromEntries((v.o as { k: string; v: any }[]).map((e) => [e.k, decode(e.v, handles)]));
  return undefined;
}
/**
 * A call of Playwright's utility script, as Playwright 1.6x sends it: `Runtime.callFunctionOn` of
 * `(utilityScript, ...args) => utilityScript.evaluate(...args)` with the function's text as the fourth argument, the
 * serialized argument as the sixth, then the handles. The function's text, its argument, and the node (the second
 * element of an `[injected, node, ...]` argument), or null.
 */
function utilityCall(m: Msg): { fn: string; arg: unknown[] | undefined; node: string | undefined } | null {
  const p = m.params ?? {};
  if (m.method !== "Runtime.callFunctionOn" || !/utilityScript\.evaluate/.test(String(p.functionDeclaration ?? ""))) return null;
  const args = (p.arguments ?? []) as any[], fn = args[3]?.value;
  if (typeof fn !== "string") return null;
  const handles = args.slice(6).map((a) => a?.objectId as string);
  const arg = decode(args[5]?.value, handles);
  const list = Array.isArray(arg) ? arg : undefined;
  const node = (list?.[1] as { handle?: string } | undefined)?.handle;
  return { fn, arg: list, node };
}

const SHIFTED = /^[A-Z~!@#$%^&*()_+{}|:"<>?]$/;
const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta"]);
const SHIFT_KEY = { key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, location: 1 };
/** A press's pending release: it fires at its planned time, or at once when something must come after it. */
type Pending = { code: string; at: number; fired: Promise<void>; fire: () => void; cancel: () => void };
type Keys = { lastDown: number; lastChar: string; downAt: Map<string, number>; held: Set<string>; pending: Pending[]; shift: boolean; shiftUp: Pending | null; speed: number; next: number | null };

/**
 * The prototype of the input stage (the design's section 4), for the page sessions of one Chromium. Each page session has
 * one gate: its calls run in order, and a call runs after the input before it has been played. The stage's own calls
 * (paths, presses, keys, notches, reads) go to Chrome with ids of their own.
 */
class Stage {
  hover: "hold" | "naive" = "hold";
  readonly random: () => number;
  readonly stats: Record<string, number> = {};
  private readonly br: Chromium;
  private gates = new Map<string, Promise<void>>();
  private last = new Map<string, Pt>();
  private lastMoveEnd = new Map<string, number>();
  private pressAt = new Map<string, { at: number; hold: number }>();
  private releaseAt = new Map<string, number>();
  private keys = new Map<string, Keys>();
  constructor(br: Chromium, seed: number) { this.br = br; this.random = seededRandom(seed); }
  private count(k: string, n = 1) { this.stats[k] = (this.stats[k] ?? 0) + n; }
  private perf() { return performance.now(); }
  private until(t: number) { return sleep(t - this.perf()); }
  /** The event's time: whole ms, a person's input latency (3 to 5 ms) before the send, so never in the future. */
  private ts() { return (Date.now() - 3 - Math.floor(this.random() * 3)) / 1000; }
  start(sessionId: string, p: Pt) { this.last.set(sessionId, p); }
  enqueue(c: Client, m: Msg, recv: number) {
    const s = m.sessionId!;
    const run = (this.gates.get(s) ?? Promise.resolve()).then(() => this.handle(c, m, recv)).catch((e) => {
      say(`stage: ${m.method} failed: ${(e as Error).message}`);
      this.br.answer(c, m, {}, recv);
    });
    this.gates.set(s, run);
  }
  private ks(s: string) {
    let k = this.keys.get(s);
    if (!k) { k = { lastDown: 0, lastChar: "", downAt: new Map(), held: new Set(), pending: [], shift: false, shiftUp: null, speed: between(this.random, 0.85, 1.15), next: null }; this.keys.set(s, k); }
    return k;
  }
  /** Every pending key event of the session is sent (each at its planned time). */
  private async flush(s: string) {
    const k = this.ks(s);
    await Promise.all(k.pending.map((p) => p.fired));
    k.pending = [];
    if (k.shiftUp) await k.shiftUp.fired;
  }
  private async handle(c: Client, m: Msg, recv: number): Promise<void> {
    const s = m.sessionId!, p = m.params ?? {};
    if (m.method === "Input.dispatchKeyEvent") return this.key(c, m, recv);
    if (m.method === "Input.insertText") return this.insert(c, m, recv);
    await this.flush(s);
    if (m.method === "Input.dispatchMouseEvent") return this.mouse(c, m, recv);
    if (m.method === "DOM.scrollIntoViewIfNeeded") return this.scrollIntoView(c, m, recv);
    const u = utilityCall(m);
    if (u && /\binjected\.setupHitTargetInterceptor\(/.test(u.fn)) {
      this.count("setupCalls");
      const o = u.arg?.[2] as Record<string, any> | undefined;
      if (o?.actionType === "hover" && o.hitPoint && this.hover === "hold") { this.count("hoverPathsBeforeSetup"); await this.path(s, { x: o.hitPoint.x, y: o.hitPoint.y }, 0); }
    }
    if (u && /\binjected\.(focusNode|fill)\(/.test(u.fn) && u.node) await this.clickToFocus(s, u.node);
    this.br.forward(c, m, recv);
  }
  /** A path from the page's last point to `to`, at 125 Hz, each move with its send time in whole ms, not awaited one by one. */
  private async path(s: string, to: Pt, modifiers: number) {
    const from = this.last.get(s)!, pts = await plan(from, to, this.random);
    const t0 = this.perf(), sent: Promise<unknown>[] = [];
    for (const { p, at } of pts) {
      await this.until(t0 + at);
      sent.push(this.br.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y, button: "none", buttons: 0, modifiers, timestamp: this.ts() }, s));
    }
    await Promise.all(sent);
    this.count("pathMoves", pts.length);
    this.last.set(s, { x: Math.round(to.x), y: Math.round(to.y) });
    this.lastMoveEnd.set(s, this.perf());
  }
  private async mouse(c: Client, m: Msg, recv: number) {
    const s = m.sessionId!, p = m.params, at = this.last.get(s)!, to = { x: Math.round(p.x), y: Math.round(p.y) };
    const same = to.x === at.x && to.y === at.y;
    if (p.type === "mouseMoved") {
      if (p.buttons) { this.last.set(s, to); this.br.forward(c, m, recv); return; } // a drag: not in this prototype
      if (same) { this.count("sameMovesAnswered"); this.br.answer(c, m, {}, recv); return; }
      await this.path(s, to, p.modifiers ?? 0);
      this.br.answer(c, m, {}, recv);
      return;
    }
    if (p.type === "mousePressed") {
      if (!same) await this.path(s, to, p.modifiers ?? 0);
      const rel = this.releaseAt.get(s) ?? 0, end = this.lastMoveEnd.get(s) ?? 0;
      // The second press of a double click comes a person's gap after the first release; a first press, a pause after the path.
      await this.until(rel > end ? rel + between(this.random, 90, 150) : end + between(this.random, 90, 220));
      const r = await this.br.call("Input.dispatchMouseEvent", { ...p, x: to.x, y: to.y, force: 0.5, timestamp: this.ts() }, s);
      this.pressAt.set(s, { at: this.perf(), hold: between(this.random, 75, 125) });
      this.count("presses");
      this.br.answer(c, m, r ?? {}, recv);
      return;
    }
    if (p.type === "mouseReleased") {
      const pr = this.pressAt.get(s);
      if (pr) await this.until(pr.at + pr.hold);
      const r = await this.br.call("Input.dispatchMouseEvent", { ...p, x: to.x, y: to.y, timestamp: this.ts() }, s);
      this.releaseAt.set(s, this.perf());
      this.br.answer(c, m, r ?? {}, recv);
      return;
    }
    if (p.type === "mouseWheel") {
      await this.notches(s, p.deltaX ?? 0, p.deltaY ?? 0, p.modifiers ?? 0);
      this.br.answer(c, m, {}, recv);
      return;
    }
    this.br.forward(c, m, recv);
  }
  /** Wheel notches of 120 px (X11), a person's gaps; at least one notch for a delta that is not 0. */
  private async notches(s: string, dx: number, dy: number, modifiers: number) {
    const at = this.last.get(s)!;
    for (const [d, axis] of [[dy, "y"], [dx, "x"]] as const) {
      if (!d) continue;
      const n = Math.max(1, Math.round(Math.abs(d) / 120));
      for (let i = 0; i < n; i++) {
        await this.br.call("Input.dispatchMouseEvent", { type: "mouseWheel", x: at.x, y: at.y, deltaX: axis === "x" ? Math.sign(d) * 120 : 0, deltaY: axis === "y" ? Math.sign(d) * 120 : 0, modifiers, timestamp: this.ts() }, s);
        this.count("notches");
        if (i < n - 1) await sleep(between(this.random, 35, 90));
      }
    }
  }
  /** DOM.scrollIntoViewIfNeeded as a person scrolls: wheel notches until the element is in view, then the answer {}. */
  private async scrollIntoView(c: Client, m: Msg, recv: number) {
    const s = m.sessionId!, p = m.params ?? {};
    const node = p.objectId ? { objectId: p.objectId } : p.backendNodeId ? { backendNodeId: p.backendNodeId } : { nodeId: p.nodeId };
    for (let round = 0; round < 4; round++) {
      let box: { top: number; bottom: number }, vh: number;
      try {
        const q = (await this.br.call("DOM.getContentQuads", node, s)).quads?.[0] as number[] | undefined;
        const lm = await this.br.call("Page.getLayoutMetrics", {}, s);
        if (!q) break;
        const ys = [q[1], q[3], q[5], q[7]];
        box = { top: Math.min(...ys), bottom: Math.max(...ys) };
        vh = lm.cssVisualViewport.clientHeight;
      } catch { break; }
      const mid = (box.top + box.bottom) / 2;
      if ((box.top >= 0 && box.bottom <= vh) || (mid > vh * 0.2 && mid < vh * 0.8)) { this.count("scrollsByWheel", round ? 1 : 0); this.br.answer(c, m, {}, recv); return; }
      await this.notches(s, 0, mid - vh / 2, 0);
      await sleep(350); // the smooth scroll of the last notch ends
    }
    this.count("scrollFallbacks");
    this.br.forward(c, m, recv);
  }
  /** Before Playwright's script focus (focusNode, fill): a click on the field when it does not have the focus. */
  private async clickToFocus(s: string, objectId: string) {
    const st = (await this.br.call("Runtime.callFunctionOn", { objectId, returnByValue: true,
      functionDeclaration: "function () { const d = this.ownerDocument, a = d.activeElement; return { focused: (a === this || this.contains(a)) && d.hasFocus(), text: typeof this.value === 'string' && this.value.length > 0 }; }" }, s)).result.value;
    if (st.focused) return;
    const q = (await this.br.call("DOM.getContentQuads", { objectId }, s)).quads?.[0] as number[] | undefined;
    if (!q) return;
    const xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]];
    const l = Math.min(...xs), r = Math.max(...xs), t = Math.min(...ys), b = Math.max(...ys);
    // A field with text: its left end, where the script focus puts the caret (Playwright's caret reset); else its middle.
    const to = { x: st.text ? l + between(this.random, 3, 6) : l + (r - l) * between(this.random, 0.3, 0.7), y: t + (b - t) * between(this.random, 0.35, 0.65) };
    await this.path(s, to, 0);
    await this.until((this.lastMoveEnd.get(s) ?? 0) + between(this.random, 90, 220));
    const at = this.last.get(s)!;
    await this.br.call("Input.dispatchMouseEvent", { type: "mousePressed", x: at.x, y: at.y, button: "left", buttons: 1, clickCount: 1, force: 0.5, timestamp: this.ts() }, s);
    await sleep(between(this.random, 75, 125));
    await this.br.call("Input.dispatchMouseEvent", { type: "mouseReleased", x: at.x, y: at.y, button: "left", buttons: 0, clickCount: 1, timestamp: this.ts() }, s);
    this.releaseAt.set(s, this.perf());
    this.count("focusClicks");
  }
  /** The time from one key's press to the next: a lognormal around 170 ms (times the session's speed), longer after a space or a mark. */
  private interval(k: { lastChar: string; speed: number }) {
    const u1 = Math.max(1e-9, this.random()), u2 = this.random(), z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    let ms = 150 * Math.exp(0.35 * z) * k.speed;
    if (k.lastChar === " ") ms += between(this.random, 20, 120);
    if (/[.,!?;:]/.test(k.lastChar)) ms += between(this.random, 80, 250);
    return Math.min(700, Math.max(60, ms));
  }
  private hold() {
    const u1 = Math.max(1e-9, this.random()), u2 = this.random(), z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return Math.min(190, Math.max(55, 105 + 22 * z));
  }
  private pendingOf(code: string, at: number, send: () => Promise<unknown>): Pending {
    let fire!: () => void, cancelled = false;
    const go = new Promise<void>((r) => { fire = r; });
    const fired = Promise.race([go, this.until(at)]).then(() => (cancelled ? undefined : send())).then(() => {});
    return { code, at, fired, fire, cancel: () => { cancelled = true; fire(); } };
  }
  /** The stage's Shift goes up 15 to 60 ms after the last held key went up (a next capital can still keep it down). */
  private planShiftUp(s: string, k: Keys) {
    if (!k.shift || k.held.size || k.shiftUp) return;
    k.shiftUp = this.pendingOf("ShiftLeft", this.perf() + between(this.random, 15, 60), async () => {
      await this.br.call("Input.dispatchKeyEvent", { type: "keyUp", ...SHIFT_KEY, modifiers: 0, timestamp: this.ts() }, s);
      k.shift = false; k.shiftUp = null; this.count("shiftUps");
    });
  }
  /** Every pending release now (in order), then the stage's Shift: what must come before a key with no Shift. */
  private async releaseAll(s: string, k: Keys) {
    for (const q of k.pending) q.fire();
    await Promise.all(k.pending.map((q) => q.fired));
    k.pending = [];
    this.planShiftUp(s, k);
    if (k.shiftUp) { const u = k.shiftUp; u.fire(); await u.fired; }
  }
  /** One key event of the client, with a person's timing; a Shift key for a shifted character with no Shift; rollover by an early answer of a release. */
  private async key(c: Client, m: Msg, recv: number) {
    const s = m.sessionId!, p = m.params, k = this.ks(s);
    const isMod = MODIFIER_KEYS.has(p.key);
    if (p.type === "keyUp") {
      const down = k.downAt.get(p.code) ?? this.perf();
      k.downAt.delete(p.code);
      const hold = isMod ? between(this.random, 40, 90) : this.hold();
      // The next key's base interval is drawn now: when it is shorter than this hold, the next press can come first.
      if (!isMod) k.next = this.interval(k);
      const up = this.pendingOf(p.code, down + hold, async () => {
        await this.br.call("Input.dispatchKeyEvent", { ...p, modifiers: (p.modifiers ?? 0) | (k.shift && !isMod ? 8 : 0), timestamp: this.ts() }, s);
        k.held.delete(p.code);
        this.planShiftUp(s, k);
      });
      if (!isMod && k.next !== null && k.next < hold) { k.pending.push(up); this.count("earlyReleaseAnswers"); this.br.answer(c, m, {}, recv); return; }
      await up.fired;
      this.br.answer(c, m, {}, recv);
      return;
    }
    // A press (keyDown, rawKeyDown, char).
    const text = typeof p.text === "string" ? p.text : "";
    const needShift = !isMod && SHIFTED.test(text) && !((p.modifiers ?? 0) & 8);
    // The same key again: its release first.
    for (const q of k.pending.filter((x) => x.code === p.code)) { q.fire(); await q.fired; }
    k.pending = k.pending.filter((x) => x.code !== p.code);
    const planned = k.lastDown && !isMod ? k.lastDown + (k.next ?? this.interval(k)) : this.perf();
    if (!isMod) k.next = null;
    if (needShift) {
      if (k.shiftUp) { k.shiftUp.cancel(); k.shiftUp = null; this.count("shiftKeptDown"); } // the next capital keeps Shift down
      if (!k.shift) {
        await this.until(planned - between(this.random, 45, 95));
        await this.br.call("Input.dispatchKeyEvent", { type: "rawKeyDown", ...SHIFT_KEY, modifiers: 8, timestamp: this.ts() }, s);
        k.shift = true; this.count("shiftDowns");
      }
    } else if (k.shift && !isMod) await this.releaseAll(s, k);
    await this.until(planned);
    const r = await this.br.call("Input.dispatchKeyEvent", { ...p, modifiers: (p.modifiers ?? 0) | (k.shift && !isMod ? 8 : 0), timestamp: this.ts() }, s);
    k.held.add(p.code);
    k.downAt.set(p.code, this.perf());
    if (!isMod) { k.lastDown = this.perf(); k.lastChar = text || p.key; }
    this.count("keys");
    this.br.answer(c, m, r ?? {}, recv);
  }
  /** Input.insertText as typed keys when every character has a US key and the text is short; else as it is. */
  private async insert(c: Client, m: Msg, recv: number) {
    const s = m.sessionId!, text = String(m.params?.text ?? "");
    const chars = [...text];
    if (chars.length > 60 || chars.some((ch) => ch !== "\n" && !charKey(ch))) { await this.flush(s); this.count("insertsAsText"); this.br.forward(c, m, recv); return; }
    const sink: Client = { ws: { readyState: -1, send() {} } as unknown as WebSocket, sessions: new Set() };
    for (const ch of chars) {
      const kk = ch === "\n" ? { key: "Enter", code: "Enter", keyCode: 13, text: "\r" } : charKey(ch)!;
      const base = { key: kk.key, code: kk.code, windowsVirtualKeyCode: kk.keyCode, modifiers: 0, location: 0, autoRepeat: false, isKeypad: false };
      await this.key(sink, { id: 0, method: "Input.dispatchKeyEvent", sessionId: s, params: { type: "keyDown", ...base, text: kk.text, unmodifiedText: kk.text } }, recv);
      await this.key(sink, { id: 0, method: "Input.dispatchKeyEvent", sessionId: s, params: { type: "keyUp", ...base } }, recv);
    }
    await this.flush(s);
    this.count("insertsAsKeys");
    this.br.answer(c, m, {}, recv);
  }
}

// ------------------------------------------------------------------ the scenarios
const traces: Record<string, Trace[]> = {};
const stats: Record<string, unknown> = {};
async function startChrome(name: string, urls: string[]): Promise<Chromium> {
  const c = new Chromium(name, urls);
  traces[name] = c.trace;
  await c.listen();
  return c;
}
/** A tiny CDP client over the bridge (no Playwright): the source scenario's own CDP calls. */
async function rawCdp(url: string) {
  const [, sock, path] = /^ws\+unix:\/\/(.+):(\/.*)$/.exec(url)!;
  const ws = new WebSocket(`ws+unix://${sock}:${path}`);
  await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
  let id = 1;
  const waits = new Map<number, (m: any) => void>();
  ws.on("message", (d) => { const m = JSON.parse(String(d)); if (m.id && waits.has(m.id)) { waits.get(m.id)!(m); waits.delete(m.id); } });
  const send = (method: string, params: object = {}, sessionId?: string) => new Promise<any>((r, j) => {
    const i = id++;
    waits.set(i, (m) => (m.error ? j(new Error(m.error.message)) : r(m.result)));
    ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  return { send, close: () => ws.close() };
}

const SCENARIOS: Record<string, () => Promise<Record<string, unknown>>> = {
  // ---------------------------------------------------------------- the same paths as real X input and as CDP moves
  async source() {
    const c = await startChrome("source", [REC_URL("source")]);
    try {
      await loaded();
      const win = chromeWindow(c.proc.pid!);
      xdo(["windowraise", win]); xdo(["windowfocus", win]); await sleep(500);
      const random = seededRandom(306);
      const starts: Pt[] = [{ x: 900, y: 700 }, { x: 760, y: 560 }, { x: 980, y: 380 }];
      const targets = () => [centre("b"), centre("hov"), centre("chk")];
      // X input first, with no CDP session on the page: one xdotool script per path (the daemon's form: `xdotool -`).
      for (let i = 0; i < 3; i++) {
        const o = origin(), from = starts[i], to = targets()[i], pts = await plan(from, to, random);
        xdo(["mousemove", String(Math.round(o.x + from.x)), String(Math.round(o.y + from.y))]); await sleep(400);
        const lines: string[] = [];
        let t = 0;
        for (const { p, at } of pts) { lines.push(`sleep ${((at - t) / 1000).toFixed(3)}`, `mousemove ${Math.round(o.x + p.x)} ${Math.round(o.y + p.y)}`); t = at; }
        lines.push("sleep 0.150", "mousedown 1", "sleep 0.090", "mouseup 1");
        await step(`x: path at 125 Hz to target ${i + 1} (${pts.length} moves), press 90 ms`, async () => { xdo(["-"], lines.join("\n") + "\n"); return { moves: pts.length }; });
      }
      xdo(["mousemove", "1900", "1060"]); await sleep(300); // the X pointer leaves the window: no real event comes into the page
      const cdp = await rawCdp(c.cdpUrl);
      const page = ((await cdp.send("Target.getTargets")).targetInfos as { targetId: string; type: string; url: string }[]).find((t) => t.type === "page" && t.url.includes("recorder.html"))!;
      const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
      const send = (mth: string, p: object) => cdp.send(mth, p, sessionId);
      const mv = (p: Pt, extra: object = {}) => send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y, button: "none", buttons: 0, ...extra });
      const variants: [string, () => object][] = [
        ["timestamp in whole ms", () => ({ timestamp: Date.now() / 1000 })],
        ["timestamp in whole ms, 4 ms before the send", () => ({ timestamp: (Date.now() - 4) / 1000 })],
        ["fractional timestamp", () => ({ timestamp: (performance.timeOrigin + performance.now()) / 1000 })],
        ["no timestamp", () => ({})],
      ];
      for (const [label, extra] of variants) {
        for (let i = 0; i < 3; i++) {
          const from = starts[i], to = targets()[i], pts = await plan(from, to, random);
          await mv(from); await sleep(400);
          await step(`cdp: path at 125 Hz, not awaited, ${label}, to target ${i + 1} (${pts.length} moves), press 90 ms`, async () => {
            const t0 = performance.now(), sent: Promise<unknown>[] = [];
            for (const { p, at } of pts) { await sleep(t0 + at - performance.now()); sent.push(mv(p, extra())); }
            await Promise.all(sent);
            await sleep(150);
            const end = pts[pts.length - 1].p;
            await send("Input.dispatchMouseEvent", { type: "mousePressed", x: end.x, y: end.y, button: "left", buttons: 1, clickCount: 1, force: 0.5, ...extra() });
            await sleep(90);
            await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: end.x, y: end.y, button: "left", buttons: 0, clickCount: 1, ...extra() });
            return { moves: pts.length };
          });
        }
      }
      await mv({ x: 700, y: 650 }, { timestamp: Date.now() / 1000 }); await sleep(300);
      await step("cdp: a move to the point where the pointer is (700,650), twice", async () => {
        await mv({ x: 700, y: 650 }, { timestamp: Date.now() / 1000 }); await sleep(50);
        await mv({ x: 700, y: 650 }, { timestamp: Date.now() / 1000 });
      });
      cdp.close();
      return {};
    } finally { await c.stop(); }
  },

  // ---------------------------------------------------------------- vanilla Playwright through the stage prototype
  async stage() {
    const c = await startChrome("stage", [REC_URL("stage")]);
    let browser: any;
    try {
      await loaded();
      const win = chromeWindow(c.proc.pid!);
      xdo(["windowraise", win]); xdo(["windowfocus", win]); await sleep(500);
      xdo(["mousemove", "1900", "1060"]); await sleep(300); // the X pointer outside the window
      const stage = new Stage(c, 3061);
      c.stage = stage;
      browser = await pw.chromium.connectOverCDP(c.cdpUrl, { timeout: 15_000 });
      const page = browser.contexts()[0].pages().find((p: any) => p.url().includes("recorder.html"));
      if (!page) throw new Error("Playwright sees no recorder page");
      const pageSession = [...c.types.entries()].find(([, t]) => t === "page")![0];
      stage.start(pageSession, { x: 900, y: 700 });
      const t = { timeout: 8000 };
      const value = (sel: string) => page.locator(sel).inputValue();
      const counts = () => ({ ...stage.stats });
      const delta = (a: Record<string, number>) => Object.fromEntries(Object.entries(stage.stats).map(([k, v]) => [k, v - (a[k] ?? 0)]).filter(([, v]) => v));
      const run = async (name: string, fn: () => Promise<unknown>, limit = 20_000) => {
        const before = counts();
        await step(name, async () => { const t0 = performance.now(); const out = await fn(); return { ms: Math.round(performance.now() - t0), out, stage: delta(before) }; }, limit);
      };
      await step("idle 2 s", () => sleep(2000));
      await run("locator('#b').click() from 900,700", () => page.locator("#b").click(t));
      // A listener of the page's own, added after Playwright's (the recorder's listeners come first, so they see every
      // event): it counts what a page script that listens on the document gets.
      const late = () => page.evaluate("(() => { const c = window.__late = { mousemove: 0, pointermove: 0 }; for (const k of Object.keys(c)) document.addEventListener(k, () => c[k]++, true); })()");
      const lateCounts = () => page.evaluate("JSON.stringify(window.__late)").then((x: string) => JSON.parse(x));
      await late();
      await run("locator('#hov').hover(): the path before the hit-target check", async () => { await page.evaluate("Object.keys(window.__late).forEach((k) => window.__late[k] = 0)"); await page.locator("#hov").hover(t); return { late: await lateCounts() }; });
      await run("mouse.move(900, 700)", () => page.mouse.move(900, 700));
      stage.hover = "naive";
      await run("locator('#hov').hover(): the path after the hit-target check (naive)", async () => { await page.evaluate("Object.keys(window.__late).forEach((k) => window.__late[k] = 0)"); await page.locator("#hov").hover(t); return { late: await lateCounts() }; });
      stage.hover = "hold";
      await run("mouse.move(900, 700) again", () => page.mouse.move(900, 700));
      await run("locator('#chk').check()", async () => { await page.locator("#chk").check(t); return { checked: await page.locator("#chk").isChecked() }; });
      await run("locator('#b').dblclick()", () => page.locator("#b").dblclick(t));
      await run("frameLocator('#box').locator('#cb').click()", () => page.frameLocator("#box").locator("#cb").click(t));
      await run("locator('#b').click({ modifiers: ['Shift'] })", () => page.locator("#b").click({ ...t, modifiers: ["Shift"] }));
      await run("locator('#f').click(); keyboard.type('Hello World, OK!')", async () => {
        await page.locator("#f").click(t); await page.keyboard.type("Hello World, OK!"); return { value: await value("#f") };
      });
      await run("locator('#ta').pressSequentially('Meet me at 10:45.') (no focus)", async () => {
        await page.locator("#ta").pressSequentially("Meet me at 10:45.", t); return { value: await value("#ta") };
      });
      await run("locator('#f').fill('jane.doe@example.com') (no focus, text in it)", async () => {
        await page.locator("#f").fill("jane.doe@example.com", t); return { value: await value("#f") };
      });
      await run("mouse.wheel(0, 600)", async () => { await page.mouse.wheel(0, 600); await sleep(500); return { scrollY: await page.evaluate("scrollY") }; });
      await run("mouse.wheel(0, -600)", async () => { await page.mouse.wheel(0, -600); await sleep(500); return { scrollY: await page.evaluate("scrollY") }; });
      await run("locator('#far').click() (below the fold)", async () => { await page.locator("#far").click(t); return { scrollY: await page.evaluate("scrollY") }; });
      await run("mouse.wheel(0, -2400)", async () => { await page.mouse.wheel(0, -2400); await sleep(700); return { scrollY: await page.evaluate("scrollY") }; });
      await run("mouse.move(900, 700); locator('#b').click({ timeout: 3000 })", async () => { await page.mouse.move(900, 700); await page.locator("#b").click({ timeout: 3000 }); });
      stats.stage = stage.stats;
      return { playwright: PW_VERSION };
    } finally {
      await browser?.close().catch(() => {});
      await c.stop();
    }
  },
};

// ------------------------------------------------------------------ the probe's own counts per step (beside analyze.ts)
function extra(name: string) {
  const r = recs[name] ?? [], tr = traces[name] ?? [];
  return (marks[name] ?? []).map((m) => {
    const list = r.filter((x) => typeof x.t === "number" && x.t >= m.t0 - 50 && x.t <= m.t1 + 650);
    const top = (e: string) => list.filter((x) => x.e === e && (x.f ?? "top") === "top").length;
    const calls = tr.filter((x) => x.t >= m.t0 - 1 && x.t <= m.t1 + 1);
    const held = calls.filter((x) => x.d === "<" && typeof x.m === "string" && x.m.startsWith("Input.")).map((x) => [x.m!.slice(6), x.held]);
    return { name: m.name, ok: m.ok, error: m.error, note: m.note,
      top: { pointermove: top("pointermove"), mousemove: top("mousemove"), mouseover: top("mouseover") },
      eventAfterHandler: list.filter((x) => typeof x.h === "number" && x.t > x.h + 0.05).length,
      clientSetupCalls: calls.filter((x) => x.d === ">" && /setupHitTargetInterceptor/.test(JSON.stringify(x.p ?? ""))).length,
      clientInput: calls.filter((x) => x.d === ">" && typeof x.m === "string" && x.m.startsWith("Input.")).length,
      stageCalls: calls.filter((x) => x.d === "s").length,
      inputAnswersHeldMs: held.slice(0, 12) };
  });
}

// ------------------------------------------------------------------ run
const product = execFileSync(CHROME, ["--version"], { encoding: "utf8" }).trim();
const out: Record<string, unknown> = { chrome: product, display: DISPLAY, screen: SCREEN, playwright: PW_VERSION, scenarios: {} };
for (const name of ONLY) {
  scenarioName = name;
  say(`--- ${name}`);
  let notes: Record<string, unknown> = {}, error: string | undefined;
  const t0 = now();
  try { notes = await SCENARIOS[name](); }
  catch (e) { error = String((e as Error).stack ?? e).slice(0, 600); say(`${name}: ERROR ${error}`); }
  await sleep(500);
  (out.scenarios as Record<string, unknown>)[name] = { t0, t1: now(), notes, error, marks: marks[name] ?? [], recs: recs[name] ?? [], trace: traces[name] ?? [] };
}
writeFileSync(join(RUN, "results.json"), JSON.stringify(out) + "\n");
writeFileSync(join(RUN, "extra.json"), JSON.stringify({ chrome: product, playwright: PW_VERSION, stats, steps: Object.fromEntries(ONLY.map((n) => [n, extra(n)])) }, null, 1) + "\n");
say(`wrote ${join(RUN, "results.json")} and extra.json`);
server.close();
process.exit(0);
