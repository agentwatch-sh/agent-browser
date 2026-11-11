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
//   the X pointer (xdotool on the agent browser's own display: no other program's window on it), the last step of
//   each path is the X pointer's move there, inside the lock, so the next activation enters where the page last saw
//   the pointer. Measured on taylor (test/live/anti-detect/extra.ts --exp pointer): with the X pointer moved to each
//   path's end, 0 jumps and 0 position changes that the movement does not explain, as for a person who switches
//   windows; with the X pointer never moved, 0 jumps but each later activation entered at the X pointer's one point,
//   a position change that the movement does not explain (2 in each window per 3 activations). The whole design
//   (run.ts design, 4 runs): 0 and 0.
// - The shape: the generator of src/human/ (board ab-t30.3; the input design,
//   docs/superpowers/specs/2026-11-10-vanilla-playwright-human-input-design.md, sections 10.1 and 11.2), the one that
//   agent mode's input stage uses too: a path of Fitts's time along an arc, with end corrections, an overshoot past
//   500 px, a tremor and a slow approach to a small target, one sample each 8 ms in whole px, sent by the CDP player at
//   its time with no wait for each answer, with a person's timestamp; a pause on the target, a press with force 0.5 at a
//   spread point of the element; the wheel brings an element into view (120 px a notch); one person for each endpoint
//   scope (pointer.json keeps its seed). The keys follow the keyboard model of src/human/keys.ts (board ab-t30.4; the
//   design's section 10.2): a person's hold for each key, the time from one press to the next with its letter-pair
//   part, pauses at word and line ends, a slow drift of the speed, rollover (the next press before this key's release),
//   a real Shift key before a capital, chords with their modifier keys, the fast end after 12 s of a run, each event with
//   a person's timestamp; a field gets the focus by a click, and the caret goes where el.focus() would have put it; a file
//   input gets a click that opens Chrome's file chooser (intercepted), and the files go to the input that it names.
//   The times are the inputTiming option (options.ts, INPUT_TIMING): its ranges bound the generator's draws.

import { AsyncLocalStorage } from "node:async_hooks";
import { randomInt } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Tab } from "./browser.ts";
import { displayOf, onlyWindowsOf, pidOf, type DisplayInfo, type XAccess } from "./display.ts";
import { AgentBrowserError } from "./errors.ts";
import { withFileLock } from "./lock.ts";
import { statePath, type InputTiming, type Settings } from "./options.ts";
import { keyFields } from "./browser.ts";
import { charKey, macCommands, parseKey, type Point } from "./record.ts";
import { CdpPlayer, systemClock } from "./human/cdp-player.ts";
import { KeyStream, type Key, type KeyEv } from "./human/keys.ts";
import { planPath, startPoint } from "./human/path.ts";
import { paramsFor, personFor, type Person } from "./human/person.ts";
import { force, holdMs, pauseMs, spreadPoint } from "./human/press.ts";
import type { Random } from "./human/random.ts";
import { notches, notchGapMs } from "./human/wheel.ts";
import { playX } from "./human/x-player.ts";

export const INPUT_LOCK = "input.lock", POINTER_FILE = "pointer.json";

/** The input locks that this call chain holds (by path): withInputLock is reentrant in one chain, never across chains. */
const held = new AsyncLocalStorage<ReadonlySet<string>>();

/**
 * Run `fn` while this process holds the agent browser's input lock (the state folder's input.lock). One lock for the
 * pages of every site (board task ab-v16.46: the operator's choice on ab-1bi, after one lock per site on ab-hbt showed
 * each page alone a blur and a focus during its own typing while an agent on another site typed), and for every
 * endpoint scope behind agent mode's endpoint: only the tab record is per endpoint scope (options.ts, recordDir;
 * ab-v16.58), never input.lock or pointer.json. Reentrant within
 * one call chain of one process (Tab.withInput around the caller's own Tab.click); another chain, or another process,
 * waits for it, up to lockWaitMs, or up to `deadline` (epoch ms) when that comes first (Tab.waitFor's timeout);
 * `signal` ends that wait at once (Tab.waitFor's condition held: review-52 note 3).
 */
export async function withInputLock<T>(s: Settings, fn: () => Promise<T>, opts: { deadline?: number; signal?: AbortSignal } = {}): Promise<T> {
  const path = statePath(s, INPUT_LOCK), mine = held.getStore();
  if (mine?.has(path)) return fn();
  const wait = s.inputTiming.lockWaitMs, until = Math.min(Date.now() + wait, opts.deadline ?? Infinity);
  return withFileLock(path, until, () => held.run(new Set([...(mine ?? []), path]), fn),
    until < Date.now() + wait ? "the input lock (another input command of this agent browser held it until the wait's timeout)"
      : `the input lock (another input command of this agent browser held it for ${wait / 1000} s)`, { signal: opts.signal });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const between = ([a, b]: [number, number]) => a + (b - a) * Math.random();
/**
 * The least time between two moves, whatever inputTiming.moveScale is (ms): a page's event (a navigation off the
 * allowlist) is read between two moves, so the guard stops the path at the next one.
 */
export const MIN_MOVE_GAP_MS = 2;

// ---------- the pointer's state ----------

/**
 * The last point of each page's pointer (client CSS px), what is known of the X display (a cdpUrl's display, verified
 * by an activation), and when a log line last named why a display is not used (at most one each 5 minutes). Written
 * inside the input lock.
 */
type PointerState = { pages: Record<string, Point>; display?: { name: string; ok: boolean; at: number }; notices?: Record<string, number>; seed?: number };

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

/** A log line, at most once each 5 minutes for one key (the state is written at the command's end). */
function notice(s: Settings, st: PointerState, key: string, line: string) {
  const at = st.notices?.[key] ?? 0;
  if (Date.now() - at < 5 * 60_000) return;
  (st.notices ??= {})[key] = Date.now();
  s.log(line);
}

// ---------- the display (display.ts) ----------

/** The X pointer on the screen. */
async function xLocation(x: XAccess): Promise<Point> {
  const v = Object.fromEntries((await x.run(["getmouselocation", "--shell"])).split("\n").map((l) => l.split("=")));
  const p = { x: Number(v.X), y: Number(v.Y) };
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) throw new Error("xdotool getmouselocation gave no position");
  return p;
}

// ---------- the page side (our isolated world) ----------

type Geo = { sx: number; sy: number; ow: number; oh: number; iw: number; ih: number; dpr: number };

/**
 * The page's focus, whether it is in front of its window (not hidden), and its geometry; when it needs the activation
 * (no focus, or hidden behind another tab of its window), a listener for the real pointer event that the activation gives.
 */
function arm(): { focus: boolean; hidden: boolean; geo: Geo } {
  const g = globalThis as any;
  const geo = { sx: screenX, sy: screenY, ow: outerWidth, oh: outerHeight, iw: innerWidth, ih: innerHeight, dpr: devicePixelRatio };
  const focus = document.hasFocus(), hidden = document.visibilityState === "hidden";
  if (g.__abEntryOff) g.__abEntryOff();
  g.__abEntry = null;
  if (!focus || hidden) {
    const types = ["mousemove", "pointermove", "mouseover", "pointerover"];
    const f = (e: MouseEvent) => { if (e.isTrusted && !g.__abEntry) g.__abEntry = { x: e.clientX, y: e.clientY }; };
    for (const t of types) document.addEventListener(t, f as EventListener, { capture: true, passive: true });
    g.__abEntryOff = () => { for (const t of types) document.removeEventListener(t, f as EventListener, { capture: true }); g.__abEntryOff = null; };
  }
  return { focus, hidden, geo };
}
function peek(): { focus: boolean; entry: Point | null } { return { focus: document.hasFocus() && document.visibilityState === "visible", entry: (globalThis as any).__abEntry ?? null }; }
function disarm(): Point | null { const g = globalThis as any; if (g.__abEntryOff) g.__abEntryOff(); return g.__abEntry ?? null; }

type Box = { x: number; y: number; w: number; h: number };

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

/** The element at the point is the kept one (the file input or its label), or inside it: no other element covers it. */
function hits(x: number, y: number): boolean {
  const el = (globalThis as any).__abEl as Element | null, at = document.elementFromPoint(x, y);
  return !!el && !!at && (at === el || el.contains(at));
}

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

/**
 * The input of one command in a window of its own: begin() activates the window and finds the pointer; end() keeps
 * the pointer's place. `guard` (Tab.byHand) throws when the page's main frame went to a page off the allowlist: it runs
 * before each input event, and the allowlist is read again before each press and each key.
 */
export class Hands {
  readonly tab: Tab;
  readonly timing: InputTiming;
  /** The pointer, in the page's client CSS px. */
  at: Point;
  /** Where the pointer is came from the page or the X pointer (not a guess): record starts its cursor there. */
  readonly known: boolean;
  private readonly x: XAccess | undefined;
  private readonly geo: Geo;
  private readonly state: PointerState;
  private readonly guard: () => void;
  /** The scope's person (one for each endpoint scope: design 10.4), the draws' source, and the CDP player. */
  readonly person: Person;
  private readonly random: Random = Math.random;
  private readonly player: CdpPlayer;
  private recordMoved = false;
  private keys = 0;
  /** The key run's stream (src/human/keys.ts), and its events that wait for their time (an early-answered release, the Shift release). */
  private keyStream: KeyStream | undefined;
  private keyQueue: { ev: KeyEv; commands?: string[] }[] = [];

  private constructor(tab: Tab, at: Point, known: boolean, x: XAccess | undefined, geo: Geo, state: PointerState, guard: () => void) {
    this.tab = tab;
    this.timing = tab.browser.settings.inputTiming;
    this.at = at;
    this.known = known;
    this.x = x;
    this.geo = geo;
    this.state = state;
    this.guard = guard;
    this.person = personOf(tab, state);
    const dev = this.person.params.device;
    this.player = new CdpPlayer((method, params) => this.tab.send(method, params), {
      clock: systemClock, latencyMs: dev.latencyMs, wholeMs: dev.wholeMsTimestamps, random: this.random, maxInFlight: dev.movesInFlight,
      scale: this.timing.moveScale, minGapMs: MIN_MOVE_GAP_MS, before: () => this.guard(),
    });
  }

  private get log() { return this.tab.browser.settings.log; }
  private get name() { return this.tab.targetId.slice(0, 8); }

  /**
   * Bring the page's window forward when the page has no focus or is hidden behind another tab of its window (a tab
   * switch, as a person's), and find where the pointer is. Call it inside the input lock, after the allowlist check.
   * A window page exists only on a display of the agent browser's own (AgentBrowser.windows, display.ts), so that no
   * operator's window or focus is ever touched.
   */
  static async begin(tab: Tab, guard: () => void = () => {}): Promise<Hands> {
    const s = tab.browser.settings, t = s.inputTiming, state = readPointer(s), mac = tab.browser.mac;
    // On the Mac (ab-v16.27) no window comes forward and no X pointer exists: the display check is Linux's.
    const disp: DisplayInfo = mac ? { own: false } : tab.browser.display ?? await displayOf(s);
    const { focus, hidden, geo } = await tab.evaluate(arm);
    let entry: Point | null = null;
    if (mac) {
      await tab.evaluate(disarm);
      // A page behind another tab of its window (the opener behind a site's popup tab) gets no input while it is hidden:
      // a person cannot reach it with no tab switch, and on the Mac every tab switch of CDP activates the agent Chrome.
      // It shows again about 1.0 s after that popup closed (the popup rule: the way back to the opener is the popup's close).
      if (hidden && !(await tab.waitShown())) {
        throw new AgentBrowserError("error", `tab ${tab.targetId.slice(0, 8)} is hidden behind another tab of its window (a site's popup tab?): on macOS agent-browser never switches tabs, because that brings the agent Chrome to the front; close the tab in front of it (${s.commandName} close <tab>), then retry: the page shows again about 1 s after that close`);
      }
    } else if ((!focus || hidden) && disp.own) {
      guard();
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
      if (!focusedAt) s.log(`agent-browser: the page of tab ${tab.targetId.slice(0, 8)} has no focus ${t.activateMs / 1000} s after Page.bringToFront; the input goes on without it (a press activates its window; keys alone can give two pages the focus)`);
    } else if (!focus || hidden) await tab.evaluate(disarm);
    // Why the X-pointer method is off, for a log line (review-47b note 5); undefined while it is on. The Mac has none.
    let off: string | undefined = mac ? undefined : !disp.x ? (s.cdpUrl ? "no DISPLAY of the agent browser's Xvfb in this process (over agentwatch's relay)" : "no xdotool on the agent browser's display")
      : geo.dpr !== 1 ? `a device pixel ratio of ${geo.dpr}` : undefined;
    let x = off || mac ? undefined : disp.x;
    if (x) {
      try {
        let pid = disp.chromePid === undefined ? undefined : String(disp.chromePid);
        if (pid === undefined) {
          // Behind cdpUrl the agent Chrome's pid is not known: the display is its own when the activation's real event
          // came where xdotool says the pointer is, and the focused window is the page's (its title). Kept for 5 minutes.
          const focusWin = (await x.run(["getwindowfocus"])).trim();
          let verified = state.display?.name === x.display && Date.now() - state.display.at < 5 * 60_000 ? state.display.ok : undefined;
          if (entry) {
            const p = await xLocation(x), o = origin(geo), title = await tab.evaluate(() => document.title);
            const name = (await x.run(["getwindowname", focusWin]).catch(() => "")).trim();
            verified = Math.abs(p.x - o.x - entry.x) <= 3 && Math.abs(p.y - o.y - entry.y) <= 3 && (!title || name.startsWith(title));
            state.display = { name: x.display, ok: verified, at: Date.now() };
          }
          if (verified) pid = (await pidOf(x, focusWin)) || undefined;
        }
        if (!pid) { off = "the display cannot be verified (no activation's pointer event where xdotool says the pointer is, or not the page's window)"; x = undefined; }
        else if (!(await onlyWindowsOf(x, pid))) {
          notice(s, state, `x-${x.display}`, `agent-browser: another program's window is on the display: agent-browser does not move the X pointer there (each path starts at the page's own pointer event)`);
          x = undefined;
        }
      } catch (e) { off = `xdotool failed (${(e as Error).message.split("\n")[0]})`; x = undefined; }
    }
    // Over agentwatch's relay the relay has the daemon move the X pointer at each activation (board ab-v16.71; the agent
    // pointer design, docs/superpowers/specs/2026-11-06-agent-pointer-move-design.md, section 5): the page enters at its own last point.
    if (off && s.cdpUrl && !disp.x) notice(s, state, `x-off-relay`, "agent-browser: the X-pointer method is off over agentwatch's relay: the relay has the daemon move the X pointer at each activation (a daemon with the pointer ops), along a path from where the page under the pointer last saw it, and each path of agent-browser starts at the page's own pointer event");
    else if (off) notice(s, state, `x-off-${off}`, `agent-browser: the X-pointer method is off (${off}): each path starts at the page's own pointer event, and a window that comes forward can show the pointer at another point`);
    let at = entry ?? state.pages[tab.targetId];
    if (!at && x) {
      try { const p = await xLocation(x), o = origin(geo); at = { x: p.x - o.x, y: p.y - o.y }; } catch { /* below */ }
    }
    const known = !!at;
    // No last point and no X pointer: a random point of the viewport's middle 30% to 70% (design 10.1).
    at ??= startPoint(geo.iw, geo.ih, Math.random, paramsFor(mac ? "darwin" : "linux").path.start.middle);
    at = { x: Math.min(Math.max(at.x, 0), Math.max(0, geo.iw - 1)), y: Math.min(Math.max(at.y, 0), Math.max(0, geo.ih - 1)) };
    return new Hands(tab, at, known, x, geo, state, guard);
  }

  /**
   * After the command: the page's last point is kept. After a take of record (its own CDP moves), the X pointer goes
   * to the cursor's end; after a path of this file it is there already (the path's last step).
   */
  async end(): Promise<void> {
    // The key run's last releases first. A page that left the allowlist gets none: the guard refuses each event.
    await this.endKeys().catch(() => {});
    if (this.recordMoved && this.x) await this.xMove(this.at);
    this.state.pages[this.tab.targetId] = { x: Math.round(this.at.x * 100) / 100, y: Math.round(this.at.y * 100) / 100 };
    writePointer(this.tab.browser.settings, this.state);
  }

  /**
   * Move the X pointer to a point of the page. Chrome gives the page that real move with its movement from the page's
   * last point (measured: a move to the point where a CDP path ended had movement 0), so as the last step of a path
   * it is one more step of that path, not a jump. True when it moved.
   */
  private async xMove(p: Point): Promise<boolean> {
    const o = origin(this.geo), at = { x: Math.round(p.x), y: Math.round(p.y) };
    this.guard();
    try {
      // The X player (src/human/x-player.ts): one point is one xdotool move.
      await playX((args) => this.x!.run(args), [{ ...at, t: 0 }], (q) => ({ x: o.x + q.x, y: o.y + q.y }));
      return true;
    } catch (e) {
      this.log(`agent-browser: could not move the X pointer (${(e as Error).message.split("\n")[0]}); the input goes on with CDP alone`);
      return false;
    }
  }

  /** An input event to the page, after the guard: never one to a page that left the allowlist. */
  private send(method: string, params: object) {
    this.guard();
    return this.tab.send(method, params);
  }

  /**
   * A pointer path to `to` (W: the target's smaller side), planned by the generator (src/human/path.ts): one sample each
   * 8 ms in whole px with no sample that does not move, sent by the CDP player at its time with no wait for the answer
   * of the move before it (times inputTiming.moveScale). Where agent-browser may move the X pointer, the path's last step
   * is the X pointer's move there (xMove): the pointer is then where the page saw it last, with no extra move after the
   * press. When the page answers none of 8 moves (a dialog), the path stops and one move goes to `to`.
   */
  async moveTo(to: Point, width = 24): Promise<void> {
    await this.endKeys(); // a pointer path after keys waits for their releases (design 4.5)
    to = { x: Math.round(to.x), y: Math.round(to.y) };
    const from = { x: Math.round(this.at.x), y: Math.round(this.at.y) };
    const { samples } = planPath(from, to, width, this.person, this.random);
    if (!samples.length) { this.at = to; return; }
    const last = samples[samples.length - 1], viaX = !!this.x, t0 = systemClock.now();
    const r = await this.player.moves(viaX ? samples.slice(0, -1) : samples);
    if (r.stopped) {
      this.log(`agent-browser: tab ${this.name} answered none of ${this.person.params.device.movesInFlight} moves; the path stops, and one move goes to its end`);
      await this.player.event("Input.dispatchMouseEvent", { type: "mouseMoved", x: to.x, y: to.y, button: "none", buttons: 0 });
    } else if (viaX) {
      await sleep(t0 + last.t * this.timing.moveScale - systemClock.now());
      if (!(await this.xMove(last))) await this.player.event("Input.dispatchMouseEvent", { type: "mouseMoved", x: last.x, y: last.y, button: "none", buttons: 0 });
    }
    this.at = to;
  }

  /** The pointer moved to `p` by other input of the command (record's cursor): the X pointer follows it at the end. */
  movedTo(p: Point): void {
    this.at = { x: Math.round(p.x), y: Math.round(p.y) };
    this.recordMoved = true;
  }

  /**
   * A click where the pointer is: the pause on the target (design 10.1: a lognormal, median 140 ms, from 80 to 400 ms,
   * within inputTiming.settleMs), the allowlist read again, then a press with force 0.5, held a person's time (a
   * lognormal, median 100 ms, from 60 to 180 ms, within inputTiming.pressMs) from the press's send, and a release; each
   * event with a person's timestamp. `before` (setFiles' second hit test) can still stop it after the pause: false, no
   * press.
   */
  async press(before?: () => Promise<boolean>): Promise<boolean> {
    await this.endKeys();
    await sleep(pauseMs(this.person, this.random, this.timing.settleMs));
    this.guard();
    await this.tab.assertAllowed();
    if (before && !(await before())) return false;
    this.guard();
    const { x, y } = this.at, hold = holdMs(this.person, this.random, this.timing.pressMs), sent = systemClock.now();
    await this.player.event("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1, force: force(this.person) });
    await sleep(sent + hold - systemClock.now()); // the hold counts from the press's send, not from its answer (C11)
    await this.player.event("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
    return true;
  }

  /** A point of the box to click, in its middle 40% (`fx`, `fy`: other parts), inside the viewport. */
  private aim(b: Box, fx: [number, number] = [0.3, 0.7], fy: [number, number] = [0.3, 0.7]): Point {
    const x = b.x + b.w * between(fx), y = b.y + b.h * between(fy);
    return this.inside({ x, y });
  }
  private inside(p: Point): Point { return { x: Math.min(Math.max(p.x, 1), this.geo.iw - 2), y: Math.min(Math.max(p.y, 1), this.geo.ih - 2) }; }

  /**
   * The press point of the kept element's box: a person's spread around its middle (src/human/press.ts: a normal offset
   * with a standard deviation of 1/8 of the smaller side, at most 1/4 of it), inside the viewport, when the element is
   * at that point (a hit test); else its middle.
   */
  private async spread(b: Box): Promise<Point> {
    const p = this.inside(spreadPoint(b, this.person, this.random));
    if (await this.tab.evaluate(hits, p.x, p.y)) return p;
    return this.inside({ x: Math.round(b.x + b.w / 2), y: Math.round(b.y + b.h / 2) });
  }

  /**
   * Bring the kept element into view with the wheel, as a person scrolls: the pointer goes over the element's scroller
   * if it is not there, then notches of 120 px (X11's notch; src/human/wheel.ts: the count rounds half up, at least one),
   * with a person's gaps. At most 3 rounds; when the element does not come into view, the old way (a script's
   * scrollIntoView) and a log line. Its box in view.
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
      const px = this.person.params.wheel.notchPx;
      for (const [delta, axis] of [[v.dy, "y"], [v.dx, "x"]] as const) {
        for (let i = 0, n = Math.min(80, Math.abs(notches(delta, 0, px).count)); i < n; i++) {
          const d = Math.sign(delta) * px;
          await this.player.event("Input.dispatchMouseEvent", { type: "mouseWheel", x: Math.round(this.at.x), y: Math.round(this.at.y), deltaX: axis === "x" ? d : 0, deltaY: axis === "y" ? d : 0 });
          await sleep(notchGapMs(this.person, this.random, this.timing.wheelMs));
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
    await this.moveTo(await this.spread(b), Math.min(b.w, b.h));
    await this.press();
  }

  /** Move the pointer over the element (hover menus): into view, a path, no press. */
  async hover(selector: string): Promise<void> {
    const box = await this.tab.evaluate(pick, selector);
    if (!box) throw new Error(`no element matches ${selector}`);
    if (box.w === 0 || box.h === 0) throw new Error(`element ${selector} is not visible`);
    const b = await this.intoView(`element ${selector}`);
    await this.moveTo(await this.spread(b), Math.min(b.w, b.h));
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
      this.guard();
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
    this.guard(); // the field's click can take the page off the allowlist: no code of ours runs there after it
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

  /** The page is still on the allowlist: the key run's releases, the guard, then the list read again (Tab.assertAllowed). */
  async check(): Promise<void> {
    await this.endKeys();
    this.guard();
    await this.tab.assertAllowed();
    this.guard();
  }

  /** Before a key: the guard, and the allowlist read again before the first key and each 16th. */
  private async beforeKey(): Promise<void> {
    this.guard();
    if (this.keys++ % 16 === 0) { await this.tab.assertAllowed(); this.guard(); }
  }

  /** The key run's stream: inputTiming's holdMs bounds each hold, and keyMs each time from one press to the next. */
  private get keysOf(): KeyStream {
    return this.keyStream ??= new KeyStream(this.person, this.random, { holdMs: this.timing.holdMs, keyMs: this.timing.keyMs });
  }

  /** CDP's fields of a key event: keyFields (a function key stays in the page), the text of a press, a Shift's or modifier's location, on macOS its editing commands. */
  private keyParams(ev: KeyEv, commands?: string[]): Record<string, unknown> {
    return { type: ev.type, ...keyFields(ev.key, ev.code, ev.keyCode, ev.modifiers), ...(ev.location ? { location: ev.location } : {}),
      ...(ev.type !== "keyUp" && ev.text ? { text: ev.text, unmodifiedText: ev.text } : {}), ...(commands?.length ? { commands } : {}) };
  }

  /**
   * The queued key events and `evs`, in time order, each at its time through the CDP player (the guard before each one, a
   * person's timestamp), up to `until`: a later event (a release after the next press: rollover) stays queued.
   */
  private async playKeys(evs: { ev: KeyEv; commands?: string[] }[], until = Infinity): Promise<void> {
    this.keyQueue.push(...evs);
    this.keyQueue.sort((a, b) => a.ev.t - b.ev.t);
    while (this.keyQueue.length && this.keyQueue[0].ev.t <= until) {
      const { ev, commands } = this.keyQueue.shift()!;
      await sleep(ev.t - systemClock.now());
      await this.player.event("Input.dispatchKeyEvent", this.keyParams(ev, commands));
    }
  }

  /**
   * One key by the keyboard model (src/human/keys.ts): a Shift or a chord's modifiers when the key needs them, the press at
   * its time, the release after the key's hold. When the next key can overlap (the early answer of design 4.5), the
   * release stays queued and the next key's press can come before it. `commands`: macOS's editing commands of the key.
   */
  async key(k: Key, commands = true): Promise<void> {
    await this.beforeKey();
    const s = this.keysOf, cmds = commands && process.platform === "darwin" ? macCommands(k) : undefined;
    const press = s.next(k, systemClock.now());
    await this.playKeys(press.map((ev) => ({ ev, commands: ev.own ? undefined : cmds })), press.at(-1)!.t);
    const r = s.release(k, systemClock.now());
    if (r.early) this.keyQueue.push(...r.events.map((ev) => ({ ev })));
    else await this.playKeys(r.events.map((ev) => ({ ev })));
  }

  /** The end of a key run: every queued release and the release of the stream's own Shift. Every input that is not a key comes after it (design 4.5). */
  async endKeys(): Promise<void> {
    if (!this.keyStream && !this.keyQueue.length) return;
    await this.playKeys((this.keyStream?.end(systemClock.now()) ?? []).map((ev) => ({ ev })));
  }

  /** `press`: Tab.press's own key (a keyDown with the key's text, and a keyUp), held a person's time, as a run of its own. */
  async keyPress(fields: object, text?: string): Promise<void> {
    const f = fields as { key: string; code: string; windowsVirtualKeyCode: number };
    await this.key({ key: f.key, code: f.code, keyCode: f.windowsVirtualKeyCode, ...(text !== undefined ? { text } : {}), modifiers: 0, type: "keyDown" }, false);
    await this.endKeys();
  }

  /** One character as a key by the keyboard model; a character with no US key as inserted text, after the run's releases, one interval after the last press. */
  async typeChar(ch: string): Promise<void> {
    if (ch === "\n") return this.key(parseKey("Enter"));
    if (ch === "\t") return this.key(parseKey("Tab"));
    const k = charKey(ch);
    if (k) return this.key(k);
    await this.beforeKey();
    const r = this.keysOf.insert(systemClock.now());
    await this.playKeys(r.events.map((ev) => ({ ev })));
    await sleep(r.t - systemClock.now());
    await this.send("Input.insertText", { text: ch });
  }

  /**
   * setFiles as a person picks files: a click on the file input (or on its label, for a hidden input) opens Chrome's
   * file chooser, which a session intercepts (Page.setInterceptFileChooserDialog: no dialog opens), and the files go to
   * the input that the chooser names. An input with no box and no label, and a click that opens no chooser in 2 s
   * (another element covers the input), give the files with no click, as before, with a log line (a site can see
   * files with no click). False: those cases, for the caller to do.
   */
  async setFiles(selector: string, files: string[]): Promise<boolean> {
    const t = await this.tab.evaluate(pickFile, selector);
    if (!t.found) throw new Error(`no element matches ${selector}`);
    if (!t.box) {
      this.log(`agent-browser setFiles: ${selector} has no box to click and no label; the files go to it with no click (a site can see that)`);
      return false;
    }
    const conn = this.tab.browser.conn, stop = new AbortController();
    const what = t.via === "label" ? `the label of ${selector}` : `file input ${selector}`;
    this.guard();
    await this.tab.send("Page.setInterceptFileChooserDialog", { enabled: true });
    try {
      const b = await this.intoView(what);
      const at = this.inside(spreadPoint(b, this.person, this.random));
      await this.moveTo(at, Math.min(b.w, b.h));
      // A hit test of the click point: when another element (a frame, say) covers the input, the click would reach it,
      // and its chooser is not this input's (review-47b). Then no click, and the files go the old way.
      if (!(await this.tab.evaluate(hits, at.x, at.y))) {
        this.log(`agent-browser setFiles: another element covers ${selector} at the click's point; the files go to it with no click (a site can see that)`);
        return false;
      }
      // The chooser's wait starts after the wheel and the path, at the press (review-47b: an input below the fold).
      const opened = conn.waitForEvent<{ backendNodeId: number }>("Page.fileChooserOpened", { sessionId: this.tab.sessionId, timeoutMs: 2000, signal: stop.signal });
      opened.catch(() => {});
      // A second hit test just before the press: an element (a frame) can move over the input in the pause (review-47c).
      if (!(await this.press(() => this.tab.evaluate(hits, at.x, at.y)))) {
        this.log(`agent-browser setFiles: another element covers ${selector} at the click's point; the files go to it with no click (a site can see that)`);
        return false;
      }
      const ev = await opened.catch(() => undefined);
      if (!ev) {
        this.log(`agent-browser setFiles: the click on ${selector}${t.via === "label" ? "'s label" : ""} opened no file chooser; the files go to it with no click (a site can see that)`);
        return false;
      }
      this.guard();
      await this.tab.assertAllowed();
      try {
        // The chooser must be the named input's, never another input's (an off-list frame's input over this one).
        const { root } = await this.tab.send("DOM.getDocument", { depth: 0 });
        const { nodeId } = await this.tab.send("DOM.querySelector", { nodeId: root.nodeId, selector });
        const own = nodeId ? (await this.tab.send("DOM.describeNode", { nodeId })).node.backendNodeId : undefined;
        if (own !== ev.backendNodeId) {
          this.log(`agent-browser setFiles: the click on ${selector} opened another input's file chooser; the files go to ${selector} with no chooser (a site can see that)`);
          return false;
        }
        this.guard();
        await this.tab.send("DOM.setFileInputFiles", { files, backendNodeId: ev.backendNodeId });
      } catch (e) {
        // The page can go to a new page as the chooser opens: then the refusal, not the DOM call's own error.
        this.guard();
        await this.tab.assertAllowed();
        throw e;
      }
      return true;
    } finally {
      stop.abort();
      await this.tab.send("Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => {});
    }
  }
}

/**
 * The person of the command's endpoint scope (design 10.4): drawn from the scope's name and a seed that pointer.json
 * keeps for the state folder's life (made at random on its first use), so the commands of one scope move as one person
 * and two scopes as two. Direct mode is the scope "".
 */
function personOf(tab: Tab, state: PointerState): Person {
  const s = tab.browser.settings;
  if (typeof state.seed !== "number" || !Number.isInteger(state.seed)) state.seed = randomInt(2 ** 31);
  return personFor(s.tabScope ?? "", state.seed, paramsFor(tab.browser.mac ? "darwin" : "linux"));
}

/** The page's content origin on the screen: Chrome draws its own frame on a display with no window manager. */
function origin(g: Geo): Point {
  const side = Math.round((g.ow - g.iw) / 2);
  return { x: g.sx + side, y: g.sy + g.oh - g.ih - side };
}
