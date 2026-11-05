// A person's input in a window of its own (Linux, agent mode; ab-v16.26; docs/research/2026-11-05-anti-detect-drive.md,
// "The answer", steps 4 to 6, and section 5). Tab's input commands (click, clickText, clickAt, hover, type, press,
// setFiles) run here when the page's drive is "window" (browser.ts, Tab.drive):
//
// - One input at a time in each agent browser: the activation and the input command hold the state folder's input
//   lock (withInputLock), across processes. Two agents that typed at once otherwise gave two focused pages.
// - The window comes forward first: a page without the focus gets Page.bringToFront, which on Linux selects its tab
//   and activates its window, as a person's switch to it does (measured on taylor: it gives the focus, as
//   Target.activateTarget does; Page.bringToFront also passes through agentwatch's relay).
// - The pointer is one pointer for all the windows, as a person's mouse is. Chrome gives a window that comes forward a
//   real pointer event at the X pointer, so each path starts at that event's point (read by a listener in our
//   isolated world), else at the page's last point (pointer.json in the state folder). Where agent-browser can reach
//   the X pointer (xdotool on the agent browser's own display: no other program's window on it), the X pointer moves
//   to the end of each path, inside the lock, so the next activation enters where the page last saw the pointer.
//   Measured on taylor (test/live/anti-detect/extra.ts --exp pointer): with the X pointer moved to each path's end,
//   0 jumps and 0 position changes that the movement does not explain, as for a person who switches windows; with
//   the X pointer never moved, 0 jumps but each later activation entered at the X pointer's one point, a position
//   change that the movement does not explain (2 in each window per 3 activations).
// - The shape: a ghost-cursor path (as `record`'s cursor) of 12 to 60 moves, a pause on the target, a press of 70 to
//   90 ms with force 0.5; one key-event pair per character, 90 to 150 ms apart; the wheel brings an element into view
//   (100 px a notch); a field gets the focus by a click, and the caret goes where el.focus() would have put it; a file
//   input gets a click that opens Chrome's file chooser (intercepted), and the files go to the input that it names.
//   The times are the inputTiming option (options.ts, INPUT_TIMING).

import { execFile } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { agentChromePid } from "./agent.ts";
import type { Tab } from "./browser.ts";
import { withFileLock } from "./lock.ts";
import { statePath, underNodeTest, type InputTiming, type Settings, type XdotoolRunner } from "./options.ts";
import { charKey, parseKey, planMove, pointAt, sendKey, type KeyEvent, type Point } from "./record.ts";

export const INPUT_LOCK = "input.lock", POINTER_FILE = "pointer.json";

/** Run `fn` while this process holds the agent browser's input lock (the state folder's input.lock). */
export async function withInputLock<T>(s: Settings, fn: () => Promise<T>): Promise<T> {
  return withFileLock(statePath(s, INPUT_LOCK), Date.now() + s.inputTiming.lockWaitMs, fn,
    `the input lock (another input command of this agent browser held it for ${s.inputTiming.lockWaitMs / 1000} s)`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const between = ([a, b]: [number, number]) => a + (b - a) * Math.random();

// ---------- the pointer's state ----------

/** The last point of each page's pointer (client CSS px), and what is known of the X display. Written inside the input lock. */
type PointerState = { pages: Record<string, Point>; display?: { name: string; ok: boolean; at: number } };

function readPointer(s: Settings): PointerState {
  try {
    const raw = JSON.parse(readFileSync(statePath(s, POINTER_FILE), "utf8"));
    if (raw && typeof raw === "object" && raw.pages && typeof raw.pages === "object") return raw as PointerState;
  } catch { /* none yet */ }
  return { pages: {} };
}

function writePointer(s: Settings, st: PointerState) {
  const ids = Object.keys(st.pages);
  for (const id of ids.slice(0, Math.max(0, ids.length - 200))) delete st.pages[id]; // the oldest go: at most 200 pages
  const path = statePath(s, POINTER_FILE), tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(st), { mode: 0o600 });
  renameSync(tmp, path);
}

// ---------- the X pointer ----------

type XAccess = { run: XdotoolRunner; display: string };

/**
 * xdotool on the agent browser's display: this process's DISPLAY (and XAUTHORITY), else, for the agent Chrome that
 * agent-browser started, the display in that Chrome's own environment. None under a test (a test passes its own
 * runner), none when the option says so, and none without xdotool.
 */
function xAccess(s: Settings): XAccess | undefined {
  if (s.xdotool === false) return undefined;
  if (s.xdotool) return { run: s.xdotool, display: "injected" };
  if (underNodeTest() || s.platform !== "linux") return undefined;
  let env: Record<string, string> | undefined;
  if (process.env.DISPLAY) env = { DISPLAY: process.env.DISPLAY, ...(process.env.XAUTHORITY ? { XAUTHORITY: process.env.XAUTHORITY } : {}) };
  else if (!s.cdpUrl) {
    try {
      const pid = agentChromePid(s);
      if (pid) {
        const vars = Object.fromEntries(readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)]));
        if (vars.DISPLAY) env = { DISPLAY: vars.DISPLAY, ...(vars.XAUTHORITY ? { XAUTHORITY: vars.XAUTHORITY } : {}) };
      }
    } catch { /* no such process, or not readable */ }
  }
  if (!env) return undefined;
  const full = { ...process.env, ...env };
  delete full.WAYLAND_DISPLAY;
  const run: XdotoolRunner = (args) => new Promise((resolve, reject) => {
    execFile("xdotool", args, { env: full, timeout: 3000, encoding: "utf8" }, (e, out) => (e ? reject(e) : resolve(out)));
  });
  return { run, display: env.DISPLAY };
}

/** The X pointer on the screen. */
async function xLocation(x: XAccess): Promise<Point> {
  const v = Object.fromEntries((await x.run(["getmouselocation", "--shell"])).split("\n").map((l) => l.split("=")));
  const p = { x: Number(v.X), y: Number(v.Y) };
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) throw new Error("xdotool getmouselocation gave no position");
  return p;
}

/**
 * The display holds the agent browser only: every visible top-level window but the root belongs to the process of the
 * window that has the X focus (the agent Chrome, whose window just came forward). Never move a person's pointer.
 */
async function ownDisplay(x: XAccess): Promise<boolean> {
  const ids = (out: string) => out.split("\n").map((l) => l.trim()).filter(Boolean);
  const root = ids(await x.run(["search", "--maxdepth", "0", "--name", ""]))[0];
  const visible = ids(await x.run(["search", "--onlyvisible", "--name", ""]).catch(() => "")).filter((w) => w !== root);
  const pidOf = async (w: string) => (await x.run(["getwindowpid", w]).catch(() => "")).trim();
  const chrome = await pidOf((await x.run(["getwindowfocus"])).trim());
  if (!chrome) return false;
  for (const w of visible) if ((await pidOf(w)) !== chrome) return false;
  return visible.length > 0;
}

// ---------- the page side (our isolated world) ----------

type Geo = { sx: number; sy: number; ow: number; oh: number; iw: number; ih: number; dpr: number };

/** The page's focus and geometry; with no focus, a listener for the real pointer event that its window's activation gives. */
function arm(): { focus: boolean; geo: Geo } {
  const g = globalThis as any;
  const geo = { sx: screenX, sy: screenY, ow: outerWidth, oh: outerHeight, iw: innerWidth, ih: innerHeight, dpr: devicePixelRatio };
  const focus = document.hasFocus();
  if (g.__abEntryOff) g.__abEntryOff();
  g.__abEntry = null;
  if (!focus) {
    const types = ["mousemove", "pointermove", "mouseover", "pointerover"];
    const f = (e: MouseEvent) => { if (e.isTrusted && !g.__abEntry) g.__abEntry = { x: e.clientX, y: e.clientY }; };
    for (const t of types) document.addEventListener(t, f as EventListener, { capture: true, passive: true });
    g.__abEntryOff = () => { for (const t of types) document.removeEventListener(t, f as EventListener, { capture: true }); g.__abEntryOff = null; };
  }
  return { focus, geo };
}
function peek(): { focus: boolean; entry: Point | null } { return { focus: document.hasFocus(), entry: (globalThis as any).__abEntry ?? null }; }
function disarm(): Point | null { const g = globalThis as any; if (g.__abEntryOff) g.__abEntryOff(); return g.__abEntry ?? null; }

type Box = { x: number; y: number; w: number; h: number };
const boxOf = (el: Element): Box => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };

/** Keep the first element that matches (globalThis.__abEl) and give its box, or null. */
function pick(selector: string): Box | null {
  const el = document.querySelector(selector) as HTMLElement | null;
  (globalThis as any).__abEl = el;
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

/** Keep the smallest visible element whose text matches exactly (case-insensitive, trimmed), as Tab.clickText finds it. */
function pickText(t: string, within: string | null): Box | null {
  const root = within ? document.querySelector(within) : document.body;
  (globalThis as any).__abEl = null;
  if (!root) return null;
  const want = t.trim().toLowerCase();
  const cands = [...root.querySelectorAll<HTMLElement>("button, a, [role=button], [role=menuitem], [role=tab], label, span, div")]
    .filter((el) => (el.innerText ?? "").trim().toLowerCase() === want && el.getClientRects().length > 0);
  cands.sort((a, b) => a.getBoundingClientRect().width * a.getBoundingClientRect().height - b.getBoundingClientRect().width * b.getBoundingClientRect().height);
  const el = cands[0];
  (globalThis as any).__abEl = el ?? null;
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

/**
 * Where the kept element is, and how far the wheel must scroll it, on each axis: none when it is in view on that axis
 * (all of it inside the viewport, or its middle in the middle 60% or 80%); else to the middle. `wheelAt`: a point where the wheel scrolls the
 * element's scroller (its nearest ancestor that scrolls, else the page): the pointer when it is over that scroller,
 * else a point of the scroller's visible part. null: the element is gone.
 */
function view(px: number, py: number): { box: Box; dx: number; dy: number; wheelAt: Point | null } | null {
  const el = (globalThis as any).__abEl as HTMLElement | null;
  if (!el || !el.getClientRects().length) return null;
  const r = el.getBoundingClientRect(), vw = innerWidth, vh = innerHeight;
  const box = { x: r.left, y: r.top, w: r.width, h: r.height };
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const inY = r.top >= 0 && r.bottom <= vh, inX = r.left >= 0 && r.right <= vw;
  const dy = inY || (cy > vh * 0.2 && cy < vh * 0.8 && r.bottom > 0 && r.top < vh) ? 0 : Math.round(cy - vh / 2);
  const dx = inX || (cx > vw * 0.1 && cx < vw * 0.9 && r.right > 0 && r.left < vw) ? 0 : Math.round(cx - vw / 2);
  const scrollerOf = (n: Element | null): Element | null => {
    for (let p = n?.parentElement ?? null; p; p = p.parentElement) {
      const st = getComputedStyle(p);
      if (/(auto|scroll|overlay)/.test(`${st.overflowY} ${st.overflowX}`) && (p.scrollHeight > p.clientHeight + 1 || p.scrollWidth > p.clientWidth + 1)) return p;
    }
    return null; // the page
  };
  const own = scrollerOf(el);
  const over = (x: number, y: number) => x >= 0 && y >= 0 && x < vw && y < vh && scrollerOf(document.elementFromPoint(x, y)) === own;
  let wheelAt: Point | null = null;
  if (dx || dy) {
    if (over(px, py)) wheelAt = { x: px, y: py };
    else {
      const a = own ? own.getBoundingClientRect() : { left: 0, top: 0, right: vw, bottom: vh };
      const l = Math.max(0, a.left), t = Math.max(0, a.top), w = Math.min(vw, a.right) - l, h = Math.min(vh, a.bottom) - t;
      for (let i = 0; i < 25 && !wheelAt && w > 0 && h > 0; i++) {
        const x = l + w * (0.5 + ((i % 5) - 2) * 0.18), y = t + h * (0.5 + (Math.floor(i / 5) - 2) * 0.18);
        if (over(x, y)) wheelAt = { x, y };
      }
    }
  }
  return { box, dx, dy, wheelAt };
}

/** The old way, when the wheel cannot reach the element: a script's scroll. */
function scriptScroll(): void { (globalThis as any).__abEl?.scrollIntoView({ block: "center", inline: "center" }); }

type FieldKind = "input" | "textarea" | "editable" | "other";
/**
 * The field for `type --into`, kept as the element: whether it has the focus, its kind, its text's length, its box,
 * and the caret that el.focus() would give it: a text field's own cached selection (0 for text that came with the
 * page, the end after a script set the value, where it was after an earlier focus; measured on Chromium 156,
 * test/live/anti-detect/extra.ts --exp caret), and the start of an editable element.
 */
function pickField(selector: string): { found: boolean; focused: boolean; kind: FieldKind; len: number; want: [number, number]; box: Box | null } {
  const el = document.querySelector(selector) as (HTMLElement & { value?: string; selectionStart?: number | null; selectionEnd?: number | null }) | null;
  (globalThis as any).__abEl = el;
  if (!el) return { found: false, focused: false, kind: "other", len: 0, want: [0, 0], box: null };
  const active = document.activeElement;
  const focused = active === el || (!!active && active !== document.body && el.contains(active));
  const kind: FieldKind = el.tagName === "TEXTAREA" ? "textarea" : typeof el.value === "string" ? "input" : el.isContentEditable ? "editable" : "other";
  const len = typeof el.value === "string" ? el.value.length : (el.innerText ?? "").length;
  const want: [number, number] = typeof el.selectionStart === "number" && typeof el.selectionEnd === "number" ? [el.selectionStart, el.selectionEnd] : [0, 0];
  const r = el.getBoundingClientRect();
  return { found: true, focused, kind, len, want, box: el.getClientRects().length && r.width > 0 && r.height > 0 ? { x: r.left, y: r.top, w: r.width, h: r.height } : null };
}
/** The kept field: whether it has the focus, and its caret (a text field's selection). */
function fieldState(): { focused: boolean; caret: [number, number] | null } {
  const el = (globalThis as any).__abEl as (HTMLElement & { selectionStart?: number | null; selectionEnd?: number | null }) | null;
  if (!el) return { focused: false, caret: null };
  const active = document.activeElement;
  const focused = active === el || (!!active && active !== document.body && el.contains(active));
  return { focused, caret: typeof el.selectionStart === "number" && typeof el.selectionEnd === "number" ? [el.selectionStart, el.selectionEnd] : null };
}
function scriptFocus(): void { ((globalThis as any).__abEl as HTMLElement | null)?.focus(); }
function scriptCaret(a: number, b: number): void { ((globalThis as any).__abEl as HTMLInputElement | null)?.setSelectionRange(a, b); }

/** A file input to click (kept as the element), or a visible label of it: the input's box, else the label's (kept instead). */
function pickFile(selector: string): { found: boolean; box: Box | null; via: "input" | "label" | null } {
  const el = document.querySelector(selector) as HTMLInputElement | null;
  (globalThis as any).__abEl = el;
  if (!el) return { found: false, box: null, via: null };
  const shown = (e: Element) => { const r = e.getBoundingClientRect(); return e.getClientRects().length > 0 && r.width > 0 && r.height > 0; };
  if (shown(el)) { const r = el.getBoundingClientRect(); return { found: true, box: { x: r.left, y: r.top, w: r.width, h: r.height }, via: "input" }; }
  const label = (el.id ? document.querySelector(`label[for="${el.id}"]`) : null) ?? el.closest("label");
  if (label && shown(label)) {
    (globalThis as any).__abEl = label;
    const r = label.getBoundingClientRect();
    return { found: true, box: { x: r.left, y: r.top, w: r.width, h: r.height }, via: "label" };
  }
  return { found: true, box: null, via: null };
}

// ---------- the hands ----------

/** The input of one command in a window of its own: begin() activates the window and finds the pointer; end() leaves it. */
export class Hands {
  readonly tab: Tab;
  readonly timing: InputTiming;
  /** The pointer, in the page's client CSS px. */
  at: Point;
  private readonly x: XAccess | undefined;
  private readonly geo: Geo;
  private readonly state: PointerState;
  private moved = false;
  private lastKey = 0;

  private constructor(tab: Tab, at: Point, x: XAccess | undefined, geo: Geo, state: PointerState) {
    this.tab = tab;
    this.timing = tab.browser.settings.inputTiming;
    this.at = at;
    this.x = x;
    this.geo = geo;
    this.state = state;
  }

  private get log() { return this.tab.browser.settings.log; }
  private get name() { return this.tab.targetId.slice(0, 8); }

  /** Bring the page's window forward when the page has no focus, and find where the pointer is. Call it inside the input lock. */
  static async begin(tab: Tab): Promise<Hands> {
    const s = tab.browser.settings, t = s.inputTiming, state = readPointer(s);
    const { focus, geo } = await tab.evaluate(arm);
    let entry: Point | null = null;
    if (!focus) {
      await tab.send("Page.bringToFront");
      const deadline = Date.now() + t.activateMs;
      let focusedAt = 0;
      for (;;) {
        const p = await tab.evaluate(peek);
        if (p.focus && !focusedAt) focusedAt = Date.now();
        // The real pointer event comes with the window's activation, if the X pointer is over the window.
        if ((p.focus && p.entry) || (focusedAt && Date.now() - focusedAt > 150) || Date.now() > deadline) break;
        await sleep(20);
      }
      entry = await tab.evaluate(disarm);
      if (!focusedAt) s.log(`agent-browser: the page of tab ${tab.targetId.slice(0, 8)} has no focus ${t.activateMs / 1000} s after Page.bringToFront; the input goes on (its first press activates the window)`);
    }
    // The X pointer, where agent-browser may move it: the display is the agent browser's (the activation's real event
    // came where xdotool says the pointer is; that answer is kept for 5 minutes), and it holds the agent browser only
    // (checked for each command: another program's window can open at any time).
    let x = xAccess(s);
    if (x) {
      try {
        let verified = state.display?.name === x.display && Date.now() - state.display.at < 5 * 60_000 ? state.display.ok : undefined;
        if (entry && geo.dpr === 1) {
          const p = await xLocation(x), o = origin(geo);
          verified = Math.abs(p.x - o.x - entry.x) <= 3 && Math.abs(p.y - o.y - entry.y) <= 3;
          state.display = { name: x.display, ok: verified, at: Date.now() };
        }
        if (!verified || geo.dpr !== 1 || !(await ownDisplay(x))) x = undefined;
      } catch { x = undefined; }
    }
    let at = entry ?? state.pages[tab.targetId];
    if (!at && x) {
      try { const p = await xLocation(x), o = origin(geo); at = { x: p.x - o.x, y: p.y - o.y }; } catch { /* below */ }
    }
    at ??= { x: geo.iw * between([0.35, 0.65]), y: geo.ih * between([0.35, 0.65]) };
    at = { x: Math.min(Math.max(at.x, 0), Math.max(0, geo.iw - 1)), y: Math.min(Math.max(at.y, 0), Math.max(0, geo.ih - 1)) };
    return new Hands(tab, at, x, geo, state);
  }

  /** After the command: the X pointer goes to the path's end (when agent-browser may move it), and the page's last point is kept. */
  async end(): Promise<void> {
    if (this.moved && this.x) {
      const o = origin(this.geo);
      await this.x.run(["mousemove", String(Math.round(o.x + this.at.x)), String(Math.round(o.y + this.at.y))]).catch((e) => {
        this.log(`agent-browser: could not move the X pointer to the end of the path (${(e as Error).message.split("\n")[0]})`);
      });
    }
    this.state.pages[this.tab.targetId] = { x: Math.round(this.at.x * 100) / 100, y: Math.round(this.at.y * 100) / 100 };
    writePointer(this.tab.browser.settings, this.state);
  }

  private send(method: string, params: object) { return this.tab.send(method, params); }

  /**
   * A pointer path to `to` along ghost-cursor's curve (W: the target's smaller side): 12 to 60 points at about 60 a
   * second, in whole pixels as a mouse gives them, and no move that does not move (a real mouse sends none).
   */
  async moveTo(to: Point, width = 24): Promise<void> {
    to = { x: Math.round(to.x), y: Math.round(to.y) };
    const from = { x: Math.round(this.at.x), y: Math.round(this.at.y) };
    const legs = await planMove(from, to, width, Math.random);
    if (!legs.length) { this.at = to; return; }
    for (const leg of legs) leg.ms *= this.timing.moveScale;
    const total = legs.reduce((a, l) => a + l.ms, 0), n = Math.min(60, Math.max(12, Math.round(total / 16))), t0 = Date.now();
    let last = from;
    for (let i = 1; i <= n; i++) {
      const q = i === n ? to : pointAt(legs, (total * i) / n), p = { x: Math.round(q.x), y: Math.round(q.y) };
      if (p.x !== last.x || p.y !== last.y) {
        await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y, button: "none", buttons: 0 });
        last = p;
      }
      await sleep(t0 + (total * i) / n - Date.now());
    }
    this.at = to;
    this.moved = true;
  }

  /** The pointer moved to `p` by other input of the command (record's cursor): the X pointer follows it at the end. */
  movedTo(p: Point): void {
    this.at = { x: Math.round(p.x), y: Math.round(p.y) };
    this.moved = true;
  }

  /** A click where the pointer is: the pause on the target, then a press with force 0.5 and a release. */
  async press(): Promise<void> {
    await sleep(between(this.timing.settleMs));
    const { x, y } = this.at;
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1, force: 0.5 });
    await sleep(between(this.timing.pressMs));
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
  }

  /** A point of the box to click, in its middle 40% (`fx`, `fy`: other parts), inside the viewport. */
  private aim(b: Box, fx: [number, number] = [0.3, 0.7], fy: [number, number] = [0.3, 0.7]): Point {
    const x = b.x + b.w * between(fx), y = b.y + b.h * between(fy);
    return { x: Math.min(Math.max(x, 1), this.geo.iw - 2), y: Math.min(Math.max(y, 1), this.geo.ih - 2) };
  }

  /**
   * Bring the kept element into view with the wheel, as a person scrolls: the pointer goes over the element's scroller
   * if it is not there, then 100 px notches. At most 3 rounds; when the element does not come into view, the old way
   * (a script's scrollIntoView) and a log line. Its box in view.
   */
  async intoView(what: string): Promise<Box> {
    let last: string | undefined;
    for (let round = 0; round < 3; round++) {
      const v = await this.tab.evaluate(view, this.at.x, this.at.y);
      if (!v) throw new Error(`${what} is no longer on the page`);
      if (!v.dx && !v.dy) return v.box;
      const key = JSON.stringify(v.box);
      if (key === last || !v.wheelAt) break; // the wheel moved nothing, or no point scrolls it
      last = key;
      if (Math.hypot(v.wheelAt.x - this.at.x, v.wheelAt.y - this.at.y) > 2) await this.moveTo(v.wheelAt, 80);
      for (const [delta, axis] of [[v.dy, "y"], [v.dx, "x"]] as const) {
        for (let i = 0, notches = Math.min(80, Math.ceil(Math.abs(delta) / 100)); i < notches; i++) {
          const d = Math.sign(delta) * 100;
          await this.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: this.at.x, y: this.at.y, deltaX: axis === "x" ? d : 0, deltaY: axis === "y" ? d : 0 });
          await sleep(between(this.timing.wheelMs));
        }
      }
      await sleep(150); // a smooth scroll ends after its last notch
    }
    const v = await this.tab.evaluate(view, this.at.x, this.at.y);
    if (!v) throw new Error(`${what} is no longer on the page`);
    if (!v.dx && !v.dy) return v.box;
    const b = v.box;
    if (b.y + b.h > 0 && b.y < this.geo.ih && b.x + b.w > 0 && b.x < this.geo.iw) return b; // a part of it is in view: enough to click
    this.log(`agent-browser: the wheel did not bring ${what} into view in tab ${this.name}; a script scrolled it (a site can see a scroll with no wheel)`);
    await this.tab.evaluate(scriptScroll);
    const after = await this.tab.evaluate(view, this.at.x, this.at.y);
    if (!after) throw new Error(`${what} is no longer on the page`);
    return after.box;
  }

  /** Click the element that `selector` names (or, with `text`, the one whose text matches): into view, a path, a press. */
  async click(selector: string | null, text?: { text: string; within?: string }): Promise<void> {
    const box = text ? await this.tab.evaluate(pickText, text.text, text.within ?? null) : await this.tab.evaluate(pick, selector!);
    const what = text ? `the element with text "${text.text}"` : `element ${selector}`;
    if (!box) throw new Error(text ? `no visible element with text "${text.text}"` : `no element matches ${selector}`);
    if (!text && (box.w === 0 || box.h === 0)) throw new Error(`element ${selector} is not visible`);
    const b = await this.intoView(what);
    await this.moveTo(this.aim(b), Math.min(b.w, b.h));
    await this.press();
  }

  /** Move the pointer over the element (hover menus): into view, a path, no press. */
  async hover(selector: string): Promise<void> {
    const box = await this.tab.evaluate(pick, selector);
    if (!box) throw new Error(`no element matches ${selector}`);
    if (box.w === 0 || box.h === 0) throw new Error(`element ${selector} is not visible`);
    const b = await this.intoView(`element ${selector}`);
    await this.moveTo(this.aim(b), Math.min(b.w, b.h));
  }

  /** A click at a point of the viewport (CSS px): a path there, a press. */
  async clickAt(x: number, y: number): Promise<void> {
    await this.moveTo({ x, y });
    await this.press();
  }

  /**
   * The focus for `type --into`: a click on the field, as a person gives it (no el.focus()). A field that has the focus
   * gets none, as el.focus() changed nothing there. The click goes where el.focus() would put the caret (the left end
   * for the start, the right end for the end), and keys put the caret there when the click did not (Home, End, the
   * arrows; Control+Home in a textarea); a caret in the middle of a long text, or a range, is set by a script (a log
   * line). A field with no box, or one that the click does not focus (another element covers it), gets el.focus(), with
   * a log line.
   */
  async focusField(selector: string): Promise<void> {
    const f = await this.tab.evaluate(pickField, selector);
    if (!f.found) throw new Error(`no element matches ${selector}`);
    if (f.focused) return;
    const fallback = async (why: string) => {
      this.log(`agent-browser type: ${why}; it gets the focus from a script (el.focus()), which a site can see`);
      await this.tab.evaluate(scriptFocus);
    };
    if (!f.box) return fallback(`${selector} has no box to click`);
    const b = await this.intoView(`field ${selector}`);
    const [a, z] = f.want, start = a === 0 && z === 0, end = a === f.len && z === f.len;
    // The left end for the start, the right end for the end (past the text, when it is shorter than the box); in an
    // empty field any point gives the caret its one place.
    const fx: [number, number] = f.len === 0 && f.kind !== "editable" ? [0.25, 0.75]
      : start || f.kind === "editable" ? [2 / b.w, Math.min(0.5, 5 / b.w)] : end ? [Math.max(0.5, 1 - 10 / b.w), Math.max(0.5, 1 - 4 / b.w)] : [0.3, 0.7];
    const fy: [number, number] = f.kind === "textarea" || f.kind === "editable" ? [Math.min(0.5, 6 / b.h), Math.min(0.5, 12 / b.h)] : [0.35, 0.65];
    await this.moveTo(this.aim(b, fx, fy), Math.min(b.w, b.h));
    await this.press();
    const after = await this.tab.evaluate(fieldState);
    if (!after.focused) return fallback(`the click on ${selector} did not focus it`);
    if (f.kind !== "input" && f.kind !== "textarea") return;
    if (!after.caret || (after.caret[0] === a && after.caret[1] === z)) return;
    const home = f.kind === "textarea" ? "Control+Home" : "Home", endKey = f.kind === "textarea" ? "Control+End" : "End";
    if (start) return this.key(parseKey(home));
    if (end) return this.key(parseKey(endKey));
    if (z <= 64) {
      await this.key(parseKey(home));
      for (let i = 0; i < a; i++) await this.key(parseKey("ArrowRight"));
      for (let i = a; i < z; i++) await this.key(parseKey("Shift+ArrowRight"));
      return;
    }
    this.log(`agent-browser type: the caret of ${selector} is set by a script (setSelectionRange), to where el.focus() would put it`);
    await this.tab.evaluate(scriptCaret, a, z);
  }

  /** One key: down, held a short time, up. */
  async key(k: KeyEvent): Promise<void> {
    await sendKey(this.tab, k, between(this.timing.holdMs));
  }

  /** `press`: Tab.press's own key events (a keyDown with the key's text, and a keyUp), held down a short time. */
  async keyPress(fields: object, text?: string): Promise<void> {
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", ...fields, text });
    await sleep(between(this.timing.holdMs));
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...fields });
  }

  /** One character as a key-event pair, keyMs after the last one's press; a character with no US key as inserted text. */
  async typeChar(ch: string): Promise<void> {
    if (this.lastKey) await sleep(this.lastKey + between(this.timing.keyMs) - Date.now());
    this.lastKey = Date.now();
    if (ch === "\n") return this.key(parseKey("Enter"));
    if (ch === "\t") return this.key(parseKey("Tab"));
    const k = charKey(ch);
    if (k) return this.key(k);
    await this.send("Input.insertText", { text: ch });
  }

  /**
   * setFiles as a person picks files: a click on the file input (or on its label, for a hidden input) opens Chrome's
   * file chooser, which a session intercepts (Page.setInterceptFileChooserDialog: no dialog opens), and the files go to
   * the input that the chooser names. An input with no box and no label gets the files with no click, as before (a log
   * line: a site can see files with no click). False: that last case, for the caller to do.
   */
  async setFiles(selector: string, files: string[]): Promise<boolean> {
    const t = await this.tab.evaluate(pickFile, selector);
    if (!t.found) throw new Error(`no element matches ${selector}`);
    if (!t.box) {
      this.log(`agent-browser setFiles: ${selector} has no box to click and no label; the files go to it with no click (a site can see that)`);
      return false;
    }
    const conn = this.tab.browser.conn, stop = new AbortController();
    await this.tab.send("Page.setInterceptFileChooserDialog", { enabled: true });
    try {
      const opened = conn.waitForEvent<{ backendNodeId: number }>("Page.fileChooserOpened", { sessionId: this.tab.sessionId, timeoutMs: 5000, signal: stop.signal });
      opened.catch(() => {});
      const b = await this.intoView(t.via === "label" ? `the label of ${selector}` : `file input ${selector}`);
      await this.moveTo(this.aim(b), Math.min(b.w, b.h));
      await this.press();
      const ev = await opened.catch(() => { throw new Error(`setFiles: the click on ${selector}${t.via === "label" ? "'s label" : ""} opened no file chooser in 5 s`); });
      await this.tab.send("DOM.setFileInputFiles", { files, backendNodeId: ev.backendNodeId });
      return true;
    } finally {
      stop.abort();
      await this.tab.send("Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => {});
    }
  }
}

/** The page's content origin on the screen: Chrome draws its own frame on a display with no window manager. */
function origin(g: Geo): Point {
  const side = Math.round((g.ow - g.iw) / 2);
  return { x: g.sx + side, y: g.sy + g.oh - g.ih - side };
}
