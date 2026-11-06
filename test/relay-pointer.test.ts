// The relay's side of the daemon's pointer ops (board ab-v16.71; the agent pointer design,
// docs/superpowers/specs/2026-11-06-agent-pointer-move-design.md, sections 2, 3 and 7; contract C10 "The daemon's own
// ops" and C11 "The pointer at an activation" in chrome-extension's docs/protocol.md). The vectors are copies of
// chrome-extension test/vectors/{bridge,endpoint}.json at commit 8a3b66f (main, the merge of PR #31: C10's daemon ops
// with the pointer vectors p1-p108, C11's pointer constants); the folder name names that commit. The older tests read
// the copy at 40c2d93: its vectors are not a subset of these (a request vector and the endpoint's upgrade checks changed).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Bridge, BridgeError, MAX_IN_FLIGHT_PER_TAB, POINTER_READ_WAIT_MS, RELAY_TIMER } from "../src/relay/bridge.ts";
import { ACTIVATE_MAX_MS, CATCH_UP_MAX_UNANSWERED, clampRect, GEOMETRY_WAIT_MS, insideRect, monotonicMs, moveProblem, moveWait, notAfter, planPath, POINTER,
  sampleLegs, toDisplay, toPage, usable, type Geo, type PathPoint, type Pt, type Rect } from "../src/relay/pointer.ts";
import { planMove, seededRandom } from "../src/record.ts";

const vectors = (name: string) => JSON.parse(readFileSync(new URL(`./vectors/chrome-extension-8a3b66f/${name}.json`, import.meta.url), "utf8"));
const bridgeV = vectors("bridge");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MOVE = bridgeV.pointerVectors.find((v: any) => v.req.id === "p14").req.args[0];

// ------------------------------------------------------------------ the bridge

test("an error answer keeps its data (C10: an error res of a daemon. op may carry data); an ok answer gives its data", async () => {
  const lines: any[] = [];
  const b = new Bridge((l) => lines.push(JSON.parse(l)));
  const moved = b.call("daemon.movePointer", [MOVE], { wait: 1565 }).catch((e) => e);
  const plain = b.call("daemon.pointerAt").catch((e) => e);
  const ok = b.call("daemon.pointerAt");
  const res = (id: string) => bridgeV.pointerVectors.find((v: any) => v.req.id === id).res;
  b.answer({ ...res("p70"), id: lines[0].id });
  b.answer({ ...res("p5"), id: lines[1].id });
  b.answer({ ...res("p1"), id: lines[2].id });
  const e = await moved;
  assert.ok(e instanceof BridgeError);
  assert.equal(e.message, "pointer moved");
  assert.deepEqual(e.data, { x: 900, y: 431, views: 0 });
  const p = await plain;
  assert.equal(p.message, "too many moves");
  assert.equal(p.data, undefined, "no data on an error that has none");
  assert.deepEqual(await ok, { x: 812, y: 431, width: 1280, height: 900, views: 0 });
});

test("the daemon's ops have their own waits (daemon.pointerAt POINTER_READ_WAIT_MS, daemon.movePointer per request) and the in-flight key pointer", async () => {
  const c = bridgeV.pointerConstants;
  const lines: any[] = [];
  const b = new Bridge((l) => lines.push(JSON.parse(l)));
  for (const row of bridgeV.daemonOps) assert.equal(row.inFlightKey, "pointer", row.op);
  assert.equal(bridgeV.daemonOps.find((r: any) => r.op === "daemon.pointerAt").wait, "`POINTER_READ_WAIT_MS`");
  void b.call("daemon.pointerAt").catch(() => {});
  void b.call("daemon.movePointer", [MOVE], { wait: 1565 }).catch(() => {});
  assert.deepEqual(lines.map((l) => [l.op, l.args, l.wait]), [["daemon.pointerAt", [], c.POINTER_READ_WAIT_MS], ["daemon.movePointer", [MOVE], 1565]]);
  // The key pointer is apart: the shared key full of requests does not hold the daemon's ops back, nor they it.
  for (let i = 0; i < MAX_IN_FLIGHT_PER_TAB; i++) void b.call("tabs.query", [{}]).catch(() => {});
  void b.call("daemon.pointerAt").catch(() => {});
  assert.equal(lines.at(-1).op, "daemon.pointerAt");
  b.dropAll();
});

test("the relay's own timer ends the wait of a daemon op at its wait; the late answer is dropped, and the key's slot is free", async () => {
  const lines: any[] = [];
  const b = new Bridge((l) => lines.push(JSON.parse(l)));
  const t0 = Date.now();
  const late = await b.call("daemon.movePointer", [MOVE], { wait: 60 }).catch((e) => e);
  assert.ok(late instanceof BridgeError);
  assert.equal(late.message, RELAY_TIMER);
  assert.ok(Date.now() - t0 >= 55, "it waited its wait");
  b.answer({ t: "res", ch: "bridge", id: lines[0].id, ok: true, data: { x: 1, y: 1, views: 0 } }); // dropped: no request waits
  // A bridge op of the receiver keeps C10's way: no timer of the relay (the daemon always answers).
  const kept = b.call("tabs.get", [7]);
  await sleep(80);
  b.answer({ t: "res", ch: "bridge", id: lines[1].id, ok: true, data: { id: 7 } });
  assert.deepEqual(await kept, { id: 7 });
  // The pointer key has no request in flight after the timer: 64 more go out at once.
  for (let i = 0; i < MAX_IN_FLIGHT_PER_TAB; i++) void b.call("daemon.pointerAt").catch(() => {});
  assert.equal(lines.filter((l) => l.op === "daemon.pointerAt").length, MAX_IN_FLIGHT_PER_TAB);
  b.dropAll();
});

// ------------------------------------------------------------------ the constants, the waits, the clock and the relay's own checks

test("the pointer constants are the contracts' (C10's pointerConstants, C11's ACTIVATE_MAX_MS, GEOMETRY_WAIT_MS and CATCH_UP_MAX_UNANSWERED)", () => {
  assert.deepEqual(POINTER, bridgeV.pointerConstants);
  assert.equal(POINTER_READ_WAIT_MS, bridgeV.pointerConstants.POINTER_READ_WAIT_MS);
  const e = vectors("endpoint").constants;
  assert.deepEqual([ACTIVATE_MAX_MS, GEOMETRY_WAIT_MS, CATCH_UP_MAX_UNANSWERED], [e.ACTIVATE_MAX_MS, e.GEOMETRY_WAIT_MS, e.CATCH_UP_MAX_UNANSWERED]);
});

test("a move's wait is POINTER_START_MS + the path's total time + POINTER_KILL_MS + POINTER_SLACK_MS (each ok vector's wait)", () => {
  const moves = bridgeV.pointerVectors.filter((v: any) => v.req.op === "daemon.movePointer" && v.res?.ok);
  assert.ok(moves.length >= 15);
  for (const v of moves) assert.equal(moveWait(v.req.args[0].path), v.req.wait, v.req.id);
});

test("notAfter is CLOCK_MONOTONIC in whole ms (process.hrtime.bigint()), plus POINTER_START_MS", () => {
  const before = Number(process.hrtime.bigint() / 1000000n);
  const now = monotonicMs();
  assert.ok(Number.isInteger(now) && now >= before && now - before < 50);
  const n = notAfter();
  assert.ok(n - monotonicMs() <= POINTER.POINTER_START_MS && n - monotonicMs() > POINTER.POINTER_START_MS - 50);
});

test("the relay's own check of a move agrees with the vectors: each bad args and out of bounds, and every move that plays passes", () => {
  const world = bridgeV.pointerWorld;
  let n = 0;
  for (const v of bridgeV.pointerVectors.filter((x: any) => x.req.op === "daemon.movePointer")) {
    const now = v.world?.now ?? world.now, got = moveProblem(v.req.args ?? [], now), want = v.res?.error;
    if (want === "bad args") assert.equal(got, "bad args", v.req.id);
    else if (want === "out of bounds") assert.equal(got, "out of bounds", v.req.id);
    // The relay's display is the request's size: a wrong display is a check of the daemon's world, never bad args.
    else if (want === "wrong display") assert.notEqual(got, "bad args", v.req.id);
    else assert.equal(got, null, `${v.req.id} (${want ?? "ok"})`);
    n++;
  }
  assert.ok(n >= 90, `${n} move vectors`);
});

// ------------------------------------------------------------------ the path (section 3, step 4)

const dist2 = (a: Pt, b: Pt) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
/** Each rule of a path: C10's limits by the relay's own check, the first step 2 px or more, no point that does not move, every point inside the clamp, the end at T. */
function assertPath(path: PathPoint[], S: Pt, T: Pt, clamp: Rect | null, what: string) {
  const move = { at: { x: 0, y: 0 }, from: S, path, width: 1920, height: 1080, notAfter: 1000, views: 0 };
  assert.equal(moveProblem([move], 1000), null, `${what}: ${JSON.stringify(path)}`);
  assert.ok(dist2(path[0], S) >= 4, `${what}: the first step is 2 px or more`);
  let last = S;
  for (const p of path) {
    assert.ok(p.x !== last.x || p.y !== last.y, `${what}: a point that does not move`);
    assert.ok(p.dt >= 16 && p.dt <= 250, `${what}: dt ${p.dt}`);
    if (clamp) assert.ok(p.x >= clamp.x0 && p.x <= clamp.x1 && p.y >= clamp.y0 && p.y <= clamp.y1, `${what}: ${p.x},${p.y} outside the clamp`);
    last = p;
  }
  assert.deepEqual({ x: last.x, y: last.y }, T, `${what}: the path ends at T`);
}

test("the path: the generator's legs from S to T sampled every 16 ms, clamped 2 px inside the viewport, in whole pixels, each dt 16 to 250 ms, no step over 50 px, a first step of 2 px or more", async () => {
  const random = seededRandom(71);
  const clamp = { x0: 2, y0: 93, x1: 1277, y1: 897 };
  let planned = 0;
  for (let i = 0; i < 300; i++) {
    const S = { x: clamp.x0 + Math.floor(random() * 1276), y: clamp.y0 + Math.floor(random() * 805) };
    const T = { x: clamp.x0 + Math.floor(random() * 1276), y: clamp.y0 + Math.floor(random() * 805) };
    const path = await planPath(S, T, { clamp, random });
    if (!path) continue;
    planned++;
    assertPath(path, S, T, clamp, `path ${i} ${JSON.stringify([S, T])}`);
  }
  assert.ok(planned >= 290, `${planned} of 300 paths fit the limits on a 1280 x 900 display`);
});

test("the path is sampled every 16 ms: on a short move each dt is 16 to 31 ms, except where it merged a point that did not move", async () => {
  const path = (await planPath({ x: 300, y: 300 }, { x: 420, y: 330 }, { random: seededRandom(3) }))!;
  const plain = path.filter((p) => p.dt < 32);
  assert.ok(plain.length >= path.length / 2, JSON.stringify(path));
  const total = path.reduce((a, p) => a + p.dt, 0);
  assert.ok(total >= 280 && total <= 1500, `${total} ms: about fittsMs, 300 ms or more`);
});

test("the stretch: a long fast move gets one longer time for all legs, so that no step is over 50 px", async () => {
  const S = { x: 30, y: 450 }, T = { x: 1880, y: 520 }, random = seededRandom(5);
  const legs = await planMove(S, T, 24, seededRandom(5));
  const fast = sampleLegs(S, T, legs, 1, null);
  const max = (path: PathPoint[]) => Math.max(...path.map((p, i) => Math.sqrt(dist2(p, i ? path[i - 1] : S))));
  assert.ok(max(fast) > 50, `unstretched max step ${max(fast)}`);
  const path = (await planPath(S, T, { random }))!;
  assert.ok(path, "it fits after the stretch");
  assertPath(path, S, T, null, "the stretched path");
  assert.ok(path.reduce((a, p) => a + p.dt, 0) > fast.reduce((a, p) => a + p.dt, 0), "it takes longer");
});

test("no path when it does not fit the limits (more than 1500 ms: a far target on a large display)", async () => {
  assert.equal(await planPath({ x: 5, y: 5 }, { x: 3800, y: 2100 }, { random: seededRandom(9) }), null);
});

test("S equal to T (at elsewhere): a short out-and-back of 2 to 4 px, inside the clamp; S within 2 px of T too", async () => {
  const clamp = { x0: 2, y0: 93, x1: 1277, y1: 897 };
  for (const [S, T] of [[{ x: 600, y: 500 }, { x: 600, y: 500 }], [{ x: 2, y: 93 }, { x: 2, y: 93 }], [{ x: 1277, y: 897 }, { x: 1276, y: 897 }]]) {
    const path = (await planPath(S, T, { clamp, random: seededRandom(1) }))!;
    assert.equal(path.length, 2, JSON.stringify(path));
    const out = Math.sqrt(dist2(path[0], S));
    assert.ok(out >= 2 && out <= 4, `out ${out}`);
    assertPath(path, S, T, clamp, `out-and-back ${JSON.stringify(S)}`);
  }
});

test("the clamp: a target near the viewport's edge, past 500 px (an overshoot leg), keeps every point 2 px inside", async () => {
  const clamp = { x0: 102, y0: 182, x1: 797, y1: 577 };
  const random = seededRandom(11);
  for (let i = 0; i < 100; i++) {
    const S = { x: 110 + Math.floor(random() * 10), y: 190 + Math.floor(random() * 10) };
    const T = { x: 790 + Math.floor(random() * 7), y: 570 + Math.floor(random() * 7) };
    const path = await planPath(S, T, { clamp, random });
    if (path) assertPath(path, S, T, clamp, `edge ${i}`);
  }
});

test("the catch-up's path: the same generator and limits in the page's CSS px, with no clamp", async () => {
  const path = (await planPath({ x: 10, y: 10 }, { x: 760, y: 300 }, { random: seededRandom(2) }))!;
  assertPath(path, { x: 10, y: 10 }, { x: 760, y: 300 }, null, "catch-up");
});

// ------------------------------------------------------------------ the geometry (section 3, the mapping of src/input.ts)

test("the mapping: display x = round(screenX + side + px), y = round(screenY + outerHeight - innerHeight - side + py); the inverse; the viewport 2 px inside", () => {
  const g: Geo = { sx: 100, sy: 50, ow: 1100, oh: 700, iw: 1090, ih: 610, dpr: 1, scale: 1, sw: 1280, sh: 900, vis: "visible" };
  // side = round((1100 - 1090) / 2) = 5: the content's origin is (105, 50 + 700 - 610 - 5) = (105, 135).
  assert.deepEqual(toDisplay(g, { x: 10.4, y: 20.6 }), { x: 115, y: 156 });
  assert.deepEqual(toPage(g, { x: 115, y: 156 }), { x: 10, y: 21 });
  assert.equal(toPage(g, { x: 104, y: 156 }), null, "left of the viewport");
  assert.equal(toPage(g, { x: 105 + 1090, y: 156 }), null, "right of it");
  assert.deepEqual(clampRect(g), { x0: 107, y0: 137, x1: 105 + 1090 - 3, y1: 135 + 610 - 3 });
  assert.ok(insideRect(clampRect(g), { x: 107, y: 137 }) && !insideRect(clampRect(g), { x: 106, y: 137 }));
});

test("a geometry is not usable when the ratio or the scale is not 1, or the screen is not the display's size", () => {
  const g: Geo = { sx: 0, sy: 0, ow: 1280, oh: 900, iw: 1280, ih: 809, dpr: 1, scale: 1, sw: 1280, sh: 900, vis: "visible" };
  const display = { width: 1280, height: 900 };
  assert.equal(usable(g, display), true);
  assert.equal(usable({ ...g, dpr: 2 }, display), false);
  assert.equal(usable({ ...g, scale: 1.5 }, display), false);
  assert.equal(usable({ ...g, sw: 1920 }, display), false);
  assert.equal(usable({ ...g, sh: 1080 }, display), false);
  assert.equal(usable(null, display), false);
});
