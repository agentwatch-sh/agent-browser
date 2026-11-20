// The fit of a person's recording (board ab-t30.13; the input design,
// docs/superpowers/specs/2026-11-10-vanilla-playwright-human-input-design.md, section 10.3; the research,
// docs/research/2026-11-09-click-box-input-signals.md, section 8): from the step numbers that the research's analyze.ts
// writes (`--numbers`), the medians, spreads and bounds that the parameter files (src/human/params/*.json) and the
// harness's reference take, each with its source. A reviewed change of a parameter file then takes them.
//
//   node src/human/fit.ts NUMBERS.json [--out FIT.json]
//
// NUMBERS.json comes from a path that the caller gives, outside the repository: a person's numbers stay out of it (the
// research's rule, section 8.4). The fit refuses a path inside the repository, for its input and for --out. Its output
// holds numbers and texts of its own only: no step's own values, no key, no point. A value that analyze.ts does not give
// (the research counted it from the harness's per-event measures) is in `notInNumbers` with its source, and has no value.
// The checks: no move of task 2 is shorter than Fitts's least time (300 ms, C11), and the parameter file's typing plan
// on part B's own lines fits about 40 to 50 characters in 10 s (C11, the typing rule).

import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { planText } from "./keys.ts";
import { middlePerson, paramsFor, type Params } from "./person.ts";
import { seededRandom } from "./random.ts";

/** A summary of values: their median, their p10 and p90 (the nearest rank), their range and their count. */
export type Summary = { n: number; median: number; p10: number; p90: number; min: number; max: number };
/** One fitted value: its numbers and its source. */
export type Fitted = Record<string, number | number[] | string> & { source: string };
export type Fit = {
  format: 1;
  values: Record<string, Fitted>;
  checks: Record<string, Fitted & { ok: number }>;
  /** The values that analyze.ts's numbers do not hold: each one's source (the research's own count). */
  notInNumbers: Record<string, string>;
};

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const nums = (a: unknown[]) => a.filter((v): v is number => typeof v === "number" && Number.isFinite(v));

/** The summary of some values, or null with none. */
export function summary(values: readonly number[]): Summary | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b), m = s.length >> 1, q = (p: number) => s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
  return { n: s.length, median: r3(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2), p10: r3(q(0.1)), p90: r3(q(0.9)), min: r3(s[0]), max: r3(s[s.length - 1]) };
}

/** A lognormal's median and sigma of some values: the values' median, and the standard deviation of their logs. */
export function lognormalOf(values: readonly number[]): [number, number] | null {
  const v = values.filter((x) => x > 0);
  if (v.length < 2) return null;
  const logs = v.map(Math.log), m = logs.reduce((a, b) => a + b, 0) / logs.length;
  const sd = Math.sqrt(logs.reduce((a, b) => a + (b - m) ** 2, 0) / (logs.length - 1));
  return [summary(v)!.median, r3(sd)];
}

type Step = { name: string; ok?: boolean; ms?: number; metrics: Record<string, any> };
const PART_B = "analyze.ts --numbers of part B (the research's section 8)";

/** The person's steps of a numbers file: its one scenario whose name starts with "person-" (a person's recording). */
function personSteps(numbers: unknown): { steps: Step[]; trains: Record<string, any> | null } {
  const scenarios = (numbers as { scenarios?: Record<string, { steps?: Step[]; wheelTrains?: Record<string, any> }> })?.scenarios;
  if (!scenarios || typeof scenarios !== "object") throw new Error("fit: not a numbers file of analyze.ts (no scenarios)");
  const people = Object.entries(scenarios).filter(([name]) => name.startsWith("person-"));
  if (people.length !== 1) throw new Error(`fit: the numbers file holds ${people.length} scenarios of a person's recording, not 1`);
  const sc = people[0][1];
  if (!Array.isArray(sc.steps)) throw new Error("fit: the person's scenario has no steps");
  return { steps: sc.steps.filter((s) => s && s.ok !== false && s.metrics && typeof s.metrics === "object"), trains: sc.wheelTrains ?? null };
}

/** A fitted value of a summary, or nothing with no values. */
function put(out: Record<string, Fitted>, key: string, values: number[], source: string, extra: Record<string, number | number[]> = {}): void {
  const s = summary(values);
  if (s) out[key] = { ...s, ...extra, source };
}

/** The share of values above a bound, rounded. */
const above = (values: readonly number[], bound: number) => r3(values.filter((v) => v > bound).length / Math.max(1, values.length));

/** Part B's three task lines (recorder.html, task 3; the research's section 8.4): the typing check plans them. */
export const TASK_LINES: readonly string[] = ["The quick brown fox jumps over the lazy dog.\n", "Meet me at 10:45 on Friday, OK?\n", "jane.doe@example.com\n"];

/**
 * The typing check: the parameter file's plan of part B's own lines at the middle person's speed (no fast end), as the
 * mean time from one key's press to the next and the characters that fit in 10 s (C11, the typing rule: about 40 to 50).
 */
export function typingCheck(params: Params = paramsFor("linux"), seeds = 200): Fitted & { ok: number } {
  const person = middlePerson(params);
  let ms = 0, keys = 0;
  for (let s = 0; s < seeds; s++) for (const [i, line] of TASK_LINES.entries()) {
    const ev = planText(line, person, seededRandom(1000 * s + i), { runSlowMs: Infinity }).events.filter((e) => e.type !== "keyUp" && !e.own).sort((a, b) => a.t - b.t);
    if (ev.length < 2) continue;
    ms += ev[ev.length - 1].t - ev[0].t;
    keys += ev.length - 1;
  }
  const perKey = ms / Math.max(1, keys), chars = 10000 / perKey;
  // "About 40 to 50": 5% around that range.
  return { msPerKey: r3(perKey), charsIn10s: r3(chars), ok: chars >= 38 && chars <= 52.5 ? 1 : 0,
    source: "the parameter file's plan (src/human/keys.ts planText, the middle person, no fast end) of part B's three task lines: about 40 to 50 characters in 10 s (C11, the typing rule; part B's mean of 207 ms a key gives about 48)" };
}

/** The fit of a numbers file's JSON (pure but for the typing check's plan of the parameter file). */
export function fitNumbers(numbers: unknown, params: Params = paramsFor("linux")): Fit {
  const { steps, trains } = personSteps(numbers);
  const task = (prefix: string) => steps.filter((s) => s.name.startsWith(prefix));
  const P = (s: Step) => s.metrics.pointer as Record<string, any> | undefined;
  const pointerSteps = steps.filter((s) => P(s) && typeof P(s)!.moves === "number" && P(s)!.moves > 0);
  const values: Record<string, Fitted> = {};
  // The rate (point 1): each step's median sample gap, mean samples and predicted points per pointermove.
  put(values, "rate.sampleGapMs", nums(pointerSteps.map((s) => P(s)!.sampleGapMs?.median)), `${PART_B}: each step's median gap between its samples (point 1; C11 STAGE_MOVE_MS)`);
  put(values, "rate.samplesPerMove", nums(pointerSteps.map((s) => P(s)!.coalesced?.mean)), `${PART_B}: each step's mean count of samples per pointermove (point 1; the harness's P1 on the Mac)`);
  put(values, "rate.predictedPerMove", nums(pointerSteps.map((s) => P(s)!.predicted?.mean)), `${PART_B}: each step's mean count of predicted points per pointermove (point 2; the harness's P1 on the Mac)`);
  // The path of task 2's moves (point 4): the peak speed, the straightness, the time of a long move.
  const t2 = task("2-targets").map((s) => P(s)?.path).filter((p) => p && typeof p.straightness === "number");
  const peaks = nums(t2.map((p) => p.peakPxPerMs)), straight = nums(t2.map((p) => p.straightness));
  put(values, "path.peakPxPerMs", peaks, `${PART_B}: task 2's moves (point 4; params device.maxPxPerMs and path.corrections)`, { above3_5: above(peaks, 3.5), above8: above(peaks, 8) });
  put(values, "path.straightness", straight, `${PART_B}: task 2's moves, chord / length (point 4; params path.arc)`, { above0_94: above(straight, 0.94) });
  put(values, "path.longMoveMs", nums(t2.filter((p) => p.lengthPx * p.straightness > 400).map((p) => p.ms)), `${PART_B}: task 2's moves with a chord over 400 px (point 4; C11's path time of 300 to 1000 ms)`);
  // The box (point 5): the samples inside the frame before the press (the path of the press's frame).
  put(values, "box.samples", nums(task("1-clickbox").map((s) => P(s)?.path?.samples)), `${PART_B}: task 1's samples in the box's frame before the press (point 5; params path.corrections; the harness's P4)`);
  // The pause and the press (point 6).
  const pressed = pointerSteps.filter((s) => typeof P(s)!.pressMs === "number");
  put(values, "press.pauseFromLastMoveMs", nums(pressed.map((s) => P(s)!.pauseBeforePressMs)), `${PART_B}: the time from the last pointermove to the press (point 6; the harness's P5 on the Mac)`);
  const holds = nums(pressed.map((s) => P(s)!.pressMs)), ln = lognormalOf(holds);
  put(values, "press.holdMs", holds, `${PART_B}: each step's press, pointerdown to pointerup (point 6; params press.holdMs, C11 holdMs 60 to 180 ms)`, ln ? { lognormal: ln } : {});
  // The Mac's device (point 10): the steps whose pointermoves all have a fractional point, the mouse events with one, and
  // each step's share of moves whose movement does not match the point.
  const frac = pointerSteps.filter((s) => P(s)!.fractional);
  if (frac.length) values["device.fractional"] = { steps: frac.length, allPointerMoves: frac.filter((s) => P(s)!.fractional.pointer === P(s)!.moves).length,
    mouseEvents: nums(frac.map((s) => P(s)!.fractional.mouse)).reduce((a, b) => a + b, 0), source: `${PART_B}: fractional points (point 10; the harness's R9 on the Mac)` };
  put(values, "device.movementMismatchShare", nums(pointerSteps.map((s) => (typeof P(s)!.movementMismatch === "number" ? P(s)!.movementMismatch / P(s)!.moves : undefined))),
    `${PART_B}: each step's share of moves whose movementX/Y does not match the point (point 10; the harness's M1 on the Mac)`);
  // The keys (point 9): each typing step's median hold and press to press; the overlap share of all of them.
  const typed = task("3-typing").map((s) => s.metrics.keys).filter((k) => k && typeof k.keydowns === "number");
  put(values, "keys.holdMsStepMedians", nums(typed.map((k) => k.holdMs?.median)), `${PART_B}: each typing step's median hold (point 9; params keys.holdMs)`,
    typed.length ? { range: [Math.min(...nums(typed.map((k) => k.holdMs?.range?.[0]))), Math.max(...nums(typed.map((k) => k.holdMs?.range?.[1])))] } : {});
  put(values, "keys.downToDownMsStepMedians", nums(typed.map((k) => k.downToDownMs?.median)), `${PART_B}: each typing step's median time from one key press to the next (point 9; params keys.baseMs)`);
  const pairs = typed.reduce((a, k) => a + Math.max(0, k.keydowns - (k.repeats ?? 0) - (k.shiftDowns ?? 0) - 1), 0), overlaps = typed.reduce((a, k) => a + (k.overlaps ?? 0), 0);
  if (pairs) values["keys.overlapShare"] = { share: r3(overlaps / pairs), overlaps, pairs, source: `${PART_B}: the typing steps' overlaps over their key pairs (point 9; params keys.baseMs and keys.pairMs; the harness's K3)` };
  const shifted = typed.reduce((a, k) => a + (k.shiftedChars ?? 0), 0);
  if (shifted) values["keys.shiftedWithShiftKeyDown"] = { share: r3(typed.reduce((a, k) => a + (k.shiftedWithShiftKeyDown ?? 0), 0) / shifted), shifted, source: `${PART_B}: shifted characters with a Shift keydown (point 9; the harness's K4)` };
  // The idle hand (point 7): task 6's pointer moves.
  const rest = task("6-rest");
  if (rest.length) values["idle.moves"] = { moves: rest.reduce((a, s) => a + (P(s)?.moves ?? 0), 0), steps: rest.length, source: `${PART_B}: task 6's pointer moves (point 7; C11: no idle moves, the answer Q4 a)` };
  // The wheel's trains (point 8): the Mac's wheel model is step B (board ab-t30.32).
  if (trains && Array.isArray(trains.trains)) {
    const T = trains.trains as Record<string, any>[];
    put(values, "wheel.eventsPerScroll", nums(T.map((t) => t.events)), `${PART_B}: the wheel trains' events (point 8; the harness's P7 on the Mac, board ab-t30.32)`);
    put(values, "wheel.peakPx", nums(T.map((t) => t.peakPx)), `${PART_B}: the trains' peak |deltaY| (point 8)`);
    put(values, "wheel.toPeak", nums(T.map((t) => t.toPeak)), `${PART_B}: the trains' events before the peak (point 8)`);
    put(values, "wheel.lastPx", nums(T.map((t) => t.lastPx)), `${PART_B}: the trains' last |deltaY| (point 8)`);
    put(values, "wheel.gapMs", nums(T.map((t) => t.gapMs)), `${PART_B}: the trains' median gaps (point 8)`);
    const d = trains.absDeltaYPx;
    if (d && Array.isArray(d.range)) values["wheel.absDeltaYPx"] = { median: d.median, p10: d.p10, p90: d.p90, range: d.range, ratios: nums(trains.wheelDeltaRatio ?? []), source: `${PART_B}: every wheel event's |deltaY| and wheelDeltaY / deltaY (point 8)` };
  }
  // The checks.
  const checks: Fit["checks"] = {};
  const t2ms = nums(t2.map((p) => p.ms));
  if (t2ms.length) checks["path.task2AtLeast300Ms"] = { below300: t2ms.filter((v) => v < 300).length, min: r3(Math.min(...t2ms)), ok: t2ms.every((v) => v >= 300) ? 1 : 0,
    source: `${PART_B}: no move of task 2 is shorter than Fitts's least time (C11: a path's time is 300 to 1000 ms)` };
  checks["keys.typing10s"] = typingCheck(params);
  return {
    format: 1, values, checks,
    notInNumbers: {
      "press.pause1PxMs": "the time from the last sample 1 px or more from the press point to the press: the research's section 8.3 point 6 (its own count from the harness's samples: a median of 49.5 ms, p10 35.3, p90 78.2; params press.pauseMs, C11 pauseMs)",
      "keys.holdMs": "every hold's median, mean and SD: the research's section 8.3 point 9 (the harness's holds: 80.3, 81.8 and 19.0 ms; params keys.holdMs)",
      "keys.downToDownMs": "every press to press's median and mean: the research's section 8.3 point 9 (the harness's downToDown: 128.9 and 207 ms; params keys.baseMs)",
      "keys.shiftBeforeMs": "the Shift's keydown to the character's: the research's section 8.3 point 9 (its own count: a median of 147.7 ms, 47.8 to 471.8; params keys.shift, C11 shiftBeforeMs)",
      "keys.shiftAfterMs": "the Shift's keyup after the character's: the research's section 8.3 point 9 (its own count: a median of 38.0 ms; C11 shiftAfterMs)",
      "keys.shiftOtherHand": "the Shift of the other hand's side: the research's section 8.3 point 9 (the harness's K4: 5 of 8; C11: about 70%)",
    },
  };
}

/** The repository's own folder (the parent of src/): the fit reads and writes no file in it. */
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
/** Whether a path is inside the repository (after its links). */
export function inRepo(path: string, repo = REPO): boolean {
  const p = real(resolve(path)), r = real(repo);
  return p === r || p.startsWith(r + sep);
}

if (import.meta.main) {
  const usage = "usage: node src/human/fit.ts NUMBERS.json [--out FIT.json]   (NUMBERS.json: analyze.ts --numbers, from outside the repository)";
  let input: string, out: string | undefined;
  try {
    const { values: v, positionals } = parseArgs({ allowPositionals: true, options: { out: { type: "string" } } });
    if (positionals.length !== 1) throw new Error("one numbers file");
    [input, out] = [positionals[0], v.out];
  } catch (e) { process.stderr.write(`${(e as Error).message}\n${usage}\n`); process.exit(2); }
  for (const p of [input, out]) if (p !== undefined && inRepo(p)) { process.stderr.write(`fit: ${p} is inside the repository: a person's numbers and their fit stay outside it\n`); process.exit(2); }
  try {
    const text = JSON.stringify(fitNumbers(JSON.parse(readFileSync(input, "utf8"))), null, 1) + "\n";
    if (out) writeFileSync(out, text, { mode: 0o600 }); else process.stdout.write(text);
  } catch (e) { process.stderr.write(`${(e as Error).message}\n`); process.exit(1); }
}
