// The live check's counts of the pointer design (test/live/agent-mode/pointer-measure.ts; board ab-v16.71) on a small
// probe log: the moves that a played path gave a page (Chrome merges some), the dt that the page saw, the presses away
// from the last move, the moves while a button is held, and the relay's step lines.

import { test } from "node:test";
import assert from "node:assert/strict";
import { dtPairs, movesWhileHeld, pageCounts, pathMoves, pressesAway, stepLine } from "./live/agent-mode/pointer-measure.ts";

const move = (te: number, cx: number, cy: number, mx: number, my: number, extra: object = {}) => ({ type: "mousemove", te, cx, cy, sx: cx, sy: cy + 91, mx, my, ...extra });
const logOf = (tab: string, list: object[]) => [{ t: 0, tab, ev: "moves", list }];

test("a played path's moves in a page: at the path's points, in its order, in its time; Chrome's merged moves leave points out", () => {
  const p = { startedAt: 1000, endedAt: 1100, answer: "ok", path: [{ x: 10, y: 101, dt: 16 }, { x: 20, y: 101, dt: 16 }, { x: 30, y: 101, dt: 17 }, { x: 40, y: 101, dt: 16 }] };
  const log = logOf("A", [move(990, 5, 10, 0, 0), move(1016, 10, 10, 5, 0), move(1050, 30, 10, 20, 0), move(1066, 40, 10, 10, 0), move(1200, 40, 10, 0, 0)]) as any;
  const m = pathMoves(log, "A", p);
  assert.deepEqual(m.map((x) => x.i), [0, 2, 3], "point 1 merged into point 2's frame; the entry after the play is not the path's");
  assert.deepEqual(dtPairs(m, p), [{ seen: 34, planned: 33 }, { seen: 16, planned: 16 }]);
  const c = pageCounts(log, "A", 0, 2000, [], [p]);
  assert.deepEqual([c.pathMoves, c.zeroMovement, c.maxPathMovement, c.jumps], [3, 0, 20, 0]);
});

test("presses away from the last move, and real moves while a button is held", () => {
  const log = logOf("A", [move(10, 5, 5, 0, 0), { type: "mousedown", te: 20, cx: 5, cy: 5 }, { type: "mouseup", te: 30, cx: 5, cy: 5 },
    move(40, 50, 50, 45, 45), { type: "mousedown", te: 50, cx: 90, cy: 90 }, move(60, 95, 95, 5, 5), { type: "mouseup", te: 70, cx: 95, cy: 95 }]) as any;
  assert.equal(pressesAway(log, "A", 0, 100), 1);
  assert.equal(movesWhileHeld(log, "A", 0, 100), 1);
});

test("the relay's step line (AGENT_BROWSER_POINTER_LOG=1) names the kind, the tab, the outcome and the time", () => {
  assert.deepEqual(stepLine(5, "relay: step input of tab 12: a path of 40 points, ok in 700 ms; 760 ms"), { t: 5, kind: "input", tab: 12, what: "a path of 40 points, ok in 700 ms", ms: 760 });
  assert.equal(stepLine(5, "relay: catch-up in tab 12: 9 moves in 300 ms"), null);
});
