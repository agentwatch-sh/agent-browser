// The drag of the input stage (board ab-t30.12.3; C11 "The input stage", the drag): Playwright's dragTo and mouse.move with
// a held button over an HTML5 draggable, as Playwright 1.64 to 1.66 sends them (its drag manager: Input.setInterceptDrags,
// the move with the left button down, Input.dispatchDragEvent), go as a person's drag. The fake Chrome here does what the
// task's probe measured on Chromium 156: a move with the button down more than 4 px from the press on one axis starts the
// drag, and Chrome's Input.dragIntercepted comes before the answer of that move. C11 holds each rule;
// test/contracts-c11.test.ts holds its sentences.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Stage, STAGE_EVENT_WAIT_MS } from "../src/relay/stage.ts";
import { seededRandom } from "../src/human/random.ts";
import { FakeClock, FakeTab, type Sent } from "./stage-fakes.ts";
import type { Body } from "../src/relay/stage.ts";

const SRC = { x: 140, y: 120 }, DST = { x: 580, y: 350 };
const DATA = { items: [{ mimeType: "text/plain", data: "payload" }], dragOperationsMask: 16 };
const own = () => ({ id: "own", platform: "linux", seed: 5, clock: 0, page: { viewport: { width: 1280, height: 720 }, last: { x: 900, y: 700 }, nodes: {}, focused: null }, chrome: {}, in: [], out: [], answers: [] });
const M = "Input.dispatchMouseEvent", D = "Input.dispatchDragEvent", I = "Input.setInterceptDrags";
const move = (p: { x: number; y: number }, down = false) => ({ type: "mouseMoved", x: p.x, y: p.y, button: down ? "left" : "none", buttons: down ? 1 : 0, modifiers: 0, ...(down ? { force: 0.5 } : {}) });
const press = (type: "mousePressed" | "mouseReleased", p: { x: number; y: number }) => ({ type, x: p.x, y: p.y, button: "left", buttons: type === "mousePressed" ? 1 : 0, modifiers: 0, clickCount: 1 });
const drag = (type: string, p: { x: number; y: number }) => ({ type, x: p.x, y: p.y, data: DATA, modifiers: 0 });

/** One stage and one tab; Chrome's drag (its threshold, its report before the move's answer) unless `report` is false. */
function setup(o: { seed?: number; report?: boolean } = {}) {
  const clock = new FakeClock();
  const stage = new Stage({ log: () => {}, random: seededRandom(o.seed ?? 4), platform: "linux", clock, stamp: clock.stamp, trace: true });
  const t = new FakeTab(own(), clock, { id: 1 });
  t.stage = stage;
  let at: { x: number; y: number } | null = null, reported = false;
  t.hook = (s: Sent) => {
    if (s.method === M && s.params.type === "mousePressed") at = { x: s.params.x, y: s.params.y };
    if (s.method === M && s.params.type === "mouseMoved" && s.params.buttons === 1 && at && !reported && (Math.abs(s.params.x - at.x) > 4 || Math.abs(s.params.y - at.y) > 4)) {
      reported = true;
      if (o.report !== false) stage.event(t, undefined, "Input.dragIntercepted", { data: DATA });
    }
    return undefined;
  };
  return { clock, stage, t };
}
/** The client's calls one after the other (each after the answer of the one before), as Playwright awaits each. */
function client(t: FakeTab, calls: [string, any][]) {
  const answers: { method: string; type?: string; body: Body; t: number }[] = [];
  const next = (i: number) => {
    if (i >= calls.length) return;
    const [method, params] = calls[i];
    t.queue(undefined, method, params, (body) => { answers.push({ method, type: params.type, body, t: t.clock.now() }); next(i + 1); });
  };
  next(0);
  return { answers, done: () => answers.length === calls.length };
}
/** Playwright's dragTo up to its move to the target (crDragDrop.ts: the interception on, the move, the interception off). */
const toTarget = (p = DST): [string, any][] => [[M, move(SRC)], [M, press("mousePressed", SRC)], [I, { enabled: true }], [M, move(p, true)], [I, { enabled: false }]];
const input = (t: FakeTab) => t.sent.filter((s) => s.method === M || s.method === D);

test("dragTo when Playwright's drag manager sees no drag (the stage's first moves are short): 100 to 300 ms after the press, a short path with the button down until Chrome's report, then the stage's own dragEnter and dragOver events at the device's rate to the target; the client's release goes as the drop after a pause; the lock is free", async () => {
  const { clock, stage, t } = setup();
  const c = client(t, [...toTarget(), [M, press("mouseReleased", DST)]]);
  await clock.run(c.done, 30_000);
  assert.ok(c.done());
  assert.ok(c.answers.every((a) => !("error" in a.body)), "no client's call fails");
  const ev = input(t), at = (s: Sent) => ev.indexOf(s);
  const pressed = ev.find((s) => s.params.type === "mousePressed")!;
  const down = ev.filter((s) => s.method === M && s.params.type === "mouseMoved" && s.params.buttons === 1);
  const drags = ev.filter((s) => s.method === D);
  assert.ok(down.length >= 2, `a short path with the button down (${down.length} moves)`);
  assert.ok(Math.max(Math.abs(down[0].params.x - SRC.x), Math.abs(down[0].params.y - SRC.y)) <= 4, "its first move is short (a person's start)");
  const wait = down[0].t - pressed.t;
  assert.ok(wait >= 100 && wait <= 300 + 8, `the first move ${wait} ms after the press`);
  assert.equal(drags[0].params.type, "dragEnter", "the stage's own dragEnter first (M12)");
  assert.deepEqual(drags[0].params.data, DATA, "with the data of Chrome's report");
  assert.ok(at(drags[0]) > at(down[down.length - 1]), "after the last move with the button down");
  const over = drags.filter((s) => s.params.type === "dragOver");
  assert.ok(over.length >= 10, `dragOver events along the path (${over.length})`);
  assert.equal(drags.filter((s) => s.params.type === "dragEnter").length, 1, "one dragEnter");
  const gaps = over.slice(1).map((s, i) => s.t - over[i].t);
  // The device's rate: each gap is a whole number of samples (a sample with no change of the whole px point sends nothing).
  assert.ok(gaps.every((g) => Math.abs(g - 8 * Math.round(g / 8)) < 0.5 && g >= 8), `the device's rate (${[...new Set(gaps)]})`);
  assert.ok(gaps.filter((g) => g === 8).length > gaps.length / 2, "most gaps are one sample");
  const last = over[over.length - 1];
  assert.deepEqual([last.params.x, last.params.y], [DST.x, DST.y], "the path ends at the target");
  const drop = drags[drags.length - 1];
  assert.equal(drop.params.type, "drop");
  assert.deepEqual([drop.params.x, drop.params.y, drop.params.data], [DST.x, DST.y, DATA]);
  assert.ok(drop.t - last.t >= 50, `a pause before the drop (${drop.t - last.t} ms)`);
  assert.equal(ev.filter((s) => s.params.type === "mouseReleased").length, 0, "no release reaches Chrome: the drop takes its place");
  assert.equal(c.answers.find((a) => a.type === "mouseMoved" && a.t > pressed.t)!.t >= last.t, true, "the client's move is answered after its path");
  const s = stage.state(1)!;
  assert.deepEqual([s.buttons, s.action], [[], false], "the button is up and the lock is free");
  assert.equal(stage.counts.drags, 1);
  assert.equal(stage.counts.drops, 1);
});

test("dragTo when Playwright's drag manager sees the drag: its dragEnter at the target goes as a dragOver at its point (the page has its dragenter already), and its drop goes after a pause", async () => {
  const { clock, stage, t } = setup();
  const c = client(t, [...toTarget(), [D, drag("dragEnter", DST)], [D, drag("drop", DST)]]);
  await clock.run(c.done, 30_000);
  assert.ok(c.done() && c.answers.every((a) => !("error" in a.body)));
  const drags = input(t).filter((s) => s.method === D);
  assert.equal(drags.filter((s) => s.params.type === "dragEnter").length, 1, "one dragEnter: the stage's own (the page gets no second dragenter)");
  assert.equal(drags[0].params.type, "dragEnter");
  const after = drags.slice(-2);
  assert.deepEqual(after.map((s) => [s.params.type, s.params.x, s.params.y]), [["dragOver", DST.x, DST.y], ["drop", DST.x, DST.y]], "the client's dragEnter as a dragOver, then its drop");
  assert.ok(after[1].t - after[0].t >= 50, "a pause before the drop");
  assert.deepEqual(stage.state(1)!.buttons, []);
  assert.equal(stage.state(1)!.action, false);
});

test("mouse.move with steps in a drag: the client's later moves with the button down, and its dragOver events, go as paths of dragOver events (no move with the button down after Chrome's report)", async () => {
  const { clock, t } = setup();
  const mid = { x: 360, y: 235 };
  const c = client(t, [...toTarget(mid), [I, { enabled: true }], [M, move(DST, true)], [I, { enabled: false }], [D, drag("dragOver", { x: 600, y: 360 })], [M, press("mouseReleased", { x: 600, y: 360 })]]);
  await clock.run(c.done, 30_000);
  assert.ok(c.done() && c.answers.every((a) => !("error" in a.body)));
  const ev = input(t), enter = ev.findIndex((s) => s.method === D && s.params.type === "dragEnter");
  assert.ok(enter > 0);
  assert.equal(ev.slice(enter).filter((s) => s.method === M).length, 0, "after the report, only drag events");
  const overs = ev.filter((s) => s.method === D && s.params.type === "dragOver");
  assert.ok(overs.some((s) => s.params.x === DST.x && s.params.y === DST.y) && overs.some((s) => s.params.x === 600 && s.params.y === 360), "each client's point is on a path");
  assert.ok(overs.filter((s) => s.t > overs.find((o) => o.params.x === DST.x && o.params.y === DST.y)!.t).length >= 2, "a path of dragOver events to the client's dragOver, not one jump");
  assert.equal(ev[ev.length - 1].params.type, "drop");
});

test("when Chrome reports no drag (the page's dragstart cancels it, or no draggable): the whole path goes with the button down, and the client's release goes as a release after the hold", async () => {
  const { clock, stage, t } = setup({ report: false });
  const c = client(t, [...toTarget(), [M, press("mouseReleased", DST)]]);
  await clock.run(c.done, 30_000);
  assert.ok(c.done() && c.answers.every((a) => !("error" in a.body)));
  const ev = input(t);
  assert.equal(ev.filter((s) => s.method === D).length, 0, "no drag event");
  const down = ev.filter((s) => s.params.type === "mouseMoved" && s.params.buttons === 1);
  assert.ok(down.length >= 10, `a path with the button down (${down.length} moves), not one jump`);
  assert.deepEqual([down[down.length - 1].params.x, down[down.length - 1].params.y], [DST.x, DST.y], "the path with the button down ends at the client's point");
  const rel = ev[ev.length - 1];
  assert.deepEqual([rel.params.type, rel.params.x, rel.params.y], ["mouseReleased", DST.x, DST.y]);
  assert.equal(stage.state(1)!.action, false);
  assert.equal(stage.counts.drops ?? 0, 0);
});

test("a drag event of a drag that the stage did not start goes as it is, counted (dragAsIs); its drop ends the client's press (no release after it), and the lock is free", async () => {
  const { clock, stage, t } = setup({ report: false });
  // A client's own drag (a raw CDP client): a press, then drag events with no move through the stage's drag.
  const c = client(t, [[M, move(SRC)], [M, press("mousePressed", SRC)], [D, drag("dragEnter", DST)], [D, drag("drop", DST)]]);
  await clock.run(c.done, 30_000);
  assert.ok(c.done() && c.answers.every((a) => !("error" in a.body)));
  const drags = input(t).filter((s) => s.method === D);
  assert.deepEqual(drags.map((s) => s.params), [drag("dragEnter", DST), drag("drop", DST)], "as the client sent them (no timestamp)");
  assert.equal(stage.counts.dragAsIs, 2);
  await clock.advance(STAGE_EVENT_WAIT_MS);
  const s = stage.state(1)!;
  assert.deepEqual([s.buttons, s.action], [[], false]);
  assert.equal(input(t).filter((x) => x.params.type === "mouseReleased").length, 0);
});

test("a dragCancel in a drag of the stage goes as it is and ends the drag: the button is up and the lock is free", async () => {
  const { clock, stage, t } = setup();
  const c = client(t, [...toTarget(), [D, { type: "dragCancel", x: DST.x, y: DST.y, data: { items: [], dragOperationsMask: 65535 } }]]);
  await clock.run(c.done, 30_000);
  assert.ok(c.done() && c.answers.every((a) => !("error" in a.body)));
  const last = input(t).at(-1)!;
  assert.deepEqual([last.method, last.params.type], [D, "dragCancel"]);
  assert.deepEqual(last.params.data, { items: [], dragOperationsMask: 65535 }, "as the client sent it");
  const s = stage.state(1)!;
  assert.deepEqual([s.buttons, s.action], [[], false]);
});

test("the end of a plan in a drag that Chrome reported (a dragOver that Chrome never answers: STAGE_EVENT_WAIT_MS): the end sends a dragCancel in place of the release of the button", async () => {
  const { clock, stage, t } = setup();
  const hook = t.hook;
  let overs = 0;
  t.hook = (s: Sent) => (s.method === D && s.params.type === "dragOver" && ++overs === 5 ? new Promise(() => {}) : hook(s));
  const c = client(t, toTarget());
  await clock.run(() => c.answers.length >= 4 && stage.state(1)!.action === false, 30_000);
  const ev = input(t);
  const cancel = ev.find((s) => s.method === D && s.params.type === "dragCancel");
  assert.ok(cancel, "a dragCancel ends the drag");
  assert.deepEqual(cancel!.params.data, DATA);
  assert.equal(ev.filter((s) => s.params.type === "mouseReleased").length, 0, "no release of the button in the drag");
  assert.deepEqual(stage.state(1)!.buttons, []);
});

test("review-138 N2: a client's drop that waits in the tab's gate when the plan ends (an ended plan) goes as it is and ends the drag and the press: no dragCancel and no release go after it", async () => {
  const { clock, stage, t } = setup();
  const hook = t.hook;
  let overs = 0, dropped: Body | null = null;
  t.hook = (s: Sent) => {
    if (s.method === D && s.params.type === "dragOver" && ++overs === 1) t.queue(undefined, D, drag("drop", DST), (b) => { dropped = b; });
    return s.method === D && s.params.type === "dragOver" && overs === 5 ? new Promise(() => {}) : hook(s);
  };
  const c = client(t, toTarget());
  await clock.run(() => dropped !== null && c.done() && stage.state(1)!.action === false, 30_000);
  await clock.advance(STAGE_EVENT_WAIT_MS);
  const ev = input(t), drop = ev.findIndex((s) => s.method === D && s.params.type === "drop");
  assert.ok(drop >= 0 && !("error" in dropped!), "the drop goes and gets Chrome's answer");
  assert.deepEqual(ev.slice(drop + 1).map((s) => s.params.type), [], "nothing after the drop");
  assert.deepEqual(stage.state(1)!.buttons, []);
});

test("review-138 N3: a drop or a dragCancel that Chrome answers with an error keeps the drag and the press: the plan's stop sends the dragCancel (a drag that Chrome reported) or the release (a drag that the stage did not start) after it", async () => {
  const refuse = (t: FakeTab, type: string) => { const hook = t.hook; t.hook = (s: Sent) => (s.method === D && s.params.type === type ? Promise.reject(Object.assign(new Error(`${type} failed`), { code: -32000 })) : hook(s)); };
  const cancel = { type: "dragCancel", x: DST.x, y: DST.y, data: { items: [], dragOperationsMask: 65535 }, modifiers: 0 };
  const cases: [string, boolean, [string, any][], string][] = [
    ["the stage's drop", true, [...toTarget(), [D, drag("drop", DST)]], "dragCancel"],
    ["a dragCancel as it is", true, [...toTarget(), [D, cancel]], "dragCancel"],
    ["a drop of a drag that the stage did not start", false, [[M, move(SRC)], [M, press("mousePressed", SRC)], [D, drag("dragEnter", DST)], [D, drag("drop", DST)]], "mouseReleased"],
  ];
  for (const [name, report, calls, after] of cases) {
    const { clock, stage, t } = setup({ report });
    const type = calls.at(-1)![1].type;
    refuse(t, type);
    const c = client(t, calls);
    await clock.run(c.done, 30_000);
    assert.ok("error" in c.answers.at(-1)!.body, `${name}: the client gets the error`);
    const ev = input(t), i = ev.findIndex((s) => s.method === D && s.params.type === type);
    assert.deepEqual(ev.slice(i + 1).map((s) => s.params.type), [after], `${name}: ${after} after it`);
    assert.deepEqual(stage.state(1)!.buttons, [], name);
  }
});

test("review-138 N5: when Chrome's report comes with the last move of the path, the stage's dragEnter goes at the client's point", async () => {
  const { clock, stage, t } = setup({ report: false });
  const hook = t.hook;
  let reported = false;
  t.hook = (s: Sent) => {
    if (!reported && s.method === M && s.params.type === "mouseMoved" && s.params.buttons === 1 && s.params.x === DST.x && s.params.y === DST.y) { reported = true; stage.event(t, undefined, "Input.dragIntercepted", { data: DATA }); }
    return hook(s);
  };
  const c = client(t, toTarget());
  await clock.run(c.done, 30_000);
  assert.ok(reported, "the report came at the client's point");
  const drags = input(t).filter((s) => s.method === D);
  assert.deepEqual(drags.map((s) => [s.params.type, s.params.x, s.params.y]), [["dragEnter", DST.x, DST.y]]);
  assert.deepEqual(drags[0].params.data, DATA);
});

test("review-138 N5: a drop at another point than the page's last one gets the drag's path there first, then the drop at its point", async () => {
  const { clock, t } = setup();
  const OTHER = { x: 760, y: 430 };
  const c = client(t, [...toTarget(), [D, drag("drop", OTHER)]]);
  await clock.run(c.done, 30_000);
  assert.ok(c.answers.every((a) => !("error" in a.body)));
  const ev = input(t).filter((s) => s.method === D), k = ev.findLastIndex((s) => s.params.x === DST.x && s.params.y === DST.y);
  const path = ev.slice(k + 1, -1);
  assert.ok(path.length >= 2 && path.every((s) => s.params.type === "dragOver"), `a path of dragOver events (${path.length})`);
  assert.deepEqual([path.at(-1)!.params.x, path.at(-1)!.params.y], [OTHER.x, OTHER.y]);
  assert.deepEqual([ev.at(-1)!.params.type, ev.at(-1)!.params.x, ev.at(-1)!.params.y], ["drop", OTHER.x, OTHER.y]);
});

test("review-138 N5: a dialog in a drag that Chrome reported ends the plan: after the close the end sends a dragCancel in place of the release of the button", async () => {
  const { clock, stage, t } = setup();
  const hook = t.hook;
  let overs = 0;
  t.hook = (s: Sent) => {
    if (s.method === D && s.params.type === "dragOver" && ++overs === 3) {
      t.clientEvents.push({ t: t.clock.now(), method: "Page.javascriptDialogOpening" });
      stage.event(t, undefined, "Page.javascriptDialogOpening", { type: "alert", message: "x", frameId: "main" });
      setImmediate(() => { t.dialogSeen = true; });
      t.clock.timer(300, () => { void t.pass(undefined, "Page.handleJavaScriptDialog", { accept: true }, () => {}); });
    }
    return hook(s);
  };
  const c = client(t, toTarget());
  await clock.run(() => c.done() && stage.state(1)!.action === false, 30_000);
  assert.equal(stage.counts.dialogEnds, 1);
  const close = t.sent.find((s) => s.method === "Page.handleJavaScriptDialog")!.t;
  const after = input(t).filter((s) => s.t >= close && !s.dropped);
  assert.ok(after.some((s) => s.method === D && s.params.type === "dragCancel"), "a dragCancel after the close");
  assert.deepEqual(after.find((s) => s.params.type === "dragCancel")!.params.data, DATA);
  assert.equal(input(t).filter((s) => s.params.type === "mouseReleased").length, 0, "no release of the button in the drag");
  assert.deepEqual(stage.state(1)!.buttons, []);
});
