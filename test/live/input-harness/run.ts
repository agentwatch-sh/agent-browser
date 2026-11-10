// The input harness (board ab-t30.2; design 2026-11-10-vanilla-playwright-human-input-design.md, section 13.3): it runs
// input scenarios on local pages, records what the page sees, and scores each gap of the design against a reference. Not
// part of `npm test` (its statistics are: test/input-harness.test.ts). Linux only, in a private Xvfb that it starts
// (display 169 by default), with Chromium processes of its own and local pages only.
//
//   node test/live/input-harness/run.ts --out-dir DIR [--playwright DIR] [--display 169] [--chrome /usr/bin/chromium]
//        [--only source,agent-browser,playwright] [--reference FILE]
//   node test/live/input-harness/run.ts --rescore DIR/run-XXXXXX/results.json [--reference FILE]
//
// The page is the input research's recorder (docs/research/2026-11-09-click-box-input-signals/recorder.html) on a local
// server (rec.localhost, with the click-box stand-in in a frame of box.localhost). The scenarios, each in its own
// Chromium on a new profile (removed at the scenario's end):
//   source         the design probe's `source` scenario (M1): the reference, real X input (XTEST: one `xdotool -` script
//                  for each step, at 125 Hz, with no CDP session on the page): paths with a press, paths into the box,
//                  a double click, a click with Shift, typing, wheel notches and a click below the fold; then M1's planned
//                  paths (its seed and width) as CDP moves at 125 Hz with no wait for each answer, in four forms of the
//                  `timestamp` (the send time in whole ms, 4 ms before the send in whole ms, fractional, none), and the
//                  design's form on XTEST's own three paths (cdp-4ms-same)
//   agent-browser  today's agent-browser input (src/input.ts) through its commands over the endpoint form (ws+unix://)
//   playwright     plain Playwright (playwright-core from --playwright DIR, a scratch folder: never in package.json)
//                  over connectOverCDP; skipped with a message when DIR has no playwright-core
// Each step has a source and a kind (measures.ts); the run measures every step, builds the reference from the XTEST
// steps (reference.ts) or reads --reference FILE (a person's numbers, later), and scores each source (score.ts). It
// writes DIR/run-XXXXXX/: results.json (the records: they hold the page's state, so they stay out of the repository),
// reference.json (numbers only), report.json and report.txt, and prints report.txt.
//
// Chromium runs with --remote-debugging-pipe; a small bridge serves the pipe as a WebSocket on a Unix socket in a short
// temporary folder of its own (removed at the end). Chromium opens no debugging port. No page of the network is
// reachable: the host resolver maps every host but the two local ones to nothing, and the proxy is a closed local port.
// One harness at a time and nothing left after its end (test/live/README.md): the harness guard; the run ends only the
// processes that it started, by their pids, and xdotool (its own and agent-browser's) reaches only its own display.

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
import { planMove, pointAt, seededRandom } from "../../../src/record.ts";
import { harnessGuard, reservedDisplay } from "../guard.ts";
import { measureStep, type Rec, type StepKind, type StepMark, type StepMeasures } from "./measures.ts";
import { buildReference, checkReference, type Reference } from "./reference.ts";
import { scoreSource, textTable, type Row } from "./score.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const RECORDER = join(HERE, "../../../docs/research/2026-11-09-click-box-input-signals/recorder.html");
const USAGE = "usage: node test/live/input-harness/run.ts --out-dir DIR [--playwright DIR] [--display 169] [--chrome /usr/bin/chromium] [--only source,agent-browser,playwright] [--reference FILE]\n"
  + "       node test/live/input-harness/run.ts --rescore RESULTS.json [--reference FILE]";
function refuse(message: string): never { process.stderr.write(`${message}\n`); process.exit(2); }
let values: Record<string, string | undefined>;
try {
  values = parseArgs({ options: { "out-dir": { type: "string" }, chrome: { type: "string" }, display: { type: "string" }, only: { type: "string" }, playwright: { type: "string" },
    reference: { type: "string" }, rescore: { type: "string" } } }).values;
} catch (e) { refuse(`${(e as Error).message}\n${USAGE}`); }

/** The sources in the report's order: the reference first. */
const ORDER = ["xtest", "cdp-4ms", "cdp-4ms-same", "cdp-send", "cdp-frac", "cdp-none", "agent-browser", "playwright"];
type Scenario = { t0: number; t1: number; notes?: unknown; error?: string; marks: StepMark[]; recs: Rec[] };
type Results = { chrome?: string; display?: number; playwright?: string | null; scenarios: Record<string, Scenario> };

/** Measure every step, take the reference (a file, or the run's XTEST steps), and score each source. */
function scoreRun(out: Results, referenceFile?: string): { reference: Reference; scored: Record<string, Row[]>; steps: Record<string, StepMeasures[]> } {
  const steps: Record<string, StepMeasures[]> = {};
  for (const sc of Object.values(out.scenarios)) for (const m of sc.marks) (steps[m.source] ??= []).push(measureStep(sc.recs, m));
  const reference = referenceFile ? checkReference(JSON.parse(readFileSync(referenceFile, "utf8"))) : buildReference(steps.xtest ?? []);
  const names = Object.keys(steps).sort((a, b) => (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99));
  return { reference, scored: Object.fromEntries(names.map((n) => [n, scoreSource(steps[n], reference)])), steps };
}

function writeReport(dir: string, out: Results, referenceFile?: string): string {
  const { reference, scored, steps } = scoreRun(out, referenceFile);
  const failed = Object.values(out.scenarios).flatMap((sc) => sc.marks.filter((m) => !m.ok).map((m) => `${m.source}: ${m.name}: ${m.error}`));
  const errors = Object.entries(out.scenarios).filter(([, sc]) => sc.error).map(([n, sc]) => `${n}: ${sc.error!.split("\n")[0]}`);
  writeFileSync(join(dir, "reference.json"), JSON.stringify(reference, null, 1) + "\n");
  writeFileSync(join(dir, "report.json"), JSON.stringify({ chrome: out.chrome, playwright: out.playwright, display: out.display, referenceFile: referenceFile ? "given" : "the run's XTEST steps",
    failedSteps: failed, scenarioErrors: errors, sources: scored, steps }, null, 1) + "\n");
  const text = textTable(scored) + (failed.length ? `\nsteps that failed:\n${failed.map((f) => `  ${f}`).join("\n")}\n` : "") + (errors.length ? `\nscenario errors:\n${errors.map((f) => `  ${f}`).join("\n")}\n` : "");
  writeFileSync(join(dir, "report.txt"), text);
  return text;
}

if (values.rescore) {
  const file = resolve(values.rescore);
  process.stdout.write(writeReport(dirname(file), JSON.parse(readFileSync(file, "utf8")) as Results, values.reference && resolve(values.reference)));
  process.exit(0);
}

if (!values["out-dir"]) refuse(USAGE);
if (process.platform !== "linux") refuse(`linux only, in a private Xvfb (this is ${process.platform})`);
const CHROME = values.chrome ?? "/usr/bin/chromium", DISPLAY = Number(values.display ?? 169);
if (!Number.isInteger(DISPLAY) || DISPLAY < 1) refuse("--display is a positive whole number");
const reserved = reservedDisplay(DISPLAY, "--display");
if (reserved) refuse(reserved);
const ALL = ["source", "agent-browser", "playwright"];
let ONLY = values.only ? values.only.split(",") : ALL;
for (const n of ONLY) if (!ALL.includes(n)) refuse(`no scenario ${n}; known: ${ALL.join(", ")}`);
const REFERENCE_FILE = values.reference ? resolve(values.reference) : undefined;
if (REFERENCE_FILE) {
  try { checkReference(JSON.parse(readFileSync(REFERENCE_FILE, "utf8"))); } catch (e) { refuse(`--reference ${REFERENCE_FILE}: ${(e as Error).message}`); }
} else if (!ONLY.includes("source")) refuse("with no --reference FILE, the run needs the source scenario: its XTEST steps are the reference");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const now = () => Math.round((performance.timeOrigin + performance.now()) * 1000) / 1000;
const say = (line: string) => process.stderr.write(`${new Date().toISOString().slice(11, 23)} ${line}\n`);
const PW_DIR = values.playwright ? resolve(values.playwright) : undefined;
let PW_VERSION: string | null = null;
if (ONLY.includes("playwright")) {
  try { PW_VERSION = JSON.parse(readFileSync(join(PW_DIR ?? "", "node_modules/playwright-core/package.json"), "utf8")).version; } catch { /* below */ }
  if (!PW_VERSION) {
    say(`playwright: skipped: no playwright-core in ${PW_DIR ? `${PW_DIR}/node_modules` : "a folder (no --playwright DIR)"}. Install it in a scratch folder, never in package.json: `
      + "mkdir -p DIR && cd DIR && npm init -y && npm install --ignore-scripts playwright-core@1.65.0; then pass --playwright DIR");
    ONLY = ONLY.filter((n) => n !== "playwright");
  }
}
if (!ONLY.length) refuse("no scenario left to run");
const OUT = resolve(values["out-dir"]!);
mkdirSync(OUT, { recursive: true });
const RUN = mkdtempSync(join(OUT, "run-"));
const SOCKS = mkdtempSync(join(tmpdir(), "abih-"));
process.on("exit", () => rmSync(SOCKS, { recursive: true, force: true }));

// ------------------------------------------------------------------ Xvfb (own display, own X authority)
const field = (b: Buffer) => { const n = Buffer.alloc(2); n.writeUInt16BE(b.length); return Buffer.concat([n, b]); };
const xauth = join(RUN, "Xauthority");
writeFileSync(xauth, Buffer.concat([Buffer.from([0xff, 0xff]), field(Buffer.alloc(0)), field(Buffer.from(String(DISPLAY))),
  field(Buffer.from("MIT-MAGIC-COOKIE-1")), field(randomBytes(16))]), { mode: 0o600 });
const children: ChildProcess[] = [];
process.on("exit", () => { for (const c of children.reverse()) if (c.exitCode === null && c.signalCode === null) c.kill("SIGTERM"); });
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => process.exit(130));
const harness = await harnessGuard("input-harness");
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
      try { const list = JSON.parse(body) as Rec[]; (recs[scenarioName] ??= []).push(...list); } catch { /* a broken beacon */ }
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

// ------------------------------------------------------------------ the page's layout, the screen, X input
type Pt = { x: number; y: number };
const own = () => recs[scenarioName] ?? [];
const lastOf = (e: string, f = "top") => own().filter((r) => r.e === e && (r.f ?? "top") === f).at(-1) as Record<string, any> | undefined;
async function loaded(ms = 15_000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (lastOf("layout") && lastOf("state", "box")) return;
  throw new Error("the recorder page (or its box) did not load");
}
const rectOf = (id: string) => { const r = lastOf("layout")?.r?.[id] as number[] | undefined; if (!r) throw new Error(`no layout for ${id}`); return r; };
/** The middle of an element (client CSS px), from the page's latest layout record. */
const centre = (id: string, dx = 0.5, dy = 0.5): Pt => { const r = rectOf(id); return { x: r[0] + r[2] * dx, y: r[1] + r[3] * dy }; };
/** The element's smaller side: Fitts's width. */
const widthOf = (id: string) => { const r = rectOf(id); return Math.round(Math.min(r[2], r[3])); };
/** The box's square (#cb at 16,20, 24 px, in the box's page) in the top page's client px. */
const boxSquare = (): Pt => { const b = rectOf("box"); return { x: b[0] + 28, y: b[1] + 32 }; };
/** The page's content origin on the screen (Chrome draws its own frame: no window manager on this Xvfb). */
function origin(): Pt {
  const g = lastOf("state")!;
  const side = Math.round((g.ow - g.iw) / 2);
  return { x: g.wx + side, y: g.wy + g.oh - g.ih - side };
}
const xdo = (args: string[], input?: string) => execFileSync("xdotool", args, { env: XENV, encoding: "utf8", timeout: 30_000, ...(input !== undefined ? { input } : {}) }).trim();
function chromeWindow(pid: number, title = "Input recorder"): string {
  for (const id of xdo(["search", "--onlyvisible", "--pid", String(pid)]).split("\n").filter(Boolean)) {
    try { if (xdo(["getwindowname", id]).startsWith(title)) return id; } catch { /* gone */ }
  }
  throw new Error(`no window titled "${title}"`);
}
/** The X pointer in the page's client px. */
const xPointer = (): Pt => { const v = Object.fromEntries(xdo(["getmouselocation", "--shell"]).split("\n").map((l) => l.split("="))); const o = origin(); return { x: Number(v.X) - o.x, y: Number(v.Y) - o.y }; };
/** A client point as the X screen's two coordinates (xdotool's arguments). */
const xAt = (p: Pt): [string, string] => { const o = origin(); return [String(Math.round(o.x + p.x)), String(Math.round(o.y + p.y))]; };

// ------------------------------------------------------------------ marks and steps
const marks: Record<string, StepMark[]> = {};
async function step(source: string, kind: StepKind, name: string, fn: () => Promise<unknown>, o: { width?: number; limitMs?: number; settle?: number } = {}): Promise<void> {
  const t0 = now(), limit = o.limitMs ?? 20_000;
  let ok = true, error: string | undefined;
  let timer: NodeJS.Timeout | undefined;
  try { await Promise.race([fn(), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`no end in ${limit / 1000} s`)), limit); })]); }
  catch (e) { ok = false; error = String((e as Error).message ?? e).split("\n")[0].slice(0, 240); }
  finally { clearTimeout(timer); }
  const t1 = now();
  (marks[scenarioName] ??= []).push({ name, source, kind, ok, t0, t1, ...(o.width ? { width: o.width } : {}), ...(error ? { error } : {}) });
  say(`${source}: ${name} ${ok ? "ok" : `FAILED: ${error}`} (${Math.round(t1 - t0)} ms)`);
  await sleep(o.settle ?? 700);
}

// ------------------------------------------------------------------ the planned path (one generator: src/record.ts)
const SAMPLE_MS = 8; // a 125 Hz mouse
/** A path from `from` to `to` in whole px: planMove's legs (ghost-cursor's curve, Fitts's time, an overshoot past 500 px), one point each 8 ms, no point that does not move. */
async function plan(from: Pt, to: Pt, random: () => number, width: number): Promise<{ p: Pt; at: number }[]> {
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
/** The lines of one `xdotool -` script that plays a path. */
function pathLines(pts: { p: Pt; at: number }[]): string[] {
  const lines: string[] = [];
  let t = 0;
  for (const { p, at } of pts) { lines.push(`sleep ${((at - t) / 1000).toFixed(3)}`, `mousemove ${xAt(p).join(" ")}`); t = at; }
  return lines;
}
const between = (random: () => number, a: number, b: number) => a + (b - a) * random();
const press = (holdMs: number, pauseMs = 150) => [`sleep ${(pauseMs / 1000).toFixed(3)}`, "mousedown 1", `sleep ${(holdMs / 1000).toFixed(3)}`, "mouseup 1"];
const script = (lines: string[]) => xdo(["-"], lines.join("\n") + "\n");
const TEXT = "Hello World, OK!";

// ------------------------------------------------------------------ Chromium over a pipe, and the bridge
const BASE_ARGS = ["--remote-debugging-pipe", "--no-first-run", "--no-default-browser-check", "--ozone-platform=x11", "--password-store=basic",
  "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-default-apps", "--disable-backgrounding-occluded-windows",
  "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE rec.localhost , EXCLUDE box.localhost", "--proxy-server=http://127.0.0.1:9",
  "--proxy-bypass-list=rec.localhost;box.localhost", "--window-position=0,0", "--window-size=1280,1000"];
type Client = { ws: WebSocket; sessions: Set<string> };
class Chromium {
  readonly proc: ChildProcess;
  readonly dir: string;
  readonly sock: string;
  readonly cdpUrl: string;
  private buf = "";
  private next = 1;
  private pending = new Map<number, { c?: Client; id: number; method: string }>();
  private owner = new Map<string, Client>();
  private clients = new Set<Client>();
  private autoAttacher?: Client;
  private wss?: WebSocketServer;
  private http = createServer();
  constructor(name: string, urls: string[]) {
    // The scenario's own temporary profile: stop() removes it.
    this.dir = join(RUN, `profile-${name}`);
    mkdirSync(this.dir, { recursive: true });
    const fd = openSync(join(RUN, `chrome-${name}.log`), "a");
    this.proc = spawn(CHROME, [...BASE_ARGS, `--user-data-dir=${this.dir}`, ...urls], { env: XENV, stdio: ["ignore", fd, fd, "pipe", "pipe"] });
    children.push(this.proc);
    harness.track(this.proc.pid, "Chromium");
    // agent-browser takes agent mode's endpoint form only (ws+unix://); the run folder's path is too long for a socket.
    this.sock = join(SOCKS, `${name}.sock`);
    this.cdpUrl = `ws+unix://${this.sock}:/devtools/browser/harness`;
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
    this.toChrome({ ...m, id: gid });
  }
  private fromChrome(raw: string) {
    const m = JSON.parse(raw);
    if (typeof m.id === "number") {
      const p = this.pending.get(m.id);
      this.pending.delete(m.id);
      if (!p?.c) return;
      if (p.method === "Target.attachToTarget" && m.result?.sessionId) { this.owner.set(m.result.sessionId, p.c); p.c.sessions.add(m.result.sessionId); }
      if (p.c.ws.readyState === WebSocket.OPEN) p.c.ws.send(JSON.stringify({ ...m, id: p.id }));
      return;
    }
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
    rmSync(this.dir, { recursive: true, force: true }); // the scenario's own temporary profile goes with its Chrome
  }
}
async function startChrome(name: string, urls: string[]): Promise<Chromium> {
  const c = new Chromium(name, urls);
  await c.listen();
  return c;
}
/** A tiny CDP client over the bridge (no Playwright): the CDP forms' own calls. */
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

// ------------------------------------------------------------------ the scenarios
const SCENARIOS: Record<string, () => Promise<Record<string, unknown>>> = {
  // ---------------------------------------------------------------- the reference (XTEST) and M1's CDP forms
  async source() {
    const c = await startChrome("source", [REC_URL("source")]);
    try {
      await loaded();
      const win = chromeWindow(c.proc.pid!);
      xdo(["windowraise", win]); xdo(["windowfocus", win]); await sleep(500);
      // M1's random stream (the design probe's source scenario: seed 306, planMove with a width of 24 px), for M1's paths only:
      // its three XTEST paths, then the three paths of each CDP form. The other XTEST steps take a stream of their own.
      const m1 = seededRandom(306), random = seededRandom(3062);
      const starts: Pt[] = [{ x: 900, y: 700 }, { x: 760, y: 560 }, { x: 980, y: 380 }], ids = ["b", "hov", "chk"];
      xdo(["mousemove", ...xAt({ x: 900, y: 700 })]); await sleep(400);
      await step("xtest", "idle", "x: idle 2 s", () => sleep(2000));
      const m1Paths: { p: Pt; at: number }[][] = [];
      for (let round = 0; round < 2; round++) {
        for (let i = 0; i < 3; i++) {
          // Every reference path is planned as M1's (a width of 24 px), as the CDP forms' paths are: a faster plan (the target's own
          // width) gives more predicted points (run 2 of this task: 2.53 to 2.68 on #b), and the bar compares the same kind of paths.
          const w = widthOf(ids[i]), pts = await plan(starts[i], centre(ids[i]), round === 0 ? m1 : random, 24);
          if (round === 0) m1Paths.push(pts);
          xdo(["mousemove", ...xAt(starts[i])]); await sleep(400);
          await step("xtest", "click", `x: ${round === 0 ? "M1's " : ""}path at 125 Hz to #${ids[i]} (${pts.length} moves), press 90 ms`, async () => script([...pathLines(pts), ...press(90)]), { width: w });
        }
      }
      for (const from of [{ x: 900, y: 520 }, { x: 260, y: 400 }]) {
        const pts = await plan(from, boxSquare(), random, 24);
        xdo(["mousemove", ...xAt(from)]); await sleep(400);
        await step("xtest", "box", `x: path at 125 Hz into the box (${pts.length} moves), press 85 ms on its square`, async () => script([...pathLines(pts), ...press(85, 160)]), { width: 24 });
      }
      {
        const w = widthOf("b"), from = { x: 700, y: 640 }, pts = await plan(from, centre("b"), random, w);
        xdo(["mousemove", ...xAt(from)]); await sleep(400);
        await step("xtest", "dblclick", "x: path to #b, double click (gap 120 ms)", async () => script([...pathLines(pts), ...press(90), "sleep 0.120", "mousedown 1", "sleep 0.085", "mouseup 1"]), { width: w });
      }
      {
        const w = widthOf("b"), from = { x: 820, y: 600 }, pts = await plan(from, centre("b"), random, w);
        xdo(["mousemove", ...xAt(from)]); await sleep(400);
        await step("xtest", "modclick", "x: Shift down, path to #b, click, Shift up", async () => script(["keydown Shift_L", "sleep 0.080", ...pathLines(pts), ...press(90), "sleep 0.040", "keyup Shift_L"]), { width: w });
      }
      {
        const w = widthOf("f"), from = { x: 640, y: 520 }, pts = await plan(from, centre("f", 0.8), random, w);
        xdo(["mousemove", ...xAt(from)]); await sleep(400);
        await step("xtest", "type", `x: path to #f, press, xdotool type --delay 120 '${TEXT}'`, async () => { script([...pathLines(pts), ...press(80)]); await sleep(300); xdo(["type", "--delay", "120", TEXT]); }, { width: w });
      }
      const notches = (button: 4 | 5, n: number) => {
        const lines: string[] = [];
        // A notch is a press and a release of button 4 or 5 (xdotool's `click` adds about 100 ms to each one).
        for (let i = 0; i < n; i++) { lines.push(`mousedown ${button}`, `mouseup ${button}`); if (i < n - 1) lines.push(`sleep ${(between(random, 35, 90) / 1000).toFixed(3)}`); }
        script(lines);
      };
      {
        const pts = await plan(xPointer(), { x: 600, y: 600 }, random, 40);
        script(pathLines(pts)); await sleep(400);
        await step("xtest", "wheel", "x: 8 wheel notches down (gaps 35 to 90 ms)", async () => { notches(5, 8); await sleep(400); });
        await step("xtest", "wheel", "x: 8 wheel notches up", async () => { notches(4, 8); await sleep(400); });
      }
      await step("xtest", "far", "x: wheel notches until #far is in view, then a path and a press", async () => {
        for (let i = 0; i < 30; i++) {
          const far = rectOf("far"), ih = lastOf("layout")!.ih as number;
          if (far[1] > 100 && far[1] < ih - 100) break;
          notches(5, 3); await sleep(400);
        }
        const pts = await plan(xPointer(), centre("far"), random, widthOf("far"));
        script([...pathLines(pts), ...press(80)]);
      }, { width: 40, limitMs: 40_000 });
      // CDP: M1's planned paths in four forms of the timestamp, with no CDP session on the page before now; then the design's
      // form (whole ms, 4 ms early) on XTEST's own three paths of M1, for a comparison path by path.
      xdo(["mousemove", "1900", "1060"]); await sleep(300); // the X pointer leaves the window: no real event comes into the page
      const cdp = await rawCdp(c.cdpUrl);
      const page = ((await cdp.send("Target.getTargets")).targetInfos as { targetId: string; type: string; url: string }[]).find((t) => t.type === "page" && t.url.includes("recorder.html"))!;
      const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
      const send = (mth: string, p: object) => cdp.send(mth, p, sessionId);
      await send("Runtime.evaluate", { expression: "scrollTo(0, 0)" }); await sleep(600);
      const mv = (p: Pt, extra: object = {}) => send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y, button: "none", buttons: 0, ...extra });
      const variants: [string, string, () => object][] = [
        ["cdp-send", "timestamp of the send in whole ms", () => ({ timestamp: Date.now() / 1000 })],
        ["cdp-4ms", "timestamp in whole ms, 4 ms before the send", () => ({ timestamp: (Date.now() - 4) / 1000 })],
        ["cdp-frac", "fractional timestamp", () => ({ timestamp: (performance.timeOrigin + performance.now()) / 1000 })],
        ["cdp-none", "no timestamp", () => ({})],
      ];
      variants.push(["cdp-4ms-same", "timestamp in whole ms, 4 ms before the send, XTEST's own path", variants[1][2]]);
      for (const [source, label, extra] of variants) {
        for (let i = 0; i < 3; i++) {
          const w = widthOf(ids[i]), pts = source === "cdp-4ms-same" ? m1Paths[i] : await plan(starts[i], centre(ids[i]), m1, 24);
          await mv(starts[i]); await sleep(400);
          await step(source, "click", `cdp: path at 125 Hz, not awaited, ${label}, to #${ids[i]} (${pts.length} moves), press 90 ms`, async () => {
            const t0 = performance.now(), sent: Promise<unknown>[] = [];
            for (const { p, at } of pts) { await sleep(t0 + at - performance.now()); sent.push(mv(p, extra())); }
            await Promise.all(sent);
            await sleep(150);
            const end = pts[pts.length - 1].p;
            await send("Input.dispatchMouseEvent", { type: "mousePressed", x: end.x, y: end.y, button: "left", buttons: 1, clickCount: 1, force: 0.5, ...extra() });
            await sleep(90);
            await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: end.x, y: end.y, button: "left", buttons: 0, clickCount: 1, ...extra() });
          }, { width: w });
        }
      }
      cdp.close();
      return {};
    } finally { await c.stop(); }
  },

  // ---------------------------------------------------------------- today's agent-browser input (src/input.ts)
  async "agent-browser"() {
    const c = await startChrome("agent-browser", [`http://rec.localhost:${PORT}/blank.html`]);
    const stateDir = join(RUN, "state-agent-browser");
    try {
      const o: BrowserOptions = { stateDir, cdpUrl: c.cdpUrl, allow: ["rec.localhost", "box.localhost"], commandName: "input harness",
        log: (l) => say(/^agent-browser\b/.test(l) ? l : `agent-browser: ${l}`) };
      await sleep(1500);
      xdo(["mousemove", "900", "700"]);
      await commands.open(o, { url: REC_URL("agent-browser"), name: "rec" });
      await loaded();
      // The blank page's window comes back over the recorder's, as another agent's or the operator's window: agent-browser's
      // first input then brings the recorder's window forward (Page.bringToFront), and the real pointer event of that
      // activation lets it verify its display and use the X pointer (src/input.ts, Hands.begin).
      const blank = chromeWindow(c.proc.pid!, "blank");
      xdo(["windowraise", blank]); xdo(["windowfocus", blank]); await sleep(500);
      const ids = ["b", "chk", "hov"];
      await step("agent-browser", "idle", "idle 2 s", () => sleep(2000));
      for (let round = 0; round < 2; round++) {
        for (const id of ids) {
          if (id === "hov") await step("agent-browser", "hover", `hover #${id}`, () => commands.hover(o, { tab: "rec", target: `#${id}` }), { width: widthOf(id) });
          else await step("agent-browser", "click", `click #${id}`, () => commands.click(o, { tab: "rec", target: `#${id}` }), { width: widthOf(id) });
        }
      }
      for (let i = 0; i < 2; i++) {
        await step("agent-browser", "box", "clickAt the box's square (library Tab.clickAt)", async () => {
          const b = await AgentBrowser.connect(o);
          try { const tab = await b.find("rec"); const p = boxSquare(); await tab.clickAt(p.x, p.y); } finally { await b.disconnect().catch(() => {}); }
        }, { width: 24 });
        // The box's check box toggles; a move away lets the next path enter the box again.
        await step("agent-browser", "click", "click #b", () => commands.click(o, { tab: "rec", target: "#b" }), { width: widthOf("b") });
      }
      await step("agent-browser", "type", `type --into #f '${TEXT}'`, () => commands.type(o, { tab: "rec", text: TEXT, into: "#f" }), { width: widthOf("f") });
      await step("agent-browser", "far", "click #far (the wheel brings it into view)", () => commands.click(o, { tab: "rec", target: "#far" }), { width: 40, limitMs: 30_000 });
      return {};
    } finally {
      await c.stop();
      rmSync(stateDir, { recursive: true, force: true }); // agent-browser's state folder of this run
    }
  },

  // ---------------------------------------------------------------- plain Playwright over CDP
  async playwright() {
    const pw = createRequire(join(PW_DIR!, "package.json"))("playwright-core");
    const c = await startChrome("playwright", [REC_URL("playwright")]);
    let browser: any;
    try {
      await loaded();
      const win = chromeWindow(c.proc.pid!);
      xdo(["windowraise", win]); xdo(["windowfocus", win]); await sleep(500);
      xdo(["mousemove", "1900", "1060"]); await sleep(300); // the X pointer outside the window: Playwright's input is CDP only
      browser = await pw.chromium.connectOverCDP(c.cdpUrl, { timeout: 15_000 });
      const page = browser.contexts()[0].pages().find((p: any) => p.url().includes("recorder.html"));
      if (!page) throw new Error("Playwright sees no recorder page");
      const t = { timeout: 8000 };
      await step("playwright", "idle", "idle 2 s", () => sleep(2000));
      for (let round = 0; round < 2; round++) {
        await step("playwright", "click", "locator('#b').click()", () => page.locator("#b").click(t), { width: widthOf("b") });
        await step("playwright", "click", "locator('#chk').click()", () => page.locator("#chk").click(t), { width: widthOf("chk") });
        await step("playwright", "hover", "locator('#hov').hover()", () => page.locator("#hov").hover(t), { width: widthOf("hov") });
      }
      await step("playwright", "move", "mouse.move(700, 600, { steps: 20 })", () => page.mouse.move(700, 600, { steps: 20 }));
      for (let i = 0; i < 2; i++) {
        await step("playwright", "box", "frameLocator('#box').locator('#cb').click()", () => page.frameLocator("#box").locator("#cb").click(t), { width: 24 });
        await step("playwright", "click", "locator('#b').click()", () => page.locator("#b").click(t), { width: widthOf("b") });
      }
      await step("playwright", "dblclick", "locator('#b').dblclick()", () => page.locator("#b").dblclick(t), { width: widthOf("b") });
      await step("playwright", "modclick", "locator('#b').click({ modifiers: ['Shift'] })", () => page.locator("#b").click({ ...t, modifiers: ["Shift"] }), { width: widthOf("b") });
      await step("playwright", "type", `locator('#f').click(); keyboard.type('${TEXT}')`, async () => { await page.locator("#f").click(t); await page.keyboard.type(TEXT); }, { width: widthOf("f") });
      await step("playwright", "type", "locator('#ta').pressSequentially('Meet me at 10:45.') (no focus)", () => page.locator("#ta").pressSequentially("Meet me at 10:45.", t));
      await step("playwright", "fill", "locator('#f').fill('jane.doe@example.com') (no focus)", () => page.locator("#f").fill("jane.doe@example.com", t));
      await step("playwright", "wheel", "mouse.wheel(0, 600)", async () => { await page.mouse.wheel(0, 600); await sleep(500); });
      await step("playwright", "wheel", "mouse.wheel(0, -600)", async () => { await page.mouse.wheel(0, -600); await sleep(500); });
      await step("playwright", "drag", "locator('#drag').dragTo(locator('#drop'))", () => page.locator("#drag").dragTo(page.locator("#drop"), t));
      await step("playwright", "far", "locator('#far').click() (below the fold)", () => page.locator("#far").click(t), { width: 40 });
      return { playwright: PW_VERSION };
    } finally {
      await browser?.close().catch(() => {});
      await c.stop();
    }
  },
};

// ------------------------------------------------------------------ run
const product = execFileSync(CHROME, ["--version"], { encoding: "utf8" }).trim();
const out: Results & { screen: typeof SCREEN } = { chrome: product, display: DISPLAY, screen: SCREEN, playwright: PW_VERSION, scenarios: {} };
for (const name of ONLY) {
  scenarioName = name;
  say(`--- ${name}`);
  let notes: Record<string, unknown> = {}, error: string | undefined;
  const t0 = now();
  try { notes = await SCENARIOS[name](); }
  catch (e) { error = String((e as Error).stack ?? e).slice(0, 600); say(`${name}: ERROR ${error}`); }
  await sleep(500);
  out.scenarios[name] = { t0, t1: now(), notes, error, marks: marks[name] ?? [], recs: recs[name] ?? [] };
}
writeFileSync(join(RUN, "results.json"), JSON.stringify(out) + "\n");
let text: string;
try { text = writeReport(RUN, out, REFERENCE_FILE); } catch (e) { say(`the score failed: ${(e as Error).message}`); server.close(); process.exit(1); }
process.stdout.write(text);
say(`wrote ${join(RUN, "results.json")}, reference.json, report.json and report.txt`);
server.close();
process.exit(0);
