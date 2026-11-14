// The open points of the input stage's pointer part (board ab-t30.17; PR #116's open points, review-116 and review-116b):
// a navigation of the main frame that closes a dialog (in both orders of Chrome's events), the client's Page.disable while
// a dialog is open, an ended press that opens a second dialog (note D), and the lock over the steps of mouse.move (N9).
// C11 "The input stage" (dialogs, the input lock) holds each rule; test/contracts-c11.test.ts holds its sentences.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DIALOG_READ, Stage, STAGE_ACTION_MAX_MS } from "../src/relay/stage.ts";
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

/** A dialog of `type` (its frame "main") that opens at the fifth move of the tab; Chrome drops what it gets while it is open. */
function dialogAtFifth(t: FakeTab, type: string) {
  let n = 0;
  t.hook = (s: Sent) => {
    if (s.method === "Input.dispatchMouseEvent" && s.params.type === "mouseMoved" && ++n === 5) {
      t.stage.event(t, undefined, "Page.javascriptDialogOpening", { ...DIALOG, type, frameId: "main" });
      setImmediate(() => { t.dialogSeen = true; });
    }
    return undefined;
  };
}
/** A click (move, press, release in one tick) of tab A whose path opens a dialog; `at` runs the test's own steps on the clock. */
async function navRun(type: string, at: (A: FakeTab, clock: FakeClock, answers: Map<string, any>) => void) {
  const { clock, stage, tab } = stageOf();
  const A = tab(1);
  dialogAtFifth(A, type);
  const answers = new Map<string, any>();
  for (const c of [mouse("mouseMoved", 300, 200), mouse("mousePressed", 300, 200), mouse("mouseReleased", 300, 200)]) A.queue(undefined, c.method, c.params, (b) => answers.set(c.params.type, b));
  at(A, clock, answers);
  clock.timer(1500, () => A.queue(undefined, "Runtime.evaluate", { expression: "1" }, (b) => answers.set("later", b)));
  await clock.run(() => answers.size === 4, 30_000);
  return { A, stage, answers };
}
const goneError = (b: any) => /context was destroyed/i.test(b?.error?.message ?? "");

test("point 1 (the measured order): a navigation of the main frame closes the dialog at its start, before its Page.frameNavigated: no held event reaches a page; each held call gets the error that the context is gone; the gate opens", async () => {
  for (const known of [false, true]) {
    const { A, stage, answers } = await navRun("confirm", (A, clock) => {
      // The main frame's id: from an earlier Page.frameNavigated, or else the open dialog's frame.
      if (known) A.stage.event(A, undefined, "Page.frameNavigated", { frame: { id: "main", url: "http://a.localhost/" } });
      clock.timer(500, () => A.stage.event(A, undefined, "Page.frameStartedNavigating", { frameId: "main", url: "http://a.localhost/next", loaderId: "L2", navigationType: "differentDocument" }));
      // Chrome closes the dialog 4 ms after the navigation's start (result false), and commits the new document later.
      clock.timer(504, () => { void A.pass(undefined, "Page.handleJavaScriptDialog", { accept: false }, () => {}); });
      clock.timer(900, () => A.navigate());
    });
    const close = A.sent.find((s) => s.method === "Page.handleJavaScriptDialog")!.t;
    assert.deepEqual(events(A).filter((s) => s.t >= close).map((s) => s.params.type), [], `known ${known}: no event after the close`);
    for (const k of ["mouseMoved", "mousePressed", "mouseReleased"]) assert.ok(goneError(answers.get(k)), `known ${known}: ${k}: ${JSON.stringify(answers.get(k))}`);
    assert.ok(answers.get("later")?.result, "the gate opens");
    assert.equal(stage.counts.navigationDrops, 1);
    assert.equal(stage.lock.held, 0);
  }
});

test("point 1 (the other order, and after the close): a navigation of the main frame while the held calls wait for the lock again: none of them goes; each gets the error that the context is gone", async () => {
  const { clock, stage, tab } = stageOf();
  const A = tab(1), B = tab(2);
  dialogAtFifth(A, "confirm");
  const answers = new Map<string, any>();
  for (const c of [mouse("mouseMoved", 300, 200), mouse("mousePressed", 300, 200), mouse("mouseReleased", 300, 200)]) A.queue(undefined, c.method, c.params, (b) => answers.set(c.params.type, b));
  // Another tab's action holds the lock at the close; A's main frame navigates before that action ends.
  let bDone = false;
  clock.timer(300, () => click(B, 700, 500, () => { bDone = true; }));
  clock.timer(320, () => { void A.pass(undefined, "Page.handleJavaScriptDialog", { accept: true }, () => {}); });
  clock.timer(340, () => A.navigate());
  await clock.run(() => answers.size === 3 && bDone, 30_000);
  const close = A.sent.find((s) => s.method === "Page.handleJavaScriptDialog")!.t;
  assert.ok(events(B)[0].t < close && events(B).at(-1)!.t > 340, "B's action holds the lock at the close and at the navigation");
  assert.deepEqual(events(A).filter((s) => s.t >= close).map((s) => s.params.type), [], "no held event reaches the new document");
  for (const k of ["mouseMoved", "mousePressed", "mouseReleased"]) assert.ok(goneError(answers.get(k)), `${k}: ${JSON.stringify(answers.get(k))}`);
  assert.equal(stage.lock.held, 0);
});

test("point 1 (the daemon lead's point): an accepted beforeunload dialog starts a navigation: its close sends no held event, and the held calls get the error that the context is gone; a dismissed one keeps the page, and the held events go", async () => {
  for (const accept of [true, false]) {
    const { A, answers } = await navRun("beforeunload", (A, clock) => {
      clock.timer(500, () => { void A.pass(undefined, "Page.handleJavaScriptDialog", { accept }, () => {}); });
    });
    const close = A.sent.find((s) => s.method === "Page.handleJavaScriptDialog")!.t;
    const after = events(A).filter((s) => s.t >= close && !s.dropped).map((s) => s.params.type);
    if (accept) {
      assert.deepEqual(after, [], "no held event after an accepted beforeunload");
      for (const k of ["mouseMoved", "mousePressed", "mouseReleased"]) assert.ok(goneError(answers.get(k)), `${k}: ${JSON.stringify(answers.get(k))}`);
    } else {
      assert.deepEqual(after, ["mouseMoved", "mousePressed", "mouseReleased"], "a dismissed beforeunload: the held events go");
      for (const k of ["mouseMoved", "mousePressed", "mouseReleased"]) assert.ok(answers.get(k)?.result, `${k}: Chrome's answer`);
    }
    assert.ok(answers.get("later")?.result, "the gate opens");
  }
});

test("point 1: a navigation that started before the dialog and is under way at its close is the close's navigation; one that stopped, a same-document one and one of another frame leave the close as it is", async () => {
  // Measured: the page's own navigation (location.href, then confirm() in the same mousedown handler) starts before the
  // dialog opens and commits only after its close.
  {
    const { A, answers } = await navRun("confirm", (A, clock) => {
      A.stage.event(A, undefined, "Page.frameNavigated", { frame: { id: "main", url: "http://a.localhost/" } });
      A.stage.event(A, undefined, "Page.frameStartedNavigating", { frameId: "main", url: "http://a.localhost/next", loaderId: "L2", navigationType: "differentDocument" });
      clock.timer(500, () => { void A.pass(undefined, "Page.handleJavaScriptDialog", { accept: true }, () => {}); });
    });
    const close = A.sent.find((s) => s.method === "Page.handleJavaScriptDialog")!.t;
    assert.deepEqual(events(A).filter((s) => s.t >= close).map((s) => s.params.type), [], "no held event after the close");
    for (const k of ["mouseMoved", "mousePressed", "mouseReleased"]) assert.ok(goneError(answers.get(k)), `${k}: ${JSON.stringify(answers.get(k))}`);
  }
  for (const kind of ["stopped", "sameDocument", "a frame"]) {
    const { A, answers } = await navRun("confirm", (A, clock) => {
      A.stage.event(A, undefined, "Page.frameNavigated", { frame: { id: "main", url: "http://a.localhost/" } });
      clock.timer(400, () => A.stage.event(A, undefined, "Page.frameStartedNavigating", { frameId: kind === "a frame" ? "F1" : "main", url: "http://a.localhost/#x", loaderId: "L2", navigationType: kind === "sameDocument" ? "sameDocument" : "differentDocument" }));
      if (kind === "stopped") clock.timer(450, () => A.stage.event(A, undefined, "Page.frameStoppedLoading", { frameId: "main" }));
      clock.timer(500, () => { void A.pass(undefined, "Page.handleJavaScriptDialog", { accept: true }, () => {}); });
    });
    const close = A.sent.find((s) => s.method === "Page.handleJavaScriptDialog")!.t;
    assert.deepEqual(events(A).filter((s) => s.t >= close && !s.dropped).map((s) => s.params.type), ["mouseMoved", "mousePressed", "mouseReleased"], kind);
    for (const k of ["mouseMoved", "mousePressed", "mouseReleased"]) assert.ok(answers.get(k)?.result, `${kind}: ${k}`);
  }
});

/** mouse.down() and mouse.up() of tab A at 900,700 whose press opens a confirm() (Chrome keeps the press until the close); `at` runs the test's own steps. */
async function pressRun(at: (A: FakeTab, clock: FakeClock) => void, maxMs = 30_000) {
  const { clock, stage, tab, logs } = stageOf();
  const A = tab(1);
  let presses = 0;
  A.opensDialog = (s) => s.method === "Input.dispatchMouseEvent" && s.params.type === "mousePressed" && ++presses === 1;
  const answers = new Map<string, any>();
  for (const c of [mouse("mousePressed", 900, 700), mouse("mouseReleased", 900, 700)]) A.queue(undefined, c.method, c.params, (b) => answers.set(c.params.type, b));
  at(A, clock);
  clock.timer(600, () => A.queue(undefined, "Runtime.evaluate", { expression: "1" }, (b) => answers.set("later", b)));
  await clock.run(() => answers.size === 3, maxMs);
  return { A, stage, answers, logs, clock };
}

test("point 2: the client's Page.disable while a dialog that Chrome's dialog manager keeps is open: the wait goes on until the stage's own read of the page answers (after the close); the release then goes and Chrome does not drop it", async () => {
  // The model gives the stage the client's Page.disable after Chrome's answer (it never waits in the tab's gate).
  const { A, stage, answers } = await pressRun((A, clock) => {
    clock.timer(500, () => A.stage.event(A, undefined, "Page.disable", {}));
    clock.timer(3000, () => A.endDialog()); // the dialog closes later, with no Closed event (Page is off)
  });
  const read = A.sent.find((s) => s.method === "ownRead" && s.params.fn === DIALOG_READ);
  assert.ok(read && read.t >= 500 && read.t <= 501, "the stage reads the page at the client's Page.disable");
  const rel = events(A).filter((s) => s.params.type === "mouseReleased");
  assert.deepEqual(rel.map((s) => !!s.dropped), [false], `one release, not dropped (${JSON.stringify(rel.map((s) => [s.t, s.dropped]))})`);
  assert.ok(rel[0].t >= 3000, `the release after the close (${rel[0].t}), not at the Page.disable`);
  const later = A.sent.find((s) => s.method === "Runtime.evaluate")!;
  assert.ok(later.t >= rel[0].t, "the gate opens after the release");
  assert.ok(answers.get("mouseReleased")?.result, "the held release gets Chrome's answer");
  assert.equal(stage.lock.held, 0);
});

test("point 2: the client's Page.disable that ends the dialog (Chrome with no dialog manager): the stage's read answers at once, and the held release goes at once, not dropped", async () => {
  const { A, answers } = await pressRun((A, clock) => {
    clock.timer(500, () => { A.endDialog(); A.stage.event(A, undefined, "Page.disable", {}); });
  });
  const rel = events(A).filter((s) => s.params.type === "mouseReleased");
  assert.deepEqual(rel.map((s) => !!s.dropped), [false]);
  assert.ok(rel[0].t >= 500 && rel[0].t <= 501, `the release at once (${rel[0].t})`);
  assert.ok(answers.get("later")?.result);
});

test("point 2: a dialog that stays open after the client's Page.disable, and no close: the wait ends at STAGE_ACTION_MAX_MS; the held events go, the gate opens, and the stage logs it", async () => {
  const { A, stage, answers, logs } = await pressRun((A, clock) => { clock.timer(500, () => A.stage.event(A, undefined, "Page.disable", {})); }, 120_000);
  const rel = events(A).find((s) => s.params.type === "mouseReleased")!;
  assert.ok(rel.t >= 500 + STAGE_ACTION_MAX_MS && rel.t <= 501 + STAGE_ACTION_MAX_MS, `the release at the limit (${rel.t})`);
  assert.ok(answers.get("later")?.result, "the gate opens");
  assert.equal(stage.counts.disableLimits, 1);
  assert.ok(logs.some((l) => /no close of the dialog in 25000 ms after the client's Page.disable/.test(l)));
  assert.equal(stage.lock.held, 0);
});
