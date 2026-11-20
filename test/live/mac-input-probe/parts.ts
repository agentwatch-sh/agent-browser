// The pure parts of the Mac input probe (probe.ts; board ab-t30.32, part 1): the arguments, the --out check, the points
// of the probe's moves, the recorder page's scripts, the summary statistics, the result's JSON and its check of numbers
// only. No CDP, no browser and no file access but through the reads that a caller gives, so that
// test/mac-input-probe.test.ts runs them in `npm test`.
//
// The result holds numbers only: the probe's version and commit, the platform, the Chrome version, the page's size and,
// for each question, its values and summaries. It holds no page text, no URL, no cookie, no token and no path of the box:
// checkResult refuses every other string, and clean() takes URLs, paths and long ids out of a failure's text.

import { basename, dirname, join, resolve } from "node:path";
import { parseArgs as nodeParseArgs } from "node:util";
import { CDP_URL_RE } from "../../../src/options.ts";

/** The probe's version: a change of the result's fields or of the probe's moves gives a new one. */
export const PROBE_VERSION = 1;
/** The time limit of the whole run (the brief: 60 s). */
export const TIME_LIMIT_MS = 60_000;
/** The part of the limit that the probe keeps for its stop: the close of its tab. */
export const CLOSE_RESERVE_MS = 8_000;
/** The longest wait for one CDP answer, and for the endpoint's connection (a stopped agent Chrome starts at a use). */
export const CALL_MAX_MS = 15_000;
export const CONNECT_MAX_MS = 30_000;
/** The wait after each part, for the page's last events (a pointermove goes at the page's next frame). */
export const SETTLE_MS = 400;

export type Pt = { x: number; y: number };
/** Q1's point (the brief's example): a fraction on both axes, far from a whole px and from 0.5. */
export const Q1_POINT: Pt = { x: 300.37, y: 200.61 };
/** Q3's path: about 600 px, at least 300 px, and its end at least EDGE_PX inside the viewport. */
export const PATH_PX = 600;
export const PATH_MIN_PX = 300;
export const EDGE_PX = 8;
/** Q2's wheel calls: a small deltaY (a trackpad's median step, 13 px) and one notch (120 px). */
export const WHEEL_DELTAS: readonly number[] = [13, 120];
/** The page's point is the asked point within this much (a float32 of the page keeps about 1e-5 px at 300). */
export const REACH_PX = 0.01;
/** A value has a fraction when it is more than this far from a whole number. */
export const FRACTION_EPS = 0.001;
/** At most this many raw values of one list go into the result. */
export const LIST_MAX = 400;
/** The result's largest size, as JSON. */
export const RESULT_MAX_BYTES = 128 * 1024;

// ------------------------------------------------------------------ the arguments

export type Args = { cdpUrl: string; out: string | null; seed: number | null };
export const USAGE = "usage: node test/live/mac-input-probe/probe.ts --cdp-url URL [--out FILE] [--seed N]";

/** The probe's arguments, or the refusal (the probe writes USAGE on stderr with it). No refusal text holds the URL or a path. */
export function parseArgs(argv: readonly string[]): Args | { error: string } {
  let v: { "cdp-url"?: string; out?: string; seed?: string };
  try {
    v = nodeParseArgs({ args: [...argv], options: { "cdp-url": { type: "string" }, out: { type: "string" }, seed: { type: "string" } }, strict: true, allowPositionals: false }).values;
  } catch (e) {
    return { error: clean((e as Error).message) || "the arguments do not parse" };
  }
  const url = v["cdp-url"];
  if (url === undefined) return { error: "--cdp-url is required: agent mode's endpoint, as `agentwatch browser endpoint` prints it" };
  if (!CDP_URL_RE.test(url)) return { error: "--cdp-url must be agent mode's endpoint (the ws+unix form), as `agentwatch browser endpoint` prints it" };
  if (v.out !== undefined && !v.out.trim()) return { error: "--out needs a file name" };
  let seed: number | null = null;
  if (v.seed !== undefined) {
    if (!/^[0-9]{1,10}$/.test(v.seed) || Number(v.seed) > 0xffffffff) return { error: "--seed is a whole number from 0 to 4294967295" };
    seed = Number(v.seed);
  }
  return { cdpUrl: url, out: v.out ?? null, seed };
}

/** What outPath reads: the real path of a folder (null when it is not a folder), and whether a path exists. */
export type PathFs = { realDir(path: string): string | null; exists(path: string): boolean };

/**
 * The file of --out: a new file in a folder that exists, outside any git checkout (no folder from the file's real folder
 * up to the root holds a `.git`). Else the refusal. No refusal text holds the path.
 */
export function outPath(file: string, cwd: string, fs: PathFs): { path: string } | { error: string } {
  const abs = resolve(cwd, file), name = basename(abs);
  if (!name || name === "." || name === ".." || file.endsWith("/")) return { error: "--out names a folder, not a file" };
  const dir = fs.realDir(dirname(abs));
  if (dir === null) return { error: "the folder of --out does not exist" };
  const path = join(dir, name);
  if (fs.exists(path)) return { error: "--out names a file that exists: the probe writes a new file only" };
  for (let d = dir; ; d = dirname(d)) {
    if (fs.exists(join(d, ".git"))) return { error: "--out names a file inside a git checkout: write it outside every checkout" };
    if (dirname(d) === d) break;
  }
  return { path };
}

// ------------------------------------------------------------------ the points

/** A small seeded generator (mulberry32): one seed gives the same points each time. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Two decimals, as a client writes a point. */
const r2 = (n: number) => Math.round(n * 100) / 100;
const rn = (n: number, d: number) => { const k = 10 ** d; return Math.round(n * k) / k; };

/** A fraction from 0.05 to 0.95 in steps of 0.01, but not 0.50 (a tie of the rounding). */
function fraction(rnd: () => number): number {
  for (;;) { const f = 5 + Math.floor(rnd() * 91); if (f !== 50) return f / 100; }
}

/** Q1's point: Q1_POINT, or with a seed 300 and 200 with the seed's fractions. */
export function q1Point(seed: number | null): Pt {
  if (seed === null) return { ...Q1_POINT };
  const rnd = seeded(seed);
  return { x: r2(300 + fraction(rnd)), y: r2(200 + fraction(rnd)) };
}

/** The point is in the viewport, at least EDGE_PX from each edge. */
export const inside = (p: Pt, view: { width: number; height: number }) =>
  p.x >= EDGE_PX && p.y >= EDGE_PX && p.x <= view.width - EDGE_PX && p.y <= view.height - EDGE_PX;

const DIRECTIONS: readonly Pt[] = [{ x: 0.8, y: 0.6 }, { x: 0.8, y: -0.6 }, { x: -0.8, y: 0.6 }, { x: -0.8, y: -0.6 }, { x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];

/**
 * Q3's end: PATH_PX from `from` in the first direction that has the room in the viewport (down and to the right first;
 * a seed changes the order), else the direction with the most room (a whole px less than it). Null when no direction has
 * PATH_MIN_PX. The end keeps two decimals, so it has a fraction when `from` has one.
 */
export function pathEnd(from: Pt, view: { width: number; height: number }, seed: number | null): { to: Pt; lengthPx: number } | null {
  const dirs = [...DIRECTIONS];
  if (seed !== null) {
    const rnd = seeded(seed ^ 0x5bd1e995);
    for (let i = dirs.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [dirs[i], dirs[j]] = [dirs[j], dirs[i]]; }
  }
  const room = (p: number, d: number, size: number) => (d > 0 ? (size - EDGE_PX - p) / d : d < 0 ? (p - EDGE_PX) / -d : Infinity);
  let best: { d: Pt; len: number } | null = null;
  for (const d of dirs) {
    const len = Math.min(PATH_PX, room(from.x, d.x, view.width), room(from.y, d.y, view.height));
    if (!best || len > best.len) best = { d, len };
    if (len >= PATH_PX) break;
  }
  if (!best || best.len < PATH_MIN_PX) return null;
  const len = best.len >= PATH_PX ? PATH_PX : Math.floor(best.len) - 1;
  const to = { x: r2(from.x + best.d.x * len), y: r2(from.y + best.d.y * len) };
  return { to, lengthPx: r2(Math.hypot(to.x - from.x, to.y - from.y)) };
}

// ------------------------------------------------------------------ the page's scripts (Runtime.evaluate on the probe's own tab)

/**
 * The recorder: a pad over the page, four viewports tall (so that the wheel can scroll the page), and passive listeners of
 * pointermove, mousemove and wheel on the window (passive: the stage's wheel column sees no listener that holds the
 * wheel). Each record holds the part's name and numbers only. During Q3 it also records the page's frames
 * (requestAnimationFrame's times), for a page that hides getCoalescedEvents (q3Of). It returns true, or false when the
 * page has it already.
 */
export const RECORDER = `(() => {
  if (Object.prototype.hasOwnProperty.call(window, "__macInputProbe")) return false;
  const R = { phase: "", moves: [], mice: [], wheels: [], frames: [] };
  document.documentElement.style.cssText = "margin:0;padding:0";
  document.body.style.cssText = "margin:0;padding:0";
  const pad = document.createElement("div");
  pad.style.cssText = "position:absolute;left:0;top:0;width:100%;height:400vh;margin:0;padding:0;border:0";
  document.body.appendChild(pad);
  const n = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const pt = (e) => ({ t: n(e.timeStamp), x: n(e.clientX), y: n(e.clientY), ox: n(e.offsetX), oy: n(e.offsetY) });
  const o = { capture: true, passive: true };
  addEventListener("pointermove", (e) => {
    const c = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [];
    const p = typeof e.getPredictedEvents === "function" ? e.getPredictedEvents() : [];
    R.moves.push({ p: R.phase, ...pt(e), tr: e.isTrusted === true, mouse: e.pointerType === "mouse", api: typeof e.getCoalescedEvents === "function", c: c.map(pt), pr: p.length });
  }, o);
  addEventListener("mousemove", (e) => { R.mice.push({ p: R.phase, ...pt(e), tr: e.isTrusted === true }); }, o);
  addEventListener("wheel", (e) => {
    R.wheels.push({ p: R.phase, t: n(e.timeStamp), dx: n(e.deltaX), dy: n(e.deltaY), mode: n(e.deltaMode), wdx: n(e.wheelDeltaX), wdy: n(e.wheelDeltaY), tr: e.isTrusted === true });
  }, o);
  R.set = (name) => {
    R.phase = name;
    if (name !== "q3") return;
    const f = (t) => { if (R.phase !== "q3") return; if (n(t) !== null) R.frames.push(t); requestAnimationFrame(f); };
    requestAnimationFrame(f);
  };
  Object.defineProperty(window, "__macInputProbe", { value: R });
  return true;
})()`;

/** The page's size and state: numbers and flags only. */
export const PAGE_INFO = `(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio, visible: document.visibilityState === "visible", focused: document.hasFocus(), secure: isSecureContext === true }))()`;

/** Two frames of the page within 2 s (awaitPromise): true, else false (a page that does not draw delays each move). */
export const FRAMES = `new Promise((r) => { const t = setTimeout(() => r(false), 2000); requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(t); r(true); })); })`;

/** The parts' names in the records: q1, q3 and q2-<i> (WHEEL_DELTAS[i]). */
export const PHASE_RE = /^(|q1|q3|q2-[0-9])$/;
export function phase(name: string): string {
  if (!PHASE_RE.test(name) || !name) throw new Error(`not a part's name: ${name}`);
  return `(() => { window.__macInputProbe.set(${JSON.stringify(name)}); return true; })()`;
}

/** The records, the frames of Q3 and the page's scroll. */
export const READ = `(() => { const R = window.__macInputProbe; return { moves: R.moves, mice: R.mice, wheels: R.wheels, frames: R.frames, scrollY: scrollY }; })()`;

// ------------------------------------------------------------------ the records

export type Point = { t: number | null; x: number | null; y: number | null; ox: number | null; oy: number | null };
export type Move = Point & { p: string; tr: boolean; mouse: boolean; api: boolean; c: Point[]; pr: number };
export type Mouse = Point & { p: string; tr: boolean };
export type Wheel = { p: string; t: number | null; dx: number | null; dy: number | null; mode: number | null; wdx: number | null; wdy: number | null; tr: boolean };
export type Records = { moves: Move[]; mice: Mouse[]; wheels: Wheel[]; frames: number[]; scrollY: number | null };

const num = (v: unknown): v is number | null => v === null || (typeof v === "number" && Number.isFinite(v));
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const point = (v: unknown): v is Point & Record<string, unknown> => obj(v) && num(v.t) && num(v.x) && num(v.y) && num(v.ox) && num(v.oy);
const part = (v: unknown) => typeof v === "string" && PHASE_RE.test(v);
const pick = <T extends string>(v: Record<string, unknown>, keys: readonly T[]) => Object.fromEntries(keys.map((k) => [k, v[k]])) as Record<T, any>;
const POINT_KEYS = ["t", "x", "y", "ox", "oy"] as const;

/** The page's records in their shape (numbers, flags and the parts' names only), or null: the probe fails closed. */
export function readRecords(v: unknown): Records | null {
  if (!obj(v) || !Array.isArray(v.moves) || !Array.isArray(v.mice) || !Array.isArray(v.wheels) || !num(v.scrollY)) return null;
  if (!Array.isArray(v.frames) || !v.frames.every((t) => typeof t === "number" && Number.isFinite(t))) return null;
  const moves: Move[] = [], mice: Mouse[] = [], wheels: Wheel[] = [];
  for (const m of v.moves) {
    if (!point(m) || !part(m.p) || typeof m.tr !== "boolean" || typeof m.mouse !== "boolean" || typeof m.api !== "boolean" || !Array.isArray(m.c) || !m.c.every(point) || !Number.isInteger(m.pr)) return null;
    moves.push({ ...pick(m, POINT_KEYS), p: m.p as string, tr: m.tr, mouse: m.mouse, api: m.api, c: (m.c as Point[]).map((c) => pick(c, POINT_KEYS)), pr: m.pr as number });
  }
  for (const m of v.mice) {
    if (!point(m) || !part(m.p) || typeof m.tr !== "boolean") return null;
    mice.push({ ...pick(m, POINT_KEYS), p: m.p as string, tr: m.tr });
  }
  for (const w of v.wheels) {
    if (!obj(w) || !part(w.p) || ![w.t, w.dx, w.dy, w.mode, w.wdx, w.wdy].every(num) || typeof w.tr !== "boolean") return null;
    wheels.push(pick(w, ["p", "t", "dx", "dy", "mode", "wdx", "wdy", "tr"] as const));
  }
  return { moves, mice, wheels, frames: [...v.frames] as number[], scrollY: v.scrollY };
}

// ------------------------------------------------------------------ the statistics

/** The q-quantile by linear interpolation between the closest ranks (R's type 7, numpy's default); null with no value. */
export function quantile(values: readonly number[], q: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b), h = (s.length - 1) * q, lo = Math.floor(h);
  return lo + 1 < s.length ? s[lo] + (h - lo) * (s[lo + 1] - s[lo]) : s[lo];
}

export type Summary = { count: number; median: number | null; p10: number | null; p90: number | null; min: number | null; max: number | null };

/** count, median, p10, p90, min and max, to 3 decimals. */
export function summarize(values: readonly number[]): Summary {
  const r = (v: number | null) => (v === null ? null : rn(v, 3));
  return {
    count: values.length, median: r(quantile(values, 0.5)), p10: r(quantile(values, 0.1)), p90: r(quantile(values, 0.9)),
    min: r(values.length ? Math.min(...values) : null), max: r(values.length ? Math.max(...values) : null),
  };
}

/** The differences of consecutive values. */
export const gaps = (times: readonly number[]) => times.slice(1).map((t, i) => t - times[i]);
/** The value has a fraction (more than FRACTION_EPS from a whole number). */
export const hasFraction = (v: number | null) => v !== null && Math.abs(v - Math.round(v)) > FRACTION_EPS;
/** The gap is a whole ms (within FRACTION_EPS). */
export const wholeMs = (gap: number) => Math.abs(gap - Math.round(gap)) <= FRACTION_EPS;
const nonNull = (v: number | null): v is number => v !== null;
const sum = (a: readonly (number | null)[]) => a.filter(nonNull).reduce((s, v) => s + v, 0);

// ------------------------------------------------------------------ the three questions

/** Q1: the page's pointer events of the move to the asked fractional point. */
export function q1Of(r: Records, asked: Pt) {
  const moves = r.moves.filter((m) => m.p === "q1"), samples = moves.flatMap((m) => m.c), mice = r.mice.filter((m) => m.p === "q1");
  const last = moves.at(-1) ?? null, ls = last?.c.at(-1) ?? null;
  const err = last && last.x !== null && last.y !== null ? { x: rn(last.x - asked.x, 6), y: rn(last.y - asked.y, 6) } : null;
  const frac = (p: Point) => hasFraction(p.x) || hasFraction(p.y);
  return {
    asked,
    pointermoves: moves.length, samples: samples.length, mousemoves: mice.length,
    trusted: moves.filter((m) => m.tr).length, mouseType: moves.filter((m) => m.mouse).length, coalescedApi: moves.filter((m) => m.api).length,
    last: last && { clientX: last.x, clientY: last.y, offsetX: last.ox, offsetY: last.oy, sampleX: ls?.x ?? null, sampleY: ls?.y ?? null, sampleOffsetX: ls?.ox ?? null, sampleOffsetY: ls?.oy ?? null },
    lastErrorPx: err,
    reached: !!err && Math.abs(err.x) <= REACH_PX && Math.abs(err.y) <= REACH_PX,
    lastHasFraction: !!last && frac(last),
    withFraction: {
      pointermove: moves.filter(frac).length,
      pointermoveOffset: moves.filter((m) => hasFraction(m.ox) || hasFraction(m.oy)).length,
      sample: samples.filter(frac).length,
      sampleOffset: samples.filter((s) => hasFraction(s.ox) || hasFraction(s.oy)).length,
      mousemove: mice.filter(frac).length,
    },
  };
}

/** Q2: the page's wheel events of each wheel call. */
export function q2Of(r: Records, deltas: readonly number[]) {
  return {
    calls: deltas.map((deltaY, i) => {
      const w = r.wheels.filter((x) => x.p === `q2-${i}`), dy = w.map((x) => x.dy), wdy = w.map((x) => x.wdy);
      const sDy = sum(dy), sWdy = sum(wdy);
      return {
        deltaY, events: w.length, trusted: w.filter((x) => x.tr).length,
        deltaYs: dy.slice(0, LIST_MAX), deltaModes: w.map((x) => x.mode).slice(0, LIST_MAX), wheelDeltaYs: wdy.slice(0, LIST_MAX),
        deltaXSum: sum(w.map((x) => x.dx)), wheelDeltaXSum: sum(w.map((x) => x.wdx)),
        deltaYSum: rn(sDy, 4), wheelDeltaYSum: rn(sWdy, 4), wheelPerDeltaY: sDy ? rn(sWdy / sDy, 4) : null,
        gapsMs: summarize(gaps(w.map((x) => x.t).filter(nonNull))),
      };
    }),
    scrollY: r.scrollY,
  };
}

/**
 * Q3: the sample gaps of the stage's path: the coalesced events' timeStamps (fromCoalesced). Chrome gives
 * getCoalescedEvents in a secure context only, and the agent browser's about:blank tab is not one on the Linux server
 * (page.secure false): then each pointermove counts as one sample. A pointermove goes at the page's next frame with the
 * time of its last sample, so such a gap is one sample gap or more; framesMs gives the page's frame gaps during the path.
 */
export function q3Of(r: Records, from: Pt, to: Pt) {
  const moves = r.moves.filter((m) => m.p === "q3");
  const samples = moves.flatMap((m) => (m.c.length ? m.c : [m]));
  const times = samples.map((s) => s.t).filter(nonNull), sg = gaps(times);
  const last = moves.at(-1) ?? null;
  const err = last && last.x !== null && last.y !== null ? { x: rn(last.x - to.x, 6), y: rn(last.y - to.y, 6) } : null;
  return {
    from, to, chordPx: r2(Math.hypot(to.x - from.x, to.y - from.y)),
    pointermoves: moves.length, samples: samples.length, coalescedApi: moves.filter((m) => m.api).length,
    fromCoalesced: moves.length > 0 && moves.every((m) => m.api),
    sampleGapsMs: summarize(sg),
    pointermoveGapsMs: summarize(gaps(moves.map((m) => m.t).filter(nonNull))),
    samplesPerPointermove: summarize(moves.map((m) => m.c.length)),
    frames: r.frames.length,
    framesMs: summarize(gaps(r.frames)),
    wholeMsGaps: sg.filter(wholeMs).length,
    pathMs: times.length > 1 ? rn(times[times.length - 1] - times[0], 3) : null,
    end: last && { clientX: last.x, clientY: last.y },
    endErrorPx: err,
    endReached: !!err && Math.abs(err.x) <= REACH_PX && Math.abs(err.y) <= REACH_PX,
    gapsMs: sg.slice(0, LIST_MAX).map((g) => rn(g, 3)),
  };
}

// ------------------------------------------------------------------ the result

export type Meta = { version: number; commit: string; dirty: boolean | null; seed: number | null };
export type Platform = { os: string; arch: string; node: string; chrome: string };
export type PageInfo = { width: number; height: number; dpr: number; visible: boolean; focused: boolean; secure: boolean; frames: boolean };

/** The Chrome version of Browser.getVersion's product ("Chrome/158.0.7100.1"): its digits and dots only, else "unknown". */
export function chromeVersion(product: unknown): string {
  const m = typeof product === "string" ? /\/([0-9]+(\.[0-9]+){0,3})$/.exec(product) : null;
  return m ? m[1] : "unknown";
}

/** The page's size and state in its shape, or null. */
export function readPage(v: unknown, frames: unknown): PageInfo | null {
  if (!obj(v) || ![v.width, v.height, v.dpr].every((x) => typeof x === "number" && Number.isFinite(x) && x > 0) || typeof v.visible !== "boolean" || typeof v.focused !== "boolean" || typeof v.secure !== "boolean" || typeof frames !== "boolean") return null;
  return { width: v.width as number, height: v.height as number, dpr: v.dpr as number, visible: v.visible, focused: v.focused, secure: v.secure, frames };
}

export type Parts = { q1: ReturnType<typeof q1Of>; q2: ReturnType<typeof q2Of>; q3: ReturnType<typeof q3Of> };

/** The result of a run whose three parts ran: their values and summaries. */
export function okResult(o: { meta: Meta; platform: Platform; page: PageInfo; parts: Parts; ms: number; tabClosed: boolean }) {
  return { ok: true as const, probe: o.meta, platform: o.platform, page: o.page, q1: o.parts.q1, q2: o.parts.q2, q3: o.parts.q3, tabClosed: o.tabClosed, ms: Math.round(o.ms) };
}

/** The result of a stop: the stage, a fixed reason, and the CDP error's code and cleaned text when there is one. */
export function failResult(o: { meta: Meta; platform?: Platform; page?: PageInfo; stage: string; reason: string; code?: number; detail?: string; tabClosed?: boolean | null; ms: number }) {
  return {
    ok: false as const, stage: o.stage, reason: o.reason,
    ...(o.code !== undefined ? { code: o.code } : {}), ...(o.detail ? { detail: o.detail } : {}),
    probe: o.meta, ...(o.platform ? { platform: o.platform } : {}), ...(o.page ? { page: o.page } : {}),
    tabClosed: o.tabClosed ?? null, ms: Math.round(o.ms),
  };
}

/**
 * A failure's text with no URL, path, address or long id, in printable ASCII, at most 200 characters. `redact`: the
 * strings that never go out as they are (the endpoint's socket path and scope).
 */
export function clean(text: string, redact: readonly string[] = []): string {
  let s = String(text);
  for (const r of redact) if (r) s = s.split(r).join("<endpoint>");
  s = s.replace(/[^\x20-\x7e]/g, " ")
    .replace(/[A-Za-z][A-Za-z0-9+.-]*:\/\/\S*/g, "<url>")
    .replace(/[~.]*\/\S*/g, "<path>")
    .replace(/\\\S*/g, "<path>")
    .replace(/\S+@\S+/g, "<address>")
    .replace(/[A-Za-z0-9_+=-]{24,}/g, "<id>")
    .replace(/\s+/g, " ").trim();
  return s.length > 200 ? `${s.slice(0, 197)}...` : s;
}

/** The strings that a result may hold, by their place, and their form. */
const STRINGS: Record<string, RegExp> = {
  "probe.commit": /^([0-9a-f]{40}|unknown)$/,
  "platform.os": /^[a-z0-9]{1,16}$/,
  "platform.arch": /^[a-z0-9_]{1,16}$/,
  "platform.node": /^([0-9]+(\.[0-9]+){0,3}|unknown)$/,
  "platform.chrome": /^([0-9]+(\.[0-9]+){0,3}|unknown)$/,
  stage: /^[a-z0-9-]{1,24}$/,
  reason: /^[\x20-\x7e]{1,200}$/,
  detail: /^[\x20-\x7e]{1,200}$/,
};
/** The free texts: a stop's reason and detail. */
const FREE_TEXT: ReadonlySet<string> = new Set(["reason", "detail"]);
/** A free text with no URL, path, address or long id (clean's output). */
const safeText = (s: string) => !/[/\\@]/.test(s) && !/[A-Za-z0-9_+=-]{24,}/.test(s);

/**
 * The check of numbers only: every value of the result is a finite number, a flag or null, but the strings of STRINGS in
 * their form (the free texts with no URL, path, address or long id); its size is at most RESULT_MAX_BYTES. Null when it
 * passes, else the place of the first value that fails.
 */
export function checkResult(result: unknown): string | null {
  const walk = (v: unknown, at: string): string | null => {
    if (v === null || typeof v === "boolean") return null;
    if (typeof v === "number") return Number.isFinite(v) ? null : at;
    if (typeof v === "string") { const re = STRINGS[at]; return re && re.test(v) && (!FREE_TEXT.has(at) || safeText(v)) ? null : at; }
    if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) { const bad = walk(v[i], `${at}[${i}]`); if (bad) return bad; } return null; }
    if (obj(v)) {
      for (const [k, x] of Object.entries(v)) {
        if (!/^[A-Za-z0-9]{1,32}$/.test(k)) return `${at}.<key>`;
        const bad = walk(x, at ? `${at}.${k}` : k);
        if (bad) return bad;
      }
      return null;
    }
    return at || "<root>";
  };
  if (!obj(result) || typeof result.ok !== "boolean") return "ok";
  if (result.ok && !["probe", "platform", "page", "q1", "q2", "q3", "ms"].every((k) => k in result)) return "<parts>";
  if (!result.ok && !("stage" in result && "reason" in result)) return "<stop>";
  const bad = walk(result, "");
  if (bad) return bad;
  return Buffer.byteLength(JSON.stringify(result)) <= RESULT_MAX_BYTES ? null : "<size>";
}
