// The open points of the input stage's pointer part (board ab-t30.17; PR #116's open points, review-116 and review-116b):
// a navigation of the main frame that closes a dialog (in both orders of Chrome's events), the client's Page.disable while
// a dialog is open, an ended press that opens a second dialog (note D), and the lock over the steps of mouse.move (N9).
// C11 "The input stage" (dialogs, the input lock) holds each rule; test/contracts-c11.test.ts holds its sentences.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Stage } from "../src/relay/stage.ts";
import { seededRandom } from "../src/human/random.ts";
import { FakeClock, FakeTab, type Sent } from "./stage-fakes.ts";

const mouse = (type: string, x: number, y: number, extra: object = {}) => ({ method: "Input.dispatchMouseEvent", params: { type, x, y, button: type === "mouseMoved" ? "none" : "left", buttons: type === "mousePressed" ? 1 : 0, modifiers: 0, ...(type === "mouseMoved" ? {} : { clickCount: 1 }), ...(type === "mousePressed" ? { force: 0.5 } : {}), ...extra } });
const events = (t: FakeTab) => t.sent.filter((s) => s.method.startsWith("Input.") && s.pass === undefined);
const own = (page: Partial<any> = {}) => ({ id: "own", platform: "linux", seed: 5, clock: 0, page: { viewport: { width: 1280, height: 720 }, last: { x: 900, y: 700 }, nodes: {}, focused: null, ...page }, chrome: {}, in: [], out: [], answers: [] });
const DIALOG = { type: "alert", message: "x", url: "http://a.localhost/", hasBrowserHandler: false, defaultPrompt: "" };

/** One stage with tabs of their own fake Chrome on one clock. */
function stageOf(seed = 4) {
  const clock = new FakeClock();
  const logs: string[] = [];
  const stage = new Stage({ log: (l) => logs.push(l), random: seededRandom(seed), platform: "linux", clock, stamp: clock.stamp });
  const tab = (id: number) => { const t = new FakeTab(own(), clock, { id }); t.stage = stage; return t; };
  return { clock, stage, logs, tab };
}

/** A dialog that opens at the fifth move of the tab (a mouseover handler): Chrome drops what it gets while it is open. */
function dialogAtFifthMove(t: FakeTab) {
  let n = 0;
  t.hook = (s: Sent) => {
    if (s.method === "Input.dispatchMouseEvent" && s.params.type === "mouseMoved" && ++n === 5) {
      t.clientEvents.push({ t: t.clock.now(), method: "Page.javascriptDialogOpening" });
      t.stage.event(t, undefined, "Page.javascriptDialogOpening", DIALOG);
      setImmediate(() => { t.dialogSeen = true; });
    }
    return undefined;
  };
}

test("note D: an ended press that opens a second dialog, with no client release left: the stage's release waits for the press's answer (after that dialog's close), so Chrome does not drop it; the client's later release gets no second event", async () => {
  const { clock, stage, tab } = stageOf();
  const A = tab(1);
  dialogAtFifthMove(A);
  // The ended press (it goes after the first dialog's close) opens a confirm() in its mousedown handler.
  let presses = 0;
  A.opensDialog = (s) => s.method === "Input.dispatchMouseEvent" && s.params.type === "mousePressed" && ++presses === 1;
  const answers: string[] = [];
  A.queue(undefined, "Input.dispatchMouseEvent", mouse("mouseMoved", 300, 200).params, () => answers.push("move"));
  // mouse.down(): the client sends its release only after the press's answer (mouse.up()).
  A.queue(undefined, "Input.dispatchMouseEvent", mouse("mousePressed", 300, 200).params, () => {
    answers.push("press");
    A.queue(undefined, "Input.dispatchMouseEvent", mouse("mouseReleased", 300, 200).params, () => answers.push("release"));
  });
  clock.timer(250, () => { void A.pass(undefined, "Page.handleJavaScriptDialog", { accept: true }, () => answers.push("dialog 1")); });
  clock.timer(1000, () => { void A.pass(undefined, "Page.handleJavaScriptDialog", { accept: true }, () => answers.push("dialog 2")); });
  await clock.run(() => answers.length === 5, 30_000);
  const closes = A.sent.filter((s) => s.method === "Page.handleJavaScriptDialog").map((s) => s.t);
  assert.equal(closes.length, 2);
  const press = events(A).find((s) => s.params.type === "mousePressed")!;
  assert.ok(press.t >= closes[0] && press.t < closes[1] && !press.dropped, "the ended press goes after the first close and opens the second dialog");
  const releases = events(A).filter((s) => s.params.type === "mouseReleased");
  assert.deepEqual(releases.map((s) => !!s.dropped), [false], `one release, never dropped (${JSON.stringify(releases.map((s) => [s.t, s.dropped]))})`);
  assert.ok(releases[0].t >= closes[1], "the release goes after the second dialog's close");
  assert.equal(stage.lock.held, 0, "the lock is free");
});

/** mouse.move(x, y, { steps }) of tab `t` from its last point: each step a client call that goes `gapMs` after the answer of the one before. */
function steps(t: FakeTab, points: [number, number][], gapMs: number, done: (tAt: number) => void, i = 0): void {
  const [x, y] = points[i];
  t.queue(undefined, "Input.dispatchMouseEvent", mouse("mouseMoved", x, y).params, () => {
    if (i + 1 < points.length) t.clock.timer(gapMs, () => steps(t, points, gapMs, done, i + 1));
    else done(t.clock.now());
  });
}
const click = (t: FakeTab, x: number, y: number, done: () => void) => {
  for (const c of [mouse("mouseMoved", x, y), mouse("mousePressed", x, y), mouse("mouseReleased", x, y)]) t.queue(undefined, c.method, c.params, () => { if (c.params.type === "mouseReleased") done(); });
};

test("N9: the lock holds for the whole mouse.move with steps: another tab's click that arrives during the first step waits until after the last step; one activation for the move", async () => {
  const { clock, stage, tab } = stageOf();
  const A = tab(1), B = tab(2);
  let aDone = -1, bDone = false;
  clock.timer(0, () => steps(A, [[920, 700], [940, 700], [960, 700], [980, 700]], 3, (at) => { aDone = at; }));
  clock.timer(5, () => click(B, 300, 200, () => { bDone = true; }));
  await clock.run(() => aDone >= 0 && bDone, 30_000);
  const ea = events(A), eb = events(B);
  assert.ok(ea.length >= 8 && eb.length > 5);
  assert.ok(eb[0].t >= ea.at(-1)!.t, `B's first event (${eb[0].t}) after A's last step (${ea.at(-1)!.t})`);
  assert.equal(A.activations.length, 1, "one activation for the four steps");
  assert.equal(stage.lock.held, 0);
});

test("N9: a move run ends at the tab's next call that the stage does not take (the lock is free at once), and with no call RUN_IDLE_MS after the move", async () => {
  for (const next of [true, false]) {
    const { clock, stage, tab } = stageOf();
    const A = tab(1), B = tab(2);
    let aDone = -1, bDone = false;
    clock.timer(0, () => steps(A, [[920, 700]], 3, (at) => {
      aDone = at;
      if (next) clock.timer(3, () => A.queue(undefined, "Runtime.evaluate", { expression: "1" }, () => {}));
    }));
    clock.timer(5, () => click(B, 300, 200, () => { bDone = true; }));
    await clock.run(() => aDone >= 0 && bDone, 30_000);
    const eb = events(B);
    const evaluate = A.sent.find((s) => s.method === "Runtime.evaluate");
    if (next) assert.ok(evaluate && eb[0].t >= evaluate.t && eb[0].t - aDone <= 50, `B's first event at ${eb[0].t}: at A's next call (${evaluate?.t}), not RUN_IDLE_MS later`);
    else assert.ok(eb[0].t - aDone >= 1000 && eb[0].t - aDone <= 1050, `B's first event ${eb[0].t - aDone} ms after A's move: RUN_IDLE_MS`);
    assert.equal(stage.lock.held, 0);
  }
});
