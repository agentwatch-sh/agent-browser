// The relay's part of the agent display's pointer (board ab-v16.71; the agent pointer design,
// docs/superpowers/specs/2026-11-06-agent-pointer-move-design.md, sections 2 and 3; contract C10 "The daemon's own ops"
// and C11 "The pointer at an activation" in chrome-extension's docs/protocol.md, the master). The relay plans a
// person-shaped path in display pixels with the generator that src/input.ts uses (src/human/path.ts, board ab-t30.3:
// its trajectory, sampled for the X player within C10's limits), and the daemon, which owns the unit's Xvfb, plays it
// with xdotool (daemon.movePointer). This file holds the
// constants, the relay's own check of a move (C10's rules that need no daemon state), the path and the mapping of a
// page's CSS px to the display. The model (model.ts) runs the activation step and the catch-up with them. No log line
// carries a point (C10's log rule).

import { buildTrajectory, drawShape, withoutOvershoot, type Point, type Shape, type Trajectory } from "../human/path.ts";
import { drawPerson, paramsFor, type Person } from "../human/person.ts";

export type Pt = Point;
/** A point of a path: whole display px, and `dt`, the wait in ms before its move. */
export type PathPoint = { x: number; y: number; dt: number };
/** A rectangle of whole px, both ends inside. */
export type Rect = { x0: number; y0: number; x1: number; y1: number };
/** The arg of daemon.movePointer (C10). */
export type Move = { at: Pt; from: Pt; path: PathPoint[]; width: number; height: number; notAfter: number; views: number };

/** C10's pointer constants (the vectors' pointerConstants). */
export const POINTER = {
  POINTER_PATH_MAX_POINTS: 120,
  POINTER_DT_MIN_MS: 16,
  POINTER_DT_MAX_MS: 250,
  POINTER_PATH_MAX_MS: 1500,
  POINTER_STEP_MAX_PX: 50,
  POINTER_NEAR_PX: 2,
  POINTER_AHEAD_MAX_MS: 2000,
  POINTER_PATHS_PER_S: 5,
  POINTER_READS_PER_S: 10,
  POINTER_READ_MS: 1000,
  POINTER_KILL_MS: 1000,
  POINTER_START_MS: 300,
  POINTER_SLACK_MS: 200,
  POINTER_READ_WAIT_MS: 1200,
  POINTER_VIEW_QUIET_MS: 10000,
} as const;
/** C11: the limit of each part of the activation step. */
export const ACTIVATE_MAX_MS = 2000;
/** C11: how long the relay waits for a geometry read. */
export const GEOMETRY_WAIT_MS = 200;
/** C11: a tab has at most this many catch-up moves without an answer (per tab, not per catch-up: review-63e note E). */
export const CATCH_UP_MAX_UNANSWERED = 4;
/** The sample time of a path (16 ms: C10's POINTER_DT_MIN_MS; the X path keeps its 16 ms samples, the input design's section 11.2). */
const SAMPLE_MS = 16;
/** The default target width of the generator (input.ts's moveTo). */
const TARGET_WIDTH = 24;

/** CLOCK_MONOTONIC in whole ms, which every process of the box shares (C10): never performance.now(). */
export const monotonicMs = () => Number(process.hrtime.bigint() / 1000000n);
/** A move's notAfter: the clock plus POINTER_START_MS. */
export const notAfter = () => monotonicMs() + POINTER.POINTER_START_MS;
/** The path's total time. */
export const totalMs = (path: readonly { dt: number }[]) => path.reduce((a, p) => a + p.dt, 0);
/** The wait of a move (C10): POINTER_START_MS + the path's total time + POINTER_KILL_MS + POINTER_SLACK_MS. */
export const moveWait = (path: readonly { dt: number }[]) => POINTER.POINTER_START_MS + totalMs(path) + POINTER.POINTER_KILL_MS + POINTER.POINTER_SLACK_MS;

const int = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const keysAre = (o: unknown, keys: string[]): o is Record<string, unknown> =>
  !!o && typeof o === "object" && !Array.isArray(o) && Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k));
const isPt = (p: unknown): p is Pt => keysAre(p, ["x", "y"]) && int(p.x) && int(p.y);
/** Two points are at most d px apart, in integers (C10: Euclidean, squared). */
export const near = (a: Pt, b: Pt, d: number) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2 <= d * d;
const inSize = (p: Pt, w: number, h: number) => p.x >= 0 && p.y >= 0 && p.x < w && p.y < h;

/**
 * The relay's own check of daemon.movePointer's args (C10's checks that need no daemon state; the relay checks each
 * move before it sends it): `bad args`, then `out of bounds` against the request's own width and height (the relay's
 * display), or null. `now`: the clock for the POINTER_AHEAD_MAX_MS rule. The stand-in daemon of the live test uses the
 * same rules (test/live/agent-mode/pointer-ops.ts).
 */
export function moveProblem(args: unknown, now: number): "bad args" | "out of bounds" | null {
  if (!Array.isArray(args) || args.length !== 1) return "bad args";
  const m = args[0];
  if (!keysAre(m, ["at", "from", "path", "width", "height", "notAfter", "views"])) return "bad args";
  if (!isPt(m.at) || !isPt(m.from) || !int(m.width) || !int(m.height) || !int(m.notAfter) || !int(m.views)) return "bad args";
  const w = m.width, h = m.height;
  if (w < 1 || h < 1 || m.views < 0 || m.notAfter < 0 || m.notAfter > now + POINTER.POINTER_AHEAD_MAX_MS) return "bad args";
  if (!inSize(m.at, w, h)) return "bad args";
  const path = m.path;
  if (!Array.isArray(path) || path.length < 1 || path.length > POINTER.POINTER_PATH_MAX_POINTS) return "bad args";
  let last: Pt = m.from, total = 0;
  for (const p of path) {
    if (!keysAre(p, ["x", "y", "dt"]) || !int(p.x) || !int(p.y) || !int(p.dt)) return "bad args";
    if (p.dt < POINTER.POINTER_DT_MIN_MS || p.dt > POINTER.POINTER_DT_MAX_MS) return "bad args";
    if (!near(p as Pt, last, POINTER.POINTER_STEP_MAX_PX)) return "bad args";
    total += p.dt;
    last = p as Pt;
  }
  if (total > POINTER.POINTER_PATH_MAX_MS) return "bad args";
  if (!inSize(m.from, w, h) || path.some((p: Pt) => !inSize(p, w, h))) return "out of bounds";
  return null;
}

/**
 * Sample a trajectory every 16 ms (whole ms; each dt 16 to 31 ms, the last sample at the end), in whole pixels, each
 * point clamped into `clamp`; drop a point that does not move (its time goes to the next one) and a first point less
 * than 2 px from the rounded start, and cap each dt at POINTER_DT_MAX_MS. `keepEnd`: the last point is `to` itself, also
 * outside the clamp.
 */
export function sampleTrajectory(from: Pt, to: Pt, traj: Trajectory, clamp: Rect | null, keepEnd = false): PathPoint[] {
  const total = Math.max(SAMPLE_MS, Math.round(traj.ms));
  const n = Math.max(1, Math.floor(total / SAMPLE_MS)), base = Math.floor(total / n), extra = total - base * n;
  const fit = (q: Pt): Pt => {
    const p = { x: Math.round(q.x), y: Math.round(q.y) };
    return clamp ? { x: Math.min(Math.max(p.x, clamp.x0), clamp.x1), y: Math.min(Math.max(p.y, clamp.y0), clamp.y1) } : p;
  };
  const start = { x: Math.round(from.x), y: Math.round(from.y) };
  const out: PathPoint[] = [];
  let last = start, t = 0, wait = 0;
  for (let i = 1; i <= n; i++) {
    const dt = base + (i <= extra ? 1 : 0);
    t += dt; wait += dt;
    const p = i === n ? (keepEnd ? { x: Math.round(to.x), y: Math.round(to.y) } : fit(to)) : fit(traj.at((t / total) * traj.ms));
    if ((p.x === last.x && p.y === last.y) || (!out.length && near(p, start, 1.99))) continue;
    out.push({ x: p.x, y: p.y, dt: Math.min(wait, POINTER.POINTER_DT_MAX_MS) });
    last = p; wait = 0;
  }
  return out;
}

/** The longest step of a path from `from`, squared. */
const maxStep2 = (from: Pt, path: PathPoint[]) => path.reduce((m, p, i) => { const q = i ? path[i - 1] : from; return Math.max(m, (p.x - q.x) ** 2 + (p.y - q.y) ** 2); }, 0);

/** A path fits C10's limits: 1 to 120 points, each dt 16 to 250 ms, at most 1500 ms, each step at most 50 px. */
export function fits(from: Pt, path: PathPoint[]): boolean {
  return path.length >= 1 && path.length <= POINTER.POINTER_PATH_MAX_POINTS && totalMs(path) <= POINTER.POINTER_PATH_MAX_MS
    && path.every((p) => p.dt >= POINTER.POINTER_DT_MIN_MS && p.dt <= POINTER.POINTER_DT_MAX_MS)
    && maxStep2(from, path) <= POINTER.POINTER_STEP_MAX_PX ** 2;
}

/**
 * The out-and-back of S equal to T (or within 2 px of it): a move 3 px from S toward the clamp's middle (2 to 4 px after
 * the rounding and the clamp), then T.
 */
function outAndBack(S: Pt, T: Pt, clamp: Rect | null, random: () => number): PathPoint[] | null {
  const mid = clamp ? { x: (clamp.x0 + clamp.x1) / 2, y: (clamp.y0 + clamp.y1) / 2 } : { x: S.x + 1, y: S.y };
  const base = Math.atan2(mid.y - S.y, mid.x - S.x) || 0;
  for (let i = 0; i < 16; i++) {
    const a = base + (random() - 0.5) * (i < 8 ? Math.PI / 2 : 2 * Math.PI), r = 2.5 + random();
    let p = { x: Math.round(S.x + r * Math.cos(a)), y: Math.round(S.y + r * Math.sin(a)) };
    if (clamp) p = { x: Math.min(Math.max(p.x, clamp.x0), clamp.x1), y: Math.min(Math.max(p.y, clamp.y0), clamp.y1) };
    const d2 = (p.x - S.x) ** 2 + (p.y - S.y) ** 2;
    if (d2 < 4 || d2 > 16 || (p.x === T.x && p.y === T.y)) continue;
    const dt = () => SAMPLE_MS + Math.floor(random() * SAMPLE_MS);
    return [{ x: p.x, y: p.y, dt: dt() }, { x: T.x, y: T.y, dt: dt() }];
  }
  return null;
}

/**
 * The relay's path from S to T (section 3, step 4), in whole px, or null when it does not fit C10's limits. The
 * generator's trajectory (src/human/path.ts: Fitts's time with the person's spread, the arc, the end corrections, an
 * overshoot past 500 px, the tremor; the target width 24) of `person` (the model's one person for the display's one
 * pointer; else one drawn from `random`), sampled every 16 ms and clamped into `clamp`; while a step is over 50 px,
 * the trajectory's time is stretched by one factor and it is sampled again. When that does not fit C10's 1500 ms, the
 * path without its overshoot and corrections. With S equal to T (or within 2 px), a short
 * out-and-back of 2 to 4 px. The catch-up uses it too, in the page's CSS px, clamped to the page's content box with
 * `keepEnd`: its last point is the client's own event point, also where that is outside the box.
 */
export async function planPath(S: Pt, T: Pt, o: { clamp?: Rect | null; random?: () => number; keepEnd?: boolean; person?: Person } = {}): Promise<PathPoint[] | null> {
  const random = o.random ?? Math.random, clamp = o.clamp ?? null;
  const from = { x: Math.round(S.x), y: Math.round(S.y) }, to = { x: Math.round(T.x), y: Math.round(T.y) };
  if (near(from, to, 1.99)) {
    const path = outAndBack(from, to, clamp, random);
    return path && fits(from, path) ? path : null;
  }
  const person = o.person ?? drawPerson(paramsFor("linux"), random);
  const shape = drawShape(from, to, TARGET_WIDTH, person, random);
  const stretched = (sh: Shape): PathPoint[] | null => {
    let factor = 1;
    for (let i = 0; i < 24; i++) {
      const path = sampleTrajectory(from, to, buildTrajectory(from, to, sh, person, factor), clamp, o.keepEnd ?? false);
      if (!path.length) return null;
      const step = Math.sqrt(maxStep2(from, path));
      if (step <= POINTER.POINTER_STEP_MAX_PX) return fits(from, path) ? path : null;
      if (totalMs(path) > POINTER.POINTER_PATH_MAX_MS) return null;
      factor *= Math.max(1.02, step / (POINTER.POINTER_STEP_MAX_PX - 3));
    }
    return null;
  };
  // An overshoot or a correction that does not fit C10's limits after the stretch: the main sub-movement alone.
  return stretched(shape) ?? (shape.overshoot || shape.ends.length ? stretched(withoutOvershoot(shape)) : null);
}

// ------------------------------------------------------------------ the geometry

/**
 * A page's geometry, read in the relay's own isolated world: the 7 values of src/input.ts's mapping (screenX, screenY,
 * outerWidth, outerHeight, innerWidth, innerHeight, devicePixelRatio), visualViewport.scale, screen.width and
 * screen.height, document.visibilityState, and the content box `cw` x `ch`: the viewport less its scrollbars
 * (visualViewport.width and height, at a scale of 1; else documentElement.clientWidth and clientHeight). A page gets no
 * mouse event over its scrollbars, so the path and the catch-up stay inside the content box (the lead's decision on
 * point 5 of PR #68).
 */
export type Geo = { sx: number; sy: number; ow: number; oh: number; iw: number; ih: number; cw: number; ch: number; dpr: number; scale: number; sw: number; sh: number; vis: string };
/** The read's expression: one object by value. */
export const GEO_EXPRESSION = "({ sx: screenX, sy: screenY, ow: outerWidth, oh: outerHeight, iw: innerWidth, ih: innerHeight, "
  + "cw: window.visualViewport ? visualViewport.width : document.documentElement.clientWidth, "
  + "ch: window.visualViewport ? visualViewport.height : document.documentElement.clientHeight, dpr: devicePixelRatio, "
  + "scale: window.visualViewport ? visualViewport.scale : 1, sw: screen.width, sh: screen.height, vis: document.visibilityState })";

/** The geometry of a read's value, or null when a value is missing. */
export function geoOf(v: unknown): Geo | null {
  if (!v || typeof v !== "object") return null;
  const g = v as Record<string, unknown>;
  for (const k of ["sx", "sy", "ow", "oh", "iw", "ih", "cw", "ch", "dpr", "scale", "sw", "sh"]) if (typeof g[k] !== "number" || !Number.isFinite(g[k])) return null;
  return { sx: g.sx, sy: g.sy, ow: g.ow, oh: g.oh, iw: g.iw, ih: g.ih, cw: Math.floor(g.cw as number), ch: Math.floor(g.ch as number), dpr: g.dpr, scale: g.scale,
    sw: g.sw, sh: g.sh, vis: String(g.vis) } as Geo;
}

/** The page's content origin on the display (input.ts's origin: Chrome draws its own frame on a display with no window manager). */
export function originOf(g: Geo): Pt {
  const side = Math.round((g.ow - g.iw) / 2);
  return { x: g.sx + side, y: g.sy + g.oh - g.ih - side };
}
/** A page's point (client CSS px) on the display, in whole px. */
export function toDisplay(g: Geo, p: Pt): Pt {
  const o = originOf(g);
  return { x: Math.round(o.x + p.x), y: Math.round(o.y + p.y) };
}
/** A display point in a page (client CSS px), or null when it is outside the page's viewport. */
export function toPage(g: Geo, d: Pt): Pt | null {
  const o = originOf(g), p = { x: d.x - o.x, y: d.y - o.y };
  return p.x >= 0 && p.y >= 0 && p.x < g.iw && p.y < g.ih ? p : null;
}
/** The page's content box on the display (the viewport less its scrollbars), 2 px inside its edges: the clamp of a path, and where S and T must be. */
export function clampRect(g: Geo): Rect {
  const o = originOf(g);
  return { x0: o.x + 2, y0: o.y + 2, x1: o.x + g.cw - 3, y1: o.y + g.ch - 3 };
}
/** The same box in the page's CSS px: the clamp of a catch-up. */
export function contentRect(g: Geo): Rect {
  return { x0: 2, y0: 2, x1: g.cw - 3, y1: g.ch - 3 };
}
export const insideRect = (r: Rect, p: Pt) => p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1;

/**
 * The geometry gives the window's real viewport on the display (section 3): the ratio and the scale are 1, and the
 * screen is the display's size. The model adds the rules that the read alone cannot see (a minimized window, a read
 * in flight, a device-metrics override).
 */
export function usable(g: Geo | null, display: { width: number; height: number } | null): g is Geo {
  return !!g && !!display && g.dpr === 1 && g.scale === 1 && g.sw === display.width && g.sh === display.height && g.iw > 4 && g.ih > 4
    && g.cw > 4 && g.ch > 4 && g.cw <= g.iw && g.ch <= g.ih;
}
