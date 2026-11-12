// The input stage's mouse.wheel after review 122 (board ab-t30.11; C11 "The input stage", `mouseWheel` on Linux): the
// call's column before the notches (the lead's option b: the notches go until the next one would bring an element of
// rules 1, 2 or 4 under the page's last point, and the rest goes as one wheel event at the same point), the end of a
// wheel plan (the daemon lead's P1: a notch is gone when Chrome answered it, the dialog race of the keys' rule, the rest
// only when the point is still a wheel point of its scroller, no rest at a navigation), and review notes 8 and 12 and the
// residual's "no lock and no activation". A fake Chrome (stage-fakes.ts) moves its scrollers by the wheel events.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { GEOMETRY_WAIT_MS } from "../src/relay/pointer.ts";
import { STAGE_EVENT_WAIT_MS, WHEEL_CLEAR, WHEEL_COLUMN } from "../src/relay/stage.ts";
import { runVector, type FakeTab, type Sent } from "./stage-fakes.ts";

const V = JSON.parse(readFileSync(new URL("./vectors/stage.json", import.meta.url), "utf8"));
const F = V.firstValues;

const wheel = (dx: number, dy: number, x = 640, y = 360) => ({ method: "Input.dispatchMouseEvent", params: { type: "mouseWheel", x, y, modifiers: 0, deltaX: dx, deltaY: dy } });
const evaluate = () => ({ method: "Runtime.evaluate", params: { expression: "1" } });
/** A vector of the tests' own: the calls in order, each after the answer of the one before unless it names `at`, `after` or `afterEvent`. */
function own(calls: any[], page: Partial<any> = {}) {
  const ins = calls.map((c, i) => ({ id: i + 1, ...(c.at === undefined && c.after === undefined && c.afterEvent === undefined ? (i === 0 ? { at: 0 } : { after: i }) : {}), ...c }));
  return { id: "own", platform: "linux", seed: 11, clock: 0, page: { viewport: { width: 1280, height: 720 }, last: { x: 640, y: 360 }, nodes: {}, focused: null, ...page }, chrome: {}, in: ins, out: [], answers: [] };
}
const DOC = (h = 4000, extra: object = {}) => ({ scrollers: { document: { scrollY: 0, height: h, ...extra } } });
/** A canvas (an element of rule 1) across the column of the page's last point, `d` px below it. */
const CANVAS = (d: number, o: object = {}) => ({ tag: "canvas", box: { x: 600, y: 360 + d, width: 100, height: 100 }, ...o });
const notchesOf = (t: FakeTab) => t.sent.filter((s) => s.method === "Input.dispatchMouseEvent" && s.params.type === "mouseWheel" && s.pass === undefined);
const passOf = (t: FakeTab, id: number) => t.sent.find((s) => s.pass === id);
const answerOf = (r: Awaited<ReturnType<typeof runVector>>, id: number) => r.answers.find((a) => a.id === id)!;
const dys = (n: Sent[]) => n.map((s) => s.params.deltaY);
const gap = (a: Sent, b: Sent) => b.t - a.t;
const inGap = (ms: number) => ms >= F.notchGapMs[0] && ms <= F.notchGapMs[1];

// ================================================================ the column (the lead's option b)

test("mouse.wheel's column: a canvas 540 px below the page's last point: 4 notches go (the 5th would bring it under the point), then the rest (960 px) as one wheel event at the same point, one person's gap later, counted, with a trace line with no point; the canvas gets no wheel event; the residual does not change; the call is answered after Chrome's answer of that event", async () => {
  for (let seed = 1; seed <= 6; seed++) {
    const r = await runVector(own([wheel(0, 1440), wheel(0, 60)], { nodes: { c: CANVAS(540) }, ...DOC() }), { seed, tab: (t) => { (t.stage as any).o.trace = true; } });
    const n = notchesOf(r.tab);
    assert.deepEqual(dys(n).slice(0, 5), [120, 120, 120, 120, 960], `seed ${seed}: 4 notches, then the rest as one event`);
    assert.ok(n.slice(0, 5).every((s) => s.params.x === 640 && s.params.y === 360 && s.params.deltaX === 0), "at the page's last point");
    assert.ok(inGap(gap(n[3], n[4])), `the rest ${gap(n[3], n[4])} ms after the 4th notch`);
    assert.ok(typeof n[4].params.timestamp === "number", "with the stage's timestamp");
    assert.ok(answerOf(r, 1).t >= n[4].answered!, "the answer after Chrome's answer of the rest");
    assert.ok(r.tab.wheels.every((w) => w.at !== "c"), "the canvas gets no wheel event");
    assert.equal(r.stage.counts.wheelRestAsOne, 1);
    // The residual is the call's own (1440 px: 0): the next call of 60 px gets one notch (half up), as with no column.
    assert.equal(n.length, 6, "the next call: one notch");
    const line = r.logs.find((l) => /the rest as one event/.test(l));
    assert.ok(line && !/\b(640|360)\b/.test(line), `a trace line with no point: ${line}`);
  }
});

test("mouse.wheel's column: k can be 0 (a canvas 40 px below the point: the whole call as one event, at the time of the first notch), and all notches go when the scroller's range ends before the element or when no element is in the column", async () => {
  const zero = await runVector(own([wheel(0, 1440)], { nodes: { c: CANVAS(40) }, ...DOC() }));
  assert.deepEqual(dys(notchesOf(zero.tab)), [1440], "one event");
  assert.equal(zero.stage.counts.wheelRestAsOne, 1);
  assert.ok(zero.tab.wheels.every((w) => w.at !== "c"));
  // The range: a page 1,000 px tall moves 280 px; the canvas 540 px below is not in the column.
  const range = await runVector(own([wheel(0, 1440)], { nodes: { c: CANVAS(540) }, ...DOC(1000) }));
  assert.equal(notchesOf(range.tab).length, 12, "all the notches");
  assert.equal(range.stage.counts.wheelRestAsOne, undefined);
  const clear = await runVector(own([wheel(0, 1440)], { nodes: { b: { tag: "button", box: { x: 600, y: 900, width: 100, height: 40 } } }, ...DOC() }));
  assert.ok(dys(notchesOf(clear.tab)).every((d) => d === 120) && notchesOf(clear.tab).length === 12, "a button is no element of rule 1");
  // Upward: a canvas 300 px above the point, on a page at 2,000.
  const up = await runVector(own([wheel(0, -1440)], { nodes: { c: CANVAS(-400 + 2000) }, scrollers: { document: { scrollY: 2000, height: 4000 } } }));
  assert.deepEqual(dys(notchesOf(up.tab)), [-120, -120, -1200], "the canvas's lower edge 300 px above the point: 2 notches, then the rest");
});

test("mouse.wheel's column: the element under the point at the start, the elements around it, and fixed elements do not count; another scroller, a frame, and an element with a wheel listener that is not passive (also inside an open shadow root: rule 2 reads each root) count; a listener of a box that holds the point does not", async () => {
  // The client wheels over a canvas: it is the client's choice.
  const self = await runVector(own([wheel(0, 1440)], { nodes: { c: { tag: "canvas", box: { x: 600, y: 300, width: 100, height: 100 } } }, ...DOC() }));
  assert.equal(notchesOf(self.tab).length, 12, "the element under the point");
  const fixed = await runVector(own([wheel(0, 1440)], { nodes: { c: CANVAS(540, { fixed: true }) }, ...DOC() }));
  assert.equal(notchesOf(fixed.tab).length, 12, "a fixed element");
  const list = await runVector(own([wheel(0, 1440)], { scrollers: { document: { scrollY: 0, height: 4000 }, list: { box: { x: 600, y: 900, width: 100, height: 100 }, height: 900, scrollY: 0 } } }));
  assert.deepEqual(dys(notchesOf(list.tab)), [120, 120, 120, 120, 960], "another scroller");
  const frame = await runVector(own([wheel(0, 1440)], { frames: { f: { origin: "same", box: { x: 600, y: 900, width: 100, height: 100 }, border: 0 } }, ...DOC() }));
  assert.deepEqual(dys(notchesOf(frame.tab)), [120, 120, 120, 120, 960], "a frame");
  const listener = await runVector(own([wheel(0, 1440)], { nodes: { d: { tag: "div", listener: "nonpassive", box: { x: 600, y: 900, width: 100, height: 100 } } }, ...DOC() }));
  assert.deepEqual(dys(notchesOf(listener.tab)), [120, 120, 120, 120, 960], "rule 2");
  const shadow = await runVector(own([wheel(0, 1440)], { nodes: { d: { tag: "div", listener: "nonpassive", shadow: true, box: { x: 600, y: 900, width: 100, height: 100 } } }, ...DOC() }));
  assert.deepEqual(dys(notchesOf(shadow.tab)), [120, 120, 120, 120, 960], "rule 2 inside an open shadow root");
  const around = await runVector(own([wheel(0, 1440)], { nodes: { w: { tag: "div", listener: "nonpassive", box: { x: 0, y: 0, width: 1280, height: 4000 } } }, ...DOC() }));
  assert.equal(notchesOf(around.tab).length, 12, "a listener of a box that holds the point");
  const passive = await runVector(own([wheel(0, 1440)], { nodes: { d: { tag: "div", listener: "passive", box: { x: 600, y: 900, width: 100, height: 100 } } }, ...DOC() }));
  assert.equal(notchesOf(passive.tab).length, 12, "a passive listener");
});

test("mouse.wheel's column over a cross-origin frame, or at a read that fails or reaches GEOMETRY_WAIT_MS: the notches go as with no column, counted; the reads run in the stage's own world, and the world lets go of them after the call", async () => {
  const frame = await runVector(own([wheel(0, 1440)], { frames: { xf: { origin: "cross", box: { x: 300, y: 100, width: 700, height: 500 }, border: 0, height: 3000 } }, nodes: { c: CANVAS(540) }, ...DOC() }));
  assert.equal(notchesOf(frame.tab).length, 12);
  assert.equal(frame.stage.counts["wheelNoColumn:frame"], 1);
  const fails = await runVector(own([wheel(0, 1440)], { nodes: { c: CANVAS(540) }, ...DOC() }), { hook: (s) => (s.method === "ownRead" && s.params.fn === WHEEL_COLUMN ? new Promise(() => {}) : undefined) });
  const n = notchesOf(fails.tab);
  assert.equal(n.length, 12);
  assert.ok(n[0].t >= GEOMETRY_WAIT_MS, "after the read's limit");
  assert.equal(fails.stage.counts["wheelNoColumn:readFails"], 1);
  const ok = await runVector(own([wheel(0, 1440)], { nodes: { c: CANVAS(540) }, ...DOC() }));
  const reads = ok.tab.sent.filter((s) => s.method === "ownRead" || s.method === "ownObject");
  assert.ok(reads.some((s) => s.params.fn === WHEEL_COLUMN), "the column's read in the stage's own world");
  assert.ok(reads.at(-1)!.params.fn === WHEEL_CLEAR && reads.at(-1)!.t >= notchesOf(ok.tab).at(-1)!.t, "then the world lets go of its read (review-122 note 9)");
});

// ================================================================ the end of a wheel plan (the daemon lead's P1)

test("a dialog during the notches, and its notice comes after the next notch went (the dialog race, review-122 note 1): that notch did not reach the page (Chrome dropped it), so it goes in the rest after the close: the page gets the asked total", async () => {
  const v = own([{ at: 0, ...wheel(0, 600) }, { afterEvent: "Page.javascriptDialogOpening", waitMs: 1000, method: "Page.handleJavaScriptDialog", params: { accept: true } }], DOC());
  let k = 0;
  const r = await runVector(v, { tab: (t) => { t.dialogNoticeMs = 100; t.opensDialog = (s) => s.method === "Input.dispatchMouseEvent" && s.params.type === "mouseWheel" && ++k === 2; } });
  const n = notchesOf(r.tab), rest = n.at(-1)!;
  assert.ok(n.some((s) => s.dropped), "Chrome dropped a notch");
  assert.equal(rest.params.deltaY, 600 - 240, "the rest: all but the two notches that reached the page");
  assert.equal(r.tab.sc.document.y, 600, "the page moved the asked total");
  assert.ok(!answerOf(r, 1).body.error);
});

test("the rest after a dialog's close goes only when the page's last point is still a wheel point of its scroller (read again after the close, with the lock taken again); else no rest, and the call gets an error that names the end and the count of the notches that did not go", async () => {
  const v = own([{ at: 0, ...wheel(0, 600) }, { afterEvent: "Page.javascriptDialogOpening", waitMs: 1000, method: "Page.handleJavaScriptDialog", params: { accept: true } }], DOC());
  let k = 0;
  const r = await runVector(v, { tab: (t) => {
    t.opensDialog = (s) => s.method === "Input.dispatchMouseEvent" && s.params.type === "mouseWheel" && ++k === 2;
    // While the dialog is open, the page puts a canvas into the rest's column.
    t.hook = (s) => { if (s.method === "Page.handleJavaScriptDialog") t.v.page.nodes.c = CANVAS(240 + 140); return undefined; };
  } });
  const n = notchesOf(r.tab);
  assert.deepEqual(dys(n), [120, 120], "no rest");
  assert.equal(answerOf(r, 1).body.error?.message, "The input stage ended a wheel call at a dialog, and 3 notches did not go: the page's last point is no longer a wheel point of its scroller.");
  const reads = r.tab.sent.filter((s) => s.method === "ownRead" && s.params.fn === WHEEL_COLUMN);
  assert.ok(reads.length === 2 && reads[1].t >= passOf(r.tab, 2)!.t && reads[1].params.args[5] === 1, "the column read again after the close");
  assert.equal(r.stage.counts.wheelRestsCut, 1);
  assert.equal(r.stage.lock.held, 0);
  // The same page with no canvas: the rest goes.
  k = 0;
  const ok = await runVector(own([{ at: 0, ...wheel(0, 600) }, { afterEvent: "Page.javascriptDialogOpening", waitMs: 1000, method: "Page.handleJavaScriptDialog", params: { accept: true } }], DOC()), { tab: (t) => { t.opensDialog = (s) => s.method === "Input.dispatchMouseEvent" && s.params.type === "mouseWheel" && ++k === 2; } });
  assert.deepEqual(dys(notchesOf(ok.tab)), [120, 120, 360]);
});

test("a navigation of the main frame with no dialog during the notches stops them, as a typed text stops (review-122 note 6): no rest, and the call gets an error with the count of the notches that did not go", async () => {
  let navAt = 0;
  const r = await runVector(own([wheel(0, 1200)], DOC()), { tab: (t) => { t.clock.timer(150, () => { navAt = t.clock.now(); t.navigate(); }); } });
  const n = notchesOf(r.tab);
  assert.ok(n.length >= 2 && n.length < 10 && n.every((s) => s.t <= navAt), `no notch after the navigation (${n.length})`);
  assert.equal(answerOf(r, 1).body.error?.message, `The input stage ended a wheel call at a navigation of the main frame, and ${10 - n.length} notches did not go: the page navigated.`);
  assert.equal(r.stage.lock.held, 0);
});

test("STAGE_EVENT_WAIT_MS ends a wheel plan: the stage waits for the notches' answers, at most one more STAGE_EVENT_WAIT_MS; answers that come: the rest goes (the point still passes); none: no rest, and the call gets an error with the count of the notches that may not have gone", async () => {
  let k = 0, late = 0;
  const r = await runVector(own([{ at: 0, ...wheel(0, 6000) }, { at: 10, ...evaluate() }], DOC(9000)), { maxMs: 20_000, tab: (t) => {
    t.hook = (s) => (s.method === "Input.dispatchMouseEvent" && s.params.type === "mouseWheel" && ++k === 2 ? new Promise((res) => t.clock.timer(STAGE_EVENT_WAIT_MS + 500, () => { late = t.clock.now(); res({}); })) : undefined);
  } });
  const n = notchesOf(r.tab), rest = n.at(-1)!;
  assert.ok(n.slice(0, -1).every((s) => s.params.deltaY === 120), "the notches go on after the one with no answer");
  assert.equal(rest.params.deltaY, 6000 - 120 * (n.length - 1), "then the rest");
  assert.ok(rest.t >= late, "after the late answer");
  assert.equal(r.stage.counts.waitEnds, 1);
  assert.ok(!answerOf(r, 1).body.error);
  k = 0;
  const q = await runVector(own([{ at: 0, ...wheel(0, 6000) }, { at: 10, ...evaluate() }], DOC(9000)), { maxMs: 20_000, hook: (s) => (s.method === "Input.dispatchMouseEvent" && s.params.type === "mouseWheel" && ++k === 2 ? new Promise(() => {}) : undefined) });
  const m = notchesOf(q.tab);
  assert.ok(m.every((s) => s.params.deltaY === 120), "no rest");
  assert.equal(answerOf(q, 1).body.error?.message, `The input stage ended a wheel call at no answer in ${STAGE_EVENT_WAIT_MS} ms, and ${50 - (m.length - 1)} notches may not have gone: the page did not answer.`);
  assert.ok(answerOf(q, 1).t - m[1].t >= 2 * STAGE_EVENT_WAIT_MS, "after one more STAGE_EVENT_WAIT_MS");
  assert.ok(passOf(q.tab, 2), "the later call goes");
  assert.equal(q.stage.lock.held, 0);
});

// ================================================================ review-122 notes 8 and 12, and the residual

test("a wheel call of delta 0 on both axes sends one wheel event, as Playwright's own input does (review-122 note 8), counted; the residual does not change", async () => {
  const r = await runVector(own([wheel(0, 60), wheel(0, 0), wheel(0, 60)], DOC()));
  const n = notchesOf(r.tab);
  assert.deepEqual(n.map((s) => [s.params.deltaX, s.params.deltaY]), [[0, 120], [0, 0]], "one notch, the zero event, then no notch (the residual)");
  assert.equal(r.stage.counts.wheelZero, 1);
  assert.ok(answerOf(r, 2).t >= n[1].answered!);
});

test("the residual belongs to a page: a navigation of the main frame starts it again (review-122 note 12)", async () => {
  const r = await runVector(own([wheel(0, 60), { after: 1, waitMs: 500, ...wheel(0, 60) }], DOC()), { tab: (t) => { t.clock.timer(300, () => t.navigate()); } });
  assert.equal(notchesOf(r.tab).length, 2, "the second call: one notch on the new page");
});

test("a call that earlier notches have given gets no event, no lock and no activation (C11's residual sentence; review-122 B4)", async () => {
  let acquired = 0;
  const r = await runVector(own([wheel(0, 60), wheel(0, 60)], DOC()), { tab: (t) => {
    const lock = t.stage.lock, acq = lock.acquire.bind(lock);
    lock.acquire = () => { acquired++; return acq(); };
  } });
  assert.equal(notchesOf(r.tab).length, 1);
  assert.equal(acquired, 1, "one lock: the first call's");
  assert.equal(r.tab.activations.length, 1, "one activation: the first call's");
  assert.ok(r.tab.activations[0] <= answerOf(r, 1).t);
  assert.deepEqual(answerOf(r, 2).body, { result: {} });
});
