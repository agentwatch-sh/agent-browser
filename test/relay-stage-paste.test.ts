// The input stage's paste and its collected keys (board ab-t30.19; the operator's answer on board item ab-8fu,
// 2026-11-12: "can we do a simulated copy/paste for long text input? and we use a person typing for short input only?";
// C11 "The input stage": the collected keys, the paste, the time of a key run). A test for each rule that the vectors
// (test/vectors/stage.json: type, type-delay, type-long, fill-long, fill-long-mac, fill-paste-refused) do not show: the
// time of the text on the clipboard, a refused paste for a collected part, a paste handler's own text, the cases with no
// paste (the Mac, no clipboard, a grant of the clipboard, a contenteditable, a held key), the owner's failure, the keys
// that end a part, a key that is down at the part's end, and every end of a part's plan (a dialog during a typed part and
// during a paste, a navigation, STAGE_EVENT_WAIT_MS with a page that never answers, a session's end, an error), with the
// lock free and the tab's gate open at each end. A fake Chrome (stage-fakes.ts) keeps each field's value and pastes the
// fake clipboard's text at Control+V.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { charKey, CONTROL, SHIFT } from "../src/human/keys.ts";
import { seededRandom } from "../src/human/random.ts";
import { CLIPBOARD_HOLD_MS, PLAIN_IN_FLIGHT, RUN_IDLE_MS, Stage, STAGE_EVENT_WAIT_MS } from "../src/relay/stage.ts";
import { FakeClock, FakeTab, runVector, type Sent } from "./stage-fakes.ts";

const V = JSON.parse(readFileSync(new URL("./vectors/stage.json", import.meta.url), "utf8"));
const vec = (id: string) => structuredClone(V.vectors.find((x: any) => x.id === id));
const F = V.firstValues;

const ENTER = { key: "Enter", code: "Enter", keyCode: 13, text: "\r", modifiers: 0 };
/** Playwright's keyDown and keyUp of a character (playwright-core 1.65.0): a capital or a symbol with modifiers 0. */
const kd = (ch: string) => { const k = ch === "\r" ? ENTER : charKey(ch)!; return { method: "Input.dispatchKeyEvent", params: { type: "keyDown", modifiers: 0, windowsVirtualKeyCode: k.keyCode, code: k.code, commands: [], key: k.key, text: ch, unmodifiedText: ch, autoRepeat: false, location: 0, isKeypad: false } }; };
const ku = (ch: string) => { const k = ch === "\r" ? ENTER : charKey(ch)!; return { method: "Input.dispatchKeyEvent", params: { type: "keyUp", modifiers: 0, key: k.key, windowsVirtualKeyCode: k.keyCode, code: k.code, location: 0, isKeypad: false } }; };
const TAB = [{ method: "Input.dispatchKeyEvent", params: { type: "rawKeyDown", modifiers: 0, windowsVirtualKeyCode: 9, code: "Tab", commands: [], key: "Tab", text: "", unmodifiedText: "", autoRepeat: false, location: 0, isKeypad: false } },
  { method: "Input.dispatchKeyEvent", params: { type: "keyUp", modifiers: 0, key: "Tab", windowsVirtualKeyCode: 9, code: "Tab", location: 0, isKeypad: false } }];
const typeCalls = (text: string) => [...text].flatMap((ch): { method: string; params: Record<string, unknown> }[] => (ch === "\r" || charKey(ch) ? [kd(ch), ku(ch)] : [{ method: "Input.insertText", params: { text: ch } }]));
const insert = (text: string) => ({ method: "Input.insertText", params: { text } });
const evaluate = () => ({ method: "Runtime.evaluate", params: { expression: "1" } });
const FILL_FN = vec("fill").in[0].params.arguments[3].value;
const util = (fn: string, arg: unknown, node: string) => ({ method: "Runtime.callFunctionOn",
  params: { functionDeclaration: "(utilityScript, ...args) => utilityScript.evaluate(...args)", objectId: "7.3.1", returnByValue: true, awaitPromise: true, userGesture: true,
    arguments: [{ objectId: "7.3.1" }, { value: true }, { value: true }, { value: fn }, { value: 1 }, { value: { a: [{ h: 0 }, { h: 1 }, arg] } }, { objectId: "7.3.2" }, { objectId: node }] } });
const fillCall = (node: string, value: string) => util(FILL_FN, { o: [{ k: "value", v: value }, { k: "force", v: false }, { k: "frameVisible", v: true }] }, node);
/** A vector of the tests' own: the calls in order, each after the answer of the one before unless it names `at` or `after`. */
function own(calls: any[], page: Partial<any> = {}, extra: Partial<any> = {}) {
  const ins = calls.map((c, i) => ({ id: i + 1, ...(c.at === undefined && c.after === undefined && c.afterEvent === undefined ? (i === 0 ? { at: 0 } : { after: i }) : {}), ...c }));
  return { id: "own", platform: "linux", seed: 11, clock: 0, page: { viewport: { width: 1280, height: 720 }, last: { x: 900, y: 700 }, nodes: {}, focused: null, ...page },
    chrome: { results: Object.fromEntries(ins.filter((c) => c.method === "Runtime.callFunctionOn" && c.params.arguments?.[3]?.value === FILL_FN).map((c) => [c.id, { result: { type: "string", value: "needsinput" } }])) },
    in: ins, out: [], answers: [], ...extra };
}
const INPUT = (o: object = {}) => ({ tag: "input", type: "text", box: { x: 200, y: 300, width: 300, height: 30 }, text: 0, focused: true, ...o });
const TEXTAREA = (o: object = {}) => ({ tag: "textarea", box: { x: 200, y: 400, width: 400, height: 120 }, text: 0, focused: true, ...o });
/** A focused field n with the clipboard of the service's own display (and the page's facts in `o`). */
const PAGE = (node: object = INPUT(), o: object = {}) => ({ nodes: { n: node }, focused: "n", clipboard: true, ...o });
const keyEvents = (t: FakeTab) => t.sent.filter((s) => s.method === "Input.dispatchKeyEvent" && s.pass === undefined);
const answerOf = (r: Awaited<ReturnType<typeof runVector>>, id: number) => r.answers.find((a) => a.id === id)!;
const LONG = "the quick brown fox jumps over the lazy dog ".repeat(57).slice(0, 2500);
const MID = "the quick brown fox jumps over the lazy dog and the cat runs to the barn at noon today and then home again";
/** The chord of a paste: Control's press, V's press and release, Control's release (the stage's own keys). */
const chordOf = (t: FakeTab) => {
  const ev = keyEvents(t);
  return { ctrl: ev.find((s) => s.params.key === "Control" && s.params.type === "rawKeyDown"), v: ev.find((s) => s.params.key === "v" && s.params.type === "rawKeyDown"),
    vUp: ev.find((s) => s.params.key === "v" && s.params.type === "keyUp"), ctrlUp: ev.find((s) => s.params.key === "Control" && s.params.type === "keyUp") };
};
/** No log line holds a text of the test (C10's log rule). */
const noText = (logs: string[], text: string) => assert.ok(!logs.some((l) => l.includes(text.slice(0, 12))), "no log line holds the text");

// ================================================================ the paste

test("the paste of a long fill (C11, the paste): Control; the text on the clipboard only at V's time; V's keyDown (a rawKeyDown with modifiers 2 and no text); the clipboard cleared at once at V's answer; V's release after its hold, Control's 20 to 80 ms after; one paste of the whole text; the call's answer after Chrome's answers", async () => {
  for (let seed = 1; seed <= 8; seed++) {
    const r = await runVector(own([fillCall("n", LONG), insert(LONG)], PAGE(INPUT({ value: "old text", focused: false }))), { seed });
    const { ctrl, v, vUp, ctrlUp } = chordOf(r.tab);
    assert.ok(ctrl && v && vUp && ctrlUp, `seed ${seed}: the chord`);
    assert.deepEqual([ctrl!.params.modifiers, v!.params.modifiers, v!.params.text, v!.params.code, v!.params.windowsVirtualKeyCode], [CONTROL, CONTROL, undefined, "KeyV", 86]);
    assert.ok(v!.t - ctrl!.t >= F.chordBeforeMs[0] && v!.t - ctrl!.t <= F.chordBeforeMs[1] + 1, `seed ${seed}: V ${v!.t - ctrl!.t} ms after Control`);
    assert.ok(vUp!.t - v!.t >= F.keyHoldMs[0] && vUp!.t - v!.t <= F.keyHoldMs[1] + 1 && ctrlUp!.t - vUp!.t >= F.chordReleaseGapMs[0] && ctrlUp!.t - vUp!.t <= F.chordReleaseGapMs[1] + 1);
    const [hold, clear] = r.tab.clipLog;
    assert.deepEqual(r.tab.clipLog.map((x) => x.op), ["hold", "clear"], `seed ${seed}: one hold, one clear`);
    assert.ok(hold.t >= ctrl!.t && hold.t <= v!.t && v!.t - hold.t <= 1, `seed ${seed}: the hold at V's time (${v!.t - hold.t} ms before V), after Control`);
    assert.ok(clear.t >= v!.t && clear.t <= vUp!.t && clear.t - (v!.answered ?? v!.t) <= 1, `seed ${seed}: the clear at V's answer, before V's release`);
    assert.equal(hold.len, 2500);
    assert.deepEqual(r.tab.pastes.map((p) => p.len), [2500], "one paste of the whole text");
    assert.equal(r.tab.valueOf("n"), LONG, "the field's value is the text (fill's script selected the old text)");
    assert.ok(answerOf(r, 2).t >= ctrlUp!.t && !answerOf(r, 2).body.error, "the answer after the chord's last event");
    assert.equal(r.stage.counts.pastes, 1);
    assert.ok(!keyEvents(r.tab).some((s) => s.params.text && s.params.text !== ""), "no key event of a character");
    noText(r.logs, LONG);
  }
  // keyboard.insertText into a field with text and its caret at the end: the text in place of the selection.
  const k = await runVector(own([insert(MID + MID)], PAGE(INPUT({ value: "abc", caret: [3, 3] }))));
  assert.equal(k.tab.valueOf("n"), "abc" + MID + MID);
  assert.equal(k.stage.counts.pastes, 1);
});

test("a collected part of a long pressSequentially (2,500 characters, C11, the collected keys): every call answered at once with no event; the part goes at the next call as one paste; that call waits for the paste's events; the whole text once", async () => {
  const calls = [...typeCalls(LONG), evaluate()];
  const r = await runVector(own(calls, PAGE(TEXTAREA())), { maxMs: 200_000 });
  for (let id = 1; id <= LONG.length * 2; id++) assert.ok(!r.tab.sent.slice(0, answerOf(r, id).n).some((s) => s.method === "Input.dispatchKeyEvent"), `call ${id}: its answer before any key event`);
  const { ctrl, ctrlUp } = chordOf(r.tab), ev = r.tab.sent.find((s) => s.pass === calls.length)!;
  assert.ok(ctrl!.t - r.arrived.get(calls.length)! < 2500, "the part goes at the evaluate's arrival (a person's time before Control)");
  assert.ok(ev.t >= ctrlUp!.t, "the evaluate goes after the paste's last event");
  assert.equal(r.tab.valueOf("n"), LONG);
  assert.deepEqual([r.stage.counts.pastedParts, r.stage.counts.collectedParts, r.stage.counts.collectedCalls, r.tab.pastes.length], [1, 1, 5000, 1]);
  assert.ok(ctrlUp!.t - r.arrived.get(calls.length)! < 3000, `the paste's events in ${Math.round(ctrlUp!.t - r.arrived.get(calls.length)!)} ms`);
});

test("a refused paste (a paste handler that prevents it: the field's value did not change, C11, the paste): fill gets the client's Input.insertText after the paste's events; a collected part gets the client's own key events at once, in order", async () => {
  const f = await runVector(own([fillCall("n", LONG), insert(LONG)], PAGE(INPUT({ refusesPaste: true, focused: false }))));
  const { ctrlUp } = chordOf(f.tab), pass = f.tab.sent.find((s) => s.method === "Input.insertText")!;
  assert.ok(pass && pass.pass === 2 && pass.t >= ctrlUp!.t, "fill: the client's insertText after the chord");
  assert.equal(f.tab.valueOf("n"), LONG);
  assert.equal(f.stage.counts.pastesRefused, 1);
  const p = await runVector(own(typeCalls(MID + MID), PAGE(INPUT({ refusesPaste: true }))));
  const keys = keyEvents(p.tab).filter((s) => s.params.text);
  assert.equal(keys.map((s) => s.params.text).join(""), MID + MID, "the part: the client's own keyDowns, each character once, in order");
  assert.ok(keys[0].t >= chordOf(p.tab).ctrlUp!.t);
  assert.equal(p.tab.valueOf("n"), MID + MID);
  assert.deepEqual([p.stage.counts.pastesRefused, p.tab.clipLog.map((x) => x.op).join(",")], [1, "hold,clear"]);
});

test("a long text with line breaks into an input (the probe: Chrome inserts a space for each line break there, as Input.insertText does): a paste, counted as one, with no second input", async () => {
  const text = (MID + "\n").repeat(3);
  const r = await runVector(own([fillCall("n", text), insert(text)], PAGE(INPUT({ focused: false }))));
  assert.equal(r.tab.valueOf("n"), text.replace(/\n/g, " "));
  assert.deepEqual([r.stage.counts.pastes, r.stage.counts.pasteValueDiffers, r.tab.sent.filter((s) => s.method === "Input.insertText").length], [1, undefined, 0]);
});

test("a collected part as the client's own keys (no clipboard): at most PLAIN_IN_FLIGHT (8) of its events without an answer; each character once, in order", async () => {
  // A page that takes 2 ms for each key event (Chrome queues the rest): the answers come one by one.
  const r = await runVector(own(typeCalls(LONG.slice(0, 400)), { nodes: { n: INPUT() }, focused: "n" }), { tab: (t) => { t.busy = (s) => (s.method === "Input.dispatchKeyEvent" ? 2 : 0); } });
  assert.equal(r.tab.valueOf("n"), LONG.slice(0, 400));
  const ev = keyEvents(r.tab);
  let most = 0;
  for (const e of ev) most = Math.max(most, ev.filter((x) => x.t <= e.t && (x.answered ?? Infinity) > e.t).length);
  assert.ok(most <= PLAIN_IN_FLIGHT && most >= 2, `at most ${most} key events without an answer`);
});

test("a paste handler of the page that inserts its own text (a value that is neither the text nor the old value): counted, logged with no text, no repair (no second input)", async () => {
  const r = await runVector(own([fillCall("n", LONG), insert(LONG)], PAGE(INPUT({ pasteAs: "cleaned", focused: false }))));
  assert.equal(r.tab.valueOf("n"), "cleaned");
  assert.equal(r.stage.counts.pasteValueDiffers, 1);
  assert.ok(!r.tab.sent.some((s) => s.method === "Input.insertText"), "no insertText after the paste");
  noText(r.logs, LONG);
});

test("no paste (C11, the paste rule): on the Mac (Chrome there shares the operator's own clipboard: the open point of stage 4), with no clipboard (the relay), while a connection holds a grant of the clipboard, into a contenteditable, while the client holds a key: a long fill goes as one Input.insertText and a long collected part as the client's own keys; the clipboard gets no call", async () => {
  const CE = { tag: "div", contenteditable: true, box: { x: 200, y: 300, width: 300, height: 30 }, text: 0, focused: true };
  const cases: [string, any, any, string][] = [
    ["the Mac", PAGE(), { platform: "mac" }, "mac"],
    ["no clipboard", { nodes: { n: INPUT() }, focused: "n" }, {}, "noClipboard"],
    ["a grant of the clipboard", PAGE(INPUT(), { clipboardGrant: true }), {}, "clipboardGrant"],
    ["a contenteditable", PAGE(CE), {}, "contenteditable"],
  ];
  for (const [name, page, extra, why] of cases) {
    const f = await runVector(own([insert(LONG)], page, extra));
    assert.deepEqual([f.tab.sent.filter((s) => s.method === "Input.insertText" && s.pass === 1).length, f.stage.counts[`noPaste:${why}`], f.tab.clipLog.length, f.tab.pastes.length], [1, 1, 0, 0], `${name}: the fill's text as one Input.insertText, no clipboard call`);
    const p = await runVector(own(typeCalls(MID + MID), page, extra));
    assert.equal(keyEvents(p.tab).filter((s) => s.params.text).map((s) => s.params.text).join(""), MID + MID, `${name}: the part as the client's own keys`);
    assert.deepEqual([p.stage.counts[`partsAsKeys:${why}`], p.tab.clipLog.length], [1, 0], `${name}: counted, no clipboard call`);
  }
  // A key that the client holds (keyboard.down('Shift'), then a long insertText): no paste (Control+V would be Control+Shift+V).
  const SHIFT_DOWN = { method: "Input.dispatchKeyEvent", params: { type: "rawKeyDown", modifiers: SHIFT, windowsVirtualKeyCode: 16, code: "ShiftLeft", commands: [], key: "Shift", text: "", unmodifiedText: "", autoRepeat: false, location: 1, isKeypad: false } };
  const h = await runVector(own([SHIFT_DOWN, insert(LONG)], PAGE()));
  assert.deepEqual([h.stage.counts["noPaste:keyHeld"], h.tab.clipLog.length], [1, 0]);
});

test("the clipboard's owner fails (it answers false) or does not answer in CLIPBOARD_HOLD_MS: V does not go; the chord's Control goes up; the text goes as Playwright's own input; the clipboard is cleared", async () => {
  for (const [name, answer] of [["false", () => false], ["no answer", () => new Promise<boolean>(() => {})]] as const) {
    const r = await runVector(own([fillCall("n", LONG), insert(LONG)], PAGE(INPUT({ focused: false }))), { tab: (t) => { t.holdAnswer = answer as () => boolean; } });
    const { ctrl, v, ctrlUp } = chordOf(r.tab), pass = r.tab.sent.find((s) => s.method === "Input.insertText")!;
    assert.ok(ctrl && ctrlUp && !v, `${name}: Control down and up, no V`);
    assert.ok(pass && pass.t >= ctrlUp!.t, `${name}: the client's insertText after Control's release`);
    if (name === "no answer") assert.ok(ctrlUp!.t - r.tab.clipLog[0].t >= CLIPBOARD_HOLD_MS, "the wait ends at CLIPBOARD_HOLD_MS");
    assert.equal(r.tab.clipLog.at(-1)!.op, "clear");
    assert.equal(r.tab.valueOf("n"), LONG);
    assert.equal(r.stage.counts.pasteHoldFails, 1);
  }
});

// ================================================================ the collected keys

test("Enter, Tab and a key with no text end a collected part and go as keys of the per-key path, in order (C11, the collected keys)", async () => {
  const calls = [...typeCalls("ab"), kd("\r"), ku("\r"), ...typeCalls("cd"), ...TAB, ...typeCalls("ef")];
  const r = await runVector(own(calls, PAGE(TEXTAREA())));
  const order = keyEvents(r.tab).filter((s) => s.params.type !== "keyUp" && s.params.key !== "Shift").map((s) => s.params.key).join(" ");
  assert.equal(order, "a b Enter c d Tab e f");
  assert.equal(r.stage.counts.collectedParts, 3);
  const enter = keyEvents(r.tab).find((s) => s.params.key === "Enter")!, b = keyEvents(r.tab).find((s) => s.params.key === "b" && s.params.type === "keyUp")!;
  assert.ok(enter.t > b.t && answerOf(r, 5).t >= enter.t, "Enter after the part's last event; its own answer after its keyDown");
});

test("a collected key whose keyUp has not come at the part's end (keyboard.down('a'), then another call): the part goes, then the client's press of a, down until the client's own keyUp", async () => {
  const r = await runVector(own([...typeCalls("xy"), kd("a"), evaluate(), { ...ku("a"), waitMs: 2000 }], PAGE()));
  const ev = keyEvents(r.tab), aDown = ev.find((s) => s.params.key === "a" && s.params.type === "keyDown")!, aUp = ev.find((s) => s.params.key === "a" && s.params.type === "keyUp")!;
  const evalSent = r.tab.sent.find((s) => s.pass === 6)!;
  assert.ok(aDown.t <= evalSent.t && aUp.t >= r.arrived.get(7)!, "a goes down before the evaluate and up at the client's keyUp");
  assert.equal(r.tab.valueOf("n"), "xya");
});

test("a drop during the collection (the tab's end or the session's end): no event of the part goes; its calls have their answers; counted", async () => {
  for (const why of ["tab", "session"] as const) {
    const r = await runVector(own(typeCalls(MID), PAGE()), { tab: (t) => { t.clock.timer(200, () => t.stage.drop(t.id, why)); } });
    assert.equal(keyEvents(r.tab).length, 0, `${why}: no key event`);
    assert.equal(r.answers.length, r.tab.v.in.length);
    assert.equal(r.stage.counts.collectedDropped, 1);
    assert.equal(r.stage.lock.held, 0);
  }
});

// ================================================================ the ends of a part's plan (no repeat of review-123b R1)

/** A dialog that a page's keydown handler opens at the n-th keyDown of `key` (any key when null); the client answers it after `ms`. */
function dialogAt(t: FakeTab, n: number, key: string | null) { let k = 0; t.opensDialog = (s) => s.method === "Input.dispatchKeyEvent" && (s.params.type === "keyDown" || s.params.type === "rawKeyDown") && (key === null ? s.params.key !== "Shift" && s.params.key !== "Control" : s.params.key === key) && ++k === n; }
const ANSWER = (ms: number) => ({ afterEvent: "Page.javascriptDialogOpening", waitMs: ms, method: "Page.handleJavaScriptDialog", params: { accept: true } });

test("a dialog during a typed part (a keydown handler's alert at its 3rd key): the plan ends, the lock is free while it is open; after the close the held keys go up and the rest goes as one Input.insertText; the tab's next call waits for it; the text once", async () => {
  let held = -1;
  const calls = [...typeCalls("hello world"), evaluate(), ANSWER(3000)];
  const r = await runVector(own(calls, PAGE()), { tab: (t) => { dialogAt(t, 3, null); const h = t.hook; t.hook = (s) => { if (s.method === "Page.handleJavaScriptDialog") held = t.stage.lock.held; return h(s); }; } });
  assert.equal(held, 0, "the lock is free while the dialog is open");
  const rest = r.tab.sent.filter((s) => s.method === "Input.insertText");
  assert.equal(rest.length, 1, "the rest as one insertText");
  const evalSent = r.tab.sent.find((s) => s.pass === 23)!;
  assert.ok(evalSent && r.tab.sent.indexOf(evalSent) > r.tab.sent.indexOf(rest[0]), "the evaluate after the rest");
  assert.equal(r.tab.valueOf("n"), "hello world");
  assert.equal(r.stage.counts.typedTextsEnded, 1);
});

test("a dialog during a paste (a keydown handler's alert at V): the clipboard is cleared at once at the dialog, not at the close; Chrome's paste after the close (V's default action, review-126 note 7) finds no text; after the close the held keys go up, and the text goes once as Playwright's own input; for a refused paste the same", async () => {
  const r = await runVector(own([fillCall("n", LONG), insert(LONG), ANSWER(3000)], PAGE(INPUT({ focused: false }))), { tab: (t) => dialogAt(t, 1, "v") });
  const v = chordOf(r.tab).v!, clear = r.tab.clipLog.find((x) => x.op === "clear")!;
  assert.ok(clear.t - v.t < 50, `the clear ${clear.t - v.t} ms after V (the dialog), before the close at 3 s`);
  assert.deepEqual(r.tab.pastes.map((x) => [x.t >= 3000, x.len]), [[true, 0]], "Chrome's paste after the close, with an empty clipboard");
  assert.equal(r.tab.valueOf("n"), LONG);
  const ins0 = r.tab.sent.filter((s) => s.method === "Input.insertText");
  assert.ok(ins0.length === 1 && ins0[0].t >= 3000, "the client's insertText once, after the close");
  assert.ok(keyEvents(r.tab).some((s) => s.params.key === "Control" && s.params.type === "keyUp" && s.t >= 3000), "Control up after the close");
  assert.ok(!answerOf(r, 2).body.error);
  const q = await runVector(own([fillCall("n", LONG), insert(LONG), ANSWER(3000)], PAGE(INPUT({ focused: false, refusesPaste: true }))), { tab: (t) => dialogAt(t, 1, "v") });
  const ins = q.tab.sent.find((s) => s.method === "Input.insertText")!;
  assert.ok(ins && ins.t >= 3000, "refused: the client's insertText after the close");
  assert.equal(q.tab.valueOf("n"), LONG);
});

test("a page that never answers V (STAGE_EVENT_WAIT_MS): the clipboard is cleared at the end; the stage waits one more STAGE_EVENT_WAIT_MS; fill's call gets an error that names the end and the count; a collected part's error goes to the log; the lock is free and the tab's next call goes, each wait with its limit", async () => {
  const never = (s: Sent) => (s.method === "Input.dispatchKeyEvent" && s.params.key === "v" ? new Promise(() => {}) : undefined);
  const f = await runVector(own([fillCall("n", LONG), insert(LONG), evaluate()], PAGE(INPUT({ focused: false }))), { hook: never, maxMs: 60_000 });
  const v = chordOf(f.tab).v!;
  assert.match(answerOf(f, 2).body.error?.message ?? "", /^The input stage ended a pasted text at no answer in 2000 ms, and 2500 characters may not have gone: the page did not answer\.$/);
  assert.ok(answerOf(f, 2).t - v.t <= 2 * STAGE_EVENT_WAIT_MS + 50, `the error ${answerOf(f, 2).t - v.t} ms after V`);
  assert.ok(f.tab.clipLog.find((x) => x.op === "clear")!.t - v.t <= STAGE_EVENT_WAIT_MS + 1, "the clipboard cleared at the first end");
  assert.ok(f.tab.sent.some((s) => s.pass === 3), "the evaluate goes");
  assert.equal(f.stage.lock.held, 0);
  const p = await runVector(own([...typeCalls(LONG.slice(0, 300)), evaluate()], PAGE()), { hook: never, maxMs: 60_000 });
  const pv = chordOf(p.tab).v!, ev = p.tab.sent.find((s) => s.pass === 601)!;
  assert.ok(ev && ev.t - pv.t <= 2 * STAGE_EVENT_WAIT_MS + 50, `the part's end opens the gate: the evaluate ${ev ? ev.t - pv.t : "never"} ms after V`);
  assert.equal(p.stage.counts.partErrors, 1);
  assert.ok(p.logs.some((l) => /a collected part of a key run: The input stage ended a pasted text at no answer in 2000 ms, and 300 characters may not have gone/.test(l)));
  assert.equal(p.stage.lock.held, 0);
});

test("a dialog during a collected part as the client's own keys (no clipboard; found in the review-126 round): Chrome drops each event that it gets while the dialog is open, so the events after the one that opened it go again after the close: the whole text once, in order", async () => {
  const text = LONG.slice(0, 400);
  for (const n of [1, 20, 199]) {
    const r = await runVector(own([...typeCalls(text), evaluate(), ANSWER(500)], { nodes: { n: INPUT() }, focused: "n" }), { maxMs: 60_000, tab: (t) => dialogAt(t, n, null) });
    assert.equal(r.tab.valueOf("n"), text, `a dialog at keyDown ${n}: the whole text once`);
    assert.ok(keyEvents(r.tab).some((s) => s.dropped), `keyDown ${n}: Chrome dropped events while the dialog was open`);
    assert.ok((r.stage.counts.partKeysAgain ?? 0) >= 1, `keyDown ${n}: ${r.stage.counts.partKeysAgain} events again`);
    assert.equal(r.stage.lock.held, 0);
  }
});

test("review-126 B2: a collected part as the client's own keys (no clipboard) that resumes after a dialog's close, on a page that then stops answering (eight events in flight): each wait has its STAGE_EVENT_WAIT_MS limit; the rest does not go; the held keys go up; the error goes to the log; the gate opens and the lock is free", async () => {
  let closed = -1;
  const text = LONG.slice(0, 400);
  const r = await runVector(own([...typeCalls(text), evaluate(), ANSWER(500)], { nodes: { n: INPUT() }, focused: "n" }), { maxMs: 60_000, tab: (t) => {
    dialogAt(t, 20, null);
    t.hook = (s) => {
      if (s.method === "Page.handleJavaScriptDialog") { closed = t.clock.now(); return undefined; }
      return closed >= 0 && s.method === "Input.dispatchKeyEvent" ? new Promise(() => {}) : undefined;
    };
  } });
  const after = keyEvents(r.tab).filter((s) => s.t >= closed && s.params.type === "keyDown");
  const ev = r.tab.sent.find((s) => s.pass === text.length * 2 + 1)!;
  assert.ok(closed > 0 && after.length >= 1 && after.length <= PLAIN_IN_FLIGHT, `${after.length} keyDowns after the close`);
  assert.ok(ev && ev.t - after[0].t <= STAGE_EVENT_WAIT_MS + 50, `the evaluate ${ev ? Math.round(ev.t - after[0].t) : "never"} ms after the first event that has no answer`);
  assert.equal(r.stage.counts.partKeysCut, 1);
  assert.ok(r.logs.some((l) => /a collected part of a key run: The input stage ended a collected part of a key run, and \d+ of its key events did not go: the page did not answer\./.test(l)), "logged");
  assert.equal(r.stage.lock.held, 0);
  assert.deepEqual(r.stage.state(r.tab.id)?.keys ?? [], [], "no key of the part stays down");
  assert.ok((r.stage.counts.partKeysAgain ?? 0) >= 1, "the events that the dialog dropped go again after the close");
});

test("a page that never answers any key of a typed part: the part's end opens the gate within its limits (no repeat of review-123b R1), and the lock is free", async () => {
  const never = (s: Sent) => (s.method === "Input.dispatchKeyEvent" ? new Promise(() => {}) : undefined);
  const r = await runVector(own([...typeCalls("hello"), evaluate()], PAGE()), { hook: never, maxMs: 60_000 });
  const first = keyEvents(r.tab)[0], ev = r.tab.sent.find((s) => s.pass === 11)!;
  assert.ok(ev && ev.t - first.t <= 2 * STAGE_EVENT_WAIT_MS + 50, `the evaluate ${ev ? ev.t - first.t : "never"} ms after the first key`);
  assert.equal(r.stage.lock.held, 0);
  assert.equal(r.stage.counts.waitEnds, 1);
});

test("a navigation of the main frame during a paste: no text goes after it; fill's call gets the error that names the navigation", async () => {
  const slow = (t: FakeTab) => { t.hook = (s) => (s.method === "Input.dispatchKeyEvent" && s.params.key === "v" && s.params.type === "rawKeyDown" ? new Promise((res) => t.clock.timer(800, () => res({}))) : undefined); };
  const r = await runVector(own([fillCall("n", LONG), insert(LONG)], PAGE(INPUT({ focused: false, refusesPaste: true }))), { tab: (t) => { slow(t); const v0 = () => chordOf(t).v; const tick = () => { if (v0()) t.clock.timer(300, () => t.navigate()); else t.clock.timer(5, tick); }; t.clock.timer(5, tick); } });
  assert.match(answerOf(r, 2).body.error?.message ?? "", /did not go: the page navigated\.$/);
  assert.ok(answerOf(r, 2).t < 5000, `the error at ${Math.round(answerOf(r, 2).t)} ms, not at a limit`);
  assert.ok(!r.tab.sent.some((s) => s.method === "Input.insertText"), "no text after the navigation");
  assert.ok(keyEvents(r.tab).some((s) => s.params.key === "Control" && s.params.type === "keyUp"), "Control goes up");
  await r.clock.advance(RUN_IDLE_MS + 10);
  assert.equal(r.stage.lock.held, 0, "the run ends RUN_IDLE_MS after its last key, and the lock is free");
});

test("a session's end during a paste: nothing goes back; the clipboard is cleared at once; the held keys go up at the drop; the lock is free", async () => {
  const r = await runVector(own([fillCall("n", LONG), insert(LONG)], PAGE(INPUT({ focused: false }))), { maxMs: 30_000, tab: (t) => {
    t.hook = (s) => (s.method === "Input.dispatchKeyEvent" && s.params.key === "v" && s.params.type === "rawKeyDown" ? (t.clock.timer(10, () => t.stage.drop(t.id, "session")), new Promise(() => {})) : undefined);
  } });
  const v = chordOf(r.tab).v!;
  assert.ok(r.tab.clipLog.at(-1)!.op === "clear" && r.tab.clipLog.at(-1)!.t - v.t <= 11, "cleared at the drop");
  assert.ok(!r.answers.some((a) => a.id === 2), "nothing goes back");
  assert.ok(keyEvents(r.tab).some((s) => s.params.key === "Control" && s.params.type === "keyUp" && s.t - v.t <= 11), "Control up at the drop");
  assert.equal(r.stage.lock.held, 0);
});

// ================================================================ two tabs of one display (review-126 B4)

/**
 * Two tabs of one stage on one display: each with its own fake Chrome, one clipboard (tab 1's, which both read: the
 * display's selection), each tab's calls as in `own` (chained by their answers).
 */
async function twoPastes(callsA: any[], callsB: any[], pageA: Partial<any>, pageB: Partial<any>, setup?: (A: FakeTab, B: FakeTab, stage: Stage) => void, maxMs = 120_000) {
  const clock = new FakeClock(), logs: string[] = [];
  const mk = (id: number, calls: any[], page: Partial<any>) => {
    const v = own(calls, page), t = new FakeTab(v, clock, { id }), answers: { id: number; t: number; body: any }[] = [];
    const send = (c: any) => t.queue(undefined, c.method, c.params, (body) => { answers.push({ id: c.id, t: clock.now(), body }); for (const x of v.in) if (x.after === c.id) later(x); });
    const later = (c: any) => (c.waitMs ? clock.timer(c.waitMs, () => send(c)) : send(c));
    return { t, v, answers, start: () => { for (const c of v.in) if (c.at !== undefined) clock.timer(c.at, () => later(c)); } };
  };
  const A = mk(1, callsA, pageA), B = mk(2, callsB, pageB);
  const stage = new Stage({ log: (l) => logs.push(l), random: seededRandom(5), platform: "linux", clock, stamp: clock.stamp, clipboard: A.t.clipboard });
  A.t.stage = stage; B.t.stage = stage;
  B.t.clipBox = A.t.clipBox;
  setup?.(A.t, B.t, stage);
  A.start(); B.start();
  await clock.run(() => A.answers.length === A.v.in.length && B.answers.length === B.v.in.length, maxMs);
  await clock.advance(5000);
  return { A, B, stage, clock, logs };
}

test("review-126 B4: no paste puts a text on the clipboard while an earlier paste's V has no answer: tab 1's V answers after 3 s (a busy keydown handler), tab 2's long text goes at once as Playwright's own input (counted), and tab 1's field never gets tab 2's text; the clipboard is cleared before the lock is free; after V's answer, or the end of its tab, the paste path is open again", async () => {
  const L2 = LONG.toUpperCase(), L3 = LONG.replace(/ /g, "_");
  // Each page's keydown handler of V is busy: tab 1's for 3 s, tab 2's for 1.5 s (a text that it held would stay on the
  // clipboard that long, and tab 1's paste at 3 s would read it).
  const busyV = (t: FakeTab, ms: number) => { t.busy = (s) => (s.method === "Input.dispatchKeyEvent" && s.params.key === "v" && s.params.type === "rawKeyDown" ? ms : 0); };
  const r = await twoPastes([fillCall("n", LONG), insert(LONG)], [{ at: 1, ...fillCall("n", L2) }, insert(L2), { ...fillCall("n", L3), waitMs: 6000 }, insert(L3)],
    PAGE(INPUT({ focused: false })), PAGE(INPUT({ focused: false })), (A, B) => { busyV(A, 3000); busyV(B, 1500); });
  const v = chordOf(r.A.t).v!, clear = r.A.t.clipLog.find((x) => x.op === "clear")!, holds = r.A.t.clipLog.filter((x) => x.op === "hold");
  const bFirst = r.B.t.sent.find((s) => s.method.startsWith("Input."))!, bText = r.B.t.sent.find((s) => s.method === "Input.insertText")!;
  assert.ok(v.answered! - v.t >= 3000, `tab 1's V answers ${v.answered! - v.t} ms after its send`);
  assert.ok(bText && bText.t < v.answered!, `tab 2's text goes at ${bText?.t} ms, before tab 1's V answer at ${v.answered} ms`);
  assert.ok(clear.t <= bFirst.t, `the clear at ${clear.t} ms, before tab 2's first input at ${bFirst.t} ms (the lock was free)`);
  assert.deepEqual(r.A.t.pastes.map((x) => x.len), [0], "tab 1's paste (after its handler) finds no text");
  assert.equal(r.A.t.valueOf("n"), LONG, "tab 1's field: its own text (Playwright's own input after V's answer)");
  assert.equal(r.stage.counts["noPaste:vPending"], 1);
  assert.equal(r.B.t.pastes.length, 1, "tab 2's later long text (after V's answer) is a paste again");
  assert.equal(r.B.t.valueOf("n"), L3);
  assert.deepEqual(holds.map((x) => x.len), [2500, 2500], "the holds: tab 1's text, then tab 2's later one");
  // A V that never answers closes the path until its tab ends.
  const q = await twoPastes([fillCall("n", LONG), insert(LONG)], [{ at: 1, ...fillCall("n", L2) }, insert(L2), { ...fillCall("n", L3), waitMs: 6000 }, insert(L3)],
    PAGE(INPUT({ focused: false })), PAGE(INPUT({ focused: false })), (A, _B, stage) => {
      A.hook = (s) => (s.method === "Input.dispatchKeyEvent" && s.params.key === "v" && s.params.type === "rawKeyDown" ? (A.clock.timer(5000, () => stage.drop(A.id, "tab")), new Promise(() => {})) : undefined);
    });
  assert.equal(q.stage.counts["noPaste:vPending"], 1, "tab 2's first long text while tab 1's V has no answer");
  assert.equal(q.B.t.pastes.length, 1, "tab 2's later long text, after the end of tab 1, is a paste");
  assert.equal(q.B.t.valueOf("n"), L3);
  assert.equal(q.stage.lock.held, 0);
});

// The grant of the clipboard (the paste rule) is the model's: test/relay-stage-model.test.ts.

test("RUN_IDLE_MS is the gap that ends a collected part (C11, the collected keys), and CLIPBOARD_HOLD_MS the stage's wait for the clipboard's owner", () => {
  assert.deepEqual([RUN_IDLE_MS, CLIPBOARD_HOLD_MS], [1000, 500]);
});
