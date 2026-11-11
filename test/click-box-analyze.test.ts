// The research's analysis of a probe run or of a person's recording (docs/research/2026-11-09-click-box-input-signals/
// analyze.ts; board ab-t30.1, part B: ab-t30.7). analyze.ts is a script, so these tests run it on small recordings in
// the form that recorder.html saves, and read its --numbers and --summary files. No browser.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = new URL("../docs/research/2026-11-09-click-box-input-signals/", import.meta.url);
const ANALYZE = new URL("analyze.ts", DIR).pathname;

type Rec = Record<string, unknown> & { e: string; t: number };
const ev = (e: string, t: number, extra: Record<string, unknown> = {}): Rec => ({ f: "top", e, t, h: t + 1, tr: 1, ...extra });
const task = (what: string, t: number, extra: Record<string, unknown> = {}): Rec => ({ f: "top", e: "task", what, t, ...extra });

/** Runs analyze.ts on a recording (or a probe's results) and gives its --numbers and --summary files. */
function analyze(data: unknown): { numbers: any; summary: any; stdout: string } {
  const dir = mkdtempSync(join(tmpdir(), "click-box-analyze-"));
  try {
    const file = join(dir, "in.json");
    writeFileSync(file, JSON.stringify(data));
    const r = spawnSync(process.execPath, [ANALYZE, file, "--numbers", join(dir, "numbers.json"), "--summary", join(dir, "summary.json")], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return { numbers: JSON.parse(readFileSync(join(dir, "numbers.json"), "utf8")), summary: JSON.parse(readFileSync(join(dir, "summary.json"), "utf8")), stdout: r.stdout };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const recording = (records: Rec[]) => ({ what: "ab-t30.1 input recording", saved: "test", device: "trackpad", url: "recorder.html", records, frames: [] });

/** One click of task 2 (a trial from 1000 to 1400 ms), then a drag of #drag after the task's end, as Chrome on a Mac gives it. */
function dragRecording(): Rec[] {
  const recs: Rec[] = [task("begin", 990, { task: "2-targets" }), task("trial", 1000, { task: "2-targets", n: 0, size: 24 })];
  for (let i = 0; i < 5; i++) recs.push(ev("pointermove", 1100 + 8 * i, { x: 100 + 10 * i, y: 200, sx: 100 + 10 * i, sy: 300, mx: 10, my: 0, bs: 0, nc: 1, np: 2 }));
  recs.push(ev("pointerdown", 1200, { x: 140, y: 200, bs: 1, tg: "#t" }), ev("pointerup", 1290, { x: 140, y: 200, bs: 0, tg: "#t" }), ev("click", 1290, { tg: "#t" }));
  recs.push(task("end", 1400, { task: "2-targets" }));
  // The drag: 5 s after the task's end, outside every step. The press and the dragstart have the same event time; the
  // dragstart's handler runs 150 ms later. Two moves with the button down, a pointercancel, then drag and dragover pairs.
  const p = 6400;
  recs.push(ev("pointermove", p - 16, { x: 60, y: 350, sx: 60, sy: 450, mx: 1, my: 0, bs: 0, nc: 1, np: 2 }), ev("pointermove", p - 8, { x: 61, y: 350, sx: 61, sy: 450, mx: 1, my: 0, bs: 0, nc: 1, np: 2 }));
  recs.push(ev("pointerdown", p, { x: 61, y: 350, bs: 1, tg: "#drag" }), { ...ev("dragstart", p, { tg: "#drag" }), h: p + 150 });
  recs.push(ev("pointermove", p + 120, { x: 66, y: 350, sx: 66, sy: 450, mx: 5, my: 0, bs: 1, nc: 1, np: 2 }), ev("pointermove", p + 130, { x: 72, y: 350, sx: 72, sy: 450, mx: 6, my: 0, bs: 1, nc: 1, np: 2 }));
  recs.push(ev("pointercancel", p + 130, { bs: 0 }));
  const pts = [[80, 350], [80, 350], [95, 352], [110, 354], [110, 354], [130, 356]];
  pts.forEach(([x, y], i) => { const t = p + 160 + 8 * i; recs.push({ ...ev("drag", t, { x, y, bs: 1, b: 0, tg: "#drag" }), h: t }, { ...ev("dragover", t, { x, y, bs: 1, b: 0, tg: "#drop" }), h: t }); });
  recs.push({ ...ev("drag", p + 220, { x: 130, y: 356, bs: 0, b: 0, tg: "#drag" }), h: p + 220 }, { ...ev("dragend", p + 900, { tg: "#drag" }), h: p + 900 });
  return recs;
}

test("analyze: a drag outside every task is a step of its own, from its press to its dragend, after the tasks' steps", () => {
  const { numbers } = analyze(recording(dragRecording()));
  const steps = numbers.scenarios["person-trackpad"].steps;
  assert.deepEqual(steps.map((s: any) => s.name), ["2-targets #0", "drag #0"]);
  assert.equal(steps[1].ms, 900, "from the press (6400) to the dragend (7300)");
  assert.equal(steps[0].metrics.dragEvents, undefined, "the task's step holds no drag event");
});

test("analyze: a drag step's drag events: the button state of drag and dragover (R8), the times around the dragstart, the bursts", () => {
  const d = analyze(recording(dragRecording())).numbers.scenarios["person-trackpad"].steps[1].metrics.dragEvents;
  assert.deepEqual(d, {
    drag: 7, dragover: 6, dragButton1: 6, dragoverButton1: 6, dragstarts: 1, dragends: 1, drops: 0, pointercancel: 1,
    pressToDragstartMs: 0, dragstartLagMs: 150, firstDragMs: 160, dragMs: 900, movesHeld: 2,
    gapMs: { median: 8, range: [8, 20] }, lagMs: 0, samePointShare: 0.5,
  });
});

test("analyze: drag events need no press: a step with drag events and no dragstart or press gives nulls, not an error", () => {
  const recs: Rec[] = [task("begin", 990, { task: "7-switch" }), ev("drag", 1000, { x: 1, y: 1, bs: 1 }), ev("dragover", 1000, { x: 1, y: 1, bs: 1 }), task("end", 1100, { task: "7-switch" })];
  const d = analyze(recording(recs)).numbers.scenarios["person-trackpad"].steps[0].metrics.dragEvents;
  assert.equal(d.drag, 1);
  assert.equal(d.dragButton1, 1);
  assert.equal(d.pressToDragstartMs, null);
  assert.equal(d.dragMs, null);
  assert.equal(d.samePointShare, null, "one drag event has no event before it");
});

/** Wheel events of task 4: three trains. A: 7 events down, 8 ms apart, with a peak and a falling tail; a gap of 150 ms
 * (the gap alone ends A); B: 3 events down; C: at once 2 events up (deltaY < 0: the change of direction alone ends B). */
function wheelRecording(): Rec[] {
  const recs: Rec[] = [task("begin", 990, { task: "4-scroll" }), task("trial", 1000, { task: "4-scroll", n: 0, leg: "down" })];
  const w = (t: number, dy: number) => ev("wheel", t, { dx: 0, dy, dz: 0, dm: 0, wdx: 0, wdy: -3 * dy, bs: 0, m: 0 });
  [2, 5, 9, 7, 6, 6, 3].forEach((dy, i) => recs.push(w(1100 + 8 * i, dy)));
  [4, 8, 3].forEach((dy, i) => recs.push(w(1298 + 8 * i, dy)));
  [-5, -4].forEach((dy, i) => recs.push(w(1322 + 8 * i, dy)));
  recs.push(task("trial", 1500, { task: "4-scroll", n: 0, leg: "up" }), task("end", 1600, { task: "4-scroll" }));
  return recs;
}

test("analyze: the wheel's trains (P7: events per scroll): a train ends at a gap over 100 ms or a change of direction", () => {
  const { numbers, summary } = analyze(recording(wheelRecording()));
  const w = numbers.scenarios["person-trackpad"].wheelTrains;
  assert.deepEqual(w, summary.scenarios["person-trackpad"].wheelTrains, "the same in --numbers and --summary");
  assert.equal(w.splitMs, 100);
  assert.deepEqual(w.trains.map((t: any) => t.events), [7, 3, 2]);
  assert.deepEqual(w.trains[0], { step: "4-scroll #0 down", events: 7, ms: 48, px: 38, peakPx: 9, toPeak: 2, tailEvents: 5, tailMs: 32, lastPx: 3, gapMs: 8 });
  assert.deepEqual(w.trains[1], { step: "4-scroll #0 down", events: 3, ms: 16, px: 15, peakPx: 8, toPeak: 1, tailEvents: 2, tailMs: 8, lastPx: 3, gapMs: 8 });
  assert.deepEqual(w.trains[2], { step: "4-scroll #0 down", events: 2, ms: 8, px: 9, peakPx: 5, toPeak: 0, tailEvents: 2, tailMs: 8, lastPx: 4, gapMs: 8 });
  assert.deepEqual(w.absDeltaPx, { p10: 3, median: 5, p90: 8, range: [2, 9] });
  assert.deepEqual(w.wheelDeltaRatio, [-3]);
});

test("analyze: a recording with no wheel event has no wheel trains", () => {
  assert.equal(analyze(recording(dragRecording())).numbers.scenarios["person-trackpad"].wheelTrains, undefined);
});

test("analyze: the committed probe results still give the committed summaries (the new measures change no existing output)", () => {
  const dir = mkdtempSync(join(tmpdir(), "click-box-analyze-"));
  try {
    for (const run of ["run-1", "run-3"]) {
      const out = join(dir, `${run}-summary.json`);
      const r = spawnSync(process.execPath, [ANALYZE, new URL(`results/${run}.json`, DIR).pathname, "--summary", out], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      const now = JSON.parse(readFileSync(out, "utf8"));
      for (const sc of Object.values(now.scenarios) as any[]) delete sc.wheelTrains;
      assert.deepEqual(now, JSON.parse(readFileSync(new URL(`results/${run}-summary.json`, DIR), "utf8")), `${run}: the same summary, the new wheel trains left out`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
