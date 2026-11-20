// The fit of a person's recording (board ab-t30.13; src/human/fit.ts; the input design, section 10.3): from the step
// numbers of the research's analyze.ts (`--numbers`) to medians, spreads and bounds with their sources. Every number here
// is made up: no value of a person's recording is in the repository (the research's rule, section 8.4).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fitNumbers, inRepo, lognormalOf, summary, typingCheck } from "../src/human/fit.ts";
import { paramsFor } from "../src/human/person.ts";
import { tempDir } from "./temp-dirs.ts";

const FIT = new URL("../src/human/fit.ts", import.meta.url).pathname;

/** A made-up step of a person's numbers file, in analyze.ts's form. */
const step = (name: string, metrics: Record<string, unknown>) => ({ name, ok: true, ms: 1000, metrics });
const pointer = (o: Record<string, unknown> = {}) => ({ moves: 40, coalesced: { mean: 1.1 }, predicted: { mean: 2.4 }, sampleGapMs: { median: 8.2 }, fractional: { pointer: 40, mouse: 0, samples: 40 },
  movementMismatch: 16, ...o });
/** Made-up numbers: 5 moves of task 2, 3 trials of the box, 2 typing steps, a rest, and 2 wheel trains. */
function numbers() {
  const steps = [
    ...[[2, 0.97, 380, 300, 500], [4, 0.93, 700, 640, 800], [6, 0.9, 500, 420, 900], [3, 0.96, 350, 260, 600], [9, 0.95, 900, 520, 700]].map(([peak, straightness, ms, lengthPx, pressMs], i) =>
      step(`2-targets #${i}`, { pointer: pointer({ path: { samples: 60, ms, lengthPx, straightness, peakPxPerMs: peak }, pauseBeforePressMs: 20 + i, pressMs: pressMs / 6 }) })),
    ...[30, 41, 50].map((samples, i) => step(`1-clickbox #${i}`, { pointer: pointer({ path: { samples, ms: 600, lengthPx: 400, straightness: 0.9, peakPxPerMs: 3 }, pauseBeforePressMs: 15, pressMs: 80 + 10 * i, movementMismatch: 12 }) })),
    step("3-typing #0", { keys: { keydowns: 22, repeats: 0, shiftDowns: 2, overlaps: 3, holdMs: { median: 78, range: [45, 120] }, downToDownMs: { median: 130, range: [40, 600] }, shiftedChars: 2, shiftedWithShiftKeyDown: 2 } }),
    step("3-typing #1", { keys: { keydowns: 12, repeats: 1, shiftDowns: 0, overlaps: 1, holdMs: { median: 84, range: [50, 140] }, downToDownMs: { median: 126, range: [60, 900] }, shiftedChars: 0, shiftedWithShiftKeyDown: 0 } }),
    step("6-rest", {}),
    { name: "2-targets #9", ok: false, ms: 1, metrics: { pointer: pointer({ path: { samples: 2, ms: 10, lengthPx: 5, straightness: 0.1, peakPxPerMs: 99 } }) } },
  ];
  return { scenarios: { "person-device": { frameGapMs: 8.3, steps, wheelTrains: { splitMs: 100, absDeltaYPx: { p10: 2, median: 12, p90: 40, range: [1, 55] }, wheelDeltaRatio: [-3],
    trains: [{ events: 40, peakPx: 30, toPeak: 9, lastPx: 3, gapMs: 8.3 }, { events: 90, peakPx: 50, toPeak: 15, lastPx: 8, gapMs: 8.4 }] } } } };
}

test("fit: a summary (median, p10, p90 by the nearest rank, the range) and a lognormal's median and sigma of some values", () => {
  assert.deepEqual(summary([5, 1, 4, 2, 3]), { n: 5, median: 3, p10: 1, p90: 5, min: 1, max: 5 });
  assert.equal(summary([1, 2, 3, 4])!.median, 2.5);
  assert.equal(summary([]), null);
  const [m, sigma] = lognormalOf([50, 100, 200])!;
  assert.equal(m, 100);
  assert.ok(Math.abs(sigma - Math.log(2)) < 0.001, `${sigma}`);
  assert.equal(lognormalOf([100]), null, "one value has no spread");
});

test("fit: the numbers of a person's recording give each value with its source; a failed step is left out", () => {
  const f = fitNumbers(numbers());
  assert.equal(f.format, 1);
  const v = f.values;
  assert.deepEqual([v["path.peakPxPerMs"].median, v["path.peakPxPerMs"].max, v["path.peakPxPerMs"].above3_5, v["path.peakPxPerMs"].n], [4, 9, 0.6, 5], "the failed step's 99 px/ms is not in it");
  assert.deepEqual([v["path.straightness"].median, v["path.straightness"].above0_94], [0.95, 0.6]);
  assert.deepEqual([v["path.longMoveMs"].min, v["path.longMoveMs"].max, v["path.longMoveMs"].n], [700, 900, 2], "the moves with a chord over 400 px (length x straightness: 595 and 494 px)");
  assert.deepEqual([v["box.samples"].median, v["box.samples"].min, v["box.samples"].max], [41, 30, 50]);
  assert.deepEqual([v["press.pauseFromLastMoveMs"].median, v["press.pauseFromLastMoveMs"].n], [20.5, 8], "15, 15, 15 of the box; 20 to 24 of task 2");
  assert.equal(v["press.holdMs"].n, 8);
  assert.ok(Array.isArray(v["press.holdMs"].lognormal) && (v["press.holdMs"].lognormal as number[])[0] === v["press.holdMs"].median);
  assert.deepEqual([v["rate.sampleGapMs"].median, v["rate.samplesPerMove"].median, v["rate.predictedPerMove"].median], [8.2, 1.1, 2.4]);
  assert.deepEqual([v["device.fractional"].steps, v["device.fractional"].allPointerMoves, v["device.fractional"].mouseEvents], [8, 8, 0]);
  assert.deepEqual([v["device.movementMismatchShare"].min, v["device.movementMismatchShare"].max], [0.3, 0.4]);
  assert.deepEqual([v["keys.holdMsStepMedians"].median, v["keys.holdMsStepMedians"].range, v["keys.downToDownMsStepMedians"].median], [81, [45, 140], 128]);
  // Overlaps over the key pairs: (22 - 0 - 2 - 1) + (12 - 1 - 0 - 1) = 29 pairs, 4 overlaps.
  assert.deepEqual([v["keys.overlapShare"].share, v["keys.overlapShare"].pairs], [0.138, 29]);
  assert.equal(v["keys.shiftedWithShiftKeyDown"].share, 1);
  assert.deepEqual([v["idle.moves"].moves, v["idle.moves"].steps], [0, 1]);
  assert.deepEqual([v["wheel.eventsPerScroll"].min, v["wheel.eventsPerScroll"].max, v["wheel.peakPx"].max, v["wheel.absDeltaYPx"].range, v["wheel.absDeltaYPx"].ratios], [40, 90, 50, [1, 55], [-3]]);
  for (const [k, x] of Object.entries(v)) assert.ok(typeof x.source === "string" && /section 8|point \d+/.test(x.source), `${k}: its source`);
  // The values that analyze.ts does not give: each one names its source, and has no value.
  assert.deepEqual(Object.keys(f.notInNumbers).sort(), ["keys.downToDownMs", "keys.holdMs", "keys.shiftAfterMs", "keys.shiftBeforeMs", "keys.shiftOtherHand", "press.pause1PxMs"]);
  for (const s of Object.values(f.notInNumbers)) assert.match(s, /section 8\.3 point \d/);
  // The output holds no step's name, no key and no point of the recording.
  assert.doesNotMatch(JSON.stringify(f), /2-targets|clickbox|person-device/);
});

test("fit: the checks: no move of task 2 below Fitts's least time of 300 ms; the parameter file's typing plan fits about 40 to 50 characters in 10 s", () => {
  const ok = fitNumbers(numbers()).checks;
  assert.deepEqual([ok["path.task2AtLeast300Ms"].ok, ok["path.task2AtLeast300Ms"].below300, ok["path.task2AtLeast300Ms"].min], [1, 0, 350]);
  const short = numbers();
  short.scenarios["person-device"].steps[0].metrics.pointer = pointer({ path: { samples: 20, ms: 250, lengthPx: 200, straightness: 0.95, peakPxPerMs: 2 } });
  const c = fitNumbers(short).checks["path.task2AtLeast300Ms"];
  assert.deepEqual([c.ok, c.below300, c.min], [0, 1, 250]);
  // Board ab-t30.13's parameter file: part B's lines at the person's speed, about 48 characters in 10 s.
  const t = typingCheck(paramsFor("linux"), 60);
  assert.ok(t.ok === 1 && (t.charsIn10s as number) > 44 && (t.charsIn10s as number) < 52, `${t.charsIn10s} characters in 10 s (${t.msPerKey} ms a key)`);
  // The first values' slower typist would fit fewer characters.
  const L = paramsFor("linux"), slow = { ...L, keys: { ...L.keys, baseMs: { lognormal: [400, 0.3] as [number, number], min: 40, max: 1500 } } };
  assert.equal(typingCheck(slow, 20).ok, 0);
});

test("fit: a file that is not a person's numbers is refused", () => {
  assert.throws(() => fitNumbers({}), /not a numbers file/);
  assert.throws(() => fitNumbers({ scenarios: { xtest: { steps: [] } } }), /0 scenarios of a person's recording/);
  assert.throws(() => fitNumbers({ scenarios: { "person-a": { steps: [] }, "person-b": { steps: [] } } }), /2 scenarios/);
});

test("fit: the command reads a numbers file from outside the repository and writes the fit there; a path inside the repository is refused", () => {
  const dir = tempDir("ab-fit-"), file = join(dir, "numbers.json"), out = join(dir, "fit.json");
  writeFileSync(file, JSON.stringify(numbers()));
  const run = (...args: string[]) => spawnSync(process.execPath, [FIT, ...args], { encoding: "utf8" });
  const r = run(file, "--out", out);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(readFileSync(out, "utf8")).values["box.samples"].median, 41);
  const printed = run(file);
  assert.equal(printed.status, 0, printed.stderr);
  assert.equal(JSON.parse(printed.stdout).format, 1);
  const inside = new URL("./vectors/stage.json", import.meta.url).pathname;
  assert.ok(inRepo(inside) && !inRepo(file));
  const refused = run(inside);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /inside the repository/);
  const outInside = run(file, "--out", new URL("./fit-out.json", import.meta.url).pathname);
  assert.equal(outInside.status, 2, "no fit is written into the repository");
  assert.equal(run().status, 2, "the usage");
});
