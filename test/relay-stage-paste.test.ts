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
import { CLIPBOARD_HOLD_MS, PLAIN_IN_FLIGHT, RUN_IDLE_MS, Stage, STAGE_EVENT_WAIT_MS, STAGE_FLUSH_MS } from "../src/relay/stage.ts";
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
  // The call waits for the part's step itself, not only for the lock of its run: it goes right after the part, not at the run's idle end.
  assert.ok(enter.t - b.t < 600, `Enter ${Math.round(enter.t - b.t)} ms after the part's last event`);
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
  // The stage hears of the dialog 400 ms late: the keys that it sent in that time were dropped (the dialog was open), so
  // only the keys up to the one that opened it count as typed (review-126: a part's dialog end).
  const late = await runVector(own(calls, PAGE()), { tab: (t) => { dialogAt(t, 3, null); t.dialogNoticeMs = 400; } });
  assert.ok(keyEvents(late.tab).some((s) => s.dropped && s.params.type === "keyDown"), "keys dropped while the dialog was open");
  assert.equal(late.tab.valueOf("n"), "hello world", "a late notice: the text once");
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

test("review-126 B2: no event of a part's own keys goes after the end of the session, also after a resume (the dialog's close)", async () => {
  let dropAt = -1;
  const text = LONG.slice(0, 400);
  const r = await runVector(own([...typeCalls(text), evaluate(), ANSWER(500)], { nodes: { n: INPUT() }, focused: "n" }), { maxMs: 60_000, tab: (t) => {
    dialogAt(t, 20, null);
    t.busy = (s) => (s.method === "Input.dispatchKeyEvent" ? 2 : 0);
    // The session ends 200 ms after the client's Page.handleJavaScriptDialog: the part resumed, and it sends.
    t.hook = (s) => { if (s.method === "Page.handleJavaScriptDialog") t.clock.timer(200, () => { dropAt = t.clock.now(); t.stage.drop(t.id, "session"); }); return undefined; };
  } });
  const after = keyEvents(r.tab).filter((s) => s.t > dropAt && s.params.type === "keyDown");
  assert.ok(dropAt > 0 && keyEvents(r.tab).some((s) => s.t > dropAt - 200 && s.t < dropAt && s.params.type === "keyDown"), "the part sent after the resume, before the end");
  assert.deepEqual(after.map((s) => s.params.key), [], "no keyDown after the session's end");
  assert.equal(r.stage.lock.held, 0);
});

test("the watchdog's compare has its margin (no endless timer at a float time): with seeds 21 and 36 a page that never answers V ends the plan at STAGE_EVENT_WAIT_MS, and the run ends", async () => {
  const never = (s: Sent) => (s.method === "Input.dispatchKeyEvent" && s.params.key === "v" ? new Promise(() => {}) : undefined);
  for (const seed of [21, 36]) {
    const run = runVector(own([insert(LONG), evaluate()], PAGE()), { seed, hook: never, maxMs: 60_000 }).then((r) => r.stage.counts.waitEnds);
    const got = await Promise.race([run, new Promise((res) => setTimeout(() => res("no end in 5 s"), 5000))]);
    assert.equal(got, 1, `seed ${seed}: the plan ends at STAGE_EVENT_WAIT_MS`);
  }
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

// ================================================================ the flush (review-126 B3)

test("review-126 B3: the flush before a close of the tab or at its session's end: a collected part that has not gone goes at once as one Input.insertText of its text (no paste, no keys), within STAGE_FLUSH_MS; a part whose plan runs (typed, pasted) ends as at STAGE_ACTION_MAX_MS and its rest goes as one Input.insertText; the field holds the text once; with no part, no flush", async () => {
  // A collected part of 300 characters (a paste) and one of 11 (typed), each flushed before its gap ends.
  for (const text of [LONG.slice(0, 300), "hello world"]) {
    let flushed: Promise<void> | null = null, at = -1, done = -1;
    const r = await runVector(own(typeCalls(text), PAGE()), { maxMs: 60_000, tab: (t) => {
      t.clock.timer(300, () => { at = t.clock.now(); flushed = t.stage.flush(t); void flushed?.then(() => { done = t.clock.now(); }); });
    } });
    await r.clock.advance(STAGE_FLUSH_MS);
    const ins = r.tab.sent.filter((s) => s.method === "Input.insertText");
    assert.ok(flushed && done >= at && done - at <= 50, `${text.length} characters: the flush ends ${done - at} ms after it starts`);
    assert.deepEqual(ins.map((s) => s.params.text), [text], `${text.length} characters: one Input.insertText of the part`);
    assert.equal(keyEvents(r.tab).length, 0, "no key event");
    assert.equal(r.tab.valueOf("n"), text);
    assert.deepEqual([r.stage.counts.partFlushes, r.stage.counts.partsFlushed], [1, 1]);
    assert.equal(r.stage.lock.held, 0);
  }
  // A part whose plan runs: typed (40 characters), and pasted (2,500 characters, V's answer late): the flush 300 ms in.
  for (const [text, hook] of [["the lazy dog jumps over a big fox and th", undefined], [LONG, (t: FakeTab) => { t.busy = (s) => (s.params?.key === "v" && s.params.type === "rawKeyDown" ? 1000 : 0); }]] as const) {
    let flushed: Promise<void> | null = null, at = -1, done = -1;
    const r = await runVector(own([...typeCalls(text), evaluate()], PAGE(TEXTAREA())), { maxMs: 200_000, tab: (t) => {
      hook?.(t);
      // The part goes at the evaluate's arrival; the flush comes during its plan.
      const tick = () => { if (keyEvents(t).length) t.clock.timer(300, () => { at = t.clock.now(); flushed = t.stage.flush(t); void flushed?.then(() => { done = t.clock.now(); }); }); else t.clock.timer(5, tick); };
      t.clock.timer(5, tick);
    } });
    await r.clock.advance(STAGE_FLUSH_MS);
    assert.ok(flushed && done >= at && done - at <= STAGE_FLUSH_MS, `${text.length} characters: the flush ends ${Math.round(done - at)} ms after it starts`);
    assert.equal(r.tab.valueOf("n"), text, `${text.length} characters: the text once`);
    assert.equal(r.stage.counts.limitEnds, 1, `${text.length} characters: the plan ends as at the limit`);
    assert.ok(!keyEvents(r.tab).some((s) => s.t > at + 1 && s.params.text), `${text.length} characters: no key of a character after the flush`);
    assert.equal(r.stage.lock.held, 0);
  }
  // A part as the client's own keys (no clipboard; a page that takes 2 ms for each key event): at the flush the release of
  // a key whose press went, then the rest of the text as one Input.insertText (the client's 800 events would take 1.6 s).
  {
    const text = LONG.slice(0, 400);
    let flushed: Promise<void> | null = null, at = -1, done = -1;
    const r = await runVector(own([...typeCalls(text), evaluate()], { nodes: { n: TEXTAREA() }, focused: "n" }), { maxMs: 60_000, tab: (t) => {
      t.busy = (s) => (s.method === "Input.dispatchKeyEvent" ? 2 : 0);
      const tick = () => { if (keyEvents(t).length) t.clock.timer(300, () => { at = t.clock.now(); flushed = t.stage.flush(t); void flushed?.then(() => { done = t.clock.now(); }); }); else t.clock.timer(5, tick); };
      t.clock.timer(5, tick);
    } });
    await r.clock.advance(STAGE_FLUSH_MS);
    const ins = r.tab.sent.filter((s) => s.method === "Input.insertText"), keysAfter = keyEvents(r.tab).filter((s) => s.t > at + 1 && s.params.type === "keyDown");
    assert.ok(flushed && done - at <= STAGE_EVENT_WAIT_MS, `the own keys: the flush ends ${Math.round(done - at)} ms after it starts`);
    assert.equal(ins.length, 1, "the rest as one Input.insertText");
    assert.deepEqual(keysAfter.map((s) => s.params.key), [], "no keyDown after the flush");
    assert.equal(r.tab.valueOf("n"), text, "the own keys: the text once");
    assert.equal(r.stage.counts.partKeysFlushed, 1);
  }
  const n = await runVector(own([insert("abc")], PAGE()));
  assert.equal(n.stage.flush(n.tab), null, "no part: no flush");
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
    const send = (c: any) => t.queue(c.session === "child" ? "child" : undefined, c.method, c.params, (body) => { answers.push({ id: c.id, t: clock.now(), body }); for (const x of v.in) if (x.after === c.id) later(x); });
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

test("review-126 note 3: an input call on a frame's own session (an out-of-process frame) goes under the input lock: another tab's Control+V into its own frame waits while a paste has its text on the clipboard, and goes after the clear, as the client sent it, with Chrome's answer; with no other action it goes at once", async () => {
  const CTRL = { type: "rawKeyDown", modifiers: 2, windowsVirtualKeyCode: 17, code: "ControlLeft", commands: [], key: "Control", text: "", unmodifiedText: "", autoRepeat: false, location: 1, isKeypad: false };
  const V = { type: "rawKeyDown", modifiers: 2, windowsVirtualKeyCode: 86, code: "KeyV", commands: [], key: "v", text: "", unmodifiedText: "", autoRepeat: false, location: 0, isKeypad: false };
  const childKeys = (at: number) => [{ at, session: "child", method: "Input.dispatchKeyEvent", params: CTRL }, { session: "child", method: "Input.dispatchKeyEvent", params: V }];
  const r = await twoPastes([fillCall("n", LONG), insert(LONG)], childKeys(400), PAGE(INPUT({ focused: false })), PAGE(), (A) => {
    A.busy = (s) => (s.method === "Input.dispatchKeyEvent" && s.params.key === "v" && s.params.type === "rawKeyDown" ? 1000 : 0);
  });
  const hold = r.A.t.clipLog.find((x) => x.op === "hold")!, clear = r.A.t.clipLog.find((x) => x.op === "clear")!;
  const child = r.B.t.sent.filter((s) => s.child === "child" && s.method === "Input.dispatchKeyEvent");
  assert.ok(hold.t < 400 && clear.t > 400, `tab 1's text on the clipboard from ${Math.round(hold.t)} to ${Math.round(clear.t)} ms`);
  assert.equal(child.length, 2, "both frame keys go");
  assert.ok(child[0].t >= clear.t, `the frame's Control at ${Math.round(child[0].t)} ms, after the clear at ${Math.round(clear.t)} ms`);
  assert.deepEqual(child.map((s) => s.params), [CTRL, V], "as the client sent them");
  assert.ok(r.B.answers.every((x) => !x.body.error), "Chrome's answers");
  assert.equal(r.stage.counts.childInputs, 2);
  const q = await runVector(own(childKeys(0), PAGE()));
  assert.ok(q.tab.sent.filter((s) => s.child === "child").every((s) => s.t <= 1), "alone: at once");
  assert.equal(q.stage.lock.held, 0);
});

// The grant of the clipboard (the paste rule) is the model's: test/relay-stage-model.test.ts.

// ================================================================ the flush and the lock (review-126b R1 and note 5)

test("review-126b R1 (the re-check's case): tab 2 types 24 characters (it holds the input lock about 5 s); tab 1's pressSequentially into a field that has the focus (no action open); a flush (page.close()) while tab 1's part waits for the lock, and one before its gap: the part goes at once as the flush, one Input.insertText with no lock and no activation; the field holds the whole text when the flush ends (before tabs.remove); the part never types or pastes later", async () => {
  const T1 = "Thanks, see you at 10.", T2 = "the cat runs to the barn";
  for (const when of ["waits", "notGone"] as const) {
    let at = -1, done = -1, valueAtDone: string | undefined;
    const calls1 = typeCalls(T1);
    const r = await twoPastes([{ at: 500, ...calls1[0] }, ...calls1.slice(1)], [...typeCalls(T2), evaluate()], PAGE(), PAGE(), (A, _B, stage) => {
      // The flush 1 s after tab 1's part starts to wait for the lock (its gap ends RUN_IDLE_MS after its last call), or
      // 200 ms after its last call (a part that has not gone).
      const ready = () => (when === "waits" ? !!(stage as any).tabs.get(A.id)?.parting : stage.counts.collectedCalls >= calls1.length + 2 * T2.length);
      const tick = () => {
        if (!ready()) { A.clock.timer(5, tick); return; }
        A.clock.timer(when === "waits" ? 1000 : 200, () => { at = A.clock.now(); void stage.flush(A)?.then(() => { done = A.clock.now(); valueAtDone = A.valueOf("n"); }); });
      };
      A.clock.timer(5, tick);
    });
    const ins = r.A.t.sent.filter((s) => s.method === "Input.insertText");
    assert.ok(at > 0 && done >= at && done - at <= STAGE_EVENT_WAIT_MS, `${when}: the flush ends ${Math.round(done - at)} ms after it starts (no wait for tab 2's lock)`);
    assert.equal(valueAtDone, T1, `${when}: tab 1's field holds the whole text when the flush ends`);
    assert.deepEqual(ins.map((s) => s.params.text), [T1], `${when}: one Input.insertText of the whole part`);
    assert.equal(keyEvents(r.A.t).length, 0, `${when}: tab 1's part never types later`);
    assert.deepEqual([r.A.t.pastes.length, r.A.t.clipLog.filter((x) => x.op === "hold").length], [0, 0], `${when}: and never pastes`);
    assert.equal(r.A.t.activations.length, 0, `${when}: no activation of tab 1 (tab 2's action has the window)`);
    assert.equal(r.A.t.valueOf("n"), T1, `${when}: tab 1's field at the end: the text once`);
    assert.equal(r.B.t.valueOf("n"), T2, `${when}: tab 2's typed text`);
    assert.ok(keyEvents(r.B.t).length > 2 * T2.length - 4, `${when}: tab 2 typed its keys`);
    assert.deepEqual([r.stage.counts.partLockFlushed ?? 0, r.stage.counts.partsFlushed ?? 0], when === "waits" ? [1, 0] : [0, 1], `${when}: the flush ended the part's wait for the lock, or sent the part`);
    assert.equal(r.stage.lock.held, 0);
  }
});

test("review-126b R1 and C11's item 8: a part whose plan runs at a flush (typed, 25 characters) ends as at STAGE_ACTION_MAX_MS and keeps the input lock until its rest has gone: tab 2's call that waits for the lock gets it (its activation) only after tab 1's rest (one Input.insertText); the rest has its focus check (a page that moved the focus gets no rest)", async () => {
  const T1 = "see you at the barn today", T2 = "hello world";
  for (const moved of [false, true]) {
    const order: string[] = [];
    let at = -1;
    const r = await twoPastes([...typeCalls(T1), evaluate()], [{ at: 1000, ...fillCall("n", T2) }, insert(T2)], PAGE(TEXTAREA()), PAGE(INPUT({ focused: false })), (A, B, stage) => {
      const act = B.activate.bind(B);
      B.activate = async () => { order.push("tab 2's activation"); return act(); };
      A.hook = (s) => { if (s.method === "Input.insertText") order.push("tab 1's rest"); return undefined; };
      const tick = () => {
        if (!keyEvents(A).length) { A.clock.timer(5, tick); return; }
        A.clock.timer(2000, () => { at = A.clock.now(); if (moved) A.focusedId = null; void stage.flush(A); });
      };
      A.clock.timer(5, tick);
    });
    const typed = keyEvents(r.A.t).filter((s) => s.params.type === "keyDown" && s.params.text).length;
    assert.ok(at > 0 && typed > 0 && typed < T1.length, `moved ${moved}: the flush ${at} ms in, after ${typed} typed keys`);
    assert.equal(r.stage.counts.limitEnds, 1, `moved ${moved}: the plan ends as at the limit`);
    assert.equal(order[0], moved ? "tab 2's activation" : "tab 1's rest", `moved ${moved}: ${order.join(", ")}`);
    if (!moved) {
      assert.equal(order[1], "tab 2's activation", `tab 2's activation after tab 1's rest: ${order.join(", ")}`);
      assert.equal(r.A.t.valueOf("n"), T1, "tab 1's field: the whole text once");
    } else {
      assert.equal(r.stage.counts.typedTextsCut, 1, "a page that moved the focus: the rest does not go (its focus check)");
      assert.ok(!order.includes("tab 1's rest"), "no rest");
    }
    assert.equal(r.B.t.valueOf("n"), T2, `moved ${moved}: tab 2's text`);
    assert.equal(r.stage.lock.held, 0);
  }
});

test("review-126b R1: a running part's rest that waits for the lock again (its plan ended at STAGE_EVENT_WAIT_MS and tab 2's part took the lock) goes on at once at a flush, with no lock and no focus check (the window's focus is not known with no activation): a typed part and a pasted one; the field holds the whole text within STAGE_EVENT_WAIT_MS of the flush", async () => {
  const T2 = "the cat runs to the barn";
  for (const [T1, busyKey] of [["see you at the barn today", 5], [LONG, 0]] as const) {
    let at = -1, done = -1, valueAtDone: string | undefined, k = 0;
    const r = await twoPastes([...typeCalls(T1), evaluate()], [{ at: 500, ...typeCalls(T2)[0] }, ...typeCalls(T2).slice(1), evaluate()], PAGE(TEXTAREA({ windowAway: true })), PAGE(INPUT()), (A, _B, stage) => {
      // Tab 1's page is busy 3 s at its 5th typed key, or at V: the plan ends at STAGE_EVENT_WAIT_MS, and tab 2's part takes the lock.
      A.busy = (s) => (s.method === "Input.dispatchKeyEvent" && (busyKey ? s.params.type === "keyDown" && ++k === busyKey : s.params.key === "v" && s.params.type === "rawKeyDown") ? 3000 : 0);
      const tick = () => {
        if (!stage.counts.waitEnds) { A.clock.timer(5, tick); return; }
        // Tab 2's action took the window's focus: tab 1's focus check would fail now.
        A.clock.timer(1500, () => { at = A.clock.now(); A.windowFocus = false; void stage.flush(A)?.then(() => { done = A.clock.now(); valueAtDone = A.valueOf("n"); }); });
      };
      A.clock.timer(5, tick);
    });
    const what = busyKey ? "typed" : "pasted";
    assert.ok(at > 0 && done >= at && done - at <= STAGE_EVENT_WAIT_MS, `${what}: the flush ends ${Math.round(done - at)} ms after it starts (no wait for tab 2's lock)`);
    assert.equal(valueAtDone, T1, `${what}: tab 1's field holds the whole text when the flush ends`);
    assert.equal(r.stage.counts.partLockFlushed, 1, `${what}: the flush ended the rest's wait for the lock`);
    assert.equal((r.stage.counts.typedTextsCut ?? 0) + (r.stage.counts.pastesCut ?? 0), 0, `${what}: no focus check: the rest went`);
    assert.equal(r.B.t.valueOf("n"), T2, `${what}: tab 2's typed text`);
    assert.equal(r.stage.lock.held, 0);
  }
});

// ================================================================ no input event with no lock while a text is on the selection (review-126b R2 and notes 2 to 4)

const FRAME_CTRL = { type: "rawKeyDown", modifiers: 2, windowsVirtualKeyCode: 17, code: "ControlLeft", commands: [], key: "Control", text: "", unmodifiedText: "", autoRepeat: false, location: 1, isKeypad: false };
const FRAME_V = { type: "rawKeyDown", modifiers: 2, windowsVirtualKeyCode: 86, code: "KeyV", commands: [], key: "v", text: "", unmodifiedText: "", autoRepeat: false, location: 0, isKeypad: false };
const frameKeys = (at: number) => [{ at, session: "child", method: "Input.dispatchKeyEvent", params: FRAME_CTRL }, { at, session: "child", method: "Input.dispatchKeyEvent", params: FRAME_V }];
/** The input events of tab `t` that went while the shared clipboard (its log on `clip`) held a text. */
const onSelection = (clip: FakeTab, t: FakeTab): Sent[] => {
  const spans: [number, number][] = [];
  let from = -1;
  for (const x of clip.clipLog) {
    if (x.op === "hold" && from < 0) from = x.t;
    if (x.op === "clear" && from >= 0) { spans.push([from, x.t]); from = -1; }
  }
  return t.sent.filter((s) => s.method.startsWith("Input.") && spans.some(([a, b]) => s.t >= a && s.t <= b));
};
const busyV = (t: FakeTab, ms: number) => { t.busy = (s) => (s.method === "Input.dispatchKeyEvent" && s.params.key === "v" && s.params.type === "rawKeyDown" ? ms : 0); };

test("review-126b R2: an ended input call on a frame's own session goes as an ended plan's events go: tab 2's key to its busy main frame ends its plan at STAGE_EVENT_WAIT_MS, and its frame's Control and V, which wait in its gate, take the input lock again (tab 1's paste holds it): no frame key goes while tab 1's text is on the clipboard; after the clear they go, as the client sent them, with Chrome's answers", async () => {
  const r = await twoPastes([{ at: 1, ...fillCall("n", LONG) }, insert(LONG)], [{ at: 0, ...TAB[0] }, ...frameKeys(0)], PAGE(INPUT({ focused: false })), PAGE(), (_A, B) => {
    B.busy = (s) => (!s.child && s.method === "Input.dispatchKeyEvent" && s.params.key === "Tab" ? 10_000 : 0);
  });
  const hold = r.A.t.clipLog.find((x) => x.op === "hold")!, clear = r.A.t.clipLog.find((x) => x.op === "clear")!;
  const child = r.B.t.sent.filter((s) => s.child === "child");
  assert.ok(hold && hold.t >= STAGE_EVENT_WAIT_MS, `tab 1's text on the clipboard at ${Math.round(hold?.t)} ms, after tab 2's plan ended`);
  assert.equal(child.length, 2, "both frame keys go");
  assert.deepEqual(onSelection(r.A.t, r.B.t).map((s) => `${s.child ?? "main"} ${s.params.type} ${s.params.key}`), [], "no event of tab 2 while tab 1's text is on the clipboard");
  assert.ok(child[0].t >= clear.t, `the frame's Control at ${Math.round(child[0].t)} ms, after the clear at ${Math.round(clear.t)} ms`);
  assert.deepEqual(child.map((s) => s.params), [FRAME_CTRL, FRAME_V], "as the client sent them");
  assert.ok(r.B.answers.filter((x) => x.id > 1).every((x) => !x.body.error), "Chrome's answers");
  assert.equal(r.A.t.valueOf("n"), LONG);
  assert.equal(r.stage.lock.held, 0);
});

test("review-126b R2: an ended input call on a frame's own session waits for the dialog's close, as an ended plan's events do: a keydown handler's alert at the tab's Tab key; the frame's Control and V, which wait in its gate, go after the close with the lock taken again, and Chrome takes them", async () => {
  const r = await runVector(own([{ at: 0, ...TAB[0] }, ...frameKeys(0), ANSWER(500)], PAGE()), { tab: (t) => dialogAt(t, 1, "Tab") });
  const close = r.tab.sent.find((s) => s.method === "Page.handleJavaScriptDialog")!.t, child = r.tab.sent.filter((s) => s.child === "child");
  assert.equal(child.length, 2, "both frame keys go");
  assert.ok(child.every((s) => s.t >= close && !s.dropped), `the frame keys at ${child.map((s) => Math.round(s.t)).join(", ")} ms (${child.map((s) => (s.dropped ? "dropped" : "taken")).join(", ")}), after the close at ${Math.round(close)} ms`);
  assert.deepEqual(child.map((s) => s.params), [FRAME_CTRL, FRAME_V], "as the client sent them");
  assert.ok([2, 3].every((id) => !answerOf(r, id).body.error), "Chrome's answers");
  await r.clock.advance(2000);
  assert.equal(r.stage.lock.held, 0);
});

test("review-126b R2: a dropped input call on a frame's own session that waits for the input lock (tab 1's paste holds it): at the end of the client's session it never goes and gets no answer; at the tab's end it goes to Chrome as the client sent it and gets Chrome's error for a closed target", async () => {
  for (const why of ["session", "tab"] as const) {
    const r = await twoPastes([fillCall("n", LONG), insert(LONG)], frameKeys(300), PAGE(INPUT({ focused: false })), PAGE(), (A, B, stage) => {
      busyV(A, 1500);
      A.clock.timer(600, () => { if (why === "tab") B.closed = true; stage.drop(B.id, why); });
    }, 30_000);
    const clear = r.A.t.clipLog.find((x) => x.op === "clear")!, child = r.B.t.sent.filter((s) => s.child === "child");
    assert.ok(clear.t > 600, `${why}: tab 1's paste holds the lock at the drop (its clear at ${Math.round(clear.t)} ms)`);
    assert.deepEqual(onSelection(r.A.t, r.B.t), [], `${why}: no event of tab 2 while tab 1's text is on the clipboard`);
    if (why === "session") {
      assert.deepEqual(child, [], "session: no frame key goes after the session's end");
      assert.deepEqual(r.B.answers, [], "session: nothing goes back");
    } else {
      assert.deepEqual(child.map((s) => s.params), [FRAME_CTRL, FRAME_V], "tab: as the client sent them");
      assert.ok(r.B.answers.length === 2 && r.B.answers.every((x) => x.body.error), `tab: Chrome's errors: ${JSON.stringify(r.B.answers.map((x) => x.body))}`);
    }
    assert.equal(r.A.t.valueOf("n"), LONG, `${why}: tab 1's paste`);
    assert.equal(r.stage.lock.held, 0);
  }
});

test("review-126b R2, the flush's exception (C11): the flush takes no lock, so its events can go while another tab's paste has its text on the clipboard; they are only one Input.insertText and printable keys with no modifiers and no commands, which cannot paste", async () => {
  const T1 = "Thanks, see you at 10.", calls1 = typeCalls(T1);
  let at = -1;
  const r = await twoPastes([{ at: 300, ...calls1[0] }, ...calls1.slice(1)], [fillCall("n", LONG), insert(LONG)], PAGE(), PAGE(INPUT({ focused: false })), (A, B, stage) => {
    busyV(B, 1500);
    const tick = () => {
      if (!((stage as any).tabs.get(A.id)?.parting && A.clipText !== null)) { A.clock.timer(5, tick); return; }
      at = A.clock.now();
      void stage.flush(A);
    };
    A.clock.timer(5, tick);
  });
  const during = onSelection(r.A.t, r.A.t);
  assert.ok(at > 0, "the flush while tab 2's text is on the clipboard");
  assert.ok(during.length >= 1, `tab 1's flush goes while the text is on the clipboard (${during.length} events)`);
  for (const s of during) assert.ok(s.method === "Input.insertText" || (s.method === "Input.dispatchKeyEvent" && !s.params.modifiers && !(s.params.commands ?? []).length), `${s.method} ${JSON.stringify(s.params).slice(0, 80)}: no modifiers and no commands`);
  assert.equal(r.A.t.valueOf("n"), T1, "tab 1's field: its text");
  assert.equal(r.B.t.valueOf("n"), LONG, "tab 2's field: its own text");
  assert.deepEqual(r.B.t.pastes.map((x) => x.len), [2500], "tab 2's paste");
  assert.equal(r.stage.lock.held, 0);
});

test("review-126b note 4: an error of an input call on a frame's own session fails only that call (as with no stage): the tab's main-session key calls that wait in its gate go and get Chrome's answers", async () => {
  const r = await runVector(own([{ at: 0, session: "child", method: "Input.dispatchKeyEvent", params: FRAME_CTRL }, { at: 0, ...TAB[0] }, { at: 0, ...TAB[1] }], PAGE()), {
    hook: (s) => (s.child === "child" ? Promise.reject(Object.assign(new Error("Cannot find context with specified id"), { code: -32000 })) : undefined) });
  const a1 = answerOf(r, 1);
  assert.ok(a1.body.error && /context/.test(a1.body.error.message), `the frame's call gets Chrome's error: ${JSON.stringify(a1.body)}`);
  for (const id of [2, 3]) assert.ok(!answerOf(r, id).body.error, `the main-session call ${id} gets Chrome's answer: ${JSON.stringify(answerOf(r, id).body)}`);
  assert.deepEqual(keyEvents(r.tab).filter((s) => !s.child).map((s) => [s.params.type, s.params.key]), [["rawKeyDown", "Tab"], ["keyUp", "Tab"]], "the main-session keys go");
  assert.equal(r.stage.counts.eventErrors ?? 0, 0, "no plan stops");
  // The key run ends 1 s after its last key (C11, the input lock): then the lock is free.
  await r.clock.advance(2000);
  assert.equal(r.stage.lock.held, 0);
});

test("review-126b note 2: an error answer of V is not its answer (Chrome can still run its paste): the paste path stays closed until V's tab ends or its main frame navigates, also when the error comes after the end of the client's session (the stage then keeps no state of the tab); logged and counted", async () => {
  const L2 = LONG.toUpperCase(), L3 = LONG.replace(/ /g, "_");
  const vErr = (A: FakeTab, ms: number) => {
    A.hook = (s) => (s.method === "Input.dispatchKeyEvent" && s.params.key === "v" && s.params.type === "rawKeyDown"
      ? A.clock.sleep(ms).then(() => { throw Object.assign(new Error("Detached while handling command."), { code: -32000 }); }) : undefined);
  };
  for (const end of ["navigation", "tab's end"] as const) {
    const r = await twoPastes([fillCall("n", LONG), insert(LONG)], [{ at: 3000, ...fillCall("n", L2) }, insert(L2), { at: 9000, ...fillCall("n", L3) }, insert(L3)], PAGE(INPUT({ focused: false })), PAGE(INPUT({ focused: false })), (A, _B, stage) => {
      if (end === "navigation") { vErr(A, 300); A.clock.timer(6000, () => A.navigate()); }
      else { vErr(A, 1500); A.clock.timer(1000, () => stage.drop(A.id, "session")); A.clock.timer(6000, () => stage.drop(A.id, "tab")); }
    }, 30_000);
    assert.deepEqual(r.B.t.pastes.map((x) => x.len), [2500], `${end}: tab 2's text at 3 s goes as Playwright's own input (no paste); its text at 9 s, after the ${end}, is a paste`);
    assert.equal(r.stage.counts.vErrors, 1, `${end}: the stage counts V's error`);
    assert.ok((r.stage.counts["noPaste:vPending"] ?? 0) >= 1, `${end}: counted`);
    assert.equal(r.B.t.valueOf("n"), L3);
    assert.ok(r.logs.some((l) => l.includes("an error answer of the paste's V")), `${end}: logged`);
    assert.equal(r.stage.lock.held, 0);
  }
});

test("review-126b note 2: an error of V that comes after its tab's end (Chrome fails a pending command of a closed tab) closes nothing: tab 2's long text after it is a paste", async () => {
  const L2 = LONG.toUpperCase();
  const r = await twoPastes([fillCall("n", LONG), insert(LONG)], [{ at: 3000, ...fillCall("n", L2) }, insert(L2)], PAGE(INPUT({ focused: false })), PAGE(INPUT({ focused: false })), (A, _B, stage) => {
    A.hook = (s) => (s.method === "Input.dispatchKeyEvent" && s.params.key === "v" && s.params.type === "rawKeyDown"
      ? new Promise((_r, no) => { A.clock.timer(1000, () => { A.closed = true; stage.drop(A.id, "tab"); }); A.clock.timer(1200, () => no(Object.assign(new Error("No target with given id found"), { code: -32602 }))); }) : undefined);
  }, 30_000);
  assert.deepEqual(r.B.t.pastes.map((x) => x.len), [2500], "tab 2's text at 3 s is a paste");
  assert.equal(r.stage.counts.vErrors ?? 0, 0, "the late error is not counted");
  assert.equal(r.B.t.valueOf("n"), L2);
  assert.equal(r.stage.lock.held, 0);
});

test("RUN_IDLE_MS is the gap that ends a collected part (C11, the collected keys), and CLIPBOARD_HOLD_MS the stage's wait for the clipboard's owner", () => {
  assert.deepEqual([RUN_IDLE_MS, CLIPBOARD_HOLD_MS], [1000, 500]);
});

// ================================================================ a secret never goes through the clipboard (board ab-t30.22)

/** The client's mark of a secret (C11, the paste): AgentBrowser.setSecretInput on the tab's own session. */
const mark = (enabled: boolean) => ({ method: "AgentBrowser.setSecretInput", params: { enabled } });
/** The Input.insertText calls that carry exactly `text`. */
const insertsOf = (t: FakeTab, text: string) => t.sent.filter((s) => s.method === "Input.insertText" && s.params.text === text);
const typedText = (t: FakeTab) => keyEvents(t).filter((s) => s.params.text).map((s) => s.params.text).join("");
const SHORT_SECRET = "test-secret-1";

test("board ab-t30.22, the field rule (C11, the paste, rule 7): no paste into a password field or a field whose autocomplete has current-password, new-password or one-time-code: a long fill and a long collected part each go as one Input.insertText of the text, counted, with no clipboard call; a short one is typed; a field with another autocomplete still pastes", async () => {
  const cases: [string, any][] = [
    ["a password field", INPUT({ type: "password" })],
    ["autocomplete current-password", INPUT({ autocomplete: "current-password" })],
    ["autocomplete new-password in a section", INPUT({ autocomplete: "section-signup new-password" })],
    ["autocomplete one-time-code (a tel field)", INPUT({ type: "tel", autocomplete: "one-time-code" })],
    ["a textarea with One-Time-Code", TEXTAREA({ autocomplete: "One-Time-Code" })],
  ];
  for (const [name, node] of cases) {
    const f = await runVector(own([insert(LONG)], PAGE(node)));
    assert.deepEqual([insertsOf(f.tab, LONG).length, f.stage.counts["noPaste:secretField"], f.tab.clipLog.length, f.tab.pastes.length, f.tab.fields.get("n")?.value], [1, 1, 0, 0, LONG], `${name}: the fill's text as one Input.insertText, no clipboard call`);
    const p = await runVector(own([...typeCalls(MID + MID), evaluate()], PAGE(node)));
    assert.deepEqual([insertsOf(p.tab, MID + MID).length, typedText(p.tab), p.stage.counts["partsAsText:secretField"], p.tab.clipLog.length, p.tab.fields.get("n")?.value], [1, "", 1, 0, MID + MID], `${name}: the part as one Input.insertText of its text, no key event of it`);
    assert.ok(p.tab.sent.findIndex((x) => x.method === "Runtime.evaluate" && x.params.expression === "1") > p.tab.sent.indexOf(insertsOf(p.tab, MID + MID)[0]), `${name}: the next call after the part's text`);
    const s = await runVector(own([insert(SHORT_SECRET)], PAGE(node)));
    assert.deepEqual([typedText(s.tab), insertsOf(s.tab, SHORT_SECRET).length, s.tab.clipLog.length], [SHORT_SECRET, 0, 0], `${name}: a short text is typed`);
  }
  const plain = await runVector(own([insert(LONG)], PAGE(INPUT({ autocomplete: "username" }))));
  assert.deepEqual([plain.tab.pastes.length, plain.stage.counts["noPaste:secretField"]], [1, undefined], "a field with autocomplete username pastes");
});

test("board ab-t30.22, the client's mark (C11, the paste, rule 8: AgentBrowser.setSecretInput): the stage answers it with {} and sends nothing to Chrome; while it is on, a long fill and a long collected part into a plain field go as one Input.insertText each, with no clipboard call; a short text is typed; the mark holds until enabled false, whose step ends the key run first, so the part before it goes with the mark on", async () => {
  const f = await runVector(own([mark(true), insert(LONG)], PAGE()));
  assert.deepEqual(answerOf(f, 1).body, { result: {} });
  assert.ok(!f.tab.sent.some((s) => s.method.startsWith("AgentBrowser.")), "the mark never reaches Chrome");
  assert.deepEqual([insertsOf(f.tab, LONG).length, f.stage.counts["noPaste:secretMark"], f.tab.clipLog.length, f.tab.pastes.length], [1, 1, 0, 0], "the fill's text as one Input.insertText");
  const keys = typeCalls(MID + MID);
  const p = await runVector(own([mark(true), ...keys, mark(false), insert(LONG)], PAGE()));
  assert.deepEqual([insertsOf(p.tab, MID + MID).length, p.stage.counts["partsAsText:secretMark"]], [1, 1], "the part before the mark's end as one Input.insertText");
  assert.ok(answerOf(p, keys.length + 2).n > p.tab.sent.indexOf(insertsOf(p.tab, MID + MID)[0]), "the end of the mark answers after the part's text went");
  assert.deepEqual([p.tab.pastes.length, p.tab.fields.get("n")?.value], [1, MID + MID + LONG], "after the mark's end a long text pastes again");
  const s = await runVector(own([mark(true), insert(SHORT_SECRET)], PAGE()));
  assert.deepEqual([typedText(s.tab), s.tab.clipLog.length], [SHORT_SECRET, 0], "a short text is typed");
});

test("board ab-t30.22: a mark whose step runs after the tab's end (it waited in the tab's gate behind a paste) gets {} and never reaches Chrome", async () => {
  const r = await runVector(own([{ ...insert(LONG), at: 0 }, { ...mark(true), at: 0 }], PAGE()), { tab: (t) => { t.clock.timer(1, () => t.stage.drop(t.id, "tab")); } });
  assert.deepEqual(answerOf(r, 2).body, { result: {} });
  assert.ok(!r.tab.sent.some((s) => s.method.startsWith("AgentBrowser.")), "the mark never reaches Chrome");
});
