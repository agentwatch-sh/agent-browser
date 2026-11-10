// The input harness's bars and report (board ab-t30.2): each gap of the design's section 13.3
// (2026-11-10-vanilla-playwright-human-input-design.md) scored for one source against a reference (reference.ts). Pure;
// unit-tested in test/input-harness.test.ts.
//
// A row's verdict: "pass" (the bar holds), "fail", "not scored" (measured, but its bar waits for a decision: P6 for Q4,
// K5 for a later build, R7/R15 for Q3), or "no data" (the source has no step of the row's kind, or too few values for
// the row's test).

import type { StepKind, StepMeasures } from "./measures.ts";
import { type Dist, type Reference } from "./reference.ts";
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
  /** P2: the whole-ms share equals the reference's within this much. */
  wholeMsTol: 1e-6,
  /** P4: the entry is at the box's edge: at most this many px from it, or the reference's largest when that is more. */
  boxEdgeMinPx: 10,
  /** P4: the reference's range of moves inside the box, widened by this many moves; of the time from the entry to the press, by this many ms (5 samples at 125 Hz). */
  boxMovesMargin: 2, boxTimeMarginMs: 40,
  /** R8: more than 5 moves with the button down between the press and the drop. */
  heldMovesMin: 6,
  /** R13: the modifier goes down this long before the press and up this long after the release (design 10.2's Shift: 45 to 95 ms before, 15 to 60 ms after). */
  modifierLeadMinMs: 45, modifierLagMinMs: 15,
  /** R13: a double click's gap from the first release to the second press (design 10.1's first value). */
  doubleClickMinMs: 90, doubleClickMaxMs: 150,
};

const POINTER: ReadonlySet<StepKind> = new Set(["click", "hover", "move", "box", "dblclick", "modclick", "far", "drag"]);
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
  return { how: two ? "ks2" : "ks1", stat, bound, pass: stat === null || bound === null || bound >= 1 ? null : stat <= bound };
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

/** Every row of section 13.3 for one source's steps. */
export function scoreSource(steps: readonly StepMeasures[], ref: Reference): Row[] {
  const rows: Row[] = [];
  const of = (kinds: ReadonlySet<StepKind>) => steps.filter((s) => kinds.has(s.kind));
  const ptr = of(POINTER).filter((s) => s.pointer), P = ptr.map((s) => s.pointer!);
  const rp = ref.pointer;

  // ---- P1 rate: the mean over the source's steps of each step's mean count, in the reference's per-path range with a margin.
  for (const [measure, key, dist] of [["samples per pointermove (mean)", "samplesPerMove", rp.samplesPerMove], ["predicted points per pointermove (mean)", "predictedPerMove", rp.predictedPerMove]] as const) {
    const b = band(dist, BARS.countMargin), v = nums(P.map((p) => p[key])), m = mean(v);
    rows.push(m === null || !b ? noData("P1", measure, bandText(b)) : row("P1", measure, bandText(b), `${f2(m)}`, yes(inBand(m, b)), v.length));
  }
  // ---- P2 times: the share of whole-ms sample gaps over all steps; events later than their handler.
  {
    const gaps = sum(P.map((p) => p.sampleGaps)), whole = sum(P.map((p) => p.wholeMsGaps)), bar = `${f2(rp.wholeMsShare)}`;
    if (!gaps) rows.push(noData("P2", "sample gaps on a whole ms (share)", bar, "no gap"));
    else {
      const share = whole / gaps, chance = wholeMsChance();
      rows.push(row("P2", "sample gaps on a whole ms (share)", bar, `${f2(share)} (chance ${f2(chance)}, z ${binomialZ(whole, gaps, chance)!.toFixed(1)})`,
        yes(Math.abs(share - rp.wholeMsShare) <= BARS.wholeMsTol), gaps));
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
    const moves = band(rp.boxMovesInside, BARS.boxMovesMargin), time = band(rp.boxEntryToPressMs, BARS.boxTimeMarginMs);
    const rowsOf: [string, string, (b: NonNullable<StepMeasures["box"]>) => number | null, (v: number) => boolean][] = [
      ["box entry from its edge (px)", `at most ${f2(edgeMax)}`, (b) => b.entryEdgePx, (v) => v <= edgeMax],
      ["box moves inside", bandText(moves), (b) => b.movesInside, (v) => !!moves && inBand(v, moves)],
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
  // ---- P7 wheel: notches of the reference's size with deltaMode 0, wheelDeltaY / deltaY -1, gaps in range; events per scroll (not scored).
  {
    const W = of(WHEEL).map((s) => s.wheel).filter((w) => w !== null && w.events > 0).map((w) => w!);
    const notch = ref.wheel.notchPx, gb = band(ref.wheel.gapMs);
    if (!W.length) {
      for (const [m, bar] of [["wheel notch (px, deltaMode 0)", `${notch}`], ["wheelDeltaY / deltaY", "-1"], ["wheel gaps (median ms)", bandText(gb)], ["wheel events per scroll", "none"]]) rows.push(noData("P7", m, bar));
    } else {
      const deltas = [...new Set(W.flatMap((w) => w.absDeltaY))], ratios = [...new Set(W.flatMap((w) => w.ratios))];
      rows.push(row("P7", "wheel notch (px, deltaMode 0)", `${notch}`, deltas.map(f2).join(", "), yes(W.every((w) => w.absDeltaY.every((d) => d === notch) && w.deltaModes.every((m) => m === 0))), W.length));
      rows.push(row("P7", "wheelDeltaY / deltaY", "-1", ratios.map(f2).join(", "), yes(ratios.every((r) => Math.abs(r + 1) < 1e-6)), W.length));
      const med = W.map((w) => median(w.gapsMs));
      rows.push(row("P7", "wheel gaps (median ms)", bandText(gb), med.map((m) => (m === null ? "no gap" : f2(m))).join(", "), yes(!!gb && med.every((m) => m !== null && inBand(m, gb))), W.length));
      rows.push(row("P7", "wheel events per scroll", "none", f2(mean(W.map((w) => w.events))!), "not scored", W.length));
    }
  }
  // ---- P8 phase: the median over the steps of each step's median, in the reference's per-path range.
  {
    const b = band(rp.handlerLagMs, BARS.phaseMarginMs), v = nums(P.map((p) => p.handlerLagMs)), m = median(v);
    rows.push(m === null || !b ? noData("P8", "frame phase (median ms)", bandText(b)) : row("P8", "frame phase (median ms)", bandText(b), f2(m), yes(inBand(m, b)), v.length));
  }
  // ---- K1 to K6: the keys of the typing steps.
  {
    const K = steps.filter((s) => s.kind === "type" && s.keys).map((s) => s.keys!);
    const rk = ref.keys, chars = sum(steps.filter((s) => s.text).map((s) => s.text!.chars));
    rows.push(distRow("K1", "key holds (ms)", K.flatMap((k) => k.holds), rk.holdMs));
    rows.push(distRow("K2", "press to press (ms)", K.flatMap((k) => k.downToDown), rk.downToDownMs));
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
  // ---- R3/R14 and R4: the text steps.
  {
    const T = of(TEXT), fin = sum(steps.map((s) => s.focusinWithNoPress));
    rows.push(T.length ? row("R3/R14", "focusin with no press (text fields)", "0", `${fin}`, yes(fin === 0), T.length) : noData("R3/R14", "focusin with no press (text fields)", "0"));
    const X = T.map((s) => s.text).filter((t) => t !== null).map((t) => t!);
    const chars = sum(X.map((t) => t.chars)), none = sum(X.map((t) => t.textsWithNoKeys)), long = sum(X.map((t) => t.longTextsWithNoKeys));
    rows.push(X.length ? row("R4", "key events per character (texts with none)", "1 or more; 0 texts below the limit",
      `${f2(sum(X.map((t) => t.keyChars)) / Math.max(1, chars))} (${none} texts; ${long} above the limit)`, yes(none === 0), X.length) : noData("R4", "key events per character (texts with none)", "1 or more; 0 texts below the limit"));
  }
  // ---- R5/R6: scrolls with no wheel or key.
  {
    const W = steps.map((s) => s.wheel).filter((w) => w !== null && w.scrolls > 0), n = sum(W.map((w) => w!.scrollsWithNoWheelOrKey));
    rows.push(W.length ? row("R5/R6", "scrolls with no wheel or key", "0", `${n} of ${sum(W.map((w) => w!.scrolls))}`, yes(n === 0), W.length) : noData("R5/R6", "scrolls with no wheel or key", "0"));
  }
  // ---- R7/R15: untrusted events, measured, not scored (Q3).
  rows.push(row("R7/R15", "untrusted events", "by Q3", `${sum(steps.map((s) => s.untrusted))}`, "not scored", steps.length));
  // ---- R8: moves with the button down between the press and the drop.
  {
    const d = of(new Set<StepKind>(["drag"])).map((s) => s.pointer?.heldMoves ?? null), bar = `${BARS.heldMovesMin} or more`;
    rows.push(d.length ? row("R8", "moves with the button down before the drop", bar, d.map((v) => (v === null ? "none" : `${v}`)).join(", "), yes(d.every((v) => v !== null && v >= BARS.heldMovesMin)), d.length)
      : noData("R8", "moves with the button down before the drop", bar));
  }
  // ---- R9, R10, R11, R12.
  {
    const fr = sum(P.map((p) => p.fractional));
    rows.push(P.length ? row("R9", "fractional points", "0", `${fr}`, yes(fr === 0), P.length) : noData("R9", "fractional points", "0"));
    const parts = rows.filter((r) => r.gap === "P1" || r.gap === "P2" || r.gap === "P8").map((r) => r.verdict);
    const fails = parts.filter((v) => v === "fail").length;
    rows.push(row("R10", "P1, P2 and P8 together", "all pass", `${parts.filter((v) => v === "pass").length} of ${parts.length} pass`,
      fails ? "fail" : parts.includes("pass") ? "pass" : "no data", parts.length));
    const mm = sum(P.map((p) => p.movementMismatch));
    rows.push(P.length ? row("R11", "position changes the movement does not explain", "0", `${mm}`, yes(mm === 0), P.length) : noData("R11", "position changes the movement does not explain", "0"));
    const touch = sum(steps.map((s) => s.touch));
    rows.push(row("R12", "touch events", "0", `${touch}`, yes(touch === 0), steps.length));
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
  return rows;
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
