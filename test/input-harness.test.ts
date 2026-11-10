// The input harness (board ab-t30.2; design 2026-11-10-vanilla-playwright-human-input-design.md, section 13.3): its
// statistics, the measures of one step from the recorder's records, the reference file (numbers only), the bar of each
// gap and the report. No browser: the live run is test/live/input-harness/run.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  binomialZ, fittsMs, isWholeMs, ks1, ks2, ksBound, ksCdf, ksCritical, lognormalCdf, lognormalOf, mean, median, normalCdf, pathShape, speedPeaks, wholeMsChance, wholeMsShare, type Sample,
} from "./live/input-harness/stats.ts";
import {
  activationJumps, boxMeasures, focusinWithNoPress, keyMeasures, lostBatches, measureStep, pointerMeasures, samplesOf, stepRecords, textMeasures, wheelMeasures,
  type KeyMeasures, type PathMeasures, type PointerMeasures, type Rec, type StepMeasures, type TextMeasures,
} from "./live/input-harness/measures.ts";
import { buildReference, checkReference, LITERATURE, type Reference } from "./live/input-harness/reference.ts";
import { band, compareDist, scoreSource, textTable, type Row } from "./live/input-harness/score.ts";
import { Cleanup } from "./live/input-harness/cleanup.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const near = (a: number | null | undefined, b: number, eps = 1e-3) => assert.ok(a !== null && a !== undefined && Math.abs(a - b) <= eps, `${a} is not ${b} (within ${eps})`);
const FIXTURE = JSON.parse(readFileSync(new URL("./live/input-harness/reference.fixture.json", import.meta.url), "utf8"));
/** The fixture's reference with an edit. */
const refWith = (edit: (r: any) => void = () => {}): Reference => { const r = structuredClone(FIXTURE); edit(r); return checkReference(r); };

// ---------------------------------------------------------------- the records of a page, as recorder.html logs them
const ev = (e: string, t: number, extra: Record<string, unknown> = {}): Rec => ({ e, f: "top", t, h: t + 1, tr: 1, ...extra });
const key = (e: "keydown" | "keyup", t: number, k: string, extra: Record<string, unknown> = {}): Rec =>
  ev(e, t, { k, c: k.length === 1 ? `Key${k.toUpperCase()}` : k, m: 0, nl: 0, r: 0, ...extra });
const line = (n: number, x0: number, y0: number, dx: number, t0 = 1000): Sample[] => Array.from({ length: n }, (_, i) => ({ t: t0 + i * 8, x: x0 + i * dx, y: y0 }));
/** Pointermoves of `perMove` samples each (the event's point is its last sample), with a handler `lag` ms after the event. */
function movesOf(pts: Sample[], o: { perMove?: number; lag?: number; np?: number; f?: string; bs?: number } = {}): Rec[] {
  const per = o.perMove ?? 2, out: Rec[] = [];
  let prev: Sample | undefined;
  for (let i = 0; i < pts.length; i += per) {
    const g = pts.slice(i, i + per), last = g[g.length - 1];
    out.push({ e: "pointermove", f: o.f ?? "top", t: last.t, h: last.t + (o.lag ?? 5), tr: 1, x: last.x, y: last.y, sx: last.x, sy: last.y + 100,
      mx: prev ? last.x - prev.x : 0, my: prev ? last.y - prev.y : 0, nc: g.length, np: o.np ?? 2, co: g.map((s) => [s.t - last.t, s.x, s.y]), bs: o.bs ?? 0 });
    prev = last;
  }
  return out;
}

// ---------------------------------------------------------------- the measures of a step, as measureStep gives them
const pathM = (o: Partial<PathMeasures> = {}): PathMeasures =>
  ({ samples: 100, ms: 900, lengthPx: 800, chordPx: 700, straightness: 0.85, maxDeviationPx: 60, peakPxPerMs: 2, meanPxPerMs: 0.9, speedPeaks: 1, fittsRatio: 1.5, ...o });
function stepM(o: Omit<Partial<StepMeasures>, "pointer"> & { pointer?: Partial<PointerMeasures> | null } = {}): StepMeasures {
  const pointer: PointerMeasures | null = o.pointer === null ? null : {
    moves: 60, samplesPerMove: 1.9, predictedPerMove: 1.9, sampleGaps: 100, wholeMsGaps: 100, wholeMsShare: 1, eventsAfterHandler: 0, handlerLagMs: 5,
    fractional: 0, jumps: 0, movementMismatch: 0, path: null, pauseMs: null, pressMs: null, focusInPress: null, doubleClickGapMs: null, modifierLeadMs: null,
    modifierLagMs: null, heldMoves: null, ...(o.pointer ?? {}) };
  return { name: "s", source: "x", kind: "click", ok: true, ms: 1000, box: null, keys: null, text: null, wheel: null, focusinWithNoPress: 0, untrusted: 0, touch: 0,
    idleMovesPerS: null, events: 50, activationJumps: [], ...o, pointer };
}
/** The z values of the quantiles (i + 0.5) / 12 of a normal: a sample that a model's KS test passes. */
const Z12 = [-1.732, -1.15, -0.812, -0.548, -0.319, -0.105, 0.105, 0.319, 0.548, 0.812, 1.15, 1.732];
const keysM = (o: Partial<KeyMeasures> = {}): KeyMeasures => ({ keys: 13, holds: Z12.map((z) => 116 + 24 * z), downToDown: Z12.map((z) => 216.4 * Math.exp(0.446 * z)),
  wordEndExtraMs: 100, overlaps: 4, overlapShare: 4 / 12, shiftedChars: 4, shiftedWithShiftDown: 4, numLockOn: 0, backspaces: 0, pairs: {}, ...o });
const textM = (o: Partial<TextMeasures> = {}): TextMeasures => ({ inputs: 16, chars: 16, keyChars: 16, keyEventsPerChar: 1, textsWithNoKeys: 0, longTextsWithNoKeys: 0, ...o });
const rowOf = (rows: Row[], gap: string, measure: RegExp): Row => {
  const r = rows.find((x) => x.gap === gap && measure.test(x.measure));
  assert.ok(r, `no row ${gap} ${measure}`);
  return r;
};
const verdict = (rows: Row[], gap: string, measure: RegExp) => rowOf(rows, gap, measure).verdict;

// ================================================================ statistics

test("median and mean", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), null);
  assert.equal(mean([1, 2, 3]), 2);
  assert.equal(mean([]), null);
});

test("ks2: the two-sample Kolmogorov-Smirnov statistic", () => {
  assert.equal(ks2([1, 2, 3], [1, 2, 3]), 0);
  assert.equal(ks2([1, 2, 3], [10, 11, 12]), 1);
  assert.equal(ks2([1, 2, 3, 4], [3, 4, 5, 6]), 0.5);
  assert.equal(ks2([], [1]), null);
});

test("ks1 against a model's CDF, and the bound of a KS statistic at 5%", () => {
  near(ks1([0.1, 0.3, 0.5, 0.7, 0.9], (x) => x), 0.1);
  near(ks1([0, 0, 0], (x) => Math.min(1, Math.max(0, x))), 1);
  near(ks1([1, 1, 1], (x) => Math.min(1, Math.max(0, x))), 1, 1e-9);
  assert.equal(ks1([], (x) => x), null);
  near(ksBound(16), 0.327, 0.002); // exact for n up to 35 (Miller's table: 0.32733)
  near(ksBound(8, 8), 0.679);
});

test("the normal and the lognormal CDF, and a lognormal from a mean and a standard deviation", () => {
  near(normalCdf(116, 116, 24), 0.5);
  near(normalCdf(140, 116, 24), 0.8413);
  near(normalCdf(92, 116, 24), 0.1587);
  near(lognormalCdf(140, 140, 0.4), 0.5);
  near(lognormalCdf(140 * Math.exp(0.4), 140, 0.4), 0.8413);
  assert.equal(lognormalCdf(0, 140, 0.4), 0);
  const [m, s] = lognormalOf(239, 112);
  near(m, 216.4, 0.1);
  near(s, 0.4456);
});

test("whole-ms sample gaps: the share, and its chance rate on the page's clock of 0.1 ms", () => {
  assert.equal(isWholeMs(8.1), true);
  assert.equal(isWholeMs(8.2), false);
  assert.equal(isWholeMs(7.86), true);
  assert.equal(isWholeMs(7.84), false);
  near(wholeMsShare([8, 8.1, 7.9, 8.05, 8.2]), 0.8);
  assert.equal(wholeMsShare([]), null);
  near(wholeMsChance(), 0.3);
  near(wholeMsChance(0.01), 0.31);
  near(binomialZ(30, 100, 0.3), 0);
  near(binomialZ(100, 100, 0.3), 15.275, 0.01);
  assert.equal(binomialZ(0, 0, 0.3), null);
});

test("the path's shape: straightness, maximum deviation, peak and mean speed", () => {
  const s = pathShape(line(11, 0, 0, 10, 0))!;
  assert.deepEqual([s.samples, s.ms, s.lengthPx, s.chordPx, s.straightness, s.maxDeviationPx], [11, 80, 100, 100, 1, 0]);
  near(s.peakPxPerMs, 1.25);
  near(s.meanPxPerMs, 1.25);
  const l = pathShape([{ t: 0, x: 0, y: 0 }, { t: 8, x: 30, y: 0 }, { t: 16, x: 30, y: 40 }])!;
  near(l.straightness, 50 / 70);
  near(l.maxDeviationPx, 24);
  assert.equal(pathShape(line(2, 0, 0, 10)), null);
});

test("speed peaks: one for a bell, two for two bells, one for a bell with a small ripple and for a constant speed", () => {
  // A minimum-jerk move: x(s) = D (10 s^3 - 15 s^4 + 6 s^5), one sample each 8 ms.
  const bell = (n: number, d: number, t0 = 0, x0 = 0): Sample[] => Array.from({ length: n + 1 }, (_, i) => { const s = i / n; return { t: t0 + i * 8, x: x0 + d * (10 * s ** 3 - 15 * s ** 4 + 6 * s ** 5), y: 0 }; });
  assert.equal(speedPeaks(bell(100, 800)), 1);
  const a = bell(60, 500);
  assert.equal(speedPeaks([...a, ...bell(60, 300, a[a.length - 1].t + 8, 500)]), 2);
  assert.equal(speedPeaks(bell(100, 800).map((p, i) => ({ ...p, x: p.x + (i % 2 ? 0.3 : -0.3) }))), 1);
  const flat = Array.from({ length: 30 }, (_, i) => ({ t: i * 16, x: i * 37, y: 0 }));
  assert.equal(speedPeaks(flat), 1);
  assert.equal(speedPeaks(flat.slice(0, 2)), 0);
});

test("Fitts's time: a + b log2(1 + D / W), not clamped", () => {
  assert.equal(fittsMs(0, 24), 250);
  assert.equal(fittsMs(72, 24), 470);
});

// ================================================================ the measures of a step

test("pointer measures: samples and predicted points per pointermove, whole-ms gaps, the frame phase, the pause, the press and the focus", () => {
  const moves = movesOf(line(6, 100, 200, 10), { perMove: 2, np: 3 });
  moves[1].np = 0;
  moves[0].h = moves[0].t + 4;
  moves[1].h = moves[1].t + 6;
  const down = ev("pointerdown", 1190, { x: 150, y: 200, tg: "#b" }), up = ev("pointerup", 1280, { x: 150, y: 200, tg: "#b" });
  const p = pointerMeasures([...moves, down, ev("focus", 1192, { tg: "#b" }), up], 40)!;
  near(p.samplesPerMove, 2);
  near(p.predictedPerMove, 2);
  assert.deepEqual([p.moves, p.sampleGaps, p.wholeMsGaps, p.wholeMsShare, p.handlerLagMs], [3, 5, 5, 1, 5]);
  assert.deepEqual([p.pauseMs, p.pressMs, p.focusInPress], [150, 90, true]);
  assert.deepEqual([p.fractional, p.jumps, p.movementMismatch, p.eventsAfterHandler], [0, 0, 0, 0]);
  assert.deepEqual([p.path!.samples, p.path!.straightness], [6, 1]);
  near(p.path!.fittsRatio, 40 / fittsMs(50, 40));
  assert.equal(pointerMeasures([...moves, down, up, ev("focus", 1285, { tg: "#b" })])!.focusInPress, false);
  assert.equal(pointerMeasures([...moves, down, up])!.focusInPress, null);
  assert.equal(pointerMeasures([...moves])!.path!.fittsRatio, null, "no target width: no Fitts ratio");
  assert.equal(pointerMeasures([ev("click", 5)]), null);
});

test("pointer measures: fractional points, jumps over 100 px, a movement that does not match the point, an event later than its handler", () => {
  const m = movesOf(line(4, 100, 200, 10), { perMove: 1 });
  m[1] = { ...m[1], x: 110.5, co: [[0, 110.5, 200]] };
  m[2] = { ...m[2], mx: 150 };
  m[3] = { ...m[3], h: m[3].t - 2 };
  const p = pointerMeasures(m)!;
  assert.deepEqual([p.fractional, p.jumps, p.movementMismatch, p.eventsAfterHandler], [2, 1, 1, 1]);
  assert.deepEqual(samplesOf(m).map((s) => s.x), [100, 110.5, 120, 130]);
  // The pointer leaves the top page for the box and comes back: the first move after each entry has movement 0.
  const reentry = [...movesOf(line(2, 100, 200, 10), { perMove: 1 }), ...movesOf(line(2, 3, 30, 4, 1016), { perMove: 1, f: "box" }), ...movesOf(line(2, 400, 200, 10, 1032), { perMove: 1 })];
  assert.equal(pointerMeasures(reentry)!.movementMismatch, 0);
  const late = pointerMeasures(movesOf(line(4, 0, 0, 5).map((s, i) => ({ ...s, t: s.t + i * 0.37 })), { perMove: 1 }))!;
  assert.deepEqual([late.sampleGaps, late.wholeMsGaps, late.wholeMsShare], [3, 0, 0], "gaps of 8.37 ms are not on a whole ms");
});

test("pointer measures: a double click's gap, the modifier's hold around the press, and the moves with the button down before a drop", () => {
  const m = movesOf(line(3, 100, 200, 10));
  const dbl = pointerMeasures([...m, ev("pointerdown", 1100), ev("pointerup", 1190), ev("pointerdown", 1310), ev("pointerup", 1400)])!;
  assert.deepEqual([dbl.doubleClickGapMs, dbl.modifierLeadMs, dbl.modifierLagMs, dbl.heldMoves], [120, null, null, 0]);
  const mod = pointerMeasures([key("keydown", 990, "Shift"), ...m, ev("pointerdown", 1100), ev("pointerup", 1190), key("keyup", 1220, "Shift")])!;
  assert.deepEqual([mod.modifierLeadMs, mod.modifierLagMs, mod.doubleClickGapMs], [110, 30, null]);
  const drag = pointerMeasures([...m, ev("pointerdown", 1200), ...movesOf(line(4, 300, 300, 5, 1210), { perMove: 1, bs: 1 }), ev("drop", 1260),
    ...movesOf(line(2, 400, 300, 5, 1270), { perMove: 1, bs: 1 }), ev("pointerup", 1300)])!;
  assert.equal(drag.heldMoves, 4);
  assert.equal(pointerMeasures(m)!.heldMoves, null);
});

test("a step's records (its window) and its measures: idle moves, untrusted and touch events", () => {
  const all = [ev("pointermove", 940), ...movesOf(line(4, 10, 10, 3, 1000)), ev("click", 1500, { tr: 0 }), ev("touchstart", 1600), ev("pointermove", 2700)];
  assert.equal(stepRecords(all, { t0: 1000, t1: 2000 }).length, 4);
  const s = measureStep(all, { name: "idle 1 s", source: "x", kind: "idle", ok: true, t0: 1000, t1: 2000 });
  assert.deepEqual([s.name, s.source, s.kind, s.ok, s.ms, s.untrusted, s.touch], ["idle 1 s", "x", "idle", true, 1000, 1, 1]);
  near(s.idleMovesPerS, 2);
  assert.equal(measureStep(all, { name: "c", source: "x", kind: "click", ok: true, t0: 1000, t1: 2000 }).idleMovesPerS, null);
});

test("key measures: holds, press to press, the overlap share, and the Shift key before shifted characters", () => {
  const k = keyMeasures([key("keydown", 0, "Shift", { c: "ShiftLeft" }), key("keydown", 60, "H", { m: 8 }), key("keyup", 170, "H", { m: 8 }), key("keyup", 200, "Shift", { c: "ShiftLeft" }),
    key("keydown", 300, "i"), key("keyup", 410, "i"), key("keydown", 400, "!", { c: "Digit1" }), key("keyup", 480, "!", { c: "Digit1" })])!;
  assert.deepEqual(k.holds, [110, 110, 80]);
  assert.deepEqual(k.downToDown, [240, 100]);
  assert.deepEqual([k.keys, k.overlaps, k.overlapShare], [3, 1, 0.5]);
  assert.deepEqual([k.shiftedChars, k.shiftedWithShiftDown], [2, 1]);
  assert.deepEqual([k.numLockOn, k.backspaces], [0, 0]);
});

test("key measures: the extra pause at a word end, NumLock on, Backspace", () => {
  const k = keyMeasures([key("keydown", 0, "a"), key("keyup", 100, "a"), key("keydown", 200, " ", { c: "Space" }), key("keyup", 290, " ", { c: "Space" }),
    key("keydown", 500, "b", { nl: 1 }), key("keyup", 600, "b"), key("keydown", 700, "Backspace"), key("keyup", 780, "Backspace")])!;
  assert.equal(k.wordEndExtraMs, 100);
  assert.deepEqual([k.numLockOn, k.backspaces], [1, 1]);
  assert.equal(keyMeasures([ev("click", 5)]), null);
});

test("text measures: key events for each typed character, and texts with no key events below and above the limit", () => {
  const typed = ["a", "b", "c"].flatMap((ch, i) => [key("keydown", i * 100, ch), ev("input", i * 100 + 2, { it: "insertText", dt: ch }), key("keyup", i * 100 + 80, ch)]);
  assert.deepEqual(textMeasures(typed), { inputs: 3, chars: 3, keyChars: 3, keyEventsPerChar: 1, textsWithNoKeys: 0, longTextsWithNoKeys: 0 });
  const fill = textMeasures([ev("input", 10, { it: "insertText", dt: "jane.doe@example.com" })])!;
  assert.deepEqual([fill.chars, fill.keyEventsPerChar, fill.textsWithNoKeys, fill.longTextsWithNoKeys], [20, 0, 1, 0]);
  const long = textMeasures([ev("input", 10, { it: "insertText", dt: "x".repeat(41) })])!;
  assert.deepEqual([long.textsWithNoKeys, long.longTextsWithNoKeys], [0, 1]);
  assert.equal(textMeasures([ev("click", 1)]), null);
});

test("a focusin on a text field with no press and no Tab key in the 1.5 s before it", () => {
  const fin = (t: number, tg = "#f") => ev("focusin", t, { tg });
  assert.equal(focusinWithNoPress([fin(1000)]), 1);
  assert.equal(focusinWithNoPress([ev("pointerdown", 900, { tg: "#f" }), fin(1000)]), 0);
  assert.equal(focusinWithNoPress([key("keydown", 950, "Tab"), fin(1000)]), 0);
  assert.equal(focusinWithNoPress([ev("pointerdown", -1000, { tg: "#f" }), fin(1000)]), 1);
  assert.equal(focusinWithNoPress([fin(1000, "#b")]), 0);
});

test("wheel measures: the notch size, wheelDeltaY / deltaY, the gaps, and scrolls with no wheel or key", () => {
  const w = (t: number, dy: number, wdy = -120, dm = 0) => ev("wheel", t, { dy, wdy, dm, dx: 0 });
  const m = wheelMeasures([w(0, 120), w(60, 120), w(130, 120), ev("scroll", 150), ev("scroll", 1500)])!;
  assert.deepEqual([m.absDeltaY, m.ratios, m.deltaModes, m.gapsMs], [[120, 120, 120], [-1, -1, -1], [0, 0, 0], [60, 70]]);
  assert.deepEqual([m.events, m.scrolls, m.scrollsWithNoWheelOrKey], [3, 2, 1]);
  const pw = wheelMeasures([w(0, 600)])!;
  assert.deepEqual([pw.absDeltaY, pw.ratios], [[600], [-0.2]]);
  assert.equal(wheelMeasures([ev("click", 1)]), null);
});

test("box measures: the entry from the box's edge, the moves inside, and the time from the entry to the press", () => {
  const inBox = movesOf(line(5, 2, 30, 4), { f: "box", perMove: 1 });
  assert.deepEqual(boxMeasures([ev("pointerover", 1000, { f: "box", x: 2, y: 30 }), ...inBox, ev("pointerdown", 1300, { f: "box" })]), { entryEdgePx: 2, movesInside: 5, entryToPressMs: 300 });
  const pw = boxMeasures([ev("pointerover", 1000, { f: "box", x: 29, y: 33 }), ...movesOf(line(1, 29, 33, 0), { f: "box" }), ev("pointerdown", 1001, { f: "box" })])!;
  assert.equal(pw.entryEdgePx, 29);
  assert.equal(boxMeasures([ev("pointerover", 1000, { f: "box", x: 296, y: 40 })])!.entryEdgePx, 4, "the right edge is the nearest");
  assert.equal(boxMeasures(movesOf(line(3, 1, 1, 1))), null);
});

// ================================================================ the reference file

test("the reference file: the fixture passes; it holds numbers only, and every field is a known one", () => {
  const r = checkReference(FIXTURE);
  // The fixture is the reference of this task's live run: XTEST's six paths (M1's three and three more), its two box paths, and LITERATURE.
  assert.deepEqual([r.format, r.source, (r.pointer.samplesPerMove as number[]).length, (r.pointer.boxEntryEdgePx as number[]).length], [1, 1, 6, 2]);
  const bad = (edit: (x: any) => void, want: RegExp) => { const x = structuredClone(FIXTURE); edit(x); assert.throws(() => checkReference(x), want); };
  bad((x) => { x.ua = "Mozilla/5.0"; }, /^Error: reference: ua: not a field/);
  bad((x) => { x.pointer.screen = [1920, 1080]; }, /reference: pointer\.screen: not a field/);
  bad((x) => { x.pointer.samplesPerMove = [1.9, "2"]; }, /reference: pointer\.samplesPerMove\[1\]: not a number/);
  bad((x) => { x.keys.holdMs = { normal: [116] }; }, /reference: keys\.holdMs/);
  bad((x) => { x.keys.holdMs = { normal: [116, 24], note: "x" }; }, /reference: keys\.holdMs/);
  bad((x) => { delete x.wheel.notchPx; }, /reference: wheel\.notchPx: missing/);
  bad((x) => { x.format = 2; }, /reference: format: /);
  bad((x) => { x.source = 3; }, /reference: source: /);
  bad((x) => { x.pointer.pressMs = []; }, /reference: pointer\.pressMs: /);
  bad((x) => { x.pointer.pressMs = { range: [180, 60] }; }, /reference: pointer\.pressMs: /);
  assert.throws(() => checkReference("{}"), /reference: /);
});

test("the reference built from the XTEST steps: per-path values, the literature's values for the rest, numbers only", () => {
  const steps = [
    stepM({ kind: "idle", pointer: null, idleMovesPerS: 0 }),
    stepM({ pointer: { samplesPerMove: 1.9, predictedPerMove: 1.8, handlerLagMs: 3, path: pathM({ straightness: 0.8, fittsRatio: 1.4 }) } }),
    stepM({ kind: "hover", pointer: { samplesPerMove: 2, predictedPerMove: 2.1, handlerLagMs: 7, path: pathM({ straightness: 0.9, fittsRatio: 1.6 }) } }),
    stepM({ kind: "box", pointer: { samplesPerMove: 1.5, predictedPerMove: 1.1, handlerLagMs: 9, path: pathM() }, box: { entryEdgePx: 3, movesInside: 16, entryToPressMs: 240 } }),
    stepM({ kind: "type", pointer: null, keys: keysM({ holds: [30, 31] }), text: textM() }),
    stepM({ ok: false, pointer: { samplesPerMove: 9, predictedPerMove: 9, handlerLagMs: 9, path: pathM({ straightness: 0.1, fittsRatio: 9 }) } }),
  ];
  const r = buildReference(steps); // the failed step (9s) is left out
  assert.deepEqual(checkReference(JSON.parse(JSON.stringify(r))), r);
  assert.deepEqual([r.pointer.samplesPerMove, r.pointer.predictedPerMove, r.pointer.handlerLagMs, r.pointer.straightness, r.pointer.fittsRatio], [[1.9, 2], [1.8, 2.1], [3, 7], [0.8, 0.9], [1.4, 1.6]]);
  assert.deepEqual([r.pointer.boxEntryEdgePx, r.pointer.boxMovesInside, r.pointer.boxEntryToPressMs], [[3], [16], [240]]);
  assert.deepEqual([r.keys, r.wheel, r.pointer.pauseMs, r.pointer.pressMs], [LITERATURE.keys, LITERATURE.wheel, LITERATURE.pointer.pauseMs, LITERATURE.pointer.pressMs]);
  // The literature's values (design 8.2, 10.1, 10.2, 13.3; [19]) are the fixture's: press to press is lognormalOf(239, 112).
  assert.deepEqual([LITERATURE.keys, LITERATURE.wheel, LITERATURE.pointer.pauseMs, LITERATURE.pointer.pressMs, LITERATURE.pointer.wholeMsShare],
    [FIXTURE.keys, FIXTURE.wheel, FIXTURE.pointer.pauseMs, FIXTURE.pointer.pressMs, 1]);
  const [m, sg] = lognormalOf(239, 112);
  near(m, (LITERATURE.keys.downToDownMs as { lognormal: number[] }).lognormal[0], 0.05);
  near(sg, (LITERATURE.keys.downToDownMs as { lognormal: number[] }).lognormal[1], 0.001);
  assert.doesNotMatch(JSON.stringify(r), /"[^"]*"\s*[,}\]]/, "no string value: every string is a key");
  assert.throws(() => buildReference(steps.filter((s) => s.kind !== "box")), /no box step/);
});

// ================================================================ the bars

test("the band of a distribution: the samples' range with a margin, a range, a normal's and a lognormal's two standard deviations", () => {
  const b = band([1.87, 1.97], 0.15)!;
  near(b[0], 1.72);
  near(b[1], 2.12);
  assert.deepEqual(band({ range: [90, 150] }), [90, 150]);
  assert.deepEqual(band({ normal: [116, 24] }), [68, 164]);
  const l = band({ lognormal: [100, 0.275] })!;
  near(l[0], 57.69, 0.01);
  near(l[1], 173.33, 0.01);
  assert.equal(band([]), null);
});

test("a distribution against the reference: KS against its samples or its model with the bound at 5%, or a range", () => {
  const ref = Array.from({ length: 12 }, (_, i) => 0.7 + i * 0.02);
  const same = compareDist(ref.map((v) => v + 0.001), ref);
  assert.deepEqual([same.how, same.pass], ["ks2", true]);
  const off = compareDist(ref.map(() => 1), ref);
  assert.deepEqual([off.stat, off.pass], [1, false]);
  near(off.bound, ksBound(12, 12));
  assert.equal(compareDist([1, 2], [1, 2]).pass, null, "a bound of 1 or more: too few values to score");
  const holds = Array.from({ length: 20 }, (_, i) => 116 + 4 * (i - 9.5));
  assert.equal(compareDist(holds, { normal: [116, 24] }).pass, true);
  const short = compareDist(holds.map(() => 35), { normal: [116, 24] });
  assert.deepEqual([short.how, short.pass], ["ks1", false]);
  assert.equal(compareDist([0.2, 0.3], { range: [0.15, 0.5] }).pass, true);
  assert.equal(compareDist([0.1], { range: [0.15, 0.5] }).pass, false);
  assert.equal(compareDist([], { range: [0.15, 0.5] }).pass, null);
});

test("P1, P2, P8 and R10 on M1's numbers: the CDP form with whole-ms times 4 ms early meets the samples, the whole-ms share and the phase; its predicted points do not", () => {
  // M1 run 2's XTEST (the design probe's results): samples 1.89 to 1.93, predicted points 1.80 to 2.11, phase 2.3 to 8.1 ms.
  const ref = refWith((r) => { r.pointer.samplesPerMove = [1.89, 1.9, 1.93]; r.pointer.predictedPerMove = [1.84, 1.8, 2.11]; r.pointer.handlerLagMs = [8.1, 2.3, 4]; });
  // The same paths: M1's XTEST predicted points on its three paths (design 9.1's bar).
  const same = { "m1-0": 1.84, "m1-1": 1.8, "m1-2": 2.11 };
  const steps = (rows: number[][]) => rows.map(([s, p, l], i) => stepM({ path: `m1-${i}`, pointer: { samplesPerMove: s, predictedPerMove: p, handlerLagMs: l } }));
  const cdp4 = scoreSource(steps([[1.79, 2.67, 5.4], [1.73, 2.32, 5.4], [1.86, 2.64, 5.55]]), ref, { samePaths: same });
  assert.equal(verdict(cdp4, "P1", /samples/), "pass");
  assert.equal(verdict(cdp4, "P1", /same paths/), "fail");
  assert.equal(verdict(cdp4, "P1", /predicted points per pointermove/), "not scored", "with an XTEST reference, information");
  assert.equal(verdict(cdp4, "P2", /whole ms/), "pass");
  assert.match(rowOf(cdp4, "P2", /whole ms/).value, /chance 0\.3/);
  assert.equal(verdict(cdp4, "P8", /phase/), "pass");
  assert.equal(verdict(cdp4, "R10", /P1, P2 and P8/), "fail");
  const send = scoreSource(steps([[1.79, 2.66, 1.5], [1.88, 2.84, 1.35], [1.8, 2.38, 1.5]]), ref);
  assert.equal(verdict(send, "P8", /phase/), "fail");
  assert.equal(verdict(scoreSource([stepM({ pointer: { sampleGaps: 100, wholeMsGaps: 5, wholeMsShare: 0.05 } })], ref), "P2", /whole ms/), "fail");
  const one = scoreSource([stepM({ pointer: { samplesPerMove: 1, predictedPerMove: 0, handlerLagMs: 1 } })], ref);
  assert.equal(verdict(one, "P1", /samples/), "fail");
  const xt = scoreSource(steps([[1.89, 1.84, 8.1], [1.9, 1.8, 2.3], [1.93, 2.11, 4]]), ref, { samePaths: same });
  assert.equal(verdict(xt, "R10", /P1, P2 and P8/), "pass", "the reference against itself");
});

test("P2 events later than their handler, R1/R2 a focus after the release and jumps, R9 fractional points, M1's unexplained position changes, R12 touch: each bar is 0", () => {
  const ref = checkReference(FIXTURE);
  const good = scoreSource([stepM({ pointer: { focusInPress: true } })], ref);
  for (const [gap, m] of [["P2", /handler/], ["R1/R2", /focus/], ["R1/R2", /jumps/], ["R9", /fractional/], ["M1", /position/], ["R12", /touch/]] as const) {
    assert.equal(verdict(good, gap, m), "pass", `${gap} ${m}`);
  }
  const bad = scoreSource([stepM({ touch: 1, pointer: { eventsAfterHandler: 1, focusInPress: false, jumps: 1, fractional: 2, movementMismatch: 1 } })], ref);
  for (const [gap, m] of [["P2", /handler/], ["R1/R2", /focus/], ["R1/R2", /jumps/], ["R9", /fractional/], ["M1", /position/], ["R12", /touch/]] as const) {
    assert.equal(verdict(bad, gap, m), "fail", `${gap} ${m}`);
  }
});

test("P3: each shape measure by KS against the reference's paths; a source with no path where the reference has paths fails", () => {
  const shapes = Array.from({ length: 12 }, (_, i) => pathM({ straightness: 0.7 + i * 0.02, maxDeviationPx: 20 + i * 5, peakPxPerMs: 1.5 + i * 0.1, meanPxPerMs: 0.6 + i * 0.05,
    fittsRatio: 1 + i * 0.1, speedPeaks: 1 + (i % 2) }));
  const keys = ["straightness", "maxDeviationPx", "peakPxPerMs", "meanPxPerMs", "fittsRatio", "speedPeaks"] as const;
  const ref = refWith((r) => { for (const k of keys) r.pointer[k] = shapes.map((s) => s[k]); });
  const like = scoreSource(shapes.map((p) => stepM({ pointer: { path: p } })), ref).filter((r) => r.gap === "P3");
  assert.deepEqual(like.map((r) => r.verdict), ["pass", "pass", "pass", "pass", "pass", "pass"]);
  const straight = scoreSource(shapes.map((p) => stepM({ pointer: { path: { ...p, straightness: 1, maxDeviationPx: 0, speedPeaks: 3 } } })), ref);
  assert.deepEqual(keys.map((k, i) => straight.filter((r) => r.gap === "P3")[i].verdict), ["fail", "fail", "pass", "pass", "pass", "fail"]);
  const flat = scoreSource(shapes.map((p) => stepM({ pointer: { path: { ...p, maxDeviationPx: 0 } } })), ref);
  assert.deepEqual([verdict(flat, "P3", /straightness/), verdict(flat, "P3", /deviation/)], ["pass", "fail"], "each measure on its own");
  const jump = scoreSource([stepM({ pointer: { path: null, moves: 1 } })], ref);
  assert.equal(verdict(jump, "P3", /straightness/), "fail");
  assert.match(rowOf(jump, "P3", /straightness/).value, /no path/);
});

test("P4: the box's entry at its edge, its moves inside and the time to the press in the reference's range", () => {
  const ref = refWith((r) => { r.pointer.boxEntryEdgePx = [3, 5]; r.pointer.boxMovesInside = [16, 14]; r.pointer.boxEntryToPressMs = [240, 260]; });
  const box = (b: StepMeasures["box"]) => scoreSource([stepM({ kind: "box", box: b })], ref);
  const good = box({ entryEdgePx: 9, movesInside: 13, entryToPressMs: 290 });
  assert.deepEqual([verdict(good, "P4", /edge/), verdict(good, "P4", /moves/), verdict(good, "P4", /press/)], ["pass", "pass", "pass"]);
  const pw = box({ entryEdgePx: 29, movesInside: 1, entryToPressMs: 1 });
  assert.deepEqual([verdict(pw, "P4", /edge/), verdict(pw, "P4", /moves/), verdict(pw, "P4", /press/)], ["fail", "fail", "fail"]);
  assert.equal(verdict(box({ entryEdgePx: 3, movesInside: 8, entryToPressMs: 250 }), "P4", /moves/), "fail");
});

test("P5: the pause before the press and the press against the literature's lognormals", () => {
  const ref = checkReference(FIXTURE); // pause lognormal(140, 0.4), press lognormal(100, 0.275)
  const presses = (pause: number[], press: number[]) => scoreSource(pause.map((p, i) => stepM({ pointer: { pauseMs: p, pressMs: press[i] } })), ref);
  const like = presses(Z12.map((z) => 140 * Math.exp(0.4 * z)), Z12.map((z) => 100 * Math.exp(0.275 * z)));
  assert.deepEqual([verdict(like, "P5", /pause/), verdict(like, "P5", /^press/)], ["pass", "pass"]);
  const ab = presses(Z12.map((_, i) => 96 + i * 8), Z12.map((_, i) => 73 + i * 2));
  assert.equal(verdict(ab, "P5", /^press/), "fail");
  const pw = presses(Z12.map(() => 0.3), Z12.map(() => 0.2));
  assert.deepEqual([verdict(pw, "P5", /pause/), verdict(pw, "P5", /^press/)], ["fail", "fail"]);
});

test("P6, K5 and R7/R15 are measured and not scored (the bars wait for Q4, a later build and Q3)", () => {
  const rows = scoreSource([stepM({ kind: "idle", pointer: null, idleMovesPerS: 0.5 }), stepM({ untrusted: 2 }), stepM({ kind: "type", pointer: null, keys: keysM({ backspaces: 1 }), text: textM() })],
    checkReference(FIXTURE));
  assert.deepEqual([verdict(rows, "P6", /idle/), verdict(rows, "K5", /Backspace/), verdict(rows, "R7/R15", /untrusted/)], ["not scored", "not scored", "not scored"]);
  assert.match(rowOf(rows, "P6", /idle/).value, /^0\.5/);
  assert.match(rowOf(rows, "K5", /Backspace/).value, /^6\.25/);
  assert.match(rowOf(rows, "R7/R15", /untrusted/).value, /^2/);
});

test("P7: notches of 120 px with deltaMode 0 and wheelDeltaY / deltaY -1, the gaps in range; R5/R6: no scroll without a wheel or a key", () => {
  const ref = checkReference(FIXTURE); // notch 120 px, gaps 35 to 90 ms
  const wheel = (w: Partial<NonNullable<StepMeasures["wheel"]>>) => scoreSource([stepM({ kind: "wheel", pointer: null,
    wheel: { events: 5, absDeltaY: [120, 120, 120, 120, 120], ratios: [-1, -1, -1, -1, -1], deltaModes: [0, 0, 0, 0, 0], gapsMs: [60, 70, 65, 80], scrolls: 5, scrollsWithNoWheelOrKey: 0, ...w } })], ref);
  const x11 = wheel({});
  assert.deepEqual([/notch/, /wheelDeltaY/, /gaps/].map((m) => verdict(x11, "P7", m)), ["pass", "pass", "pass"]);
  assert.equal(verdict(x11, "R5/R6", /no wheel/), "pass");
  assert.equal(verdict(x11, "P7", /per scroll/), "not scored");
  const ab = wheel({ absDeltaY: [100, 100], ratios: [-1.2, -1.2], deltaModes: [0, 0], gapsMs: [20] });
  assert.deepEqual([/notch/, /wheelDeltaY/, /gaps/].map((m) => verdict(ab, "P7", m)), ["fail", "fail", "fail"]);
  const pw = wheel({ events: 1, absDeltaY: [600], ratios: [-0.2], deltaModes: [0], gapsMs: [], scrolls: 1 });
  assert.deepEqual([/notch/, /wheelDeltaY/, /gaps/].map((m) => verdict(pw, "P7", m)), ["fail", "fail", "fail"]);
  assert.equal(verdict(wheel({ deltaModes: [1, 1, 1, 1, 1] }), "P7", /notch/), "fail");
  assert.equal(verdict(wheel({ events: 0, absDeltaY: [], ratios: [], deltaModes: [], gapsMs: [], scrollsWithNoWheelOrKey: 3 }), "R5/R6", /no wheel/), "fail");
});

test("K1 to K4 and K6: holds and press to press by KS against the literature, the word-end pause, the overlap share, Shift, NumLock", () => {
  const ref = checkReference(FIXTURE);
  const typing = (k: Partial<KeyMeasures>) => scoreSource([stepM({ kind: "type", pointer: null, keys: keysM(k), text: textM() })], ref);
  const person = typing({});
  assert.deepEqual([verdict(person, "K1", /holds/), verdict(person, "K2", /press to press/), verdict(person, "K2", /word end/), verdict(person, "K3", /overlap/),
    verdict(person, "K4", /Shift/), verdict(person, "K6", /NumLock/)], ["pass", "pass", "pass", "pass", "pass", "pass"]);
  const ab = typing({ holds: Z12.map((_, i) => 22 + i * 2.5), downToDown: Z12.map((_, i) => 90 + i * 5), wordEndExtraMs: 2, overlaps: 0, overlapShare: 0, shiftedWithShiftDown: 0, numLockOn: 1 });
  assert.deepEqual([verdict(ab, "K1", /holds/), verdict(ab, "K2", /press to press/), verdict(ab, "K2", /word end/), verdict(ab, "K3", /overlap/),
    verdict(ab, "K4", /Shift/), verdict(ab, "K6", /NumLock/)], ["fail", "fail", "fail", "fail", "fail", "fail"]);
  assert.equal(verdict(typing({ overlaps: 8, overlapShare: 8 / 12 }), "K3", /overlap/), "fail", "the share is above 50%");
  assert.equal(verdict(typing({ shiftedChars: 0, shiftedWithShiftDown: 0 }), "K4", /Shift/), "no data");
  assert.equal(verdict(typing({ shiftedWithShiftDown: 3 }), "K4", /Shift/), "fail", "3 of 4 is not every one");
});

test("R3/R14 and R4: no focusin with no press; one key event or more for each character of a text below the limit", () => {
  const ref = checkReference(FIXTURE);
  const typed = scoreSource([stepM({ kind: "type", pointer: null, keys: keysM(), text: textM() })], ref);
  assert.deepEqual([verdict(typed, "R3/R14", /focusin/), verdict(typed, "R4", /key events/)], ["pass", "pass"]);
  const fill = scoreSource([stepM({ kind: "fill", pointer: null, focusinWithNoPress: 1, text: textM({ inputs: 1, chars: 20, keyChars: 0, keyEventsPerChar: 0, textsWithNoKeys: 1 }) })], ref);
  assert.deepEqual([verdict(fill, "R3/R14", /focusin/), verdict(fill, "R4", /key events/)], ["fail", "fail"]);
  const long = scoreSource([stepM({ kind: "fill", pointer: null, text: textM({ inputs: 1, chars: 60, keyChars: 0, keyEventsPerChar: 0, textsWithNoKeys: 0, longTextsWithNoKeys: 1 }) })], ref);
  assert.equal(verdict(long, "R4", /key events/), "pass", "a text above the limit is counted, not failed");
  assert.match(rowOf(long, "R4", /key events/).value, /1 above the limit/);
});

test("R8 and R13: moves with the button down before the drop; the modifier around the press; a double click's gap", () => {
  const ref = checkReference(FIXTURE);
  const one = (kind: StepMeasures["kind"], p: Partial<PointerMeasures>) => scoreSource([stepM({ kind, pointer: p })], ref);
  assert.equal(verdict(one("drag", { heldMoves: 12 }), "R8", /button down/), "pass");
  assert.equal(verdict(one("drag", { heldMoves: 1 }), "R8", /button down/), "fail");
  const mod = one("modclick", { modifierLeadMs: 80, modifierLagMs: 30 });
  assert.deepEqual([verdict(mod, "R13", /down before/), verdict(mod, "R13", /up after/)], ["pass", "pass"]);
  const pwMod = one("modclick", { modifierLeadMs: 3, modifierLagMs: 2 });
  assert.deepEqual([verdict(pwMod, "R13", /down before/), verdict(pwMod, "R13", /up after/)], ["fail", "fail"]);
  assert.equal(verdict(one("dblclick", { doubleClickGapMs: 120 }), "R13", /double click/), "pass");
  assert.equal(verdict(one("dblclick", { doubleClickGapMs: 0.1 }), "R13", /double click/), "fail");
});

test("a gap with no step of its kind has no data", () => {
  const rows = scoreSource([stepM()], checkReference(FIXTURE));
  for (const [gap, m] of [["R8", /button down/], ["R13", /double click/], ["K1", /holds/], ["P7", /notch/], ["P4", /edge/], ["R4", /key events/], ["P5", /pause/]] as const) {
    assert.equal(verdict(rows, gap, m), "no data", `${gap} ${m}`);
  }
});

test("the text table: a header with each source, one line for each measure, and the verdicts", () => {
  const ref = checkReference(FIXTURE);
  const xt = scoreSource([stepM()], ref);
  const lines = textTable({ xtest: xt, playwright: scoreSource([stepM({ pointer: { samplesPerMove: 1 } })], ref) }).trim().split("\n");
  assert.match(lines[0], /^gap +measure +bar +xtest +playwright/);
  assert.equal(lines.length, 2 + xt.length);
  assert.ok(lines.some((l) => /^P1 +samples per pointermove .* ok .* FAIL/.test(l)), lines.join("\n"));
  assert.ok(lines.some((l) => /^R8 .* - +- *$/.test(l)), "no data: a dash");
});

// ================================================================ fix round 1 (review-97)

test("a gap of 0 ms (equal timestamps) or of less than 0.5 ms is not a whole-ms gap", () => {
  assert.deepEqual([isWholeMs(0), isWholeMs(0.1), isWholeMs(1), isWholeMs(0.9)], [false, false, true, true]);
  assert.equal(wholeMsShare([0, 0, 0]), 0);
});

test("the one-sample KS bound: exact for n up to 35 (Miller's table at 5%), asymptotic above", () => {
  near(ksCdf(1, 0.975), 0.95, 1e-9);
  near(ksCdf(3, 0.7076), 0.95, 2e-3);
  for (const [n, d] of [[1, 0.975], [2, 0.8419], [3, 0.7076], [5, 0.5633], [10, 0.4093], [20, 0.2941], [35, 0.2242]] as const) near(ksCritical(n), d, 2e-3);
  near(ksBound(3), 0.7076, 2e-3);
  near(ksBound(100), 0.1358);
  near(ksBound(8, 8), 0.679);
});

test("the path ends at the first press in its frame: no move after the press and no move of another frame", () => {
  const m = [...movesOf(line(6, 100, 200, 10), { perMove: 1 }), ...movesOf(line(3, 5, 5, 3, 1012), { perMove: 1, f: "box" }), ev("pointerdown", 1045, { x: 150, y: 200 }),
    ...movesOf(line(4, 400, 200, 10, 1050), { perMove: 1 }), ev("pointerup", 1150)];
  const p = pointerMeasures(m)!;
  assert.deepEqual([p.path!.samples, p.path!.chordPx], [6, 50]);
});

test("K2 per letter pair: each pair's press-to-press times, the pair in lower case, keys with no character left out", () => {
  const k = keyMeasures([key("keydown", 0, "Shift", { c: "ShiftLeft" }), key("keydown", 60, "H", { m: 8 }), key("keyup", 150, "H"), key("keyup", 160, "Shift", { c: "ShiftLeft" }),
    key("keydown", 300, "e"), key("keyup", 380, "e"), key("keydown", 500, "y"), key("keyup", 600, "y"), key("keydown", 800, "Enter"), key("keyup", 880, "Enter"),
    key("keydown", 1000, "h"), key("keyup", 1080, "h"), key("keydown", 1150, "e"), key("keyup", 1230, "e")])!;
  assert.deepEqual(k.pairs, { he: [240, 150], ey: [200] });
});

test("R8: drag and dragover events between the press and the drop count with the moves that have the button down", () => {
  const p = pointerMeasures([ev("pointerdown", 1200), ...movesOf(line(1, 300, 300, 5, 1210), { perMove: 1, bs: 1 }), ev("dragstart", 1215), ev("drag", 1250, { bs: 1 }),
    ev("dragover", 1252, { bs: 1 }), ev("drag", 1300, { bs: 1 }), ev("dragover", 1302, { bs: 1 }), ev("drag", 1305, { bs: 0 }), ev("dragover", 1306, { bs: 0 }),
    ev("drop", 1320), ev("drag", 1330), ev("dragend", 1340)])!;
  assert.equal(p.heldMoves, 5, "drag events with the button up (a protocol drag: buttons 0) do not count");
});

test("R11: the jump from the page's last pointer position to the first pointer event after an activation of its window", () => {
  const win = (e: string, t: number, f = "top") => ev(e, t, { f, tg: "[object Window]" });
  const at = (e: string, t: number, sx: number, sy: number, f = "top") => ev(e, t, { f, x: sx, y: sy - 100, sx, sy });
  const base = [at("pointermove", 100, 900, 700), at("mousemove", 101, 900, 700)];
  assert.deepEqual(activationJumps([...base, win("focus", 5000), win("focus", 5001), at("pointerover", 5002, 950, 700)], { t0: 4990, t1: 6000 }), [50]);
  assert.deepEqual(activationJumps([...base, win("focus", 5000), at("pointerover", 5002, 900, 700)], { t0: 4990, t1: 6000 }), [0]);
  assert.deepEqual(activationJumps([...base, win("focus", 5000), win("blur", 5001, "box"), at("pointerover", 5002, 950, 700)], { t0: 4990, t1: 6000 }), [], "the focus came from the box: no activation");
  assert.deepEqual(activationJumps([...base, win("focus", 5000), at("pointerover", 5002, 950, 700)], { t0: 6000, t1: 7000 }), [], "outside the step");
  assert.deepEqual(activationJumps([win("focus", 5000), at("pointerover", 5002, 950, 700)], { t0: 4990, t1: 6000 }), [], "no position before");
});

test("wheel measures: a wheel event with no deltaMode gives none, never mode 0", () => {
  assert.deepEqual(wheelMeasures([ev("wheel", 0, { dy: 120, wdy: -120, dx: 0 })])!.deltaModes, [null]);
});

test("lost beacon batches: the gaps in the batches' sequence numbers", () => {
  assert.deepEqual([lostBatches([0, 1, 2, 4, 5]), lostBatches([]), lostBatches([1, 2]), lostBatches([0, 0, 1])], [1, 0, 1, 0]);
});

test("a step's event count: the records of events (with isTrusted), not the page's own records", () => {
  const s = measureStep([ev("click", 1000), ev("keydown", 1100, { k: "a", c: "KeyA" }), { e: "layout", f: "top", t: 1200 }, { e: "seq", f: "top", t: 1300, n: 0 }],
    { name: "c", source: "x", kind: "click", ok: true, t0: 1000, t1: 1400, path: "m1-b" });
  assert.deepEqual([s.events, s.path], [2, "m1-b"]);
});

test("the reference file: inherited names (constructor, toString, __proto__) with any value are refused; an array where a number is expected is refused", () => {
  const text = JSON.stringify(FIXTURE);
  for (const name of ["constructor", "toString", "__proto__"]) {
    for (const value of ['"Mozilla/5.0 (X11; Linux x86_64)"', "1", "{}"]) {
      for (const [part, re] of [["", new RegExp(`reference: ${name}: not a field`)], ["pointer", new RegExp(`reference: pointer\\.${name}: not a field`)], ["keys", /reference: keys\./], ["wheel", /reference: wheel\./]] as const) {
        const edited = part ? text.replace(`"${part}":{`, `"${part}":{"${name}":${value},`) : text.replace(/^\{/, `{"${name}":${value},`);
        assert.throws(() => checkReference(JSON.parse(edited)), re, `${part || "top"}.${name} = ${value}`);
      }
    }
  }
  const bad = (edit: (x: any) => void, want: RegExp) => { const x = structuredClone(FIXTURE); edit(x); assert.throws(() => checkReference(x), want); };
  bad((x) => { x.pointer.wholeMsShare = [1]; }, /reference: pointer\.wholeMsShare: not a number/);
  bad((x) => { x.wheel.notchPx = [120]; }, /reference: wheel\.notchPx: not a number/);
});

test("the reference file: press to press per letter pair (optional): two characters for each key, a distribution for each value", () => {
  const ok = refWith((r) => { r.keys.downToDownByPairMs = { th: [100, 110, 120, 130, 140], "e ": { lognormal: [200, 0.4] } }; });
  assert.deepEqual(Object.keys(ok.keys.downToDownByPairMs!), ["th", "e "]);
  const bad = (pairs: unknown, want: RegExp) => assert.throws(() => refWith((r) => { r.keys.downToDownByPairMs = pairs; }), want);
  bad({ the: [100] }, /reference: keys\.downToDownByPairMs\.the: not a letter pair/);
  bad({ th: "x" }, /reference: keys\.downToDownByPairMs\.th: /);
  bad({ th: [] }, /reference: keys\.downToDownByPairMs\.th: no values/);
  bad(JSON.parse('{"__proto__": [1, 2]}'), /reference: keys\.downToDownByPairMs\.__proto__: not a letter pair/);
  bad({}, /reference: keys\.downToDownByPairMs: no pairs/);
  bad([1, 2], /reference: keys\.downToDownByPairMs: /);
});

test("K2 per letter pair: KS for each pair with 5 values or more in both; the pooled row stays", () => {
  const like = [100, 110, 120, 130, 140], slow = [300, 310, 320, 330, 340];
  const ref = refWith((r) => { r.keys.downToDownByPairMs = { th: like, he: like, zz: like }; });
  const typing = (pairs: Record<string, number[]>) => scoreSource([stepM({ kind: "type", pointer: null, keys: keysM({ pairs }), text: textM() })], ref);
  assert.equal(verdict(typing({ th: like.map((v) => v + 1), he: like.map((v) => v + 2), xy: [1] }), "K2", /per letter pair/), "pass");
  const one = typing({ th: like.map((v) => v + 1), he: slow });
  assert.equal(verdict(one, "K2", /per letter pair/), "fail");
  assert.match(rowOf(one, "K2", /per letter pair/).value, /1 of 2 pairs pass/);
  assert.equal(verdict(typing({ th: like.slice(0, 4) }), "K2", /per letter pair/), "no data", "4 values: too few");
  assert.equal(verdict(scoreSource([stepM({ kind: "type", pointer: null, keys: keysM({ pairs: { th: like } }), text: textM() })], checkReference(FIXTURE)), "K2", /per letter pair/), "no data", "no pair in the reference");
  assert.equal(verdict(one, "K2", /press to press \(all pairs/), "pass", "the pooled row");
});

test("R11 and M1: the jump at an activation (bar 0), and the position changes that the movement does not explain under their own name", () => {
  const ref = checkReference(FIXTURE);
  assert.equal(verdict(scoreSource([stepM({ activationJumps: [0] })], ref), "R11", /activation/), "pass");
  assert.equal(verdict(scoreSource([stepM({ activationJumps: [0, 50] })], ref), "R11", /activation/), "fail");
  assert.equal(verdict(scoreSource([stepM()], ref), "R11", /activation/), "no data");
  assert.equal(verdict(scoreSource([stepM({ pointer: { movementMismatch: 1 } })], ref), "M1", /movement does not explain/), "fail");
});

test("no row passes on records that are not there: R3/R14, R7/R15 and R12 with no events, P7's ratio with no ratio, a missing deltaMode", () => {
  const ref = checkReference(FIXTURE);
  const empty = scoreSource([stepM({ kind: "type", pointer: null, keys: null, text: null, events: 0 })], ref);
  assert.deepEqual([verdict(empty, "R3/R14", /focusin/), verdict(empty, "R12", /touch/), verdict(empty, "R7/R15", /untrusted/)], ["no data", "no data", "no data"]);
  const wheel = (w: Partial<NonNullable<StepMeasures["wheel"]>>) => scoreSource([stepM({ kind: "wheel", pointer: null,
    wheel: { events: 1, absDeltaY: [120], ratios: [-1], deltaModes: [0], gapsMs: [], scrolls: 1, scrollsWithNoWheelOrKey: 0, ...w } })], ref);
  assert.equal(verdict(wheel({ absDeltaY: [0], ratios: [] }), "P7", /wheelDeltaY/), "no data");
  assert.equal(verdict(wheel({ deltaModes: [null as unknown as number] }), "P7", /notch/), "fail");
});

test("P1, P2 and P8 need 30 pointermoves (P2: 30 sample gaps) and give no data below; P2 against a reference share below 1 is a z test", () => {
  const ref = checkReference(FIXTURE);
  const few = scoreSource([stepM({ pointer: { moves: 1, samplesPerMove: 2, predictedPerMove: 2, sampleGaps: 1, wholeMsGaps: 1, wholeMsShare: 1, handlerLagMs: 4 } })], ref);
  for (const [gap, m] of [["P1", /samples/], ["P2", /whole ms/], ["P8", /phase/], ["R10", /together/]] as const) assert.equal(verdict(few, gap, m), "no data", `${gap} ${m}`);
  assert.equal(verdict(scoreSource([stepM({ pointer: { moves: 30, sampleGaps: 30, wholeMsGaps: 30 } })], ref), "P2", /whole ms/), "pass");
  assert.equal(verdict(scoreSource([stepM({ pointer: { moves: 60, sampleGaps: 60, wholeMsGaps: 0, wholeMsShare: 0 } })], ref), "P2", /whole ms/), "fail", "all gaps 0 ms");
  const half = refWith((r) => { r.pointer.wholeMsShare = 0.5; });
  assert.equal(verdict(scoreSource([stepM({ pointer: { sampleGaps: 100, wholeMsGaps: 52 } })], half), "P2", /whole ms/), "pass");
  assert.equal(verdict(scoreSource([stepM({ pointer: { sampleGaps: 100, wholeMsGaps: 90 } })], half), "P2", /whole ms/), "fail");
});

test("a failed step is left out of every row, and counted; a source with only failed steps has no data", () => {
  const ref = checkReference(FIXTURE);
  const rows = scoreSource([stepM(), stepM({ ok: false, touch: 3, pointer: { jumps: 5 } })], ref);
  assert.deepEqual([verdict(rows, "R1/R2", /jumps/), verdict(rows, "R12", /touch/)], ["pass", "pass"]);
  assert.match(rowOf(rows, "all", /failed steps/).value, /^1$/);
  const only = scoreSource([stepM({ ok: false })], ref);
  assert.deepEqual([verdict(only, "P1", /samples/), verdict(only, "R12", /touch/), verdict(only, "R7/R15", /untrusted/)], ["no data", "no data", "no data"]);
});

test("lost beacon batches make every row of the source no data", () => {
  const rows = scoreSource([stepM()], checkReference(FIXTURE), { lostBatches: 2 });
  assert.ok(rows.filter((r) => r.gap !== "all").every((r) => r.verdict === "no data"), rows.filter((r) => r.verdict !== "no data").map((r) => r.measure).join(", "));
  assert.match(rowOf(rows, "P1", /samples/).value, /2 batches lost/);
});

test("P1's predicted points: the bar of design 9.1 is XTEST's per-path range on the same paths with no margin; the range row is information with an XTEST reference", () => {
  const ref = refWith((r) => { r.pointer.predictedPerMove = [1.8, 2.11]; });
  const steps = (v: number[]) => v.map((p, i) => stepM({ path: `m1-${i}`, pointer: { predictedPerMove: p } }));
  const same = { "m1-0": 1.77, "m1-1": 1.8, "m1-2": 2.07 };
  const cdp = scoreSource(steps([2.47, 2.18, 2.55]), ref, { samePaths: same });
  assert.equal(verdict(cdp, "P1", /same paths/), "fail");
  assert.equal(verdict(scoreSource(steps([1.8, 1.9, 2.0]), ref, { samePaths: same }), "P1", /same paths/), "pass");
  assert.equal(verdict(scoreSource(steps([2.1, 2.1, 2.1]), ref, { samePaths: same }), "P1", /same paths/), "fail", "no margin: 2.1 is above 2.07");
  assert.equal(verdict(scoreSource([stepM()], ref, { samePaths: same }), "P1", /same paths/), "no data", "no step on those paths");
  assert.equal(verdict(cdp, "P1", /predicted points per pointermove/), "not scored");
  const person = refWith((r) => { r.source = 2; r.pointer.predictedPerMove = [1.8, 2.11]; });
  assert.equal(verdict(scoreSource(steps([2.12, 2.12, 2.12]), person), "P1", /predicted points per pointermove/), "fail", "no margin: 2.12 is above 2.11");
});

test("R4's bar says what the verdict checks", () => {
  const rows = scoreSource([stepM({ kind: "type", pointer: null, keys: keysM(), text: textM() })], checkReference(FIXTURE));
  assert.match(rowOf(rows, "R4", /key events/).bar, /every text input of 40 characters or less: one character, with a key event/);
});

// ---------------------------------------------------------------- the run's cleanup (run.ts uses cleanup.ts)

const gone = (pid: number) => { try { process.kill(pid, 0); return false; } catch { return true; } };
const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("the cleanup stops the children by pid, then removes its paths; a path whose condition says keep stays", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-ih-"));
  const kids: ChildProcess[] = [];
  try {
    const c = new Cleanup({ termMs: 2000 });
    for (let i = 0; i < 2; i++) { const k = spawn("sleep", ["60"], { stdio: "ignore" }); kids.push(k); c.child(k); }
    for (const name of ["profile", "state", "keep"]) { mkdirSync(join(dir, name)); writeFileSync(join(dir, name, "x"), "x"); }
    c.path(join(dir, "profile")); c.path(join(dir, "state")); c.path(join(dir, "keep"), () => false);
    await c.stop();
    assert.ok(kids.every((k) => k.exitCode !== null || k.signalCode !== null), "both children ended");
    assert.deepEqual([existsSync(join(dir, "profile")), existsSync(join(dir, "state")), existsSync(join(dir, "keep"))], [false, false, true]);
    const k = spawn("sleep", ["60"], { stdio: "ignore" }); kids.push(k);
    const d = new Cleanup(); d.child(k); d.path(join(dir, "keep"));
    d.stopNow();
    assert.equal(existsSync(join(dir, "keep")), false, "stopNow removes at once");
    for (let i = 0; i < 50 && k.exitCode === null && k.signalCode === null; i++) await sleepMs(50);
    assert.ok(k.signalCode === "SIGTERM", "stopNow sends SIGTERM");
  } finally { for (const k of kids) if (k.exitCode === null && k.signalCode === null) k.kill("SIGKILL"); rmSync(dir, { recursive: true, force: true }); }
});

test("on SIGINT, SIGTERM and SIGHUP a driver with the cleanup stops its child and removes its folders before it exits", { skip: process.platform !== "linux" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-ih-"));
  const script = join(dir, "driver.mjs");
  writeFileSync(script, `import { Cleanup } from ${JSON.stringify(new URL("./live/input-harness/cleanup.ts", import.meta.url).pathname)};
import { spawn } from "node:child_process"; import { mkdirSync, writeFileSync } from "node:fs";
const d = process.argv[2], c = new Cleanup({ termMs: 2000 });
const kid = spawn("sleep", ["60"], { stdio: "ignore" }); c.child(kid);
mkdirSync(d + "/profile"); writeFileSync(d + "/profile/x", "x"); c.path(d + "/profile");
c.onSignals();
process.stdout.write("ready " + kid.pid + "\\n");
setInterval(() => {}, 1000);
`);
  const left: number[] = [];
  try {
    for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]] as const) {
      const run = join(dir, sig);
      mkdirSync(run);
      const drv = spawn(process.execPath, [script, run], { stdio: ["ignore", "pipe", "inherit"] });
      const pid = await new Promise<number>((resolve, reject) => {
        let out = "";
        drv.stdout!.on("data", (b) => { out += b; const m = /ready (\d+)/.exec(out); if (m) resolve(Number(m[1])); });
        drv.once("exit", () => reject(new Error(`the driver ended early: ${out}`)));
      });
      left.push(pid);
      assert.equal(existsSync(join(run, "profile")), true);
      const exit = new Promise<number | null>((r) => drv.once("exit", (c) => r(c)));
      drv.kill(sig);
      assert.equal(await exit, code, `${sig}: the exit code`);
      assert.equal(gone(pid), true, `${sig}: the child ${pid} is gone`);
      assert.equal(existsSync(join(run, "profile")), false, `${sig}: the profile is removed`);
    }
  } finally {
    for (const pid of left) if (!gone(pid)) process.kill(pid, "SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a drag step counts in R8 only: Chromium sends no pointer event during a drag, so the first move after the drop jumps", () => {
  const ref = checkReference(FIXTURE);
  const rows = scoreSource([stepM(), stepM({ kind: "drag", pointer: { jumps: 1, samplesPerMove: 1, heldMoves: 119 } })], ref);
  assert.deepEqual([verdict(rows, "R1/R2", /jumps/), verdict(rows, "P1", /samples/), verdict(rows, "R8", /button down/)], ["pass", "pass", "pass"]);
  assert.equal(rowOf(rows, "P1", /samples/).value, "1.90");
});
