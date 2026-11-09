// The anti-detect drive measurement (board task ab-v16.21; docs/research/2026-11-05-anti-detect-drive.md).
// Not part of `npm test`. Linux only, in a private Xvfb that it starts, with Chromium processes of its own.
//
//   node test/live/anti-detect/run.ts --out-dir DIR [--chrome /usr/bin/chromium] [--display 121]
//        [--only NAME,NAME] [--playwright DIR]   (DIR: a folder whose node_modules has playwright-core)
//
// What a site can see when a page that is not in front is driven, against what it sees of a person.
// Each scenario starts its own Chromium (a new profile in DIR/run-XXXXXX), driven through
// --remote-debugging-pipe by a small bridge (a WebSocket server on a Unix socket in the run folder; it
// detaches a client's sessions when the client leaves, as agent-browser's proxy and the relay do). No
// debugging port is opened. agent-browser's own commands reach that bridge through cdpUrl, so they send
// what they send through the proxy or the relay. A person is xdotool (XTest input through the X server,
// as from a real mouse and keyboard). Xvfb has no window manager, so where a person's window manager
// would raise and focus a window that the person clicks, the script raises and focuses it with xdotool.
//
// Two probe pages: F (the page in front: the operator's tab, or another agent's) and T (the page that is
// driven). probe.ts logs every signal of each page with timestamps. The scenarios (see SCENARIOS):
//   person-front, person-tab, person-window         baselines: no CDP message at all for these pages
//   default, hidden-drive                           agent-browser's old modes (focus emulation on attach / Tab.whileDrawn), through
//                                                   the gate's fallback (display: { own: false }): through cdpUrl every page is a
//                                                   window page, also with open --tab; activate and emulate-input too
//   ab-window                                       agent-browser's own open on Linux (ab-v16.26): a window of its own, no focus emulation
//   design, design-no-x                             the whole design with agent-browser's real commands (ab-v16.26): a window of its own,
//                                                   activation, a person's input, the input lock; F's window takes the focus after each
//                                                   input step, so T's window comes forward again for each one (several activations).
//                                                   design-no-x cannot reach the X pointer (as over agentwatch's relay)
//   design-two                                      the design with two agents at once on one site (two windows, one input lock),
//                                                   each typing 6 times, then a third agent on the first page's site
//   design-two-sites                                the same with the two pages on two sites (probe.localhost, other.localhost): they
//                                                   share the one input lock (ab-1bi). At e52de19 (one lock per site, ab-v16.46)
//                                                   both typed at once: the numbers of the README's "One input at a time"
//   person-window-multi                             the person baseline for several activations: F's window takes the focus after each step
//   window, window-no-flag, window-default          one window per agent page (candidate 1); window-default sends the old
//                                                   attach's focus emulation itself around each command
//   window-activate                                 one window per page, Target.activateTarget on it for each input command
//   activate                                        Target.activateTarget for each input command, then back (2)
//   emulate-input                                   focus emulation only around each input command (3)
//   pw-default, pw-no-defaults, pw-filtered         Playwright behind the bridge: its own focus emulation,
//                                                   noDefaults: true, or the bridge answers it without sending it (5)
//   pw-window-filtered                              the filter, and each new page in a window of its own (5 with 1)
//   xfocus-cdp, xfocus-xinput                       one window per page, the X focus moved to it, CDP or X input (6)
//   window-human-cdp                                one window per page, Target.activateTarget, person-like CDP input (6)
//   window-keys-inactive                            one window per page: keys into it after another window took the focus
// Since ab-v16.26 agent-browser's own commands drive a page in a window of its own as the design says (activation, a
// person's input, the input lock), so the window*, xfocus-cdp and window-keys-inactive scenarios no longer measure
// the old input in a window: the research's appendix holds those rows. The old modes stay behind open --tab.
// It writes DIR/run-XXXXXX/results.json (every record and every step) and steps.md, and prints the
// tables of report.ts. Exit 0 when every scenario ran (a step may fail: a failed step is a measurement),
// 1 when a scenario could not run (its error is in its notes), 2 on a start problem.
// It ends only its own children (by the pids it recorded) and never connects to a Chrome it did not start.

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { parseArgs } from "node:util";
import WebSocket, { WebSocketServer } from "ws";
import { AgentBrowser } from "../../../src/browser.ts";
import { CDPConnection } from "../../../src/cdp.ts";
import { commands } from "../../../src/commands.ts";
import type { BrowserOptions } from "../../../src/options.ts";
import { bothFocusedMs, FAR, LAYOUT, pointerSignals, rates, startServer, stepSignals, visAt, type Rec } from "./probe.ts";
import { report } from "./report.ts";
import { harnessGuard, reservedDisplay } from "../guard.ts";

const { values } = parseArgs({ options: { "out-dir": { type: "string" }, chrome: { type: "string" }, display: { type: "string" }, only: { type: "string" }, playwright: { type: "string" } } });
function refuse(message: string): never { process.stderr.write(`${message}\n`); process.exit(2); }
if (!values["out-dir"]) refuse("usage: node test/live/anti-detect/run.ts --out-dir DIR [--chrome /usr/bin/chromium] [--display 121] [--only a,b] [--playwright DIR]");
if (process.platform !== "linux") refuse(`linux only, in a private Xvfb (this is ${process.platform})`);
const CHROME = values.chrome ?? "/usr/bin/chromium", DISPLAY = Number(values.display ?? 121);
if (!Number.isInteger(DISPLAY) || DISPLAY < 1) refuse("--display is a positive whole number");
const reserved = reservedDisplay(DISPLAY, "--display");
if (reserved) refuse(reserved);
const OUT = resolve(values["out-dir"]!);
mkdirSync(OUT, { recursive: true });
const RUN = mkdtempSync(join(OUT, "run-"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const say = (line: string) => process.stderr.write(`${new Date().toISOString().slice(11, 23)} ${line}\n`);

// ------------------------------------------------------------------ Xvfb (own display, own X authority)
const field = (b: Buffer) => { const n = Buffer.alloc(2); n.writeUInt16BE(b.length); return Buffer.concat([n, b]); };
const xauth = join(RUN, "Xauthority");
writeFileSync(xauth, Buffer.concat([Buffer.from([0xff, 0xff]), field(Buffer.alloc(0)), field(Buffer.from(String(DISPLAY))),
  field(Buffer.from("MIT-MAGIC-COOKIE-1")), field(randomBytes(16))]), { mode: 0o600 });
const children: ChildProcess[] = [];
process.on("exit", () => { for (const c of children.reverse()) if (c.exitCode === null) c.kill("SIGTERM"); });
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => process.exit(130));
// One live harness at a time, and nothing of this run after its end, also after a kill -9 (test/live/README.md).
const harness = await harnessGuard("anti-detect");
if (existsSync(`/tmp/.X11-unix/X${DISPLAY}`)) refuse(`display :${DISPLAY} is in use; pass --display N`);
const xvfb = spawn("Xvfb", [`:${DISPLAY}`, "-auth", xauth, "-nolisten", "tcp", "-screen", "0", "1600x1000x24"], { stdio: "ignore" });
children.push(xvfb);
harness.track(xvfb.pid, "Xvfb");
for (let i = 0; i < 50 && !existsSync(`/tmp/.X11-unix/X${DISPLAY}`) && xvfb.exitCode === null; i++) await sleep(100);
await sleep(300);
if (xvfb.exitCode !== null) refuse(`Xvfb did not start on :${DISPLAY}`);
const XENV: NodeJS.ProcessEnv = { ...process.env, DISPLAY: `:${DISPLAY}`, XAUTHORITY: xauth };
delete XENV.WAYLAND_DISPLAY; delete XENV.XDG_SESSION_TYPE;
// agent-browser's own commands reach the X pointer of this run's Xvfb (input.ts, xAccess): never another display.
process.env.DISPLAY = `:${DISPLAY}`; process.env.XAUTHORITY = xauth; delete process.env.WAYLAND_DISPLAY;
say(`Xvfb :${DISPLAY} pid ${xvfb.pid}; run folder ${RUN}`);

// ------------------------------------------------------------------ the probe server
const log: Rec[] = [];
const { server, port } = await startServer(log);
const BASE = `http://probe.localhost:${port}`, BASE2 = `http://other.localhost:${port}`; // two sites (design-two-sites)
const urlOf = (tab: string, base = BASE) => `${base}/p?tab=${tab}`;
const mark = (ev: string, extra: Record<string, unknown> = {}) => log.push({ t: Date.now(), tab: "driver", ev, ...extra });

// ------------------------------------------------------------------ Chromium over a pipe, and the bridge
const BASE_ARGS = ["--remote-debugging-pipe", "--no-first-run", "--no-default-browser-check", "--ozone-platform=x11", "--password-store=basic",
  "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-default-apps",
  "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE probe.localhost , EXCLUDE other.localhost", "--proxy-server=http://127.0.0.1:9",
  "--proxy-bypass-list=probe.localhost;other.localhost",
  "--window-position=0,0", "--window-size=1100,700"];

type Client = { ws: WebSocket; sessions: Set<string>; label: string };
class Chromium {
  readonly proc: ChildProcess;
  private buf = "";
  private next = 1;
  private pending = new Map<number, { c?: Client; id: number; method: string }>();
  private owner = new Map<string, Client>();
  private clients = new Set<Client>();
  private autoAttacher?: Client;
  /** When true, the bridge answers Emulation.setFocusEmulationEnabled itself and never sends it to Chromium. */
  filterFocus = false;
  /** When true, the bridge opens each Target.createTarget in a new window of its own (a relay that never makes a tab). */
  ownWindow = false;
  readonly counts: Record<string, number> = {};
  dropped = 0;
  readonly sock: string;
  readonly cdpUrl: string;
  private wss?: WebSocketServer;
  private http = createServer();

  readonly name: string;
  constructor(name: string, flags: string[], urls: string[]) {
    this.name = name;
    const dir = join(RUN, `profile-${name}`);
    mkdirSync(dir, { recursive: true });
    const fd = openSync(join(RUN, `chrome-${name}.log`), "a");
    this.proc = spawn(CHROME, [...BASE_ARGS, `--user-data-dir=${dir}`, ...flags, ...urls], { env: XENV, stdio: ["ignore", fd, fd, "pipe", "pipe"] });
    children.push(this.proc);
    harness.track(this.proc.pid, "Chromium");
    const read = this.proc.stdio[4] as Readable;
    read.setEncoding("utf8");
    read.on("data", (d: string) => {
      this.buf += d;
      for (let i; (i = this.buf.indexOf("\0")) >= 0;) { const m = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1); this.fromChrome(m); }
    });
    this.sock = join(RUN, `${name}.sock`);
    this.cdpUrl = `ws+unix://${this.sock}:/devtools/browser/probe`;
  }

  async listen(): Promise<void> {
    this.wss = new WebSocketServer({ server: this.http, perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
    this.wss.on("connection", (ws, req) => {
      const c: Client = { ws, sessions: new Set(), label: String(req.headers["user-agent"] ?? "client") };
      this.clients.add(c);
      ws.on("message", (data) => this.fromClient(c, String(data)));
      ws.on("close", () => this.leave(c));
    });
    await new Promise<void>((r) => this.http.listen(this.sock, r));
  }

  private toChrome(m: object) { (this.proc.stdio[3] as Writable).write(JSON.stringify(m) + "\0"); }

  private fromClient(c: Client, raw: string) {
    const m = JSON.parse(raw);
    this.counts[m.method] = (this.counts[m.method] ?? 0) + 1;
    if (m.method === "Emulation.setFocusEmulationEnabled") mark("cdp-focus-emulation", { enabled: m.params?.enabled, chrome: this.name });
    if (this.filterFocus && m.method === "Emulation.setFocusEmulationEnabled") {
      this.dropped++;
      c.ws.send(JSON.stringify({ id: m.id, result: {}, ...(m.sessionId ? { sessionId: m.sessionId } : {}) }));
      return;
    }
    if (this.ownWindow && m.method === "Target.createTarget") m.params = { ...m.params, newWindow: true, background: true };
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

  /** A client left: its root sessions detach (that ends its focus emulation), and its auto-attach ends. */
  private leave(c: Client) {
    this.clients.delete(c);
    for (const s of c.sessions) { this.pending.set(this.next, { id: 0, method: "detach" }); this.toChrome({ id: this.next++, method: "Target.detachFromTarget", params: { sessionId: s } }); }
    if (this.autoAttacher === c) {
      this.autoAttacher = undefined;
      this.pending.set(this.next, { id: 0, method: "x" }); this.toChrome({ id: this.next++, method: "Target.setAutoAttach", params: { autoAttach: false, waitForDebuggerOnStart: false, flatten: true } });
      this.pending.set(this.next, { id: 0, method: "x" }); this.toChrome({ id: this.next++, method: "Target.setDiscoverTargets", params: { discover: false } });
    }
  }

  async stop(): Promise<void> {
    this.wss?.close(); this.http.close();
    if (this.proc.exitCode === null) {
      this.proc.kill("SIGTERM");
      for (let i = 0; i < 50 && this.proc.exitCode === null; i++) await sleep(100);
    }
    if (this.proc.exitCode === null) { // our own child, by its pid: never a Chrome that this script did not start
      this.proc.kill("SIGKILL");
      for (let i = 0; i < 20 && this.proc.exitCode === null; i++) await sleep(100);
    }
  }
}

// ------------------------------------------------------------------ xdotool: the person's hands, and the stand-in window manager
const xdo = (...args: string[]) => execFileSync("xdotool", args, { env: XENV, encoding: "utf8", timeout: 5000 }).trim();
function windowOf(pid: number, tab: string): string {
  for (const id of xdo("search", "--onlyvisible", "--pid", String(pid)).split("\n").filter(Boolean)) {
    try { if (xdo("getwindowname", id).startsWith(`probe ${tab}`)) return id; } catch { /* gone */ }
  }
  throw new Error(`no window titled "probe ${tab}"`);
}
/** What a window manager does when a person clicks a window: raise it and give it the keyboard focus. */
async function raiseAndFocus(win: string) { xdo("windowraise", win); xdo("windowfocus", win); await sleep(300); }
/** The page's content origin on the screen, from its own geometry report (Chrome draws its own frame). */
function origin(tab: string): { x: number; y: number } {
  const g = log.filter((e) => e.tab === tab && (e.ev === "load" || e.ev === "geo")).at(-1) as Record<string, number> | undefined;
  if (!g) throw new Error(`no geometry from ${tab}`);
  const side = Math.round((g.ow - g.iw) / 2);
  return { x: g.sx + side, y: g.sy + g.oh - g.ih - side };
}
/** A person's pointer: a curved path of about 20 moves in about 350 ms, then a press of 70 ms. */
async function personMove(tab: string, pt: { x: number; y: number }) {
  const o = origin(tab), to = { x: o.x + pt.x, y: o.y + pt.y };
  const loc = Object.fromEntries(xdo("getmouselocation", "--shell").split("\n").map((l) => l.split("=")));
  const from = { x: Number(loc.X), y: Number(loc.Y) }, n = 20, bend = 40;
  for (let i = 1; i <= n; i++) {
    const s = i / n, e = s * s * s * (10 - 15 * s + 6 * s * s); // minimum jerk
    const x = from.x + (to.x - from.x) * e + Math.sin(Math.PI * s) * bend, y = from.y + (to.y - from.y) * e;
    xdo("mousemove", String(Math.round(i === n ? to.x : x)), String(Math.round(i === n ? to.y : y)));
    await sleep(14);
  }
}
/** The far button's top in T's viewport, from the page's latest scroll record (or from load, before any scroll). */
const farTop = (tab: string) => { const r = log.filter((e) => e.tab === tab && e.ev === "scroll").at(-1); return r ? Number(r.farTop) : FAR.pageY - 20; };
async function personClick(tab: string, pt: { x: number; y: number }) {
  await personMove(tab, pt);
  await sleep(120);
  xdo("mousedown", "1"); await sleep(70); xdo("mouseup", "1");
}

// ------------------------------------------------------------------ scenario frame
type Step = { name: string; t0: number; t1: number; ok: boolean; error?: string; detail?: unknown };
type Scenario = { name: string; what: string; chrome?: Chromium; steps: Step[]; tStart: number; tEnd?: number; notes: string[]; F: string; T: string };
const results: Scenario[] = [];
const loaded = async (tab: string, ms = 15_000) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (log.some((e) => e.tab === tab && e.ev === "load")) return; throw new Error(`page ${tab} did not load`); };
async function step(sc: Scenario, name: string, fn: () => Promise<unknown>, limitMs = 25_000): Promise<void> {
  await sleep(400);
  const t0 = Date.now();
  mark("step", { scenario: sc.name, name });
  let ok = true, error: string | undefined, detail: unknown;
  let timer: NodeJS.Timeout | undefined;
  try { detail = await Promise.race([fn(), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`no end in ${limitMs / 1000} s`)), limitMs); })]); }
  catch (e) { ok = false; error = String((e as Error).message ?? e).split("\n")[0].slice(0, 200); }
  finally { clearTimeout(timer); }
  const t1 = Date.now();
  sc.steps.push({ name, t0, t1, ok, ...(error ? { error } : {}), ...(detail && typeof detail === "object" && "detail" in (detail as object) ? { detail: (detail as { detail: unknown }).detail } : {}) });
  say(`${sc.name}: ${name} ${ok ? "ok" : `FAILED: ${error}`} (${t1 - t0} ms)`);
  await sleep(1600); // frames in the second after the step, and the hidden page's next batch
}
const idle = (sc: Scenario, name: string, ms: number) => step(sc, name, () => sleep(ms));

// The probe pages are F (in front) and T (driven); each scenario uses its own names, so that logs never mix.
let serial = 0;
function scenario(name: string, what: string): Scenario {
  serial++;
  const sc: Scenario = { name, what, steps: [], tStart: Date.now(), notes: [], F: `F${serial}`, T: `T${serial}` };
  results.push(sc);
  say(`--- ${name}: ${what}`);
  return sc;
}

/** agent-browser options for the bridge of `c` (agent mode's endpoint transport). */
const opts = (c: Chromium, hiddenDrive: boolean): BrowserOptions => ({
  stateDir: join(RUN, `state-${c.name}-${hiddenDrive ? "h" : "d"}`), cdpUrl: c.cdpUrl, allow: ["probe.localhost", "other.localhost"], hiddenDrive,
  // agent-browser's own lines start with its name already (review-45c: "agent-browser: agent-browser: ...").
  commandName: "anti-detect probe", log: (l) => say(/^agent-browser\b/.test(l) ? l : `agent-browser: ${l}`),
});

type Wrap = (fn: () => Promise<unknown>) => Promise<unknown>;
const plain: Wrap = (fn) => fn();

/** The agent's drive of T: the same commands in each agent scenario; `wrap` is the candidate's input wrapper. */
async function agentDrive(sc: Scenario, o: BrowserOptions, wrap: Wrap, opt: { shotWrap?: boolean; readWrap?: boolean } = {}) {
  const T = `tab=${sc.T}`;
  await idle(sc, "idle before", 3000);
  await step(sc, "text", () => (opt.readWrap ? wrap : plain)(() => commands.text(o, { tab: T })));
  await step(sc, "click", () => wrap(() => commands.click(o, { tab: T, target: "#b" })));
  await step(sc, "type", () => wrap(() => commands.type(o, { tab: T, text: "hello", into: "#f" })));
  await step(sc, "click below the fold", () => wrap(() => commands.click(o, { tab: T, target: "#far" })));
  await step(sc, "library: clickAt, waitFor a frame's content", () => wrap(async () => {
    const b = await AgentBrowser.connect(o);
    try {
      const tab = await b.find(T);
      await tab.clickAt(LAYOUT.rafButton.x, LAYOUT.rafButton.y);
      await tab.waitFor(() => document.getElementById("rd")!.textContent === "frames: 1", { timeoutMs: 5000, what: "the frame's content" });
    } finally { await b.disconnect().catch(() => {}); }
  }));
  await step(sc, "press End (scrolls to the lazy image)", () => wrap(() => commands.press(o, { tab: T, key: "End" })));
  await step(sc, "shot", () => (opt.shotWrap ? wrap : plain)(() => commands.shot(o, { tab: T, path: join(RUN, `${sc.name}.png`) })), 35_000); // main: agent-browser ends a hung shot at 30 s (ab-b84.17)
  const script = join(RUN, "record-steps.json");
  writeFileSync(script, JSON.stringify([{ wait: 1000 }]));
  await step(sc, "record 1 s", () => commands.record(o, { tab: T, out: join(RUN, `${sc.name}.mp4`), script, size: "640x360", fps: 30 }));
  await idle(sc, "idle after", 3000);
}

/**
 * The whole design (ab-v16.26) with agent-browser's own commands: the same steps as agentDrive, with no wrapper, and
 * after each input step F's window takes the focus again (the stand-in window manager's raise, as another agent or
 * the operator), so each input step brings T's window forward again.
 */
async function designDrive(sc: Scenario, o: BrowserOptions, wf: string) {
  const T = `tab=${sc.T}`, away = () => raiseAndFocus(wf);
  await idle(sc, "idle before", 3000);
  await step(sc, "text", () => commands.text(o, { tab: T }));
  await step(sc, "click", () => commands.click(o, { tab: T, target: "#b" }));
  await away();
  await step(sc, "type", () => commands.type(o, { tab: T, text: "hello", into: "#f" }));
  await away();
  await step(sc, "click below the fold", () => commands.click(o, { tab: T, target: "#far" }));
  await away();
  await step(sc, "library: clickAt, waitFor a frame's content", async () => {
    const b = await AgentBrowser.connect(o);
    try {
      const tab = await b.find(T);
      await tab.clickAt(LAYOUT.rafButton.x, LAYOUT.rafButton.y);
      await tab.waitFor(() => document.getElementById("rd")!.textContent === "frames: 1", { timeoutMs: 5000, what: "the frame's content" });
    } finally { await b.disconnect().catch(() => {}); }
  });
  await away();
  await step(sc, "press End (scrolls to the lazy image)", () => commands.press(o, { tab: T, key: "End" }));
  await away();
  await step(sc, "shot", () => commands.shot(o, { tab: T, path: join(RUN, `${sc.name}.png`) }), 35_000);
  const script = join(RUN, "record-steps.json");
  writeFileSync(script, JSON.stringify([{ wait: 1000 }]));
  await step(sc, "record 1 s", () => commands.record(o, { tab: T, out: join(RUN, `${sc.name}.mp4`), script, size: "640x360", fps: 30 }));
  await away();
  await idle(sc, "idle after", 3000);
}

/** A person's drive of T: switch to it (bring), click, type, the frame button, End, switch back (back). With `each`, the
 *  person switches to F after each step and back to T before the next one (several activations of T's window). */
async function personDrive(sc: Scenario, bring: () => Promise<void>, back: () => Promise<void>, each = false) {
  const again = async () => { if (each) { await back(); await sleep(400); await bring(); } };
  await idle(sc, "idle before", 3000);
  await step(sc, "bring T to the front", bring);
  await step(sc, "click", () => personClick(sc.T, LAYOUT.button));
  await again();
  await step(sc, "type", async () => { await personClick(sc.T, LAYOUT.field); await sleep(200); xdo("type", "--delay", "90", "hello"); });
  await again();
  await step(sc, "click below the fold", async () => {
    await personMove(sc.T, { x: FAR.x, y: 400 });
    for (let i = 0; i < 20; i++) {
      const top = farTop(sc.T);
      if (top !== undefined && top > 80 && top < 450) break;
      xdo("click", "--repeat", "2", "--delay", "70", "5"); await sleep(300);
    }
    await personClick(sc.T, { x: FAR.x, y: (farTop(sc.T) ?? 0) + 20 });
  });
  await again();
  await step(sc, "click the frame button", () => personClick(sc.T, LAYOUT.rafButton));
  await again();
  await step(sc, "press End (scrolls to the lazy image)", async () => { xdo("key", "End"); });
  await step(sc, "send T back", back);
  await idle(sc, "idle after", 3000);
}

async function startChrome(sc: Scenario, flags: string[], urls: string[]): Promise<Chromium> {
  const c = new Chromium(sc.name, flags, urls);
  sc.chrome = c;
  await c.listen();
  return c;
}

const OCCLUDED = "--disable-backgrounding-occluded-windows";
const SCENARIOS: Record<string, (sc: Scenario) => Promise<void>> = {
  // ---------------------------------------------------------------- baselines
  async "person-front"(sc) {
    const c = await startChrome(sc, [], [urlOf(sc.T)]);
    await loaded(sc.T);
    await raiseAndFocus(windowOf(c.proc.pid!, sc.T));
    await personDrive(sc, async () => {}, async () => {});
  },
  async "person-tab"(sc) {
    const c = await startChrome(sc, [], [urlOf(sc.F), urlOf(sc.T)]);
    await loaded(sc.F); await loaded(sc.T);
    const win = windowOf(c.proc.pid!, sc.F);
    await raiseAndFocus(win);
    xdo("key", "ctrl+1"); await sleep(800);
    await personDrive(sc, async () => { xdo("key", "ctrl+2"); await sleep(700); }, async () => { xdo("key", "ctrl+1"); });
  },
  async "person-window-multi"(sc) {
    const c = await startChrome(sc, [], [urlOf(sc.T)]);
    await loaded(sc.T);
    const wt = windowOf(c.proc.pid!, sc.T);
    await raiseAndFocus(wt);
    execFileSync(CHROME, [`--user-data-dir=${join(RUN, `profile-${sc.name}`)}`, "--new-window", urlOf(sc.F)], { env: XENV, stdio: "ignore", timeout: 15_000 });
    await loaded(sc.F);
    const wf = windowOf(c.proc.pid!, sc.F);
    await raiseAndFocus(wf);
    await personDrive(sc, () => raiseAndFocus(wt), () => raiseAndFocus(wf), true);
  },
  async "person-window"(sc) {
    const c = await startChrome(sc, [], [urlOf(sc.T)]);
    await loaded(sc.T);
    const wt = windowOf(c.proc.pid!, sc.T);
    await raiseAndFocus(wt);
    // The person opens F in a second window over it, as a link from another app does: a second start on the
    // same profile hands the URL to the running Chromium (its process singleton) and ends. No CDP message.
    execFileSync(CHROME, [`--user-data-dir=${join(RUN, `profile-${sc.name}`)}`, "--new-window", urlOf(sc.F)], { env: XENV, stdio: "ignore", timeout: 15_000 });
    await loaded(sc.F);
    const wf = windowOf(c.proc.pid!, sc.F);
    await raiseAndFocus(wf);
    await personDrive(sc, () => raiseAndFocus(wt), () => raiseAndFocus(wf));
  },
  // ---------------------------------------------------------------- agent-browser today (4)
  async default(sc) {
    const c = await startChrome(sc, [OCCLUDED], [urlOf(sc.F)]);
    await loaded(sc.F);
    await raiseAndFocus(windowOf(c.proc.pid!, sc.F));
    // The old modes: the gate's fallback (review-45b B1). Through cdpUrl the bridge is agent mode's endpoint, where
    // every page is a window page, also with open --tab (F8); "not a display of its own" gives today's tab and drive.
    const o: BrowserOptions = { ...opts(c, false), display: { own: false } };
    await commands.open(o, { url: urlOf(sc.T), tab: true });
    await loaded(sc.T);
    await agentDrive(sc, o, plain);
  },
  async "hidden-drive"(sc) {
    const c = await startChrome(sc, [OCCLUDED], [urlOf(sc.F)]);
    await loaded(sc.F);
    await raiseAndFocus(windowOf(c.proc.pid!, sc.F));
    const o: BrowserOptions = { ...opts(c, true), display: { own: false } }; // the old hidden drive, as in default
    await commands.open(o, { url: urlOf(sc.T), tab: true });
    await loaded(sc.T);
    await agentDrive(sc, o, plain);
  },
  // ---------------------------------------------------------------- agent-browser's own window per page (ab-v16.26)
  async "ab-window"(sc) {
    const c = await startChrome(sc, [OCCLUDED], [urlOf(sc.F)]);
    await loaded(sc.F);
    const wf = windowOf(c.proc.pid!, sc.F);
    await raiseAndFocus(wf);
    const o = opts(c, false);
    await commands.open(o, { url: urlOf(sc.T) });
    await loaded(sc.T);
    await sleep(500);
    sc.notes.push(`T's window after its open: ${windowOf(c.proc.pid!, sc.T)}; F's window: ${wf}; X focus: ${xdo("getwindowfocus")}`);
    await raiseAndFocus(wf); // as windowCase: F's window over T's, the case to measure
    await agentDrive(sc, o, plain);
  },
  // ---------------------------------------------------------------- the whole design (ab-v16.26)
  async design(sc) { await designCase(sc, true); },
  async "design-no-x"(sc) { await designCase(sc, false); },
  async "design-two"(sc) { await designTwoCase(sc, false); },
  async "design-two-sites"(sc) { await designTwoCase(sc, true); },
  // ---------------------------------------------------------------- one window per agent page (1)
  async window(sc) { await windowCase(sc, [OCCLUDED], true); },
  async "window-no-flag"(sc) { await windowCase(sc, [], true); },
  // The old default in a window: since ab-v16.26 agent-browser sends no focus emulation to a window page, so the
  // scenario sends it itself around each command, as the old attach did (review-45 F4).
  async "window-default"(sc) { await windowCase(sc, [OCCLUDED], false, false, true); },
  async "window-activate"(sc) { await windowCase(sc, [OCCLUDED], true, true); },
  // ---------------------------------------------------------------- activate the tab for input (2)
  async activate(sc) {
    const c = await startChrome(sc, [OCCLUDED], [urlOf(sc.F)]);
    await loaded(sc.F);
    await raiseAndFocus(windowOf(c.proc.pid!, sc.F));
    const o: BrowserOptions = { ...opts(c, true), display: { own: false } }; // a background tab with the hidden drive, as in default
    const t = (await commands.open(o, { url: urlOf(sc.T), tab: true })).tab.targetId;
    await loaded(sc.T);
    const raw = await CDPConnection.connect(c.cdpUrl);
    const f = ((await raw.send("Target.getTargets")).targetInfos as { targetId: string; url: string }[]).find((x) => x.url.includes(`tab=${sc.F}`))!.targetId;
    const wrap: Wrap = async (fn) => {
      await raw.send("Target.activateTarget", { targetId: t });
      try { return await fn(); } finally { await raw.send("Target.activateTarget", { targetId: f }); }
    };
    await agentDrive(sc, o, wrap);
    await raw.close();
  },
  // ---------------------------------------------------------------- focus emulation for input only (3)
  async "emulate-input"(sc) {
    const c = await startChrome(sc, [OCCLUDED], [urlOf(sc.F)]);
    await loaded(sc.F);
    await raiseAndFocus(windowOf(c.proc.pid!, sc.F));
    const o: BrowserOptions = { ...opts(c, true), display: { own: false } }; // a background tab with the hidden drive, as in default
    const t = (await commands.open(o, { url: urlOf(sc.T), tab: true })).tab.targetId;
    await loaded(sc.T);
    const raw = await CDPConnection.connect(c.cdpUrl);
    const wrap: Wrap = async (fn) => {
      const { sessionId } = await raw.send("Target.attachToTarget", { targetId: t, flatten: true });
      await raw.send("Emulation.setFocusEmulationEnabled", { enabled: true }, sessionId);
      try { return await fn(); } finally {
        await raw.send("Emulation.setFocusEmulationEnabled", { enabled: false }, sessionId).catch(() => {});
        await raw.send("Target.detachFromTarget", { sessionId }).catch(() => {});
      }
    };
    await agentDrive(sc, o, wrap);
    await raw.close();
  },
  // ---------------------------------------------------------------- Playwright behind the bridge (5)
  async "pw-default"(sc) { await playwrightCase(sc, { noDefaults: false, filter: false }); },
  async "pw-no-defaults"(sc) { await playwrightCase(sc, { noDefaults: true, filter: false }); },
  async "pw-filtered"(sc) { await playwrightCase(sc, { noDefaults: false, filter: true }); },
  async "pw-window-filtered"(sc) { await playwrightCase(sc, { noDefaults: false, filter: true, window: true }); },
  // ---------------------------------------------------------------- one window per page, with the X focus (6)
  async "xfocus-cdp"(sc) { await xfocusCase(sc, false); },
  async "xfocus-xinput"(sc) { await xfocusCase(sc, true); },
  async "window-human-cdp"(sc) { await humanCdpCase(sc); },
  async "window-keys-inactive"(sc) { await keysInactiveCase(sc); },
};

/** The whole design: agent-browser's own open (a window of its own on Linux) and commands; `x`: agent-browser may reach
 *  the X pointer (this run's Xvfb, through DISPLAY and XAUTHORITY), else not (as over agentwatch's relay). */
async function designCase(sc: Scenario, x: boolean) {
  const c = await startChrome(sc, [OCCLUDED], [urlOf(sc.F)]);
  await loaded(sc.F);
  const wf = windowOf(c.proc.pid!, sc.F);
  await raiseAndFocus(wf);
  const o: BrowserOptions = { ...opts(c, false), ...(x ? {} : { display: { xdotool: false } }) };
  await commands.open(o, { url: urlOf(sc.T) });
  await loaded(sc.T);
  await sleep(500);
  await raiseAndFocus(wf); // F's window over T's
  await designDrive(sc, o, wf);
  try { sc.notes.push(`pointer.json: ${readFileSync(join(o.stateDir, "pointer.json"), "utf8").slice(0, 300)}`); } catch { sc.notes.push("no pointer.json"); }
}

/** Two agents at once, each with a window of its own (T, and a second page T2 of the same site, or with `twoSites` of another
 *  site), sharing one agent browser's state folder (one input lock): each types "hello" into its field 6 times, with
 *  pauses. Also each alone, for the cost. Each page's own sequence of focus, blur and keys during its own commands is
 *  listed (what that site alone sees); then a third agent types on T's site. */
async function designTwoCase(sc: Scenario, twoSites: boolean) {
  const c = await startChrome(sc, [OCCLUDED], [urlOf(sc.F)]);
  await loaded(sc.F);
  const wf = windowOf(c.proc.pid!, sc.F);
  await raiseAndFocus(wf);
  const o = opts(c, false), T2 = `${sc.T}b`, T3 = `${sc.T}c`; // T3: a third page of T's site, for a later agent there
  await commands.open(o, { url: urlOf(sc.T) });
  await commands.open(o, { url: urlOf(T2, twoSites ? BASE2 : BASE) });
  await commands.open(o, { url: urlOf(T3) });
  await loaded(sc.T); await loaded(T2); await loaded(T3);
  await sleep(500);
  await raiseAndFocus(wf);
  const agent = async (tab: string, delay: number, rounds = 6) => {
    await sleep(delay);
    for (let r = 0; r < rounds; r++) {
      mark("cmd", { of: tab, phase: "start" });
      await commands.type(o, { tab: `tab=${tab}`, text: "hello", into: "#f" });
      mark("cmd", { of: tab, phase: "end" });
      await sleep(300 + Math.round(Math.random() * 400));
    }
  };
  await idle(sc, "idle before", 2000);
  let together = 0;
  await step(sc, "two agents type at once", async () => { const t0 = Date.now(); await Promise.all([agent(sc.T, 0), agent(T2, 450)]); together = Date.now() - t0; }, 120_000);
  const sorted = () => log.slice().sort((x, y) => x.t - y.t);
  const s0 = sc.steps.at(-1)!;
  const both = bothFocusedMs(sorted(), sc.T, T2, s0.t0, s0.t1);
  // A third agent on T's site after both: T and T3 (one site) must never both have the focus (way 1).
  await step(sc, "a third agent on T's site, after both", () => agent(T3, 0, 2), 60_000);
  const s3 = sc.steps.at(-1)!;
  sc.notes.push(`after both, a third agent on T's site: T and T3 both focused ${bothFocusedMs(sorted(), sc.T, T3, s3.t0, s3.t1)} ms, T2 and T3 ${bothFocusedMs(sorted(), T2, T3, s3.t0, s3.t1)} ms of ${s3.t1 - s3.t0} ms; `
    + `focused at its end: ${[sc.T, T2, T3].map((tab) => `${tab} ${log.filter((e) => e.tab === tab && e.focus !== undefined && e.t <= s3.t1).sort((x, y) => x.t - y.t).at(-1)?.focus}`).join(", ")}`);
  await raiseAndFocus(wf);
  let alone = 0;
  await step(sc, "each agent alone, one after the other", async () => { const t0 = Date.now(); await agent(sc.T, 0); await agent(T2, 0); alone = Date.now() - t0; }, 120_000);
  const focusOf = (tab: string) => log.filter((e) => e.tab === tab && e.ev === "focus" && e.t >= s0.t0 && e.t <= s0.t1).map((e) => e.t);
  sc.notes.push(`two at once: ${together} ms; both pages focused ${both} ms; one after the other: ${alone} ms (the lock makes the work of two at once ${Math.round(((together - alone / 2) / (alone / 2)) * 100)}% longer than one agent's, against ${alone} ms for both in turn)`);
  for (const tab of [sc.T, T2]) sc.notes.push(`${tab} pointer while both typed: ${JSON.stringify(pointerSignals(sorted(), tab, s0.t0, s0.t1 + 200, focusOf(tab)))}`);
  for (const tab of [sc.T, T2]) {
    const ins = log.filter((e) => e.tab === tab && e.ev === "in" && e.t >= s0.t0 && e.t <= s0.t1 + 200) as Record<string, any>[];
    sc.notes.push(`${tab}: keydowns ${ins.filter((e) => e.type === "keydown").length}, while unfocused ${ins.filter((e) => e.type === "keydown" && e.focus === false).length}, untrusted ${ins.filter((e) => e.trusted === false).length}, field focus with no press ${ins.filter((e) => e.type === "focusin" && !ins.some((i) => i.type === "pointerdown" && i.t <= e.t && e.t - i.t < 1000)
      && !log.some((x) => x.tab === tab && x.ev === "focus" && x.t <= e.t + 5 && e.t - x.t < 100)).length}`);
  }
  for (const tab of [sc.T, T2]) sc.notes.push(`${tab} alone, during its own commands: ${ownSequence(sorted(), tab, s0.t0, s0.t1 + 200)}`);
  const b = await AgentBrowser.connect(o);
  try { for (const tab of [sc.T, T2]) sc.notes.push(`${tab} field: ${JSON.stringify(await (await b.find(`tab=${tab}`)).evaluate(() => (document.getElementById("f") as HTMLInputElement).value))}`); }
  finally { await b.disconnect().catch(() => {}); }
  await idle(sc, "idle after", 2000);
}

/**
 * What one page sees alone during its own commands (the driver's "cmd" marks of design-two): for each command, its events
 * in order (F focus, B blur, d pointerdown, k keydown, k' a keydown while the page had no focus), and the counts over all
 * commands: blurs inside a command, focus events after a command's first, keydowns with no focus. A person's page shows
 * "F d k k k k k" (the window's focus, the field's press, the keys): a blur comes only when the person leaves the window.
 */
function ownSequence(sorted: Rec[], tab: string, from: number, to: number): string {
  const marks = sorted.filter((e) => e.tab === "driver" && e.ev === "cmd" && e.of === tab && e.t >= from && e.t <= to);
  const spans: [number, number][] = [];
  for (const m of marks) if (m.phase === "start") spans.push([m.t, to]); else if (spans.length) spans[spans.length - 1][1] = m.t;
  let blurs = 0, refocus = 0, keysUnfocused = 0;
  const seqs = spans.map(([a, z]) => {
    const evs = sorted.filter((e) => e.tab === tab && e.t >= a && e.t <= z + 50 && (e.ev === "focus" || e.ev === "blur" || (e.ev === "in" && (e.type === "keydown" || e.type === "pointerdown"))));
    let focusSeen = 0;
    return evs.map((e) => {
      if (e.ev === "focus") { if (focusSeen++) refocus++; return "F"; }
      if (e.ev === "blur") { if (e.t <= z) blurs++; return "B"; }
      if (e.type === "pointerdown") return "d";
      if (e.focus === false) { keysUnfocused++; return "k'"; }
      return "k";
    }).join(" ");
  });
  return `${spans.length} commands; blurs inside its commands ${blurs}, focus events after a command's first ${refocus}, keydowns with no focus ${keysUnfocused}; sequences: ${seqs.map((q) => `[${q}]`).join(" ")}`;
}

/** Candidate 1: T opens in a window of its own (Target.createTarget newWindow, background); F's window stays over it. */
async function windowCase(sc: Scenario, flags: string[], hiddenDrive: boolean, activate = false, emulate = false) {
  const c = await startChrome(sc, flags, [urlOf(sc.F)]);
  await loaded(sc.F);
  const wf = windowOf(c.proc.pid!, sc.F);
  await raiseAndFocus(wf);
  const raw = await CDPConnection.connect(c.cdpUrl);
  const t = (await raw.send("Target.createTarget", { url: urlOf(sc.T), newWindow: true, background: true })).targetId;
  await loaded(sc.T);
  await sleep(500);
  sc.notes.push(`T's window after its open: ${windowOf(c.proc.pid!, sc.T)}; F's window: ${wf}; X focus: ${xdo("getwindowfocus")}`);
  // On Linux a new window with background: true comes above F's window without the X focus (review-43's raise
  // check, extra.ts --exp raise). The script raises F's window again, so that T's window is covered: the case to
  // measure. On the Mac the order of a new window is not measured.
  await raiseAndFocus(wf);
  const f = ((await raw.send("Target.getTargets")).targetInfos as { targetId: string; url: string }[]).find((x) => x.url.includes(`tab=${sc.F}`))!.targetId;
  // activate: Chrome's own window activation (Target.activateTarget; the relay's chrome.windows.update focused) before input, then back.
  const wrap: Wrap = activate ? async (fn) => {
    await raw.send("Target.activateTarget", { targetId: t }); await sleep(100);
    try { return await fn(); } finally { await raw.send("Target.activateTarget", { targetId: f }); }
  } : emulate ? async (fn) => {
    const { sessionId } = await raw.send("Target.attachToTarget", { targetId: t, flatten: true });
    await raw.send("Emulation.setFocusEmulationEnabled", { enabled: true }, sessionId);
    try { return await fn(); } finally {
      await raw.send("Emulation.setFocusEmulationEnabled", { enabled: false }, sessionId).catch(() => {});
      await raw.send("Target.detachFromTarget", { sessionId }).catch(() => {});
    }
  } : plain;
  await agentDrive(sc, opts(c, hiddenDrive), wrap, { readWrap: emulate });
  await raw.close();
}

/** One window per page; after the agent's click in T, F's window takes the focus again (another agent, or a
 *  person); then the agent types into T with no click first: keys for a page whose window is not active. */
async function keysInactiveCase(sc: Scenario) {
  const c = await startChrome(sc, [OCCLUDED], [urlOf(sc.F)]);
  await loaded(sc.F);
  const wf = windowOf(c.proc.pid!, sc.F);
  await raiseAndFocus(wf);
  const raw = await CDPConnection.connect(c.cdpUrl);
  await raw.send("Target.createTarget", { url: urlOf(sc.T), newWindow: true, background: true });
  await raw.close();
  await loaded(sc.T);
  await sleep(500);
  await raiseAndFocus(wf);
  const o = opts(c, true), T = `tab=${sc.T}`;
  await idle(sc, "idle before", 3000);
  await step(sc, "click", () => commands.click(o, { tab: T, target: "#b" }));
  await step(sc, "F's window takes the focus", () => raiseAndFocus(wf));
  await step(sc, "type", () => commands.type(o, { tab: T, text: "hello", into: "#f" }));
  await step(sc, "press End (scrolls to the lazy image)", () => commands.press(o, { tab: T, key: "End" }));
  await idle(sc, "idle after", 3000);
}

/** Input that a person's hands make, sent as CDP input: a curved path of moves, a 70 ms press with force 0.5, one key
 *  event pair per character, 90 ms apart. It shows which input signals CDP can match and which it cannot. */
async function humanCdp(raw: CDPConnection, sessionId: string) {
  let at = { x: LAYOUT.neutral.x, y: LAYOUT.neutral.y };
  const send = (m: string, p: object) => raw.send(m, p, sessionId);
  const move = async (to: { x: number; y: number }) => {
    for (let i = 1, n = 20; i <= n; i++) {
      const s = i / n, e = s * s * s * (10 - 15 * s + 6 * s * s);
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x + (to.x - at.x) * e + (i === n ? 0 : Math.sin(Math.PI * s) * 40), y: at.y + (to.y - at.y) * e });
      await sleep(14);
    }
    at = to;
  };
  const click = async (to: { x: number; y: number }) => {
    await move(to); await sleep(120);
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: to.x, y: to.y, button: "left", buttons: 1, clickCount: 1, force: 0.5 });
    await sleep(70);
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, button: "left", buttons: 0, clickCount: 1 });
  };
  const key = async (k: string) => {
    const code = k === "End" ? "End" : `Key${k.toUpperCase()}`, vk = k === "End" ? 35 : k.toUpperCase().charCodeAt(0);
    await send("Input.dispatchKeyEvent", { type: k === "End" ? "rawKeyDown" : "keyDown", key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, ...(k === "End" ? {} : { text: k, unmodifiedText: k }) });
    await sleep(40);
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  };
  const wheel = async (deltaY: number) => { await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: at.x, y: at.y, deltaX: 0, deltaY }); await sleep(70); };
  // The path starts where the real pointer is (review-43: an activation gives the page a real pointer event at the X
  // pointer, and a path that starts elsewhere jumps by some hundred pixels).
  const startAt = (pt: { x: number; y: number }) => { at = pt; };
  return { click, key, wheel, startAt, type: async (text: string) => { for (const ch of text) { await key(ch); await sleep(90); } } };
}

/** The real X pointer in T's viewport (CSS px), clamped into the viewport. */
function pointerIn(tab: string): { x: number; y: number } {
  const loc = Object.fromEntries(xdo("getmouselocation", "--shell").split("\n").map((l) => l.split("=")));
  const o = origin(tab), g = log.filter((e) => e.tab === tab && (e.ev === "load" || e.ev === "geo")).at(-1) as Record<string, number>;
  return { x: Math.min(Math.max(Number(loc.X) - o.x, 1), g.iw - 2), y: Math.min(Math.max(Number(loc.Y) - o.y, 1), g.ih - 2) };
}

/** One window per page, Chrome's own activation before input, and the person-like CDP input of humanCdp. */
async function humanCdpCase(sc: Scenario) {
  const c = await startChrome(sc, [OCCLUDED], [urlOf(sc.F)]);
  await loaded(sc.F);
  const wf = windowOf(c.proc.pid!, sc.F);
  await raiseAndFocus(wf);
  const raw = await CDPConnection.connect(c.cdpUrl);
  const t = (await raw.send("Target.createTarget", { url: urlOf(sc.T), newWindow: true, background: true })).targetId;
  await loaded(sc.T);
  await sleep(500);
  await raiseAndFocus(wf);
  const f = ((await raw.send("Target.getTargets")).targetInfos as { targetId: string; url: string }[]).find((x) => x.url.includes(`tab=${sc.F}`))!.targetId;
  const { sessionId } = await raw.send("Target.attachToTarget", { targetId: t, flatten: true });
  const h = await humanCdp(raw, sessionId);
  const bring = async () => { await raw.send("Target.activateTarget", { targetId: t }); await sleep(300); h.startAt(pointerIn(sc.T)); };
  const back = async () => { await raw.send("Target.activateTarget", { targetId: f }); };
  await idle(sc, "idle before", 3000);
  await step(sc, "bring T to the front", bring);
  await step(sc, "click", () => h.click(LAYOUT.button));
  await step(sc, "type", async () => { await h.click(LAYOUT.field); await sleep(200); await h.type("hello"); });
  await step(sc, "click below the fold", async () => {
    for (let i = 0; i < 20; i++) { const top = farTop(sc.T); if (top > 80 && top < 450) break; await h.wheel(100); await sleep(150); }
    await h.click({ x: FAR.x, y: farTop(sc.T) + 20 });
  });
  await step(sc, "click the frame button", () => h.click(LAYOUT.rafButton));
  await step(sc, "press End (scrolls to the lazy image)", () => h.key("End"));
  await step(sc, "send T back", back);
  await idle(sc, "idle after", 3000);
  await raw.send("Target.detachFromTarget", { sessionId });
  await raw.close();
}

/** Candidate 6: one window per page; before input the agent moves the X focus to T's window (a window manager's
 *  raise and focus), as a person's click on that window does; then CDP input, or X input at the page's screen points. */
async function xfocusCase(sc: Scenario, xinput: boolean) {
  const c = await startChrome(sc, [OCCLUDED], [urlOf(sc.F)]);
  await loaded(sc.F);
  const wf = windowOf(c.proc.pid!, sc.F);
  await raiseAndFocus(wf);
  const raw = await CDPConnection.connect(c.cdpUrl);
  await raw.send("Target.createTarget", { url: urlOf(sc.T), newWindow: true, background: true });
  await raw.close();
  await loaded(sc.T);
  await sleep(500);
  const wt = windowOf(c.proc.pid!, sc.T);
  await raiseAndFocus(wf);
  if (xinput) { await personDrive(sc, () => raiseAndFocus(wt), () => raiseAndFocus(wf)); return; }
  const o = opts(c, true);
  const wrap: Wrap = async (fn) => { await raiseAndFocus(wt); try { return await fn(); } finally { await raiseAndFocus(wf); } };
  await agentDrive(sc, o, wrap);
}

/** Candidate 5: Playwright (connectOverCDP) behind the bridge, with its own focus emulation, noDefaults, or the bridge's filter. */
async function playwrightCase(sc: Scenario, v: { noDefaults: boolean; filter: boolean; window?: boolean }) {
  if (!values.playwright) { sc.notes.push("skipped: no --playwright DIR"); return; }
  const pw = createRequire(join(resolve(values.playwright), "package.json"))("playwright-core");
  const c = await startChrome(sc, [OCCLUDED], [urlOf(sc.F)]);
  c.filterFocus = v.filter;
  c.ownWindow = !!v.window;
  await loaded(sc.F);
  const wf = windowOf(c.proc.pid!, sc.F);
  await raiseAndFocus(wf);
  const browser = await pw.chromium.connectOverCDP(c.cdpUrl, { noDefaults: v.noDefaults, timeout: 15_000 });
  const context = browser.contexts()[0];
  const page = await context.newPage(); // Playwright's newPage opens a tab in front
  await page.goto(urlOf(sc.T));
  await loaded(sc.T);
  // The operator (or another agent) brings F to the front again: T is now a background tab (or a window behind F's).
  await raiseAndFocus(wf);
  if (!v.window) xdo("key", "ctrl+1");
  await sleep(1000);
  const t = { timeout: 8000 };
  await idle(sc, "idle before", 3000);
  await step(sc, "text", () => page.textContent("#s", t));
  await step(sc, "click", () => page.click("#b", t));
  await step(sc, "type", () => page.fill("#f", "hello", t));
  await step(sc, "library: click, waitForFunction a frame's content", async () => {
    await page.click("#r", t);
    await page.waitForFunction(() => document.getElementById("rd")!.textContent === "frames: 1", undefined, { timeout: 5000 });
  });
  await step(sc, "press End (scrolls to the lazy image)", () => page.keyboard.press("End"));
  await step(sc, "shot", () => page.screenshot({ path: join(RUN, `${sc.name}.png`), ...t }));
  await idle(sc, "idle after", 3000);
  await step(sc, "disconnect", () => browser.close());
  await idle(sc, "idle after the disconnect", 2000);
  sc.notes.push(`Emulation.setFocusEmulationEnabled from Playwright: ${c.counts["Emulation.setFocusEmulationEnabled"] ?? 0} (the bridge answered ${c.dropped} itself)`);
}

// ------------------------------------------------------------------ run
const only = values.only ? values.only.split(",") : Object.keys(SCENARIOS);
for (const n of only) if (!SCENARIOS[n]) refuse(`no scenario ${n}; known: ${Object.keys(SCENARIOS).join(", ")}`);
for (const name of only) {
  const sc = scenario(name, name);
  try { await SCENARIOS[name](sc); }
  catch (e) { sc.notes.push(`scenario error: ${String((e as Error).message ?? e).split("\n")[0]}`); say(`${name}: ERROR ${(e as Error).stack}`); }
  sc.tEnd = Date.now();
  if (sc.chrome) {
    sc.notes.push(`CDP methods sent: ${Object.entries(sc.chrome.counts).map(([m, n]) => `${m} ${n}`).join(", ") || "none"}`);
    await sc.chrome.stop();
  }
}

// ------------------------------------------------------------------ analysis
const product = execFileSync(CHROME, ["--version"], { encoding: "utf8" }).trim();
const summary = results.map((sc) => {
  const end = sc.tEnd ?? Date.now();
  const steps = sc.steps.map((s) => ({ name: s.name, ok: s.ok, ms: s.t1 - s.t0, ...(s.error ? { error: s.error } : {}), ...stepSignals(log, sc.T, s.t0, s.t1) }));
  const idleBefore = sc.steps.find((s) => s.name === "idle before"), idleAfter = sc.steps.find((s) => s.name === "idle after");
  const lazy = log.find((e) => e.tab === sc.T && e.ev === "lazy-request"), end0 = sc.steps.find((s) => s.name.startsWith("press End"));
  const io = log.filter((e) => e.tab === sc.T && e.ev === "io").map((e) => `${e.hit ? "in" : "out"}@${end0 ? e.t - end0.t0 : "?"}`);
  // At load (a tab that loads before Chrome shows it reports outerWidth and outerHeight 0, a person's background tab too), and the first resize after.
  const geo = (tab: string) => {
    const g = log.find((e) => e.tab === tab && e.ev === "load"), r = log.find((e) => e.tab === tab && e.ev === "geo");
    return g ? { load: `${g.iw}x${g.ih} in ${g.ow}x${g.oh} at ${g.sx},${g.sy}`, ...(r ? { resize: `${r.iw}x${r.ih} in ${r.ow}x${r.oh} at ${r.sx},${r.sy}` } : {}), webdriver: g.webdriver, historyLength: g.hl } : undefined;
  };
  const fEvents = log.filter((e) => e.tab === sc.F && e.t >= sc.tStart && e.t <= end && ["visibilitychange", "focus", "blur"].includes(e.ev)).map((e) => `${e.ev}${e.ev === "visibilitychange" ? `:${e.vis}` : ""}`);
  return {
    name: sc.name, notes: sc.notes,
    idleBefore: idleBefore && { vis: visAt(log, sc.T, idleBefore.t1), ...rates(log, sc.T, idleBefore.t0, idleBefore.t1), focus: stepSignals(log, sc.T, idleBefore.t0, idleBefore.t1).focusAfter },
    idleAfter: idleAfter && { vis: visAt(log, sc.T, idleAfter.t1), ...rates(log, sc.T, idleAfter.t0, idleAfter.t1), focus: stepSignals(log, sc.T, idleAfter.t0, idleAfter.t1).focusAfter },
    lazyRequestMs: lazy && end0 ? lazy.t - end0.t0 : null, io,
    rafContent: log.filter((e) => e.tab === sc.T && e.ev === "raf-content").length,
    // Up to the record step: record turns focus emulation on for its run, and after it the page keeps the focus with no blur.
    fEvents, bothFocusedMs: bothFocusedMs(log.slice().sort((x, y) => x.t - y.t), sc.F, sc.T, sc.tStart, sc.steps.find((s) => s.name.startsWith("record"))?.t0 ?? end),
    geometry: { F: geo(sc.F), T: geo(sc.T) }, steps,
    // The pointer over the whole scenario; each focus event of T is an activation of T (ab-v16.26, correction 3b).
    pointer: pointerSignals(log, sc.T, sc.tStart, end, log.filter((e) => e.tab === sc.T && e.ev === "focus" && e.t >= sc.tStart && e.t <= end).map((e) => e.t)),
  };
});
writeFileSync(join(RUN, "results.json"), JSON.stringify({ chrome: product, display: DISPLAY, summary, log }, null, 2) + "\n");
const rows = summary.flatMap((s) => [
  `## ${s.name}`, ...s.notes.map((n) => `- ${n}`),
  `- idle before: ${JSON.stringify(s.idleBefore)}; idle after: ${JSON.stringify(s.idleAfter)}`,
  `- lazy request ${s.lazyRequestMs ?? "none"} ms after End; IO ${s.io.join(" ") || "none"}; frame content ${s.rafContent}; F saw ${s.fEvents.join(" ") || "nothing"}; F and T both focused ${s.bothFocusedMs} ms`,
  `- geometry ${JSON.stringify(s.geometry)}`,
  `- pointer ${JSON.stringify(s.pointer)}`,
  ...s.steps.map((st) => `  - ${st.name}: ${st.ok ? "ok" : `FAIL ${st.error}`} ${st.ms} ms; vis ${st.visBefore} visibleMs ${st.visibleMs} changes [${st.visChanges.join(" ")}] focus [${st.focusEvents.join(" ")}] focusAfter ${st.focusAfter} framesDuring ${st.framesDuring} after ${st.framesAfter}; input ${st.inputSeq || "-"}; hidden-input ${st.inputHidden} unfocused-input ${st.inputUnfocused} untrusted ${st.untrusted} screen-client ${JSON.stringify(st.screenMinusClient)} pressure ${st.pressure} down-up ${st.downUpMs} moves ${st.moves}/${st.movesWithMovement} keydowns ${st.keydowns} inputType ${st.inputTypes}`),
]);
writeFileSync(join(RUN, "steps.md"), `${product}; run ${RUN}\n${rows.join("\n")}\n`);
process.stdout.write(`${product}; ${RUN}/results.json (every step: ${RUN}/steps.md)\n\n${report([{ summary }])}`);
server.close();
process.exit(results.some((sc) => sc.notes.some((n) => n.startsWith("scenario error"))) ? 1 : 0);
