// The input harness's bars and report (board ab-t30.2): each gap of the design's section 13.3
// (2026-11-10-vanilla-playwright-human-input-design.md) scored for one source against a reference (reference.ts). Pure;
// unit-tested in test/input-harness.test.ts.
//
// The bars for each platform (board ab-t30.13; the research's section 8.3, points 1, 3 and 10; the plan of ab-t30.13,
// section 2): the values of the hand (P3, P4, P5, K1 to K4) are the person's on both, and the values of the device
// differ. On Linux (os "linux") the device's rows (P1, P2, P8) score against XTEST at the same period, and R9, M1, R1/R2
// have a bar of 0; on the Mac (os "mac") they score against the person's recording (part B): a fractional point on every
// pointer event and on no mouse event (R9), the person's share of movements that do not match the point (M1), a jump
// over 100 px only inside a fast move (R1/R2), the pause from the last pointermove (P5), every sample in the box (P4),
// and a trackpad's wheel trains (P7).
//
// A row's verdict: "pass" (the bar holds), "fail", "not scored" (measured, but its bar waits for a decision: K5 for a
// later build, R7/R15 for Q3; or information: P1's range row of predicted points with an XTEST reference), or
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
   *  (binomialZ), so on Linux (X11) every gap must be whole; on the Mac (board ab-t30.13) the share against the person's is
   *  information, within wholeMsZ standard errors or not (a z test), and P1's gap distribution is the bar. Below it: no data. */
  minGaps: 30, wholeMsZ: 3,
  /** P4: the entry is at the box's edge: at most this many px from it, or the reference's largest when that is more. */
  boxEdgeMinPx: 10,
  /** P4: the reference's range of moves inside the box, widened by this many moves; of the time from the entry to the press, by this many ms (5 samples at 125 Hz). */
  boxMovesMargin: 2, boxTimeMarginMs: 40,
  /** R8: more than 5 moves with the button down, or drag events, between the press and the drop. */
  heldMovesMin: 6,
  /** R11: a jump at an activation of 1 px or more fails (points are whole px on Linux: the bar is 0). The jump is the change that the movement does not explain, or a change over 100 px on an axis or over a path's first step of 64 px in all (measures.ts, board ab-t30.15, board ab-t30.13). */
  activationJumpPx: 1,
  /** P1 on Linux (board ab-t30.13): XTEST's same-path row is the bar only for a source at XTEST's period, within this many ms (the mean of the sample gaps from 5 to 12 ms): PR #109 measured the predicted points to follow the period (the player at 8 ms 2.42, at 8.33 ms 1.92; XTEST at a true 8.0 ms 2.47). */
  periodTolMs: 0.1,
  /** M1 on the Mac (board ab-t30.13): the reference's per-step shares of moves whose movement does not match the point (part B: 0.30 to 0.53), widened by this much. */
  movementShareMargin: 0,
  /** P7 on the Mac (board ab-t30.13): a wheel event's wheelDeltaY / deltaY within this much of the reference's ratio (part B: -3, -2.95, -2.98). */
  wheelRatioTol: 0.1,
  /** K2 per letter pair: a pair is tested when the source and the reference each have this many values of it (two samples of 5: a KS bound of 0.86). */
  minPairValues: 5,
  /** K1 per key (board ab-t30.4): a key is tested when the source has this many holds of it (one sample of 5 against a model: a KS bound of 0.56). */
  minKeyValues: 5,
  /** K4: the share of Shift presses on the other hand's side (design 10.2's first value, about 70%): information. */
  shiftOtherHandShare: 0.7,
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

/** The platform of a source's records: its device's bars (board ab-t30.13). */
export type Os = "linux" | "mac";
/** A source's sample period (ms): the mean of its sample gaps from 5 to 12 ms (one device sample apart), or null with none. */
export function periodOf(gaps: readonly number[]): number | null {
  return mean(gaps.filter((g) => g >= 5 && g <= 12));
}

export type ScoreOptions = {
  /** The platform of the source's records (default linux): the device's bars of each platform (board ab-t30.13). */
  os?: Os;
  /** On Linux, the reference of the run's own XTEST steps for the device's rows (P1, P8) when `ref` is a person's (run.ts --reference FILE). */
  xtest?: Reference;
  /** XTEST's predicted points on each planned path that it played (by path id): P1's same-path row (design 9.1). */
  samePaths?: Record<string, number>;
  /** XTEST's samples (nc) of each pointermove on each planned path (by path id): open point 6's option c, KS on the same paths. */
  samePathCounts?: Record<string, number[]>;
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
  // The device's reference (board ab-t30.13): on Linux XTEST's at the same period (the run's own XTEST steps when `ref` is a
  // person's), on the Mac the person's (part B). The values of the hand (P3, P4, P5, keys) are `ref`'s on both.
  const mac = opts.os === "mac", dref = mac ? ref : opts.xtest ?? (ref.source === SOURCE.xtest ? ref : null), dp = dref?.pointer ?? null;
  const noDevice = "no XTEST reference on Linux", noXtestOnMac = "the Mac: no XTEST paths";

  // ---- P1 rate: the mean over the source's steps of each step's mean count. Samples: on Linux in XTEST's per-path range
  // widened by BARS.countMargin (the lead's choice; design section 16), on the Mac in the person's per-step range with no
  // margin (part B: 1.01 to 1.19). Predicted points: on Linux design 9.1's bar, XTEST's per-path range on the same paths
  // at the same period with no margin (the same-path row; the range row over all paths is information); on the Mac the
  // person's per-step range with no margin (part B: 2.15 to 2.79).
  {
    const b = dp ? band(dp.samplesPerMove, mac ? 0 : BARS.countMargin) : null, v = nums(P.map((p) => p.samplesPerMove)), m = mean(v), measure = "samples per pointermove (mean)";
    rows.push(!dp ? noData("P1", measure, bandText(b), noDevice) : m === null || !b ? noData("P1", measure, bandText(b)) : moves < BARS.minMoves ? noData("P1", measure, bandText(b), fewMoves)
      : row("P1", measure, bandText(b), `${f2(m)}`, yes(inBand(m, b)), v.length));
    // Open point 6's other options (design section 16), as information: option b, the per-path range with no margin; option c,
    // a two-sample KS of the pointermoves' counts on XTEST's same paths.
    const b0 = dp ? band(dp.samplesPerMove) : null, mb = "samples per pointermove, the range with no margin (point 6, option b)", bar0 = `${bandText(b0)} (information)`;
    rows.push(!dp ? noData("P1", mb, bar0, noDevice) : m === null || !b0 ? noData("P1", mb, bar0) : moves < BARS.minMoves ? noData("P1", mb, bar0, fewMoves)
      : row("P1", mb, bar0, `${f2(m)} (${inBand(m, b0) ? "inside" : "outside"})`, "not scored", v.length));
    const counts = opts.samePathCounts ?? {}, onPaths = ptr.filter((s) => s.path !== undefined && Object.hasOwn(counts, s.path));
    const sv = onPaths.flatMap((s) => s.pointer!.samplesEach ?? []), xv = onPaths.flatMap((s) => counts[s.path!]), mc = "samples per pointermove, KS of the counts on XTEST's paths (point 6, option c)";
    const c = compareDist(sv, xv), barC = "KS against XTEST's counts on the same paths (information)";
    rows.push(mac ? noData("P1", mc, barC, noXtestOnMac) : !onPaths.length ? noData("P1", mc, barC, "no step on XTEST's paths") : sv.length < BARS.minMoves ? noData("P1", mc, barC, `${sv.length} moves: fewer than ${BARS.minMoves}`)
      : row("P1", mc, barC, `D ${f2(c.stat ?? 0)} / ${f2(c.bound ?? 0)} (${c.pass ? "inside" : "outside"} the bound)`, "not scored", sv.length));
  }
  // P1's distributions (board ab-t30.3; the research's measure of P1): each pointermove's samples (nc) and each sample gap,
  // by a two-sample KS against the device reference's values; the predicted points (np) likewise, as information with an
  // XTEST reference (the same-path row below is the bar), and the bar with a person's reference.
  const each = (key: "samplesEach" | "predictedEach" | "gapsMs") => P.flatMap((p) => p[key] ?? []);
  const distOf = (measure: string, values: number[], dist: Dist | undefined, information: boolean): Row => {
    const bar = dist ? `KS vs ${distText(dist)}${information ? " (information)" : ""}` : "KS vs the reference's values";
    if (!dp) return noData("P1", measure, bar, noDevice);
    if (!dist) return noData("P1", measure, bar, "no values in the reference");
    if (moves < BARS.minMoves) return noData("P1", measure, bar, fewMoves);
    const r = distRow("P1", measure, values, dist);
    return information && (r.verdict === "pass" || r.verdict === "fail") ? { ...r, bar, verdict: "not scored" } : { ...r, bar };
  };
  rows.push(distOf("samples per pointermove (distribution)", each("samplesEach"), dp?.samplesEach, false));
  rows.push(distOf("sample gaps (distribution, ms)", each("gapsMs"), dp?.sampleGapsMs, false));
  {
    const xtest = dref?.source === SOURCE.xtest, b = dp ? band(dp.predictedPerMove) : null, v = nums(P.map((p) => p.predictedPerMove)), m = mean(v);
    const measure = "predicted points per pointermove (mean)", bar = xtest ? `${bandText(b)} (information: the same-path row is the bar)` : bandText(b);
    rows.push(!dp ? noData("P1", measure, bar, noDevice) : m === null || !b ? noData("P1", measure, bar) : moves < BARS.minMoves ? noData("P1", measure, bar, fewMoves)
      : row("P1", measure, bar, `${f2(m)}`, xtest ? "not scored" : yes(inBand(m, b)), v.length));
    // The same-path row: XTEST's predicted points on the same paths, the bar at the same period only (board ab-t30.13: the
    // predicted points follow the period, so a source at another period than XTEST's is information).
    const same = opts.samePaths ?? {}, on = ptr.filter((s) => s.path !== undefined && Object.hasOwn(same, s.path) && s.pointer!.predictedPerMove !== null);
    const sv = on.map((s) => s.pointer!.predictedPerMove!), xv = on.map((s) => same[s.path!]), sm = mean(sv), sameMoves = sum(on.map((s) => s.pointer!.moves));
    const sb: [number, number] | null = xv.length ? [Math.min(...xv), Math.max(...xv)] : null, sMeasure = "predicted points on XTEST's same paths (mean)";
    const xg = dp && Array.isArray(dp.sampleGapsMs) ? dp.sampleGapsMs : [], pSource = periodOf(on.flatMap((s) => s.pointer!.gapsMs ?? [])), pX = periodOf(xg);
    const other = pSource !== null && pX !== null && Math.abs(pSource - pX) > BARS.periodTolMs;
    rows.push(mac ? noData("P1", sMeasure, "XTEST's per-path range on the same paths", noXtestOnMac)
      : sm === null || !sb ? noData("P1", sMeasure, "XTEST's per-path range on the same paths", "no step on XTEST's paths")
      : sameMoves < BARS.minMoves ? noData("P1", sMeasure, bandText(sb), `${sameMoves} moves: fewer than ${BARS.minMoves}`)
      : row("P1", sMeasure, other ? `${bandText(sb)} at XTEST's period (information)` : bandText(sb),
        `${f2(sm)} (${sv.map(f2).join(", ")} against ${xv.map(f2).join(", ")})${other ? `; another period: ${f2(pSource!)} ms against XTEST's ${f2(pX!)} ms` : ""}`,
        other ? "not scored" : yes(inBand(sm, sb)), sv.length));
    rows.push(distOf("predicted points per pointermove (distribution)", each("predictedEach"), dp?.predictedEach, xtest));
  }
  // ---- P2 times: the share of whole-ms sample gaps over all steps (30 gaps or more); events later than their handler. On
  // Linux every gap is a whole ms (X11's times); on the Mac the share is information, and P1's gap distribution is the bar
  // (part B: the gaps cluster at 8.0 to 8.2 ms, so the share depends on the period; the research's section 8.3, point 3).
  {
    const gaps = sum(P.map((p) => p.sampleGaps)), whole = sum(P.map((p) => p.wholeMsGaps)), share0 = rp.wholeMsShare;
    const measure = "sample gaps on a whole ms (share)";
    const bar = !mac ? `every gap (${BARS.minGaps} gaps or more)` : `information: ${f2(share0)} in the reference (${BARS.minGaps} gaps or more)`;
    if (gaps < BARS.minGaps) rows.push(noData("P2", measure, bar, `${gaps} gaps: fewer than ${BARS.minGaps}`));
    else {
      const share = whole / gaps, chance = wholeMsChance(), zRef = !mac || share0 >= 1 || share0 <= 0 ? null : (share - share0) / Math.sqrt((share0 * (1 - share0)) / gaps);
      rows.push(row("P2", measure, bar, `${f2(share)} (chance ${f2(chance)}, z ${binomialZ(whole, gaps, chance)!.toFixed(1)}${zRef === null ? "" : `; z against the reference ${zRef.toFixed(1)}, ${Math.abs(zRef) <= BARS.wholeMsZ ? "inside" : "outside"} ${BARS.wholeMsZ} standard errors`})`,
        mac ? "not scored" : yes(whole === gaps), gaps));
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
  // ---- P4 the box: the entry at its edge, the samples inside and the time to the press in the reference's range. The
  // samples inside (board ab-t30.13; part B's count is its samples, 25 to 65): on Linux those that move 1 px or more from
  // the one before (a whole-px device sends no other), on the Mac every one (a trackpad's moves of less than 1 px count).
  {
    const boxes = of(new Set<StepKind>(["box"])), B = boxes.map((s) => s.box);
    const edgeMax = Math.max(BARS.boxEdgeMinPx, band(rp.boxEntryEdgePx)?.[1] ?? 0);
    const mb = band(rp.boxMovesInside, BARS.boxMovesMargin), time = band(rp.boxEntryToPressMs, BARS.boxTimeMarginMs);
    const rowsOf: [string, string, (b: NonNullable<StepMeasures["box"]>) => number | null, (v: number) => boolean][] = [
      ["box entry from its edge (px)", `at most ${f2(edgeMax)}`, (b) => b.entryEdgePx, (v) => v <= edgeMax],
      [mac ? "box samples inside (every one)" : "box samples inside (each 1 px or more from the one before)", bandText(mb), (b) => (mac ? b.samplesInside : b.movedSamplesInside), (v) => !!mb && inBand(v, mb)],
      ["box entry to press (ms)", bandText(time), (b) => b.entryToPressMs, (v) => !!time && inBand(v, time)],
    ];
    for (const [measure, bar, get, ok] of rowsOf) {
      if (!boxes.length) { rows.push(noData("P4", measure, bar)); continue; }
      const v = B.map((b) => (b ? get(b) : null));
      const shown = v.map((x) => (x === null ? "none" : f2(x))).join(", ");
      rows.push(row("P4", measure, bar, shown, yes(v.every((x) => x !== null && ok(x))), v.length));
    }
    // The straightness inside the box (board ab-t30.3): with an XTEST reference, information only: XTEST's box paths are
    // planned by the old generator (ghost-cursor), whose almost straight end is the research's gap P4 itself; with a person's
    // reference, in its range.
    const sr = rp.boxStraightness, sbd = sr ? band(sr) : null, xt = ref.source === SOURCE.xtest, ms = "box straightness inside (entry to press)";
    const sBar = !sbd ? "the reference's range" : xt ? `${bandText(sbd)} (information: XTEST's box paths are planned)` : bandText(sbd);
    const sv = B.map((b) => b?.straightness ?? null);
    rows.push(!boxes.length ? noData("P4", ms, sBar) : !sbd ? noData("P4", ms, sBar, "no values in the reference")
      : row("P4", ms, sBar, sv.map((x) => (x === null ? "none" : f2(x))).join(", "), xt ? "not scored" : yes(sv.every((x) => x !== null && inBand(x, sbd))), sv.length));
  }
  // ---- P5 the pause before the press and the press: KS against the reference. On Linux every move is 1 px or more, so the
  // pause from the last pointermove is the pause from the last move of 1 px or more (C11; part B: a median of 49.5 ms, the
  // reference's pause1PxMs when it has one); on the Mac the pause from the last pointermove (part B: a median of 19.1 ms,
  // with the trackpad's moves of less than 1 px; board ab-t30.13).
  const presses = of(PRESSES).filter((s) => s.pointer).map((s) => s.pointer!);
  rows.push(distRow("P5", mac ? "pause before the press, from the last pointermove (ms)" : "pause before the press, from the last move of 1 px or more (ms)",
    nums(presses.map((p) => p.pauseMs)), mac ? rp.pauseMs : rp.pause1PxMs ?? rp.pauseMs));
  rows.push(distRow("P5", "press (ms)", nums(presses.map((p) => p.pressMs)), rp.pressMs));
  // ---- P6 idle: a bar of 0 (the answer Q4 a: no idle moves; part B's task 6: no move in 10 s; board ab-t30.13).
  {
    const v = nums(steps.filter((s) => s.kind === "idle").map((s) => s.idleMovesPerS));
    rows.push(v.length ? row("P6", "idle moves per s", "0 (Q4 a)", f2(mean(v)!), yes(v.every((x) => x === 0)), v.length) : noData("P6", "idle moves per s", "0 (Q4 a)"));
    // The time from the page's load to its first move (board ab-t30.3): measured, not scored (Q4; part B's task 6 measures a person's).
    const l = nums(steps.map((s) => s.loadToFirstMoveMs)), lm = "load to the first move (ms)", lb = "by Q4 (part B)";
    rows.push(l.length ? row("P6", lm, lb, l.map(f2).join(", "), "not scored", l.length) : noData("P6", lm, lb, "no move after a load"));
  }
  // ---- P7 wheel: on Linux notches of the reference's size with deltaMode 0 (a missing deltaMode fails), wheelDeltaY / deltaY
  // -1, gaps in range; events per scroll (not scored). On the Mac a trackpad's trains (board ab-t30.13; part B: whole-px
  // deltas of 1 to 60 px with deltaMode 0, wheelDeltaY about -3 x deltaY, one event per frame, 36 to 133 events a scroll):
  // the reference's deltaPx, ratio and eventsPerScroll (no data with none: the Mac's wheel model is step B, board ab-t30.32).
  const W = of(WHEEL).map((s) => s.wheel).filter((w) => w !== null && w.events > 0).map((w) => w!);
  if (mac) {
    const rw = ref.wheel, gb = band(rw.gapMs), db = rw.deltaPx ? band(rw.deltaPx) : null, eb = rw.eventsPerScroll ? band(rw.eventsPerScroll) : null;
    const trains = "no train values in the reference", m0 = "wheel deltas (px, deltaMode 0)", mr = "wheelDeltaY / deltaY", mg = "wheel gaps (median ms)", me = "wheel events per scroll";
    const rBar = rw.ratio === undefined ? "the reference's ratio" : f2(rw.ratio);
    if (!W.length) for (const [m, bar] of [[m0, bandText(db)], [mr, rBar], [mg, bandText(gb)], [me, bandText(eb)]]) rows.push(noData("P7", m, bar));
    else {
      const deltas = W.flatMap((w) => w.absDeltaY), modes = W.flatMap((w) => w.deltaModes), ratios = W.flatMap((w) => w.ratios), missing = modes.filter((m) => m === null).length;
      rows.push(!db ? noData("P7", m0, "whole px in the reference's range", trains)
        : row("P7", m0, `whole px in ${bandText(db)}`, `${f2(Math.min(...deltas))} to ${f2(Math.max(...deltas))}` + (missing ? ` (${missing} with no deltaMode)` : ""),
          yes(deltas.every((d) => Number.isInteger(d) && inBand(d, db)) && modes.every((m) => m === 0)), W.length));
      rows.push(rw.ratio === undefined ? noData("P7", mr, rBar, trains) : !ratios.length ? noData("P7", mr, rBar, "no ratio")
        : row("P7", mr, `${rBar} (within ${f2(BARS.wheelRatioTol)})`, [...new Set(ratios.map(f2))].join(", "), yes(ratios.every((r) => Math.abs(r - rw.ratio!) <= BARS.wheelRatioTol + 1e-9)), W.length));
      const med = W.map((w) => median(w.gapsMs));
      rows.push(row("P7", mg, bandText(gb), med.map((m) => (m === null ? "no gap" : f2(m))).join(", "), yes(!!gb && med.every((m) => m !== null && inBand(m, gb))), W.length));
      const ev = mean(W.map((w) => w.events))!;
      rows.push(!eb ? noData("P7", me, "the reference's range", trains) : row("P7", me, bandText(eb), f2(ev), yes(inBand(ev, eb)), W.length));
    }
  } else {
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
  // ---- P8 phase: the median over the steps of each step's median, in the device reference's per-path range (30 moves or more).
  {
    const b = dp ? band(dp.handlerLagMs, BARS.phaseMarginMs) : null, v = nums(P.map((p) => p.handlerLagMs)), m = median(v), measure = "frame phase (median ms)";
    rows.push(!dp ? noData("P8", measure, bandText(b), noDevice) : m === null || !b ? noData("P8", measure, bandText(b)) : moves < BARS.minMoves ? noData("P8", measure, bandText(b), fewMoves)
      : row("P8", measure, bandText(b), f2(m), yes(inBand(m, b)), v.length));
  }
  // ---- K1 to K6: the keys of the typing steps.
  {
    const K = steps.filter((s) => s.kind === "type" && s.keys).map((s) => s.keys!);
    const rk = ref.keys, chars = sum(steps.filter((s) => s.text).map((s) => s.text!.chars));
    rows.push(distRow("K1", "key holds (ms)", K.flatMap((k) => k.holds), rk.holdMs));
    {
      // K1 per key (design 13.3, review-97's list on ab-t30.4): KS for each key with BARS.minKeyValues holds or more, against the
      // key's own reference (part B) when the reference has one, else against the reference of all holds.
      const measure = "key holds per key", bar = `KS for each key with ${BARS.minKeyValues} values or more (its own reference, else all holds')`;
      const src: Record<string, number[]> = {};
      for (const k of K) for (const [c, v] of Object.entries(k.holdsByKey ?? {})) (src[c] ??= []).push(...v);
      const own = rk.holdByKeyMs ?? {};
      const tested = Object.entries(src).filter(([, v]) => v.length >= BARS.minKeyValues)
        .map(([c, v]) => [c, compareDist(v, Object.hasOwn(own, c) ? own[c] : rk.holdMs)] as const).filter(([, c]) => c.pass !== null);
      const passed = tested.filter(([, c]) => c.pass).length, worst = tested.filter(([, c]) => !c.pass).map(([c]) => JSON.stringify(c));
      rows.push(!tested.length ? noData("K1", measure, bar, `no key with ${BARS.minKeyValues} values`)
        : row("K1", measure, bar, `${passed} of ${tested.length} keys pass${worst.length ? ` (not: ${worst.slice(0, 4).join(", ")})` : ""}`, yes(passed === tested.length), tested.length));
    }
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
    // K4's Shift (review-97's list on ab-t30.4): its location (1 left, 2 right: never CDP's default 0), its keyup after the
    // keyup of each shifted character that it holds, and its side against the hand of its first character (information).
    const downs = sum(K.map((k) => k.shiftDowns ?? 0)), located = sum(K.map((k) => (k.shiftLocations ?? []).filter((l) => l === 1 || l === 2).length));
    rows.push(downs ? row("K4", "Shift keydowns with a location of 1 or 2", "1", `${located} of ${downs}`, yes(located === downs), downs) : noData("K4", "Shift keydowns with a location of 1 or 2", "1", "no Shift keydown"));
    const after = sum(K.map((k) => k.shiftUpAfter ?? 0)), ma = "shifted characters whose Shift goes up after their keyup";
    rows.push(withShift ? row("K4", ma, "1", `${after} of ${withShift}`, yes(after === withShift), withShift) : noData("K4", ma, "1", "no shifted character with a Shift keydown"));
    const sided = sum(K.map((k) => k.shiftSided ?? 0)), other = sum(K.map((k) => k.shiftOtherHand ?? 0)), mo = "Shift on the other hand's side (share)";
    const barO = `about ${f2(BARS.shiftOtherHandShare)} (design 10.2; information)`;
    rows.push(sided ? row("K4", mo, barO, `${f2(other / sided)} (${other} of ${sided})`, "not scored", sided) : noData("K4", mo, barO, "no Shift keydown with a location before a shifted character"));
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
    // On the Mac a jump inside a fast move is allowed (part B: 3 moves of a fast flick moved over 100 px; board ab-t30.13).
    const j = sum(P.map((p) => (mac ? p.jumpsAfterGap : p.jumps))), mj = mac ? "jumps over 100 px outside a fast move" : "jumps over 100 px";
    rows.push(P.length ? row("R1/R2", mj, "0", `${j}`, yes(j === 0), P.length) : noData("R1/R2", mj, "0"));
  }
  // ---- R3/R14 and R4: the text steps that recorded events.
  {
    const T = of(TEXT).filter((s) => s.events > 0), fin = sum(T.map((s) => s.focusinWithNoPress));
    rows.push(T.length ? row("R3/R14", "focusin with no press (text fields)", "0", `${fin}`, yes(fin === 0), T.length) : noData("R3/R14", "focusin with no press (text fields)", "0", "no text step with events"));
    const X = T.map((s) => s.text).filter((t) => t !== null).map((t) => t!), bar = `every text input of ${TEXT_LIMIT} characters or less: one character, with a key event before it`;
    const chars = sum(X.map((t) => t.chars)), none = sum(X.map((t) => t.textsWithNoKeys)), long = sum(X.map((t) => t.longTextsWithNoKeys)), pastes = sum(X.map((t) => t.pastes ?? 0));
    rows.push(X.length ? row("R4", "key events per character (texts with none)", bar,
      `${f2(sum(X.map((t) => t.keyChars)) / Math.max(1, chars))} (${none} texts; ${long} above the limit, ${pastes} of them a person's paste)`, yes(none === 0), X.length) : noData("R4", "key events per character (texts with none)", bar));
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
    // R9: on Linux no fractional point (X11's points are whole px); on the Mac a fractional point on every pointer event and
    // on no mouse event (part B: every pointer event of the person, none of its mouse events; board ab-t30.13).
    if (mac) {
      const pp = sum(P.map((p) => p.pointerPoints)), fp = sum(P.map((p) => p.fractionalPointer)), fm = sum(P.map((p) => p.fractionalMouse)), m9 = "fractional points: pointer events, mouse events";
      rows.push(P.length ? row("R9", m9, "every pointer event, no mouse event", `${fp} of ${pp}, ${fm}`, yes(fp === pp && fm === 0), P.length) : noData("R9", m9, "every pointer event, no mouse event"));
    } else {
      const fr = sum(P.map((p) => p.fractional));
      rows.push(P.length ? row("R9", "fractional points", "0", `${fr}`, yes(fr === 0), P.length) : noData("R9", "fractional points", "0"));
    }
    // R10: no row of P1, P2 and P8 fails, and the three core rows have data and pass: P1's samples, P2's share and P8 on
    // Linux; P1's samples, P1's sample gaps and P8 on the Mac (P2's share is information there).
    const parts = rows.filter((r) => r.gap === "P1" || r.gap === "P2" || r.gap === "P8"), fails = parts.filter((r) => r.verdict === "fail").length;
    const coreRe = mac ? /^(samples per pointermove \(mean\)|sample gaps \(distribution|frame phase)/ : /^(samples per pointermove \(mean\)|sample gaps on a whole ms|frame phase)/;
    const core = parts.filter((r) => coreRe.test(r.measure)).map((r) => r.verdict);
    rows.push(row("R10", "P1, P2 and P8 together", mac ? "none fails; P1's samples and gaps and P8 pass" : "none fails; P1's samples, P2's share and P8 pass", `${parts.filter((r) => r.verdict === "pass").length} of ${parts.length} pass`,
      fails ? "fail" : core.length === 3 && core.every((v) => v === "pass") ? "pass" : "no data", parts.length));
    const jumps = steps.flatMap((s) => s.activationJumps);
    rows.push(jumps.length ? row("R11", "jump at an activation of the window (px)", "0", jumps.map(f2).join(", "), yes(jumps.every((v) => v < BARS.activationJumpPx)), jumps.length)
      : noData("R11", "jump at an activation of the window (px)", "0", "no activation"));
    // M1: on Linux 0; on the Mac the person's share of moves whose movement does not match the point (part B: 0.30 to 0.53 of
    // a step's moves; board ab-t30.13), from the reference's movementMismatchShare.
    const mm = sum(P.map((p) => p.movementMismatch)), m1 = "position changes the movement does not explain";
    if (mac) {
      const mb = rp.movementMismatchShare ? band(rp.movementMismatchShare, BARS.movementShareMargin) : null, share = moves ? mm / moves : null;
      rows.push(!P.length || share === null ? noData("M1", m1, bandText(mb)) : !mb ? noData("M1", m1, "the reference's share", "no share in the reference")
        : row("M1", m1, `a share in ${bandText(mb)}`, `${f2(share)} (${mm} of ${moves})`, yes(inBand(share, mb)), P.length));
    } else rows.push(P.length ? row("M1", m1, "0", `${mm}`, yes(mm === 0), P.length) : noData("M1", m1, "0"));
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
