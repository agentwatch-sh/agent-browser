// The pointer plan (board ab-t30.3; the input design, docs/superpowers/specs/2026-11-10-vanilla-playwright-human-input-design.md,
// section 10.1; C11 "The input stage", "A person's input"): a path from a start point to a target with a width, as points
// with times at the device's rate. Pure: the random source and the person are arguments, and no clock is read.
//
// The rules (first values in src/human/params/*.json, each with its source):
// - The start: the page's last point, never a fixed point. With none, a random point of the viewport's middle 30% to
//   70% (startPoint). The caller gives the start.
// - The time: Fitts's law, a + b log2(1 + D / W) (W the target's smaller side), times the person's speed and a lognormal
//   spread (sigma 0.2), from 300 to 1000 ms.
// - The shape: one main sub-movement with a bell speed (minimum jerk) along an arc to one side, with a deviation of 2%
//   to 10% of the distance.
// - End corrections: 0 to 2 small corrective sub-movements in the last 10% of the time; for a move of more than 500 px,
//   in about 30% of moves (the person's share), an overshoot of 2% to 8% past the target, then the way back (the path's
//   time then at most 1500 ms).
// - Jitter: a hand's tremor across the path, 0.3 to 1.2 px at 8 to 12 Hz (the person's), which fades in and out at the
//   ends, so that the path starts at its start and ends on its target.
// - The approach to a small target: the bell's peak comes early and its end is slow (a time warp of the main
//   sub-movement), so a 24 px square in a 300 x 65 frame sees an entry at the frame's edge and many samples inside it.
// - The rate: one sample each 8 ms (125 Hz), in whole px, with no sample that does not move; the last one is the target.
// - The speed: at most 3.5 px/ms between two samples; a faster plan is stretched in time until it holds.

import type { Person } from "./person.ts";
import { chance, draw, uniform, type Random } from "./random.ts";

export type Pt = { x: number; y: number };
/** A sample of a plan: its point and its time in ms from the start of the path. */
export type Sample = { x: number; y: number; t: number };
/** One sub-movement of a path: when it starts and how long it takes (ms). */
export type Sub = { kind: "main" | "correction" | "back"; start: number; ms: number };

/** Fitts's law: a + b log2(1 + D / W), not clamped (the person's a and b). */
export const fittsMs = (distance: number, width: number, aMs: number, bMs: number) => aMs + bMs * Math.log2(1 + distance / Math.max(1, width));

/** Minimum jerk: slow start, fast middle, slow arrival. */
const minJerk = (u: number) => u * u * u * (10 - 15 * u + 6 * u * u);
const clamp01 = (u: number) => Math.min(1, Math.max(0, u));
const smooth01 = (u: number) => { const v = clamp01(u); return v * v * (3 - 2 * v); };

/** The drawn values of one path: the same values give the same path at another time scale (the speed rule's stretch). */
export type Shape = {
  /** Fitts's time with its spread, in [minMs, maxMs]. */
  fittsMs: number;
  /** The arc: its deviation (px) and its side (1 or -1). */
  deviationPx: number; side: 1 | -1;
  /** The main sub-movement's time warp (below 1: an early peak and a slow end). */
  warp: number;
  /** An overshoot past the target (then `ends` holds the overshoot point), or the main's end error before the corrections. */
  overshoot: boolean;
  /** Where each sub-movement but the last ends, as an offset from the target (px): the main's end, then each correction's. */
  ends: Pt[];
  /** The way back's time after an overshoot (ms; 0 with none). */
  backMs: number;
  /** The tremor: two waves across the path (px, Hz, phase). */
  waves: { px: number; hz: number; phase: number }[];
};

/** Draw the values of a path from `from` to `to`, to a target of the width `width`. */
export function drawShape(from: Pt, to: Pt, width: number, person: Person, random: Random): Shape {
  const P = person.params.path, D = Math.hypot(to.x - from.x, to.y - from.y);
  const ux = D > 0 ? (to.x - from.x) / D : 1, uy = D > 0 ? (to.y - from.y) / D : 0, nx = -uy, ny = ux;
  const f = P.fitts, time = Math.min(f.maxMs, Math.max(f.minMs, fittsMs(D, width, f.aMs, f.bMs) * person.speed * draw(random, f.spread)));
  const side: 1 | -1 = chance(random, person.side) ? 1 : -1, deviationPx = draw(random, P.arc.deviation) * D;
  const warp = draw(random, width <= P.approach.smallPx ? P.approach.warpSmall : P.approach.warpLarge);
  const overshoot = D > P.overshoot.minPx && chance(random, person.overshootShare);
  const lateral = () => uniform(random, -1, 1) * P.corrections.lateralShare * D;
  const ends: Pt[] = [];
  let backMs = 0;
  if (overshoot) {
    const past = draw(random, P.overshoot.past) * D, side2 = lateral();
    ends.push({ x: ux * past + nx * side2, y: uy * past + ny * side2 });
    backMs = Math.min(P.overshoot.maxMs - time * 0.95, Math.max(P.overshoot.backMinMs, draw(random, P.overshoot.backShare) * time));
  } else {
    // 0, 1 or 2 corrections, by the counts' shares; the main then ends short of the target (and to one side of it).
    let u = random(), n = 0;
    while (n < P.corrections.counts.length - 1 && u >= P.corrections.counts[n]) { u -= P.corrections.counts[n]; n++; }
    if (n > 0) {
      const short = Math.min(draw(random, P.corrections.errorShare) * D, 1.5 * width + 4), side2 = Math.max(-short, Math.min(short, lateral()));
      const e0 = { x: -ux * short + nx * side2, y: -uy * short + ny * side2 };
      ends.push(e0);
      if (n === 2) { const k = uniform(random, 0.2, 0.4); ends.push({ x: e0.x * k, y: e0.y * k }); }
    }
  }
  const px = person.tremorPx * uniform(random, 0.8, 1.2), share = uniform(random, 0.6, 0.8);
  const waves = [
    { px: px * share, hz: person.tremorHz, phase: uniform(random, 0, 2 * Math.PI) },
    { px: px * (1 - share), hz: person.tremorHz * uniform(random, 1.3, 1.6), phase: uniform(random, 0, 2 * Math.PI) },
  ];
  return { fittsMs: time, deviationPx, side, warp, overshoot, ends, backMs, waves };
}

/** A path's continuous form: where the pointer is `t` ms after its start, with and without the tremor. */
export type Trajectory = {
  from: Pt; to: Pt; ms: number; shape: Shape; subs: Sub[];
  at(t: number): Pt;
  /** The path with no tremor. */
  smooth(t: number): Pt;
};

/**
 * The trajectory of a shape, with all its times multiplied by `scale`: the sum of the sub-movements (each one a minimum-
 * jerk bell that moves the pointer by its own offset; the main one along its arc, in its time warp), plus the tremor
 * across the chord, faded in and out over the first and the last `fadeShare` of the time.
 */
export function buildTrajectory(from: Pt, to: Pt, shape: Shape, person: Person, scale = 1): Trajectory {
  const P = person.params.path, D = Math.hypot(to.x - from.x, to.y - from.y);
  const ux = D > 0 ? (to.x - from.x) / D : 1, uy = D > 0 ? (to.y - from.y) / D : 0;
  const T = shape.fittsMs * scale, subs: Sub[] = [];
  const points = [...shape.ends.map((e) => ({ x: to.x + e.x, y: to.y + e.y })), { x: to.x, y: to.y }];
  let mainMs: number;
  if (shape.overshoot) {
    mainMs = T;
    subs.push({ kind: "main", start: 0, ms: T }, { kind: "back", start: T * 0.95, ms: shape.backMs * scale });
  } else if (points.length === 1) {
    mainMs = T;
    subs.push({ kind: "main", start: 0, ms: T });
  } else {
    // The corrections share the last part of the time, one after the other with a small overlap.
    const last = P.corrections.lastShare * T, n = points.length - 1, d = last / (n - 0.3 * (n - 1));
    mainMs = T - last;
    subs.push({ kind: "main", start: 0, ms: mainMs });
    for (let k = 0; k < n; k++) subs.push({ kind: "correction", start: mainMs + k * 0.7 * d, ms: d });
  }
  const ms = Math.max(...subs.map((s) => s.start + s.ms));
  const main = points[0], mdx = main.x - from.x, mdy = main.y - from.y, ml = Math.hypot(mdx, mdy) || 1;
  const mnx = -mdy / ml, mny = mdx / ml, bend = 4 * shape.deviationPx * shape.side;
  const smooth = (t: number): Pt => {
    if (t >= ms) return { x: to.x, y: to.y }; // the end is the target itself, not a sum of offsets
    const s = minJerk(Math.pow(clamp01(t / mainMs), shape.warp));
    let x = from.x + mdx * s + mnx * bend * s * (1 - s), y = from.y + mdy * s + mny * bend * s * (1 - s);
    for (let k = 1; k < subs.length; k++) {
      const q = minJerk(clamp01((t - subs[k].start) / subs[k].ms));
      x += (points[k].x - points[k - 1].x) * q;
      y += (points[k].y - points[k - 1].y) * q;
    }
    return { x, y };
  };
  const fade = Math.max(1, P.jitter.fadeShare * ms);
  const at = (t: number): Pt => {
    const p = smooth(t);
    if (t <= 0 || t >= ms) return p;
    const env = smooth01(t / fade) * smooth01((ms - t) / fade);
    let j = 0;
    for (const w of shape.waves) j += w.px * Math.sin(2 * Math.PI * w.hz * t / 1000 + w.phase); // a tremor keeps its frequency in a stretched path
    return { x: p.x - uy * j * env, y: p.y + ux * j * env };
  };
  return { from, to, ms, shape, subs, at, smooth };
}

/** The samples of a trajectory each `rateMs`: whole px (`wholePx`), no sample that does not move, the target last. */
export function samplePath(traj: Trajectory, rateMs: number, wholePx = true): Sample[] {
  const fit = (p: Pt): Pt => (wholePx ? { x: Math.round(p.x), y: Math.round(p.y) } : { x: p.x, y: p.y });
  const end = fit(traj.to), out: Sample[] = [];
  let last = fit(traj.from);
  const n = Math.ceil(traj.ms / rateMs);
  for (let i = 1; i <= n; i++) {
    const t = i * rateMs, p = i === n ? end : fit(traj.at(t));
    if (Math.abs(p.x - last.x) < 1e-9 && Math.abs(p.y - last.y) < 1e-9) continue;
    out.push({ x: p.x, y: p.y, t });
    last = p;
  }
  return out;
}

/** The highest speed between two samples (px/ms), from the start. */
export function peakSpeed(from: Pt, samples: readonly Sample[]): number {
  let top = 0, prev = { x: from.x, y: from.y, t: 0 };
  for (const s of samples) { top = Math.max(top, Math.hypot(s.x - prev.x, s.y - prev.y) / Math.max(1e-9, s.t - prev.t)); prev = s; }
  return top;
}

export type PathPlan = { samples: Sample[]; ms: number; trajectory: Trajectory };

/**
 * The plan of a path from `from` to `to` (a target of the width `width`): the samples at the device's rate (the
 * person's parameter file, or `rateMs`), stretched in time until no step is faster than `maxPxPerMs`. Empty for a move
 * of less than 1 px (a mouse that does not move sends nothing).
 */
export function planPath(from: Pt, to: Pt, width: number, person: Person, random: Random, opts: { rateMs?: number } = {}): PathPlan {
  const dev = person.params.device, rate = opts.rateMs ?? dev.rateMs;
  const start = dev.wholePx ? { x: Math.round(from.x), y: Math.round(from.y) } : from;
  const end = dev.wholePx ? { x: Math.round(to.x), y: Math.round(to.y) } : to;
  const shape = drawShape(start, to, width, person, random);
  if (Math.hypot(to.x - from.x, to.y - from.y) < 1 || (start.x === end.x && start.y === end.y)) {
    return { samples: [], ms: 0, trajectory: buildTrajectory(start, to, { ...shape, fittsMs: 0, ends: [], overshoot: false, backMs: 0 }, person) };
  }
  const stretched = (sh: Shape) => {
    let scale = 1, traj = buildTrajectory(start, to, sh, person, scale), samples = samplePath(traj, rate, dev.wholePx);
    for (let i = 0; i < 8; i++) {
      const v = peakSpeed(start, samples);
      if (v <= dev.maxPxPerMs) break;
      scale *= Math.max(1.02, v / (dev.maxPxPerMs * 0.97));
      traj = buildTrajectory(start, to, sh, person, scale);
      samples = samplePath(traj, rate, dev.wholePx);
    }
    return { samples, ms: traj.ms, trajectory: traj };
  };
  const plan = stretched(shape);
  // An overshoot that the speed rule stretches past its time limit (a long move): the path with no overshoot.
  return plan.ms > person.params.path.overshoot.maxMs && shape.overshoot ? stretched(withoutOvershoot(shape)) : plan;
}

/** A shape with no overshoot and no corrections: the main sub-movement alone ends on the target. */
export const withoutOvershoot = (shape: Shape): Shape => ({ ...shape, overshoot: false, ends: [], backMs: 0 });

/** A start point when the page has none: a random point of the viewport's middle (30% to 70% on each axis). */
export function startPoint(width: number, height: number, random: Random, middle: readonly [number, number] = [0.3, 0.7]): Pt {
  return { x: width * uniform(random, middle[0], middle[1]), y: height * uniform(random, middle[0], middle[1]) };
}
