// The generator of a person's pointer input (board ab-t30.3; the input design,
// docs/superpowers/specs/2026-11-10-vanilla-playwright-human-input-design.md, sections 10.1, 10.4, 11.1 and 13.1): the
// random source, the person, the path, the press, the wheel, the CDP player and the X player, each with a seed and a
// fake clock. Each rule of section 10.1 has a test here; the pull request's mutation table names them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CdpPlayer, type Clock } from "../src/human/cdp-player.ts";
import { buildTrajectory, drawShape, fittsMs, peakSpeed, planPath, startPoint, type Pt, type Sample } from "../src/human/path.ts";
import { drawPerson, middlePerson, paramsFor, personFor, type Person } from "../src/human/person.ts";
import { atMiddle, doubleClickGapMs, force, holdMs, pauseMs, pointFree, pressPoint, spreadPoint, type PressCase } from "../src/human/press.ts";
import { draw, normalQuantile, seededRandom, seedOf } from "../src/human/random.ts";
import { notches, notchGapMs, Wheel, wheelPlan } from "../src/human/wheel.ts";
import { playX, xScript } from "../src/human/x-player.ts";

const LINUX = paramsFor("linux"), MAC = paramsFor("darwin");
const MID = middlePerson(LINUX);
const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const quantile = (a: number[], q: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
/** A path's plan with the middle person (or `person`), from a seed. */
const plan = (from: Pt, to: Pt, width = 24, seed = 1, person: Person = MID) => planPath(from, to, width, person, seededRandom(seed));
/** Random pairs of points in a 1280 x 900 viewport at least `min` px (and at most `max` px) apart. */
function pairs(n: number, seed: number, min = 40, max = 1500): [Pt, Pt][] {
  const r = seededRandom(seed), out: [Pt, Pt][] = [];
  while (out.length < n) {
    const a = { x: 2 + Math.floor(r() * 1276), y: 2 + Math.floor(r() * 896) }, b = { x: 2 + Math.floor(r() * 1276), y: 2 + Math.floor(r() * 896) };
    if (dist(a, b) >= min && dist(a, b) <= max) out.push([a, b]);
  }
  return out;
}

// ================================================================ the random source and the person

test("random: a seeded source repeats its numbers; seedOf gives one seed for one scope's name and seed", () => {
  const a = seededRandom(7), b = seededRandom(7), c = seededRandom(8);
  const xs = Array.from({ length: 5 }, a), ys = Array.from({ length: 5 }, b);
  assert.deepEqual(xs, ys);
  assert.notDeepEqual(xs, Array.from({ length: 5 }, c));
  assert.ok(xs.every((x) => x >= 0 && x < 1));
  assert.equal(seedOf("person", "s-a", 1), seedOf("person", "s-a", 1));
  assert.notEqual(seedOf("person", "s-a", 1), seedOf("person", "s-b", 1));
  assert.notEqual(seedOf("person", "s-a", 1), seedOf("person", "s-a", 2));
  assert.notEqual(seedOf("ab", "c"), seedOf("a", "bc"), "the parts are apart");
});

test("random: each draw stays inside its bounds; a lognormal's median and sigma; a caller's range far from the median", () => {
  const r = seededRandom(3), d = { lognormal: [140, 0.402] as [number, number], min: 80, max: 400 };
  const v = Array.from({ length: 4000 }, () => draw(r, d));
  assert.ok(v.every((x) => x >= 80 && x <= 400));
  assert.ok(Math.abs(median(v) - 140) < 6, `median ${median(v)}`);
  const logs = v.filter((x) => x > 100 && x < 200).map((x) => Math.log(x / 140));
  assert.ok(logs.length > 2000);
  const n = Array.from({ length: 4000 }, () => draw(r, { normal: [10, 2] }));
  assert.ok(Math.abs(median(n) - 10) < 0.15 && Math.abs(quantile(n, 0.8413) - 12) < 0.25, `normal: ${median(n)}, ${quantile(n, 0.8413)}`);
  const short = Array.from({ length: 200 }, () => draw(r, d, [6, 9]));
  assert.ok(short.every((x) => x >= 6 && x <= 9) && Math.max(...short) - Math.min(...short) > 1, "a test's short range: inside it, and spread over it");
  assert.equal(draw(r, d, [150, 150]), 150);
  const u = Array.from({ length: 500 }, () => draw(r, { uniform: [35, 90] }));
  assert.ok(u.every((x) => x >= 35 && x <= 90) && Math.min(...u) < 40 && Math.max(...u) > 85);
  assert.ok(Math.abs(normalQuantile(0.975) - 1.95996) < 1e-4 && Math.abs(normalQuantile(0.001) + 3.0902) < 1e-3);
});

test("person: one person for each scope: the same scope and seed give the same person, another scope or seed another; each value inside the population's bounds", () => {
  const a = personFor("s-a", 41, LINUX);
  assert.deepEqual(personFor("s-a", 41, LINUX), a);
  assert.notDeepEqual(personFor("s-b", 41, LINUX), a);
  assert.notDeepEqual(personFor("s-a", 42, LINUX), a);
  const people = Array.from({ length: 300 }, (_, i) => personFor(`scope-${i}`, 1, LINUX));
  const pop = LINUX.population;
  for (const p of people) {
    assert.ok(p.speed >= (pop.speed as any).min && p.speed <= (pop.speed as any).max);
    assert.ok(p.pause >= (pop.pause as any).min && p.pause <= (pop.pause as any).max);
    assert.ok(p.tremorPx >= 0.3 && p.tremorPx <= 1.2 && p.tremorHz >= 8 && p.tremorHz <= 12);
    assert.ok(p.overshootShare >= 0.2 && p.overshootShare <= 0.4);
  }
  assert.ok(new Set(people.map((p) => p.speed.toFixed(6))).size > 290, "the people differ");
  assert.ok(Math.abs(median(people.map((p) => p.speed)) - 1) < 0.03, "the population's centre");
});

test("person: the parameter files hold the first values of design 10.1 (Linux; the Mac the same with fractional timestamps)", () => {
  assert.deepEqual([LINUX.device.rateMs, LINUX.device.latencyMs, LINUX.device.wholePx, LINUX.device.wholeMsTimestamps, LINUX.device.maxPxPerMs, LINUX.device.movesInFlight],
    [8, [3, 5], true, true, 3.5, 8]);
  assert.deepEqual([LINUX.path.fitts.aMs, LINUX.path.fitts.bMs, LINUX.path.fitts.minMs, LINUX.path.fitts.maxMs], [250, 110, 300, 1000]);
  assert.deepEqual(LINUX.path.fitts.spread, { lognormal: [1, 0.2], min: 0.6, max: 1.6 });
  assert.deepEqual([LINUX.path.arc.deviation, LINUX.path.overshoot.minPx, LINUX.path.overshoot.share, LINUX.path.overshoot.past, LINUX.path.overshoot.maxMs],
    [{ uniform: [0.02, 0.1] }, 500, 0.3, { uniform: [0.02, 0.08] }, 1500]);
  assert.deepEqual([LINUX.path.corrections.counts.length, LINUX.path.corrections.lastShare, LINUX.path.jitter.px, LINUX.path.jitter.hz, LINUX.path.start.middle],
    [3, 0.1, { uniform: [0.3, 1.2] }, { uniform: [8, 12] }, [0.3, 0.7]]);
  assert.deepEqual([LINUX.press.pauseMs, LINUX.press.holdMs, LINUX.press.force, LINUX.press.doubleGapMs, LINUX.press.spread],
    [{ lognormal: [140, 0.402], min: 80, max: 400 }, { lognormal: [100, 0.275], min: 60, max: 180 }, 0.5, { uniform: [90, 150] }, { sdShare: 0.125, maxShare: 0.25 }]);
  assert.deepEqual([LINUX.wheel.notchPx, LINUX.wheel.gapMs], [120, { uniform: [35, 90] }]);
  assert.equal(MAC.device.wholeMsTimestamps, false);
  assert.deepEqual({ ...MAC, platform: "linux", device: { ...MAC.device, wholeMsTimestamps: true }, note: LINUX.note }, LINUX, "the Mac's file is Linux's, but for its timestamps");
  for (const p of [LINUX, MAC]) for (const k of ["device.rateMs", "path.fitts", "path.arc", "path.corrections", "path.overshoot", "path.jitter", "press.pauseMs", "press.holdMs", "press.spread", "wheel"])
    assert.ok(typeof (p as any).sources[k] === "string" && (p as any).sources[k].length > 10, `${p.platform}: the source of ${k}`);
});

test("person: the parameter files agree with C11's input stage (test/vectors/stage.json): its constants and its pointer's first values; each plan's time is in its ranges", () => {
  const V = JSON.parse(readFileSync(new URL("./vectors/stage.json", import.meta.url), "utf8")), c = V.constants, f = V.firstValues;
  for (const p of [LINUX, MAC]) {
    assert.deepEqual([p.device.rateMs, p.device.latencyMs, p.device.movesInFlight, p.wheel.notchPx], [c.STAGE_MOVE_MS, c.STAGE_LATENCY_MS, c.STAGE_MOVES_IN_FLIGHT, c.STAGE_NOTCH_PX]);
    assert.deepEqual([[p.path.fitts.minMs, p.path.fitts.maxMs], p.path.overshoot.maxMs, p.path.overshoot.minPx, p.device.maxPxPerMs], [f.pathMs, f.longPathMs[1], f.longPathPx, f.maxSpeedPxPerMs]);
    const pause = p.press.pauseMs as { min: number; max: number }, hold = p.press.holdMs as { min: number; max: number };
    assert.deepEqual([[pause.min, pause.max], [hold.min, hold.max], (p.press.doubleGapMs as { uniform: number[] }).uniform, (p.wheel.gapMs as { uniform: number[] }).uniform, p.press.spread.sdShare, p.press.spread.maxShare],
      [f.pauseMs, f.holdMs, f.dblGapMs, f.notchGapMs, f.spreadSd, f.spreadMax]);
  }
  for (const [i, [a, b]] of pairs(300, 15, 3, 1500).entries()) {
    const p = plan(a, b, i % 3 ? 24 : 80, i);
    const [lo, hi] = p.trajectory.shape.overshoot ? f.longPathMs : f.pathMs;
    assert.ok(p.ms >= lo && p.ms <= hi + 1e-9, `${p.ms} ms for ${dist(a, b).toFixed(0)} px`);
  }
});

// ================================================================ the path (design 10.1)

test("path rule the start: a path starts at its start point, never at a fixed point; a page with no last point starts in the viewport's middle 30% to 70%", () => {
  const firsts = new Set<string>();
  for (const [a, b] of pairs(50, 4)) {
    const p = plan(a, b, 24, a.x);
    assert.ok(dist(p.samples[0], a) <= 3.5 * 8 + 2, `the first sample is one step from the start: ${JSON.stringify([a, p.samples[0]])}`);
    firsts.add(`${p.samples[0].x},${p.samples[0].y}`);
  }
  assert.ok(firsts.size >= 45, "no fixed start");
  const r = seededRandom(5), starts = Array.from({ length: 400 }, () => startPoint(1280, 900, r));
  assert.ok(starts.every((s) => s.x >= 0.3 * 1280 && s.x <= 0.7 * 1280 && s.y >= 0.3 * 900 && s.y <= 0.7 * 900));
  assert.ok(Math.min(...starts.map((s) => s.x)) < 0.32 * 1280 && Math.max(...starts.map((s) => s.x)) > 0.68 * 1280, "over the whole middle part");
  assert.ok(new Set(starts.map((s) => `${Math.round(s.x)},${Math.round(s.y)}`)).size > 390);
});

test("path rule the time: Fitts's law a + b log2(1 + D / W) times a lognormal spread (sigma 0.2), from 300 to 1000 ms", () => {
  const ratios: number[] = [];
  for (const [a, b] of pairs(600, 6, 95, 228)) {
    const w = 24, s = drawShape(a, b, w, MID, seededRandom(a.x * 7 + b.y));
    assert.ok(s.fittsMs >= 300 && s.fittsMs <= 1000, `${s.fittsMs} ms`);
    const f = fittsMs(dist(a, b), w, 250, 110);
    if (f > 300 / 0.6 && f < 1000 / 1.6) ratios.push(s.fittsMs / f); // not clamped
  }
  assert.ok(ratios.length > 500, `${ratios.length} unclamped`);
  const logs = ratios.map(Math.log), m = logs.reduce((x, y) => x + y, 0) / logs.length, sd = Math.sqrt(logs.reduce((x, y) => x + (y - m) ** 2, 0) / logs.length);
  assert.ok(Math.abs(m) < 0.04, `the log's mean ${m}`);
  assert.ok(sd > 0.15 && sd < 0.22, `the log's sd ${sd} (sigma 0.2, bounded at 0.6 and 1.6)`);
  // The bounds: a short move takes 300 ms or more, a long one to a small target 1000 ms or less (before the speed rule's stretch).
  for (let i = 0; i < 100; i++) {
    assert.ok(drawShape({ x: 0, y: 0 }, { x: 3, y: 0 }, 24, MID, seededRandom(i)).fittsMs >= 300);
    assert.ok(drawShape({ x: 0, y: 0 }, { x: 2000, y: 0 }, 4, MID, seededRandom(i)).fittsMs <= 1000);
  }
  // The person's speed scales the time.
  const slow = { ...MID, speed: 1.2 };
  assert.ok(Math.abs(drawShape({ x: 0, y: 0 }, { x: 300, y: 0 }, 24, slow, seededRandom(1)).fittsMs / drawShape({ x: 0, y: 0 }, { x: 300, y: 0 }, 24, MID, seededRandom(1)).fittsMs - 1.2) < 1e-9);
  // A plan's time: Fitts's time (no overshoot: the last sample is within one rate step of it).
  const p = plan({ x: 100, y: 100 }, { x: 400, y: 200 }, 24, 3);
  assert.ok(p.samples.at(-1)!.t <= p.ms + 8 && p.samples.at(-1)!.t > 0.5 * p.ms && p.ms >= 300 && p.ms <= 1000, `${p.ms}`);
});

test("path rule the shape: one main sub-movement with a bell speed along an arc to one side, with a deviation of 2% to 10% of the distance", () => {
  const sides = new Set<number>();
  for (const [a, b] of pairs(200, 7, 150, 480)) {
    const t = buildTrajectory(a, b, drawShape(a, b, 200, MID, seededRandom(a.y * 13 + b.x)), MID);
    const D = dist(a, b), main = t.subs[0];
    assert.equal(main.kind, "main");
    sides.add(t.shape.side);
    // The deviation of the smooth path from the chord.
    let dev = 0;
    for (let k = 0; k <= 200; k++) {
      const p = t.smooth((main.ms * k) / 200);
      dev = Math.max(dev, Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / D);
    }
    const ends = t.shape.ends.reduce((m, e) => Math.max(m, dist(e, { x: 0, y: 0 })), 0);
    assert.ok(dev >= 0.02 * D - 1 - ends && dev <= 0.1 * D + 1 + ends, `deviation ${dev} of ${D}`);
    // A bell: the main's speed rises to one peak and falls (sampled each 4 ms, no tremor).
    const v: number[] = [];
    for (let s = 4; s <= main.ms; s += 4) v.push(dist(t.smooth(s), t.smooth(s - 4)) / 4);
    const top = v.indexOf(Math.max(...v));
    assert.ok(top > 0 && top < v.length - 1, "the peak is inside the move");
    for (let i = 1; i <= top; i++) assert.ok(v[i] >= v[i - 1] - 1e-6, `rises to the peak (${i})`);
    for (let i = top + 1; i < v.length; i++) assert.ok(v[i] <= v[i - 1] + 1e-6, `falls after it (${i})`);
  }
  assert.deepEqual([...sides].sort(), [-1, 1], "both sides");
});

test("path rule end corrections: 0 to 2 corrective sub-movements in the last 10% of the time; each moves the pointer a small way to the target", () => {
  const counts = [0, 0, 0];
  for (const [a, b] of pairs(500, 8, 60, 480)) {
    const t = buildTrajectory(a, b, drawShape(a, b, 24, MID, seededRandom(a.x * 31 + b.y)), MID);
    const corr = t.subs.filter((s) => s.kind === "correction");
    assert.ok(corr.length <= 2);
    counts[corr.length]++;
    for (const c of corr) {
      assert.ok(c.start >= 0.9 * t.ms - 1e-6 && c.start + c.ms <= t.ms + 1e-6, `in the last 10%: ${c.start}..${c.start + c.ms} of ${t.ms}`);
    }
    if (corr.length) {
      const e0 = t.shape.ends[0];
      assert.ok(Math.hypot(e0.x, e0.y) <= Math.max(0.04 * dist(a, b), 1.5 * 24 + 4) * Math.SQRT2 + 1e-6, "a small correction");
    }
    assert.deepEqual(t.at(t.ms + 1), b, "the path ends on the target");
  }
  // The shares of the parameter file: 40%, 40%, 20%.
  assert.ok(counts.every((c, i) => Math.abs(c / 500 - LINUX.path.corrections.counts[i]) < 0.07), `counts ${counts}`);
});

test("path rule the overshoot: only past 500 px, in about 30% of moves, 2% to 8% past the target, then the way back; a path of at most 1500 ms", () => {
  let over = 0, n = 0;
  for (const [a, b] of pairs(600, 9, 40, 1500)) {
    const D = dist(a, b), t = buildTrajectory(a, b, drawShape(a, b, 24, MID, seededRandom(a.x * 17 + b.x)), MID);
    if (D <= 500) { assert.equal(t.shape.overshoot, false, `${D} px: no overshoot`); continue; }
    n++;
    if (!t.shape.overshoot) continue;
    over++;
    // How far past the target along the move's direction the smooth path goes.
    let past = 0;
    for (let k = 0; k <= 400; k++) {
      const p = t.smooth((t.ms * k) / 400);
      past = Math.max(past, ((p.x - b.x) * (b.x - a.x) + (p.y - b.y) * (b.y - a.y)) / D);
    }
    assert.ok(past >= 0.02 * D - 1 && past <= 0.08 * D + 1, `past ${past} of ${D}`);
    assert.deepEqual(t.subs.map((s) => s.kind), ["main", "back"]);
    assert.ok(t.ms <= 1500 + 1e-6, `${t.ms} ms`);
    assert.deepEqual(t.at(t.ms), b);
  }
  assert.ok(n > 150 && Math.abs(over / n - 0.3) < 0.07, `${over} of ${n} moves over 500 px`);
});

test("path rule the jitter: a tremor of 0.3 to 1.2 px across the path at 8 to 12 Hz, faded out at both ends", () => {
  for (const [i, [a, b]] of pairs(40, 10, 300, 700).entries()) {
    const person = personFor(`j${i}`, 3, LINUX), shape = drawShape(a, b, 24, person, seededRandom(i)), t = buildTrajectory(a, b, shape, person);
    // The shape's own values (review-109 B1): the two waves together 0.3 to 1.2 px, each wave at 8 to 12 Hz.
    const total = shape.waves.reduce((s, w) => s + w.px, 0);
    assert.ok(total >= 0.3 - 1e-9 && total <= 1.2 + 1e-9, `the tremor's size ${total}`);
    for (const w of shape.waves) assert.ok(w.hz >= 8 && w.hz <= 12, `a wave at ${w.hz} Hz`);
    const D = dist(a, b), ux = (b.x - a.x) / D, uy = (b.y - a.y) / D;
    const off: number[] = [];
    for (const s of [...Array.from({ length: Math.floor(t.ms) + 1 }, (_, k) => k), t.ms]) {
      const p = t.at(s), q = t.smooth(s), dx = p.x - q.x, dy = p.y - q.y;
      assert.ok(Math.abs(dx * ux + dy * uy) < 1e-9, "across the chord only");
      off.push(-dx * uy + dy * ux);
    }
    const amp = Math.max(...off.map(Math.abs));
    assert.ok(amp > 0 && amp <= 1.2 + 1e-9, `amplitude ${amp}`);
    assert.ok(Math.abs(off[0]) < 1e-9 && Math.abs(off.at(-1)!) < 1e-9, "none at the ends");
    // Its frequency: the zero crossings of the middle part (the main wave, with a smaller one on it).
    const mid = off.slice(Math.round(t.ms * 0.2), Math.round(t.ms * 0.8));
    let cross = 0;
    for (let k = 1; k < mid.length; k++) if (Math.sign(mid[k]) !== Math.sign(mid[k - 1]) && mid[k] !== 0) cross++;
    const hz = cross / 2 / (mid.length / 1000);
    assert.ok(hz >= 6 && hz <= 14, `about ${hz.toFixed(1)} Hz (the person's ${person.tremorHz.toFixed(1)} Hz and another of the band)`);
  }
});

test("path rule the speed: at most 3.5 px/ms between two samples, also on a long move (the plan is stretched in time)", () => {
  for (const [i, [a, b]] of [...pairs(300, 11, 40, 1500), [{ x: 2, y: 2 }, { x: 1918, y: 1078 }] as [Pt, Pt]].entries()) {
    const p = plan(a, b, i % 2 ? 24 : 120, i);
    assert.ok(peakSpeed(a, p.samples) <= 3.5 + 1e-9, `${peakSpeed(a, p.samples)} px/ms`);
  }
  const far = plan({ x: 2, y: 2 }, { x: 1918, y: 1078 }, 24, 2);
  assert.ok(far.ms > 1000, `a 2200 px move takes ${far.ms} ms`);
});

test("path rule the long move: the speed rule wins and the time has no upper bound; an overshoot leg only while the path stays at most 1500 ms", () => {
  let long = 0, back = 0;
  for (let s = 1; s <= 120; s++) {
    // Moves of 2000 to 4400 px (up to a 3840 x 2160 viewport's diagonal), each with its own person.
    const r = seededRandom(9000 + s), person = drawPerson(LINUX, r), D = 2000 + 20 * s, a = { x: 2, y: 2 }, b = { x: 2 + Math.round(D * 0.87), y: 2 + Math.round(D * 0.49) };
    const p = planPath(a, b, 24, person, r);
    assert.ok(peakSpeed(a, p.samples) <= 3.5 + 1e-9, `${D} px: ${peakSpeed(a, p.samples)} px/ms`);
    if (p.ms > 1500) long++;
    if (p.trajectory.subs.some((x) => x.kind === "back")) { back++; assert.ok(p.ms <= 1500 + 1e-6, `${D} px: an overshoot path of ${p.ms} ms`); }
  }
  assert.ok(long > 60, `${long} of 120 long moves take more than 1500 ms`);
  assert.ok(back > 0, "some long moves keep their overshoot");
});

test("path rule the rate: one sample each 8 ms, in whole px, no sample that does not move, the target last", () => {
  for (const [i, [a, b]] of pairs(300, 12, 3, 1500).entries()) {
    const p = plan(a, b, 24, i);
    let prev: Pt = a;
    for (const s of p.samples) {
      assert.ok(Number.isInteger(s.x) && Number.isInteger(s.y), "whole px");
      assert.ok(s.t > 0 && s.t % 8 === 0, `on the 8 ms grid: ${s.t}`);
      assert.ok(s.x !== prev.x || s.y !== prev.y, "a sample that does not move");
      prev = s;
    }
    assert.deepEqual({ x: prev.x, y: prev.y }, b, "the target last");
    for (let k = 1; k < p.samples.length; k++) assert.ok(p.samples[k].t > p.samples[k - 1].t);
    if (dist(a, b) > 200) assert.ok(p.samples.filter((x, k) => k > 0 && x.t - p.samples[k - 1].t === 8).length > p.samples.length / 2, "most samples 8 ms apart");
  }
  assert.deepEqual(plan({ x: 5, y: 5 }, { x: 5.3, y: 4.8 }).samples, [], "a move of less than 1 px: nothing");
  const half = planPath({ x: 10.4, y: 10.6 }, { x: 300.5, y: 200.5 }, 24, MID, seededRandom(1));
  assert.deepEqual([half.samples.at(-1)!.x, half.samples.at(-1)!.y], [301, 201], "Playwright's fractional point, rounded");
});

/** The click box's frame (the recorder's #box: 300 x 65 at 480, 96) and its 24 px square at 16, 20 inside it. */
const FRAME = { x: 480, y: 96, w: 300, h: 65 }, SQUARE = { x: FRAME.x + 28, y: FRAME.y + 32 };
const inFrame = (p: Pt) => p.x >= FRAME.x && p.x < FRAME.x + FRAME.w && p.y >= FRAME.y && p.y < FRAME.y + FRAME.h;

test("path rule the approach to a small target: the speed falls in the last part; a 24 px square in a 300 x 65 frame gets an entry at its edge and 8 or more samples inside", () => {
  // The last 10% of the main's way takes a larger share of its time for a small target than for a large one.
  const tail = (w: number) => {
    const shares: number[] = [];
    for (const [a, b] of pairs(150, 13, 200, 480)) {
      const s = drawShape(a, b, w, { ...MID, overshootShare: 0 }, seededRandom(a.x + b.y));
      const t = buildTrajectory(a, b, { ...s, ends: [] }, MID), D = dist(a, b);
      let k = 0;
      while (k < t.ms && dist(t.smooth(k), b) > 0.1 * D) k++;
      shares.push(1 - k / t.ms);
    }
    return median(shares);
  };
  const small = tail(24), large = tail(200);
  assert.ok(small > 0.3 && small > large + 0.04, `the last 10% of the way: ${small.toFixed(3)} of the time (small), ${large.toFixed(3)} (large)`);
  // The box: from points of the page outside the frame, 150 to 700 px away.
  const r = seededRandom(14), inside: number[] = [], edges: number[] = [];
  while (inside.length < 200) {
    const a = { x: 40 + Math.floor(r() * 1200), y: 200 + Math.floor(r() * 650) };
    if (dist(a, SQUARE) < 150 || dist(a, SQUARE) > 700) continue;
    const s = plan(a, SQUARE, 24, inside.length + 100).samples, first = s.findIndex(inFrame);
    assert.ok(first > 0, "the path enters the frame");
    const e = s[first];
    edges.push(Math.min(e.x - FRAME.x, e.y - FRAME.y, FRAME.x + FRAME.w - 1 - e.x, FRAME.y + FRAME.h - 1 - e.y));
    inside.push(s.slice(first).filter(inFrame).length);
  }
  assert.ok(quantile(edges, 0.9) <= 10, `the entry at the frame's edge: 90% within ${quantile(edges, 0.9)} px`);
  // Design 10.1 says 8 to 20 samples inside; with its own first values (Fitts's time and the minimum-jerk slow-down) the
  // median is about 24 and the 90% value about 46 (31 with no overshoot). This test holds the low end only; part B's
  // recording sets the upper end (board ab-t30.13; review-109 B2).
  assert.ok(quantile(inside, 0.1) >= 8, `samples inside: 10% below ${quantile(inside, 0.1)}, median ${median(inside)}`);
});

test("path: the same seed gives the same plan, another seed another; a plan never depends on a clock", () => {
  const a = { x: 100, y: 700 }, b = { x: 900, y: 300 };
  assert.deepEqual(plan(a, b, 24, 5).samples, plan(a, b, 24, 5).samples);
  assert.notDeepEqual(plan(a, b, 24, 5).samples, plan(a, b, 24, 6).samples);
  assert.notDeepEqual(plan(a, b, 24, 5, personFor("s-a", 1, LINUX)).samples, plan(a, b, 24, 5, personFor("s-b", 1, LINUX)).samples, "two people, two paths");
});

// ================================================================ the press (design 6.2 and 10.1)

test("press rule the pause before a press: a lognormal, median 140 ms, from 80 to 400 ms; a caller's range takes the place of the bounds", () => {
  const r = seededRandom(20), v = Array.from({ length: 3000 }, () => pauseMs(MID, r));
  assert.ok(v.every((x) => x >= 80 && x <= 400));
  assert.ok(Math.abs(median(v) - 140) < 6, `median ${median(v)}`);
  assert.ok(quantile(v, 0.1) < 105 && quantile(v, 0.9) > 220, "a lognormal's spread (bounded at 80 and 400)");
  const slow = Array.from({ length: 2000 }, () => pauseMs({ ...MID, pause: 1.3 }, r));
  assert.ok(Math.abs(median(slow) - 182) < 9, `the person's factor: ${median(slow)}`);
  assert.ok(Array.from({ length: 50 }, () => pauseMs(MID, r, [1, 3])).every((x) => x >= 1 && x <= 3));
});

test("press rule the hold: a lognormal, median 100 ms, from 60 to 180 ms; force 0.5", () => {
  const r = seededRandom(21), v = Array.from({ length: 3000 }, () => holdMs(MID, r));
  assert.ok(v.every((x) => x >= 60 && x <= 180));
  assert.ok(Math.abs(median(v) - 100) < 4, `median ${median(v)}`);
  assert.ok(quantile(v, 0.1) < 75 && quantile(v, 0.9) > 130);
  assert.equal(force(MID), 0.5);
  assert.ok(Array.from({ length: 50 }, () => holdMs(MID, r, [150, 160])).every((x) => x >= 150 && x <= 160));
});

test("press rule the double click's gap: 90 to 150 ms from the first release to the second press", () => {
  const r = seededRandom(22), v = Array.from({ length: 1000 }, () => doubleClickGapMs(MID, r));
  assert.ok(v.every((x) => x >= 90 && x <= 150) && Math.min(...v) < 95 && Math.max(...v) > 145);
});

test("press rule the spread point: an offset from the middle with a standard deviation of 1/8 of the smaller side, at most 1/4 of it, in whole px", () => {
  const r = seededRandom(23), box = { x: 40, y: 220, w: 120, h: 40 }, cx = 100, cy = 240;
  const pts = Array.from({ length: 3000 }, () => spreadPoint(box, MID, r));
  const dx = pts.map((p) => p.x - cx), dy = pts.map((p) => p.y - cy);
  assert.ok(pts.every((p) => Number.isInteger(p.x) && Number.isInteger(p.y) && Math.hypot(p.x - cx, p.y - cy) <= 10 + 1e-9), "at most 40 / 4 px from the middle");
  const sd = (a: number[]) => Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length);
  assert.ok(Math.abs(sd(dx) - 5) < 0.6 && Math.abs(sd(dy) - 5) < 0.6, `sd ${sd(dx)}, ${sd(dy)} (40 / 8 = 5)`);
  assert.ok(new Set(pts.map((p) => `${p.x},${p.y}`)).size > 100, "spread");
});

/** A locator click on a button, at the middle of its quad, whose hit test agrees: every condition holds. */
const CASE: PressCase = { point: { x: 100, y: 240 }, locatorClick: true, clickCount: 1, quad: { x: 40, y: 220, w: 120, h: 40 }, element: { tag: "button" }, sameElementAt: () => true };
async function spreadShare(c: PressCase): Promise<number> {
  const r = seededRandom(24);
  let n = 0;
  for (let i = 0; i < 100; i++) { const p = await pressPoint(c, MID, r); if (p.spread) n++; else assert.deepEqual(p.point, { x: Math.round(c.point.x), y: Math.round(c.point.y) }); }
  return n / 100;
}

test("press rule the press point's condition 1: only a locator click with clickCount 1, never a dblclick's or a triple click's press, nor mouse.click", async () => {
  assert.equal(await spreadShare(CASE), 1, "every condition holds: the spread point");
  assert.equal(await spreadShare({ ...CASE, locatorClick: false }), 0, "mouse.click: no hit-target setup");
  assert.equal(await spreadShare({ ...CASE, clickCount: 2 }), 0);
  assert.equal(await spreadShare({ ...CASE, multiClick: true }), 0, "the first press of a dblclick");
});

test("press rule the press point's condition 2: no position: the client's point within 1 px of the quad's middle", async () => {
  assert.equal(atMiddle({ x: 100.9, y: 239.1 }, CASE.quad!), true);
  assert.equal(await spreadShare({ ...CASE, point: { x: 101, y: 241 } }), 1);
  assert.equal(await spreadShare({ ...CASE, point: { x: 60.5, y: 240 } }), 0, "click({ position }): the client's point, rounded");
  assert.equal(await spreadShare({ ...CASE, quad: null }), 0, "no quad seen");
});

test("press rule the press point's condition 3: only an element whose effect does not depend on the point", async () => {
  for (const el of [{ tag: "button" }, { tag: "A", href: true }, { tag: "input", type: "checkbox" }, { tag: "input", type: "SUBMIT" }, { tag: "label" }, { tag: "summary" },
    { tag: "div", role: "button" }, { tag: "span", role: "menuitem" }, { tag: "div", role: "switch" }]) assert.equal(pointFree(el), true, JSON.stringify(el));
  for (const el of [{ tag: "canvas" }, { tag: "img", usemap: true }, { tag: "svg" }, { tag: "video" }, { tag: "input" }, { tag: "input", type: "range" }, { tag: "textarea" },
    { tag: "div", editable: true }, { tag: "div", role: "button", editable: true }, { tag: "a" }, { tag: "div" }, { tag: "canvas", role: "button" }]) assert.equal(pointFree(el), false, JSON.stringify(el));
  assert.equal(await spreadShare({ ...CASE, element: { tag: "input", type: "range" } }), 0, "a range input");
  assert.equal(await spreadShare({ ...CASE, element: { tag: "canvas" } }), 0);
  assert.equal(await spreadShare({ ...CASE, element: null }), 0);
});

test("press rule the press point's condition 4: the hit test at the spread point gives the same element, else the client's point", async () => {
  const seen: Pt[] = [];
  const edge = { ...CASE, sameElementAt: (p: Pt) => { seen.push(p); return p.x <= 100; } };
  const share = await spreadShare(edge);
  assert.ok(share > 0.2 && share < 0.8, `only the spread points that the hit test passes: ${share}`);
  assert.equal(seen.length, 100, "one hit test for each spread point");
  assert.equal(await spreadShare({ ...CASE, sameElementAt: async () => false }), 0);
});

// ================================================================ the wheel (design 8.2, C11)

test("wheel rule the notch: 120 px; the count rounds half up; a small call gets one notch; a call of 0 none", () => {
  assert.deepEqual(notches(600, 0, 120), { count: 5, residual: 0 });
  assert.deepEqual(notches(-600, 0, 120), { count: -5, residual: 0 });
  assert.deepEqual(notches(180, 0, 120), { count: 2, residual: -60 }, "1.5 rounds up");
  assert.deepEqual(notches(10, 0, 120), { count: 1, residual: -110 }, "a call whose delta is not 0 gets a wheel event");
  assert.deepEqual(notches(0, 30, 120), { count: 0, residual: 30 });
  assert.deepEqual(notches(10, -110, 120), { count: 0, residual: -100 }, "earlier notches already gave it");
  const w = new Wheel(LINUX.wheel.notchPx);
  assert.deepEqual(w.take(0, 300), { x: 0, y: 3 });
  assert.deepEqual([w.x, w.y], [0, -60]);
});

test("wheel rule the residual: ten calls of 100 px scroll the total within one notch; a series in both directions too", () => {
  const w = new Wheel(120);
  let total = 0;
  for (let i = 0; i < 10; i++) total += w.take(0, 100).y * 120;
  assert.ok(Math.abs(total - 1000) <= 120, `${total} px for 1000`);
  const r = seededRandom(25), v = new Wheel(120);
  let asked = 0, given = 0;
  for (let i = 0; i < 300; i++) {
    const d = Math.round((r() - 0.4) * 400);
    asked += d;
    given += v.take(d, 0).x * 120;
    assert.ok(Math.abs(asked - given) <= 120, `after ${i + 1} calls: ${given} for ${asked}`);
  }
});

test("wheel rule the gaps: 35 to 90 ms between notches; the vertical axis first", () => {
  const r = seededRandom(26), gaps = Array.from({ length: 500 }, () => notchGapMs(MID, r));
  assert.ok(gaps.every((g) => g >= 35 && g <= 90) && Math.min(...gaps) < 40 && Math.max(...gaps) > 85);
  const p = wheelPlan({ x: -1, y: 3 }, MID, r);
  assert.deepEqual(p.map((e) => [e.dx, e.dy]), [[0, 120], [0, 120], [0, 120], [-120, 0]]);
  assert.equal(p[0].t, 0);
  for (let i = 1; i < p.length; i++) assert.ok(p[i].t - p[i - 1].t >= 35 && p[i].t - p[i - 1].t <= 90);
});

// ================================================================ the players (design 4.6, 11.1)

/** A fake clock: sleep(ms) moves the time on, timer by timer, after the promises of the moment settle. */
class FakeClock implements Clock {
  t = 0;
  private timers: { at: number; seq: number; r: () => void }[] = [];
  private seq = 0;
  private running = false;
  now = () => this.t;
  sleep = (ms: number) => new Promise<void>((r) => { this.timers.push({ at: this.t + Math.max(0, ms), seq: this.seq++, r }); this.kick(); });
  private kick() { if (!this.running) { this.running = true; setImmediate(() => this.run()); } }
  private run() {
    if (!this.timers.length) { this.running = false; return; }
    this.timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
    const x = this.timers.shift()!;
    this.t = Math.max(this.t, x.at);
    x.r();
    setImmediate(() => this.run());
  }
}
/** A fake send whose answers come `answerMs` later (a refusal for the `fail`th call), with the time of each send. */
function fakeSend(clock: FakeClock, answerMs: number, fail?: number) {
  const calls: { t: number; method: string; params: Record<string, any> }[] = [];
  let inFlight = 0, most = 0;
  const send = async (method: string, params: Record<string, unknown>) => {
    calls.push({ t: clock.now(), method, params: params as Record<string, any> });
    const n = calls.length;
    most = Math.max(most, ++inFlight);
    await clock.sleep(answerMs);
    inFlight--;
    if (n === fail) throw new Error("refused");
    return {};
  };
  return { send, calls, most: () => most };
}
const grid = (n: number, step = 8): Sample[] => Array.from({ length: n }, (_, i) => ({ x: 10 + i, y: 20, t: (i + 1) * step }));
const player = (send: (m: string, p: Record<string, unknown>) => Promise<unknown>, clock: Clock, extra: Partial<ConstructorParameters<typeof CdpPlayer>[1]> = {}) =>
  new CdpPlayer(send, { clock, stamp: () => 1_000_000 + clock.now(), latencyMs: [3, 5], wholeMs: true, random: seededRandom(30), maxInFlight: 8, ...extra });

test("cdp player rule the rate: each move goes at its time, none awaited before the next, so moves wait for their answers together", async () => {
  const clock = new FakeClock(), f = fakeSend(clock, 20);
  const r = await player(f.send, clock).moves(grid(10));
  assert.deepEqual(r, { sent: 10, stopped: false });
  assert.deepEqual(f.calls.map((c) => c.t), [8, 16, 24, 32, 40, 48, 56, 64, 72, 80], "each at its planned time, not after the answer before it");
  assert.ok(f.most() >= 3, `${f.most()} moves waited for their answers at once`);
  assert.ok(f.calls.every((c) => c.method === "Input.dispatchMouseEvent" && c.params.type === "mouseMoved" && c.params.button === "none" && c.params.buttons === 0));
  assert.ok(clock.now() >= 100, "it returns after the last answer");
});

test("cdp player rule the timestamps: a latency of 3 to 5 ms before the send, in whole ms on Linux, with its fraction on the Mac; from the send, never from the plan", async () => {
  const clock = new FakeClock(), f = fakeSend(clock, 1);
  await player(f.send, clock).moves([{ x: 1, y: 1, t: 8 }, { x: 2, y: 1, t: 400 }, { x: 3, y: 1, t: 408 }]);
  for (const c of f.calls) {
    const ms = c.params.timestamp * 1000, sentAt = 1_000_000 + c.t;
    assert.ok(Number.isInteger(Math.round(ms * 1000) / 1000) && Math.abs(ms - Math.round(ms)) < 1e-6, `whole ms: ${ms}`);
    assert.ok(sentAt - ms >= 2.5 && sentAt - ms <= 5.5, `the latency: ${sentAt - ms} ms`);
  }
  // One latency for the moves of one plan (a device's latency over one path); a measurement can ask for one for each move.
  const lags = (calls: { t: number; params: Record<string, any> }[]) => new Set(calls.map((c) => Math.round(1_000_000 + c.t - c.params.timestamp * 1000)));
  assert.equal(lags(f.calls).size, 1, "one latency for the plan");
  const per = new FakeClock(), q = fakeSend(per, 1);
  await player(q.send, per, { latencyPerEvent: true, random: seededRandom(9) }).moves(grid(20));
  assert.ok(lags(q.calls).size >= 2, "one latency for each move");
  // A send that comes late (a busy event loop) gets the time of its send.
  const late = new FakeClock(), g = fakeSend(late, 1);
  const p = new CdpPlayer(g.send, { clock: late, stamp: () => 1_000_000 + late.now() + 50, latencyMs: [3, 5], wholeMs: true, random: seededRandom(1), maxInFlight: 8 });
  await p.moves([{ x: 1, y: 1, t: 8 }]);
  assert.ok(g.calls[0].params.timestamp * 1000 > 1_000_000 + 8 + 40, "the time of the send, not of the plan");
  const mac = new FakeClock(), h = fakeSend(mac, 1);
  await new CdpPlayer(h.send, { clock: mac, stamp: () => 1_000_000.37 + mac.now(), latencyMs: [3, 5], wholeMs: false, random: seededRandom(2), maxInFlight: 8 }).moves(grid(5));
  assert.ok(h.calls.some((c) => Math.abs(c.params.timestamp * 1000 - Math.round(c.params.timestamp * 1000)) > 0.01), "the Mac keeps the fraction");
  const one = new FakeClock(), k = fakeSend(one, 1);
  await player(k.send, one).event("Input.dispatchMouseEvent", { type: "mousePressed", x: 1, y: 1 });
  assert.ok(typeof k.calls[0].params.timestamp === "number", "a single event gets its timestamp too");
});

test("cdp player rule the in-flight bound: at most 8 moves without an answer; a move due while 8 wait stops the path", async () => {
  const clock = new FakeClock(), f = fakeSend(clock, 10_000);
  const r = await player(f.send, clock).moves(grid(20));
  assert.deepEqual(r, { sent: 8, stopped: true });
  assert.equal(f.calls.length, 8);
  assert.ok(clock.now() < 1000, "it does not wait for the answers of a page that answers none");
});

test("cdp player: an error of a move stops the plan; a throw of the check before a send stops it after the moves in flight answered", async () => {
  const clock = new FakeClock(), f = fakeSend(clock, 20, 2);
  await assert.rejects(player(f.send, clock).moves(grid(10)), /refused/);
  assert.ok(f.calls.length <= 4, `${f.calls.length} moves: none after the refusal's answer`);
  const c2 = new FakeClock(), g = fakeSend(c2, 20);
  let n = 0;
  await assert.rejects(player(g.send, c2, { before: () => { if (++n === 4) throw new Error("off the list"); } }).moves(grid(10)), /off the list/);
  assert.equal(g.calls.length, 3);
  assert.ok(c2.now() >= 24 + 20, "the moves in flight answered first");
});

test("cdp player: the scale of the plan's times, and the least gap between two sends", async () => {
  const clock = new FakeClock(), f = fakeSend(clock, 1);
  await player(f.send, clock, { scale: 0.05, minGapMs: 2 }).moves(grid(5));
  assert.deepEqual(f.calls.map((c) => c.t), [0.4, 2.4, 4.4, 6.4, 8.4]);
  const c2 = new FakeClock(), g = fakeSend(c2, 1);
  await player(g.send, c2, { scale: 0.5 }).moves(grid(3));
  assert.deepEqual(g.calls.map((c) => c.t), [4, 8, 12]);
});

test("x player: one point is one xdotool move; a path is one xdotool script with a sleep to each sample's time", async () => {
  const runs: [string[], string | undefined][] = [];
  const run = async (args: string[], input?: string) => { runs.push([args, input]); return ""; };
  const screen = (p: Pt) => ({ x: p.x + 100, y: p.y + 87 });
  await playX(run, [{ x: 5, y: 6, t: 8 }], screen);
  await playX(run, [{ x: 5, y: 6, t: 16 }, { x: 7, y: 6, t: 32 }, { x: 8, y: 7, t: 40 }], screen);
  await playX(run, [], screen);
  assert.deepEqual(runs[0], [["mousemove", "105", "93"], undefined]);
  assert.deepEqual(runs[1], [["-"], "sleep 0.016\nmousemove 105 93\nsleep 0.016\nmousemove 107 93\nsleep 0.008\nmousemove 108 94\n"]);
  assert.equal(runs.length, 2);
  assert.equal(xScript([{ x: 1, y: 1, t: 8 }], (p) => p, 2), "sleep 0.016\nmousemove 1 1\n");
});
