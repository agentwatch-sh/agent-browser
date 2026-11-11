// The input stage's keys and text (board ab-t30.10; the input design's sections 4.4, 4.5, 5.1, 5.2, 5.4, 6.3, 7 and 10.2,
// and build task 6; C11 "The input stage", with test/vectors/stage.json). The key and text vectors run in
// relay-stage.test.ts; here a test for each rule that the vectors do not show: the Shift key and its order, the early
// answer and rollover, the gate after an early answer, the lock of a key run and of a held key (N10), the run's time
// (STAGE_RUN_SLOW_MS, STAGE_ACTION_MAX_MS), the typing rule with its limits and the named exception, the focus and fill
// recognizers with the focus click, its point, its hit test and the caret, a field in a cross-origin frame, dialogs, an
// error of an event, an auto-repeat, a char, and the timestamps. A fake Chrome (stage-fakes.ts) keeps each field's value,
// focus and caret.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { charKey, SHIFT, CONTROL } from "../src/human/keys.ts";
import { seededRandom } from "../src/human/random.ts";
import { CARET_SET, RUN_IDLE_MS, Stage, STAGE_ACTION_MAX_MS, STAGE_RUN_SLOW_MS, STAGE_TYPE_MAX_MS } from "../src/relay/stage.ts";
import { keyMeasures, type Rec } from "./live/input-harness/measures.ts";
import { FakeClock, FakeTab, runVector, type Sent } from "./stage-fakes.ts";

const V = JSON.parse(readFileSync(new URL("./vectors/stage.json", import.meta.url), "utf8"));
const F = V.firstValues;
const vec = (id: string) => structuredClone(V.vectors.find((x: any) => x.id === id));

// ---------------------------------------------------------------- the client's calls, as Playwright sends them

/** Playwright's keyDown of a character (playwright-core 1.65.0, RawKeyboardImpl.keydown): a capital or a symbol with modifiers 0. */
const kd = (ch: string, extra: object = {}) => {
  const k = charKey(ch)!;
  return { method: "Input.dispatchKeyEvent", params: { type: "keyDown", modifiers: 0, windowsVirtualKeyCode: k.keyCode, code: k.code, commands: [], key: k.key, text: ch, unmodifiedText: ch, autoRepeat: false, location: 0, isKeypad: false, ...extra } };
};
const ku = (ch: string, extra: object = {}) => {
  const k = charKey(ch)!;
  return { method: "Input.dispatchKeyEvent", params: { type: "keyUp", modifiers: 0, key: k.key, windowsVirtualKeyCode: k.keyCode, code: k.code, location: 0, isKeypad: false, ...extra } };
};
/** A named key (no text): its rawKeyDown and keyUp. */
const NAMED: Record<string, [string, number, number]> = { Shift: ["ShiftLeft", 16, 1], Control: ["ControlLeft", 17, 1], Delete: ["Delete", 46, 0], ArrowLeft: ["ArrowLeft", 37, 0], a: ["KeyA", 65, 0] };
const rd = (name: string, modifiers = 0) => ({ method: "Input.dispatchKeyEvent", params: { type: "rawKeyDown", modifiers, windowsVirtualKeyCode: NAMED[name][1], code: NAMED[name][0], commands: [], key: name, text: "", unmodifiedText: "", autoRepeat: false, location: NAMED[name][2], isKeypad: false } });
const ru = (name: string, modifiers = 0) => ({ method: "Input.dispatchKeyEvent", params: { type: "keyUp", modifiers, key: name, windowsVirtualKeyCode: NAMED[name][1], code: NAMED[name][0], location: NAMED[name][2], isKeypad: false } });
/** keyboard.type(text): each key's press, then its release, each sent at the answer of the call before (Playwright awaits each). */
const typeCalls = (text: string) => [...text].flatMap((ch) => (charKey(ch) ? [kd(ch), ku(ch)] : [{ method: "Input.insertText", params: { text: ch } }]));
const insert = (text: string) => ({ method: "Input.insertText", params: { text } });
const evaluate = () => ({ method: "Runtime.evaluate", params: { expression: "1" } });
const mouse = (type: string, x: number, y: number) => ({ method: "Input.dispatchMouseEvent", params: { type, x, y, button: type === "mouseMoved" ? "none" : "left", buttons: type === "mousePressed" ? 1 : 0, modifiers: 0, ...(type === "mouseMoved" ? {} : { clickCount: 1 }) } });
const FILL_FN = vec("fill").in[0].params.arguments[3].value, FOCUS_FN = vec("press-sequentially").in[0].params.arguments[3].value;
const util = (fn: string, arg: unknown, node: string, session?: string) => ({ method: "Runtime.callFunctionOn", ...(session ? { session } : {}),
  params: { functionDeclaration: "(utilityScript, ...args) => utilityScript.evaluate(...args)", objectId: "7.3.1", returnByValue: true, awaitPromise: true, userGesture: true,
    arguments: [{ objectId: "7.3.1" }, { value: true }, { value: true }, { value: fn }, { value: 1 }, { value: { a: [{ h: 0 }, { h: 1 }, arg] } }, { objectId: "7.3.2" }, { objectId: node }] } });
/** fill's utility call (Playwright's checks, then injected.fill), and focusNode with or without the caret reset. */
const fillCall = (node: string, value: string, session?: string) => util(FILL_FN, { o: [{ k: "value", v: value }, { k: "force", v: false }, { k: "frameVisible", v: true }] }, node, session);
const focusCall = (node: string, reset: boolean, session?: string) => util(FOCUS_FN, reset ? true : { v: "undefined" }, node, session);

/** A vector of the tests' own: the calls in order, each after the answer of the one before unless it names `at` or `after`. */
function own(calls: any[], page: Partial<any> = {}, extra: Partial<any> = {}) {
  const ins = calls.map((c, i) => ({ id: i + 1, ...(c.at === undefined && c.after === undefined && c.afterEvent === undefined ? (i === 0 ? { at: 0 } : { after: i }) : {}), ...c }));
  return { id: "own", platform: "linux", seed: 11, clock: 0, page: { viewport: { width: 1280, height: 720 }, last: { x: 900, y: 700 }, nodes: {}, focused: null, ...page },
    chrome: { results: Object.fromEntries(ins.filter((c) => c.method === "Runtime.callFunctionOn" && c.params.arguments?.[3]?.value === FILL_FN).map((c) => [c.id, { result: { type: "string", value: "needsinput" } }])) },
    in: ins, out: [], answers: [], ...extra };
}
const INPUT = (o: object = {}) => ({ tag: "input", type: "text", box: { x: 200, y: 300, width: 300, height: 30 }, text: 0, focused: false, ...o });
const TEXTAREA = (o: object = {}) => ({ tag: "textarea", box: { x: 200, y: 400, width: 400, height: 120 }, text: 0, focused: false, ...o });
const keyEvents = (t: FakeTab) => t.sent.filter((s) => s.method === "Input.dispatchKeyEvent" && s.pass === undefined);
const mouseEvents = (t: FakeTab) => t.sent.filter((s) => s.method === "Input.dispatchMouseEvent" && s.pass === undefined);
const answerOf = (r: Awaited<ReturnType<typeof runVector>>, id: number) => r.answers.find((a) => a.id === id)!;
/** The page's view of the stage's key events, as the input harness's recorder logs them (its K1 to K4 measures). */
const recsOf = (ev: Sent[]): Rec[] => ev.map((s) => ({ e: s.params.type === "keyUp" ? "keyup" : "keydown", f: "top", t: s.t, h: s.t + 1, tr: 1, k: s.params.key, c: s.params.code, l: s.params.location ?? 0, m: s.params.modifiers, nl: 0, r: 0 } as Rec));

/** Each key's hold: from its keyDown or rawKeyDown to its keyUp. */
function holds(ev: Sent[]): { key: string; ms: number; down: Sent; up: Sent }[] {
  const out: { key: string; ms: number; down: Sent; up: Sent }[] = [], down = new Map<string, Sent>();
  for (const s of ev) {
    if (s.params.type === "keyUp") { const d = down.get(s.params.code); if (d) { out.push({ key: d.params.key, ms: s.t - d.t, down: d, up: s }); down.delete(s.params.code); } }
    else if (!s.params.autoRepeat) down.set(s.params.code, s);
  }
  return out;
}

// ================================================================ keys

test("keys: a capital or a symbol gets a Shift press 45 to 95 ms before it (location 1 or 2) and modifiers 8; the Shift goes up 15 to 60 ms after the last key that it holds; a run of capitals keeps it down; each hold 50 to 250 ms; whole-ms timestamps 3 to 5 ms before the send", async () => {
  const TEXT = "Hi There! OK go";
  for (let seed = 1; seed <= 12; seed++) {
    const r = await runVector(own(typeCalls(TEXT), { nodes: { "7.3.18": INPUT({ focused: true }) }, focused: "7.3.18" }), { seed });
    const ev = keyEvents(r.tab), downs = ev.filter((s) => s.params.type === "keyDown");
    assert.equal(downs.map((s) => s.params.text).join(""), TEXT, `seed ${seed}: the text in order`);
    assert.equal(r.tab.valueOf("7.3.18"), TEXT, `seed ${seed}: the field's value is the text`);
    const shiftDowns = ev.filter((s) => s.params.key === "Shift" && s.params.type === "rawKeyDown"), shiftUps = ev.filter((s) => s.params.key === "Shift" && s.params.type === "keyUp");
    assert.deepEqual([shiftDowns.length, shiftUps.length], [4, 4], `seed ${seed}: one Shift for H, T, !, and one for OK`);
    for (const sd of shiftDowns) {
      assert.ok([1, 2].includes(sd.params.location) && sd.params.modifiers === SHIFT && sd.params.code === (sd.params.location === 1 ? "ShiftLeft" : "ShiftRight"), JSON.stringify(sd.params));
      const first = downs.find((s) => s.t >= sd.t)!;
      assert.ok(first.t - sd.t >= 45 && first.t - sd.t <= 95, `seed ${seed}: the Shift ${first.t - sd.t} ms before ${first.params.text}`);
    }
    for (const d of downs) assert.equal(d.params.modifiers, charKey(d.params.text)!.modifiers & SHIFT ? SHIFT : 0, `seed ${seed}: ${d.params.text}'s modifiers`);
    for (const su of shiftUps) {
      const last = ev.filter((s) => s.params.type === "keyUp" && s.params.key !== "Shift" && s.t <= su.t).at(-1)!;
      assert.ok(su.t - last.t >= 15 && su.t - last.t <= 60, `seed ${seed}: the Shift up ${su.t - last.t} ms after ${last.params.key}'s`);
    }
    for (const h of holds(ev).filter((x) => x.key !== "Shift")) assert.ok(h.ms >= 50 && h.ms <= 250, `seed ${seed}: ${h.key} held ${h.ms} ms (never a release before its planned hold)`);
    for (const s of ev) {
      const ts = s.params.timestamp * 1000, before = r.clock.epoch + s.t - ts;
      assert.ok(Math.abs(ts - Math.round(ts)) < 1e-6 && before >= 3 - 0.5 && before <= 5 + 0.5, `seed ${seed}: a timestamp ${before} ms before the send, in whole ms`);
    }
  }
});

test("keys: the early answer gives rollover: some releases are answered before they go, and the next press then comes before them (K3 15% to 50% over the seeds); a later Runtime.evaluate goes only after every keyUp", async () => {
  const TEXT = "the quick brown fox jumps over the lazy dog and runs to the woods";
  let early = 0, pairs = 0, overlaps = 0;
  for (let seed = 1; seed <= 16; seed++) {
    const calls = [...typeCalls(TEXT), evaluate()];
    const r = await runVector(own(calls, { nodes: { "7.3.18": INPUT({ focused: true }) }, focused: "7.3.18" }), { seed });
    const ev = keyEvents(r.tab), ups = ev.filter((s) => s.params.type === "keyUp");
    for (const c of r.tab.v.in.filter((x: any) => x.params.type === "keyUp")) {
      const a = answerOf(r, c.id), sent = ups.find((s) => s.params === r.tab.sent.find((x) => x === s)?.params && s.params.code === c.params.code && s.t >= 0 && r.tab.sent.indexOf(s) >= 0 && !r.tab.sent.slice(0, r.tab.sent.indexOf(s)).includes(s))!;
      void sent;
      if (a.n < r.tab.sent.findIndex((s) => s.method === "Input.dispatchKeyEvent" && s.params.type === "keyUp" && s.params.code === c.params.code && s.t >= r.arrived.get(c.id)!) + 1) early++;
    }
    const m = keyMeasures(recsOf(ev))!;
    pairs += m.keys - 1; overlaps += m.overlaps;
    const evalSent = r.tab.sent.findIndex((s) => s.pass === calls.length);
    assert.ok(evalSent > r.tab.sent.indexOf(ups.at(-1)!), `seed ${seed}: the evaluate goes after the last keyUp`);
    assert.equal(r.tab.valueOf("7.3.18"), TEXT, `seed ${seed}: the text`);
  }
  assert.ok(early > 0, `${early} early answers`);
  const share = overlaps / pairs;
  assert.ok(share >= 0.15 && share <= 0.5, `the overlap share ${share.toFixed(3)} (${overlaps} of ${pairs})`);
});

test("keys: a release that a later key's release passes waits for it: every keyUp goes after each planned release before it (C11: a later call that is not a key press waits until an early-answered release has gone)", async () => {
  for (let seed = 1; seed <= 30; seed++) {
    const r = await runVector(own(typeCalls("abcdefghijklmnopqrstuvwxyz"), { nodes: { "7.3.18": INPUT({ focused: true }) }, focused: "7.3.18" }), { seed });
    const ev = keyEvents(r.tab).filter((s) => s.params.key !== "Shift");
    // The order of the releases is the order of the presses (each release after every earlier planned release).
    const ups = ev.filter((s) => s.params.type === "keyUp").map((s) => s.params.key), downs = ev.filter((s) => s.params.type === "keyDown").map((s) => s.params.key);
    assert.deepEqual(ups, downs, `seed ${seed}: the releases in the order of the presses`);
  }
});

test("keys: a chord (keyboard.press('Control+A')): A 40 to 120 ms after Control, its release after its hold, Control 20 to 80 ms after it; no Shift for the capital A of a chord; Control+Shift+ArrowLeft: Shift 20 to 80 ms after Control, the key 40 to 120 ms after each", async () => {
  for (let seed = 1; seed <= 20; seed++) {
    const r = await runVector(vec("press-chord"), { seed });
    const ev = keyEvents(r.tab);
    assert.deepEqual(ev.map((s) => [s.params.type, s.params.key, s.params.modifiers]), [["rawKeyDown", "Control", CONTROL], ["rawKeyDown", "A", CONTROL], ["keyUp", "A", CONTROL], ["keyUp", "Control", 0]]);
    assert.ok(ev[1].t - ev[0].t >= 40 && ev[1].t - ev[0].t <= 120 && ev[3].t - ev[2].t >= 20 && ev[3].t - ev[2].t <= 80);
    const c2 = await runVector(own([rd("Control", CONTROL), rd("Shift", CONTROL | SHIFT), rd("ArrowLeft", CONTROL | SHIFT), ru("ArrowLeft", CONTROL | SHIFT), ru("Shift", CONTROL), ru("Control", 0)],
      { nodes: { "7.3.18": INPUT({ focused: true, text: 5 }) }, focused: "7.3.18" }), { seed });
    const e2 = keyEvents(c2.tab);
    assert.deepEqual(e2.map((s) => [s.params.type, s.params.key, s.params.modifiers]), [["rawKeyDown", "Control", CONTROL], ["rawKeyDown", "Shift", CONTROL | SHIFT], ["rawKeyDown", "ArrowLeft", CONTROL | SHIFT],
      ["keyUp", "ArrowLeft", CONTROL | SHIFT], ["keyUp", "Shift", CONTROL], ["keyUp", "Control", 0]], `seed ${seed}`);
    const g = e2[1].t - e2[0].t, k1 = e2[2].t - e2[0].t, k2 = e2[2].t - e2[1].t;
    assert.ok(g >= 20 && g <= 80 && k1 >= 40 && k1 <= 120 && k2 >= 40 && k2 <= 120, `seed ${seed}: ${g}, ${k1}, ${k2}`);
  }
});

test("keys: a key that the client holds down already (keyboard.down twice) repeats with autoRepeat, with no new hold; a char goes right after its key's press", async () => {
  const r = await runVector(own([rd("a"), { ...rd("a"), waitMs: 500 }, { ...ru("a"), waitMs: 100 }], { nodes: { "7.3.18": INPUT({ focused: true }) }, focused: "7.3.18" }));
  const ev = keyEvents(r.tab);
  assert.deepEqual(ev.map((s) => [s.params.type, !!s.params.autoRepeat]), [["rawKeyDown", false], ["rawKeyDown", true], ["keyUp", false]]);
  assert.ok(ev[1].t - ev[0].t >= 500, "the repeat at its arrival");
  const c = await runVector(own([rd("a"), { method: "Input.dispatchKeyEvent", params: { type: "char", key: "a", code: "KeyA", text: "a", unmodifiedText: "a", windowsVirtualKeyCode: 65, modifiers: 0 } }, ru("a")],
    { nodes: { "7.3.18": INPUT({ focused: true }) }, focused: "7.3.18" }));
  const ce = keyEvents(c.tab);
  assert.deepEqual(ce.map((s) => s.params.type), ["rawKeyDown", "char", "keyUp"]);
  assert.ok(ce[1].t - ce[0].t <= 1 && ce[2].t - ce[0].t >= 50, "the char at once after its press; the release after the hold");
});

test("keys: the stage's own Shift goes up at its planned time, 15 to 60 ms after the last key that it holds, when no next key comes (not at the run's end 1 s later)", async () => {
  for (let seed = 1; seed <= 10; seed++) {
    const r = await runVector(own(typeCalls("A"), { nodes: { "7.3.18": INPUT({ focused: true }) }, focused: "7.3.18" }), { seed });
    const ev = keyEvents(r.tab), up = ev.find((s) => s.params.key === "A" && s.params.type === "keyUp")!, su = ev.find((s) => s.params.key === "Shift" && s.params.type === "keyUp")!;
    assert.ok(su && su.t - up.t >= 15 && su.t - up.t <= 60, `seed ${seed}: Shift up ${su ? su.t - up.t : "never"} ms after A's`);
  }
});

// ================================================================ the lock of a key run

/** Two tabs of one stage, each with its own fake Chrome; each tab's calls as in `own` (chained by their answers). */
async function twoTabs(callsA: any[], callsB: any[], pageA: Partial<any> = {}, maxMs = 120_000) {
  const clock = new FakeClock();
  const stage = new Stage({ log: () => {}, random: seededRandom(3), platform: "linux", clock, stamp: clock.stamp });
  const mk = (id: number, calls: any[], page: Partial<any>) => {
    const v = own(calls, page);
    const t = new FakeTab(v, clock, { id });
    t.stage = stage;
    const answers: { id: number; t: number }[] = [];
    const send = (c: any) => t.queue(undefined, c.method, c.params, () => { answers.push({ id: c.id, t: clock.now() }); for (const x of v.in) if (x.after === c.id) later(x); });
    const later = (c: any) => (c.waitMs ? clock.timer(c.waitMs, () => send(c)) : send(c));
    for (const c of v.in) if (c.at !== undefined) clock.timer(c.at, () => later(c));
    return { t, v, answers };
  };
  const A = mk(1, callsA, pageA), B = mk(2, callsB, {});
  await clock.run(() => A.answers.length === A.v.in.length && B.answers.length === B.v.in.length, maxMs);
  return { A, B, stage, clock };
}
const click = (x: number, y: number, at: number) => [{ at, ...mouse("mouseMoved", x, y) }, { at, ...mouse("mousePressed", x, y) }, { at, ...mouse("mouseReleased", x, y) }];
const FIELD = { nodes: { "7.3.18": INPUT({ focused: true }) }, focused: "7.3.18" };

test("the input lock: a key run holds it until 1 s after its last key; another tab's click waits; at the tab's next call that is not a key the run ends at once", async () => {
  const { A, B, stage } = await twoTabs(typeCalls("hello"), click(500, 400, 1), FIELD);
  const ka = keyEvents(A.t), mb = mouseEvents(B.t);
  assert.ok(mb[0].t >= ka.at(-1)!.t + RUN_IDLE_MS, `B's first move ${mb[0].t - ka.at(-1)!.t} ms after A's last key: the run ends ${RUN_IDLE_MS} ms after it`);
  assert.equal(stage.lock.held, 0);
  const { A: A2, B: B2 } = await twoTabs([...typeCalls("hello"), evaluate()], click(500, 400, 1), FIELD);
  const k2 = keyEvents(A2.t), m2 = mouseEvents(B2.t), ev2 = A2.t.sent.find((s) => s.pass === A2.v.in.length)!;
  assert.ok(m2[0].t >= ev2.t && m2[0].t < k2.at(-1)!.t + RUN_IDLE_MS, "the evaluate ends the run: B's click goes then");
  assert.ok(ev2.t >= k2.at(-1)!.t, "the evaluate after A's last key event");
});

test("the input lock (N10): a key that the client holds keeps the run and the lock until its keyUp; with no keyUp the lock frees at STAGE_ACTION_MAX_MS, the stage sends no release of its own, and the client's later keyUp goes", async () => {
  const { A, B } = await twoTabs([{ at: 0, ...rd("a") }, { at: 3000, ...ru("a") }], click(500, 400, 100), FIELD);
  const ka = keyEvents(A.t), mb = mouseEvents(B.t);
  assert.ok(mb[0].t >= ka.at(-1)!.t && ka.at(-1)!.t >= 3000, "B waits for A's keyUp at 3 s");
  const { A: A2, B: B2, stage } = await twoTabs([{ at: 0, ...rd("a") }, { at: STAGE_ACTION_MAX_MS + 5000, ...ru("a") }], click(500, 400, 100), FIELD, 60_000);
  const k2 = keyEvents(A2.t), m2 = mouseEvents(B2.t);
  assert.ok(m2[0].t >= STAGE_ACTION_MAX_MS && m2[0].t < STAGE_ACTION_MAX_MS + 1000, `B goes at STAGE_ACTION_MAX_MS (${m2[0].t})`);
  assert.deepEqual(k2.map((s) => [s.params.type, s.t >= STAGE_ACTION_MAX_MS + 5000]), [["rawKeyDown", false], ["keyUp", true]], "no release of the stage's own; the client's keyUp at its time");
  assert.equal(stage.counts.limitEnds, 1);
  // A modifier held (keyboard.down('Shift')) keeps the lock too.
  const { A: A3, B: B3 } = await twoTabs([{ at: 0, ...rd("Shift", SHIFT) }, { at: 2000, ...ru("Shift") }], click(500, 400, 100), FIELD);
  assert.ok(mouseEvents(B3.t)[0].t >= keyEvents(A3.t).at(-1)!.t);
});

test("the run's time: a person's speed for STAGE_RUN_SLOW_MS, then the fast end (100 to 120 ms a key); at STAGE_ACTION_MAX_MS the rest of the run goes as the client sends it, counted, and the run ends inside 30 s", async () => {
  const TEXT = "the quick brown fox jumps over the lazy dog ".repeat(6).slice(0, 250);
  const r = await runVector(own(typeCalls(TEXT), FIELD), { maxMs: 200_000 });
  const ev = keyEvents(r.tab), downs = ev.filter((s) => s.params.type === "keyDown");
  assert.equal(downs.length, TEXT.length);
  assert.equal(r.tab.valueOf("7.3.18"), TEXT, "the whole text");
  const t0 = downs[0].t;
  const fast = downs.filter((s, i) => i > 0 && s.t - t0 > STAGE_RUN_SLOW_MS + 300 && s.t - t0 < STAGE_ACTION_MAX_MS - 300 && downs[i - 1].t - t0 > STAGE_RUN_SLOW_MS + 300).map((s) => s.t - downs[downs.indexOf(s) - 1].t).sort((x, y) => x - y);
  const fmed = fast[fast.length >> 1];
  assert.ok(fast.length > 20 && fast[0] >= F.fastKeyMs[0] - 1 && fmed <= F.fastKeyMs[1] + 1, `the fast end after ${STAGE_RUN_SLOW_MS} ms: the least ${fast[0]}, the median ${fmed}`);
  assert.ok(downs.at(-1)!.t - t0 < 30_000, `the run ends in ${downs.at(-1)!.t - t0} ms`);
  assert.equal(r.stage.counts.limitEnds, 1);
  assert.ok((r.stage.counts.plainKeys ?? 0) > 10, `${r.stage.counts.plainKeys} keys as the client sent them after the limit`);
  const after = downs.filter((s) => s.t - t0 > STAGE_ACTION_MAX_MS + 50);
  assert.ok(after.every((s, i) => i === 0 || s.t - after[i - 1].t < 5), "with no person's timing after the limit");
});

// ================================================================ the typing rule

test("the typing rule: typed keys into an input or a textarea; the text as it is into a contenteditable (rule 1), with a character that has no US key, a line feed or a tab (rule 2), with a modifier that the client holds, and above STAGE_TYPE_MAX_MS even at the fast end (rule 3)", async () => {
  const cases: [string, any, string, string | null][] = [
    ["Hello world", INPUT({ focused: true }), "typed", null],
    ["Hello world", TEXTAREA({ focused: true }), "typed", null],
    ["Hello world", { tag: "div", contenteditable: true, box: { x: 200, y: 300, width: 300, height: 30 }, text: 0, focused: true }, "asIs", "contenteditable"],
    ["Héllo", INPUT({ focused: true }), "asIs", "noUsKey"],
    ["two\nlines", TEXTAREA({ focused: true }), "asIs", "lineFeedOrTab"],
    ["a\tb", INPUT({ focused: true }), "asIs", "lineFeedOrTab"],
    ["x".repeat(101), INPUT({ focused: true }), "asIs", "tooLong"],
    ["Hello", { tag: "input", type: "date", box: { x: 200, y: 300, width: 300, height: 30 }, focused: true }, "asIs", "notTextField"],
  ];
  for (const [text, node, how, why] of cases) {
    const r = await runVector(own([insert(text)], { nodes: { n1: node }, focused: "n1" }));
    const keys = keyEvents(r.tab), passed = r.tab.sent.filter((s) => s.pass === 1);
    if (how === "typed") {
      assert.equal(keys.filter((s) => s.params.type === "keyDown").map((s) => s.params.text).join(""), text, `${JSON.stringify(text)}: typed`);
      assert.equal(passed.length, 0);
      assert.equal(r.tab.valueOf("n1"), text);
    } else {
      assert.equal(keys.length, 0, `${JSON.stringify(text)} into ${node.tag}: no key`);
      assert.equal(passed.length, 1, "the text as it is");
      assert.equal(r.stage.counts[`textAsIs:${why}`], 1, `${JSON.stringify(text)}: the reason ${why}`);
    }
  }
  // A modifier that the client holds would change the typed keys: keyboard.down('Shift'), then keyboard.insertText('abc').
  const r = await runVector(own([rd("Shift", SHIFT), insert("abc"), ru("Shift")], FIELD));
  assert.equal(r.stage.counts["textAsIs:modifierHeld"], 1);
  assert.equal(r.tab.sent.filter((s) => s.pass === 2).length, 1);
});

test("the typing rule 3: the plan at the person's speed when it fits in STAGE_TYPE_MAX_MS, else at the fast end; the typed plan's time is at most STAGE_TYPE_MAX_MS (the plan's own times are played)", async () => {
  let fastSeen = 0;
  for (let seed = 1; seed <= 12; seed++) {
    for (const n of [20, 45, 60, 80]) {
      const text = "the lazy dog jumps over a big fox and then runs into the woods to find food".repeat(2).slice(0, n);
      const r = await runVector(own([insert(text)], FIELD), { seed });
      const keys = keyEvents(r.tab);
      if (!keys.length) { assert.equal(r.stage.counts["textAsIs:tooLong"], 1, `${n} chars, seed ${seed}: as it is only when too long`); continue; }
      const span = keys.at(-1)!.t - keys[0].t;
      assert.ok(span <= STAGE_TYPE_MAX_MS, `${n} chars, seed ${seed}: typed in ${span} ms`);
      if (r.stage.counts.typedTextsFast) {
        fastSeen++;
        const downs = keys.filter((s) => s.params.type === "keyDown");
        const gaps = downs.slice(1).map((s, i) => s.t - downs[i].t).sort((x, y) => x - y), med = gaps[gaps.length >> 1];
        // The fast end: 100 to 120 ms a key, longer only where the same key comes twice (after its own release).
        assert.ok(gaps[0] >= F.fastKeyMs[0] - 1 && med >= F.fastKeyMs[0] - 1 && med <= F.fastKeyMs[1] + 1, `the fast end: the least gap ${gaps[0]}, the median ${med}`);
      }
    }
  }
  assert.ok(fastSeen > 0, "some texts go at the fast end");
});

test("the typing rule: a text as it is goes after one person's time from one press to the next (keyboard.type with a character that has no US key)", async () => {
  for (let seed = 1; seed <= 10; seed++) {
    const r = await runVector(own(typeCalls("aé"), FIELD), { seed });
    const a = keyEvents(r.tab).find((s) => s.params.key === "a" && s.params.type === "keyDown")!, up = keyEvents(r.tab).find((s) => s.params.key === "a" && s.params.type === "keyUp")!;
    const t = r.tab.sent.find((s) => s.method === "Input.insertText")!;
    assert.ok(t.t >= up.t && t.t - a.t >= 30, `seed ${seed}: the text ${t.t - a.t} ms after a's press, after its release`);
    assert.equal(r.tab.valueOf("7.3.18"), "aé");
  }
});

test("the named exception: a key handler of the page acts on typed keys (an input mask); the stage logs and counts that the value is not the text, with no text in the log, and does not repair the field", async () => {
  const r = await runVector(own([fillCall("m", "12ab34"), insert("12ab34")], { nodes: { m: INPUT({ mask: "digits" }) } }));
  assert.equal(r.tab.valueOf("m"), "1234", "the mask dropped the letters");
  assert.equal(r.stage.counts.typedValueDiffers, 1);
  assert.ok(r.logs.some((l) => /not the text/.test(l)) && !r.logs.some((l) => /12ab34|1234/.test(l)), "logged, with no text");
  assert.equal(r.tab.sent.filter((s) => s.method === "Input.insertText").length, 0, "no second input");
  const ok = await runVector(own([fillCall("m", "1234"), insert("1234")], { nodes: { m: INPUT({ mask: "digits" }) } }));
  assert.equal(ok.stage.counts.typedValueDiffers, undefined, "the same value: nothing counted");
  // keyboard.insertText into the middle of a text: the text in place of the selection.
  const mid = await runVector(own([insert("XY")], { nodes: { n: INPUT({ focused: true, value: "abcdef", caret: [2, 4] }) }, focused: "n" }));
  assert.equal(mid.tab.valueOf("n"), "abXYef");
  assert.equal(mid.stage.counts.typedValueDiffers, undefined);
});

// ================================================================ the focus click

const pressOf = (t: FakeTab) => mouseEvents(t).find((s) => s.params.type === "mousePressed");

test("the focus click: a text field with no focus gets a path, a pause, a press and a hold before the utility call; the point: 2 to 5 px from the left of a field with text, 25% to 75% across an empty one, 35% to 65% down an input, 6 to 12 px from the top of a textarea or a contenteditable", async () => {
  const cases: [any, [number, number], [number, number]][] = [
    [INPUT({ text: 8 }), [202, 205], [311, 319]],
    [INPUT({ text: 0 }), [275, 425], [311, 319]],
    [TEXTAREA({ text: 12 }), [202, 205], [406, 412]],
    [TEXTAREA({ text: 0 }), [300, 500], [406, 412]],
    [{ tag: "div", contenteditable: true, box: { x: 200, y: 400, width: 400, height: 120 }, text: 5, focused: false }, [202, 205], [406, 412]],
  ];
  for (let seed = 1; seed <= 8; seed++) for (const [node, xr, yr] of cases) {
    const r = await runVector(own([focusCall("n", true)], { nodes: { n: node } }), { seed });
    const p = pressOf(r.tab)!, passAt = r.tab.sent.findIndex((s) => s.pass === 1);
    assert.ok(p && p.params.x >= xr[0] && p.params.x <= xr[1] && p.params.y >= yr[0] && p.params.y <= yr[1], `${node.tag} (${node.text} chars), seed ${seed}: ${p?.params.x},${p?.params.y}`);
    const moves = mouseEvents(r.tab).filter((s) => s.params.type === "mouseMoved"), rel = mouseEvents(r.tab).find((s) => s.params.type === "mouseReleased")!;
    assert.ok(moves.length > 10 && p.t - moves.at(-1)!.t >= 80 && p.t - moves.at(-1)!.t <= 400 && rel.t - p.t >= 60 && rel.t - p.t <= 180, "a path, a pause, a press of a person's hold");
    assert.ok(r.tab.sent.indexOf(rel) < passAt, "the click before the utility call");
    assert.equal(r.tab.activations.length, 1, "Playwright's focus call starts an action: the activation");
  }
});

test("the focus click: none for a field with the focus, for a button, for a field with no box, for a field that another element covers at the point, or out of view (until board ab-t30.11's notches); the utility call goes as the client sent it, and the stage counts each", async () => {
  const cases: [string, any, string][] = [
    ["focused", { nodes: { n: INPUT({ text: 3, focused: true }) }, focused: "n" }, "fieldFocused"],
    ["button", { nodes: { n: { tag: "button", box: { x: 60, y: 220, width: 80, height: 40 } } } }, "fieldNotText"],
    ["no box", { nodes: { n: INPUT({ box: { x: 200, y: 300, width: 0, height: 0 } }) } }, "focusNoBox"],
    ["covered", { nodes: { n: INPUT({ text: 3 }), cover: { tag: "div", box: { x: 190, y: 290, width: 100, height: 50 } } } }, "focusCovered"],
    ["out of view", { nodes: { n: INPUT({ text: 3, box: { x: 200, y: 2400, width: 300, height: 30 } }) } }, "focusOutOfView"],
  ];
  for (const [name, page, count] of cases) {
    for (const call of [focusCall("n", true), fillCall("n", "abc")]) {
      const r = await runVector(own([call], page));
      assert.equal(mouseEvents(r.tab).length, 0, `${name}: no click`);
      assert.equal(r.tab.sent.filter((s) => s.pass === 1).length, 1, `${name}: the utility call goes`);
      assert.equal(r.stage.counts[count], 1, `${name}: counted ${count}`);
    }
  }
});

test("the focus click's caret: when it is not where the script focus would put it, keys move it (Home or Control+Home to the start, End or Control+End to the end, ArrowRight and Shift+ArrowRight in the middle up to 64 characters), else a script sets it (counted)", async () => {
  // A textarea whose own selection is at its end (a script set its value): Playwright's focusNode resets no textarea's caret.
  const ends = await runVector(own([focusCall("n", true)], { nodes: { n: TEXTAREA({ value: "hello world", caret: [11, 11] }) } }));
  assert.deepEqual(keyEvents(ends.tab).map((s) => [s.params.type, s.params.key]), [["rawKeyDown", "Control"], ["rawKeyDown", "End"], ["keyUp", "End"], ["keyUp", "Control"]]);
  assert.deepEqual(ends.tab.fields.get("n"), { value: "hello world", s: 11, e: 11 }, "the caret at the end, as the script focus puts it");
  // An input with the caret reset (pressSequentially): the click at the left end puts it at 0: no key.
  const reset = await runVector(own([focusCall("n", true)], { nodes: { n: INPUT({ value: "hello", caret: [5, 5] }) } }));
  assert.equal(keyEvents(reset.tab).length, 0);
  assert.deepEqual(reset.tab.fields.get("n"), { value: "hello", s: 0, e: 0 });
  // focus() with no reset on an input whose caret was in the middle, and a selection.
  const mid = await runVector(own([focusCall("n", false)], { nodes: { n: INPUT({ value: "hello world", caret: [2, 2] }) } }));
  assert.deepEqual(keyEvents(mid.tab).filter((s) => s.params.type !== "keyUp").map((s) => s.params.key), ["Home", "ArrowRight", "ArrowRight"]);
  assert.deepEqual(mid.tab.fields.get("n"), { value: "hello world", s: 2, e: 2 });
  const sel = await runVector(own([focusCall("n", false)], { nodes: { n: INPUT({ value: "hello world", caret: [1, 4] }) } }));
  assert.deepEqual(sel.tab.fields.get("n"), { value: "hello world", s: 1, e: 4 }, "the selection with Shift+ArrowRight");
  assert.ok(keyEvents(sel.tab).some((s) => s.params.key === "Shift" && s.params.type === "rawKeyDown"));
  const long = await runVector(own([focusCall("n", false)], { nodes: { n: INPUT({ value: "x".repeat(100), caret: [70, 70] }) } }));
  assert.equal(long.stage.counts.caretScript, 1);
  assert.ok(long.tab.sent.some((s) => s.params?.functionDeclaration === CARET_SET));
  assert.deepEqual(long.tab.fields.get("n"), { value: "x".repeat(100), s: 70, e: 70 });
  // On the Mac the keys carry the Mac's editing commands (Meta+ArrowDown in a textarea: the end).
  const mac = await runVector(own([focusCall("n", true)], { nodes: { n: TEXTAREA({ value: "hello world", caret: [11, 11] }) } }, { platform: "mac" }));
  const down = keyEvents(mac.tab).find((s) => s.params.key === "ArrowDown")!;
  assert.deepEqual([down.params.modifiers, down.params.commands], [4, ["moveToEndOfDocument"]]);
});

test("fill: the focus click, then Playwright's script selects the text, and the typed keys replace it; pressSequentially into an empty textarea: the click, then the keys", async () => {
  for (let seed = 1; seed <= 6; seed++) {
    const r = await runVector(own([fillCall("n", "jane.doe@example.com"), insert("jane.doe@example.com")], { nodes: { n: INPUT({ value: "old" }) } }), { seed });
    assert.equal(r.tab.valueOf("n"), "jane.doe@example.com", `seed ${seed}`);
    assert.ok(pressOf(r.tab), "a focus click");
    const p = await runVector(own([focusCall("t", true), ...typeCalls("Meet me at 10:45.")], { nodes: { t: TEXTAREA() } }), { seed });
    assert.equal(p.tab.valueOf("t"), "Meet me at 10:45.");
  }
  // clear(): fill('') then the Delete key with a person's hold.
  const c = await runVector(own([fillCall("n", ""), rd("Delete"), ru("Delete")], { nodes: { n: INPUT({ value: "abc" }) } }));
  assert.equal(c.tab.valueOf("n"), "");
  const h = holds(keyEvents(c.tab))[0];
  assert.ok(h.key === "Delete" && h.ms >= 50 && h.ms <= 250);
});

test("a field in a cross-origin frame: the fill call on the frame's session; the stage maps the field to the top page and clicks there, on the top page's session; the typing rule reads the focus on the frame's session; typed keys", async () => {
  const page = { nodes: { n: { tag: "input", type: "text", frame: "xf", box: { x: 20, y: 30, width: 200, height: 30 }, text: 0, focused: false } },
    frames: { xf: { origin: "cross", box: { x: 460, y: 560, width: 300, height: 120 }, border: 3, padding: 4 } } };
  for (let seed = 1; seed <= 4; seed++) {
    const r = await runVector(own([fillCall("n", "Card 4242", "child"), insert("Card 4242")], page), { seed });
    const p = pressOf(r.tab)!;
    // The frame's content box at 467,567; the field at 487..687 x 597..627; empty: 25% to 75% across, 35% to 65% down.
    assert.ok(!p.child && p.params.x >= 537 && p.params.x <= 637 && p.params.y >= 608 && p.params.y <= 616, `the click at ${p.params.x},${p.params.y} on the top page's session`);
    assert.ok(r.tab.sent.find((s) => s.pass === 1)!.child === "child", "the utility call on the frame's session");
    assert.equal(r.tab.valueOf("n"), "Card 4242", "typed keys into the frame's field");
    assert.ok(keyEvents(r.tab).length > 10 && !r.stage.counts.textAsIs);
  }
});

// ================================================================ dialogs and errors

test("a dialog at a focus click (an alert() at the blur of the field before, M9): the plan ends; the client's dialog answer goes at once; the fill's call and its text go; every call ends", async () => {
  const v = own([fillCall("n", "abc"), insert("abc"), { afterEvent: "Page.javascriptDialogOpening", waitMs: 50, method: "Page.handleJavaScriptDialog", params: { accept: true } }], { nodes: { n: INPUT() } });
  v.in[1].after = 1;
  const r = await runVector(v, { tab: (t) => {
    t.hook = (s) => {
      if (s.method === "Input.dispatchMouseEvent" && s.params.type === "mousePressed" && !t.dialogSeen) {
        t.clientEvents.push({ t: t.clock.now(), method: "Page.javascriptDialogOpening" });
        t.stage.event(t, undefined, "Page.javascriptDialogOpening", { type: "alert", message: "blur" });
        t.onClientEvent("Page.javascriptDialogOpening");
        setImmediate(() => { t.dialogSeen = true; });
      }
      return undefined;
    };
  } });
  assert.equal(r.answers.length, 3, "every call ends");
  assert.ok(!answerOf(r, 1).body.error && !answerOf(r, 2).body.error);
  assert.equal(r.stage.counts.dialogEnds, 1);
  await r.clock.advance(RUN_IDLE_MS + 10);
  assert.equal(r.stage.lock.held, 0, "the lock is free at the run's end");
  const rel = mouseEvents(r.tab).find((s) => s.params.type === "mouseReleased");
  assert.ok(rel, "the held button is released after the close");
});

test("a dialog at a key (an alert() in a keydown handler): the plan ends; the key's own release goes after the close with Chrome's answer; the lock is free while it is open; no event of the plan after a later call", async () => {
  const calls = [...typeCalls("hello"), evaluate()];
  const v = own([...calls, { afterEvent: "Page.javascriptDialogOpening", waitMs: 3000, method: "Page.handleJavaScriptDialog", params: { accept: true } }], FIELD);
  let held = -1;
  const r = await runVector(v, { tab: (t) => {
    let n = 0;
    t.hook = (s) => {
      if (s.method === "Page.handleJavaScriptDialog") held = t.stage.lock.held;
      if (s.method === "Input.dispatchKeyEvent" && s.params.type === "keyDown" && ++n === 3) {
        t.clientEvents.push({ t: t.clock.now(), method: "Page.javascriptDialogOpening" });
        t.stage.event(t, undefined, "Page.javascriptDialogOpening", { type: "alert", message: "key" });
        t.onClientEvent("Page.javascriptDialogOpening");
        setImmediate(() => { t.dialogSeen = true; });
      }
      return undefined;
    };
  } });
  assert.equal(r.answers.length, v.in.length, "every call ends");
  assert.equal(held, 0, "the lock is free while the dialog is open");
  const ev = keyEvents(r.tab);
  assert.ok(!ev.some((s) => s.dropped), "no key event while the dialog is open");
  const later = r.tab.sent.findIndex((s) => s.pass === calls.length);
  assert.ok(ev.every((s) => r.tab.sent.indexOf(s) < later), "no key event after the later call");
  assert.equal(r.tab.valueOf("7.3.18"), "hello");
});

test("a typed text that a dialog ends: the release of each held key, and the characters whose keys did not go as one Input.insertText, whose answer is Chrome's", async () => {
  const v = own([fillCall("n", "Hello world"), insert("Hello world"), { afterEvent: "Page.javascriptDialogOpening", waitMs: 500, method: "Page.handleJavaScriptDialog", params: { accept: true } }], { nodes: { n: INPUT() } });
  v.in[1].after = 1;
  const r = await runVector(v, { tab: (t) => {
    let n = 0;
    t.hook = (s) => {
      if (s.method === "Input.dispatchKeyEvent" && s.params.type === "keyDown" && ++n === 4) {
        t.clientEvents.push({ t: t.clock.now(), method: "Page.javascriptDialogOpening" });
        t.stage.event(t, undefined, "Page.javascriptDialogOpening", { type: "alert", message: "x" });
        t.onClientEvent("Page.javascriptDialogOpening");
        setImmediate(() => { t.dialogSeen = true; });
      }
      return undefined;
    };
  } });
  assert.equal(r.answers.length, 3);
  const rest = r.tab.sent.filter((s) => s.method === "Input.insertText");
  assert.equal(rest.length, 1, "one insertText of the rest");
  assert.equal(r.tab.valueOf("n"), "Hello world", "the field's value is the text");
  assert.equal(r.stage.counts.typedTextsEnded, 1);
  assert.ok(!keyEvents(r.tab).some((s) => s.dropped));
});

test("an error of a key event: the plan stops; the stage's own Shift is released first; the call gets Chrome's error", async () => {
  const v = own(typeCalls("Ab"), FIELD);
  const r = await runVector(v, { tab: (t) => {
    t.hook = (s) => (s.method === "Input.dispatchKeyEvent" && s.params.type === "keyDown" && s.params.key === "A" ? Promise.reject(Object.assign(new Error("Key refused"), { code: -32000 })) : undefined);
  } });
  assert.deepEqual(answerOf(r, 1).body.error, { code: -32000, message: "Key refused" });
  const ev = keyEvents(r.tab);
  const shiftUp = ev.find((s) => s.params.key === "Shift" && s.params.type === "keyUp");
  assert.ok(shiftUp && r.tab.sent.indexOf(shiftUp) < answerOf(r, 1).n, "the Shift released before the error's answer");
  await r.clock.advance(RUN_IDLE_MS + 10);
  assert.equal(r.stage.lock.held, 0);
  assert.equal(r.stage.counts.eventErrors, 1);
});

test("the model's gate (the stage's other()): a call that the stage does not take ends a key run: it waits until an early-answered release has gone", async () => {
  let checked = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const calls = [...typeCalls("abcdefg"), evaluate()];
    const r = await runVector(own(calls, FIELD), { seed });
    const ups = keyEvents(r.tab).filter((s) => s.params.type === "keyUp"), ev = r.tab.sent.find((s) => s.pass === calls.length)!;
    const lastUp = r.tab.v.in.filter((c: any) => c.params.type === "keyUp").at(-1);
    if (answerOf(r, lastUp.id).t < ups.at(-1)!.t) checked++;
    assert.ok(ev.t >= ups.at(-1)!.t, `seed ${seed}: the evaluate after the last release`);
  }
  assert.ok(checked > 0, `the last release answered early in ${checked} seeds`);
});

test("the focus test: before fill, a field that is the active element of its document needs no click (fill's script selects its text); before Playwright's focus call, the window's focus counts too (Playwright's _activelyFocused), read after the activation", async () => {
  const page = { nodes: { n: INPUT({ text: 3, windowAway: true }) }, focused: "n" };
  const f = await runVector(own([fillCall("n", "abc")], page));
  assert.equal(mouseEvents(f.tab).length, 0, "fill: no click");
  assert.equal(f.stage.counts.fieldFocused, 1);
  const p = await runVector(own([focusCall("n", true)], page));
  assert.ok(pressOf(p.tab), "Playwright's focus call: a click (the document has the focus, the window does not)");
  assert.ok(p.tab.activations[0] <= mouseEvents(p.tab)[0].t, "the activation before the read and the click");
});

/** keyboard.type('hello') whose third key opens an alert in a keydown handler (the client answers it after `answerMs`, or never). */
function keyOpensDialog(t: FakeTab, n = 3) {
  let k = 0;
  t.hook = (s) => {
    if (s.method === "Input.dispatchKeyEvent" && s.params.type === "keyDown" && ++k === n) {
      t.clientEvents.push({ t: t.clock.now(), method: "Page.javascriptDialogOpening" });
      t.stage.event(t, undefined, "Page.javascriptDialogOpening", { type: "alert", message: "key" });
      t.onClientEvent("Page.javascriptDialogOpening");
      setImmediate(() => { t.dialogSeen = true; });
    }
    return undefined;
  };
}

test("an end of a key plan at a navigation of the main frame (the daemon lead's point, C11 sentence 6): a dialog at a key with the plan's later calls held; a navigation closes it: no held key press reaches the new page, the held calls get the error that the context is gone, only the releases of the held keys go", async () => {
  // H opens an alert in its keydown handler; the client's release of H and its press of i are calls of the plan (they came
  // before the end: a client that does not wait for each answer), so they are held until the close.
  const v = own([{ at: 0, ...kd("H") }, { at: 0, ...ku("H") }, { at: 0, ...kd("i") }], FIELD);
  const r = await runVector(v, { maxMs: 20_000, tab: (t) => { keyOpensDialog(t, 1); t.clock.timer(1000, () => t.navigate()); } });
  const ev = keyEvents(r.tab), after = ev.filter((s) => s.t >= 1000);
  assert.deepEqual(after.map((s) => [s.params.type, s.params.key]).sort(), [["keyUp", "H"], ["keyUp", "Shift"]], "only the releases of the held keys (H and the stage's own Shift)");
  assert.ok(!ev.some((s) => s.params.key === "i"), "the held press of i never goes");
  assert.deepEqual([answerOf(r, 2).body.error?.message, answerOf(r, 3).body.error?.message].map((m) => /context was destroyed/.test(m ?? "")), [true, true], "the held calls get the error that the context is gone");
  assert.equal(r.stage.counts.navigationDrops, 1);
});

test("an end of a key plan at the client's session end (the daemon lead's point): the stage sends no held key event and nothing goes back; it releases the held keys at the drop; the lock is free", async () => {
  const clock = new FakeClock();
  const stage = new Stage({ log: () => {}, random: seededRandom(4), platform: "linux", clock, stamp: clock.stamp });
  const v = own([{ at: 0, ...kd("H") }, { at: 0, ...ku("H") }, { at: 0, ...kd("i") }], FIELD), t = new FakeTab(v, clock);
  t.stage = stage;
  keyOpensDialog(t, 1);
  const answers: number[] = [];
  for (const c of v.in) clock.timer(c.at, () => t.queue(undefined, c.method, c.params, () => answers.push(c.id)));
  clock.timer(1000, () => stage.drop(t.id, "session"));
  await clock.run(() => false, 20_000);
  const ev = keyEvents(t), after = ev.filter((s) => s.t >= 1000);
  assert.deepEqual(after.map((s) => [s.params.type, s.params.key, s.t]).sort(), [["keyUp", "H", 1000], ["keyUp", "Shift", 1000]], "only the releases, at once at the drop");
  assert.ok(!ev.some((s) => s.params.key === "i"), "the held press of i never goes");
  assert.ok(!answers.includes(2) && !answers.includes(3), "nothing goes back for the held calls");
  assert.equal(stage.lock.held, 0);
});
