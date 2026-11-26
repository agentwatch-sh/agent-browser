// The press and hold's plan (board ab-t30.34; C11, the press and hold; src/human/hold.ts): the hand's moves with the
// button down (1 px steps, at most 2 px from the press point, gaps of 150 to 600 ms), the release's delay, the limit of
// maxMs, the end by the pixels (PixelWatch) and the answer's texts. Pure: a seeded random source, no stage.

import { test } from "node:test";
import assert from "node:assert/strict";
import { handMoves, handStep, HOLD, holdLimit, holdText, moveGapMs, PixelWatch, releaseAfterMs, SNAPSHOT_REF } from "../src/human/hold.ts";
import { seededRandom } from "../src/human/random.ts";
import { STAGE_ACTION_MAX_MS } from "../src/relay/stage.ts";

test("the hand's moves: each a step of 1 px along one axis, never more than 2 px from the press point, never 4 px (Chrome's drag), at gaps of 150 to 600 ms", () => {
  const press = { x: 300, y: 200 };
  let all = 0;
  const far = new Set<number>();
  for (let seed = 1; seed <= 40; seed++) {
    const r = seededRandom(seed);
    const ms = handMoves(press, 20_000, r);
    assert.ok(ms.length >= 20_000 / 600 - 1 && ms.length <= 20_000 / 150, `seed ${seed}: ${ms.length} moves in 20 s`);
    let at = press, t = 0;
    for (const m of ms) {
      const step = Math.abs(m.x - at.x) + Math.abs(m.y - at.y);
      assert.equal(step, 1, `seed ${seed}: a step of 1 px along one axis`);
      assert.ok(Number.isInteger(m.x) && Number.isInteger(m.y), "whole px");
      const d = Math.hypot(m.x - press.x, m.y - press.y);
      assert.ok(d <= HOLD.moveMaxPx + 1e-9, `seed ${seed}: ${d} px from the press point`);
      assert.ok(Math.abs(m.x - press.x) < 4 && Math.abs(m.y - press.y) < 4, "under Chrome's drag start");
      far.add(Math.round(d * 100));
      assert.ok(m.t - t >= HOLD.moveGapMs[0] - 1e-9 && m.t - t <= HOLD.moveGapMs[1] + 1e-9, `seed ${seed}: a gap of ${m.t - t} ms`);
      at = m; t = m.t;
    }
    all += ms.length;
  }
  assert.ok(all > 1000);
  assert.ok(far.has(200), "the hand reaches 2 px");
  assert.ok(far.has(0) && far.has(100), "and comes back");
});

test("handStep: from a point at 2 px it never goes farther; with no step inside the bound it stays at the press point", () => {
  const press = { x: 0, y: 0 }, r = seededRandom(7);
  for (let i = 0; i < 500; i++) {
    const p = handStep({ x: 2, y: 0 }, press, r);
    assert.ok(Math.hypot(p.x, p.y) <= 2 && Math.abs(p.x - 2) + Math.abs(p.y) === 1, `${p.x},${p.y}`);
    const q = handStep({ x: 1, y: 1 }, press, r);
    assert.ok([[0, 1], [1, 0]].some(([x, y]) => q.x === x && q.y === y), `${q.x},${q.y}`);
  }
});

test("the gaps and the release's delay: inside their ranges, and spread over them", () => {
  const r = seededRandom(3);
  const gaps = Array.from({ length: 2000 }, () => moveGapMs(r)), rel = Array.from({ length: 2000 }, () => releaseAfterMs(r));
  assert.ok(gaps.every((g) => g >= 150 && g <= 600) && Math.min(...gaps) < 170 && Math.max(...gaps) > 580);
  assert.ok(rel.every((g) => g >= 150 && g <= 400) && Math.min(...rel) < 160 && Math.max(...rel) > 390);
});

test("maxMs: 15000 by default; a whole number from 1000 to 20000, under the stage's action limit; anything else is a refusal", () => {
  assert.equal(holdLimit(undefined), 15_000);
  assert.equal(holdLimit(1000), 1000);
  assert.equal(holdLimit(20_000), 20_000);
  assert.ok(HOLD.maxMs < STAGE_ACTION_MAX_MS, "the most stays under STAGE_ACTION_MAX_MS");
  for (const v of [999, 20_001, 1500.5, "5000", null, -1, Infinity]) assert.deepEqual(holdLimit(v), { why: "maxMs must be a whole number of ms from 1000 to 20000." }, String(v));
});

test("the ref: only a snapshot ref of the pinned MCP (e<n>, f<n>e<n>), never a selector", () => {
  for (const ok of ["e1", "e123", "f1e3", "f12e45"]) assert.ok(SNAPSHOT_REF.test(ok), ok);
  for (const no of ["", "E1", "e", "f1", "#px-captcha", "button", "e1 ", "e1,e2", "role=button", "f1e"]) assert.ok(!SNAPSHOT_REF.test(no), no);
});

test("PixelWatch: done only after a change and then the same pixels for 300 ms; a still element never; a fill that keeps changing never; a failed read changes nothing", () => {
  // A fill that grows for 1 s, then its check mark, then nothing moves.
  const w = new PixelWatch();
  const reads: [number, string | null][] = [[100, "a"], [200, "b"], [300, "c"], [400, null], [500, "d"], [1100, "e"], [1200, "done"], [1300, "done"], [1400, "done"]];
  const out = reads.map(([t, s]) => w.read(t, s));
  assert.deepEqual(out, [false, false, false, false, false, false, false, false, false], "no done before 300 ms of the same pixels");
  assert.equal(w.read(1500, "done"), true, "300 ms after the last change");
  assert.ok(w.changed && w.reads);
  // A still element (a check that does not react): never done.
  const still = new PixelWatch();
  for (let t = 100; t <= 5000; t += 100) assert.equal(still.read(t, "same"), false);
  assert.ok(!still.changed && still.reads);
  // A fill that changes at each read: never done.
  const moving = new PixelWatch();
  for (let t = 100; t <= 5000; t += 100) assert.equal(moving.read(t, `f${t}`), false);
  // Failed reads only: no baseline.
  const none = new PixelWatch();
  for (let t = 100; t <= 1000; t += 100) assert.equal(none.read(t, null), false);
  assert.ok(!none.reads);
  // A fill that pauses for less than 300 ms is not done.
  const pause = new PixelWatch();
  assert.deepEqual([[100, "a"], [200, "b"], [300, "b"], [400, "b"], [450, "c"], [800, "c"]].map(([t, s]) => pause.read(t as number, s as string)), [false, false, false, false, false, true]);
});

test("the answer's texts: done, a navigation, an element gone, the time limit with its reason, an early end, and no press", () => {
  const base = { ok: true as const, heldMs: 4321, moves: 9, maxMs: 15000, pixels: "changing" as const };
  assert.equal(holdText({ ...base, end: "done" }), "Done: the hold lasted 4321 ms; it ended when the element changed and then stayed the same.");
  assert.equal(holdText({ ...base, end: "navigation" }), "Done: the hold lasted 4321 ms; it ended when the page navigated.");
  assert.equal(holdText({ ...base, end: "gone" }), "Done: the hold lasted 4321 ms; it ended when the element went away.");
  assert.equal(holdText({ ...base, end: "limit" }), "Time limit: the hold lasted 4321 ms, the limit of 15000 ms; the element did not stop changing.");
  assert.equal(holdText({ ...base, end: "limit", pixels: "still" }), "Time limit: the hold lasted 4321 ms, the limit of 15000 ms; the element did not change.");
  assert.equal(holdText({ ...base, end: "limit", pixels: "none" }), "Time limit: the hold lasted 4321 ms, the limit of 15000 ms; the agent browser could not read the element's pixels.");
  assert.equal(holdText({ ...base, end: "stopped", why: "the page opened a dialog" }), "Ended early: the hold lasted 4321 ms; the page opened a dialog.");
  assert.equal(holdText({ ok: false, why: "the tab is gone." }), "Not held: the tab is gone.");
  // I2: no text names a stop or a start of the agent browser.
  for (const t of [holdText({ ...base, end: "done" }), holdText({ ...base, end: "limit", pixels: "none" }), holdText({ ...base, end: "stopped", why: "x" })]) assert.ok(!/\b(stop|stops|stopped|start|starts|started|restart)\b/i.test(t), t);
});
