// The input harness's reference (board ab-t30.2; design 2026-11-10-vanilla-playwright-human-input-design.md, section
// 13.3): what each gap is scored against. Pure; unit-tested in test/input-harness.test.ts.
//
// Until part B (board ab-t30.7: the operator's own recording on the Mac) exists, the run builds the reference from its
// own XTEST steps (real X input at 125 Hz on the harness's Xvfb: the design probe's `source` scenario) and takes the
// values that XTEST cannot give (a person's pause, press, keys and wheel gaps) from the literature and the design's
// first values (LITERATURE below). A later task replaces it with part B's numbers through one file: run.ts
// --reference FILE.
//
// The file's format (format 1). It holds numbers only: no string anywhere, so no user agent, screen, platform, window,
// device name, time or text can be in it; checkReference refuses any field that is not below, and any value that is not
// a number. Each distribution ("Dist") is one of:
//   [v1, v2, ...]                    measured values, one for each path, trial or step (scored by KS or by their range)
//   { "normal": [mean, sd] }         a model from a source
//   { "lognormal": [median, sigma] } a model from a source (sigma: the standard deviation of the log)
//   { "range": [low, high] }         a range from a source or a bar of the design
//
//   format   1
//   source   1: XTEST at 125 Hz on the harness's own Xvfb, with LITERATURE; 2: a person's recording (part B)
//   pointer  samplesPerMove, predictedPerMove   the mean count of samples and of predicted points per pointermove (P1)
//            samplesEach, predictedEach, sampleGapsMs (optional)   their distributions: each pointermove's nc and np, and
//                                               each sample gap in ms (P1's distributions; board ab-t30.3)
//            handlerLagMs                       the median handler time minus event time: the frame phase (P8)
//            wholeMsShare                       a number: the share of sample gaps on a whole ms (P2; 1 on Linux)
//            straightness, maxDeviationPx, peakPxPerMs, meanPxPerMs, fittsRatio, speedPeaks   the path's shape (P3)
//            pauseMs, pressMs                   the pause before a press and the press (P5)
//            boxEntryEdgePx, boxMovesInside, boxEntryToPressMs   the click box's own view (P4)
//            boxStraightness (optional)        the straightness of the box's samples from the entry to the press (P4)
//   keys     holdMs, downToDownMs, wordEndExtraMs, overlapShare   (K1 to K3)
//            downToDownByPairMs (optional): { "th": Dist, "he": Dist, ... }: press to press for each letter pair (K2 per
//            letter pair); each name is two characters of the US layout's printable set (space to tilde), in lower case
//            holdByKeyMs (optional): { "e": Dist, " ": Dist, ... }: the hold of each key (K1 per key; board ab-t30.4); each
//            name is one character of that set, in lower case
//   wheel    notchPx (a number: 120 on X11), gapMs   (P7)

import type { StepMeasures } from "./measures.ts";

export const REFERENCE_FORMAT = 1;
export const SOURCE = { xtest: 1, person: 2 } as const;
export type Dist = number[] | { normal: [number, number] } | { lognormal: [number, number] } | { range: [number, number] };
export type Reference = {
  format: 1;
  source: number;
  pointer: {
    samplesPerMove: Dist; predictedPerMove: Dist; handlerLagMs: Dist; wholeMsShare: number;
    straightness: Dist; maxDeviationPx: Dist; peakPxPerMs: Dist; meanPxPerMs: Dist; fittsRatio: Dist; speedPeaks: Dist;
    pauseMs: Dist; pressMs: Dist; boxEntryEdgePx: Dist; boxMovesInside: Dist; boxEntryToPressMs: Dist;
    samplesEach?: Dist; predictedEach?: Dist; sampleGapsMs?: Dist; boxStraightness?: Dist;
  };
  keys: { holdMs: Dist; downToDownMs: Dist; wordEndExtraMs: Dist; overlapShare: Dist; downToDownByPairMs?: Record<string, Dist>; holdByKeyMs?: Record<string, Dist> };
  wheel: { notchPx: number; gapMs: Dist };
};

/**
 * The values that XTEST cannot give, from the sources of the research (2026-11-09-click-box-input-signals.md, section
 * 11) and the design's first values (sections 8.2, 10.1, 10.2, 13.3):
 * - pause before a press: a lognormal, median 140 ms, from 80 to 400 ms (design 10.1); sigma = ln(400 / 80) / 4;
 * - press: a lognormal, median 100 ms, from 60 to 180 ms (design 10.1); sigma = ln(180 / 60) / 4;
 * - sample gaps on a whole ms: 100% on Linux (X11's time is in ms; research section 6);
 * - key hold: mean 116 ms, SD 24 [19];
 * - press to press: mean 239 ms, SD 112 [19], as a lognormal: lognormalOf(239, 112) = [216.4, 0.446];
 * - the extra pause at a word end: 20 to 120 ms after a space, 80 to 250 after a mark, 200 to 600 at a line end (design 10.2);
 * - the overlap share: 15% to 50% (the bar of design 13.3; [19]: about 25% for an average typist, 50% for a fast one);
 * - the wheel: a notch of 120 px on X11 (research section 3); gaps of 35 to 90 ms (design 8.2's first value).
 */
export const LITERATURE: { pointer: Pick<Reference["pointer"], "pauseMs" | "pressMs" | "wholeMsShare">; keys: Reference["keys"]; wheel: Reference["wheel"] } = {
  pointer: { pauseMs: { lognormal: [140, 0.4] }, pressMs: { lognormal: [100, 0.275] }, wholeMsShare: 1 },
  keys: { holdMs: { normal: [116, 24] }, downToDownMs: { lognormal: [216.4, 0.446] }, wordEndExtraMs: { range: [20, 600] }, overlapShare: { range: [0.15, 0.5] } },
  wheel: { notchPx: 120, gapMs: { range: [35, 90] } },
};

const D = "dist", N = "number", PAIRS = "pairs", KEYS = "keys";
/** Fields that a file may leave out. */
const OPTIONAL = new Set(["keys.downToDownByPairMs", "keys.holdByKeyMs", "pointer.samplesEach", "pointer.predictedEach", "pointer.sampleGapsMs", "pointer.boxStraightness"]);
const PAIR = /^[\x20-\x7e]{2}$/, KEY = /^[\x20-\x7e]$/;
const SCHEMA: Record<string, Record<string, string>> = {
  pointer: { samplesPerMove: D, predictedPerMove: D, handlerLagMs: D, wholeMsShare: N, straightness: D, maxDeviationPx: D, peakPxPerMs: D, meanPxPerMs: D,
    fittsRatio: D, speedPeaks: D, pauseMs: D, pressMs: D, boxEntryEdgePx: D, boxMovesInside: D, boxEntryToPressMs: D,
    samplesEach: D, predictedEach: D, sampleGapsMs: D, boxStraightness: D },
  keys: { holdMs: D, downToDownMs: D, wordEndExtraMs: D, overlapShare: D, downToDownByPairMs: PAIRS, holdByKeyMs: KEYS },
  wheel: { notchPx: N, gapMs: D },
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
function refuse(path: string, why: string): never { throw new Error(`reference: ${path}: ${why}`); }

function checkDist(v: unknown, path: string): void {
  if (Array.isArray(v)) {
    if (!v.length) refuse(path, "no values");
    v.forEach((x, i) => { if (!isNum(x)) refuse(`${path}[${i}]`, "not a number"); });
    return;
  }
  if (!isObj(v)) refuse(path, "not a list of numbers, a normal, a lognormal or a range");
  const keys = Object.keys(v);
  if (keys.length !== 1 || !["normal", "lognormal", "range"].includes(keys[0])) refuse(path, `one of normal, lognormal or range, not ${keys.join(", ") || "nothing"}`);
  const pair = v[keys[0]];
  if (!Array.isArray(pair) || pair.length !== 2 || !pair.every(isNum)) refuse(`${path}.${keys[0]}`, "two numbers");
  const [a, b] = pair as number[];
  if (keys[0] === "normal" && !(b > 0)) refuse(path, "a normal's standard deviation is above 0");
  if (keys[0] === "lognormal" && !(a > 0 && b > 0)) refuse(path, "a lognormal's median and sigma are above 0");
  if (keys[0] === "range" && !(a <= b)) refuse(path, "a range's low end is not above its high end");
}

function checkPairs(v: unknown, path: string): void {
  if (!isObj(v)) refuse(path, "not an object of letter pairs");
  const keys = Object.keys(v);
  if (!keys.length) refuse(path, "no pairs");
  for (const k of keys) {
    if (!PAIR.test(k)) refuse(`${path}.${k}`, "not a letter pair (two characters from space to tilde)");
    checkDist(v[k], `${path}.${k}`);
  }
}

function checkKeys(v: unknown, path: string): void {
  if (!isObj(v)) refuse(path, "not an object of keys");
  const keys = Object.keys(v);
  if (!keys.length) refuse(path, "no keys");
  for (const k of keys) {
    if (!KEY.test(k)) refuse(`${path}.${k}`, "not a key (one character from space to tilde)");
    checkDist(v[k], `${path}.${k}`);
  }
}

/** The reference of a file's JSON, or an error that names the first wrong field. Every name is checked as an own name (Object.hasOwn), so the names that every object inherits (constructor, toString, __proto__) are refused. */
export function checkReference(raw: unknown): Reference {
  if (!isObj(raw)) refuse("the file", "not a JSON object");
  const top = ["format", "source", ...Object.keys(SCHEMA)];
  for (const k of Object.keys(raw)) if (!top.includes(k)) refuse(k, "not a field (the file holds numbers only, in the fields of format 1)");
  for (const k of top) if (!Object.hasOwn(raw, k)) refuse(k, "missing");
  if (raw.format !== REFERENCE_FORMAT) refuse("format", `${REFERENCE_FORMAT} is the only format`);
  if (raw.source !== SOURCE.xtest && raw.source !== SOURCE.person) refuse("source", `${SOURCE.xtest} (XTEST) or ${SOURCE.person} (a person's recording)`);
  for (const [part, fields] of Object.entries(SCHEMA)) {
    const o = raw[part];
    if (!isObj(o)) refuse(part, "not an object");
    for (const k of Object.keys(o)) if (!Object.hasOwn(fields, k)) refuse(`${part}.${k}`, "not a field (the file holds numbers only, in the fields of format 1)");
    for (const [k, kind] of Object.entries(fields)) {
      if (!Object.hasOwn(o, k)) { if (OPTIONAL.has(`${part}.${k}`)) continue; refuse(`${part}.${k}`, "missing"); }
      if (kind === N) { if (!isNum(o[k])) refuse(`${part}.${k}`, "not a number"); }
      else if (kind === PAIRS) checkPairs(o[k], `${part}.${k}`);
      else if (kind === KEYS) checkKeys(o[k], `${part}.${k}`);
      else checkDist(o[k], `${part}.${k}`);
    }
  }
  return raw as Reference;
}

const PATH_KINDS = new Set(["click", "hover", "move"]);
/** The optional fields that have values (a list of none is left out: checkDist refuses an empty list). */
const optional = (o: Record<string, number[]>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v.length));
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const vals = (list: (number | null | undefined)[]) => list.filter((v): v is number => isNum(v)).map(r3);

/** The reference of a run's XTEST steps (the steps that passed): per-path values for P1, P3 and P8, every pointermove's and sample gap's values for P1's distributions, per-trial values for P4, and LITERATURE for the rest. */
export function buildReference(all: readonly StepMeasures[]): Reference {
  const xtest = all.filter((s) => s.ok); // a failed step is left out
  const paths = xtest.filter((s) => PATH_KINDS.has(s.kind) && s.pointer && s.pointer.moves >= 5);
  const shapes = paths.map((s) => s.pointer!.path).filter((p) => p !== null);
  const boxes = xtest.filter((s) => s.kind === "box" && s.box).map((s) => s.box!);
  if (!shapes.length) throw new Error("reference: the XTEST steps have no path");
  if (!boxes.length) throw new Error("reference: the XTEST steps have no box step");
  return checkReference({
    format: 1,
    source: SOURCE.xtest,
    pointer: {
      samplesPerMove: vals(paths.map((s) => s.pointer!.samplesPerMove)), predictedPerMove: vals(paths.map((s) => s.pointer!.predictedPerMove)),
      handlerLagMs: vals(paths.map((s) => s.pointer!.handlerLagMs)), wholeMsShare: LITERATURE.pointer.wholeMsShare,
      straightness: vals(shapes.map((p) => p.straightness)), maxDeviationPx: vals(shapes.map((p) => p.maxDeviationPx)), peakPxPerMs: vals(shapes.map((p) => p.peakPxPerMs)),
      meanPxPerMs: vals(shapes.map((p) => p.meanPxPerMs)), fittsRatio: vals(shapes.map((p) => p.fittsRatio)), speedPeaks: vals(shapes.map((p) => p.speedPeaks)),
      pauseMs: LITERATURE.pointer.pauseMs, pressMs: LITERATURE.pointer.pressMs,
      boxEntryEdgePx: vals(boxes.map((b) => b.entryEdgePx)), boxMovesInside: vals(boxes.map((b) => b.movesInside)), boxEntryToPressMs: vals(boxes.map((b) => b.entryToPressMs)),
      ...optional({ samplesEach: vals(paths.flatMap((s) => s.pointer!.samplesEach ?? [])), predictedEach: vals(paths.flatMap((s) => s.pointer!.predictedEach ?? [])),
        sampleGapsMs: vals(paths.flatMap((s) => s.pointer!.gapsMs ?? [])), boxStraightness: vals(boxes.map((b) => b.straightness)) }),
    },
    keys: LITERATURE.keys,
    wheel: LITERATURE.wheel,
  });
}
