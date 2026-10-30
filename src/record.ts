// `record`: a scripted screen recording of one allowlisted tab, to MP4. A step script drives the tab
// with visible, paced input (a demo cursor moves along a curved path, clicks ripple, typing is paced)
// while CDP screencast frames arrive through the consumer's proxy; ffmpeg turns them into a
// constant-rate MP4. The step format is vedlo capture's (vedlo tools/capture/capture.ts), plus {x, y}
// targets, key combinations and waitFor, for canvas apps such as Google Sheets, whose grid has no
// selectors.
//
// It records the agent browser in place, so a site that refuses automation-flagged Chrome (Google
// sign-in) can be recorded signed in. Safety: only an allowlisted tab (and in personal mode only one
// in the pinned window); the run stops, and writes nothing, when the tab leaves the allowlist.
//
// The page is changed only for the run: the device metrics override is cleared and the overlay
// removed afterwards. The overlay is built with DOM calls only (createElement, setAttribute,
// element.style, element.animate) in our isolated world: Google Sheets enforces Trusted Types and a
// strict style-src, so innerHTML and a <style> element are refused there.
//
// Cursor motion: the path is ghost-cursor's (a Bezier curve with its spread, and its overshoot past
// 500 px); the timing is ours, a Fitts's-law duration with a minimum-jerk speed profile along that
// path, because ghost-cursor's own timestamps move at one constant speed. The page draws every frame
// of a move from one call (requestAnimationFrame); the real mouse follows on its own. All randomness
// comes from one seeded generator (--seed), so a retake moves and types the same way.

import { execFileSync, spawn } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { KEYS, type Tab, type Viewport } from "./browser.ts";
import { assertAllowedUrl, isAllowedUrl } from "./allowlist.ts";
import { AgentBrowserError, NotAllowedError, UsageError, runCleanup, safeHost, withCleanupErrors } from "./errors.ts";
import { statePath } from "./options.ts";
import { idx } from "./outline.ts";

// ---------- the step script ----------

export type Point = { x: number; y: number };
export type Box = { x: number; y: number; width: number; height: number };
/** A CSS selector (or #N from outline), or a point in CSS pixels of the recorded viewport. */
export type StepTarget = string | Point;

export type Step =
  | { wait: number }                                               // ms
  | { goto: string }                                               // an allowlisted URL
  | { click: StepTarget; duration?: number }                       // move (ms; default from the distance), then a trusted click
  | { hover: StepTarget; duration?: number }
  | { type: string; into?: StepTarget; delay?: number }            // per-character ms
  | { press: string; repeat?: number; delay?: number }             // "Enter", "ArrowDown", "Shift+Tab", "Meta+A"
  | { scroll: string | number; duration?: number }                 // selector (smooth, to the centre) or a wheel delta in px
  | { highlight: string | Box; duration?: number }                 // a ring around an element or a box
  | { waitFor: string; text?: string; timeoutMs?: number }         // an element (with this text) is visible
  | { eval: string };                                              // escape hatch, in our isolated world

const ACTIONS = ["wait", "goto", "click", "hover", "type", "press", "scroll", "highlight", "waitFor", "eval"] as const;
type Action = (typeof ACTIONS)[number];
const OPTIONS: Record<Action, string[]> = {
  wait: [], goto: [], click: ["duration"], hover: ["duration"], type: ["into", "delay"], press: ["repeat", "delay"],
  scroll: ["duration"], highlight: ["duration"], waitFor: ["text", "timeoutMs"], eval: [],
};

/** The longest recording, in seconds: the frames sit on disk until the MP4 is encoded. */
export const MAX_RECORD_SECONDS = 1800;
const MAX_STEP_MS = 10 * 60_000;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Check a step script (the parsed JSON array) before anything touches the tab. Every problem is a
 * usage error that names the step; a goto off the allowlist is refused here too.
 */
export function parseSteps(raw: unknown, viewport: Viewport, allow: readonly string[], what = "step"): Step[] {
  if (!Array.isArray(raw)) throw new UsageError(`the ${what} script must be a JSON array of steps`);
  return raw.map((step, i) => {
    const bad = (why: string) => new UsageError(`${what} ${i + 1} (${JSON.stringify(step)?.slice(0, 120)}): ${why}`);
    if (!isObject(step)) throw bad("a step is an object such as {\"click\": \"#save\"}");
    const actions = ACTIONS.filter((a) => a in step);
    if (actions.length !== 1) throw bad(`a step has exactly one of ${ACTIONS.join(", ")}`);
    const action = actions[0];
    for (const k of Object.keys(step)) if (k !== action && !OPTIONS[action].includes(k)) throw bad(`"${k}" is not an option of ${action} (options: ${OPTIONS[action].join(", ") || "none"})`);
    const ms = (k: string) => {
      if (step[k] !== undefined && (!finite(step[k]) || (step[k] as number) < 0 || (step[k] as number) > MAX_STEP_MS)) throw bad(`${k} must be a number of ms from 0 to ${MAX_STEP_MS}`);
    };
    const target = (k: string) => {
      const t = step[k];
      if (typeof t === "string") { if (!t) throw bad(`${k} is an empty selector`); return; }
      if (!isObject(t) || !finite(t.x) || !finite(t.y) || Object.keys(t).some((key) => key !== "x" && key !== "y")) throw bad(`${k} is a CSS selector, #N, or {"x": .., "y": ..}`);
      if (t.x < 0 || t.y < 0 || t.x > viewport.width || t.y > viewport.height) throw bad(`${k} is outside the ${viewport.width}x${viewport.height} viewport`);
    };
    switch (action) {
      case "wait": ms("wait"); break;
      case "goto":
        if (typeof step.goto !== "string") throw bad("goto is a URL");
        assertAllowedUrl(step.goto, allow);
        break;
      case "click": case "hover": target(action); ms("duration"); break;
      case "type":
        if (typeof step.type !== "string") throw bad("type is the text to type");
        if (step.into !== undefined) target("into");
        ms("delay");
        break;
      case "press":
        if (typeof step.press !== "string") throw bad("press is a key such as Enter or Shift+Tab");
        try { parseKey(step.press); } catch (e) { throw bad((e as Error).message); }
        if (step.repeat !== undefined && (!Number.isInteger(step.repeat) || (step.repeat as number) < 1 || (step.repeat as number) > 100)) throw bad("repeat is a whole number from 1 to 100");
        ms("delay");
        break;
      case "scroll":
        if (!(typeof step.scroll === "string" && step.scroll) && !finite(step.scroll)) throw bad("scroll is a selector or a number of pixels");
        ms("duration");
        break;
      case "highlight": {
        const h = step.highlight;
        const box = isObject(h) && ["x", "y", "width", "height"].every((k) => finite(h[k])) && Object.keys(h).length === 4;
        if (!(typeof h === "string" && h) && !box) throw bad('highlight is a selector or {"x", "y", "width", "height"}');
        ms("duration");
        break;
      }
      case "waitFor":
        if (typeof step.waitFor !== "string" || !step.waitFor) throw bad("waitFor is a CSS selector or #N");
        if (step.text !== undefined && typeof step.text !== "string") throw bad("text is the text the element must contain");
        ms("timeoutMs");
        break;
      case "eval": if (typeof step.eval !== "string") throw bad("eval is a JavaScript expression"); break;
    }
    return step as Step;
  });
}

/** "1920x1080" -> 1920 by 1080 CSS pixels. */
export function parseSize(size: string): { width: number; height: number } {
  const m = /^(\d{2,5})x(\d{2,5})$/.exec(size.trim());
  if (!m) throw new UsageError(`--size is WIDTHxHEIGHT in CSS pixels, for example 1920x1080, not ${JSON.stringify(size)}`);
  const width = Number(m[1]), height = Number(m[2]);
  if (width < 100 || height < 100 || width > 7680 || height > 4320) throw new UsageError("--size is from 100x100 to 7680x4320");
  return { width, height };
}

/** A device pixel ratio for an exact size: from 0.5 to 4. */
export function checkScale(scale: number): number {
  if (!finite(scale) || scale < 0.5 || scale > 4) throw new UsageError("--scale is a device pixel ratio from 0.5 to 4 (1 or 2 as a rule)");
  return scale;
}

// ---------- keys ----------

export type KeyEvent = { key: string; code: string; keyCode: number; text?: string; modifiers: number };

const MODIFIERS: Record<string, number> = { alt: 1, option: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, command: 4, shift: 8 };
const SHIFT = 8;
// US layout: the code, the key code and whether Shift is down for each printable character.
const PUNCTUATION: Record<string, [string, number, boolean]> = {
  " ": ["Space", 32, false], "-": ["Minus", 189, false], _: ["Minus", 189, true], "=": ["Equal", 187, false], "+": ["Equal", 187, true],
  "[": ["BracketLeft", 219, false], "{": ["BracketLeft", 219, true], "]": ["BracketRight", 221, false], "}": ["BracketRight", 221, true],
  "\\": ["Backslash", 220, false], "|": ["Backslash", 220, true], ";": ["Semicolon", 186, false], ":": ["Semicolon", 186, true],
  "'": ["Quote", 222, false], '"': ["Quote", 222, true], ",": ["Comma", 188, false], "<": ["Comma", 188, true],
  ".": ["Period", 190, false], ">": ["Period", 190, true], "/": ["Slash", 191, false], "?": ["Slash", 191, true],
  "`": ["Backquote", 192, false], "~": ["Backquote", 192, true],
};
const SHIFTED_DIGITS = ")!@#$%^&*(";

/** The US-layout key that types `ch`, or undefined (the character is then inserted as text). */
export function charKey(ch: string): KeyEvent | undefined {
  if (/^[a-z]$/.test(ch)) return { key: ch, code: `Key${ch.toUpperCase()}`, keyCode: ch.toUpperCase().charCodeAt(0), text: ch, modifiers: 0 };
  if (/^[A-Z]$/.test(ch)) return { key: ch, code: `Key${ch}`, keyCode: ch.charCodeAt(0), text: ch, modifiers: SHIFT };
  if (/^[0-9]$/.test(ch)) return { key: ch, code: `Digit${ch}`, keyCode: ch.charCodeAt(0), text: ch, modifiers: 0 };
  const d = SHIFTED_DIGITS.indexOf(ch);
  if (d >= 0) return { key: ch, code: `Digit${d}`, keyCode: 48 + d, text: ch, modifiers: SHIFT };
  const p = PUNCTUATION[ch];
  return p ? { key: ch, code: p[0], keyCode: p[1], text: ch, modifiers: p[2] ? SHIFT : 0 } : undefined;
}

/**
 * "Enter", "ArrowDown", "Shift+ArrowDown", "Meta+A", "Control+Home". A letter in a chord is the key
 * itself, in either case (Meta+A is Cmd-A, not Cmd-Shift-A). With Control, Alt or Meta down, nothing
 * is typed.
 */
export function parseKey(spec: string): KeyEvent {
  const m = /^((?:[A-Za-z]+\+)*)(.+)$/.exec(spec);
  if (!m) throw new UsageError(`unknown key ${JSON.stringify(spec)}`);
  let modifiers = 0;
  for (const name of m[1].split("+").filter(Boolean)) {
    const bit = MODIFIERS[name.toLowerCase()];
    if (!bit) throw new UsageError(`unknown modifier ${JSON.stringify(name)} in ${JSON.stringify(spec)}; use Shift, Control, Alt or Meta`);
    modifiers |= bit;
  }
  const name = m[2];
  const named = KEYS[name];
  let k: KeyEvent | undefined;
  if (named) k = { key: name, code: named.code, keyCode: named.keyCode, text: named.text, modifiers: 0 };
  else if (/^[A-Za-z]$/.test(name) && modifiers) {
    const ch = modifiers & SHIFT ? name.toUpperCase() : name.toLowerCase();
    k = { key: ch, code: `Key${name.toUpperCase()}`, keyCode: name.toUpperCase().charCodeAt(0), text: ch, modifiers: 0 };
  } else k = charKey(name);
  if (!k) throw new UsageError(`unknown key ${JSON.stringify(name)}; known: ${Object.keys(KEYS).join(", ")}, or one US-keyboard character`);
  const all = modifiers | k.modifiers;
  return { ...k, modifiers: all, text: all & ~SHIFT ? undefined : k.text };
}

/**
 * macOS: Chrome runs editing keys and shortcuts in a text field (Backspace, the arrows, Cmd-A, Cmd-C)
 * through editing commands that the OS key event carries. A CDP key event has none, so we name them,
 * as a real Mac keyboard would. A page that handles the key itself (preventDefault) still does.
 */
const MAC_COMMANDS: Record<string, string[]> = {
  Backspace: ["deleteBackward"], Delete: ["deleteForward"], ArrowUp: ["moveUp"], ArrowDown: ["moveDown"], ArrowLeft: ["moveLeft"], ArrowRight: ["moveRight"],
  "Shift+ArrowUp": ["moveUpAndModifySelection"], "Shift+ArrowDown": ["moveDownAndModifySelection"],
  "Shift+ArrowLeft": ["moveLeftAndModifySelection"], "Shift+ArrowRight": ["moveRightAndModifySelection"],
  Home: ["scrollToBeginningOfDocument"], End: ["scrollToEndOfDocument"], PageUp: ["scrollPageUp"], PageDown: ["scrollPageDown"],
  "Meta+KeyA": ["selectAll"], "Meta+KeyC": ["copy"], "Meta+KeyX": ["cut"], "Meta+KeyV": ["paste"], "Meta+KeyZ": ["undo"], "Shift+Meta+KeyZ": ["redo"],
  "Alt+Backspace": ["deleteWordBackward"], "Meta+Backspace": ["deleteToBeginningOfLine"],
  "Meta+ArrowLeft": ["moveToLeftEndOfLine"], "Meta+ArrowRight": ["moveToRightEndOfLine"], "Alt+ArrowLeft": ["moveWordLeft"], "Alt+ArrowRight": ["moveWordRight"],
};

export function macCommands(k: KeyEvent): string[] {
  const prefix = [[SHIFT, "Shift"], [2, "Control"], [1, "Alt"], [4, "Meta"]].filter(([bit]) => k.modifiers & (bit as number)).map(([, n]) => `${n}+`).join("");
  return MAC_COMMANDS[prefix + k.code] ?? [];
}

// ---------- ffmpeg ----------

/** The ffmpeg to encode with: the --ffmpeg path, else ffmpeg on PATH. It must run and have libx264. */
export function findFfmpeg(explicit?: string, path = process.env.PATH ?? ""): string {
  let bin: string | undefined;
  if (explicit !== undefined) {
    if (!isAbsolute(explicit)) throw new UsageError(`--ffmpeg must be an absolute path: ${explicit}`);
    bin = explicit;
  } else {
    bin = path.split(delimiter).filter(Boolean).map((d) => join(d, "ffmpeg")).find((p) => { try { accessSync(p, constants.X_OK); return statSync(p).isFile(); } catch { return false; } });
    if (!bin) throw new UsageError("record needs ffmpeg, and there is none on PATH: install it (macOS: brew install ffmpeg; Debian: apt install ffmpeg) or pass --ffmpeg /abs/path/to/ffmpeg");
  }
  let encoders: string;
  try { encoders = execFileSync(bin, ["-hide_banner", "-encoders"], { encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 8 << 20 }); }
  catch (e) { throw new UsageError(`cannot run ffmpeg at ${bin}: ${(e as Error).message.split("\n")[0]}`); }
  if (!/\blibx264\b/.test(encoders)) throw new UsageError(`ffmpeg at ${bin} has no libx264 encoder; install an ffmpeg built with it`);
  return bin;
}

// ---------- cursor motion ----------

/** One leg of a move: points along ghost-cursor's curve, travelled in `ms` with a minimum-jerk speed profile. */
export type Leg = { points: Point[]; ms: number };

/** mulberry32: a small seeded generator, so a retake with the same --seed moves and types the same way. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Minimum jerk: slow start, fast middle, slow arrival. */
const minJerk = (u: number) => u * u * u * (10 - 15 * u + 6 * u * u);

/** The point `elapsed` ms into a move (the same arithmetic as overlayMove draws in the page). */
export function pointAt(legs: Leg[], elapsed: number): Point {
  for (const leg of legs) {
    if (elapsed > leg.ms) { elapsed -= leg.ms; continue; }
    return alongPath(leg.points, minJerk(leg.ms > 0 ? elapsed / leg.ms : 1));
  }
  const last = legs[legs.length - 1].points;
  return last[last.length - 1];
}

function alongPath(points: Point[], f: number): Point {
  const cum = [0];
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
  const want = f * cum[cum.length - 1];
  let i = 1;
  while (i < cum.length - 1 && cum[i] < want) i++;
  const seg = cum[i] - cum[i - 1], k = seg > 0 ? (want - cum[i - 1]) / seg : 1;
  return { x: points[i - 1].x + (points[i].x - points[i - 1].x) * k, y: points[i - 1].y + (points[i].y - points[i - 1].y) * k };
}

type GhostPath = (start: Point, end: Point | Box, options?: { spreadOverride?: number }) => Point[];
type GhostOvershoot = (coordinate: Point, radius: number) => Point;
let ghost: { path: GhostPath; overshoot: GhostOvershoot } | undefined;

/** ghost-cursor, loaded on first use (only a recording needs it). */
async function ghostCursor() {
  if (!ghost) {
    const [{ path }, { overshoot }] = await Promise.all([import("ghost-cursor"), import("ghost-cursor/lib/math.js")]);
    ghost = { path: path as GhostPath, overshoot: overshoot as GhostOvershoot };
  }
  return ghost;
}

/** ghost-cursor draws its random numbers from Math.random: give it ours, only while it runs (it is synchronous). */
function withRandom<T>(random: () => number, fn: () => T): T {
  const saved = Math.random;
  Math.random = random;
  try { return fn(); } finally { Math.random = saved; }
}

/** ghost-cursor's move(): over this distance it first overshoots to a point near the target, then corrects. */
const OVERSHOOT_THRESHOLD = 500, OVERSHOOT_RADIUS = 120, OVERSHOOT_SPREAD = 10;

/** Fitts's law: about 250 ms + 110 ms x log2(1 + D/W), W the target's smaller side, from 300 to 1000 ms. */
export const fittsMs = (distance: number, width: number) => Math.min(1000, Math.max(300, 250 + 110 * Math.log2(1 + distance / Math.max(1, width))));

/** The legs of one move from `from` to `to` (W: the target's smaller side). `duration` overrides the total time. */
export async function planMove(from: Point, to: Point, width: number, random: () => number, duration?: number): Promise<Leg[]> {
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  if (distance < 1) return [];
  const { path, overshoot } = await ghostCursor();
  const end = { x: to.x, y: to.y, width, height: width };
  let legs: Leg[];
  if (distance > OVERSHOOT_THRESHOLD) {
    const over = withRandom(random, () => overshoot(to, OVERSHOOT_RADIUS));
    const first = withRandom(random, () => path(from, over));
    const second = withRandom(random, () => path(over, end, { spreadOverride: OVERSHOOT_SPREAD }));
    legs = [
      { points: first, ms: fittsMs(Math.hypot(over.x - from.x, over.y - from.y), width) },
      { points: second, ms: Math.max(150, fittsMs(Math.hypot(to.x - over.x, to.y - over.y), width) * 0.5) },
    ];
  } else legs = [{ points: withRandom(random, () => path(from, end)), ms: fittsMs(distance, width) }];
  const last = legs[legs.length - 1].points;
  last[last.length - 1] = { x: to.x, y: to.y }; // ghost-cursor clamps at 0; the move ends exactly on the target
  if (duration !== undefined) {
    const total = legs.reduce((a, l) => a + l.ms, 0);
    for (const leg of legs) leg.ms = (leg.ms / total) * duration;
  }
  return legs;
}

// ---------- the page side (our isolated world; DOM calls only) ----------

type OverlayState = { host: HTMLElement; root: ShadowRoot; pointer: HTMLElement | null; live: boolean; move: number };

/** Install the overlay unless it is there: a 1x1 pixel that changes every animation frame (so a still page still delivers frames) and the cursor. */
function overlayEnsure(cursor: boolean, x: number, y: number): boolean {
  const g = globalThis as unknown as { __agentBrowserRecord?: OverlayState };
  if (g.__agentBrowserRecord?.host.isConnected) return false;
  const host = document.createElement("div");
  // The host is in the page's DOM, so the page's style sheets reach it: !important wins over them. Inside
  // the closed shadow root no page style applies.
  const hostStyle: Record<string, string> = { position: "fixed", left: "0", top: "0", width: "0", height: "0", margin: "0", padding: "0", border: "0", overflow: "visible", "z-index": "2147483647", "pointer-events": "none", display: "block" };
  for (const k of Object.keys(hostStyle)) host.style.setProperty(k, hostStyle[k], "important");
  host.setAttribute("aria-hidden", "true");
  const root = host.attachShadow({ mode: "closed" });
  const pixel = document.createElement("div");
  Object.assign(pixel.style, { position: "fixed", left: "0", top: "0", width: "1px", height: "1px", opacity: "0.01", pointerEvents: "none" });
  root.appendChild(pixel);
  let pointer: HTMLElement | null = null;
  if (cursor) {
    pointer = document.createElement("div");
    // The arrow's tip is at (5, 3) in its box, so the box sits at (x - 5, y - 3): the tip is the point.
    Object.assign(pointer.style, { position: "fixed", left: "0", top: "0", width: "28px", height: "28px", pointerEvents: "none", willChange: "transform",
      transform: `translate(${x - 5}px, ${y - 3}px)`, filter: "drop-shadow(0 2px 3px rgba(0,0,0,.35))" });
    const svgNs = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNs, "svg");
    svg.setAttribute("width", "28");
    svg.setAttribute("height", "28");
    svg.setAttribute("viewBox", "0 0 28 28");
    const arrow = document.createElementNS(svgNs, "path");
    arrow.setAttribute("d", "M5 3l16 9-7 2-3 7z");
    arrow.setAttribute("fill", "#111");
    arrow.setAttribute("stroke", "#fff");
    arrow.setAttribute("stroke-width", "1.6");
    arrow.setAttribute("stroke-linejoin", "round");
    svg.appendChild(arrow);
    pointer.appendChild(svg);
    root.appendChild(pointer);
  }
  document.documentElement.appendChild(host);
  const state: OverlayState = { host, root, pointer, live: true, move: 0 };
  let i = 0;
  const tick = () => {
    if (!state.live) return;
    pixel.style.background = i++ % 2 ? "#000" : "#010101";
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  g.__agentBrowserRecord = state;
  return true;
}

/**
 * Draw one whole move from one call: each animation frame computes its own point (minimum jerk along
 * the path, as pointAt does in Node), so the drawing never waits for a CDP round trip.
 */
function overlayMove(legs: { points: { x: number; y: number }[]; ms: number }[]): void {
  const s = (globalThis as unknown as { __agentBrowserRecord?: OverlayState }).__agentBrowserRecord;
  const pointer = s?.pointer;
  if (!s || !pointer || !legs.length) return;
  const id = ++s.move;
  const prepared = legs.map((leg) => {
    const cum = [0];
    for (let i = 1; i < leg.points.length; i++) cum.push(cum[i - 1] + Math.hypot(leg.points[i].x - leg.points[i - 1].x, leg.points[i].y - leg.points[i - 1].y));
    return { ...leg, cum };
  });
  const place = (p: { x: number; y: number }) => { pointer.style.transform = `translate(${p.x - 5}px, ${p.y - 3}px)`; };
  const at = (elapsed: number) => {
    for (const leg of prepared) {
      if (elapsed > leg.ms) { elapsed -= leg.ms; continue; }
      const u = leg.ms > 0 ? elapsed / leg.ms : 1;
      const want = u * u * u * (10 - 15 * u + 6 * u * u) * leg.cum[leg.cum.length - 1];
      let i = 1;
      while (i < leg.cum.length - 1 && leg.cum[i] < want) i++;
      const seg = leg.cum[i] - leg.cum[i - 1], k = seg > 0 ? (want - leg.cum[i - 1]) / seg : 1;
      const a = leg.points[i - 1], b = leg.points[i];
      return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
    }
    const last = prepared[prepared.length - 1].points;
    return last[last.length - 1];
  };
  const total = prepared.reduce((sum, leg) => sum + leg.ms, 0);
  const start = performance.now();
  const frame = (now: number) => {
    if (s.move !== id) return; // a newer move took over
    const elapsed = Math.max(0, now - start);
    place(at(Math.min(elapsed, total)));
    if (elapsed < total) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

function overlayRipple(x: number, y: number): void {
  const s = (globalThis as unknown as { __agentBrowserRecord?: OverlayState }).__agentBrowserRecord;
  if (!s) return;
  const r = document.createElement("div");
  Object.assign(r.style, { position: "fixed", left: `${x - 18}px`, top: `${y - 18}px`, width: "36px", height: "36px", boxSizing: "border-box",
    borderRadius: "50%", border: "3px solid rgba(37,99,235,.9)", pointerEvents: "none", opacity: "0" });
  s.root.insertBefore(r, s.pointer);
  const a = r.animate([{ transform: "scale(.4)", opacity: 1 }, { transform: "scale(1.6)", opacity: 0 }], { duration: 450, easing: "ease-out" });
  a.onfinish = () => r.remove();
}

function overlayRing(box: { x: number; y: number; width: number; height: number }, ms: number): void {
  const s = (globalThis as unknown as { __agentBrowserRecord?: OverlayState }).__agentBrowserRecord;
  if (!s) return;
  const r = document.createElement("div");
  Object.assign(r.style, { position: "fixed", left: `${box.x - 8}px`, top: `${box.y - 8}px`, width: `${box.width + 16}px`, height: `${box.height + 16}px`,
    borderRadius: "10px", boxShadow: "0 0 0 4px rgba(37,99,235,.85), 0 0 0 9999px rgba(0,0,0,.25)", pointerEvents: "none", opacity: "0" });
  s.root.insertBefore(r, s.pointer);
  const a = r.animate([{ opacity: 0 }, { opacity: 1, offset: 0.15 }, { opacity: 1, offset: 0.85 }, { opacity: 0 }], { duration: ms, easing: "ease-in-out" });
  a.onfinish = () => r.remove();
}

function overlayRemove(): boolean {
  const g = globalThis as unknown as { __agentBrowserRecord?: OverlayState };
  const s = g.__agentBrowserRecord;
  if (!s) return false;
  s.live = false;
  s.host.remove();
  delete g.__agentBrowserRecord;
  return true;
}

/** The box of the first element that matches, scrolled into view; null if none. */
function elementBox(selector: string): { x: number; y: number; width: number; height: number } | null {
  const el = document.querySelector(selector);
  if (!el) return null;
  el.scrollIntoView({ block: "nearest", inline: "nearest" });
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}

/** waitFor: the element is there, has a box, and (with `text`) its text or value contains it. */
function elementReady(selector: string, text: string | null): boolean {
  const el = document.querySelector(selector) as HTMLElement | null;
  if (!el || !el.getClientRects().length) return false;
  if (text === null) return true;
  const value = (el as HTMLInputElement).value;
  return (typeof value === "string" ? value : el.innerText ?? el.textContent ?? "").includes(text);
}

// ---------- the recording ----------

export type RecordPlan = {
  out: string;
  provenance: string;
  script: string | null;
  steps: Step[];
  setupScript: string | null;
  setup: Step[];
  viewport: Viewport;
  fps: number;
  cursor: boolean;
  seed: number;
  settleMs: number;
  ffmpeg: string;
};

/** When a step ran, in seconds from the first frame of the MP4. */
export type RecordEvent = {
  step: number; kind: Action; start: number; end: number;
  /** click: the press. */ press?: number;
  /** press: each key. */ keys?: number[];
  /** type: the first and the last character. */ first?: number; last?: number;
};

export type RecordOutcome = {
  url: string;
  frames: number;
  seconds: number;
  maxFrameGapMs: number;
  videoWidth: number;
  videoHeight: number;
  events: RecordEvent[];
  warnings: string[];
};

/** The width and height of a baseline or progressive JPEG, from its frame header. */
export function jpegSize(buf: Buffer): [number, number] | undefined {
  for (let i = 2; i + 9 < buf.length;) {
    if (buf[i] !== 0xff) return undefined;
    const marker = buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return [buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5)];
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return undefined;
}

type Mark = { step: number; kind: Action; start: number; end: number; press?: number; keys?: number[]; first?: number; last?: number };

/** Drives the tab through the steps. The cursor's place is kept here, so the overlay survives a navigation. */
class Driver {
  readonly tab: Tab;
  readonly plan: RecordPlan;
  readonly random: () => number;
  x: number;
  y: number;
  failure?: unknown;
  /** Step times on this machine's clock (ms); converted to video time at the end. Set only while recording. */
  marks?: Mark[];
  private current?: Mark;
  private stop = new AbortController();
  private readonly mac = process.platform === "darwin";

  constructor(tab: Tab, plan: RecordPlan) {
    this.tab = tab;
    this.plan = plan;
    this.random = seededRandom(plan.seed);
    this.x = Math.round(plan.viewport.width * 0.6);
    this.y = Math.round(plan.viewport.height * 0.7);
  }

  /** Stop the run with this error (the first one wins); a pause in progress ends at once. */
  fail(e: unknown) {
    if (this.failure !== undefined) return;
    this.failure = e;
    this.stop.abort();
  }

  check() { if (this.failure !== undefined) throw this.failure; }

  async pause(ms: number) {
    if (ms > 0) await delay(ms, undefined, { signal: this.stop.signal }).catch(() => {});
    this.check();
  }

  private between(min: number, max: number) { return min + (max - min) * this.random(); }

  ensureOverlay() { return this.tab.evaluate(overlayEnsure, this.plan.cursor, this.x, this.y); }

  /** A point to aim at: inside the middle 40% of an element's box (not its exact centre), or the given point. */
  private async aim(t: StepTarget): Promise<{ point: Point; width: number }> {
    if (typeof t !== "string") return { point: t, width: 24 };
    const box = await this.tab.evaluate(elementBox, idx(t));
    if (!box) throw new Error(`no element matches ${t}`);
    if (!box.width || !box.height) throw new Error(`element ${t} is not visible`);
    return {
      point: { x: box.x + box.width * this.between(0.3, 0.7), y: box.y + box.height * this.between(0.3, 0.7) },
      width: Math.min(box.width, box.height),
    };
  }

  /** Move the visible cursor (drawn in the page, one call) and the real mouse (every ~16 ms, for hover) along the same path. */
  private async moveTo(to: Point, width: number, duration?: number) {
    const legs = await planMove({ x: this.x, y: this.y }, to, width, this.random, duration);
    if (!legs.length) return;
    if (this.plan.cursor) await this.tab.evaluate(overlayMove, legs);
    const total = legs.reduce((a, l) => a + l.ms, 0), start = Date.now();
    for (let elapsed = 0; elapsed < total; elapsed = Date.now() - start) {
      const p = pointAt(legs, elapsed);
      await this.tab.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y });
      await this.pause(16 - ((Date.now() - start) % 16));
    }
    await this.tab.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: to.x, y: to.y });
    this.x = to.x;
    this.y = to.y;
  }

  private async key(k: KeyEvent) {
    const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode, modifiers: k.modifiers };
    const commands = this.mac ? macCommands(k) : [];
    await this.tab.send("Input.dispatchKeyEvent", { type: k.text ? "keyDown" : "rawKeyDown", ...base, ...(k.text ? { text: k.text, unmodifiedText: k.text } : {}), ...(commands.length ? { commands } : {}) });
    await this.tab.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }

  /** One character as real key events (a canvas app such as Sheets reads those), else as inserted text. */
  private async typeChar(ch: string) {
    if (ch === "\n") return this.key(parseKey("Enter"));
    if (ch === "\t") return this.key(parseKey("Tab"));
    const k = charKey(ch);
    if (k) return this.key(k);
    await this.tab.send("Input.insertText", { text: ch });
  }

  /** Run one step; while recording, note when it started and ended (and its clicks, keys and characters). */
  async step(n: number, step: Step): Promise<void> {
    const kind = ACTIONS.find((a) => a in step)!;
    this.current = this.marks ? { step: n, kind, start: Date.now(), end: 0 } : undefined;
    try { await this.run(step); } finally {
      if (this.current && this.marks) { this.current.end = Date.now(); this.marks.push(this.current); }
      this.current = undefined;
    }
  }

  private note(what: "press" | "key" | "char") {
    const m = this.current, now = Date.now();
    if (!m) return;
    if (what === "press") m.press = now;
    else if (what === "key") (m.keys ??= []).push(now);
    else { m.first ??= now; m.last = now; }
  }

  private async run(step: Step): Promise<void> {
    this.check();
    await this.tab.assertAllowed();
    await this.ensureOverlay();
    if ("wait" in step) return this.pause(step.wait);
    if ("goto" in step) {
      await this.tab.goto(step.goto);
      this.check();
      await this.tab.assertAllowed();
      await this.ensureOverlay();
      return this.pause(300);
    }
    if ("click" in step || "hover" in step) {
      const { point, width } = await this.aim("click" in step ? step.click : step.hover);
      await this.moveTo(point, width, step.duration);
      if (!("click" in step)) return;
      await this.pause(this.between(80, 150)); // a person settles on the target before pressing
      this.note("press");
      if (this.plan.cursor) await this.tab.evaluate(overlayRipple, point.x, point.y);
      await this.tab.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
      await this.pause(this.between(60, 90));
      await this.tab.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
      return this.pause(200);
    }
    if ("type" in step) {
      if (step.into !== undefined) {
        const { point, width } = await this.aim(step.into);
        await this.moveTo(point, width);
        await this.pause(this.between(80, 150));
        if (this.plan.cursor) await this.tab.evaluate(overlayRipple, point.x, point.y);
        await this.tab.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
        await this.pause(this.between(60, 90));
        await this.tab.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
        await this.pause(250);
      }
      const each = step.delay ?? 55;
      for (const ch of step.type) {
        this.check();
        this.note("char");
        await this.typeChar(ch);
        await this.pause(each * this.between(0.6, 1.4));
      }
      return;
    }
    if ("press" in step) {
      const k = parseKey(step.press);
      for (let i = 0; i < (step.repeat ?? 1); i++) {
        this.note("key");
        await this.key(k);
        await this.pause(step.delay ?? 150);
      }
      return;
    }
    if ("scroll" in step) {
      const ms = step.duration ?? 900;
      if (typeof step.scroll === "string") {
        const found = await this.tab.evaluate((s: string) => {
          const el = document.querySelector(s);
          el?.scrollIntoView({ behavior: "smooth", block: "center" });
          return !!el;
        }, idx(step.scroll));
        if (!found) throw new Error(`no element matches ${step.scroll}`);
        return this.pause(ms);
      }
      // A wheel at the cursor scrolls what is under it, as a mouse does: the window, or an inner pane such as the Sheets grid.
      const n = Math.max(1, Math.round(ms / 16)), start = Date.now();
      for (let i = 1; i <= n; i++) {
        const deltaY = step.scroll * (minJerk(i / n) - minJerk((i - 1) / n));
        await this.tab.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: this.x, y: this.y, deltaX: 0, deltaY });
        await this.pause(start + (ms * i) / n - Date.now());
      }
      return;
    }
    if ("highlight" in step) {
      const ms = step.duration ?? 1600;
      const box = typeof step.highlight === "string" ? await this.tab.evaluate(elementBox, idx(step.highlight)) : step.highlight;
      if (!box) throw new Error(`no element matches ${step.highlight}`);
      await this.tab.evaluate(overlayRing, box, ms);
      return this.pause(ms);
    }
    if ("waitFor" in step) {
      const deadline = Date.now() + (step.timeoutMs ?? 30_000);
      while (!(await this.tab.evaluate(elementReady, idx(step.waitFor), step.text ?? null))) {
        if (Date.now() > deadline) throw new Error(`waitFor: ${step.waitFor}${step.text !== undefined ? " with that text" : ""} is not there after ${step.timeoutMs ?? 30_000} ms`);
        await this.pause(100);
      }
      return;
    }
    if ("eval" in step) { await this.tab.evaluate(step.eval); return; }
    throw new UsageError(`unknown step ${JSON.stringify(step)}`);
  }
}

/** A step's own error, named by its number (a refusal or a stop keeps its own error). */
function stepError(what: string, n: number, step: Step, e: unknown): unknown {
  if (e instanceof AgentBrowserError) return e;
  return new AgentBrowserError("error", `${what} ${n} (${JSON.stringify(step).slice(0, 120)}): ${(e as Error).message}`, { cause: e });
}

/**
 * Record the tab while the plan's steps drive it, and write the MP4 and its provenance JSON. The tab is
 * changed only for the run. Every cleanup step runs; a cleanup failure never replaces the run's own
 * error (it is added to its message), and after a good run it is a warning in the result.
 */
export async function recordTab(tab: Tab, plan: RecordPlan): Promise<RecordOutcome> {
  const s = tab.browser.settings;
  await tab.assertAllowed();
  const recordings = statePath(s, "recordings");
  mkdirSync(recordings, { recursive: true, mode: 0o700 });
  const framesDir = mkdtempSync(join(recordings, "frames-"));
  let outcome: RecordOutcome | undefined, failure: unknown;
  try {
    outcome = await runAndEncode(tab, plan, framesDir);
  } catch (e) { failure = e; }
  // The frames can show a signed-in page: they never outlive the run.
  const removed = await runCleanup([["remove the frames", async () => rmSync(framesDir, { recursive: true, force: true })]]);
  if (failure !== undefined) throw withCleanupErrors(failure, removed);
  for (const r of removed) s.log(`agent-browser record: cleanup failed: ${r}`);
  outcome!.warnings.push(...removed.map((r) => `cleanup failed: ${r}`));
  return outcome!;
}

async function runAndEncode(tab: Tab, plan: RecordPlan, framesDir: string): Promise<RecordOutcome> {
  const s = tab.browser.settings, conn = tab.browser.conn;
  const { width, height, scale } = plan.viewport;
  const videoWidth = Math.round(width * scale), videoHeight = Math.round(height * scale);
  const url = await tab.url();
  const driver = new Driver(tab, plan);
  const frames: { file: string; t: number }[] = [];
  let otherSize: [number, number] | undefined, otherSizes = 0, droppedSize: [number, number] | undefined, dropped = 0;
  // Chrome stamps each frame on its own clock; offset = (when we got it) - (its stamp), the least seen,
  // maps our clock (step times) onto the frames' (video time).
  let offset = Infinity;
  let writing = true;
  const offFrame = conn.on("Page.screencastFrame", (p: any, sid?: string) => {
    if (sid !== tab.sessionId) return;
    if (writing && driver.failure === undefined) {
      try {
        const jpeg = Buffer.from(p.data, "base64");
        const size = jpegSize(jpeg);
        const exact = !size || (size[0] === videoWidth && size[1] === videoHeight);
        // Chrome can send one frame of the window's own size before the emulated size takes effect: drop it.
        if (exact || frames.length) {
          if (!exact) { otherSize = size; otherSizes++; }
          const file = `${String(frames.length).padStart(6, "0")}.jpg`;
          writeFileSync(join(framesDir, file), jpeg);
          frames.push({ file, t: p.metadata.timestamp });
          offset = Math.min(offset, Date.now() / 1000 - p.metadata.timestamp);
        } else { dropped++; droppedSize = size; }
      } catch (e) { driver.fail(new Error(`could not write a frame: ${(e as Error).message}`)); }
    }
    void tab.send("Page.screencastFrameAck", { sessionId: p.sessionId }).catch(() => {});
  });
  // A main-frame navigation off the allowlist ends the run at once; no frame after it is kept.
  const offNav = conn.on("Page.frameNavigated", (p: any, sid?: string) => {
    if (sid !== tab.sessionId || p.frame?.parentId || isAllowedUrl(p.frame?.url ?? "", tab.browser.allow)) return;
    driver.fail(new NotAllowedError(p.frame?.url ?? "", `refusing: the tab navigated to ${safeHost(p.frame?.url ?? "")}, which is not on the allowlist; the recording stopped and nothing was written`));
  });
  const offDetach = conn.on("Target.detachedFromTarget", (p: any) => {
    if (p.sessionId === tab.sessionId) driver.fail(new AgentBrowserError("error", "the tab was closed or detached during the recording; nothing was written"));
  });
  const limit = setTimeout(() => driver.fail(new AgentBrowserError("error", `a recording is at most ${MAX_RECORD_SECONDS} s; nothing was written`)), MAX_RECORD_SECONDS * 1000);
  let emulated = false, casting = false;
  let startedAt = "", endedAt = "", tEnd = 0, runError: unknown;
  const marks: Mark[] = [];
  try {
    // In the agent browser the tab comes to the front of its window (a background tab paints at
    // half rate). In personal mode it is not raised over the operator's own work.
    if (s.mode === "agent") await tab.send("Page.bringToFront");
    await tab.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile: false });
    emulated = true;
    await driver.ensureOverlay();
    await tab.evaluate(() => (document as Document & { fonts?: FontFaceSet }).fonts?.ready.then(() => true) ?? true).catch(() => true);
    await driver.pause(400); // the page lays itself out again at the new size
    // Setup steps run off camera, at the recorded size, so the recording starts on a settled page.
    for (const [i, step] of plan.setup.entries()) {
      try { await driver.step(i + 1, step); } catch (e) { throw driver.failure ?? stepError("setup step", i + 1, step, e); }
    }
    if (plan.setup.length) await driver.pause(300);
    await tab.send("Page.startScreencast", { format: "jpeg", quality: 90, maxWidth: videoWidth, maxHeight: videoHeight, everyNthFrame: 1 });
    casting = true;
    startedAt = new Date().toISOString();
    s.log(`agent-browser record: ${width}x${height} at scale ${scale}, ${plan.steps.length} steps`);
    // The video starts at the first frame, so the still pre-roll (--settle) is counted from there.
    for (const deadline = Date.now() + 10_000; !frames.length; await driver.pause(10))
      if (Date.now() > deadline) throw new AgentBrowserError("error", `Chrome sent no screencast frame of ${videoWidth}x${videoHeight} in 10 s: is the agent browser window open, and the tab still there?`);
    driver.marks = marks;
    await tab.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: driver.x, y: driver.y });
    await driver.pause(plan.settleMs);
    for (const [i, step] of plan.steps.entries()) {
      try { await driver.step(i + 1, step); } catch (e) { throw driver.failure ?? stepError("step", i + 1, step, e); }
    }
    await driver.pause(plan.settleMs);
    await tab.assertAllowed();
    driver.check();
    tEnd = Date.now() / 1000;
    endedAt = new Date().toISOString();
  } catch (e) { runError = driver.failure ?? e; }
  writing = false;
  const offList = runError instanceof NotAllowedError;
  const cleanupErrors = await runCleanup([
    ["stop the screencast", casting && (() => tab.send("Page.stopScreencast"))],
    // Never run code in a page off the allowlist: its document is new, so no overlay is left in it anyway.
    ["remove the overlay", !offList && (() => tab.evaluate(overlayRemove))],
    ["clear the device metrics override", emulated && (() => tab.send("Emulation.clearDeviceMetricsOverride"))],
  ]);
  offFrame();
  offNav();
  offDetach();
  clearTimeout(limit);
  if (runError !== undefined) throw withCleanupErrors(runError, cleanupErrors);
  for (const c of cleanupErrors) s.log(`agent-browser record: cleanup failed: ${c}`);
  const warnings = cleanupErrors.map((c) => `cleanup failed: ${c}`);

  if (frames.length < 2) {
    if (dropped) throw new AgentBrowserError("error", `Chrome sent ${dropped} frame(s) of ${droppedSize?.join("x")}, never ${videoWidth}x${videoHeight}: the emulated size did not take effect`);
    throw new AgentBrowserError("error", `Chrome sent ${frames.length} screencast frame(s); the tab did not paint. Is the agent browser window open (not closed) and the tab still there?`);
  }
  if (otherSize) warnings.push(`Chrome sent ${otherSizes} frame(s) of ${otherSize[0]}x${otherSize[1]}, not ${videoWidth}x${videoHeight}; they were scaled to fit, with bars`);
  const t0 = frames[0].t;
  const end = Math.max(tEnd - offset, frames[frames.length - 1].t);
  const times = [...frames.map((f) => f.t), end];
  let maxGap = 0, gapAt = 0;
  for (let i = 1; i < times.length; i++) if (times[i] - times[i - 1] > maxGap) { maxGap = times[i] - times[i - 1]; gapAt = times[i - 1] - t0; }
  if (maxGap > 1.5) warnings.push(`the video holds one picture for ${maxGap.toFixed(1)} s from ${gapAt.toFixed(1)} s: Chrome sent no frame then (a page load, or a window that did not paint)`);
  const seconds = end - t0;
  const video = (ms: number) => +Math.max(0, ms / 1000 - offset - t0).toFixed(3);
  const events: RecordEvent[] = marks.map((m) => ({
    step: m.step, kind: m.kind, start: video(m.start), end: video(m.end),
    ...(m.press !== undefined ? { press: video(m.press) } : {}),
    ...(m.keys ? { keys: m.keys.map(video) } : {}),
    ...(m.first !== undefined ? { first: video(m.first), last: video(m.last!) } : {}),
  }));

  s.log(`agent-browser record: encoding ${frames.length} frames (${seconds.toFixed(1)} s) to ${plan.out}`);
  await encode(plan.ffmpeg, framesDir, frames, end, plan.fps, videoWidth, videoHeight, plan.out);
  const final = await tab.evaluate(() => ({ url: location.href, title: document.title }));
  const createdAt = new Date().toISOString();
  const provenance = {
    service: "agent-browser", generator: "agent-browser record", version: packageVersion(), url, finalUrl: final.url, title: final.title,
    script: plan.script, steps: plan.steps, setupScript: plan.setupScript, setup: plan.setup,
    width, height, scale, fps: plan.fps, video: { path: plan.out, width: videoWidth, height: videoHeight, codec: "h264" },
    cursor: plan.cursor, seed: plan.seed, settleMs: plan.settleMs, createdAt, startedAt, endedAt, seconds: +seconds.toFixed(3), frames: frames.length,
    maxFrameGapMs: Math.round(maxGap * 1000), events, mode: s.mode, chrome: tab.browser.product, warnings,
  };
  writeAtomically(plan.provenance, JSON.stringify(provenance, null, 2) + "\n");
  return { url, frames: frames.length, seconds: +seconds.toFixed(3), maxFrameGapMs: Math.round(maxGap * 1000), videoWidth, videoHeight, events, warnings };
}

function writeAtomically(path: string, text: string) {
  const part = `${path}.part`;
  writeFileSync(part, text);
  renameSync(part, path);
}

let version: string | undefined;
function packageVersion(): string {
  version ??= JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string;
  return version;
}

/**
 * The frames arrive whenever the page repaints, each with its time. For each tick of the constant-rate
 * MP4 (k / fps after the first frame) the frame nearest that moment is piped to ffmpeg, which
 * encodes H.264 (CRF 16, yuv420p, limited range, +faststart) at exactly w x h. (ffmpeg's concat
 * demuxer, which vedlo capture uses, puts each JPEG on a 1/25 s grid, so frames shifted by up to 40 ms
 * and collided; measured with ffprobe on ffmpeg 9.)
 */
async function encode(ffmpeg: string, dir: string, frames: { file: string; t: number }[], end: number, fps: number, w: number, h: number, out: string) {
  mkdirSync(dirname(out), { recursive: true });
  const part = `${out}.part`;
  const ticks = Math.max(1, Math.round((end - frames[0].t) * fps));
  const vf = `scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=lanczos:out_range=tv,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p`;
  try {
    const ff = spawn(ffmpeg, ["-hide_banner", "-v", "error", "-y", "-f", "image2pipe", "-framerate", String(fps), "-c:v", "mjpeg", "-i", "-", "-vf", vf,
      "-c:v", "libx264", "-preset", "medium", "-crf", "16", "-color_range", "tv", "-an", "-movflags", "+faststart", "-f", "mp4", part], { stdio: ["pipe", "ignore", "pipe"] });
    let err = "";
    ff.stderr.on("data", (d) => { err = (err + d).slice(-2000); });
    const exited = new Promise<void>((resolveRun, reject) => {
      ff.once("error", (e) => reject(new AgentBrowserError("error", `could not run ffmpeg: ${e.message}`)));
      ff.once("exit", (code, signal) => (code === 0 ? resolveRun() : reject(new AgentBrowserError("error", `ffmpeg failed (${signal ?? `exit ${code}`}): ${err.trim().slice(-600)}`))));
    });
    exited.catch(() => {}); // awaited below; an early exit must not go unhandled while frames are still being written
    let broken = false;
    ff.stdin.on("error", () => { broken = true; }); // ffmpeg stopped reading: its exit status says why
    let shown = -1, jpeg: Buffer = Buffer.alloc(0);
    for (let k = 0, j = 0; k < ticks && !broken; k++) {
      // The frame nearest the tick: Chrome paints near 60 Hz with a few ms of jitter, so "the last frame
      // before the tick" would repeat one frame and skip the next whenever a frame came a little late.
      const at = frames[0].t + (k + 0.5) / fps;
      while (j + 1 < frames.length && frames[j + 1].t <= at) j++;
      if (j !== shown) { jpeg = readFileSync(join(dir, frames[j].file)); shown = j; }
      if (!ff.stdin.write(jpeg)) await new Promise<void>((r) => { ff.stdin.once("drain", r); ff.once("exit", () => r()); });
    }
    ff.stdin.end();
    await exited;
    renameSync(part, out);
  } finally {
    if (existsSync(part)) rmSync(part, { force: true });
  }
}

/**
 * The plan for `record`, checked before any connection: the output and provenance paths, the step
 * and setup scripts, the size, the frame rate and ffmpeg. The provenance JSON goes beside the MP4
 * (clip.mp4 -> clip.json) and never over a script.
 */
export function planRecording(p: { out: string; script?: string; setup?: string; size?: string; fps?: number; scale?: number; noCursor?: boolean;
  settle?: number; seed?: number; ffmpeg?: string }, allow: readonly string[]): RecordPlan {
  if (typeof p.out !== "string" || !p.out) throw new UsageError("--out is required: the MP4 to write");
  const out = resolve(p.out);
  if (!/\.mp4$/i.test(out)) throw new UsageError(`--out must end in .mp4: ${p.out}`);
  const provenance = out.replace(/\.mp4$/i, ".json");
  const size = parseSize(p.size ?? "1920x1080");
  const scale = checkScale(p.scale ?? 1);
  const viewport = { ...size, scale };
  if (!Number.isInteger(size.width * scale) || !Number.isInteger(size.height * scale) || (size.width * scale) % 2 || (size.height * scale) % 2)
    throw new UsageError(`the video is ${size.width * scale}x${size.height * scale} pixels; H.264 needs even whole numbers: change --size or --scale`);
  const fps = p.fps ?? 30;
  if (!Number.isInteger(fps) || fps < 1 || fps > 60) throw new UsageError("--fps is a whole number from 1 to 60");
  const settleMs = p.settle ?? 600;
  if (!finite(settleMs) || settleMs < 0 || settleMs > 60_000) throw new UsageError("--settle is a number of ms from 0 to 60000");
  const seed = p.seed ?? 1;
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new UsageError("--seed is a whole number from 0 to 4294967295");
  const same = (a: string, b: string) => a === b || (existsSync(a) && existsSync(b) && realpathSync(a) === realpathSync(b));
  const read = (file: string | undefined, what: string): { path: string | null; steps: Step[] } => {
    if (file === undefined) return { path: null, steps: [] };
    const path = resolve(file);
    if (same(path, provenance) || same(path, out))
      throw new UsageError(`the provenance JSON (${provenance}) and the MP4 go beside each other and must not replace the ${what} script; name the output differently`);
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(path, "utf8")); } catch (e) { throw new UsageError(`cannot read the ${what} script ${path}: ${(e as Error).message}`); }
    return { path, steps: parseSteps(raw, viewport, allow, what === "setup" ? "setup step" : "step") };
  };
  const script = read(p.script, "step"), setup = read(p.setup, "setup");
  return { out, provenance, script: script.path, steps: script.steps, setupScript: setup.path, setup: setup.steps, viewport, fps, cursor: !p.noCursor,
    seed, settleMs, ffmpeg: findFfmpeg(p.ffmpeg) };
}
