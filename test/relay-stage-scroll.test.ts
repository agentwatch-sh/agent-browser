// The input stage's scroll and wheel (board ab-t30.11; the input design's sections 8 and 13.4, and build task 7; C11 "The
// input stage", the scroll and the wheel, with test/vectors/stage.json). The scroll and wheel vectors run in
// relay-stage.test.ts; here a test for each rule that the vectors do not show: the notches of mouse.wheel with the
// residual, their gaps and timestamps, the page's last point, the lock and the one action, every end of a plan (a dialog,
// STAGE_EVENT_WAIT_MS, an error, a navigation, a session's end) and the gate; DOM.scrollIntoViewIfNeeded's translation:
// the in-view rule, the client's rect, the wheel point's three rules, the end after a round that does not move the
// scroller, STAGE_SCROLL_ROUNDS, inner scrollers, frames (same-origin and cross-origin), the reads' limit, dialogs and
// the retry scroll's count; the focus click's notches into view, also inside a frame's own scroller; and the Mac's pass.
// A fake Chrome (stage-fakes.ts) moves its scrollers by the wheel events, as Chromium does.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { seededRandom } from "../src/human/random.ts";
import { SCROLL_STATE, SCROLL_WAIT_MS, Stage, STAGE_EVENT_WAIT_MS, STAGE_NOTCH_PX, STAGE_SCROLL_ROUNDS } from "../src/relay/stage.ts";
import { FakeClock, FakeTab, runVector, type Sent } from "./stage-fakes.ts";

const V = JSON.parse(readFileSync(new URL("./vectors/stage.json", import.meta.url), "utf8"));
const F = V.firstValues;
const vec = (id: string) => structuredClone(V.vectors.find((x: any) => x.id === id));

// ---------------------------------------------------------------- the client's calls

const wheel = (dx: number, dy: number, x = 640, y = 360) => ({ method: "Input.dispatchMouseEvent", params: { type: "mouseWheel", x, y, modifiers: 0, deltaX: dx, deltaY: dy } });
const scroll = (node: string, o: { session?: string; rect?: object } = {}) => ({ method: "DOM.scrollIntoViewIfNeeded", ...(o.session ? { session: o.session } : {}), params: { objectId: node, ...(o.rect ? { rect: o.rect } : {}) } });
const evaluate = () => ({ method: "Runtime.evaluate", params: { expression: "1" } });
const FILL_FN = vec("fill").in[0].params.arguments[3].value, FOCUS_FN = vec("press-sequentially").in[0].params.arguments[3].value;
const RETRY_FN = V.recognizers.find((r: any) => r.name === "retry scroll").texts["1.65.0"];
const util = (fn: string, arg: unknown, node: string, session?: string) => ({ method: "Runtime.callFunctionOn", ...(session ? { session } : {}),
  params: { functionDeclaration: "(utilityScript, ...args) => utilityScript.evaluate(...args)", objectId: "7.3.1", returnByValue: true, awaitPromise: true, userGesture: true,
    arguments: [{ objectId: "7.3.1" }, { value: true }, { value: true }, { value: fn }, { value: 1 }, { value: { a: [{ h: 0 }, { h: 1 }, arg] } }, { objectId: "7.3.2" }, { objectId: node }] } });
const fillCall = (node: string, value: string, session?: string) => util(FILL_FN, { o: [{ k: "value", v: value }, { k: "force", v: false }, { k: "frameVisible", v: true }] }, node, session);
const focusCall = (node: string, session?: string) => util(FOCUS_FN, true, node, session);
const insert = (text: string) => ({ method: "Input.insertText", params: { text } });

/** A vector of the tests' own: the calls in order, each after the answer of the one before unless it names `at`, `after` or `afterEvent`. */
function own(calls: any[], page: Partial<any> = {}, extra: Partial<any> = {}) {
  const ins = calls.map((c, i) => ({ id: i + 1, ...(c.at === undefined && c.after === undefined && c.afterEvent === undefined ? (i === 0 ? { at: 0 } : { after: i }) : {}), ...c }));
  return { id: "own", platform: "linux", seed: 11, clock: 0, page: { viewport: { width: 1280, height: 720 }, last: { x: 640, y: 360 }, nodes: {}, focused: null, ...page },
    chrome: { results: Object.fromEntries(ins.filter((c) => c.method === "Runtime.callFunctionOn" && c.params.arguments?.[3]?.value === FILL_FN).map((c) => [c.id, { result: { type: "string", value: "needsinput" } }])) },
    in: ins, out: [], answers: [], ...extra };
}
/** A page whose document scrolls (`h` px tall), with its facts. */
const DOC = (h = 4000, extra: object = {}) => ({ scrollers: { document: { scrollY: 0, height: h, ...extra } } });
const BUTTON = (y = 2400, o: object = {}) => ({ tag: "button", box: { x: 600, y, width: 100, height: 40 }, focused: false, ...o });
const INPUT = (o: object = {}) => ({ tag: "input", type: "text", box: { x: 200, y: 2400, width: 300, height: 30 }, text: 0, focused: false, ...o });
const notchesOf = (t: FakeTab) => t.sent.filter((s) => s.method === "Input.dispatchMouseEvent" && s.params.type === "mouseWheel" && s.pass === undefined);
const movesOf = (t: FakeTab) => t.sent.filter((s) => s.method === "Input.dispatchMouseEvent" && s.params.type === "mouseMoved" && s.pass === undefined);
const pressOf = (t: FakeTab) => t.sent.find((s) => s.method === "Input.dispatchMouseEvent" && s.params.type === "mousePressed" && s.pass === undefined);
const passOf = (t: FakeTab, id: number) => t.sent.find((s) => s.pass === id);
const answerOf = (r: Awaited<ReturnType<typeof runVector>>, id: number) => r.answers.find((a) => a.id === id)!;
/** The notches in runs: a new run after a gap of more than 100 ms (a round of the scroll). */
function rounds(ns: Sent[]): Sent[][] {
  const out: Sent[][] = [];
  for (const s of ns) { const last = out.at(-1); if (last && s.t - last.at(-1)!.t <= 100) last.push(s); else out.push([s]); }
  return out;
}
const at = (s: Sent) => [s.params.x, s.params.y];

// ================================================================ mouse.wheel

test("mouse.wheel: notches of STAGE_NOTCH_PX at the page's last point (not the client's), the vertical axis first, 35 to 90 ms apart; each with the stage's timestamp (whole ms, 3 to 5 ms before its send); the activation before the first; the answer after the last", async () => {
  for (let seed = 1; seed <= 8; seed++) {
    const r = await runVector(own([wheel(240, 360, 700, 400)], DOC(4000, { width: 3000 })), { seed });
    const n = notchesOf(r.tab);
    assert.deepEqual(n.map((s) => [s.params.deltaX, s.params.deltaY]), [[0, 120], [0, 120], [0, 120], [120, 0], [120, 0]], `seed ${seed}: 3 notches down, then 2 right`);
    assert.ok(n.every((s) => s.params.x === 640 && s.params.y === 360), "at the page's last point");
    assert.equal(STAGE_NOTCH_PX, 120);
    for (let i = 1; i < n.length; i++) assert.ok(n[i].t - n[i - 1].t >= F.notchGapMs[0] && n[i].t - n[i - 1].t <= F.notchGapMs[1], `a gap of ${n[i].t - n[i - 1].t} ms`);
    for (const s of n) {
      const ts = s.params.timestamp * 1000;
      assert.ok(Math.abs(ts - Math.round(ts)) < 1e-6 && r.clock.epoch + s.t - ts >= 3 - 0.5 && r.clock.epoch + s.t - ts <= 5 + 0.5, `the stage's timestamp (${r.clock.epoch + s.t - ts} ms before the send)`);
    }
    assert.ok(r.tab.activations.length === 1 && r.tab.activations[0] <= n[0].t, "the activation before the first notch");
    assert.ok(answerOf(r, 1).t >= n.at(-1)!.t && !answerOf(r, 1).body.error, "the answer after the last notch");
    assert.deepEqual([r.tab.sc.document.x, r.tab.sc.document.y], [240, 360]);
    assert.equal(r.stage.lock.held, 0);
  }
});

test("mouse.wheel's residual: ten calls of 100 px give 960 px, the asked total within one notch (round half up with the residual); a call that earlier notches have given gets no event and its answer at once; a call against the residual's direction", async () => {
  const r = await runVector(own([...Array.from({ length: 10 }, () => wheel(0, 100)), wheel(0, -100), wheel(0, -10)], DOC()));
  const n = notchesOf(r.tab), total = n.reduce((a, s) => a + s.params.deltaY, 0);
  // The counts: 1, 1, 1 (half up), 0, 1, 1, 1, 1, 1, 0 (960 px for 1000); then -100 against a residual of +40 (round(60 / 120) = 1, half up);
  // then -10 against a residual of +60: n = max(0, round(-50 / 120)) = 0, and r is below 0: no notch.
  const per = r.answers.map((a) => n.filter((s) => s.t <= a.t).length);
  const counts = per.map((c, i) => c - (i ? per[i - 1] : 0));
  assert.deepEqual(counts, [1, 1, 1, 0, 1, 1, 1, 1, 1, 0, 1, 0], "the notches of each call");
  assert.ok(Math.abs(1000 - 120 * counts.slice(0, 10).reduce((a, c) => a + c, 0)) < STAGE_NOTCH_PX, "the asked total within one notch");
  assert.equal(total, 960 - 120);
  for (const id of [4, 10, 12]) assert.deepEqual(answerOf(r, id).body, { result: {} }, `call ${id}: the stage's answer, with no event`);
  assert.equal(r.stage.counts.wheelNoNotch, 3);
  // C11: when n is 0 and r is 0 or more, the call gets one notch.
  const one = await runVector(own([wheel(0, 10)], DOC()));
  assert.equal(notchesOf(one.tab).length, 1);
});

test("mouse.wheel: the first notch of a later call comes at the later of its arrival and one person's gap after the page's last notch; a call that comes later gets its first notch at its arrival", async () => {
  for (let seed = 1; seed <= 6; seed++) {
    const r = await runVector(own([wheel(0, 240), wheel(0, 240), { after: 2, waitMs: 3000, ...wheel(0, 120) }], DOC()), { seed });
    const n = notchesOf(r.tab);
    assert.equal(n.length, 5);
    for (let i = 1; i < 4; i++) assert.ok(n[i].t - n[i - 1].t >= F.notchGapMs[0] && n[i].t - n[i - 1].t <= F.notchGapMs[1], `seed ${seed}: notch ${i} ${n[i].t - n[i - 1].t} ms after the one before, also across the two calls`);
    assert.equal(n[4].t, r.arrived.get(3), "the later call's notch at its arrival");
  }
});

test("mouse.wheel on a page with no last point: a path to the client's point first, then the notches there", async () => {
  const r = await runVector(own([wheel(0, 240, 500, 300)], { last: null, ...DOC() }));
  const m = movesOf(r.tab), n = notchesOf(r.tab);
  assert.ok(m.length > 5 && m.every((s) => s.t < n[0].t), `a path before the notches (${m.length} moves)`);
  assert.ok(n[0].t - m.at(-1)!.t >= F.notchGapMs[0] && n[0].t - m.at(-1)!.t <= F.notchGapMs[1], "the first notch one person's gap after the path");
  assert.deepEqual(at(m.at(-1)!), [500, 300]);
  assert.ok(n.length === 2 && n.every((s) => s.params.x === 500 && s.params.y === 300));
});

/** Two tabs of one stage, each with its own fake Chrome, and their calls in the client's order. */
async function twoTabs(callsA: any[], callsB: any[], page: object = DOC()) {
  const clock = new FakeClock();
  const stage = new Stage({ log: () => {}, random: seededRandom(3), platform: "linux", clock, stamp: clock.stamp });
  const mk = (id: number, calls: any[]) => {
    const v = own(calls, page);
    const t = new FakeTab(v, clock, { id });
    t.stage = stage;
    const answers: { id: number; t: number }[] = [];
    for (const c of v.in) clock.timer(c.at ?? 0, () => t.queue(undefined, c.method, c.params, () => answers.push({ id: c.id, t: clock.now() })));
    return { t, v, answers };
  };
  const A = mk(1, callsA), B = mk(2, callsB);
  await clock.run(() => A.answers.length === A.v.in.length && B.answers.length === B.v.in.length);
  return { A, B, stage };
}

test("the input lock and the one action: two tabs' wheels never interleave (the second waits for the first's last notch), and a scroll's notches hold the lock too", async () => {
  const { A, B, stage } = await twoTabs([{ at: 0, ...wheel(0, 1200) }], [{ at: 1, ...wheel(0, 240) }]);
  const a = notchesOf(A.t), b = notchesOf(B.t);
  assert.ok(a.length === 10 && b.length === 2 && b[0].t >= a.at(-1)!.t, "B's notches after A's last");
  assert.ok(B.t.activations[0] >= a.at(-1)!.t, "B's activation after A's action");
  const s = await twoTabs([{ at: 0, ...scroll("b") }], [{ at: 1, ...wheel(0, 240) }], { nodes: { b: BUTTON() }, ...DOC() });
  const sa = notchesOf(s.A.t), sb = notchesOf(s.B.t);
  assert.ok(sa.length === 17 && sb.length === 2 && sb[0].t >= sa.at(-1)!.t, "the wheel of B after the scroll's notches of A");
  assert.equal(stage.lock.held, 0);
});

test("a dialog during the notches (a wheel handler opens an alert): the plan ends and the lock is free at once; after the close the notches that did not go go as one wheel event with their sum, at the page's last point, and the call gets Chrome's answer of it", async () => {
  const v = own([{ at: 0, ...wheel(0, 600) }, { afterEvent: "Page.javascriptDialogOpening", waitMs: 1000, method: "Page.handleJavaScriptDialog", params: { accept: true } }], DOC());
  let k = 0, heldAt600 = -1;
  const r = await runVector(v, { tab: (t) => {
    t.opensDialog = (s) => s.method === "Input.dispatchMouseEvent" && s.params.type === "mouseWheel" && ++k === 2;
    t.clock.timer(600, () => { heldAt600 = t.stage.lock.held; });
  } });
  const n = notchesOf(r.tab), close = passOf(r.tab, 2)!;
  assert.deepEqual(n.map((s) => s.params.deltaY), [120, 120, 360], "two notches, then the rest as one event");
  assert.ok(n[2].t >= close.t && !n[2].dropped && n[2].params.x === 640 && n[2].params.y === 360, "after the close, at the page's last point");
  assert.ok(close.t > 600 && heldAt600 === 0, "the lock is free while the dialog is open");
  assert.ok(answerOf(r, 1).t >= n[2].answered! && !answerOf(r, 1).body.error, "Chrome's answer of that event");
  assert.equal(r.stage.counts.dialogEnds, 1);
  assert.equal(r.stage.lock.held, 0);
});

test("a navigation of the main frame while an ended wheel waits for a dialog's close: no held wheel event goes; the call gets the error that the context is gone; and at the client's session end no wheel event goes and nothing goes back", async () => {
  const v = own([{ at: 0, ...wheel(0, 600) }], DOC());
  let k = 0, navAt = 0;
  const r = await runVector(v, { maxMs: 10_000, tab: (t) => {
    t.opensDialog = (s) => s.method === "Input.dispatchMouseEvent" && s.params.type === "mouseWheel" && ++k === 2;
    t.clock.timer(500, () => { navAt = t.clock.now(); t.navigate(); });
  } });
  const n = notchesOf(r.tab);
  assert.equal(n.length, 2, "no wheel event after the navigation");
  assert.ok(n.every((s) => s.t < navAt));
  assert.match(answerOf(r, 1).body.error!.message, /context was destroyed/);
  // The session's end during the notches.
  const clock = new FakeClock();
  const stage = new Stage({ log: () => {}, random: seededRandom(4), platform: "linux", clock, stamp: clock.stamp });
  const w = own([{ at: 0, ...wheel(0, 1200) }], DOC()), t = new FakeTab(w, clock);
  t.stage = stage;
  const answers: number[] = [];
  t.queue(undefined, w.in[0].method, w.in[0].params, () => answers.push(1));
  clock.timer(150, () => stage.drop(t.id, "session"));
  await clock.run(() => false, 10_000);
  const after = notchesOf(t).filter((s) => s.t >= 150);
  assert.equal(after.length, 0, "no notch after the session's end");
  assert.ok(notchesOf(t).length >= 1 && notchesOf(t).length < 10);
  assert.deepEqual(answers, [], "nothing goes back");
  assert.equal(stage.lock.held, 0);
});

test("STAGE_EVENT_WAIT_MS: the notches go with no wait for each answer (a wheel's events), and a notch whose answer never comes ends the plan 2 s after it; the rest goes at once as one wheel event (no dialog is known); an error of a notch stops the plan and the call gets Chrome's error", async () => {
  let k = 0;
  const r = await runVector(own([{ at: 0, ...wheel(0, 6000) }, { at: 10, ...evaluate() }], DOC(9000)), { maxMs: 20_000, hook: (s) => (s.method === "Input.dispatchMouseEvent" && s.params.type === "mouseWheel" && ++k === 2 ? new Promise(() => {}) : undefined) });
  const n = notchesOf(r.tab), rest = n.at(-1)!;
  assert.ok(n.length > 3 && n.slice(0, -1).every((s) => s.params.deltaY === 120), "the notches go on after the one with no answer");
  assert.equal(rest.params.deltaY, 6000 - 120 * (n.length - 1), "then the rest as one event");
  assert.ok(rest.t - n[1].t >= STAGE_EVENT_WAIT_MS && rest.t - n[1].t <= STAGE_EVENT_WAIT_MS + 1, `the rest ${rest.t - n[1].t} ms after the notch with no answer`);
  assert.equal(r.stage.counts.waitEnds, 1);
  assert.ok(passOf(r.tab, 2)!.t >= rest.t, "the later call goes after the rest");
  let e = 0;
  const q = await runVector(own([{ at: 0, ...wheel(0, 600) }], DOC()), { hook: (s) => { if (s.method === "Input.dispatchMouseEvent" && s.params.type === "mouseWheel" && ++e === 2) throw Object.assign(new Error("refused"), { code: -32000 }); return undefined; } });
  assert.equal(notchesOf(q.tab).length, 2, "no notch after the refused one");
  assert.equal(answerOf(q, 1).body.error?.message, "refused");
  assert.equal(q.stage.lock.held, 0);
});

test("the gate: a call after a wheel call goes after its last notch", async () => {
  const r = await runVector(own([{ at: 0, ...wheel(0, 600) }, { at: 0, ...evaluate() }], DOC()));
  assert.ok(passOf(r.tab, 2)!.t >= notchesOf(r.tab).at(-1)!.t);
});

test("the Mac: mouse.wheel goes as the client sent it, with the stage's timestamp, and the stage counts it; DOM.scrollIntoViewIfNeeded goes as it is too", async () => {
  const r = await runVector({ ...own([wheel(0, 600), scroll("b")], { nodes: { b: BUTTON() }, ...DOC() }), platform: "mac" });
  assert.equal(notchesOf(r.tab).filter((s) => s.pass === undefined && s.params.deltaY === 120).length, 0, "no notch");
  const w = r.tab.sent.find((s) => s.method === "Input.dispatchMouseEvent")!;
  assert.ok(w.params.deltaY === 600 && typeof w.params.timestamp === "number", "the client's wheel, with the stage's timestamp");
  assert.ok(passOf(r.tab, 2), "the scroll as it is");
  assert.equal(r.stage.counts["wheelAsIs:mac"], 1);
  assert.equal(r.stage.counts["scrollAsIs:mac"], 1);
});

// ================================================================ DOM.scrollIntoViewIfNeeded

test("DOM.scrollIntoViewIfNeeded: an element in view (all of it inside the viewport, or its middle in the middle 60% vertically and 80% horizontally) gets {} at once with no event, no lock and no activation; one just below the viewport gets notches", async () => {
  for (const [name, node] of [["inside", BUTTON(300)], ["its middle in the middle 60%", { tag: "div", box: { x: 600, y: -200, width: 100, height: 1200 }, focused: false }],
    ["its middle in the middle 80% across", { tag: "div", box: { x: -300, y: 300, width: 1900, height: 40 }, focused: false }]] as const) {
    const r = await runVector(own([scroll("b")], { nodes: { b: node }, ...DOC() }));
    assert.equal(notchesOf(r.tab).length + movesOf(r.tab).length, 0, `${name}: no event`);
    assert.deepEqual(answerOf(r, 1).body, { result: {} }, `${name}: {}`);
    assert.ok(!passOf(r.tab, 1), `${name}: no script scroll`);
    assert.equal(r.tab.activations.length, 0, `${name}: no activation`);
    assert.equal(r.stage.counts.scrollInView, 1);
  }
  const below = await runVector(own([scroll("b")], { nodes: { b: BUTTON(700) }, ...DOC() }));
  assert.equal(notchesOf(below.tab).length, 3, "round((720 - 360) / 120) notches");
  assert.deepEqual(answerOf(below, 1).body, { result: {} });
});

test("DOM.scrollIntoViewIfNeeded below the fold: the activation before the first notch; no DOM.scrollIntoViewIfNeeded reaches Chrome; {} 350 ms after the last notch; the stage counts it", async () => {
  const r = await runVector(vec("scroll-into-view"));
  const n = notchesOf(r.tab);
  assert.equal(n.length, 17);
  assert.ok(r.tab.activations[0] <= n[0].t, "the activation first");
  assert.ok(!passOf(r.tab, 2), "no script scroll");
  assert.equal(SCROLL_WAIT_MS, F.scrollWaitMs);
  assert.equal(answerOf(r, 2).t - n.at(-1)!.t, SCROLL_WAIT_MS);
  assert.equal(r.tab.sc.document.y, 2040);
  assert.equal(r.stage.counts.scrollNotched, 1);
});

test("DOM.scrollIntoViewIfNeeded with the client's rect (click({ position })): the notches bring that point of the element to the middle, not the element's middle", async () => {
  const tall = { tag: "div", box: { x: 600, y: 1000, width: 100, height: 3000 }, focused: false };
  const r = await runVector(own([scroll("b", { rect: { x: 10, y: 2500, width: 0, height: 0 } })], { nodes: { b: tall }, ...DOC(6000) }));
  assert.equal(notchesOf(r.tab).length, Math.round((3500 - 360) / 120), "26 notches for the point at 3500");
  const plain = await runVector(own([scroll("b")], { nodes: { b: tall }, ...DOC(6000) }));
  assert.equal(notchesOf(plain.tab).length, Math.round((2500 - 360) / 120), "18 for the element's middle");
});

test("the wheel point's rule 1: no notch over an input, a select, a textarea, a contenteditable, a canvas, a video or a frame; the stage takes the nearest point of the 5 x 5 grid that passes, with a path there", async () => {
  // The page is scrolled to 3000 and the element is above the viewport, so the page's content moves down under the
  // wheel point, away from the element under the page's last point.
  const UP = { scrollers: { document: { scrollY: 3000, height: 4000 } } }, under = { x: 560, y: 3320, width: 160, height: 80 }, shown = { ...under, y: 320 };
  const cases: [string, any][] = [
    ["a number input", { n: { tag: "input", type: "number", box: under } }],
    ["a select", { n: { tag: "select", box: under } }],
    ["a textarea", { n: { tag: "textarea", box: under } }],
    ["a contenteditable", { n: { tag: "div", contenteditable: true, box: under } }],
    ["a canvas", { n: { tag: "canvas", box: under } }],
    ["a video", { n: { tag: "video", box: under } }],
  ];
  for (const [name, nodes] of cases) {
    const r = await runVector(own([scroll("b")], { nodes: { b: BUTTON(600), ...nodes }, ...UP }));
    const n = notchesOf(r.tab);
    assert.equal(n.length, Math.round((3000 + 360 - 620) / 120), `${name}: the notches up`);
    assert.ok(n.every((s) => s.params.deltaY === -120), `${name}: up`);
    assert.ok(n.every((s) => !(s.params.x >= shown.x && s.params.x < shown.x + shown.width && s.params.y >= shown.y && s.params.y < shown.y + shown.height)), `${name}: no notch over it`);
    assert.deepEqual(at(n[0]), [640, 230], `${name}: the nearest grid point that passes`);
    assert.deepEqual(at(movesOf(r.tab).at(-1)!), [640, 230], `${name}: a path there`);
    assert.ok(r.tab.wheels.every((w) => w.at !== "n"), `${name}: the page's element gets no wheel event`);
  }
  const frame = await runVector(own([scroll("b")], { nodes: { b: BUTTON(600) }, frames: { f: { origin: "same", box: under, border: 0 } }, ...UP }));
  assert.ok(notchesOf(frame.tab).length > 0 && notchesOf(frame.tab).every((s) => !(s.params.x >= shown.x && s.params.x < shown.x + shown.width && s.params.y >= shown.y && s.params.y < shown.y + shown.height)), "a frame: no notch over it");
  assert.equal(frame.tab.sc["frame:f"].y, 0);
});

test("the wheel point's rule 2: an element of the chain with a wheel listener that is not passive is no wheel point; a passive listener is; a listener of the window (it stops the wheel) does not count", async () => {
  const under = { x: 560, y: 320, width: 160, height: 80 };
  const non = await runVector(own([scroll("b")], { nodes: { b: BUTTON(), m: { tag: "div", listener: "nonpassive", box: under } }, ...DOC() }));
  // 640,230 is not over it, but the page's move down brings it under that point (its column, rule 4): 640,490.
  assert.deepEqual(at(notchesOf(non.tab)[0]), [640, 490], "not passive: another point, whose column does not meet it");
  assert.ok(non.tab.sent.some((s) => s.method === "DOMDebugger.getEventListeners"), "the listeners' read");
  const pas = await runVector(own([scroll("b")], { nodes: { b: BUTTON(), m: { tag: "div", listener: "passive", box: under } }, ...DOC() }));
  assert.deepEqual(at(notchesOf(pas.tab)[0]), [640, 360], "passive: the page's last point");
  assert.equal(movesOf(pas.tab).length, 0, "no path");
  const html = await runVector(own([scroll("b")], { nodes: { b: BUTTON() }, ...DOC(4000, { htmlListener: "nonpassive" }) }));
  assert.equal(notchesOf(html.tab).length, 0, "a listener of the html element counts: no point passes");
  assert.ok(passOf(html.tab, 1));
  const win = await runVector(own([scroll("b")], { nodes: { b: BUTTON() }, ...DOC(4000, { stops: true }) }));
  assert.deepEqual(at(notchesOf(win.tab)[0]), [640, 360], "a listener of the window does not count");
});

test("the wheel point's rule 3: a point whose element scrolls another scroller first (an inner list under the page's last point) is no wheel point of the page", async () => {
  const r = await runVector(own([scroll("b")], { nodes: { b: BUTTON(600) }, scrollers: { document: { scrollY: 3000, height: 4000 }, list: { box: { x: 500, y: 3250, width: 300, height: 200 }, height: 900, scrollY: 0 } } }));
  const n = notchesOf(r.tab);
  assert.ok(n.length === 23 && n.every((s) => !(s.params.x >= 500 && s.params.x < 800 && s.params.y >= 250 && s.params.y < 450)), "no notch over the list");
  assert.equal(r.tab.sc.list.y, 0, "the list does not move");
  assert.equal(r.tab.sc.document.y, 3000 - 23 * 120);
});

test("no wheel point (a canvas over the whole viewport): the client's call as it is, logged and counted", async () => {
  const r = await runVector(own([scroll("b")], { nodes: { b: BUTTON(), c: { tag: "canvas", over: true, box: { x: 0, y: 0, width: 1280, height: 720 } } }, ...DOC() }));
  assert.equal(notchesOf(r.tab).length + movesOf(r.tab).length, 0);
  assert.ok(passOf(r.tab, 1), "the script scroll");
  assert.equal(r.stage.counts["scrollAsIs:noWheelPoint"], 1);
  assert.ok(r.logs.some((l) => /a scroll into view of tab 7 went as the client sent it \(noWheelPoint\)/.test(l)), "logged");
  assert.ok(!r.logs.some((l) => /\b(640|360|2400)\b/.test(l)), "no point in a log line");
});

test("a round that does not move the scroller ends the notches: the client's call goes 350 ms after the round's last notch, logged and counted", async () => {
  const r = await runVector(vec("scroll-no-move"));
  assert.equal(notchesOf(r.tab).length, 17, "one round");
  assert.equal(passOf(r.tab, 1)!.t - notchesOf(r.tab).at(-1)!.t, SCROLL_WAIT_MS);
  assert.equal(r.stage.counts["scrollAsIs:noMove"], 1);
  assert.ok(r.logs.some((l) => /went as the client sent it \(noMove\)/.test(l)));
});

test("at most STAGE_SCROLL_ROUNDS rounds: a page that moves a small distance at each notch gets 4 rounds, then the client's call", async () => {
  const r = await runVector(own([scroll("b")], { nodes: { b: BUTTON() }, ...DOC(4000, { step: 10 }) }), { maxMs: 60_000 });
  const rs = rounds(notchesOf(r.tab));
  assert.equal(STAGE_SCROLL_ROUNDS, 4);
  assert.equal(rs.length, STAGE_SCROLL_ROUNDS, `${rs.length} rounds`);
  assert.ok(passOf(r.tab, 1), "then the script scroll");
  assert.equal(r.stage.counts["scrollAsIs:rounds"], 1);
});

test("an inner scroller in view: the notches at a point over its visible part (the nearest of the grid), bringing the element's middle to the middle of that part; the page does not move", async () => {
  const page = { nodes: { b: BUTTON(2000, { box: { x: 150, y: 2000, width: 100, height: 40 }, scroller: "list" }) }, scrollers: { list: { box: { x: 100, y: 100, width: 400, height: 300 }, height: 3000, scrollY: 0 } } };
  const r = await runVector(own([scroll("b")], page));
  const n = notchesOf(r.tab);
  assert.equal(n.length, Math.round((2020 - 250) / 120), "15 notches");
  assert.deepEqual(at(n[0]), [444, 358], "the nearest grid point over the list");
  assert.equal(r.tab.sc.list.y, 1800);
  assert.equal(r.tab.sc.document.y, 0);
  assert.deepEqual(answerOf(r, 1).body, { result: {} });
});

test("an inner scroller below the fold: first the page's notches (not over the list), then the list's notches over it; the element ends in the middle of the list's visible part", async () => {
  const page = { nodes: { b: BUTTON(3000, { box: { x: 150, y: 3000, width: 100, height: 40 }, scroller: "list" }) },
    scrollers: { document: { scrollY: 0, height: 4000 }, list: { box: { x: 100, y: 1500, width: 400, height: 300 }, height: 3000, scrollY: 0 } } };
  const r = await runVector(own([scroll("b")], page));
  const rs = rounds(notchesOf(r.tab));
  assert.equal(rs.length, 2, "two rounds");
  assert.deepEqual([rs[0].length, rs[1].length], [11, 11]);
  assert.deepEqual(at(rs[0][0]), [640, 360], "the page's notches at the page's last point");
  assert.ok(rs[1].every((s) => s.params.x >= 100 && s.params.x < 500), "the list's notches over the list");
  assert.deepEqual([r.tab.sc.document.y, r.tab.sc.list.y], [1320, 1320]);
  assert.deepEqual(answerOf(r, 1).body, { result: {} });
});

test("a same-origin frame's own document: the notches over the frame, at a point where the top page's element is the frame; the frame's document moves, the page does not", async () => {
  const page = { last: { x: 900, y: 600 }, nodes: { b: { tag: "button", frame: "sf", box: { x: 50, y: 1500, width: 100, height: 40 }, focused: false } },
    frames: { sf: { origin: "same", box: { x: 300, y: 100, width: 400, height: 300 }, border: 0, scrollY: 0, height: 2000 } } };
  const r = await runVector(own([scroll("b")], page));
  const n = notchesOf(r.tab);
  assert.equal(n.length, 11);
  assert.deepEqual(at(n[0]), [644, 358]);
  assert.ok(n.every((s) => !s.child), "on the top page's session");
  assert.equal(r.tab.sc["frame:sf"].y, 1320);
});

test("a cross-origin frame: the frame's session sends the call; the stage reads the frame's owner in its own world (DOM.resolveNode by its backendNodeId); a point where the top page's element is not the owner (a fixed banner) is no wheel point", async () => {
  const v = vec("scroll-frame");
  v.page.nodes.banner = { tag: "div", over: true, box: { x: 300, y: 300, width: 400, height: 100 } };
  const r = await runVector(v);
  const n = notchesOf(r.tab);
  assert.equal(n.length, 11);
  assert.deepEqual(at(n[0]), [644, 250], "the nearest point that the banner does not cover");
  assert.ok(r.tab.sent.some((s) => s.method === "ownNode" && s.params.backendNodeId === 900), "the owner in the stage's own world");
  assert.equal(r.tab.sc["frame:xf"].y, 1320);
  assert.ok(r.tab.wheels.every((w) => w.at !== "banner"));
});

test("a read that fails or reaches GEOMETRY_WAIT_MS: the client's call as it is, counted; a node with no box: the client's call at once (Chrome gives its own error)", async () => {
  const r = await runVector(own([scroll("b")], { nodes: { b: BUTTON() }, ...DOC() }), { hook: (s) => (s.params?.functionDeclaration === SCROLL_STATE ? new Promise(() => {}) : undefined) });
  assert.equal(passOf(r.tab, 1)!.t, 200, "after GEOMETRY_WAIT_MS");
  assert.equal(r.stage.counts["scrollAsIs:readFails"], 1);
  const none = await runVector(own([scroll("b")], { nodes: { b: BUTTON(2400, { hidden: true }) }, ...DOC() }));
  assert.equal(passOf(none.tab, 1)!.t, 0);
  assert.equal(none.stage.counts["scrollAsIs:noBox"], 1);
});

test("a dialog during a scroll's notches: the plan ends, the client's call goes as it is at once, and the lock is free", async () => {
  let k = 0;
  const r = await runVector(own([scroll("b"), { afterEvent: "Page.javascriptDialogOpening", waitMs: 1000, method: "Page.handleJavaScriptDialog", params: { accept: true } }], { nodes: { b: BUTTON() }, ...DOC() }),
    { tab: (t) => { t.opensDialog = (s) => s.method === "Input.dispatchMouseEvent" && s.params.type === "mouseWheel" && ++k === 3; } });
  assert.equal(notchesOf(r.tab).filter((s) => !s.dropped).length, 3, "no notch after the dialog");
  const p = passOf(r.tab, 1)!;
  assert.ok(p && p.t < passOf(r.tab, 2)!.t, "the client's call at once, before the close");
  assert.equal(r.stage.counts["scrollAsIs:ended"], 1);
  assert.equal(r.stage.lock.held, 0);
});

test("the retry scroll recognizer: Playwright's script scroll of a retry passes, and the stage counts it", async () => {
  const r = await runVector(own([util(RETRY_FN, { o: [{ k: "block", v: "end" }] }, "b")], { nodes: { b: BUTTON() }, ...DOC() }));
  assert.ok(passOf(r.tab, 1));
  assert.equal(notchesOf(r.tab).length, 0);
  assert.equal(r.stage.counts.retryScrolls, 1);
});

test("the gate: a call after DOM.scrollIntoViewIfNeeded goes after its answer (the notches and the smooth scroll's wait)", async () => {
  const r = await runVector(own([{ at: 0, ...scroll("b") }, { at: 0, ...evaluate() }], { nodes: { b: BUTTON() }, ...DOC() }));
  assert.ok(passOf(r.tab, 2)!.t >= answerOf(r, 1).t && answerOf(r, 1).t - notchesOf(r.tab).at(-1)!.t === SCROLL_WAIT_MS);
});

// ================================================================ the focus click's notches (review-119 N14)

test("the focus click of a field below the fold: notches into view first (no DOM.scrollIntoViewIfNeeded), then the click; for fill, for Playwright's focus call (pressSequentially) and on the Mac (no notch: no click, counted)", async () => {
  for (const call of [fillCall("n", "ab"), focusCall("n")]) {
    const r = await runVector(own([call, insert("ab")], { nodes: { n: INPUT({ text: 3 }) }, ...DOC() }));
    const n = notchesOf(r.tab), p = pressOf(r.tab)!;
    assert.equal(n.length, 17, "the notches");
    assert.ok(p && p.t > n.at(-1)!.t + SCROLL_WAIT_MS - 1, "the click after the notches and the smooth scroll");
    assert.ok(p.params.y >= 360 && p.params.y < 390, "on the field in view");
    assert.ok(!r.tab.sent.some((s) => s.method === "DOM.scrollIntoViewIfNeeded"));
    assert.equal(r.tab.valueOf("n"), call.params.arguments[3].value === FILL_FN ? "ab" : "ababc", "the text (fill selects the field's text; the focus call's caret at 0)");
    assert.equal(r.stage.counts.focusClicks, 1);
    assert.equal(r.stage.counts.focusOutOfView, undefined);
  }
  const mac = await runVector({ ...own([fillCall("n", "ab"), insert("ab")], { nodes: { n: INPUT({ text: 3 }) }, ...DOC() }), platform: "mac" });
  assert.equal(notchesOf(mac.tab).length + (pressOf(mac.tab) ? 1 : 0), 0, "the Mac: no notch and no click");
  assert.equal(mac.stage.counts.focusOutOfView, 1);
});

test("a field out of view inside a frame's own scroller (review-119 N14): notches over the frame, then the click inside it; a same-origin frame (its calls on the top page's session) and a cross-origin one (its own session)", async () => {
  for (const origin of ["same", "cross"]) {
    const page = { last: { x: 900, y: 600 }, nodes: { n: { tag: "input", type: "text", frame: "f", box: { x: 20, y: 1000, width: 200, height: 30 }, text: 0, focused: false } },
      frames: { f: { origin, box: { x: 100, y: 100, width: 400, height: 200 }, border: 0, scrollY: 0, height: 1500 } } };
    const r = await runVector(own([fillCall("n", "Card", origin === "cross" ? "child" : undefined), insert("Card")], page));
    const n = notchesOf(r.tab), p = pressOf(r.tab);
    assert.ok(n.length > 0 && n.every((s) => s.params.x >= 100 && s.params.x < 500 && s.params.y >= 100 && s.params.y < 300 && !s.child), `${origin}: notches over the frame, on the top page's session`);
    assert.ok(p && p.t > n.at(-1)!.t, `${origin}: then the click`);
    assert.ok(r.tab.sc["frame:f"].y > 0, `${origin}: the frame's document moved`);
    assert.equal(r.stage.counts.focusClicks, 1, `${origin}: a focus click`);
    assert.equal(r.stage.counts.focusCovered, undefined, `${origin}: not counted as covered`);
    assert.equal(r.tab.valueOf("n"), "Card", `${origin}: the text`);
  }
});

test("the focus click's point outside the visible part of the field's nearest scroller (a field in view by the middle rule, its left end clipped by its list): no click, counted; the utility call goes", async () => {
  const page = { nodes: { n: { tag: "input", type: "text", scroller: "list", box: { x: 50, y: 200, width: 400, height: 30 }, text: 3, focused: false } },
    scrollers: { list: { box: { x: 100, y: 100, width: 400, height: 300 }, height: 900, width: 400, scrollY: 0 } } };
  const r = await runVector(own([fillCall("n", "ab"), insert("ab")], page));
  assert.equal(pressOf(r.tab), undefined, "no click");
  assert.equal(notchesOf(r.tab).length, 0, "in view: no notch");
  assert.equal(r.stage.counts.focusOutOfView, 1);
  assert.ok(passOf(r.tab, 1), "the utility call goes");
});

test("the wheel point's rule 4 (the column): a point whose column (the content that the round's notches move under it) meets a number input, a canvas, a frame, another scroller or an element with a wheel listener that is not passive is no wheel point; an element with position: fixed, and the element and the elements around it, do not count", async () => {
  // The page scrolls down 2,040 px: the content from y 360 to 2400 at x 640 passes under the page's last point 640,360.
  const below = { x: 600, y: 1200, width: 100, height: 40 };
  for (const [name, node] of [["a number input", { tag: "input", type: "number", box: below }], ["a canvas", { tag: "canvas", box: below }],
    ["another scroller", null], ["an element with a wheel listener that is not passive", { tag: "div", listener: "nonpassive", box: below }]] as const) {
    const page = node ? { nodes: { b: BUTTON(), n: node }, ...DOC() } : { nodes: { b: BUTTON() }, scrollers: { document: { scrollY: 0, height: 4000 }, list: { box: below, height: 900, scrollY: 0 } } };
    const r = await runVector(own([scroll("b")], page));
    const n = notchesOf(r.tab);
    assert.equal(n.length, 17, `${name}: the notches`);
    assert.ok(n.every((s) => s.params.x < 600 || s.params.x >= 700), `${name}: a point whose column does not meet it (${at(n[0])})`);
    assert.ok(r.tab.wheels.every((w) => w.at !== "n" && w.moved !== "list"), `${name}: no wheel event over it, and it does not move`);
  }
  const frame = await runVector(own([scroll("b")], { nodes: { b: BUTTON() }, frames: { f: { origin: "same", box: below, border: 0 } }, ...DOC() }));
  assert.ok(notchesOf(frame.tab).every((s) => s.params.x < 600 || s.params.x >= 700), "a frame in the column: another point");
  // A fixed header in the column does not move under the point: the page's last point stays the wheel point.
  const fixed = await runVector(own([scroll("b")], { nodes: { b: BUTTON(), h: { tag: "canvas", fixed: true, box: { x: 0, y: 600, width: 1280, height: 60 } } }, ...DOC() }));
  assert.deepEqual(at(notchesOf(fixed.tab)[0]), [640, 360], "a fixed element does not count");
  // The target is in its own column: it does not count (a field to be clicked is an input).
  const field = await runVector(own([scroll("f")], { nodes: { f: { tag: "input", type: "number", box: { x: 600, y: 2400, width: 100, height: 30 } } }, ...DOC() }));
  assert.deepEqual(at(notchesOf(field.tab)[0]), [640, 360], "the element itself does not count");
});

test("no point whose column is clear (a canvas across the page between the viewport and the element): the client's call as it is, counted; the canvas gets no wheel event", async () => {
  const r = await runVector(own([scroll("b")], { nodes: { b: BUTTON(), c: { tag: "canvas", box: { x: 0, y: 1100, width: 1280, height: 240 } } }, ...DOC() }));
  assert.equal(notchesOf(r.tab).length, 0);
  assert.ok(passOf(r.tab, 1));
  assert.equal(r.stage.counts["scrollAsIs:noWheelPoint"], 1);
});
