// The input stage: the pointer part (board ab-t30.9; the input design,
// docs/superpowers/specs/2026-11-10-vanilla-playwright-human-input-design.md, sections 4 to 6, and build task 5 of its
// section 14; contract C11 "The input stage (board ab-t30.6)", the master, with test/vectors/stage.json). A client writes
// plain Playwright, and the stage turns its pointer input into a person's input: a path from the page's last point at a
// device's rate, a pause, a press of a person's length, a person's gap between the presses of a double click, the hover's
// path around Playwright's hit-target check, the frame mapping, the recovery after a miss of that check, and the spread of
// the press point. It keeps what each call asks for (the point, the button, the click count, the modifiers).
//
// The stage is a module of the model (model.ts), between the tab's gate and the bridge: the model gives it each call that
// it takes (arrive), runs the call's step in the tab's gate (step), and gives it the answers of the calls that pass (saw)
// and Chrome's events (event). The stage sends its events and reads through its host (StagePage), so the input harness
// can run it on a pipe of its own. It uses the generator of src/human/ (no second generator) with the scope's person.
//
// The build switch (C11, the build switch): the stage stays off in the default path until board tasks ab-t30.9 to
// ab-t30.12 are all merged. STAGE_BUILD_ON is false; only the tests (the model's `stage` option) and the live rows (the
// relay's environment variable STAGE_TEST_ENV with the value "test") turn the stage on.
//
// Not in this part (C11 names them; their board tasks build them): the keys and the text (ab-t30.10: in this part a key
// that is no modifier of a click, and an Input.insertText, go as the client sent them, in the lock), the scroll and the
// wheel (ab-t30.11: a wheel event goes as it is, DOM.scrollIntoViewIfNeeded is not taken), and the calls that only a
// script makes (ab-t30.12: a move with a button down, the drag, the focus click).
//
// No log line and no count holds a point, a key or a text (C10's log rule).

import { CdpPlayer, systemClock, linuxStamp, macStamp, type Clock } from "../human/cdp-player.ts";
import { planLine, planPath, startPoint, type Pt, type Sample } from "../human/path.ts";
import type { Person } from "../human/person.ts";
import { doubleClickGapMs, force, holdMs, modifierAfterMs, pauseMs, pressPoint, type Box, type ElementKind } from "../human/press.ts";
import { draw, uniform, type Random } from "../human/random.ts";
import { GEOMETRY_WAIT_MS } from "./pointer.ts";
import { PLAYWRIGHT_FOCUS, startsAction } from "./policy.ts";

// ------------------------------------------------------------------ the switch and the constants (C11)

/** The build switch: off until board tasks ab-t30.9 to ab-t30.12 are all merged ("don't do this half baked"). */
export const STAGE_BUILD_ON = false;
/** The environment variable of a relay process that the live rows set to "test" (the tests' door to the switch). */
export const STAGE_TEST_ENV = "AGENT_BROWSER_INPUT_STAGE";
/** Whether the stage is on: the model's option (the tests), else the build switch, else the live rows' variable. */
export function stageOn(option?: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  if (option !== undefined) return option;
  return STAGE_BUILD_ON || env[STAGE_TEST_ENV] === "test";
}

/** C11's constants (first values). The rate, the latency and the in-flight bound are the person's (the parameter files). */
export const STAGE_MOVE_MS = 8;
export const STAGE_LATENCY_MS = [3, 5] as const;
export const STAGE_EVENT_WAIT_MS = 2000;
export const STAGE_MOVES_IN_FLIGHT = 8;
export const STAGE_NOTCH_PX = 120;
export const STAGE_TYPE_MAX_MS = 10000;
export const STAGE_RUN_SLOW_MS = 12000;
export const STAGE_ACTION_MAX_MS = 25000;
export const STAGE_SCROLL_ROUNDS = 4;
/** The recovery (C11, the hit-target check): the exit point is this far outside the boxes; the way around widens the kept box by this much. */
export const RECOVERY_EXIT_PX = 15;
export const AROUND_MARGIN_PX = 10;
/** At most this many recoveries in one action: the setups of one node, each within RETRY_MARK_MS of a miss of that node. */
export const RECOVERIES_MAX = 2;
/** A miss marks the tab for the next setup of its node within this time (Playwright retries at most 500 ms after a miss). */
export const RETRY_MARK_MS = 2000;
/** The kept quads and handles of a tab (a navigation of its main frame clears them). */
export const KEPT_MAX = 64;
/** A hover's action ends at Playwright's move: with no pointer input of the tab this long after the setup's answer, the rest goes and the lock is free. */
export const HOVER_WAIT_MS = 1000;
/** The default width of a target for Fitts's law when the stage knows no target (a plain mouse.move): input.ts's moveTo. */
const DEFAULT_WIDTH = 24;

// ------------------------------------------------------------------ Playwright's utility calls and the recognizers

/** Playwright's utility-script call: `(utilityScript, ...args) => utilityScript.evaluate(...args)`. */
export const UTILITY_CALL = /^\(utilityScript,\s*\.\.\.args\)\s*=>\s*utilityScript\.evaluate\(\.\.\.args\)$/;
/** C11's table of the recognizers: each pattern matches the whole text of Playwright's function. */
export const RECOGNIZERS: Record<string, RegExp> = {
  "hit-target check": /^\(\[injected\b[^\]]*\]\)\s*=>\s*injected\.setupHitTargetInterceptor\([^)]*\)\s*$/,
  "the check's stop": /^\(([A-Za-z_$][\w$]*)\)\s*=>\s*\1\.stop\(\)\s*$/,
  focus: PLAYWRIGHT_FOCUS,
  fill: /^async\s*\(\[injected\b[^\]]*\]\)\s*=>\s*\{[\s\S]*\breturn\s+injected\.fill\(node,\s*[\w$]+\);?\s*\}\s*$/,
  "select text": /^async\s*\(\[injected\b[^\]]*\]\)\s*=>\s*\{[\s\S]*\breturn\s+injected\.selectText\(node\);?\s*\}\s*$/,
  "retry scroll": /^\(\[injected\b[^\]]*\]\)\s*=>\s*\{[\s\S]*\bnode\.scrollIntoView\(\{\s*\.\.\.[\w$]+,\s*behavior:\s*"instant"\s*\}\);[\s\S]*\}\s*$/,
  blur: /^\(\[injected\b[^\]]*\]\)\s*=>\s*injected\.blurNode\([^)]*\)\s*$/,
  "select option": /^async\s*\(\[injected\b[^\]]*\]\)\s*=>\s*\{[\s\S]*\breturn\s+injected\.selectOptions\(node,\s*[\w$]+\);?\s*\}\s*$/,
  "set files": /^\(\[injected\b[^\]]*\]\)\s*=>\s*injected\.setInputFiles\([^)]*\)\s*$/,
};
/** The recognizer whose pattern matches the whole text, or null. */
export function recognize(fn: string): string | null {
  for (const [name, re] of Object.entries(RECOGNIZERS)) if (re.test(fn)) return name;
  return null;
}

/** A handle of the serialized argument: the objectId of Chrome's remote object. */
export type Handle = { handle: string | undefined };
/**
 * Playwright's serialized argument (`serializeAsCallArgument`): a string, a number or a boolean is itself, `undefined`
 * and `null` (and the special numbers) are `{"v": ...}`, a handle is `{"h": <index into the handles>}`, an array is
 * `{"a": [...]}`, an object is `{"o": [{"k": <key>, "v": <value>}]}`. Other forms (a date, a URL, a cycle) read as undefined.
 */
export function decodeArg(v: unknown, handles: readonly (string | undefined)[]): unknown {
  if (v === null || typeof v !== "object") return v;
  const o = v as Record<string, unknown>;
  if ("v" in o) return ({ null: null, NaN: NaN, Infinity: Infinity, "-Infinity": -Infinity, "-0": -0 } as Record<string, unknown>)[String(o.v)];
  if ("h" in o) return { handle: handles[o.h as number] } satisfies Handle;
  if ("a" in o && Array.isArray(o.a)) return o.a.map((x) => decodeArg(x, handles));
  if ("o" in o && Array.isArray(o.o)) return Object.fromEntries((o.o as { k: string; v: unknown }[]).map((e) => [e.k, decodeArg(e.v, handles)]));
  return undefined;
}
/** A utility call: its function's text, its decoded arguments and its handles. */
export type Utility = { fn: string; name: string | null; args: unknown[]; handles: (string | undefined)[] };
/**
 * A Runtime.callFunctionOn of Playwright's utility script, decoded: its arguments are the utility script, two flags, the
 * text of Playwright's function, the count of arguments, that many serialized arguments, and then the handles. Null for
 * any other call.
 */
export function utilityCall(method: string, params: any): Utility | null {
  if (method !== "Runtime.callFunctionOn" || typeof params?.functionDeclaration !== "string" || !UTILITY_CALL.test(params.functionDeclaration.trim())) return null;
  const a: any[] = Array.isArray(params.arguments) ? params.arguments : [];
  const fn = a[3]?.value, count = a[4]?.value;
  if (typeof fn !== "string" || !Number.isInteger(count) || count < 0) return null;
  const handles = a.slice(5 + count).map((x) => (typeof x?.objectId === "string" ? x.objectId : undefined));
  return { fn, name: recognize(fn), args: a.slice(5, 5 + count).map((x) => decodeArg(x?.value, handles)), handles };
}

// ------------------------------------------------------------------ the stage's reads

/**
 * The frame mapping's read, in Playwright's utility world on the node's own handle: for each same-origin frame level up
 * to the top of its process, the frame element's box plus its border and padding (the sum of Playwright's
 * _checkFrameIsHitTarget), and the node's box with that sum. `top`: the sum reached the top page (no cross-origin frame
 * above it); `flat`: no frame element on the way has a transform (else the mapping is not a sum).
 */
export const NODE_GEO = "function () { let x = 0, y = 0, flat = true, w = this.ownerDocument.defaultView; while (w !== w.top && w.frameElement) { const fe = w.frameElement, r = fe.getBoundingClientRect(), cs = w.parent.getComputedStyle(fe); if (cs.transform && cs.transform !== 'none') flat = false; x += r.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft); y += r.top + parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop); w = w.parent; } const b = this.getBoundingClientRect(); return { ox: x, oy: y, top: w === w.top, flat, box: { x0: b.left + x, y0: b.top + y, x1: b.right + x, y1: b.bottom + y } }; }";
/**
 * The recovery's read at the hit point, in Playwright's utility world on the target's handle: the element at the point
 * when it is not the target or inside it, and its highest ancestor that does not hold the target; as an array of the
 * two (a handle that the stage keeps until its second read), or null.
 */
export const OBSTACLE_FIND = "function (x, y) { const t = this, el = t.ownerDocument.elementFromPoint(x, y); if (!el || el === t || t.contains(el)) return null; let o = el; while (o.parentElement && !o.parentElement.contains(t)) o = o.parentElement; return [o, el]; }";
/** The union of the boxes of the obstacle and the element at the point (the first read). */
export const OBSTACLE_BOTH = "function () { const a = this[0].getBoundingClientRect(), b = this[1].getBoundingClientRect(); return { x0: Math.min(a.left, b.left), y0: Math.min(a.top, b.top), x1: Math.max(a.right, b.right), y1: Math.max(a.bottom, b.bottom) }; }";
/** Two frames of the page (the recovery's wait after the pointer left the obstacle). */
export const TWO_FRAMES = "function () { return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))); }";
/** The obstacle's box again (the second read): the panel has closed, so it is the trigger's box. */
export const OBSTACLE_AGAIN = "function () { const a = this[0].getBoundingClientRect(); return { x0: a.left, y0: a.top, x1: a.right, y1: a.bottom }; }";
/** Condition 3 of the press point, in the stage's own isolated world: the element at the client's point. */
export const ELEMENT_KIND = "(x, y) => { const el = document.elementFromPoint(x, y); if (!el) return null; return { tag: el.localName, type: el.getAttribute('type') ?? undefined, role: el.getAttribute('role') ?? undefined, href: el.localName === 'a' && el.hasAttribute('href'), usemap: el.localName === 'img' && el.hasAttribute('usemap'), editable: el.isContentEditable }; }";
/** Condition 4 of the press point, in the stage's own isolated world: the element at the spread point is the one at the client's point. */
export const SAME_ELEMENT = "(x1, y1, x2, y2) => { const a = document.elementFromPoint(x1, y1); return !!a && a === document.elementFromPoint(x2, y2); }";

// ------------------------------------------------------------------ the host

/** A client's answer: Chrome's result, or an error. */
export type Body = { result?: unknown; error?: { code: number; message: string } };
/** A rectangle of CSS px of the top page, both ends inside. */
export type Rect = { x0: number; y0: number; x1: number; y1: number };

/** What the stage needs of the model for one tab. */
export type StagePage = {
  /** The tab (the key of its state). */
  readonly id: number;
  /** The scope's person (C11: each scope gets one person, drawn once for the life of the scope). */
  readonly person: Person;
  /** One command to Chrome for the stage itself (an event or a read) on the tab's session (child undefined) or a child session. */
  send(child: string | undefined, method: string, params: Record<string, unknown>): Promise<any>;
  /** A client's call as the model sends it (resolves when it is sent); `answer` gets Chrome's answer, as the client's. */
  pass(child: string | undefined, method: string, params: any, answer: (body: Body) => void): Promise<void>;
  /** The client's error body of a refused command. */
  error(method: string, e: unknown): { code: number; message: string };
  /** A read in the stage's own isolated world (the relay's world): `fn` called with `args` (numbers only), by value. */
  ownRead(fn: string, args: number[]): Promise<unknown>;
  /** The activation before the first event of an action (C11, "The window comes forward for input"). */
  activate(): Promise<void>;
  /** A step of the stage's own in the tab's gate (the end of a plan with no client call left): the tab's later calls wait for it. */
  inGate(fn: () => Promise<void>): void;
  /** The page's last point as the model keeps it, with `x11` true for the X record of an activation; or null. */
  point(): { x: number; y: number; x11: boolean } | null;
  /** The X pointer's place mapped into the page (Linux, with the pointer paths on), or null (outside the page, unknown, the Mac). */
  xPoint?(): Promise<{ x: number; y: number } | null>;
};

/** The stage's clock: the player's (now, sleep) and a timer that can be cancelled. A test gives a fake one. */
export type StageClock = Clock & { timer(ms: number, fn: () => void): () => void };
export const stageClock: StageClock = { ...systemClock, timer: (ms, fn) => { const t = setTimeout(fn, Math.max(0, ms)); return () => clearTimeout(t); } };

export type StageOptions = {
  log: (line: string) => void;
  random: Random;
  /** "linux": whole px and whole-ms timestamps; "mac": both with their fractions. */
  platform: "linux" | "mac";
  clock?: StageClock;
  /** The epoch time (ms) of an event's send (the player's stamp). */
  stamp?: () => number;
  /** A log line for each hit-target setup and each end of an action (counts and times, never a point): the live rows. */
  trace?: boolean;
};

// ------------------------------------------------------------------ the state

type Kind = "mouse" | "key" | "text" | "setup";
/** A client call that the stage took: its step runs in the tab's gate. */
export type Entry = {
  readonly child: string | undefined; readonly method: string; readonly params: any; readonly answer: (body: Body) => void;
  readonly kind: Kind; readonly util: Utility | null;
  /** Its plan ended (a dialog, STAGE_EVENT_WAIT_MS, STAGE_ACTION_MAX_MS) before its step: its own event goes at once. */
  ended?: boolean;
  /** Its plan failed: the client gets this error, with no event. */
  failedWith?: { code: number; message: string };
  /** The tab's state when the call arrived: its step runs on that state, also after the model dropped the tab. */
  readonly st: TabState;
};
type EndWhy = "dialog" | "wait" | "limit" | "drop";
/**
 * How the model dropped a tab (C11, dialogs: the end of the wait for a close). "tab": its target ended, it closed, or
 * Chrome detached it. "session": the client's session or connection ended (also a C10 timeout's detach, which ends the
 * client's sessions of the tab, and the end of the relay's link, which closes every connection).
 */
export type DropWhy = "tab" | "session";
/** The error of a held call at a navigation of the main frame (C11, dialogs: the held events never reach the new document). */
export const CONTEXT_GONE = { code: -32000, message: "Execution context was destroyed: the page navigated while a dialog was open, and the input stage sent none of the held input" };
/** A translated action: the lock, the plan's latency and its end. */
class Action {
  ended: EndWhy | null = null;
  failed = false;
  readonly endSignal: Promise<void>;
  private fireEnd!: () => void;
  readonly unanswered = new Set<{ t: number }>();
  watchdog: (() => void) | null = null;
  limit: (() => void) | null = null;
  readonly latency: number;
  readonly release: () => void;
  readonly started: number;
  events = 0;
  constructor(release: () => void, latency: number, started: number) {
    this.release = release; this.latency = latency; this.started = started;
    this.endSignal = new Promise((r) => (this.fireEnd = r));
  }
  fire(): void { this.fireEnd(); }
  get over(): boolean { return this.ended !== null || this.failed; }
}
type Setup = { node: string | undefined; child: string | undefined; action: string; hit: Pt | null; trial: boolean; used: boolean };
type Press = { at: number; hold: number; client: Pt; point: Pt; button: string };
class TabState {
  readonly pending: Entry[] = [];
  /** The point of the stage's last pointer event in the page. */
  last: Pt | null = null;
  lastWasMove = false;
  lastMoveAt = -Infinity;
  releasedAt = -Infinity;
  press: Press | null = null;
  /** The buttons that the stage's events hold down, each with the clickCount of its press, and the keys (by their code). */
  readonly buttons = new Map<string, number>();
  readonly keys = new Map<string, { at: number; params: any }>();
  /** The buttons and keys ("key:<code>") that the stage released at the end of a plan: the client's own release gets no event. */
  readonly released = new Set<string>();
  action: Action | null = null;
  running = false;
  /** The lock that an ended plan's events took again (C11: every end of a plan frees the lock; its later events take it again). */
  tail: (() => void) | null = null;
  tailActive = false;
  /** The limit of that lock (STAGE_ACTION_MAX_MS); after it the plan's remaining ended calls go with no lock. */
  tailLimit: (() => void) | null = null;
  tailOver = false;
  /** The model dropped the tab (C11, dialogs: the end of the wait for a close). */
  gone: DropWhy | null = null;
  /** A navigation of the main frame ended the wait for a close: each held call gets this error, with no event. */
  heldGone: { code: number; message: string } | null = null;
  /** The host of the tab's last call (the releases at a drop). */
  page: StagePage | null = null;
  setup: Setup | null = null;
  /** The handles that the tab's hit-target setups returned (the stop recognizer's first handle), each with its node; at most KEPT_MAX. */
  readonly handles = new Map<string, string | undefined>();
  /** The answers of the client's own DOM.getContentQuads, by the node's objectId (condition 2 of the press point). */
  readonly quads = new Map<string, Box>();
  miss = false;
  missAt = -Infinity;
  /** The node of the last miss: a miss marks its node (C11, the recoveries). */
  missNode: string | undefined = undefined;
  recov: { node: string | undefined; n: number; limited?: boolean } | null = null;
  /** After the limit of recoveries: the rest of the action goes as Playwright sends it. */
  plain = false;
  avoid: Rect | null = null;
  rest: { to: Pt; from: Pt; samples: Sample[] } | null = null;
  /** The end of a kept rest (HOVER_WAIT_MS after the setup's answer). */
  restTimer: (() => void) | null = null;
  spread: { client: Pt; point: Pt } | null = null;
  readonly flight = { n: 0 };
  /** The child sessions of the tab's cross-origin frames: the frame's id and its parent session. */
  readonly frames = new Map<string, { frameId: string; parent: string | undefined }>();
  /** An open dialog of the tab: the ended plan's events wait for its close (Chrome drops the input that it gets while it is open). */
  dialog: { closed: Promise<void>; close: () => void } | null = null;
}

/** The input lock: one for all pages of the agent browser, in the order of arrival. */
export class InputLock {
  private tail: Promise<void> = Promise.resolve();
  held = 0;
  acquire(): Promise<() => void> {
    let open!: () => void;
    const next = new Promise<void>((r) => (open = r));
    const prev = this.tail;
    this.tail = prev.then(() => next);
    return prev.then(() => {
      this.held++;
      let done = false;
      return () => { if (!done) { done = true; this.held--; open(); } };
    });
  }
}

const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta"]);
const TIMEOUT = Symbol("timeout");
const same = (a: Pt | null | undefined, b: Pt | null | undefined) => !!a && !!b && a.x === b.x && a.y === b.y;
const near = (a: Pt, b: Pt, d: number) => Math.hypot(a.x - b.x, a.y - b.y) <= d;
/** A point inside a box (the hit test of a pixel: the right and the bottom edges are outside, as for getBoundingClientRect). */
const inside = (p: Pt, r: Rect) => p.x >= r.x0 && p.x < r.x1 && p.y >= r.y0 && p.y < r.y1;
/** Whether the segment a-b meets the rectangle (Liang-Barsky). */
export function crosses(a: Pt, b: Pt, r: Rect): boolean {
  let t0 = 0, t1 = 1;
  const dx = b.x - a.x, dy = b.y - a.y;
  for (const [p, q] of [[-dx, a.x - r.x0], [dx, r.x1 - a.x], [-dy, a.y - r.y0], [dy, r.y1 - a.y]]) {
    if (p === 0) { if (q < 0) return false; continue; }
    const t = q / p;
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; }
  }
  return t0 <= t1;
}
/** A quad (8 numbers) as a rectangle, or null when it is not one (a transform). */
export function quadRect(q: unknown): Rect | null {
  if (!Array.isArray(q) || q.length !== 8 || !q.every((v) => typeof v === "number" && Number.isFinite(v))) return null;
  const xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]];
  const r = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
  for (let i = 0; i < 4; i++) if ((xs[i] !== r.x0 && xs[i] !== r.x1) || (ys[i] !== r.y0 && ys[i] !== r.y1)) return null;
  return r;
}

// ------------------------------------------------------------------ the stage

export class Stage {
  private readonly o: StageOptions;
  private readonly clock: StageClock;
  private readonly tabs = new Map<number, TabState>();
  private readonly players = new Map<number, CdpPlayer>();
  readonly lock = new InputLock();
  /** The counts of the harness (C11, the log and the counts): each case of no change and each end of a plan. */
  readonly counts: Record<string, number> = {};

  constructor(o: StageOptions) {
    this.o = o;
    this.clock = o.clock ?? stageClock;
  }

  private count(k: string, n = 1): void { this.counts[k] = (this.counts[k] ?? 0) + n; }
  private st(page: StagePage): TabState {
    let s = this.tabs.get(page.id);
    if (!s) this.tabs.set(page.id, (s = new TabState()));
    s.page = page;
    return s;
  }
  /** What the stage keeps of a tab (the tests; no client sees it). */
  state(id: number) {
    const s = this.tabs.get(id);
    return s ? { last: s.last, buttons: [...s.buttons.keys()], keys: [...s.keys.keys()], action: !!s.action, miss: s.miss, avoid: s.avoid, plain: s.plain, recoveries: s.recov?.n ?? 0, pending: s.pending.length,
      quads: s.quads.size, handles: s.handles.size, dialog: !!s.dialog } : null;
  }
  private linux(): boolean { return this.o.platform === "linux"; }
  /** A client's point as the stage sends it: whole CSS px on Linux (round half up), as it is on the Mac. */
  private fit(p: { x: number; y: number }): Pt { return this.linux() ? { x: Math.round(p.x), y: Math.round(p.y) } : { x: p.x, y: p.y }; }

  private player(page: StagePage, st: TabState): CdpPlayer {
    let pl = st.gone ? undefined : this.players.get(page.id);
    if (!pl) {
      const dev = page.person.params.device;
      pl = new CdpPlayer((method, params) => this.sendEvent(page, st, undefined, method, params), {
        clock: this.clock, stamp: this.o.stamp ?? (this.linux() ? linuxStamp : macStamp), latencyMs: dev.latencyMs, wholeMs: this.linux() && dev.wholeMsTimestamps,
        random: this.o.random, maxInFlight: dev.movesInFlight,
      });
      if (!st.gone) this.players.set(page.id, pl);
    }
    return pl;
  }

  // ---------------------------------------------------------------- the model's calls

  /**
   * A client's call arrives (before the tab's gate): the entry of a call that the stage takes, or null. On the tab's own
   * session the stage takes Input.dispatchMouseEvent, Input.dispatchKeyEvent and Input.insertText, and on every session
   * the hit-target setup (the other recognizers of C11's table belong to the later parts, and pass).
   */
  arrive(page: StagePage, child: string | undefined, method: string, params: any, answer: (body: Body) => void): Entry | null {
    let kind: Kind | null = null, util: Utility | null = null;
    if (!child && method === "Input.dispatchMouseEvent") kind = "mouse";
    else if (!child && method === "Input.dispatchKeyEvent") kind = "key";
    else if (!child && method === "Input.insertText") kind = "text";
    else if (method === "Runtime.callFunctionOn" && (util = utilityCall(method, params))?.name === "hit-target check") kind = "setup";
    if (!kind) return null;
    const st = this.st(page);
    const e: Entry = { child, method, params: params ?? {}, answer, kind, util, st };
    st.pending.push(e);
    return e;
  }

  /** The step of a taken call, in the tab's gate: it ends when the call's events have gone and Chrome answered them (or the plan ended). */
  async step(page: StagePage, e: Entry): Promise<void> {
    const st = e.st;
    const i = st.pending.indexOf(e);
    if (i >= 0) st.pending.splice(i, 1);
    st.running = true;
    try {
      if (st.gone) return await this.goneStep(page, st, e);
      if (e.failedWith) { e.answer({ error: e.failedWith }); return; }
      if (e.kind === "setup") return await this.setupStep(page, st, e);
      if (e.ended) return await this.endedEvent(page, st, e);
      if (e.kind === "mouse") {
        const t = e.params.type;
        if (t === "mouseMoved" && !e.params.buttons && (e.params.button ?? "none") === "none") return await this.moveStep(page, st, e);
        if (t === "mousePressed") return await this.pressStep(page, st, e);
        if (t === "mouseReleased") return await this.releaseStep(page, st, e);
        this.count("plainMouse");
        return await this.plainStep(page, st, e);
      }
      if (e.kind === "key") return await this.keyStep(page, st, e);
      this.count("plainText");
      return await this.plainStep(page, st, e);
    } catch (err) {
      this.o.log(`relay: the input stage: a step of tab ${page.id} failed: ${(err as Error).message}`);
      if (!st.action?.failed) e.answer({ error: page.error(e.method, err) });
    } finally {
      st.running = false;
      await this.afterStep(page, st);
    }
  }

  /** The answer of a call that passed (the stage watches the client's DOM.getContentQuads and the check's stop). */
  saw(page: StagePage, child: string | undefined, method: string, params: any, result: any): void {
    const st = this.st(page);
    if (method === "DOM.getContentQuads" && typeof params?.objectId === "string") {
      const r = quadRect(result?.quads?.[0]);
      if (r) { st.quads.delete(params.objectId); st.quads.set(params.objectId, { x: r.x0, y: r.y0, w: r.x1 - r.x0, h: r.y1 - r.y0 }); }
      while (st.quads.size > KEPT_MAX) st.quads.delete(st.quads.keys().next().value!);
      return;
    }
    const u = utilityCall(method, params);
    if (u?.name === "the check's stop" && u.handles[0] && st.handles.has(u.handles[0])) {
      // The stop ends its attempt: the plain mode after the recoveries' limit covers that attempt only.
      st.plain = false;
      const v = result?.result?.value;
      if (v !== undefined && v !== "done") { st.miss = true; st.missAt = this.clock.now(); st.missNode = st.handles.get(u.handles[0]); this.count("stopMisses"); }
    }
  }

  /** A Chrome event of the tab that goes to the client: a dialog ends the plan; the frames' sessions for the mapping. */
  event(page: StagePage, child: string | undefined, method: string, params: any): void {
    const st = this.st(page);
    if (method === "Page.javascriptDialogOpening") {
      if (!st.dialog) { let close!: () => void; const closed = new Promise<void>((r) => (close = r)); st.dialog = { closed, close }; }
      return this.end(page, st, "dialog");
    }
    // The signals that end a dialog's wait (C11, dialogs): its close, Chrome's answer to the client's
    // Page.handleJavaScriptDialog (the model sends it as a Closed event), the client's Page.disable (no Closed event can
    // come then), a navigation of the tab's main frame, a crash; and the tab's detach or removal (drop).
    const mainNav = method === "Page.frameNavigated" && !child && !params?.frame?.parentId;
    // A navigation of the main frame while an ended plan waits for a close: no held move, press or key press reaches the
    // new document. Each held call gets the error that the context is gone; only the releases of what the plan holds go.
    if (mainNav && st.dialog && st.action?.over && !st.gone) {
      st.heldGone = CONTEXT_GONE;
      for (const x of st.pending) if (x.ended) x.failedWith = CONTEXT_GONE;
      this.count("navigationDrops");
    }
    if (method === "Page.javascriptDialogClosed" || method === "Page.disable" || method === "Inspector.targetCrashed" || mainNav) { st.dialog?.close(); st.dialog = null; }
    if (mainNav) { st.quads.clear(); st.handles.clear(); }
    if (method === "Page.javascriptDialogClosed" || method === "Page.disable" || method === "Inspector.targetCrashed" || mainNav) return;
    if (method === "Target.attachedToTarget" && params?.targetInfo?.type === "iframe" && typeof params.sessionId === "string")
      st.frames.set(params.sessionId, { frameId: String(params.targetInfo.targetId), parent: child });
    if (method === "Target.detachedFromTarget" && typeof params?.sessionId === "string") st.frames.delete(params.sessionId);
  }

  /**
   * The model dropped the tab (C11, dialogs: the end of the wait for a close): its plan ends, the wait for a close ends,
   * and the lock that the tab holds is free at once (also the lock that its ended events took again). The tab's calls
   * that have not gone run on its old state: at the tab's end each goes to Chrome as the client sent it, with no lock, and
   * gets Chrome's answer or error; at a session's end none goes and nothing goes back, and only the release of each
   * button and key that the plan holds goes, now (before the model's detach), so nothing stays down.
   */
  drop(id: number, why: DropWhy = "tab"): void {
    const st = this.tabs.get(id);
    this.tabs.delete(id);
    if (!st) { this.players.delete(id); return; }
    st.gone = why;
    this.count(why === "session" ? "sessionDrops" : "tabDrops");
    st.dialog?.close();
    st.dialog = null;
    const a = st.action;
    if (a && !a.over) { a.ended = "drop"; a.fire(); }
    this.dropRest(st); st.spread = null;
    const releases = why === "session" || (!st.running && !st.pending.length);
    if (releases && st.page) this.releaseHeld(st.page, st);
    this.players.delete(id);
    this.freeTail(st);
    this.close(st, id);
  }

  /** A call of a dropped tab: at a session's end nothing goes and nothing goes back; at the tab's end it goes to Chrome as the client sent it, with no lock. */
  private async goneStep(page: StagePage, st: TabState, e: Entry): Promise<void> {
    if (st.gone === "session") return;
    if (e.failedWith) { e.answer({ error: e.failedWith }); return; }
    // The client's own release goes: the stage's release after the last call is only for what the client did not release.
    if (e.kind === "mouse" && e.params.type === "mouseReleased") st.buttons.delete(e.params.button);
    if (e.kind === "key" && e.params.type === "keyUp") st.keys.delete(e.params.code);
    await page.pass(e.child, e.method, e.params, e.answer);
  }

  // ---------------------------------------------------------------- the action, the lock and the end of a plan

  /** The action of the tab: the lock (in the order of arrival), then the activation before its first event. */
  private async begin(page: StagePage, st: TabState): Promise<Action> {
    if (st.action && !st.action.over) return st.action;
    const release = await this.lock.acquire();
    // The model dropped the tab while its step waited for the lock: an ended plan, with the lock free.
    if (st.gone) { release(); const a = new Action(() => {}, 0, this.clock.now()); a.ended = "drop"; return a; }
    const dev = page.person.params.device;
    const a = new Action(release, uniform(this.o.random, dev.latencyMs[0], dev.latencyMs[1]), this.clock.now());
    st.action = a;
    a.limit = this.clock.timer(STAGE_ACTION_MAX_MS, () => {
      if (st.action !== a || a.over) return;
      this.o.log(`relay: the input stage: an action of tab ${page.id} held the input lock ${STAGE_ACTION_MAX_MS} ms; the rest goes at once`);
      this.end(page, st, "limit");
    });
    try { await page.activate(); } catch (err) { this.o.log(`relay: the input stage: the activation of tab ${page.id} failed: ${(err as Error).message}`); }
    return a;
  }

  /** At the end of a step: a live action with nothing held and no input waiting frees the lock; an ended one, once its client calls have gone. */
  private async afterStep(page: StagePage, st: TabState): Promise<void> {
    // A dropped tab: after its last call, at the tab's end, the release of each button and key that its plan holds.
    if (st.gone) {
      if (!st.running && !st.pending.length) { if (st.gone === "tab" && st.page) this.releaseHeld(st.page, st); this.freeTail(st); }
      return;
    }
    const a = st.action;
    // No action (the plan failed): an ended event's lock goes with its last ended call.
    if (!a) { if (!st.pending.some((x) => x.ended || x.failedWith)) this.freeTail(st); return; }
    if (a.over) { if (!st.pending.some((x) => x.ended || x.failedWith)) await this.finish(page, st, a); return; }
    if (!st.buttons.size && !st.keys.size && !st.rest && !st.pending.some((x) => x.kind !== "setup")) this.close(st, page.id);
  }

  /** The hover's rest is kept for Playwright's move: with none in HOVER_WAIT_MS, it goes, and an action with nothing else frees the lock. */
  private keepRest(page: StagePage, st: TabState): void {
    st.restTimer?.();
    st.restTimer = this.clock.timer(HOVER_WAIT_MS, () => {
      st.restTimer = null;
      if (!st.rest) return;
      st.rest = null;
      this.count("hoverRestsDropped");
      if (!st.running) void this.afterStep(page, st);
    });
  }
  private dropRest(st: TabState): void { st.rest = null; st.restTimer?.(); st.restTimer = null; }

  private close(st: TabState, id?: number): void {
    const a = st.action;
    if (!a) return;
    st.action = null;
    st.heldGone = null;
    st.plain = false; // the end of the stage's action ends a plain attempt (the recoveries' limit)
    if (this.o.trace && id !== undefined) this.o.log(`relay: the input stage: tab ${id}: an action of ${a.events} events in ${Math.round(this.clock.now() - a.started)} ms${a.ended ? ` (ended: ${a.ended})` : a.failed ? " (failed)" : ""}`);
    this.dropRest(st);
    a.watchdog?.(); a.limit?.();
    a.release();
  }

  /**
   * The end of a plan (C11, dialogs): at a dialog, at STAGE_EVENT_WAIT_MS and at STAGE_ACTION_MAX_MS. The plan's own events
   * that no client call asked for are dropped (the rest of the path, the pauses); each client call that arrived goes at
   * once, in order, as the client sent it; then the release of each button and key that the plan holds, and the lock is free.
   */
  private end(page: StagePage, st: TabState, why: EndWhy): void {
    const a = st.action;
    if (!a || a.over) return;
    a.ended = why;
    a.fire();
    this.count(why === "dialog" ? "dialogEnds" : why === "wait" ? "waitEnds" : "limitEnds");
    if (why !== "limit") this.o.log(`relay: the input stage: a plan of tab ${page.id} ended (${why === "dialog" ? "a dialog" : `no answer in ${STAGE_EVENT_WAIT_MS} ms`})`);
    for (const x of st.pending) if (x.kind !== "setup") x.ended = true;
    this.dropRest(st);
    // Every end of a plan frees the lock at once. The plan's client events that go later (at a dialog: after its close)
    // take the lock again, in the order of arrival, with the activation before an ended press or key press.
    a.release();
    // With no client call left, the end's own step (the releases) goes in the tab's gate: later calls wait for it.
    if (!st.running && !st.pending.some((x) => x.ended)) page.inGate(() => this.finish(page, st, a));
  }

  /**
   * After an ended plan's client calls: the releases of what it holds (at a dialog or STAGE_EVENT_WAIT_MS; at the limit the
   * client still holds its button, and its own release goes later), under the lock that the ended events took again, after
   * the dialog's close; then the lock is free, and the tab's gate opens when this step ends.
   */
  private async finish(page: StagePage, st: TabState, a: Action): Promise<void> {
    if (st.action !== a) { this.freeTail(st); return; }
    if (a.ended !== "limit" && !a.failed && (st.buttons.size || st.keys.size)) {
      await this.dialogGone(st);
      await this.retake(page, st, false);
      this.releaseHeld(page, st);
    }
    this.freeTail(st);
    this.close(st, page.id);
  }

  /** The lock again for an ended plan's events (the order of arrival), and the activation before its first press or key press. */
  private async retake(page: StagePage, st: TabState, activate: boolean): Promise<void> {
    // A dropped tab, or a taken lock past its limit: the remaining ended calls go with no lock (and no activation).
    if (st.gone || st.tailOver) return;
    if (!st.tail) {
      const release = await this.lock.acquire();
      if (st.gone || st.tailOver) { release(); return; }
      st.tail = release;
      // The taken lock has the limit STAGE_ACTION_MAX_MS (C11, the input lock): then it is free, and the rest goes with no lock.
      st.tailLimit = this.clock.timer(STAGE_ACTION_MAX_MS, () => {
        st.tailLimit = null;
        this.o.log(`relay: the input stage: the ended events of tab ${page.id} held the input lock ${STAGE_ACTION_MAX_MS} ms; the rest goes with no lock`);
        this.count("tailLimits");
        st.tailOver = true;
        const t = st.tail; st.tail = null; st.tailActive = false; t?.();
      });
    }
    if (activate && !st.tailActive) {
      st.tailActive = true;
      try { await page.activate(); } catch (err) { this.o.log(`relay: the input stage: the activation of tab ${page.id} failed: ${(err as Error).message}`); }
    }
  }
  private freeTail(st: TabState): void { const t = st.tail; st.tail = null; st.tailActive = false; st.tailLimit?.(); st.tailLimit = null; st.tailOver = false; t?.(); }

  /**
   * A client's event of an ended plan: after the dialog's close (when the stage knows of a dialog), with the lock taken
   * again and the activation before a press or a key press; its timestamp from the send. The send's answer comes later.
   */
  private async endedSend(page: StagePage, st: TabState, e: Entry, params: Record<string, unknown>): Promise<{ sent: Promise<any> } | null> {
    // null: no event (a session's end: nothing goes back; a navigation: the call has its error).
    const held = (): { sent: Promise<any> } | null | undefined => {
      if (st.gone === "session") return null;
      if (st.heldGone) { e.answer({ error: st.heldGone }); return null; }
      if (st.gone) return { sent: page.send(undefined, e.method, params) };
      return undefined;
    };
    await this.dialogGone(st);
    let h = held();
    if (h !== undefined) return h;
    await this.retake(page, st, startsAction(e.method, params));
    h = held();
    if (h !== undefined) return h;
    if (e.kind !== "text") params.timestamp = this.stamp(page, st);
    return { sent: this.sendEvent(page, st, undefined, e.method, params) };
  }

  /**
   * Chrome drops an input event that it gets while a dialog is open (measured: board ab-t30.9, open point 5), and keeps
   * the events that it got before. So an ended plan's client events wait for the dialog's close.
   */
  private async dialogGone(st: TabState): Promise<void> { if (st.dialog) await st.dialog.closed; }

  /** The release of each button and key that the stage's events hold, at once, with no wait for the answers. */
  private releaseHeld(page: StagePage, st: TabState): void {
    const at = st.last ?? { x: 0, y: 0 };
    for (const [b, clickCount] of [...st.buttons]) {
      void this.sendEvent(page, st, undefined, "Input.dispatchMouseEvent", { type: "mouseReleased", x: at.x, y: at.y, button: b, buttons: 0, clickCount, timestamp: this.stamp(page, st) }).catch(() => {});
      st.released.add(b);
    }
    st.buttons.clear();
    for (const [code, k] of [...st.keys]) {
      const p = k.params;
      void this.sendEvent(page, st, undefined, "Input.dispatchKeyEvent", { type: "keyUp", key: p.key, code: p.code, windowsVirtualKeyCode: p.windowsVirtualKeyCode, location: p.location ?? 0, modifiers: 0, timestamp: this.stamp(page, st) }).catch(() => {});
      st.released.add(`key:${code}`);
    }
    st.keys.clear();
    st.press = null;
  }

  /**
   * An error of an event (C11, the answers): the plan stops; first the release of each button and key that it holds;
   * the client call of the refused event gets Chrome's error, and each other client call of the plan whose events did not
   * go gets the same error.
   */
  private fail(page: StagePage, st: TabState, e: Entry, err: unknown): void {
    const body = this.stopPlan(page, st, e.method, err);
    e.answer({ error: body });
    this.freeTail(st);
    this.close(st, page.id);
  }

  /**
   * The plan stops at a refused event: no more of its events, the release of each button and key that it holds first,
   * and each client call of the plan whose events did not go gets the same error. A sample that the stage sends before a
   * hit-target setup (the hover's samples outside the target, a recovery's move out) belongs to no client call that has
   * come: the plan stops in the same way, and the setup goes as the client sent it.
   */
  private stopPlan(page: StagePage, st: TabState, method: string, err: unknown): { code: number; message: string } {
    const body = page.error(method, err);
    const a = st.action;
    if (a) { a.failed = true; a.fire(); }
    this.count("eventErrors");
    for (const x of st.pending) if (x.kind !== "setup") x.failedWith = body;
    this.dropRest(st); st.spread = null;
    this.releaseHeld(page, st);
    return body;
  }

  // ---------------------------------------------------------------- sending

  /** A timestamp of the action's latency before the send (whole ms on Linux). */
  private stamp(page: StagePage, st: TabState): number {
    return this.player(page, st).timestamp(st.action?.latency ?? STAGE_LATENCY_MS[0]);
  }

  /**
   * One event of the stage to Chrome: its bookkeeping (the last point, the move's time, the unanswered events of the plan
   * for STAGE_EVENT_WAIT_MS).
   */
  private sendEvent(page: StagePage, st: TabState, child: string | undefined, method: string, params: Record<string, unknown>): Promise<any> {
    const p = page.send(child, method, params);
    if (method === "Input.dispatchMouseEvent" && typeof params.x === "number" && typeof params.y === "number" && !child) {
      st.last = { x: params.x, y: params.y as number };
      st.lastWasMove = params.type === "mouseMoved";
      if (st.lastWasMove) st.lastMoveAt = this.clock.now();
    }
    const a = st.action;
    if (a) a.events++;
    if (a && !a.over) {
      const rec = { t: this.clock.now() };
      a.unanswered.add(rec);
      const done = () => { a.unanswered.delete(rec); };
      p.then(done, done);
      this.arm(page, st, a);
    }
    return p;
  }

  /** STAGE_EVENT_WAIT_MS, counted from the oldest event of the plan that has no answer: at the limit the plan ends as at a dialog. */
  private arm(page: StagePage, st: TabState, a: Action): void {
    if (a.watchdog || a.over || !a.unanswered.size) return;
    const oldest = Math.min(...[...a.unanswered].map((r) => r.t));
    a.watchdog = this.clock.timer(oldest + STAGE_EVENT_WAIT_MS - this.clock.now(), () => {
      a.watchdog = null;
      if (st.action !== a || a.over || !a.unanswered.size) return;
      const o = Math.min(...[...a.unanswered].map((r) => r.t));
      if (this.clock.now() - o >= STAGE_EVENT_WAIT_MS) this.end(page, st, "wait");
      else this.arm(page, st, a);
    });
  }

  /** Wait until `t` on the stage's clock, or until the plan ends. */
  private async until(a: Action, t: number): Promise<void> {
    const ms = t - this.clock.now();
    if (ms <= 0 || a.over) return;
    let cancel = () => {};
    await Promise.race([new Promise<void>((r) => { cancel = this.clock.timer(ms, r); }), a.endSignal]);
    cancel();
  }

  /** Chrome's answer of an event, or the end of the plan first (then the answer still comes to the client when Chrome gives it). */
  private async settle(a: Action, p: Promise<any>): Promise<{ ok: true; value: any } | { ok: false; error: unknown } | { ended: true }> {
    const r = await Promise.race([p.then((value) => ({ ok: true as const, value }), (error) => ({ ok: false as const, error })), a.endSignal.then(() => ({ ended: true as const }))]);
    return r;
  }

  /** The client's answer: Chrome's own answer of its event, when it comes. */
  private answerWith(page: StagePage, e: Entry, p: Promise<any>): void {
    p.then((r) => e.answer({ result: r ?? {} }), (err) => e.answer({ error: page.error(e.method, err) }));
  }

  /** A read of the stage, at most GEOMETRY_WAIT_MS (C11): its value, or TIMEOUT (a failed read too; then the stage fails open). */
  private async read<T>(p: Promise<T>): Promise<T | typeof TIMEOUT> {
    let cancel = () => {};
    const r = await Promise.race([p.catch(() => TIMEOUT), new Promise<typeof TIMEOUT>((res) => { cancel = this.clock.timer(GEOMETRY_WAIT_MS, () => res(TIMEOUT)); })]);
    cancel();
    if (r === TIMEOUT) this.count("readFails");
    return r;
  }

  // ---------------------------------------------------------------- the paths

  /** Where the path starts: an X record of the activation (the catch-up's merge), else the stage's last point, else the model's. */
  private from(page: StagePage, st: TabState): Pt | null {
    const m = page.point();
    if (m && (m.x11 || !st.last)) return this.fit(m);
    return st.last;
  }

  /** A page with no last point: a random point of the viewport's middle (30% to 70%), from the stage's read of the viewport. */
  private async startOf(page: StagePage): Promise<Pt | null> {
    // C11: the X pointer's place mapped into the page (Linux, at an activation): the page got a real event there.
    const x = page.xPoint ? await this.read(page.xPoint()) : null;
    if (x && x !== TIMEOUT) { this.count("startsAtXPointer"); return this.fit(x); }
    const lm = await this.read(page.send(undefined, "Page.getLayoutMetrics", {}));
    const v = lm === TIMEOUT ? null : (lm as any)?.cssLayoutViewport;
    if (!v || !(v.clientWidth > 0) || !(v.clientHeight > 0)) return null;
    return this.fit(startPoint(v.clientWidth, v.clientHeight, this.o.random, page.person.params.path.start.middle));
  }

  /** The samples of a move from `from` to `to`: a short move (the client's line) up to `short.maxPx`, else a path (around a kept box). */
  private plan(page: StagePage, st: TabState, from: Pt, to: Pt, width: number): Sample[] {
    const P = page.person;
    if (Math.hypot(to.x - from.x, to.y - from.y) <= P.params.path.short.maxPx) return planLine(from, to, P, this.o.random).samples;
    const r = st.avoid;
    st.avoid = null;
    if (r) {
      const R = { x0: r.x0 - AROUND_MARGIN_PX, y0: r.y0 - AROUND_MARGIN_PX, x1: r.x1 + AROUND_MARGIN_PX, y1: r.y1 + AROUND_MARGIN_PX };
      const inner = { x0: R.x0 + 1, y0: R.y0 + 1, x1: R.x1 - 1, y1: R.y1 - 1 };
      if (crosses(from, to, inner)) {
        const len = (c: Pt) => Math.hypot(c.x - from.x, c.y - from.y) + Math.hypot(to.x - c.x, to.y - c.y);
        const corner = [{ x: R.x0, y: R.y0 }, { x: R.x1, y: R.y0 }, { x: R.x0, y: R.y1 }, { x: R.x1, y: R.y1 }]
          .filter((c) => !crosses(from, c, inner) && !crosses(c, to, inner)).sort((a, b) => len(a) - len(b))[0];
        if (corner) {
          this.count("pathsAround");
          const c = this.fit(corner), one = this.pathAvoiding(P, from, c, DEFAULT_WIDTH, r), two = this.pathAvoiding(P, c, to, width, r);
          const t0 = one.length ? one[one.length - 1].t : 0;
          return [...one, ...two.map((s) => ({ ...s, t: s.t + t0 }))];
        }
      }
    }
    return planPath(from, to, width, P, this.o.random).samples;
  }

  /** A path that does not enter the box `r` (a few draws of the generator; else the last draw). */
  private pathAvoiding(P: Person, from: Pt, to: Pt, width: number, r: Rect): Sample[] {
    let s: Sample[] = [];
    for (let i = 0; i < 8; i++) {
      s = Math.hypot(to.x - from.x, to.y - from.y) <= P.params.path.short.maxPx ? planLine(from, to, P, this.o.random).samples : planPath(from, to, width, P, this.o.random).samples;
      if (!s.some((q) => inside(q, r))) return s;
    }
    return s;
  }

  /**
   * Play the samples (at the device's rate, each move with no wait for the answer of the one before, at most
   * STAGE_MOVES_IN_FLIGHT of the tab without an answer). The first sample goes one sample time after the start, as a hand
   * that starts to move. `stopped`: the bound, or the end of the plan; `error`: Chrome refused a move.
   */
  private async play(page: StagePage, st: TabState, a: Action, samples: Sample[], extra: Record<string, unknown>): Promise<{ stopped: boolean; error?: unknown }> {
    if (!samples.length) return { stopped: false };
    const rate = page.person.params.device.rateMs, shift = samples[0].t - rate;
    const s = shift > 0 ? samples.map((q) => ({ ...q, t: q.t - shift })) : samples;
    try {
      const r = await this.player(page, st).moves(s, extra, { latency: a.latency, inFlight: st.flight, stop: () => a.over, until: a.endSignal });
      if (r.stopped && !r.ended) {
        this.count("inFlightStops");
        this.o.log(`relay: the input stage: a path of tab ${page.id} stopped at ${STAGE_MOVES_IN_FLIGHT} moves without an answer`);
      }
      return { stopped: r.stopped };
    } catch (error) { return { stopped: true, error }; }
  }

  /** The width of the target for Fitts's law: the smaller side of the setup's quad, else the default. */
  private widthOf(st: TabState): number {
    const q = st.setup?.node ? st.quads.get(st.setup.node) : undefined;
    return q ? Math.max(1, Math.min(q.w, q.h)) : DEFAULT_WIDTH;
  }

  // ---------------------------------------------------------------- the steps

  /** An event of an ended plan: the client's own event at once (C11, dialogs), and Chrome's own answer when it comes. */
  private async endedEvent(page: StagePage, st: TabState, e: Entry): Promise<void> {
    const p = e.params, params: Record<string, unknown> = { ...p };
    if (e.kind === "mouse") {
      const pr = p.type === "mouseReleased" && st.press?.button === p.button ? st.press : null;
      const pt = pr && same(pr.client, this.fit(p)) ? pr.point : this.fit(p);
      params.x = pt.x; params.y = pt.y;
    }
    const r = await this.endedSend(page, st, e, params);
    if (!r) return;
    const { sent } = r;
    if (e.kind === "mouse" && p.type === "mousePressed") st.buttons.set(p.button, p.clickCount ?? 1);
    if (e.kind === "mouse" && p.type === "mouseReleased") { st.buttons.delete(p.button); st.press = null; }
    if (e.kind === "key") { if (p.type === "keyUp") st.keys.delete(p.code); else st.keys.set(p.code, { at: this.clock.now(), params: p }); }
    this.answerWith(page, e, sent);
  }

  /** A call that goes as the client sent it, with the stage's timestamp, in the lock (the cases of no change). */
  private async plainStep(page: StagePage, st: TabState, e: Entry): Promise<void> {
    const a = await this.begin(page, st);
    if (a.over) return this.endedEvent(page, st, e);
    const p = e.params, params: Record<string, unknown> = { ...p };
    if (e.kind === "mouse" && typeof p.x === "number" && typeof p.y === "number") { const q = this.fit(p); params.x = q.x; params.y = q.y; }
    if (e.kind !== "text") params.timestamp = this.stamp(page, st);
    if (e.kind === "mouse" && p.type === "mousePressed") st.buttons.set(p.button, p.clickCount ?? 1);
    if (e.kind === "mouse" && p.type === "mouseReleased") st.buttons.delete(p.button);
    const pr = this.sendEvent(page, st, undefined, e.method, params);
    const r = await this.settle(a, pr);
    if ("ended" in r) { this.answerWith(page, e, pr); return; }
    if (!r.ok) { if (e.kind === "mouse" && p.type === "mousePressed") st.buttons.delete(p.button); return this.fail(page, st, e, r.error); }
    e.answer({ result: r.value ?? {} });
  }

  /** mouseMoved with no button down: no event to the last point; the client's line for a short move; else a path (C11, the pointer). */
  private async moveStep(page: StagePage, st: TabState, e: Entry): Promise<void> {
    const p = e.params, to = this.fit(p);
    if (st.plain) { this.count("plainAfterRecoveries"); return this.plainStep(page, st, e); }
    // A move to the page's last point sends nothing: it takes no lock and runs no activation.
    if (!st.rest && same(this.from(page, st), to) && !st.action?.over) { st.setup = st.setup && { ...st.setup, used: true }; e.answer({ result: {} }); this.count("sameMoves"); return; }
    const a = await this.begin(page, st);
    if (a.over) return this.endedEvent(page, st, e);
    const extra = { modifiers: p.modifiers ?? 0 };
    let from = this.from(page, st);
    // The hover's last leg: the samples of its path from the first one inside the target, at Playwright's move.
    const rest = st.rest;
    this.dropRest(st);
    let samples: Sample[] | null = null;
    if (rest && near(rest.to, to, 1.5) && same(from, rest.from)) { samples = rest.samples; this.count("hoverLastLegs"); }
    if (!samples) {
      if (same(from, to)) { st.setup = st.setup && { ...st.setup, used: true }; e.answer({ result: {} }); this.count("sameMoves"); return; }
      from ??= await this.startOf(page);
      if (!from) { this.count("plainNoStart"); return this.plainStep(page, st, e); }
      const spread = await this.spreadFor(page, st, p, to);
      const target = spread ?? to;
      samples = this.plan(page, st, from, target, this.widthOf(st));
      if (!samples.length) { e.answer({ result: {} }); return; }
    }
    const r = await this.play(page, st, a, samples, extra);
    if (r.error !== undefined) return this.fail(page, st, e, r.error);
    if (r.stopped) {
      // The bound or the end of the plan: the client's own move (its point), with Chrome's own answer.
      st.spread = null;
      if (a.over) { const r = await this.endedSend(page, st, e, { ...p, x: to.x, y: to.y }); if (r) this.answerWith(page, e, r.sent); return; }
      const params = { ...p, x: to.x, y: to.y, timestamp: this.stamp(page, st) };
      const pr = this.sendEvent(page, st, undefined, e.method, params);
      const s = await this.settle(a, pr);
      if ("ended" in s) { this.answerWith(page, e, pr); return; }
      if (!s.ok) return this.fail(page, st, e, s.error);
      e.answer({ result: s.value ?? {} });
      return;
    }
    e.answer({ result: {} });
  }

  /**
   * The spread point (C11, the pointer): only for a locator click (a hit-target setup of the action mouse, with the press
   * of clickCount 1 already here and no press of clickCount 2 or 3 in the action), at the middle of the element's content
   * quad (the client's own DOM.getContentQuads), on an element whose effect does not depend on the point, and where the
   * stage's own hit test at the spread point gives the same element. Else null: the press is at the client's point.
   */
  private async spreadFor(page: StagePage, st: TabState, p: any, to: Pt): Promise<Pt | null> {
    st.spread = null;
    const setup = st.setup;
    if (!setup || setup.used || setup.action !== "mouse" || setup.trial || !setup.node || !setup.hit) return null;
    setup.used = true;
    const presses = st.pending.filter((x) => x.kind === "mouse" && x.params.type === "mousePressed");
    if (!presses.length || presses[0].params.clickCount !== 1 || presses.some((x) => (x.params.clickCount ?? 1) >= 2)) return null;
    if (Math.abs(setup.hit.x - p.x) > 0.5 || Math.abs(setup.hit.y - p.y) > 0.5) return null; // a frame's point (not the top page's), or not this click's
    const quad = st.quads.get(setup.node);
    if (!quad) return null;
    const kind = await this.read(page.ownRead(ELEMENT_KIND, [p.x, p.y]));
    const r = await pressPoint({
      point: { x: p.x, y: p.y }, locatorClick: true, clickCount: 1, multiClick: false, quad,
      element: kind === TIMEOUT ? null : (kind as ElementKind | null),
      sameElementAt: async (q) => (await this.read(page.ownRead(SAME_ELEMENT, [p.x, p.y, q.x, q.y]))) === true,
    }, page.person, this.o.random);
    if (!r.spread) return null;
    this.count("spreadPresses");
    st.spread = { client: to, point: this.fit(r.point) };
    return st.spread.point;
  }

  /**
   * mousePressed: a pause when the press follows a path (one gap of a double click after the release before it for
   * clickCount 2 or 3), then the press with the client's button, buttons, clickCount and modifiers and force 0.5, at the
   * client's point rounded or at the spread point. The hold counts from the press's send.
   */
  private async pressStep(page: StagePage, st: TabState, e: Entry): Promise<void> {
    const p = e.params, client = this.fit(p);
    this.dropRest(st);
    if (st.plain) { this.count("plainAfterRecoveries"); return this.plainStep(page, st, e); }
    const a = await this.begin(page, st);
    if (a.over) return this.endedEvent(page, st, e);
    const P = page.person;
    const point = st.spread && same(st.spread.client, client) ? st.spread.point : client;
    let from = this.from(page, st);
    if (!same(from, point)) {
      // A press away from the last point (a client that pressed with no move): a path there first.
      from ??= await this.startOf(page);
      if (from && !same(from, point)) {
        const r = await this.play(page, st, a, this.plan(page, st, from, point, DEFAULT_WIDTH), { modifiers: p.modifiers ?? 0 });
        if (r.error !== undefined) return this.fail(page, st, e, r.error);
      }
    }
    if ((p.clickCount ?? 1) >= 2 && st.releasedAt > -Infinity) await this.until(a, st.releasedAt + doubleClickGapMs(P, this.o.random));
    else if (st.lastWasMove) await this.until(a, st.lastMoveAt + pauseMs(P, this.o.random));
    // A press with no path after the client's modifier press (the pointer was there already): a chord's time after it.
    const mods = [...st.keys.values()].filter((k) => MODIFIER_KEYS.has(k.params.key)).map((k) => k.at);
    if (mods.length) await this.until(a, Math.max(...mods) + draw(this.o.random, P.params.keys.chord.beforeMs));
    if (a.over) {
      const r = await this.endedSend(page, st, e, { ...p, x: point.x, y: point.y, force: force(P) });
      if (!r) return;
      const { sent } = r;
      st.buttons.set(p.button, p.clickCount ?? 1);
      st.press = { at: this.clock.now(), hold: 0, client, point, button: p.button };
      this.answerWith(page, e, sent);
      return;
    }
    const params = { ...p, x: point.x, y: point.y, force: force(P), timestamp: this.stamp(page, st) };
    const at = this.clock.now();
    const pr = this.sendEvent(page, st, undefined, e.method, params);
    st.buttons.set(p.button, p.clickCount ?? 1);
    st.press = { at, hold: holdMs(P, this.o.random), client, point, button: p.button };
    if (a.over) { this.answerWith(page, e, pr); return; }
    const r = await this.settle(a, pr);
    if ("ended" in r) { this.answerWith(page, e, pr); return; }
    if (!r.ok) { st.buttons.delete(p.button); st.press = null; return this.fail(page, st, e, r.error); }
    e.answer({ result: r.value ?? {} });
  }

  /** mouseReleased: at the later of its arrival and the press's send plus the hold, at the press's point. */
  private async releaseStep(page: StagePage, st: TabState, e: Entry): Promise<void> {
    const p = e.params, client = this.fit(p);
    this.dropRest(st);
    // A release of a button that the stage released at the end of a plan: no event (a button that is up cannot go up).
    if (st.released.delete(p.button) && !st.buttons.has(p.button)) { this.count("releasedAlready"); e.answer({ result: {} }); return; }
    if (st.plain) { this.count("plainAfterRecoveries"); return this.plainStep(page, st, e); }
    const a = await this.begin(page, st);
    if (a.over) return this.endedEvent(page, st, e);
    const pr0 = st.press && st.press.button === p.button ? st.press : null;
    const point = pr0 && same(pr0.client, client) ? pr0.point : client;
    if (pr0) await this.until(a, pr0.at + pr0.hold);
    if (a.over) {
      const r = await this.endedSend(page, st, e, { ...p, x: point.x, y: point.y });
      if (!r) return;
      const { sent } = r;
      st.buttons.delete(p.button); st.releasedAt = this.clock.now(); st.press = null; st.spread = null;
      this.answerWith(page, e, sent);
      return;
    }
    const params = { ...p, x: point.x, y: point.y, timestamp: this.stamp(page, st) };
    const pr = this.sendEvent(page, st, undefined, e.method, params);
    st.buttons.delete(p.button);
    st.releasedAt = this.clock.now();
    st.press = null; st.spread = null;
    if (a.over) { this.answerWith(page, e, pr); return; }
    const r = await this.settle(a, pr);
    if ("ended" in r) { this.answerWith(page, e, pr); return; }
    if (!r.ok) return this.fail(page, st, e, r.error);
    e.answer({ result: r.value ?? {} });
  }

  /**
   * A key (this part: the modifier of a click). Playwright presses a click's modifier after the hit-target setup and waits
   * for its answer before the move, so its press goes as it comes; its release goes 60 to 200 ms after the mouse release
   * (C11 modifierAfterMs), else as it comes. Every other key goes as the client sent it (the keys: board ab-t30.10).
   */
  private async keyStep(page: StagePage, st: TabState, e: Entry): Promise<void> {
    const p = e.params;
    if (p.type === "keyUp" && st.released.delete(`key:${p.code}`) && !st.keys.has(p.code)) { this.count("releasedAlready"); e.answer({ result: {} }); return; }
    const a = await this.begin(page, st);
    if (a.over) return this.endedEvent(page, st, e);
    const down = st.keys.get(p.code);
    if (p.type === "keyUp") {
      if (down && MODIFIER_KEYS.has(p.key) && st.releasedAt >= down.at) await this.until(a, st.releasedAt + modifierAfterMs(page.person, this.o.random));
      else if (!MODIFIER_KEYS.has(p.key)) this.count("plainKeys");
      st.keys.delete(p.code);
    } else {
      st.keys.set(p.code, { at: this.clock.now(), params: p });
      if (!MODIFIER_KEYS.has(p.key)) this.count("plainKeys");
    }
    if (a.over) {
      const r = await this.endedSend(page, st, e, { ...p });
      // No event went: the key is as it was (a held key stays held for its release; a key that did not go is not down).
      if (!r) { if (p.type === "keyUp") { if (down) st.keys.set(p.code, down); } else if (down) st.keys.set(p.code, down); else st.keys.delete(p.code); return; }
      this.answerWith(page, e, r.sent);
      return;
    }
    const pr = this.sendEvent(page, st, undefined, e.method, { ...p, timestamp: this.stamp(page, st) });
    if (a.over) { this.answerWith(page, e, pr); return; }
    const r = await this.settle(a, pr);
    if ("ended" in r) { this.answerWith(page, e, pr); return; }
    if (!r.ok) { if (p.type !== "keyUp") st.keys.delete(p.code); return this.fail(page, st, e, r.error); }
    e.answer({ result: r.value ?? {} });
  }

  /**
   * The hit-target setup (C11, the hit-target check and its misses): after a miss of the tab, the recovery at this setup
   * (at most two in one action, then the rest as Playwright sends it); for a hover, the path's samples outside the target
   * before the setup and the rest at Playwright's move; then the setup itself, whose answer the stage watches.
   */
  private async setupStep(page: StagePage, st: TabState, e: Entry): Promise<void> {
    const [, nodeArg, opts] = (Array.isArray(e.util?.args[0]) ? e.util!.args[0] : []) as [unknown, Handle | undefined, any];
    const node = nodeArg?.handle;
    const action = String(opts?.actionType ?? ""), trial = opts?.trial === true;
    const hit = opts?.hitPoint && typeof opts.hitPoint.x === "number" && typeof opts.hitPoint.y === "number" ? { x: opts.hitPoint.x, y: opts.hitPoint.y } : null;
    // A miss marks the tab for the next setup of its node within RETRY_MARK_MS; one action's recoveries are the setups of
    // one node that each follow such a miss. A setup with no such miss starts a new count.
    const marked = st.miss && this.clock.now() - st.missAt <= RETRY_MARK_MS && st.missNode === node;
    st.miss = false;
    if (!st.recov || st.recov.node !== node || !marked) st.recov = { node, n: 0 };
    // The plain mode covers one attempt: from this setup to its own miss, its stop's answer, or the end of the stage's action.
    st.plain = false;
    st.setup = { node, child: e.child, action, hit, trial, used: false };
    st.spread = null; this.dropRest(st);
    const live = !st.action?.over;
    let stopped = false;
    if (live && !trial && hit && node) {
      if (marked) {
        if (st.recov.n >= RECOVERIES_MAX) {
          if (!st.recov.limited) { st.recov.limited = true; this.count("recoveryLimits"); this.o.log(`relay: the input stage: tab ${page.id} reached ${RECOVERIES_MAX} recoveries in one action; each later attempt goes as the client sends it`); }
          this.count("plainAttempts");
          st.plain = true;
        } else {
          st.recov.n++;
          // A refused move of the recovery stops the plan (C11, an error of an event): no hover path, no new action.
          stopped = !(await this.recover(page, st, e, node, hit));
        }
      }
      if (action === "hover" && !st.plain && !stopped) await this.hoverBefore(page, st, e, node, hit);
    }
    this.count("setups");
    if (this.o.trace) this.o.log(`relay: the input stage: tab ${page.id}: a setup of ${action || "?"}${trial ? " (trial)" : ""}, ${st.recov.n} recoveries of its node${st.plain ? ", plain" : ""}`);
    await page.pass(e.child, e.method, e.params, (body: any) => {
      const r = body?.result?.result;
      // A miss of the setup ends its attempt (Playwright sends no input for it), so its plain mode ends too.
      if (r?.type === "string") { st.miss = true; st.missAt = this.clock.now(); st.missNode = node; st.plain = false; this.count("setupMisses"); }
      else if (typeof r?.objectId === "string") {
        st.handles.delete(r.objectId); st.handles.set(r.objectId, node);
        while (st.handles.size > KEPT_MAX) st.handles.delete(st.handles.keys().next().value!);
      }
      // A kept rest waits for Playwright's move from the setup's answer on (a miss: Playwright sends no move).
      if (st.rest) { if (r?.type === "string") { this.dropRest(st); if (!st.running) void this.afterStep(page, st); } else this.keepRest(page, st); }
      e.answer(body);
    });
  }

  /**
   * The frame mapping (C11): the node's box and its frame's offset in the top page's points. Same-origin levels by one
   * read in Playwright's utility world on the node's handle; each cross-origin level by its owner on the parent's session
   * (DOM.getFrameOwner) and the owner's content box there. Null when a read fails, a frame has a transform, or the
   * owner's quad is not a rectangle (the stage then fails open).
   */
  private async nodeGeo(page: StagePage, st: TabState, child: string | undefined, node: string): Promise<{ ox: number; oy: number; box: Rect } | null> {
    const g = await this.read(page.send(child, "Runtime.callFunctionOn", { objectId: node, functionDeclaration: NODE_GEO, returnByValue: true }));
    const v = g === TIMEOUT ? null : (g as any)?.result?.value;
    if (!v || typeof v.ox !== "number" || !v.box || v.flat === false) return null;
    let ox = v.ox, oy = v.oy, s = child;
    if (!s && !v.top) return null;
    for (let level = 0; s && level < 8; level++) {
      let f = st.frames.get(s);
      if (!f) {
        // No attach record of this session: its own target info names the frame; its parent is the tab's own session.
        const info = await this.read(page.send(s, "Target.getTargetInfo", {}));
        const id = info === TIMEOUT ? undefined : (info as any)?.targetInfo?.targetId;
        if (typeof id !== "string") { this.count("frameMapFails"); return null; }
        f = { frameId: id, parent: undefined };
        st.frames.set(s, f);
      }
      const owner = await this.read(page.send(f.parent, "DOM.getFrameOwner", { frameId: f.frameId }));
      const backendNodeId = owner === TIMEOUT ? undefined : (owner as any)?.backendNodeId;
      if (!Number.isInteger(backendNodeId)) return null;
      const box = await this.read(page.send(f.parent, "DOM.getBoxModel", { backendNodeId }));
      const r = box === TIMEOUT ? null : quadRect((box as any)?.model?.content);
      if (!r) return null;
      ox += r.x0; oy += r.y0;
      s = f.parent;
    }
    if (s) return null;
    const b = v.box as Rect;
    return { ox, oy, box: { x0: b.x0 - v.ox + ox, y0: b.y0 - v.oy + oy, x1: b.x1 - v.ox + ox, y1: b.y1 - v.oy + oy } };
  }

  /**
   * The hover (C11, the pointer): at the setup the stage plans the whole path to Playwright's point (mapped to the top
   * page), sends its samples outside the target's box, and keeps the rest (from its first sample inside the box) for
   * Playwright's move. When the pointer is inside the box already, the whole path goes after the setup. A failed mapping:
   * no path before the setup (the naive way, a retry of Playwright's), and the stage counts it.
   */
  private async hoverBefore(page: StagePage, st: TabState, e: Entry, node: string, hit: Pt): Promise<void> {
    const geo = await this.nodeGeo(page, st, e.child, node);
    if (!geo) { this.count("hoverNaive"); return; }
    const to = this.fit({ x: hit.x + geo.ox, y: hit.y + geo.oy });
    const a = await this.begin(page, st);
    if (a.over) return;
    let from = this.from(page, st) ?? await this.startOf(page);
    if (!from || same(from, to)) return;
    const box = geo.box, samples = this.plan(page, st, from, to, Math.max(1, Math.min(box.x1 - box.x0, box.y1 - box.y0)));
    if (inside(from, box)) { st.rest = { to, from, samples }; return; }
    const i = samples.findIndex((q) => inside(q, box));
    const before = i < 0 ? samples : samples.slice(0, i);
    const r = await this.play(page, st, a, before, { modifiers: 0 });
    if (r.error !== undefined) { this.stopPlan(page, st, "Input.dispatchMouseEvent", r.error); this.freeTail(st); this.close(st, page.id); return; }
    if (r.stopped) return;
    if (i < 0) return;
    if (before.length) from = st.last!;
    const t0 = i > 0 ? samples[i - 1].t : 0;
    st.rest = { to, from, samples: samples.slice(i).map((q) => ({ ...q, t: q.t - t0 })) };
    this.count("hoverPathsBeforeSetup");
  }

  /**
   * The recovery at the next setup of a marked tab (C11): the element at the hit point, when it is not the target or inside
   * it; its highest ancestor that does not hold the target; a path out of both boxes, on the side away from the target, to
   * a point 15 px outside; two frames; the ancestor's box again, which the next path goes around.
   */
  private async recover(page: StagePage, st: TabState, e: Entry, node: string, hit: Pt): Promise<boolean> {
    const found = await this.read(page.send(e.child, "Runtime.callFunctionOn", { objectId: node, functionDeclaration: OBSTACLE_FIND, arguments: [{ value: hit.x }, { value: hit.y }], returnByValue: false }));
    const handle = found === TIMEOUT ? undefined : (found as any)?.result?.objectId;
    if (typeof handle !== "string") return true;
    try {
      const geo = await this.nodeGeo(page, st, e.child, node);
      if (!geo && e.child) return true;
      const ox = geo?.ox ?? 0, oy = geo?.oy ?? 0;
      const both = await this.read(page.send(e.child, "Runtime.callFunctionOn", { objectId: handle, functionDeclaration: OBSTACLE_BOTH, returnByValue: true }));
      const b = both === TIMEOUT ? null : (both as any)?.result?.value as Rect | null;
      if (!b) return true;
      const box = { x0: b.x0 + ox, y0: b.y0 + oy, x1: b.x1 + ox, y1: b.y1 + oy }, H = { x: hit.x + ox, y: hit.y + oy };
      this.count("recoveries");
      this.o.log(`relay: the input stage: a recovery in tab ${page.id} after a miss of the hit-target check`);
      const a = await this.begin(page, st);
      if (a.over) return true;
      const at = this.from(page, st) ?? { x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2 };
      const lm = await this.read(page.send(undefined, "Page.getLayoutMetrics", {}));
      const v = lm === TIMEOUT ? null : (lm as any)?.cssLayoutViewport;
      const W = v?.clientWidth > 0 ? v.clientWidth : Infinity, Hh = v?.clientHeight > 0 ? v.clientHeight : Infinity;
      const exits = [{ x: box.x0 - RECOVERY_EXIT_PX, y: at.y }, { x: box.x1 + RECOVERY_EXIT_PX, y: at.y }, { x: at.x, y: box.y0 - RECOVERY_EXIT_PX }, { x: at.x, y: box.y1 + RECOVERY_EXIT_PX }]
        .map((q) => this.fit(q)).filter((q) => q.x >= 2 && q.y >= 2 && q.x <= W - 3 && q.y <= Hh - 3)
        .sort((p, q) => Math.hypot(q.x - H.x, q.y - H.y) - Math.hypot(p.x - H.x, p.y - H.y));
      if (exits[0] && !same(at, exits[0])) {
        const r = await this.play(page, st, a, this.plan(page, st, at, exits[0], DEFAULT_WIDTH), { modifiers: 0 });
        if (r.error !== undefined) { this.stopPlan(page, st, "Input.dispatchMouseEvent", r.error); this.freeTail(st); this.close(st, page.id); return false; }
        if (r.stopped) return true;
      }
      await this.read(page.send(e.child, "Runtime.callFunctionOn", { objectId: handle, functionDeclaration: TWO_FRAMES, awaitPromise: true, returnByValue: true }));
      const again = await this.read(page.send(e.child, "Runtime.callFunctionOn", { objectId: handle, functionDeclaration: OBSTACLE_AGAIN, returnByValue: true }));
      const k = again === TIMEOUT ? null : (again as any)?.result?.value as Rect | null;
      if (k) st.avoid = { x0: k.x0 + ox, y0: k.y0 + oy, x1: k.x1 + ox, y1: k.y1 + oy };
      return true;
    } finally {
      void page.send(e.child, "Runtime.releaseObject", { objectId: handle }).catch(() => {});
    }
  }
}
