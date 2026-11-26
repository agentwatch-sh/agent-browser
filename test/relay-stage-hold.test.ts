// The input stage's hold (board ab-t30.34; C11, the press and hold; src/relay/stage.ts, Stage.hold): after the MCP's own
// browser_hover of the hold (the vector "hover" of test/vectors/stage.json, with the model's watch on), the stage's hold
// in the tab's gate: the hover's path to a spread point, the pause, the press, the hand's moves with the button down, the
// end (the pixels, a navigation, the element gone, maxMs, a dialog), the release and its delay, the input lock; and a
// Playwright client's own hold (mouse.down, a wait of 3 s, mouse.up) through the stage. A fake Chrome and a fake clock
// (stage-fakes.ts); in the model with the fake receiver (fake-bridge.ts) the watch that finds the tab.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { HOLD, type HoldResult } from "../src/human/hold.ts";
import { HOLD_CLEAR, HOLD_KEEP, HOLD_NOT, HOLD_THERE, HOLD_WHY, STAGE_ACTION_MAX_MS } from "../src/relay/stage.ts";
import { ACTIVATE_MAX_MS, GEOMETRY_WAIT_MS } from "../src/relay/pointer.ts";
import { FakeTab, runVector, type Sent } from "./stage-fakes.ts";
import { harness, until } from "./fake-bridge.ts";

const V = JSON.parse(readFileSync(new URL("./vectors/stage.json", import.meta.url), "utf8"));
const vec = (id: string) => structuredClone(V.vectors.find((x: any) => x.id === id));
const isMouse = (s: Sent, type: string) => s.method === "Input.dispatchMouseEvent" && s.params.type === type;
/** The hover vector's button and Playwright's point (its middle). */
const BOX = { x: 60, y: 220, w: 80, h: 40 }, MIDDLE = { x: 100, y: 240 };

type Run = Awaited<ReturnType<typeof runVector>> & { res: HoldResult; resAt: number; hovered: number; holdFrom: number };
/**
 * The hover vector with the hold's watch on, then the stage's hold. `shot(t)` gives the pixels of a read at the fake
 * clock's time (null: no data), `there(t)` the element read; `during(r)` runs at the hold's call (timers of a test).
 */
async function hold(o: { seed?: number; maxMs?: number; shot?: (t: number) => string | null; there?: (t: number) => boolean; during?: (r: Omit<Run, "res" | "resAt">) => void; watch?: boolean; vector?: any; hook?: (s: Sent) => any; setup?: (t: FakeTab) => void } = {}): Promise<Run> {
  let hovered = 0, holdFrom = -1, res: HoldResult | undefined, resAt = -1;
  let tab!: FakeTab;
  // The hold starts 60 ms after the check's stop goes (the MCP's answer of its hover, then the transport's call).
  const start = () => {
    holdFrom = tab.clock.now();
    o.during?.({ tab, stage: tab.stage, clock: tab.clock, hovered, holdFrom } as any);
    void tab.stage.hold(tab, { maxMs: o.maxMs ?? 6000 }).then((x) => { res = x; resAt = tab.clock.now(); });
  };
  const r = await runVector(o.vector ?? vec("hover"), { seed: o.seed ?? 5, tab: (t) => {
    tab = t;
    o.setup?.(t);
    if (o.watch !== false) { (t as any).holdHover = () => true; (t as any).hovered = () => { hovered++; }; }
    t.hook = (s) => {
      const own = o.hook?.(s);
      if (own !== undefined) return own;
      if (s.method === "Page.captureScreenshot") { const d = o.shot?.(t.clock.now()) ?? null; return d === null ? {} : { data: d }; }
      if (s.method === "ownRead" && s.params.fn === HOLD_KEEP) return true;
      if (s.method === "ownRead" && s.params.fn === HOLD_THERE) return o.there ? o.there(t.clock.now()) : true;
      if (s.method === "ownRead" && s.params.fn === HOLD_CLEAR) return true;
      if (s.pass === 3 && holdFrom < 0) t.clock.timer(60, start);
      return undefined;
    };
  } });
  await r.clock.run(() => res !== undefined, r.clock.now() + 60_000);
  assert.ok(res, "the hold answered");
  return { ...r, hovered, holdFrom, res: res!, resAt };
}
const after = (r: Run) => r.tab.sent.filter((s) => s.t >= r.holdFrom || false);
const pressOf = (r: Run) => r.tab.sent.find((s) => isMouse(s, "mousePressed"))!;
const releaseOf = (r: Run) => r.tab.sent.find((s) => isMouse(s, "mouseReleased"))!;
const handOf = (r: Run) => { const p = pressOf(r), q = releaseOf(r); return r.tab.sent.filter((s) => isMouse(s, "mouseMoved") && s.t > p.t && (!q || s.t <= q.t)); };
/** A fill that changes the pixels at each read until `fullAt` ms after the press, then its check mark: the same pixels. */
const fill = (r: () => number, fullAt: number) => (t: number) => (t - r() < fullAt ? `fill-${t}` : "check");

test("the hover of a hold: the model learns the tab once, and the hover's path ends at a spread point inside the target (at most 1/4 of its smaller side from its middle), not always at Playwright's point", async () => {
  const ends = new Set<string>();
  for (let seed = 1; seed <= 10; seed++) {
    const r = await runVector(vec("hover"), { seed, tab: (t) => { (t as any).holdHover = () => true; let n = 0; (t as any).hovered = () => { n++; (t as any).n = n; }; } });
    assert.equal((r.tab as any).n, 1, `seed ${seed}: hovered once`);
    const last = r.tab.sent.filter((s) => isMouse(s, "mouseMoved")).at(-1)!;
    const d = Math.hypot(last.params.x - MIDDLE.x, last.params.y - MIDDLE.y);
    assert.ok(d <= Math.min(BOX.w, BOX.h) / 4 + 1e-9, `seed ${seed}: ${d} px from the middle`);
    assert.ok(last.params.x >= BOX.x && last.params.x < BOX.x + BOX.w && last.params.y >= BOX.y && last.params.y < BOX.y + BOX.h, "inside the box");
    ends.add(`${last.params.x},${last.params.y}`);
    // The client's own move gets its answer, and the check's stop passes as before.
    assert.equal(r.answers.length, 3);
  }
  assert.ok(ends.size >= 5, `spread ends: ${[...ends].join(" ")}`);
  // With no watch, the hover's path ends at Playwright's point as before (the vector's own rows check the rest).
  const plain = await runVector(vec("hover"), { seed: 3 });
  const last = plain.tab.sent.filter((s) => isMouse(s, "mouseMoved")).at(-1)!;
  assert.deepEqual([last.params.x, last.params.y], [MIDDLE.x, MIDDLE.y]);
});

test("the hold: the pause, then a press of force 0.5 at the hover's end; 1 px moves with the left button down, at most 2 px from the press, at gaps of 150 to 600 ms; no drag; the done state by the pixels; the release 150 to 400 ms after it", async () => {
  for (const seed of [1, 2, 3, 4]) {
    let t0 = 0;
    const r = await hold({ seed, shot: fill(() => t0, 3000), during: (x) => { t0 = x.holdFrom; } });
    const w = `seed ${seed}`;
    const p = pressOf(r), q = releaseOf(r), hoverEnd = r.tab.sent.filter((s) => isMouse(s, "mouseMoved") && s.t < p.t).at(-1)!;
    assert.deepEqual([p.params.x, p.params.y], [hoverEnd.params.x, hoverEnd.params.y], `${w}: the press at the hover's end`);
    assert.deepEqual({ button: p.params.button, buttons: p.params.buttons, clickCount: p.params.clickCount, force: p.params.force }, { button: "left", buttons: 1, clickCount: 1, force: 0.5 }, w);
    assert.ok(p.t - hoverEnd.t >= 25 && p.t - hoverEnd.t <= 190, `${w}: the pause ${p.t - hoverEnd.t} ms`);
    assert.ok(r.tab.activations.some((a) => a >= r.holdFrom && a <= p.t), `${w}: the activation before the press`);
    const hand = handOf(r);
    assert.ok(hand.length >= 3, `${w}: ${hand.length} moves`);
    let prev = { x: p.params.x, y: p.params.y }, at = p.t;
    for (const m of hand) {
      assert.equal(m.params.button, "left"); assert.equal(m.params.buttons, 1);
      assert.equal(Math.abs(m.params.x - prev.x) + Math.abs(m.params.y - prev.y), 1, `${w}: a step of 1 px`);
      assert.ok(Math.hypot(m.params.x - p.params.x, m.params.y - p.params.y) <= 2 + 1e-9, `${w}: within 2 px`);
      assert.ok(m.t - at >= 150 && m.t - at <= 600 + 1e-9, `${w}: a gap of ${m.t - at} ms`);
      prev = m.params; at = m.t;
    }
    assert.ok(!r.tab.sent.some((s) => s.t >= r.holdFrom && (s.method === "Input.dispatchDragEvent" || s.method === "Input.setInterceptDrags")), `${w}: no drag`);
    // The done state: the first read of the check mark, then 300 ms of the same pixels; the release 150 to 400 ms later.
    const shots = r.tab.sent.filter((s) => s.method === "Page.captureScreenshot");
    assert.ok(shots.length >= 30, `${w}: ${shots.length} reads`);
    for (let i = 1; i < shots.length; i++) assert.ok(shots[i].t - shots[i - 1].t >= HOLD.readMs - 1e-9, "a read each 100 ms at most");
    const firstCheck = shots.find((s) => s.t - t0 >= 3000)!;
    const done = shots.find((s) => s.t - firstCheck.t >= 300)!;
    assert.ok(q.t - done.t >= 150 && q.t - done.t <= 400 + 1e-9, `${w}: the release ${q.t - done.t} ms after the done state`);
    assert.deepEqual([q.params.x, q.params.y], [prev.x, prev.y], `${w}: the release at the hand's last point`);
    assert.equal(q.params.buttons, 0);
    // The clip: the target's whole box, in whole px.
    assert.deepEqual(shots[0].params.clip, { x: 60, y: 220, width: 80, height: 40, scale: 1 });
    assert.equal(shots[0].params.format, "png");
    assert.equal(r.res.ok, true);
    if (!r.res.ok) continue;
    assert.equal(r.res.end, "done");
    assert.equal(r.res.heldMs, Math.round(q.t - p.t));
    assert.equal(r.res.moves, hand.length);
    assert.equal(r.res.pixels, "changing");
    assert.equal(r.stage.lock.held, 0, `${w}: the lock is free after the release`);
    assert.deepEqual(r.stage.state(r.tab.id)?.buttons, [], "no button stays down");
  }
});

test("the end at a navigation of the main frame (its commit, or its start): the release goes at once, not after a delay", async () => {
  const at = 2500;
  const r = await hold({ shot: (t) => `fill-${t}`, during: (x) => { x.clock.timer(at, () => x.tab.navigate()); } });
  const q = releaseOf(r);
  assert.equal(q.t, r.holdFrom + at, "the release at the navigation's time");
  assert.equal(r.res.ok && r.res.end, "navigation");
  // The start of a cross-document navigation of the main frame also ends it.
  // (The fake tab has no target id: the main frame's id comes from a Page.frameNavigated of the main frame before the hold.)
  const s = await hold({ shot: (t) => `fill-${t}`, during: (x) => {
    (x.stage as any).tabs.get(x.tab.id).mainFrame = "main";
    x.clock.timer(at, () => x.stage.event(x.tab, undefined, "Page.frameStartedNavigating", { frameId: "main", navigationType: "differentDocument" }));
  } });
  assert.equal(releaseOf(s).t, s.holdFrom + at, "the release at the navigation's start");
  assert.equal(s.res.ok && s.res.end, "navigation");
});

test("the end when the element goes away (the kept element has left the document): the release at once", async () => {
  let t0 = 0;
  const r = await hold({ shot: (t) => `fill-${t}`, there: (t) => t - t0 < 1800, during: (x) => { t0 = x.holdFrom; } });
  const q = releaseOf(r), gone = r.tab.sent.find((s) => s.method === "ownRead" && s.params.fn === HOLD_THERE && s.t - t0 >= 1800)!;
  assert.equal(q.t, gone.t, "the release at the read that found it gone");
  assert.equal(r.res.ok && r.res.end, "gone");
});

test("the time limit maxMs: a fill that never stops, a still element and no read each end at maxMs from the press, with the release at once", async () => {
  for (const [name, shot, pixels] of [["changing", (t: number) => `f${t}`, "changing"], ["still", () => "same", "still"], ["none", () => null, "none"]] as const) {
    const r = await hold({ maxMs: 2000, shot });
    const p = pressOf(r), q = releaseOf(r);
    assert.ok(Math.abs(q.t - p.t - 2000) <= 1e-6, `${name}: the release at maxMs (${q.t - p.t})`);
    assert.ok(r.res.ok);
    if (r.res.ok) { assert.equal(r.res.end, "limit"); assert.equal(r.res.pixels, pixels, name); assert.equal(r.res.maxMs, 2000); }
  }
});

test("a dialog during the hold ends the plan: the answer comes at the dialog's open, before its close (the agent handles the dialog only after the answer); the button goes up after the close", async () => {
  // review of board ab-t30.34, I1: the answer waited for the close, and the agent's browser_handle_dialog waited for the answer.
  let opened = -1;
  const r = await hold({ shot: (t) => `f${t}`, during: (x) => {
    x.clock.timer(1500, () => { opened = x.clock.now(); x.stage.event(x.tab, undefined, "Page.javascriptDialogOpening", { type: "alert", message: "x" }); });
    x.clock.timer(40_000, () => x.stage.event(x.tab, undefined, "Page.javascriptDialogClosed", { result: true }));
  } });
  assert.ok(r.resAt >= opened && r.resAt <= opened + 250, `the answer at the open (${r.resAt - opened} ms after it), not at the close`);
  assert.ok(r.res.ok);
  if (r.res.ok) { assert.equal(r.res.end, "stopped"); assert.equal(r.res.why, "the page opened a dialog; handle the dialog, and the agent browser releases the button when it closes"); }
  assert.equal(releaseOf(r), undefined, "no release while the dialog is open (Chrome drops it)");
  await r.clock.advance(45_000);
  await r.clock.advance(5000);
  const q = releaseOf(r);
  assert.ok(q && q.t >= r.holdFrom + 40_000, `the release after the close (${q?.t})`);
  assert.deepEqual(r.stage.state(r.tab.id)?.buttons ?? [], []);
});

test("refusals with no press: a button of the tab down, no point of the pointer; and the hold's limits fit the stage's action limit", async () => {
  // A client's press with no release (mouse.down): the hold refuses, and sends no press of its own.
  const v = vec("hover");
  v.in.push({ id: 4, after: 3, method: "Input.dispatchMouseEvent", params: { type: "mousePressed", x: 100, y: 240, button: "left", buttons: 1, clickCount: 1, modifiers: 0, force: 0.5 } });
  const r = await runVector(v, { tab: (t) => { (t as any).holdHover = () => true; } });
  const presses = r.tab.sent.filter((s) => isMouse(s, "mousePressed")).length;
  let res: HoldResult | undefined;
  void r.stage.hold(r.tab, { maxMs: 3000 }).then((x) => { res = x; });
  await r.clock.run(() => res !== undefined, r.clock.now() + 30_000);
  assert.deepEqual(res, { ok: false, why: "a mouse button or a key of the tab is down." });
  assert.equal(r.tab.sent.filter((s) => isMouse(s, "mousePressed")).length, presses, "no press of the hold");
  // A tab that the pointer never reached.
  const other = new FakeTab(vec("hover"), r.clock, { id: 99 });
  other.stage = r.stage;
  let res2: HoldResult | undefined;
  void r.stage.hold(other, { maxMs: 3000 }).then((x) => { res2 = x; });
  await r.clock.run(() => res2 !== undefined, r.clock.now() + 30_000);
  assert.deepEqual(res2, { ok: false, why: "the pointer did not reach the element." });
  // The action's parts before the press (the activation, the pause, the box's reads: the box model and its frame owner's,
  // the kept element, the layout), the longest hold, the reads that can straddle its end (the element and the pixels),
  // and the release's delay.
  assert.ok(ACTIVATE_MAX_MS + 190 + 5 * GEOMETRY_WAIT_MS + HOLD.maxMs + 2 * GEOMETRY_WAIT_MS + HOLD.releaseAfterMs[1] < STAGE_ACTION_MAX_MS, "the longest hold, with all its parts, fits the action's limit");
});

test("an exception of the stage after the press (a send that throws): the release goes at once, and the answer says that a press and its release went", async () => {
  // review of board ab-t30.34, I2: the button stayed down for good.
  let thrown = 0;
  const r = await hold({ shot: (t) => `f${t}`, during: (x) => {
    const send = x.tab.send.bind(x.tab);
    (x.tab as any).send = (child: string | undefined, method: string, params: Record<string, unknown>) => {
      if (method === "Page.captureScreenshot" && x.tab.sent.some((q) => isMouse(q, "mousePressed")) && thrown++ === 2) throw new Error("a test's broken send");
      return send(child, method, params);
    };
  } });
  const p = pressOf(r), q = releaseOf(r);
  assert.ok(p && q && q.t >= p.t, "a press, then its release");
  assert.equal(q.params.buttons, 0);
  assert.ok(r.res.ok);
  if (r.res.ok) { assert.equal(r.res.end, "stopped"); assert.equal(r.res.why, "the input stage failed during the hold, and the agent browser released the button"); }
  await r.clock.advance(3000);
  assert.deepEqual(r.stage.state(r.tab.id)?.buttons ?? [], [], "no button stays down");
  assert.equal(r.stage.lock.held, 0, "the lock is free");
});

test("an event with no answer in STAGE_EVENT_WAIT_MS (a hand's move): the answer says that the release comes later, and the release goes after the answer", async () => {
  // The narrow re-check of board ab-t30.34, I-1: the answer said "released" before the end's steps sent the release.
  let pressed = false;
  const r = await hold({ shot: (t) => `f${t}`, hook: (s) => {
    if (isMouse(s, "mousePressed")) pressed = true;
    return pressed && isMouse(s, "mouseMoved") && s.params.buttons === 1 ? new Promise(() => {}) : undefined;
  } });
  assert.ok(r.res.ok);
  if (r.res.ok) { assert.equal(r.res.end, "stopped"); assert.equal(r.res.why, HOLD_WHY.wait); }
  await r.clock.advance(5000);
  const q = releaseOf(r);
  assert.ok(q && q.t >= r.resAt, `the release (${q?.t}) after the answer (${r.resAt})`);
});

/** The hover vector with a backendNodeId of its button (the hold reads the target's box again before the press). */
const withBackend = () => { const v = vec("hover"); v.page.nodes["7.3.10"].backendNodeId = 4242; return v; };
const quad = (x: number, y: number, w: number, h: number) => ({ model: { border: [x, y, x + w, y, x + w, y + h, x, y + h], content: [x, y, x + w, y, x + w, y + h, x, y + h] } });

test("the target's box before the press (review of board ab-t30.34, M5): an element that moved away from the pointer since the hover gets the refusal and no press; one that stays goes on, and its box is the clip", async () => {
  const moved = await hold({ vector: withBackend(), shot: (t) => `f${t}`, hook: (s) => (s.method === "DOM.getBoxModel" && s.params.backendNodeId === 4242 ? quad(60, 420, 80, 40) : undefined) });
  assert.deepEqual(moved.res, { ok: false, why: "the element is no longer under the pointer (the page changed after the hover); take a new snapshot and try again." });
  assert.equal(HOLD_NOT.moved, "the element is no longer under the pointer (the page changed after the hover); take a new snapshot and try again.");
  assert.equal(pressOf(moved), undefined, "no press");
  assert.ok(moved.tab.sent.some((s) => s.method === "DOM.describeNode" && s.params.objectId === "7.3.10"), "the hover kept the target's backendNodeId");
  const stays = await hold({ vector: withBackend(), maxMs: 1500, shot: (t) => `f${t}`, hook: (s) => (s.method === "DOM.getBoxModel" && s.params.backendNodeId === 4242 ? quad(58, 221, 84, 40) : undefined) });
  assert.ok(stays.res.ok && pressOf(stays), "the press goes");
  assert.deepEqual(stays.tab.sent.find((s) => s.method === "Page.captureScreenshot")!.params.clip, { x: 58, y: 221, width: 84, height: 40, scale: 1 }, "the clip is the box of the read before the press");
  // A read with no answer in GEOMETRY_WAIT_MS goes on with the hover's box, counted (board ab-t30.35: Chrome's error is a
  // refusal, below).
  const late = await hold({ vector: withBackend(), maxMs: 1500, shot: (t) => `f${t}`, hook: (s) => (s.method === "DOM.getBoxModel" && s.params.backendNodeId === 4242 ? new Promise(() => {}) : undefined) });
  assert.ok(late.res.ok && pressOf(late));
  assert.equal(late.stage.counts.holdBoxReadFails, 1);
  assert.deepEqual(late.tab.sent.find((s) => s.method === "Page.captureScreenshot")!.params.clip, { x: 60, y: 220, width: 80, height: 40, scale: 1 }, "the hover's box");
});

test("board ab-t30.35, m2: Chrome's error at the read of the target's box before the press (the element left the document or has no box, or the page navigated), or at the hover's DOM.describeNode, refuses the press; no backendNodeId in time goes on, counted", async () => {
  // Chrome's errors of DOM.getBoxModel by a backendNodeId: a node that left the document, or one with no box (display: none).
  for (const message of ["No node with given id found", "Could not compute box model."]) {
    const r = await hold({ vector: withBackend(), shot: (t) => `f${t}`, hook: (s) => (s.method === "DOM.getBoxModel" && s.params.backendNodeId === 4242 ? Promise.reject(Object.assign(new Error(message), { code: -32000 })) : undefined) });
    assert.deepEqual(r.res, { ok: false, why: HOLD_NOT.gone }, message);
    assert.equal(pressOf(r), undefined, `${message}: no press`);
    assert.equal(r.stage.counts.holdBoxErrors, 1);
    assert.equal(r.stage.lock.held, 0, "the lock is free");
  }
  // Chrome's error at the hover's DOM.describeNode: no box read, and no press.
  const node = await hold({ vector: withBackend(), shot: (t) => `f${t}`, hook: (s) => (s.method === "DOM.describeNode" && s.params.objectId === "7.3.10" ? Promise.reject(new Error("Cannot find context with specified id")) : undefined) });
  assert.deepEqual(node.res, { ok: false, why: HOLD_NOT.gone });
  assert.equal(pressOf(node), undefined, "no press");
  assert.ok(!node.tab.sent.some((s) => s.method === "DOM.getBoxModel"), "no box read");
  assert.equal(node.stage.counts.holdNodeErrors, 1);
  // No answer of DOM.describeNode in GEOMETRY_WAIT_MS: no backendNodeId, so no box read; the hold goes on with the hover's box, counted.
  const none = await hold({ vector: withBackend(), maxMs: 1500, shot: (t) => `f${t}`, hook: (s) => (s.method === "DOM.describeNode" && s.params.objectId === "7.3.10" ? new Promise(() => {}) : undefined) });
  assert.ok(none.res.ok && pressOf(none), "the press goes");
  assert.equal(none.stage.counts.holdNoNode, 1);
  assert.equal(HOLD_NOT.gone, "the element is gone or has no box (the page changed after the hover); take a new snapshot and try again.");
});

test("a new document of the target's cross-origin frame (its reload, or its session's end) ends the hold, and the release goes at once", async () => {
  for (const how of ["reload", "detach"] as const) {
    // The box read has no answer in time (the hold goes on with the hover's box).
    const r = await hold({ shot: (t) => `f${t}`, hook: (s) => (s.method === "DOM.getBoxModel" ? new Promise(() => {}) : undefined), during: (x) => {
      // The hover's target in a cross-origin frame (its own session "child", the frame F-x): as hoverBefore keeps it.
      const st = (x.stage as any).tabs.get(x.tab.id);
      st.aim.child = "child"; st.aim.backend = 77;
      st.frames.set("child", { frameId: "F-x", parent: undefined });
      st.holdFrame = { child: "child", frameId: "F-x", loaded: false };
      x.clock.timer(2000, () => how === "reload"
        ? x.stage.event(x.tab, "child", "Page.frameNavigated", { frame: { id: "F-x", parentId: "main", url: "http://frame.test/again" } })
        : x.stage.event(x.tab, undefined, "Target.detachedFromTarget", { sessionId: "child" }));
    } });
    const q = releaseOf(r);
    assert.ok(q, `${how}: a release`);
    assert.equal(q.t, r.holdFrom + 2000, `${how}: the release at once`);
    assert.equal(r.res.ok && r.res.end, "frame", how);
  }
});

/**
 * The hover vector with its button in a cross-origin frame: the frame xf (F-xf) at 40,200 of the top page, on its own
 * session "child" (runVector attaches it); the setup comes on that session with the hit point in the frame's points. The
 * fake's DOM.describeNode gives no backendNodeId of the button (no box read before the press).
 */
const crossHover = () => {
  const v = vec("hover");
  v.page.frames = { xf: { origin: "cross", box: { x: 40, y: 200, width: 300, height: 100 }, border: 0, padding: 0 } };
  Object.assign(v.page.nodes["7.3.10"], { frame: "xf", box: { x: 20, y: 20, width: 80, height: 40 } });
  v.in[0].session = "child"; v.in[2].session = "child";
  v.in[0].params.arguments[5].value.a[2].o[1].v.o = [{ k: "x", v: 60 }, { k: "y", v: 40 }];
  return v;
};

test("board ab-t30.35, M1: a dialog that opens while the hold waits for the input lock (another tab holds a button, and the hold's tab has no action, so no plan ends): no press, and the answer names the dialog", async () => {
  let other: FakeTab | null = null, dialogAt = -1, otherReleased = -1;
  const r = await hold({ shot: (t) => `f${t}`, during: (x) => {
    // Another tab presses and holds its button for 1.5 s: its action keeps the input lock.
    other = new FakeTab({ ...vec("hover"), in: [] }, x.clock, { id: 2 });
    other.stage = x.stage;
    other.queue(undefined, "Input.dispatchMouseEvent", { type: "mousePressed", x: 500, y: 400, button: "left", buttons: 1, clickCount: 1, modifiers: 0, force: 0.5 }, () => {});
    x.clock.timer(1500, () => other!.queue(undefined, "Input.dispatchMouseEvent", { type: "mouseReleased", x: 500, y: 400, button: "left", buttons: 0, clickCount: 1, modifiers: 0 }, () => { otherReleased = x.clock.now(); }));
    // The hold's tab opens a dialog while its hold waits for the lock.
    x.clock.timer(300, () => { dialogAt = x.clock.now(); x.tab.dialogSeen = true; x.stage.event(x.tab, undefined, "Page.javascriptDialogOpening", { type: "alert", message: "x" }); });
  } });
  // The other tab's action (its path, then its press) took the lock before the dialog opened; the hold's action began
  // (its activation) only after the other tab's release, after the dialog.
  const otherFirst = other!.sent.find((s) => s.method === "Input.dispatchMouseEvent")!;
  assert.ok(otherFirst && otherFirst.t < dialogAt, "the other tab's action held the lock before the dialog");
  const mine = r.tab.activations.filter((t) => t >= r.holdFrom);
  assert.ok(mine.length > 0 && mine.every((t) => t > dialogAt), `the hold's action began after the dialog opened (${mine.join(", ")}; the dialog at ${dialogAt})`);
  assert.deepEqual(r.res, { ok: false, why: HOLD_NOT.dialog });
  assert.equal(pressOf(r), undefined, "no press");
  await r.clock.advance(3000);
  assert.ok(otherReleased > 0, "the other tab's release went");
  assert.equal(r.stage.lock.held, 0, "the lock is free");
});

test("board ab-t30.35, M3: a new document of the target's cross-origin frame, or the end of its session, between the hover and the press: no press, and the answer says that the element is gone", async () => {
  for (const how of ["reload", "detach"] as const) {
    const r = await hold({ vector: crossHover(), shot: (t) => `f${t}`, during: (x) => {
      // After the hover's answer, before the hold's step: the frame loads a new document, or its session ends.
      if (how === "reload") x.stage.event(x.tab, "child", "Page.frameNavigated", { frame: { id: "F-xf", parentId: "main", url: "http://frame.test/again" } });
      else x.stage.event(x.tab, undefined, "Target.detachedFromTarget", { sessionId: "child" });
    } });
    assert.deepEqual(r.res, { ok: false, why: HOLD_NOT.gone }, how);
    assert.equal(pressOf(r), undefined, `${how}: no press`);
    assert.equal(r.stage.counts.holdFrameLoads, 1, how);
    assert.equal(r.stage.lock.held, 0, `${how}: the lock is free`);
  }
});

test("board ab-t30.35, m2: the frame's end needs no backendNodeId: a hover in a cross-origin frame whose DOM.describeNode gives none still ends the hold at a new document of that frame, and the release goes at once", async () => {
  for (const how of ["no backendNodeId", "no answer in time"] as const) {
    const r = await hold({ vector: crossHover(), shot: (t) => `f${t}`, hook: (s) => (how === "no answer in time" && s.method === "DOM.describeNode" ? new Promise(() => {}) : undefined), during: (x) => {
      x.clock.timer(2000, () => x.stage.event(x.tab, "child", "Page.frameNavigated", { frame: { id: "F-xf", parentId: "main", url: "http://frame.test/again" } }));
    } });
    assert.ok(r.tab.sent.some((s) => s.method === "DOM.describeNode" && s.child === "child" && s.params.objectId === "7.3.10"), `${how}: the hover read the node on the frame's session`);
    assert.ok(!r.tab.sent.some((s) => s.method === "DOM.getBoxModel" && s.child === "child"), `${how}: no box read by a backendNodeId`);
    assert.equal(r.stage.counts.holdNoNode, 1, how);
    const p = pressOf(r), q = releaseOf(r);
    assert.ok(p && q, `${how}: a press and its release`);
    assert.equal(q.t, r.holdFrom + 2000, `${how}: the release at once`);
    assert.equal(r.res.ok && r.res.end, "frame", how);
  }
});

test("board ab-t30.35, m4: the frame's end is that frame's own: a new document of another frame on the same session, the same frame id on another session and the end of another session do not end the hold", async () => {
  const r = await hold({ vector: crossHover(), maxMs: 3000, shot: (t) => `f${t}`, during: (x) => {
    // A frame inside the target's frame (the same process, so the same session) loads a new document.
    x.clock.timer(800, () => x.stage.event(x.tab, "child", "Page.frameNavigated", { frame: { id: "F-inner", parentId: "F-xf", url: "http://frame.test/inner" } }));
    // Another frame's session (another cross-origin frame) gives a Page.frameNavigated with the target frame's id.
    x.clock.timer(1200, () => x.stage.event(x.tab, "child2", "Page.frameNavigated", { frame: { id: "F-xf", parentId: "main", url: "http://other.test/" } }));
    // Another frame's session ends.
    x.clock.timer(1600, () => x.stage.event(x.tab, undefined, "Target.detachedFromTarget", { sessionId: "child2" }));
  } });
  assert.ok(r.res.ok);
  if (r.res.ok) assert.equal(r.res.end, "limit", "the hold runs to its limit");
  const p = pressOf(r), q = releaseOf(r);
  assert.ok(Math.abs(q.t - p.t - 3000) <= 1e-6, `the release at maxMs (${q.t - p.t})`);
});

test("board ab-t30.35, m3: a dialog that opened during the hover (the pinned MCP answers the hover with its modal state and no error), or after the hover before the press: no press, and the answer names the dialog", async () => {
  // A mouseover handler on the hover's path opens an alert at the path's fifth move: the fake's Chrome drops each input
  // event while it is open, and Playwright's own move and the check's stop still get their answers.
  let open = false;
  const r = await hold({ shot: (t) => `f${t}`, setup: (t) => { let moves = 0; t.opensDialog = (s) => isMouse(s, "mouseMoved") && s.params.buttons === 0 && ++moves === 5; }, during: (x) => { open = x.stage.state(x.tab.id)?.dialog === true; } });
  assert.ok(open, "the dialog is open at the hold's call");
  assert.deepEqual(r.res, { ok: false, why: HOLD_NOT.dialog });
  assert.equal(pressOf(r), undefined, "no press");
  // The check at the hold's start (the review's M1): the hold takes no input lock and makes no activation.
  assert.deepEqual(r.tab.activations.filter((t) => t >= r.holdFrom), [], "no activation of the hold");
  assert.ok(!r.tab.sent.some((s) => s.t >= r.holdFrom && s.method === "Page.captureScreenshot"), "no pixel read");
  assert.equal(r.stage.counts.holdDialogs, 1);
  assert.equal(r.stage.lock.held, 0, "the lock is free");
  assert.deepEqual(r.stage.state(r.tab.id)?.buttons ?? [], []);
  // A dialog that opens after the hover, before the press (at the stage's read of the element at the press point): the
  // plan ends at the dialog, and the answer names it.
  let tab!: FakeTab;
  const later = await hold({ shot: (t) => `f${t}`, hook: (s) => {
    if (s.method === "ownRead" && s.params.fn === HOLD_KEEP) { tab.dialogSeen = true; tab.stage.event(tab, undefined, "Page.javascriptDialogOpening", { type: "alert", message: "x" }); return true; }
    return undefined;
  }, setup: (t) => { tab = t; } });
  assert.deepEqual(later.res, { ok: false, why: HOLD_NOT.dialog });
  assert.equal(pressOf(later), undefined, "no press");
  assert.equal(later.stage.lock.held, 0, "the lock is free");
  assert.equal(HOLD_NOT.dialog, "the page has a dialog open; handle the dialog, then take a new snapshot and try again.");
});

test("board ab-t30.35 (narrow re-check): a dialog that opens during the pause before the press ends the action there: no read of the element, no press, and the answer names the dialog", async () => {
  let dialogAt = -1;
  const r = await hold({ shot: (t) => `f${t}`, during: (x) => {
    // At the hold's call: its pause starts now (as after a last move now), and a dialog opens 5 ms into it, after the
    // hold's action began (the input lock is free) and before the pause ends.
    (x.stage as any).tabs.get(x.tab.id).lastMoveAt = x.clock.now();
    x.clock.timer(5, () => { dialogAt = x.clock.now(); x.tab.dialogSeen = true; x.stage.event(x.tab, undefined, "Page.javascriptDialogOpening", { type: "alert", message: "x" }); });
  } });
  assert.ok(dialogAt > 0, "the dialog opened during the hold's pause");
  assert.deepEqual(r.res, { ok: false, why: HOLD_NOT.dialog });
  assert.equal(pressOf(r), undefined, "no press");
  const reads = r.tab.sent.filter((s) => s.t >= dialogAt && (s.method === "DOM.getBoxModel" || (s.method === "ownRead" && s.params?.fn === HOLD_KEEP)));
  assert.deepEqual(reads.map((s) => s.method), [], "no read of the element after the dialog opened");
  assert.equal(r.stage.lock.held, 0, "the lock is free");
});

test("the input lock: another tab's input waits while the hold holds the button, and goes after the release", async () => {
  let other: FakeTab | null = null;
  const answers: number[] = [];
  const r = await hold({ maxMs: 3000, shot: (t) => `f${t}`, during: (x) => {
    other = new FakeTab({ ...vec("hover"), in: [] }, x.clock, { id: 2 });
    other.stage = x.stage;
    x.clock.timer(500, () => other!.queue(undefined, "Input.dispatchMouseEvent", { type: "mouseMoved", x: 500, y: 400, button: "none", buttons: 0, modifiers: 0 }, () => answers.push(x.clock.now())));
  } });
  await r.clock.run(() => answers.length > 0, r.clock.now() + 30_000);
  const q = releaseOf(r);
  const first = other!.sent.filter((s) => s.method.startsWith("Input.")).at(0)!;
  assert.ok(first.t >= q.t, `the other tab's first event (${first.t}) after the release (${q.t})`);
  await r.clock.advance(3000);
  assert.equal(r.stage.lock.held, 0, "the lock is free after the other tab's move run");
});

test("a Playwright client's own hold (mouse.down, a wait of 3 s, mouse.up) through the stage: the release goes at the client's time, with no hand moves of the stage", async () => {
  const v = vec("hover");
  v.in = [
    { id: 1, at: 0, method: "Input.dispatchMouseEvent", params: { type: "mouseMoved", x: 300, y: 300, button: "none", buttons: 0, modifiers: 0 } },
    { id: 2, after: 1, method: "Input.dispatchMouseEvent", params: { type: "mousePressed", x: 300, y: 300, button: "left", buttons: 1, clickCount: 1, modifiers: 0, force: 0.5 } },
    { id: 3, after: 2, waitMs: 3000, method: "Input.dispatchMouseEvent", params: { type: "mouseReleased", x: 300, y: 300, button: "left", buttons: 0, clickCount: 1, modifiers: 0 } },
  ];
  for (const seed of [1, 2, 3]) {
    const r = await runVector(v, { seed });
    const p = r.tab.sent.find((s) => isMouse(s, "mousePressed"))!, q = r.tab.sent.find((s) => isMouse(s, "mouseReleased"))!;
    const pressAnswer = r.answers.find((a) => a.id === 2)!;
    assert.ok(q.t - p.t >= 3000, `seed ${seed}: the hold lasts the client's 3 s (${q.t - p.t} ms)`);
    assert.ok(q.t - pressAnswer.t >= 3000 - 1e-9 && q.t - pressAnswer.t <= 3000 + 1e-6, "the release at its arrival");
    assert.equal(r.tab.sent.filter((s) => isMouse(s, "mouseMoved") && s.t > p.t && s.t < q.t).length, 0, "no hand moves in a client's own hold");
  }
});

test("the model: pressHold finds the one tab of the scope whose hover's setup came while the hover ran, and holds there; a second hold of the scope at the same time, a hover that fails and a hover with no setup are refusals", async () => {
  const h = await harness({ stage: true });
  try {
    await h.ready();
    const c = await h.connect("s1");
    await c.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    const attached = c.waitForEvent("Target.attachedToTarget");
    await c.send("Target.createTarget", { url: "about:blank" });
    const ev = await attached;
    const sid = ev.sessionId as string;
    const setup = { functionDeclaration: "(utilityScript, ...args) => utilityScript.evaluate(...args)", objectId: "7.3.1", returnByValue: false, awaitPromise: true, userGesture: true,
      arguments: [{ objectId: "7.3.1" }, { value: true }, { value: false }, { value: "([injected, node, { actionType: actionType2, hitPoint: hitPoint2, trial }]) => injected.setupHitTargetInterceptor(node, actionType2, hitPoint2, trial)" },
        { value: 1 }, { value: { a: [{ h: 0 }, { h: 1 }, { o: [{ k: "actionType", v: "hover" }, { k: "hitPoint", v: { o: [{ k: "x", v: 100 }, { k: "y", v: 240 }] } }, { k: "trial", v: false }] }] } },
        { objectId: "7.3.2" }, { objectId: "7.3.10" }] };
    const model = h.relay.model;
    // A hover that fails: the refusal, with the hover's reason.
    assert.deepEqual(await model.pressHold("s1", { maxMs: 1000 }, async () => ({ ok: false, why: "the hover of the element failed: Ref e9 not found." })), { ok: false, why: "the hover of the element failed: Ref e9 not found." });
    // A hover that ran no hit-target check (no setup): no tab.
    assert.deepEqual(await model.pressHold("s1", { maxMs: 1000 }, async () => ({ ok: true })), { ok: false, why: "the pointer did not reach the element (the hover ran no hit-target check)." });
    // The client's hover: its setup and its move; then the hold in that tab, to the time limit (the fake Chrome gives no pixels).
    const hover = async () => {
      await c.send("Runtime.callFunctionOn", setup, sid).catch(() => {});
      await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 100, y: 240, button: "none", buttons: 0, modifiers: 0 }, sid);
      return { ok: true as const };
    };
    const first = model.pressHold("s1", { maxMs: 1000 }, hover);
    const second = await model.pressHold("s1", { maxMs: 1000 }, async () => ({ ok: true }));
    assert.deepEqual(second, { ok: false, why: "another press and hold of this session runs; wait for its answer." });
    // Also while the first one holds (after its hover).
    await new Promise((r) => setTimeout(r, 500));
    assert.deepEqual(await model.pressHold("s1", { maxMs: 1000 }, async () => ({ ok: true })), { ok: false, why: "another press and hold of this session runs; wait for its answer." }, "one hold of a scope at a time");
    const r = await first;
    assert.ok(r.ok, JSON.stringify(r));
    if (r.ok) { assert.equal(r.end, "limit"); assert.ok(r.heldMs >= 1000 && r.heldMs < 1500, `${r.heldMs} ms`); assert.equal(r.pixels, "none"); }
    const sent = h.fake.requests.filter((q) => q.op === "debugger.sendCommand" && q.args[1] === "Input.dispatchMouseEvent").map((q) => q.args[2]);
    const press = sent.findIndex((p: any) => p.type === "mousePressed"), release = sent.findIndex((p: any) => p.type === "mouseReleased");
    assert.ok(press >= 0 && release > press, "a press, then its release");
    assert.equal(sent[press].force, 0.5);
    // Two tabs of the scope with a hover's setup while the hover runs: the refusal, and no press (the rule of one tab).
    await c.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    const att2 = c.waitForEvent("Target.attachedToTarget");
    await c.send("Target.createTarget", { url: "about:blank" });
    const sid2 = (await att2).sessionId as string;
    const presses = () => h.fake.requests.filter((q) => q.op === "debugger.sendCommand" && q.args[1] === "Input.dispatchMouseEvent" && q.args[2]?.type === "mousePressed").length;
    const p0 = presses();
    const two = await model.pressHold("s1", { maxMs: 1000 }, async () => {
      await c.send("Runtime.callFunctionOn", setup, sid).catch(() => {});
      await c.send("Runtime.callFunctionOn", setup, sid2).catch(() => {});
      return { ok: true as const };
    });
    assert.deepEqual(two, { ok: false, why: "another input of this session moved the pointer on another tab at the same time; try again." });
    // A tab of another scope with a setup while the hover runs: no tab of this scope, the refusal.
    const c2 = await h.connect("s2");
    await c2.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    const att3 = c2.waitForEvent("Target.attachedToTarget");
    await c2.send("Target.createTarget", { url: "about:blank" });
    const sid3 = (await att3).sessionId as string;
    const other = await model.pressHold("s1", { maxMs: 1000 }, async () => { await c2.send("Runtime.callFunctionOn", setup, sid3).catch(() => {}); return { ok: true as const }; });
    assert.deepEqual(other, { ok: false, why: "the pointer did not reach the element (the hover ran no hit-target check)." });
    // A tab of the scope whose scope changes before the hover ends (the receiver took it out of the scope): no tab.
    const moved = await model.pressHold("s1", { maxMs: 1000 }, async () => {
      await c.send("Runtime.callFunctionOn", setup, sid).catch(() => {});
      const t = [...(model as any).tabs.values()].find((x: any) => x.sessions?.has?.(sid) || false) ?? [...(model as any).tabs.values()].find((x: any) => x.scope === "s1");
      t.scope = "s9";
      return { ok: true as const };
    });
    assert.deepEqual(moved, { ok: false, why: "the pointer did not reach the element (the hover ran no hit-target check)." });
    assert.equal(presses(), p0, "no press in the three refusals");
  } finally { await h.close(); }
});

/** Playwright's hit-target setup of a hover on node 7.3.10 at 100,240 (Playwright 1.65.0's text). */
const HOVER_SETUP = { functionDeclaration: "(utilityScript, ...args) => utilityScript.evaluate(...args)", objectId: "7.3.1", returnByValue: false, awaitPromise: true, userGesture: true,
  arguments: [{ objectId: "7.3.1" }, { value: true }, { value: false }, { value: "([injected, node, { actionType: actionType2, hitPoint: hitPoint2, trial }]) => injected.setupHitTargetInterceptor(node, actionType2, hitPoint2, trial)" },
    { value: 1 }, { value: { a: [{ h: 0 }, { h: 1 }, { o: [{ k: "actionType", v: "hover" }, { k: "hitPoint", v: { o: [{ k: "x", v: 100 }, { k: "y", v: 240 }] } }, { k: "trial", v: false }] }] } },
    { objectId: "7.3.2" }, { objectId: "7.3.10" }] };
const ALERT = { type: "alert", message: "hi", url: "about:blank", hasBrowserHandler: false, defaultPrompt: "" };

// Board ab-t30.35, m1: a limit of C11 (the press and hold, its limits). The hold's answer at a dialog ends the call (a
// use of C12), so the MCP session can end while the dialog is open. Each end of the tab's state then sends the release
// at once, and the stage keeps no state of the tab for the dialog's close. Where the release goes (the review's I1 and
// M6): at the connection's end Chrome gets it while the dialog is open and drops it; at the link's end the bridge answers
// it `not connected` (the fake as the service's carrier); at Chrome's detach and at the tab's close the tab has no
// debugger. In no case does Chrome give the page a release.
test("board ab-t30.35, m1 (a limit of C11): a hold whose dialog is still open at the end of the session's connection, at the link's end, at Chrome's detach or at the tab's close: the release goes at once at that end and no release reaches the page, nothing goes at the dialog's later close, and the lock is free", async () => {
  for (const path of ["the connection's end", "the link's end", "Chrome's detach", "the tab's close"] as const) {
    const h = await harness({ stage: true });
    try {
      await h.ready();
      const c = await h.connect("s1");
      await c.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
      const attached = c.waitForEvent("Target.attachedToTarget");
      const { targetId } = await c.send("Target.createTarget", { url: "about:blank" });
      const sid = (await attached).sessionId as string;
      const tab = [...h.fake.tabs.values()].find((t) => t.targetId === targetId)!;
      // The fake Chrome: the hand's first move with the button down opens an alert (a handler of the page); while it is
      // open, Chrome answers each input event of the tab at once and drops it.
      const s = { open: false, dropped: [] as any[] };
      h.fake.command = (target, method, params) => {
        if (target.tabId !== tab.id || method !== "Input.dispatchMouseEvent") return undefined;
        if (s.open) { s.dropped.push(params); return {}; }
        if (params.type === "mouseMoved" && params.buttons === 1) {
          s.open = true;
          h.fake.emit("debugger.onEvent", { source: { tabId: tab.id }, method: "Page.javascriptDialogOpening", params: ALERT });
        }
        return undefined;
      };
      const model = h.relay.model, stage = (model as any).stage;
      const r = await model.pressHold("s1", { maxMs: 5000 }, async () => {
        await c.send("Runtime.callFunctionOn", HOVER_SETUP, sid).catch(() => {});
        await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 100, y: 240, button: "none", buttons: 0, modifiers: 0 }, sid);
        return { ok: true as const };
      });
      assert.ok(r.ok && r.end === "stopped" && r.why === HOLD_WHY.dialog, `${path}: the answer at the dialog (${JSON.stringify(r)})`);
      const isRelease = (q: { op: string; args: any[] }) => q.op === "debugger.sendCommand" && q.args[0]?.tabId === tab.id && q.args[1] === "Input.dispatchMouseEvent" && q.args[2]?.type === "mouseReleased";
      const released = () => h.fake.requests.filter(isRelease).length + h.fake.undelivered.filter(isRelease).length;
      await new Promise((res) => setTimeout(res, 100));
      const n0 = h.fake.requests.length;
      assert.equal(released(), 0, `${path}: no release while the dialog is open and the session runs`);
      assert.ok(stage.state(tab.id)?.buttons.includes("left"), `${path}: the button is down`);
      if (path === "the connection's end") await c.close();
      else if (path === "the link's end") h.fake.line({ t: "link", up: false });
      else if (path === "Chrome's detach") { h.fake.attached.delete(tab.id); h.fake.emit("debugger.onDetach", { source: { tabId: tab.id }, reason: "canceled_by_user" }); }
      else { h.fake.attached.delete(tab.id); h.fake.tabs.delete(tab.id); h.fake.emit("tabs.onRemoved", { tabId: tab.id, removeInfo: { windowId: 1, isWindowClosing: false } }); }
      // The release at once.
      await until(() => released() === 1, `${path}: the release`);
      if (path === "the connection's end") {
        // Chrome gets it while the dialog is open, and drops it; then the model detaches the tab.
        assert.ok(s.dropped.some((p) => p.type === "mouseReleased"), `${path}: Chrome got the release while the dialog was open, and dropped it`);
        const at = h.fake.requests.findIndex(isRelease);
        const detach = await until(() => { const i = h.fake.requests.findIndex((q, k) => k > n0 && q.op === "debugger.detach" && q.args[0] === tab.id); return i < 0 ? null : i + 1; }, `${path}: the detach`) - 1;
        assert.ok(at < detach, `${path}: the release (${at}) before the detach (${detach})`);
      } else {
        // It never reaches Chrome: the link is down (`not connected`), or the tab has no debugger.
        assert.equal(s.dropped.filter((p) => p.type === "mouseReleased").length, 0, `${path}: Chrome got no release`);
        if (path === "the link's end") assert.equal(h.fake.undelivered.filter(isRelease).length, 1, `${path}: the bridge answered the release \`not connected\``);
        else assert.equal(h.fake.requests.filter(isRelease).length, 1, `${path}: the release went to a tab with no debugger`);
      }
      await until(() => stage.lock.held === 0, `${path}: the lock to be free`);
      assert.equal(stage.state(tab.id), null, `${path}: the stage keeps no state of the tab`);
      // The dialog's later close: nothing goes.
      s.open = false;
      h.fake.emit("debugger.onEvent", { source: { tabId: tab.id }, method: "Page.javascriptDialogClosed", params: { result: true, userInput: "" } });
      await new Promise((res) => setTimeout(res, 300));
      assert.equal(released(), 1, `${path}: no release at the dialog's close`);
    } finally { await h.close(); }
  }
});
