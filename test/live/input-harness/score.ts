// The input harness's bars and report (board ab-t30.2): each gap of the design's section 13.3
// (2026-11-10-vanilla-playwright-human-input-design.md) scored for one source against a reference (reference.ts). Pure;
// unit-tested in test/input-harness.test.ts.
//
// A row's verdict: "pass" (the bar holds), "fail", "not scored" (measured, but its bar waits for a decision: P6 for Q4,
// K5 for a later build, R7/R15 for Q3; or information: P1's range row of predicted points with an XTEST reference), or
// "no data" (the source has no step of the row's kind, too few values for the row's test, no event records, or lost
// beacon batches). No row passes on records that are not there. A failed step (its action failed) is left out of every
// row and counted in the row "failed steps left out".

import { TEXT_LIMIT, type StepKind, type StepMeasures } from "./measures.ts";
import { SOURCE, type Dist, type Reference } from "./reference.ts";
import { binomialZ, ks1, ks2, ksBound, lognormalCdf, mean, median, normalCdf, wholeMsChance } from "./stats.ts";

export type Verdict = "pass" | "fail" | "not scored" | "no data";
export type Row = { gap: string; measure: string; bar: string; value: string; verdict: Verdict; n: number };

/** The first values of the bars that are not in the reference (the design says "first values; the harness task sets them"). */
export const BARS = {
  /** P1: the source's mean count is within the reference's per-path range widened by this much: about three standard errors of one path's
   *  mean over about 60 pointermoves (the count's SD is about 0.4). */
  countMargin: 0.15,
  /** P8: the source's median phase is within the reference's per-path range widened by this much (ms). */
  phaseMarginMs: 0,
  /** P1, P8 (and P1's same-path row): the least count of pointermoves. One path at 125 Hz gives about 60; with 30, a mean count's
   *  standard error is about 0.4 / sqrt(30) = 0.07, half of countMargin, and a median phase's is about 1 ms. Below it: no data. */
  minMoves: 30,
  /** P2: the least count of sample gaps. With 30 gaps, a share of 1 is 8.4 or more standard deviations above the chance of 0.30
   *  (binomialZ), so with a reference share of 1 (X11) every gap must be whole; with a reference share below 1 (a person's
   *  Mac, later), the share must be within wholeMsZ standard errors of the reference's (a z test). Below it: no data. */
  minGaps: 30, wholeMsZ: 3,
  /** P4: the entry is at the box's edge: at most this many px from it, or the reference's largest when that is more. */
  boxEdgeMinPx: 10,
  /** P4: the reference's range of moves inside the box, widened by this many moves; of the time from the entry to the press, by this many ms (5 samples at 125 Hz). */
  boxMovesMargin: 2, boxTimeMarginMs: 40,
  /** R8: more than 5 moves with the button down, or drag events, between the press and the drop. */
  heldMovesMin: 6,
  /** R11: a jump at an activation of 1 px or more fails (points are whole px on Linux: the bar is 0). */
  activationJumpPx: 1,
  /** K2 per letter pair: a pair is tested when the source and the reference each have this many values of it (two samples of 5: a KS bound of 0.86). */
  minPairValues: 5,
  /** R13: the modifier goes down this long before the press and up this long after the release (design 10.2's Shift: 45 to 95 ms before, 15 to 60 ms after). */
  modifierLeadMinMs: 45, modifierLagMinMs: 15,
  /** R13: a double click's gap from the first release to the second press (design 10.1's first value). */
  doubleClickMinMs: 90, doubleClickMaxMs: 150,
};

/** The steps of the pointer rows. A drag step counts in R8 only: Chromium sends no pointer event during a drag, so its stream is cut (the first move after the drop jumps). */
const POINTER: ReadonlySet<StepKind> = new Set(["click", "hover", "move", "box", "dblclick", "modclick", "far"]);
const PATHS: ReadonlySet<StepKind> = new Set(["click", "hover", "move"]);
const PRESSES: ReadonlySet<StepKind> = new Set(["click", "box", "modclick", "far", "dblclick"]);
const FOCUS: ReadonlySet<StepKind> = new Set(["click", "far", "modclick", "dblclick", "type"]);
const TEXT: ReadonlySet<StepKind> = new Set(["type", "fill"]);
const WHEEL: ReadonlySet<StepKind> = new Set(["wheel", "far"]);

const f2 = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(2));
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
const nums = (a: (number | null | undefined)[]) => a.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
const inBand = (v: number, b: [number, number]) => v >= b[0] - 1e-9 && v <= b[1] + 1e-9;
const bandText = (b: [number, number] | null) => (b ? `${f2(b[0])} to ${f2(b[1])}` : "?");
const distText = (d: Dist) => (Array.isArray(d) ? `${d.length} values` : "normal" in d ? `normal(${d.normal.join(", ")})` : "lognormal" in d ? `lognormal(${d.lognormal.join(", ")})` : `${d.range.join(" to ")}`);

/** The band that a single value of a distribution lies in: its values' range with a margin, a range, or a model's two standard deviations. */
export function band(dist: Dist, margin = 0): [number, number] | null {
  if (Array.isArray(dist)) return dist.length ? [Math.min(...dist) - margin, Math.max(...dist) + margin] : null;
  if ("range" in dist) return [dist.range[0] - margin, dist.range[1] + margin];
  if ("normal" in dist) return [dist.normal[0] - 2 * dist.normal[1] - margin, dist.normal[0] + 2 * dist.normal[1] + margin];
  return [dist.lognormal[0] * Math.exp(-2 * dist.lognormal[1]) - margin, dist.lognormal[0] * Math.exp(2 * dist.lognormal[1]) + margin];
}

/** The least count of a KS row: the values that it scores need at least this many. The exact one-sample bound is below 1 at n = 1 (0.975), so without this count one value could pass (review-97b N1). */
export const KS_MIN_VALUES = 2;

export type Compared = { how: "ks2" | "ks1" | "range"; stat: number | null; bound: number | null; pass: boolean | null };

/** Values against a distribution: KS against its values (two samples) or its model (one sample), each with its bound at 5%; or all in its range. pass null: too few values. */
export function compareDist(values: readonly number[], dist: Dist): Compared {
  if (!Array.isArray(dist) && "range" in dist) {
    return { how: "range", stat: values.length ? values.filter((v) => inBand(v, dist.range)).length / values.length : null, bound: null,
      pass: values.length ? values.every((v) => inBand(v, dist.range)) : null };
  }
  const two = Array.isArray(dist);
  const bound = values.length ? (two ? ksBound(values.length, dist.length) : ksBound(values.length)) : null;
  const stat = two ? ks2(values, dist) : ks1(values, "normal" in dist ? (x) => normalCdf(x, dist.normal[0], dist.normal[1]) : (x) => lognormalCdf(x, dist.lognormal[0], dist.lognormal[1]));
  // A reference of one value needs no count of its own: the two-sample bound is then 1 or more.
  const few = values.length < KS_MIN_VALUES;
  return { how: two ? "ks2" : "ks1", stat, bound, pass: few || stat === null || bound === null || bound >= 1 ? null : stat <= bound };
}

function row(gap: string, measure: string, bar: string, value: string, verdict: Verdict, n: number): Row { return { gap, measure, bar, value, verdict, n }; }
const noData = (gap: string, measure: string, bar: string, why = "no step") => row(gap, measure, bar, why, "no data", 0);
const yes = (ok: boolean): Verdict => (ok ? "pass" : "fail");

/** A row of a distribution's comparison (P3, P5, K1, K2). */
function distRow(gap: string, measure: string, values: number[], dist: Dist): Row {
  const c = compareDist(values, dist), bar = c.how === "range" ? `all in ${distText(dist)}` : `KS vs ${distText(dist)}`;
  if (!values.length) return noData(gap, measure, bar);
  if (c.pass === null) return row(gap, measure, bar, `${values.length} values: too few`, "no data", values.length);
  const value = c.how === "range" ? `${f2(Math.min(...values))} to ${f2(Math.max(...values))}` : `D ${f2(c.stat!)} / ${f2(c.bound!)}`;
  return row(gap, measure, bar, value, yes(c.pass), values.length);
}

export type ScoreOptions = {
  /** XTEST's predicted points on each planned path that it played (by path id): P1's same-path row (design 9.1). */
  samePaths?: Record<string, number>;
  /** The beacon batches of the source's scenario that never came: every row is then "no data". */
  lostBatches?: number;
};

/** Every row of section 13.3 for one source's steps. A failed step is left out (and counted). */
export function scoreSource(all: readonly StepMeasures[], ref: Reference, opts: ScoreOptions = {}): Row[] {
  const steps = all.filter((s) => s.ok), failed = all.length - steps.length;
  const rows: Row[] = [row("all", "failed steps left out", "none", `${failed}`, "not scored", failed)];
  const of = (kinds: ReadonlySet<StepKind>) => steps.filter((s) => kinds.has(s.kind));
  const ptr = of(POINTER).filter((s) => s.pointer), P = ptr.map((s) => s.pointer!);
  const moves = sum(P.map((p) => p.moves)), fewMoves = `${moves} moves: fewer than ${BARS.minMoves}`;
  const withEvents = steps.filter((s) => s.events > 0);
  const rp = ref.pointer;

  // ---- P1 rate: the mean over the source's steps of each step's mean count. Samples: in the reference's per-path range
  // widened by BARS.countMargin (the lead's choice; design section 16). Predicted points: design 9.1's bar, XTEST's per-path
  // range on the same paths with no margin (the same-path row); with an XTEST reference the range row over all paths is
  // information only, with a person's reference (part B) it is the bar, with no margin.
  {
    const b = band(rp.samplesPerMove, BARS.countMargin), v = nums(P.map((p) => p.samplesPerMove)), m = mean(v), measure = "samples per pointermove (mean)";
    rows.push(m === null || !b ? noData("P1", measure, bandText(b)) : moves < BARS.minMoves ? noData("P1", measure, bandText(b), fewMoves)
      : row("P1", measure, bandText(b), `${f2(m)}`, yes(inBand(m, b)), v.length));
  }
  {
    const xtest = ref.source === SOURCE.xtest, b = band(rp.predictedPerMove), v = nums(P.map((p) => p.predictedPerMove)), m = mean(v);
    const measure = "predicted points per pointermove (mean)", bar = xtest ? `${bandText(b)} (information: the same-path row is the bar)` : bandText(b);
    rows.push(m === null || !b ? noData("P1", measure, bar) : moves < BARS.minMoves ? noData("P1", measure, bar, fewMoves)
      : row("P1", measure, bar, `${f2(m)}`, xtest ? "not scored" : yes(inBand(m, b)), v.length));
    const same = opts.samePaths ?? {}, on = ptr.filter((s) => s.path !== undefined && Object.hasOwn(same, s.path) && s.pointer!.predictedPerMove !== null);
    const sv = on.map((s) => s.pointer!.predictedPerMove!), xv = on.map((s) => same[s.path!]), sm = mean(sv), sameMoves = sum(on.map((s) => s.pointer!.moves));
    const sb: [number, number] | null = xv.length ? [Math.min(...xv), Math.max(...xv)] : null, sMeasure = "predicted points on XTEST's same paths (mean)";
    rows.push(sm === null || !sb ? noData("P1", sMeasure, "XTEST's per-path range on the same paths", "no step on XTEST's paths")
      : sameMoves < BARS.minMoves ? noData("P1", sMeasure, bandText(sb), `${sameMoves} moves: fewer than ${BARS.minMoves}`)
      : row("P1", sMeasure, bandText(sb), `${f2(sm)} (${sv.map(f2).join(", ")} against ${xv.map(f2).join(", ")})`, yes(inBand(sm, sb)), sv.length));
  }
  // ---- P2 times: the share of whole-ms sample gaps over all steps (30 gaps or more); events later than their handler.
  {
    const gaps = sum(P.map((p) => p.sampleGaps)), whole = sum(P.map((p) => p.wholeMsGaps)), ref1 = rp.wholeMsShare === 1;
    const measure = "sample gaps on a whole ms (share)";
    const bar = ref1 ? `every gap (${BARS.minGaps} gaps or more)` : `within 3 standard errors of ${f2(rp.wholeMsShare)} (${BARS.minGaps} gaps or more)`;
    if (gaps < BARS.minGaps) rows.push(noData("P2", measure, bar, `${gaps} gaps: fewer than ${BARS.minGaps}`));
    else {
      const share = whole / gaps, chance = wholeMsChance(), zRef = ref1 ? null : (share - rp.wholeMsShare) / Math.sqrt((rp.wholeMsShare * (1 - rp.wholeMsShare)) / gaps);
      rows.push(row("P2", measure, bar, `${f2(share)} (chance ${f2(chance)}, z ${binomialZ(whole, gaps, chance)!.toFixed(1)}${zRef === null ? "" : `; z against the reference ${zRef.toFixed(1)}`})`,
        yes(ref1 ? whole === gaps : Math.abs(zRef!) <= BARS.wholeMsZ), gaps));
    }
    const late = sum(P.map((p) => p.eventsAfterHandler));
    rows.push(P.length ? row("P2", "events later than their handler", "0", `${late}`, yes(late === 0), P.length) : noData("P2", "events later than their handler", "0"));
  }
  // ---- P3 shape: KS of each measure of the paths against the reference's paths. A path step with no path (one jump) fails.
  {
    const cand = of(PATHS).filter((s) => s.pointer && s.pointer.moves >= 1), paths = cand.map((s) => s.pointer!.path);
    const missing = paths.filter((p) => p === null).length;
    for (const [measure, key] of [["straightness", "straightness"], ["maximum deviation (px)", "maxDeviationPx"], ["peak speed (px/ms)", "peakPxPerMs"],
      ["mean speed (px/ms)", "meanPxPerMs"], ["time / Fitts's time", "fittsRatio"], ["speed peaks", "speedPeaks"]] as const) {
      const dist = rp[key];
      if (!cand.length) rows.push(noData("P3", measure, `KS vs ${distText(dist)}`));
      else if (missing) rows.push(row("P3", measure, `KS vs ${distText(dist)}`, `no path in ${missing} of ${cand.length} steps`, "fail", cand.length));
      else rows.push(distRow("P3", measure, nums(paths.map((p) => p![key])), dist));
    }
  }
  // ---- P4 the box: the entry at its edge, the moves inside and the time to the press in the reference's range.
  {
    const boxes = of(new Set<StepKind>(["box"])), B = boxes.map((s) => s.box);
    const edgeMax = Math.max(BARS.boxEdgeMinPx, band(rp.boxEntryEdgePx)?.[1] ?? 0);
    const mb = band(rp.boxMovesInside, BARS.boxMovesMargin), time = band(rp.boxEntryToPressMs, BARS.boxTimeMarginMs);
    const rowsOf: [string, string, (b: NonNullable<StepMeasures["box"]>) => number | null, (v: number) => boolean][] = [
      ["box entry from its edge (px)", `at most ${f2(edgeMax)}`, (b) => b.entryEdgePx, (v) => v <= edgeMax],
      ["box moves inside", bandText(mb), (b) => b.movesInside, (v) => !!mb && inBand(v, mb)],
      ["box entry to press (ms)", bandText(time), (b) => b.entryToPressMs, (v) => !!time && inBand(v, time)],
    ];
    for (const [measure, bar, get, ok] of rowsOf) {
      if (!boxes.length) { rows.push(noData("P4", measure, bar)); continue; }
      const v = B.map((b) => (b ? get(b) : null));
      const shown = v.map((x) => (x === null ? "none" : f2(x))).join(", ");
      rows.push(row("P4", measure, bar, shown, yes(v.every((x) => x !== null && ok(x))), v.length));
    }
  }
  // ---- P5 the pause before the press and the press: KS against the reference.
  const presses = of(PRESSES).filter((s) => s.pointer).map((s) => s.pointer!);
  rows.push(distRow("P5", "pause before the press (ms)", nums(presses.map((p) => p.pauseMs)), rp.pauseMs));
  rows.push(distRow("P5", "press (ms)", nums(presses.map((p) => p.pressMs)), rp.pressMs));
  // ---- P6 idle: measured, not scored (Q4).
  {
    const v = nums(steps.filter((s) => s.kind === "idle").map((s) => s.idleMovesPerS));
    rows.push(v.length ? row("P6", "idle moves per s", "by Q4", f2(mean(v)!), "not scored", v.length) : noData("P6", "idle moves per s", "by Q4"));
  }
  // ---- P7 wheel: notches of the reference's size with deltaMode 0 (a missing deltaMode fails), wheelDeltaY / deltaY -1, gaps in range; events per scroll (not scored).
  {
    const W = of(WHEEL).map((s) => s.wheel).filter((w) => w !== null && w.events > 0).map((w) => w!);
    const notch = ref.wheel.notchPx, gb = band(ref.wheel.gapMs);
    if (!W.length) {
      for (const [m, bar] of [["wheel notch (px, deltaMode 0)", `${notch}`], ["wheelDeltaY / deltaY", "-1"], ["wheel gaps (median ms)", bandText(gb)], ["wheel events per scroll", "none"]]) rows.push(noData("P7", m, bar));
    } else {
      const deltas = [...new Set(W.flatMap((w) => w.absDeltaY))], ratios = [...new Set(W.flatMap((w) => w.ratios))], modes = W.flatMap((w) => w.deltaModes);
      const missing = modes.filter((m) => m === null).length;
      rows.push(row("P7", "wheel notch (px, deltaMode 0)", `${notch}`, deltas.map(f2).join(", ") + (missing ? ` (${missing} with no deltaMode)` : ""),
        yes(W.every((w) => w.absDeltaY.every((d) => d === notch)) && modes.every((m) => m === 0)), W.length));
      rows.push(ratios.length ? row("P7", "wheelDeltaY / deltaY", "-1", ratios.map(f2).join(", "), yes(ratios.every((r) => Math.abs(r + 1) < 1e-6)), W.length)
        : noData("P7", "wheelDeltaY / deltaY", "-1", "no ratio"));
      const med = W.map((w) => median(w.gapsMs));
      rows.push(row("P7", "wheel gaps (median ms)", bandText(gb), med.map((m) => (m === null ? "no gap" : f2(m))).join(", "), yes(!!gb && med.every((m) => m !== null && inBand(m, gb))), W.length));
      rows.push(row("P7", "wheel events per scroll", "none", f2(mean(W.map((w) => w.events))!), "not scored", W.length));
    }
  }
  // ---- P8 phase: the median over the steps of each step's median, in the reference's per-path range (30 moves or more).
  {
    const b = band(rp.handlerLagMs, BARS.phaseMarginMs), v = nums(P.map((p) => p.handlerLagMs)), m = median(v), measure = "frame phase (median ms)";
    rows.push(m === null || !b ? noData("P8", measure, bandText(b)) : moves < BARS.minMoves ? noData("P8", measure, bandText(b), fewMoves)
      : row("P8", measure, bandText(b), f2(m), yes(inBand(m, b)), v.length));
  }
  // ---- K1 to K6: the keys of the typing steps.
  {
    const K = steps.filter((s) => s.kind === "type" && s.keys).map((s) => s.keys!);
    const rk = ref.keys, chars = sum(steps.filter((s) => s.text).map((s) => s.text!.chars));
    rows.push(distRow("K1", "key holds (ms)", K.flatMap((k) => k.holds), rk.holdMs));
    rows.push(distRow("K2", "press to press (all pairs, ms)", K.flatMap((k) => k.downToDown), rk.downToDownMs));
    {
      // K2 per letter pair (design 13.3): KS for each pair of the reference with BARS.minPairValues values or more in both.
      const measure = "press to press per letter pair", bar = `KS for each pair with ${BARS.minPairValues} values or more in both`;
      const src: Record<string, number[]> = {};
      for (const k of K) for (const [p, v] of Object.entries(k.pairs)) (src[p] ??= []).push(...v);
      const byPair = rk.downToDownByPairMs;
      const tested = byPair ? Object.entries(byPair).filter(([p, d]) => (Object.hasOwn(src, p) ? src[p].length : 0) >= BARS.minPairValues && (!Array.isArray(d) || d.length >= BARS.minPairValues))
        .map(([p, d]) => [p, compareDist(src[p], d)] as const).filter(([, c]) => c.pass !== null) : [];
      const passed = tested.filter(([, c]) => c.pass).length, worst = tested.filter(([, c]) => !c.pass).map(([p]) => JSON.stringify(p));
      rows.push(!byPair ? noData("K2", measure, bar, "no pair in the reference") : !tested.length ? noData("K2", measure, bar, `no pair with ${BARS.minPairValues} values in both`)
        : row("K2", measure, bar, `${passed} of ${tested.length} pairs pass${worst.length ? ` (not: ${worst.slice(0, 4).join(", ")})` : ""}`, yes(passed === tested.length), tested.length));
    }
    const we = nums(K.map((k) => k.wordEndExtraMs)), wb = band(rk.wordEndExtraMs), wm = median(we);
    rows.push(wm === null || !wb ? noData("K2", "pause at a word end (extra ms)", bandText(wb)) : row("K2", "pause at a word end (extra ms)", bandText(wb), f2(wm), yes(inBand(wm, wb)), we.length));
    const pairs = sum(K.map((k) => Math.max(0, k.keys - 1))), ob = band(rk.overlapShare);
    rows.push(!pairs || !ob ? noData("K3", "overlap share", bandText(ob)) : row("K3", "overlap share", bandText(ob), f2(sum(K.map((k) => k.overlaps)) / pairs), yes(inBand(sum(K.map((k) => k.overlaps)) / pairs, ob)), pairs));
    const shifted = sum(K.map((k) => k.shiftedChars)), withShift = sum(K.map((k) => k.shiftedWithShiftDown));
    rows.push(shifted ? row("K4", "shifted characters with a Shift keydown", "1", `${withShift} of ${shifted}`, yes(withShift === shifted), shifted) : noData("K4", "shifted characters with a Shift keydown", "1", "no shifted character"));
    const bs = sum(K.map((k) => k.backspaces));
    rows.push(K.length && chars ? row("K5", "Backspace per 100 characters", "not in the first build", f2((bs / chars) * 100), "not scored", chars) : noData("K5", "Backspace per 100 characters", "not in the first build"));
    const nl = sum(K.map((k) => k.numLockOn));
    rows.push(K.length ? row("K6", "keys with NumLock on", "0", `${nl}`, yes(nl === 0), K.length) : noData("K6", "keys with NumLock on", "0"));
  }
  // ---- R1/R2: a focus after the release at a press; jumps over 100 px (with P1 to P5 above).
  {
    const fp = of(FOCUS).map((s) => s.pointer?.focusInPress).filter((v) => v !== null && v !== undefined);
    const late = fp.filter((v) => v === false).length;
    rows.push(fp.length ? row("R1/R2", "focus after the release", "0", `${late} of ${fp.length}`, yes(late === 0), fp.length) : noData("R1/R2", "focus after the release", "0"));
    const j = sum(P.map((p) => p.jumps));
    rows.push(P.length ? row("R1/R2", "jumps over 100 px", "0", `${j}`, yes(j === 0), P.length) : noData("R1/R2", "jumps over 100 px", "0"));
  }
  // ---- R3/R14 and R4: the text steps that recorded events.
  {
    const T = of(TEXT).filter((s) => s.events > 0), fin = sum(T.map((s) => s.focusinWithNoPress));
    rows.push(T.length ? row("R3/R14", "focusin with no press (text fields)", "0", `${fin}`, yes(fin === 0), T.length) : noData("R3/R14", "focusin with no press (text fields)", "0", "no text step with events"));
    const X = T.map((s) => s.text).filter((t) => t !== null).map((t) => t!), bar = `every text input of ${TEXT_LIMIT} characters or less: one character, with a key event before it`;
    const chars = sum(X.map((t) => t.chars)), none = sum(X.map((t) => t.textsWithNoKeys)), long = sum(X.map((t) => t.longTextsWithNoKeys));
    rows.push(X.length ? row("R4", "key events per character (texts with none)", bar,
      `${f2(sum(X.map((t) => t.keyChars)) / Math.max(1, chars))} (${none} texts; ${long} above the limit)`, yes(none === 0), X.length) : noData("R4", "key events per character (texts with none)", bar));
  }
  // ---- R5/R6: scrolls with no wheel or key.
  {
    const W = steps.map((s) => s.wheel).filter((w) => w !== null && w.scrolls > 0), n = sum(W.map((w) => w!.scrollsWithNoWheelOrKey));
    rows.push(W.length ? row("R5/R6", "scrolls with no wheel or key", "0", `${n} of ${sum(W.map((w) => w!.scrolls))}`, yes(n === 0), W.length) : noData("R5/R6", "scrolls with no wheel or key", "0"));
  }
  // ---- R7/R15: untrusted events, measured, not scored (Q3).
  rows.push(withEvents.length ? row("R7/R15", "untrusted events", "by Q3", `${sum(withEvents.map((s) => s.untrusted))}`, "not scored", withEvents.length) : noData("R7/R15", "untrusted events", "by Q3", "no events"));
  // ---- R8: moves with the button down, and drag events, between the press and the drop.
  {
    const d = of(new Set<StepKind>(["drag"])).map((s) => s.pointer?.heldMoves ?? null), bar = `${BARS.heldMovesMin} or more`;
    rows.push(d.length ? row("R8", "moves or drag events with the button down before the drop", bar, d.map((v) => (v === null ? "none" : `${v}`)).join(", "), yes(d.every((v) => v !== null && v >= BARS.heldMovesMin)), d.length)
      : noData("R8", "moves or drag events with the button down before the drop", bar));
  }
  // ---- R9, R10, R11, M1, R12.
  {
    const fr = sum(P.map((p) => p.fractional));
    rows.push(P.length ? row("R9", "fractional points", "0", `${fr}`, yes(fr === 0), P.length) : noData("R9", "fractional points", "0"));
    // R10: no row of P1, P2 and P8 fails, and the three core rows (P1's samples, P2's share, P8) have data and pass.
    const parts = rows.filter((r) => r.gap === "P1" || r.gap === "P2" || r.gap === "P8"), fails = parts.filter((r) => r.verdict === "fail").length;
    const core = parts.filter((r) => /^(samples per pointermove|sample gaps on a whole ms|frame phase)/.test(r.measure)).map((r) => r.verdict);
    rows.push(row("R10", "P1, P2 and P8 together", "none fails; P1's samples, P2's share and P8 pass", `${parts.filter((r) => r.verdict === "pass").length} of ${parts.length} pass`,
      fails ? "fail" : core.length === 3 && core.every((v) => v === "pass") ? "pass" : "no data", parts.length));
    const jumps = steps.flatMap((s) => s.activationJumps);
    rows.push(jumps.length ? row("R11", "jump at an activation of the window (px)", "0", jumps.map(f2).join(", "), yes(jumps.every((v) => v < BARS.activationJumpPx)), jumps.length)
      : noData("R11", "jump at an activation of the window (px)", "0", "no activation"));
    const mm = sum(P.map((p) => p.movementMismatch));
    rows.push(P.length ? row("M1", "position changes the movement does not explain", "0", `${mm}`, yes(mm === 0), P.length) : noData("M1", "position changes the movement does not explain", "0"));
    const touch = sum(withEvents.map((s) => s.touch));
    rows.push(withEvents.length ? row("R12", "touch events", "0", `${touch}`, yes(touch === 0), withEvents.length) : noData("R12", "touch events", "0", "no events"));
  }
  // ---- R13: the modifier around the press; a double click's gap.
  {
    const mods = of(new Set<StepKind>(["modclick"])).map((s) => s.pointer);
    for (const [measure, key, min] of [["modifier down before the press (ms)", "modifierLeadMs", BARS.modifierLeadMinMs], ["modifier up after the release (ms)", "modifierLagMs", BARS.modifierLagMinMs]] as const) {
      const v = mods.map((p) => p?.[key] ?? null);
      rows.push(v.length ? row("R13", measure, `${min} or more`, v.map((x) => (x === null ? "none" : f2(x))).join(", "), yes(v.every((x) => x !== null && x >= min)), v.length) : noData("R13", measure, `${min} or more`));
    }
    const g = of(new Set<StepKind>(["dblclick"])).map((s) => s.pointer?.doubleClickGapMs ?? null), gb: [number, number] = [BARS.doubleClickMinMs, BARS.doubleClickMaxMs];
    rows.push(g.length ? row("R13", "double click gap (ms)", bandText(gb), g.map((x) => (x === null ? "none" : f2(x))).join(", "), yes(g.every((x) => x !== null && inBand(x, gb))), g.length)
      : noData("R13", "double click gap (ms)", bandText(gb)));
  }
  // ---- Lost beacon batches: the page's records of the scenario are not whole, so no row of it is scored.
  const lost = opts.lostBatches ?? 0;
  rows.splice(1, 0, row("all", "beacon batches lost", "0", `${lost}`, "not scored", lost));
  return lost > 0 ? rows.map((r) => (r.gap === "all" ? r : { ...r, value: `${lost} batches lost`, verdict: "no data" as Verdict, n: 0 })) : rows;
}

const MARK: Record<Verdict, string> = { pass: "ok", fail: "FAIL", "not scored": "(n/s)", "no data": "-" };

/** A fixed-width table: a line for each row, a column for each source, the cell "value verdict" ("-" for no data). */
export function textTable(scored: Record<string, Row[]>): string {
  const names = Object.keys(scored), first = scored[names[0]] ?? [];
  const cells = first.map((r, i) => [r.gap, r.measure, r.bar, ...names.map((n) => { const x = scored[n][i]; return x.verdict === "no data" ? "-" : `${x.value} ${MARK[x.verdict]}`; })]);
  const head = ["gap", "measure", "bar", ...names];
  const widths = head.map((h, c) => Math.max(h.length, ...cells.map((r) => r[c].length)));
  const line = (r: string[]) => r.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  return [line(head), widths.map((w) => "-".repeat(w)).join("  "), ...cells.map(line)].join("\n") + "\n";
}
