// The operator's answer on board item ab-pf8, built in the input stage (board ab-t30.18; the input design's open points 1
// and 2, section 16; C11 "The input stage", the focus click). Case 1: a field whose click opens a panel (a date picker, a
// combobox) gets no focus click: before the click the stage reads the field's widget signs (the role combobox, also on an
// element around it, aria-haspopup, aria-expanded, aria-autocomplete list or both, an input's list, and a listener of the
// page's own scripts on the field for the events of a click), and Playwright's script focus goes as the client sent it,
// counted. After each focus click the stage counts the new elements that cover the area near the field (count only: no
// Escape and no other input). Case 2 (a tag input): no change; the named exception and the value check stay.
//
// The stage's tests run on the fake Chrome of stage-fakes.ts (no browser, a fake clock); the page-side texts (the field's
// signs in FIELD_STATE, the cover read) run here as the page runs them, in a context of their own (node:vm), on a small
// model of a DOM.

import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { charKey } from "../src/human/keys.ts";
import { GEOMETRY_WAIT_MS } from "../src/relay/pointer.ts";
import { COVER_AFTER, COVER_BEFORE, COVER_CLEAR, FIELD_ELEMENT, FIELD_STATE, RUN_IDLE_MS, STAGE_ACTION_MAX_MS, STAGE_GROUP } from "../src/relay/stage.ts";
import { runVector, type FakeTab, type Sent } from "./stage-fakes.ts";

const V = JSON.parse(readFileSync(new URL("./vectors/stage.json", import.meta.url), "utf8"));
const vec = (id: string) => structuredClone(V.vectors.find((x: any) => x.id === id));

// ---------------------------------------------------------------- the client's calls, as Playwright sends them

const kd = (ch: string) => { const k = charKey(ch)!; return { method: "Input.dispatchKeyEvent", params: { type: "keyDown", modifiers: 0, windowsVirtualKeyCode: k.keyCode, code: k.code, commands: [], key: k.key, text: ch, unmodifiedText: ch, autoRepeat: false, location: 0, isKeypad: false } }; };
const ku = (ch: string) => { const k = charKey(ch)!; return { method: "Input.dispatchKeyEvent", params: { type: "keyUp", modifiers: 0, key: k.key, windowsVirtualKeyCode: k.keyCode, code: k.code, location: 0, isKeypad: false } }; };
const typeCalls = (text: string) => [...text].flatMap((ch) => [kd(ch), ku(ch)]);
const insert = (text: string) => ({ method: "Input.insertText", params: { text } });
const FILL_FN = vec("fill").in[0].params.arguments[3].value, FOCUS_FN = vec("press-sequentially").in[0].params.arguments[3].value;
const util = (fn: string, arg: unknown, node: string, session?: string) => ({ method: "Runtime.callFunctionOn", ...(session ? { session } : {}),
  params: { functionDeclaration: "(utilityScript, ...args) => utilityScript.evaluate(...args)", objectId: "7.3.1", returnByValue: true, awaitPromise: true, userGesture: true,
    arguments: [{ objectId: "7.3.1" }, { value: true }, { value: true }, { value: fn }, { value: 1 }, { value: { a: [{ h: 0 }, { h: 1 }, arg] } }, { objectId: "7.3.2" }, { objectId: node }] } });
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
const TEXTAREA = (o: object = {}) => ({ tag: "textarea", box: { x: 200, y: 300, width: 400, height: 90 }, text: 0, focused: false, ...o });
const mouseEvents = (t: FakeTab) => t.sent.filter((s) => s.method === "Input.dispatchMouseEvent" && s.pass === undefined);
const keyEvents = (t: FakeTab) => t.sent.filter((s) => s.method === "Input.dispatchKeyEvent" && s.pass === undefined);
const inputEvents = (t: FakeTab) => t.sent.filter((s) => s.method.startsWith("Input.") && s.pass === undefined);
const pressOf = (t: FakeTab) => mouseEvents(t).find((s) => s.params.type === "mousePressed");
const fnOf = (s: Sent) => (s.params as any)?.functionDeclaration;
/** The stage's trace lines of the field (C10's log rule: no point, no key, no text). */
const fieldLines = (logs: string[]) => logs.map((l) => l.replace(/^relay: the input stage: tab \d+: /, "")).filter((l) => /^(a focus click|no focus click)/.test(l));

/** The calls of the two recognizers of a field: Playwright's focus call (pressSequentially, with its caret reset) and its keys; fill and its text. */
const CALLS: [string, (n: string) => any[], string | null][] = [
  ["Playwright's focus call (pressSequentially)", (n) => [focusCall(n, true), ...typeCalls("blue")], "blue"],
  ["fill", (n) => [fillCall(n, "2026-11-12"), insert("2026-11-12")], "2026-11-12"],
];

// ================================================================ case 1: the widget signs (the operator's answer, ab-pf8)

test("ab-pf8 case 1: a field with a widget sign gets no focus click: Playwright's script focus goes as the client sent it, in the same action (one activation), and the keys or the text after it go as before; counted focusWidget and its sign, with a trace line", async () => {
  const signs: [string, object][] = [
    ["combobox", { widget: "combobox" }],
    ["haspopup", { widget: "haspopup" }],
    ["expanded", { widget: "expanded" }],
    ["autocomplete", { widget: "autocomplete" }],
    ["list", { widget: "list" }],
    ["comboboxAround", { widget: "comboboxAround" }],
    ["listener (click)", { listeners: ["click"] }],
    ["listener (click, with others)", { listeners: ["keydown", "click", "mousedown"] }],
  ];
  for (const [name, facts] of signs) for (const [call, calls, value] of CALLS) {
    const sign = name.startsWith("listener") ? "listener" : name;
    const r = await runVector(own(calls("n"), { nodes: { n: INPUT(facts) } }), { trace: true });
    assert.equal(mouseEvents(r.tab).length, 0, `${name}, ${call}: no click`);
    assert.equal(r.tab.sent.filter((s) => s.pass === 1).length, 1, `${name}, ${call}: the utility call goes as the client sent it`);
    assert.equal(r.stage.counts.focusWidget, 1, `${name}, ${call}: counted focusWidget`);
    assert.equal(r.stage.counts[`focusWidget:${sign}`], 1, `${name}, ${call}: counted its sign`);
    assert.equal(r.stage.counts.focusClicks, undefined, `${name}, ${call}: no focus click counted`);
    assert.equal(r.tab.activations.length, 1, `${name}, ${call}: one action for the focus call and what follows it`);
    assert.equal(r.tab.valueOf("n"), value, `${name}, ${call}: the text in the field`);
    assert.ok(keyEvents(r.tab).length >= 8, `${name}, ${call}: the keys go as a person's keys`);
    assert.deepEqual(fieldLines(r.logs), [`no focus click (focusWidget: ${sign})`], `${name}, ${call}: the trace line names the sign, no point`);
  }
});

test("ab-pf8 case 1: no sign, the focus click as before: a listener of another event (mousedown, mouseup, pointerdown, pointerup, dblclick, keydown, input, focus, blur, change, keyup, focusin), a listener of Playwright's utility world (not the page's), a listener of a child of the field (another node), and a field with no fact", async () => {
  const none: [string, object][] = [
    ["no fact", {}],
    // A field whose page counts its presses (a mousedown listener, as an analytics or a bot check's script can) opens nothing
    // (the live rows' frame field): only a click listener is a sign.
    ...["mousedown", "mouseup", "pointerdown", "pointerup", "dblclick", "keydown", "input", "focus", "blur", "change", "keyup", "focusin"].map((t): [string, object] => [`a ${t} listener`, { listeners: [t] }]),
    ["a click listener of Playwright's utility world", { listeners: [{ type: "click", world: "utility" }] }],
    ["a click listener of a child of the field", { childListeners: ["click", "mousedown"] }],
  ];
  for (const [name, facts] of none) for (const [call, calls, value] of CALLS) {
    const r = await runVector(own(calls("n"), { nodes: { n: INPUT(facts) } }));
    assert.ok(pressOf(r.tab), `${name}, ${call}: the focus click`);
    assert.equal(r.stage.counts.focusClicks, 1, `${name}, ${call}`);
    assert.equal(r.stage.counts.focusWidget, undefined, `${name}, ${call}: no focusWidget`);
    assert.equal(r.tab.valueOf("n"), value, `${name}, ${call}`);
  }
  // review-123 note 5: a click listener of an element around the field (a delegated listener, as a page's framework puts it
  // on its root), also when the reply holds it with its own backendNodeId, is not the field's.
  const wrap = await runVector(own([fillCall("n", "x"), insert("x")], { nodes: { n: INPUT({ aroundListeners: ["click"] }), wrap: { tag: "div", box: { x: 0, y: 0, width: 1280, height: 720 }, listeners: ["click"] } } }));
  assert.ok(pressOf(wrap.tab) && wrap.stage.counts.focusWidget === undefined, "a listener of an element around the field: the click");
});

test("ab-pf8 case 1: the read of the page's listeners: the field's element as a handle (FIELD_ELEMENT, the stage's group), DOM.describeNode, DOM.resolveNode into the page's main world, DOMDebugger.getEventListeners there with no pierce, the field's own backendNodeId only; the group is released; none when a sign of the field's read decides", async () => {
  const r = await runVector(own([fillCall("n", "x"), insert("x")], { nodes: { n: INPUT({ listeners: ["click"] }) } }));
  const reads = r.tab.sent.filter((s) => s.read);
  const el = reads.findIndex((s) => fnOf(s) === FIELD_ELEMENT), desc = reads.findIndex((s) => s.method === "DOM.describeNode"), res = reads.findIndex((s) => s.method === "DOM.resolveNode"),
    lis = reads.findIndex((s) => s.method === "DOMDebugger.getEventListeners"), rel = reads.findIndex((s, i) => i > lis && s.method === "Runtime.releaseObjectGroup");
  assert.ok(el >= 0 && el < desc && desc < res && res < lis && lis < rel, "the order of the reads");
  assert.deepEqual([reads[el].params.objectId, (reads[el].params as any).returnByValue, (reads[el].params as any).objectGroup], ["n", false, STAGE_GROUP], "the handle of the field's element, in the stage's group");
  assert.equal((reads[desc].params as any).objectId, "field:n");
  assert.equal((reads[res].params as any).executionContextId, undefined, "the page's main world");
  assert.deepEqual([(reads[lis].params as any).objectId, (reads[lis].params as any).pierce], ["mainfield:n", false], "the main world's handle, no pierce");
  assert.equal((reads[rel].params as any).objectGroup, STAGE_GROUP);
  // A sign of the field's read decides with no read of the listeners; so does a field with the focus, or a button.
  for (const [name, node, focused] of [["a sign of the read", INPUT({ widget: "combobox" }), null], ["a field with the focus", INPUT({ text: 3, focused: true, listeners: ["click"] }), "n"], ["a button", { tag: "button", box: { x: 200, y: 300, width: 120, height: 30 }, listeners: ["click"] }, null]] as const) {
    const q = await runVector(own([fillCall("n", "x")], { nodes: { n: node }, focused }));
    assert.ok(!q.tab.sent.some((s) => s.method === "DOMDebugger.getEventListeners" || fnOf(s) === FIELD_ELEMENT), `${name}: no read of the listeners`);
  }
});

test("ab-pf8 case 1: the order of the rules: a field with the focus (fieldFocused), a disabled or read-only field, a button and an email input with text keep their counts; the sign comes after the focus test and, for fill, after the activation and the read again", async () => {
  const cases: [string, any, any, string][] = [
    ["focused", INPUT({ text: 3, focused: true, widget: "combobox" }), "n", "fieldFocused"],
    ["disabled", INPUT({ text: 3, disabled: true, widget: "combobox" }), null, "fieldDisabled"],
    ["read-only", INPUT({ text: 3, readOnly: true, listeners: ["click"] }), null, "fieldReadOnly"],
    ["a button", { tag: "button", box: { x: 200, y: 300, width: 120, height: 30 }, widget: "haspopup" }, null, "fieldNotText"],
  ];
  for (const [name, node, focused, count] of cases) for (const call of [fillCall("n", "x"), focusCall("n", true)]) {
    const r = await runVector(own([call], { nodes: { n: node }, focused }));
    assert.equal(r.stage.counts[count], 1, `${name}: ${count}`);
    assert.equal(r.stage.counts.focusWidget, undefined, `${name}: not focusWidget`);
  }
  const email = await runVector(own([focusCall("n", true)], { nodes: { n: INPUT({ type: "email", value: "a@b.co", caret: [6, 6], widget: "list" }) } }));
  assert.equal(email.stage.counts.focusNoCaret, 1);
  // fill on a widget field that is the active element of a document with no focus: the activation, the read again, then no click.
  const away = await runVector(own([fillCall("n", "x"), insert("x")], { nodes: { n: INPUT({ text: 3, windowAway: true, windowStaysAway: true, widget: "combobox" }) }, focused: "n" }));
  assert.equal(away.tab.activations.length, 1);
  assert.equal(away.tab.sent.filter((s) => fnOf(s) === FIELD_STATE).length, 2, "the read, and the read again after the activation");
  assert.equal(away.stage.counts.focusWidget, 1);
  assert.equal(mouseEvents(away.tab).length, 0);
});

test("ab-pf8 case 1: a read of the listeners that does not answer: no click (the read fails open), counted fieldNoRead; the utility call goes within the read's limit", async () => {
  for (const method of ["DOMDebugger.getEventListeners", "DOM.describeNode", "DOM.resolveNode"]) {
    const r = await runVector(own([fillCall("n", "abc"), insert("abc")], { nodes: { n: INPUT() } }), { hook: (s) => (s.method === method ? new Promise(() => {}) : undefined) });
    assert.equal(mouseEvents(r.tab).length, 0, `${method}: no click`);
    assert.equal(r.stage.counts.fieldNoRead, 1, `${method}: counted`);
    const read = r.tab.sent.find((s) => s.method === method)!, pass = r.tab.sent.find((s) => s.pass === 1)!;
    assert.ok(pass.t - read.t >= GEOMETRY_WAIT_MS && pass.t - read.t <= GEOMETRY_WAIT_MS + 5, `${method}: the call goes at the read's limit`);
    assert.equal(r.tab.valueOf("n"), "abc", `${method}: the text`);
  }
});

test("ab-pf8 case 1: a widget field out of view gets no notches and no click: Playwright's script focus scrolls it, as Playwright's own input does", async () => {
  for (const [name, facts] of [["combobox", { widget: "combobox" }], ["listener", { listeners: ["click"] }]] as const) {
    const r = await runVector(own([fillCall("n", "ab"), insert("ab")], { last: { x: 640, y: 360 }, nodes: { n: INPUT({ text: 3, box: { x: 200, y: 2400, width: 300, height: 30 }, ...facts }) }, scrollers: { document: { scrollY: 0, height: 4000 } } }));
    assert.equal(inputEvents(r.tab).filter((s) => s.method === "Input.dispatchMouseEvent").length, 0, `${name}: no wheel, no path, no click`);
    assert.ok(!r.tab.sent.some((s) => s.method === "DOM.scrollIntoViewIfNeeded"), name);
    assert.equal(r.stage.counts.focusWidget, 1, name);
    assert.equal(r.stage.counts.focusNotches, undefined, name);
  }
});

test("ab-pf8 case 1: a field in a cross-origin frame with a listener sign: the reads on the frame's session; no click on the top page", async () => {
  const page = { nodes: { n: { tag: "input", type: "text", frame: "xf", box: { x: 20, y: 30, width: 200, height: 30 }, text: 0, focused: false, listeners: ["click"] } },
    frames: { xf: { origin: "cross", box: { x: 460, y: 560, width: 300, height: 120 }, border: 3, padding: 4 } } };
  const r = await runVector(own([fillCall("n", "Card 4242", "child"), insert("Card 4242")], page));
  for (const m of ["DOM.describeNode", "DOM.resolveNode", "DOMDebugger.getEventListeners"]) assert.equal(r.tab.sent.find((s) => s.method === m)?.child, "child", `${m} on the frame's session`);
  assert.equal(mouseEvents(r.tab).length, 0);
  assert.equal(r.stage.counts["focusWidget:listener"], 1);
  assert.equal(r.tab.valueOf("n"), "Card 4242");
});

// ================================================================ case 1: the new covering elements after a focus click

/** A panel that a press on the field opens, under it (a date picker's calendar), and the button that it covers. */
const PANEL = (o: object = {}) => ({ tag: "div", box: { x: 200, y: 332, width: 280, height: 200 }, opensAt: "n", ...o });

test("ab-pf8 case 1: after a focus click the stage counts each new element that covers the area near the field (focusNewCovers, focusClicksCovering, a trace line with the count only), and sends no input of its own for it: no Escape, no other click", async () => {
  const r = await runVector(own([fillCall("n", "2026"), insert("2026")], { nodes: { n: INPUT(), panel: PANEL() } }), { trace: true });
  assert.ok(pressOf(r.tab), "the focus click (no sign)");
  assert.equal(r.stage.counts.focusNewCovers, 1, "one new covering element");
  assert.equal(r.stage.counts.focusClicksCovering, 1);
  assert.deepEqual(fieldLines(r.logs).filter((l) => /new covering/.test(l)), ["a focus click: 1 new covering element"]);
  const rel = mouseEvents(r.tab).findIndex((s) => s.params.type === "mouseReleased");
  assert.equal(mouseEvents(r.tab).length, rel + 1, "no mouse event after the release");
  assert.ok(!keyEvents(r.tab).some((s) => s.params.key === "Escape"), "no Escape");
  assert.equal(r.tab.valueOf("n"), "2026", "the text");
});

test("ab-pf8 case 1: the cover count: none for a panel far from the field, an element that was there before the click, or a click that opens nothing; two panels count 2; a panel with a child counts once (its highest new ancestor)", async () => {
  const cases: [string, any, number | undefined][] = [
    ["a click that opens nothing", { n: INPUT() }, undefined],
    ["a panel 400 px below the field", { n: INPUT(), panel: PANEL({ box: { x: 200, y: 700, width: 280, height: 20 } }) }, undefined],
    ["a panel 300 px to the right of the field", { n: INPUT(), panel: PANEL({ box: { x: 900, y: 332, width: 200, height: 100 } }) }, undefined],
    ["an element that was there before", { n: INPUT(), near: { tag: "div", box: { x: 200, y: 340, width: 280, height: 100 } } }, undefined],
    ["two panels", { n: INPUT(), panel: PANEL(), hint: PANEL({ box: { x: 200, y: 250, width: 120, height: 40 } }) }, 2],
    ["a panel with a child", { n: INPUT(), panel: PANEL(), cell: PANEL({ box: { x: 210, y: 340, width: 40, height: 30 }, parent: "panel" }) }, 1],
    ["a panel above the field", { n: INPUT(), panel: PANEL({ box: { x: 200, y: 100, width: 280, height: 190 } }) }, 1],
  ];
  for (const [name, nodes, n] of cases) {
    const r = await runVector(own([focusCall("n", true), ...typeCalls("ab")], { nodes }));
    assert.ok(pressOf(r.tab), `${name}: the focus click`);
    assert.equal(r.stage.counts.focusNewCovers, n, `${name}: ${n ?? 0}`);
    assert.equal(r.stage.counts.focusClicksCovering, n ? 1 : undefined, name);
  }
});

test("ab-pf8 case 1: the cover reads run in Playwright's utility world on the node's handle: the first before the path's first move, the second (two frames, awaited) after the release, before the caret keys and the utility call; on a cross-origin frame's session for a field there", async () => {
  const r = await runVector(own([focusCall("n", false)], { nodes: { n: INPUT({ value: "hello world", caret: [11, 11] }), panel: PANEL() } }));
  const i = (pred: (s: Sent) => boolean) => r.tab.sent.findIndex(pred);
  const before = i((s) => fnOf(s) === COVER_BEFORE), after = i((s) => fnOf(s) === COVER_AFTER), first = i((s) => s.method === "Input.dispatchMouseEvent"),
    release = i((s) => s.params?.type === "mouseReleased"), caret = i((s) => s.method === "Input.dispatchKeyEvent"), pass = i((s) => s.pass === 1);
  assert.ok(before >= 0 && before < first, "the first read before the path");
  assert.ok(release < after && after < caret && caret < pass, "the second read after the release, before the caret keys and the utility call");
  assert.deepEqual([r.tab.sent[before].params.objectId, r.tab.sent[after].params.objectId], ["n", "n"], "on the node's handle");
  assert.equal((r.tab.sent[after].params as any).awaitPromise, true, "the two frames are awaited");
  assert.equal(r.stage.counts.focusNewCovers, 1);
  const page = { nodes: { n: { tag: "input", type: "text", frame: "xf", box: { x: 20, y: 30, width: 200, height: 30 }, text: 0, focused: false } },
    frames: { xf: { origin: "cross", box: { x: 460, y: 560, width: 300, height: 120 }, border: 3, padding: 4 } } };
  const x = await runVector(own([fillCall("n", "Card", "child"), insert("Card")], page));
  assert.ok(pressOf(x.tab));
  for (const fn of [COVER_BEFORE, COVER_AFTER]) assert.equal(x.tab.sent.find((s) => fnOf(s) === fn)?.child, "child", "on the frame's session");
});

test("ab-pf8 case 1: a cover read that fails changes nothing: the click and the text go, and nothing is counted; when the click's plan ends, the stage clears the first read (COVER_CLEAR)", async () => {
  for (const fn of [COVER_BEFORE, COVER_AFTER]) {
    const r = await runVector(own([fillCall("n", "abc"), insert("abc")], { nodes: { n: INPUT(), panel: PANEL() } }), { hook: (s) => (fnOf(s) === fn ? new Promise(() => {}) : undefined) });
    assert.ok(pressOf(r.tab), "the click");
    assert.equal(r.stage.counts.focusNewCovers, undefined);
    assert.equal(r.tab.valueOf("n"), "abc");
    if (fn === COVER_BEFORE) assert.ok(!r.tab.sent.some((s) => fnOf(s) === COVER_AFTER), "no second read with no first");
  }
  // The press's answer never comes (a dialog with no event): the plan ends at STAGE_EVENT_WAIT_MS, the click is not done.
  const ended = await runVector(own([fillCall("n", "abc")], { nodes: { n: INPUT(), panel: PANEL() } }), { hook: (s) => (s.params?.type === "mousePressed" ? new Promise(() => {}) : undefined) });
  assert.ok(ended.tab.sent.some((s) => fnOf(s) === COVER_CLEAR), "the first read cleared");
  assert.ok(!ended.tab.sent.some((s) => fnOf(s) === COVER_AFTER));
});

// ================================================================ review-123 (the fix round)

test("review-123 B1: the listener sign only on an input: a textarea or a contenteditable with a click listener keeps its focus click, with no read of its listeners (an editor puts a click listener on its own root), and the cover count sees a panel that its click opens", async () => {
  const cases: [string, any][] = [
    ["a textarea", TEXTAREA({ listeners: ["click"] })],
    ["a contenteditable", { tag: "div", contenteditable: true, box: { x: 200, y: 300, width: 400, height: 90 }, text: 5, focused: false, listeners: ["click"] }],
  ];
  for (const [name, node] of cases) {
    const r = await runVector(own([fillCall("n", "x"), insert("x")], { nodes: { n: node, panel: PANEL({ box: { x: 200, y: 392, width: 280, height: 150 } }) } }));
    assert.ok(pressOf(r.tab), `${name}: the focus click`);
    assert.equal(r.stage.counts.focusWidget, undefined, `${name}: no sign`);
    assert.ok(!r.tab.sent.some((s) => s.method === "DOMDebugger.getEventListeners"), `${name}: no read of the listeners`);
    assert.equal(r.stage.counts.focusNewCovers, 1, `${name}: the cover count sees the panel`);
  }
  const input = await runVector(own([fillCall("n", "x"), insert("x")], { nodes: { n: INPUT({ listeners: ["click"] }) } }));
  assert.equal(input.stage.counts["focusWidget:listener"], 1, "an input with the same listener: the sign");
});

test("review-123 B1: an empty click handler is no sign (a framework's no-op on an element whose click its root handles); a handler with a body is; a listener whose handler the reply does not give is a sign (the stage cannot tell)", async () => {
  const empty = ["function noop() {}", "function(){}", "function () { }", "() => {}", "async () => {}", "e => {}", "function noop$1() {}", "(e) => {\n}"];
  for (const h of empty) {
    const r = await runVector(own([fillCall("n", "x"), insert("x")], { nodes: { n: INPUT({ listeners: [{ type: "click", handler: h }] }) } }));
    assert.ok(pressOf(r.tab) && r.stage.counts.focusWidget === undefined, `${JSON.stringify(h)}: no sign, the click`);
  }
  const full: any[][] = [[{ type: "click", handler: "() => __k.cc++" }], [{ type: "click", handler: "function onclick(event) {\nopen()\n}" }], [{ type: "click", handler: "function () { [native code] }" }],
    [{ type: "click", handler: "e => { e.stopPropagation(); }" }], [{ type: "click", noHandler: true }], [{ type: "click", handler: "() => {}" }, { type: "click", handler: "() => open()" }]];
  for (const listeners of full) {
    const r = await runVector(own([fillCall("n", "x"), insert("x")], { nodes: { n: INPUT({ listeners }) } }));
    assert.ok(!pressOf(r.tab) && r.stage.counts["focusWidget:listener"] === 1, `${JSON.stringify(listeners)}: the sign, no click`);
  }
});

test("review-123 note 6: the read of the listeners has one deadline, GEOMETRY_WAIT_MS for its four steps in all: four steps of 120 ms each give no click, and the utility call goes at the deadline", async () => {
  const steps = (s: Sent) => fnOf(s) === FIELD_ELEMENT || ["DOM.describeNode", "DOM.resolveNode", "DOMDebugger.getEventListeners"].includes(s.method);
  let clock: any;
  const r = await runVector(own([fillCall("n", "abc"), insert("abc")], { nodes: { n: INPUT() } }), { tab: (t) => { clock = t.clock; }, hook: (s) => (steps(s) ? new Promise((res) => clock.timer(120, () => res(undefined))) : undefined) });
  assert.equal(mouseEvents(r.tab).length, 0, "no click");
  assert.equal(r.stage.counts.fieldNoRead, 1);
  const first = r.tab.sent.find(steps)!, pass = r.tab.sent.find((s) => s.pass === 1)!;
  assert.ok(pass.t - first.t >= GEOMETRY_WAIT_MS && pass.t - first.t <= GEOMETRY_WAIT_MS + 5, `the call at ${pass.t - first.t} ms after the read's start`);
});

test("review-123 note 7: a COVER_BEFORE that answers after its limit: the stage clears the kept read when it answers (COVER_CLEAR), and the click and the text go", async () => {
  let clock: any;
  const r = await runVector(own([fillCall("n", "abc"), insert("abc")], { nodes: { n: INPUT() } }), { tab: (t) => { clock = t.clock; }, hook: (s) => (fnOf(s) === COVER_BEFORE ? new Promise((res) => clock.timer(300, () => res(undefined))) : undefined) });
  const before = r.tab.sent.find((s) => fnOf(s) === COVER_BEFORE)!, clear = r.tab.sent.find((s) => fnOf(s) === COVER_CLEAR);
  assert.ok(clear && clear.t >= before.t + 300, "COVER_CLEAR after the late answer");
  assert.ok(!r.tab.sent.some((s) => fnOf(s) === COVER_AFTER), "no second read");
  assert.ok(pressOf(r.tab));
  assert.equal(r.tab.valueOf("n"), "abc");
});

const FOCUSED = { nodes: { f: INPUT({ focused: true }) }, focused: "f" };
const LONG = "the quick brown fox jumps over the lazy dog ".repeat(8).slice(0, 300);

test("board ab-t30.19 (in place of the bound of PR #123): a long pressSequentially (300 characters) is one collected part: with the clipboard one person's paste of the whole text; with none, the client's own key events at once (Playwright's own input); each character once, far inside 30 s", async () => {
  let clock: any;
  const r = await runVector(own(typeCalls(LONG), { ...FOCUSED, clipboard: true }), { maxMs: 200_000, tab: (t) => { clock = t.clock; } });
  assert.equal(r.tab.valueOf("f"), LONG, "the whole text, each character once");
  assert.deepEqual([r.stage.counts.pastedParts, r.tab.pastes.length], [1, 1], "one paste");
  const ev = r.tab.sent.filter((s) => s.method === "Input.dispatchKeyEvent");
  assert.ok(ev.at(-1)!.t - r.arrived.get(LONG.length * 2)! < RUN_IDLE_MS + 1000, "the paste goes RUN_IDLE_MS after the last key call, in about 0.5 s");
  const n = await runVector(own(typeCalls(LONG), FOCUSED), { maxMs: 200_000, hook: (s) => (s.method === "Input.dispatchKeyEvent" ? new Promise((res) => clock.timer(3, () => res(undefined))) : undefined), tab: (t) => { clock = t.clock; } });
  assert.equal(n.tab.valueOf("f"), LONG, "with no clipboard: each character once");
  assert.equal(n.stage.counts["partsAsKeys:noClipboard"], 1);
  const keys = n.tab.sent.filter((s) => s.method === "Input.dispatchKeyEvent");
  assert.equal(keys.length, LONG.length * 2, "the client's own keyDown and keyUp of each character");
  assert.ok(keys.at(-1)!.t - keys[0].t < 600 * 3, `the client's keys at once, at most 8 without an answer (${keys.at(-1)!.t - keys[0].t} ms)`);
});

test("review-123b: the design states round 0's bound as the state until board task ab-t30.19 (section 6.3, a note next to the operator's record of Q2 a), and section 15 records the operator's answer on board item ab-8fu", () => {
  const D = readFileSync(new URL("../docs/superpowers/specs/2026-11-10-vanilla-playwright-human-input-design.md", import.meta.url), "utf8").replace(/\s+/g, " ");
  const AB8FU = "\"can we do a simulated copy/paste for long text input? and we use a person typing for short input only?\"";
  for (const t of [
    "So a client action reaches Playwright's 30 s timeout because of the stage only above a bound: a `pressSequentially` or a `type` of more than about 850 characters (measured by board ab-t30.18: 820 to 921 characters went within 30 s, and on a busy box once only 598) ends with that timeout, and the rest of its text does not go.",
    `This is the state until board task ab-t30.19, which builds the operator's answer on board item ab-8fu (2026-11-12): ${AB8FU} Then a long text goes as a person's paste, and this rule of a key run and its bound go away.`,
    "speed. No client action reaches its timeout.",
    "(A note of board ab-t30.18, not the operator's words: measured, a `pressSequentially` of more than about 850 characters still reaches Playwright's 30 s timeout through the stage, fewer on a busy box; board task ab-t30.19 builds the operator's later answer on board item ab-8fu, section 15.)",
    `- **Board item ab-8fu: a paste for a long text.** The operator answered on 2026-11-12 (confirmed): ${AB8FU} Board task ab-t30.19 builds it (a long text as a person's paste, a person's typing for a short text only); until then the rule of Q2 a holds.`,
  ]) assert.ok(D.includes(t.replace(/\s+/g, " ")), `the design says: ${t}`);
  for (const old of ["So no client action reaches the 30 s timeout because of the stage (Q2).", "about 1,400 characters"]) assert.ok(!D.includes(old), `the design no longer says: ${old}`);
});

// ================================================================ the page-side texts (node:vm, a small DOM model)

type Box = { x: number; y: number; w: number; h: number };
/** An element of the model: its attributes, its box (in its document's viewport points), its parent and children. */
class El {
  nodeType = 1; children: El[] = []; parentElement: El | null = null; ownerDocument!: Doc; isContentEditable = false; disabled = false; readOnly = false; value = ""; textContent = "";
  selectionStart = 0; selectionEnd = 0; list: El | null = null; type: string | undefined; control: El | null = null;
  readonly localName: string; attrs: Record<string, string>; box: Box;
  constructor(localName: string, attrs: Record<string, string> = {}, box: Box = { x: 0, y: 0, w: 10, h: 10 }) { this.localName = localName; this.attrs = attrs; this.box = box; if (localName === "input") this.type = attrs.type ?? "text"; }
  append(...c: El[]) { for (const e of c) { e.parentElement = this; e.ownerDocument = this.ownerDocument; this.children.push(e); } return this; }
  getAttribute(n: string) { return n in this.attrs ? this.attrs[n] : null; }
  getRootNode() { return this.ownerDocument; }
  contains(x: El | null) { for (let p = x; p; p = p.parentElement) if (p === this) return true; return false; }
  getBoundingClientRect() { const b = this.box; return { left: b.x, top: b.y, right: b.x + b.w, bottom: b.y + b.h, width: b.w, height: b.h }; }
  /** A selector list of tag names, [role=x] and [role~=x] (the texts' own selectors). */
  matches(sel: string): boolean {
    return sel.split(",").map((s) => s.trim()).some((s) => {
      const m = /^\[role(~?)=([\w-]+)\]$/.exec(s);
      if (m) { const r = this.getAttribute("role") ?? ""; return m[1] ? r.split(/\s+/).includes(m[2]) : r === m[2]; }
      return s === this.localName;
    });
  }
  closest(sel: string): El | null { for (let p: El | null = this; p; p = p.parentElement) if (p.matches(sel)) return p; return null; }
}
/** A document and its window (a top window: no frame element). */
class Doc {
  nodeType = 9; body: El; activeElement: El | null = null; focus = true; defaultView: any;
  /** The elements at a point, top first (the page's paint order); a test gives it. */
  stack: (x: number, y: number) => El[] = () => [this.body];
  constructor(view = { w: 1280, h: 720 }) {
    const w: any = { innerWidth: view.w, innerHeight: view.h, frameElement: null, document: this, getComputedStyle: () => ({}) };
    w.top = w; w.parent = w; this.defaultView = w;
    this.body = new El("body", {}, { x: 0, y: 0, w: view.w, h: view.h }); this.body.ownerDocument = this;
  }
  hasFocus() { return this.focus; }
  elementsFromPoint(x: number, y: number) { return this.stack(x, y); }
  elementFromPoint(x: number, y: number) { return this.stack(x, y)[0] ?? null; }
}
/** A text run on a node (`this`) in a context of its own (Playwright's utility world); its value as plain data. */
function runOn(node: unknown, text: string, args: unknown[], ctx: vm.Context): any {
  return vm.runInContext(`(${text})`, ctx).apply(node, args);
}
const plain = (v: unknown) => JSON.parse(JSON.stringify(v));

test("FIELD_STATE's widget signs, as the page reads them: the role combobox (a token of the role, also on an element around the field), aria-haspopup other than false, aria-expanded true or false, aria-autocomplete list or both, an input whose list names a datalist; in this order; fill's retarget reads the control of a label", () => {
  const read = (attrs: Record<string, string>, set?: (el: El, doc: Doc) => void, follow = false, on?: (el: El, doc: Doc) => El) => {
    const doc = new Doc(), el = new El("input", attrs, { x: 100, y: 60, w: 300, h: 30 });
    doc.body.append(el);
    set?.(el, doc);
    return plain(runOn(on ? on(el, doc) : el, FIELD_STATE, [follow], vm.createContext({}))).widget;
  };
  const yes: [Record<string, string>, string][] = [
    [{ role: "combobox" }, "combobox"], [{ role: "combobox textbox" }, "combobox"], [{ role: "Combobox" }, "combobox"],
    ...["true", "menu", "listbox", "tree", "grid", "dialog", "TRUE", " listbox "].map((v): [Record<string, string>, string] => [{ "aria-haspopup": v }, "haspopup"]),
    [{ "aria-expanded": "false" }, "expanded"], [{ "aria-expanded": "true" }, "expanded"],
    [{ "aria-autocomplete": "list" }, "autocomplete"], [{ "aria-autocomplete": "both" }, "autocomplete"],
    [{ role: "combobox", "aria-haspopup": "listbox", "aria-expanded": "false", "aria-autocomplete": "list" }, "combobox"],
    [{ "aria-haspopup": "dialog", "aria-expanded": "false" }, "haspopup"],
    [{ "aria-expanded": "false", "aria-autocomplete": "list" }, "expanded"],
  ];
  for (const [attrs, sign] of yes) assert.equal(read(attrs), sign, JSON.stringify(attrs));
  const no: Record<string, string>[] = [{}, { role: "textbox" }, { role: "searchbox" }, { "aria-haspopup": "false" }, { "aria-haspopup": "" }, { "aria-haspopup": "yes" }, { "aria-expanded": "undefined" }, { "aria-expanded": "" },
    { "aria-autocomplete": "none" }, { "aria-autocomplete": "inline" }, { list: "nothing" }, { "aria-controls": "x" }, { autocomplete: "on" }];
  for (const attrs of no) assert.equal(read(attrs), null, JSON.stringify(attrs));
  assert.equal(read({ list: "d" }, (el) => { el.list = new El("datalist"); }), "list", "an input whose list names a datalist");
  assert.equal(read({}, (el, doc) => { const box = new El("div", { role: "combobox" }); doc.body.append(box); box.append(el); }), "comboboxAround", "the ARIA 1.1 pattern: the role on an element around the field");
  assert.equal(read({}, (el, doc) => { const box = new El("div", { role: "listbox" }); doc.body.append(box); box.append(el); }), null, "another role around it");
  // A textarea has no list; its own signs count.
  const ta = new Doc(), t = new El("textarea", { "aria-autocomplete": "list" }, { x: 0, y: 0, w: 100, h: 50 });
  ta.body.append(t);
  assert.equal(plain(runOn(t, FIELD_STATE, [false], vm.createContext({}))).widget, "autocomplete");
  // fill's retarget (follow): a label's control, whose signs count.
  assert.equal(read({}, (el, doc) => { el.attrs.role = "combobox"; }, true, (el, doc) => { const l = new El("label"); doc.body.append(l); l.control = el; return l; }), "combobox", "the label's control");
});

test("FIELD_ELEMENT gives the field's element (fill's retarget: a label's control)", () => {
  const doc = new Doc(), el = new El("input", {}, { x: 0, y: 0, w: 100, h: 30 }), l = new El("label");
  doc.body.append(el, l); l.control = el;
  const ctx = vm.createContext({});
  assert.equal(runOn(el, FIELD_ELEMENT, [false], ctx), el);
  assert.equal(runOn(l, FIELD_ELEMENT, [true], ctx), el);
});

/** A page with a field at 100,60 (300 x 30) and the elements at each point by their boxes, the last drawn on top. */
function coverPage() {
  const doc = new Doc(), field = new El("input", {}, { x: 100, y: 60, w: 300, h: 30 });
  doc.body.append(field);
  const shown: El[] = [];
  const within = (e: El, x: number, y: number) => x >= e.box.x && x < e.box.x + e.box.w && y >= e.box.y && y < e.box.y + e.box.h;
  doc.stack = (x, y) => [...[...shown].reverse().filter((e) => within(e, x, y)), ...(within(field, x, y) ? [field] : []), doc.body];
  const ctx = vm.createContext({ requestAnimationFrame: (f: () => void) => { setImmediate(f); return 1; } });
  return { doc, field, shown, ctx };
}

test("COVER_BEFORE and COVER_AFTER, as the page runs them: the area near the field (40 px across, 240 px down and up, within the viewport) at 9 x 25 points; after the click, the new top elements there, each once with its highest new ancestor; the field, its content and the elements there before do not count; the read is kept in the world until COVER_AFTER or COVER_CLEAR", async () => {
  const { doc, field, shown, ctx } = coverPage();
  const before = (): number => runOn(field, COVER_BEFORE, [false], ctx);
  const after = (): Promise<number> => runOn(field, COVER_AFTER, [], ctx);
  // The grid: x from 60 to 440 (9 columns), y from 0 (the viewport's top, not -180) to 330 (25 rows).
  let pts: number[][] = [];
  doc.stack = ((orig) => (x: number, y: number) => { pts.push([x, y]); return orig(x, y); })(doc.stack);
  assert.equal(before(), 225, "9 x 25 points");
  const xs = [...new Set(pts.map((p) => p[0]))].sort((a, b) => a - b), ys = [...new Set(pts.map((p) => p[1]))].sort((a, b) => a - b);
  assert.deepEqual([xs.length, xs[0], xs.at(-1), ys.length, ys[0], ys.at(-1)], [9, 60, 440, 25, 0, 330]);
  assert.equal(await after(), 0, "nothing new");
  // A panel under the field, with cells: one element (the panel, the highest new ancestor).
  // The cell lies under grid points (x 107.5 to 297.5, y 110 and 123.75): with no climb to its highest new ancestor it would count twice.
  const panel = new El("div", {}, { x: 100, y: 92, w: 280, h: 200 }), cell = new El("td", {}, { x: 100, y: 100, w: 200, h: 30 });
  doc.body.append(panel); panel.append(cell);
  before(); shown.push(panel, cell);
  assert.equal(await after(), 1, "the panel once");
  // A panel that the page draws at its next frame (a framework's render after the click): the read waits two frames.
  shown.length = 0;
  before();
  (ctx as any).requestAnimationFrame(() => shown.push(panel));
  assert.equal(await after(), 1, "the panel of the next frame");
  // review-123 note 5: a panel that the page draws at its second frame: the read waits two frames, not one.
  shown.length = 0;
  before();
  (ctx as any).requestAnimationFrame(() => (ctx as any).requestAnimationFrame(() => shown.push(panel)));
  assert.equal(await after(), 1, "the panel of the second frame");
  // Two new elements: a panel and a hint above the field.
  shown.length = 0;
  const hint = new El("div", {}, { x: 100, y: 20, w: 120, h: 30 });
  doc.body.append(hint);
  before(); shown.push(panel, hint);
  assert.equal(await after(), 2);
  // An element there before (at a point of the area) does not count when it comes on top; nor does the field's own content.
  shown.length = 0; shown.push(hint);
  before(); shown.length = 0; shown.push(panel, hint);
  assert.equal(await after(), 1, "only the panel is new");
  const inner = new El("span", {}, { x: 110, y: 62, w: 50, h: 20 });
  field.append(inner);
  shown.length = 0;
  before(); shown.push(inner);
  assert.equal(await after(), 0, "the field's own content");
  // review-123 note 5: a new element around the field (a framework that wraps the field at the focus) is not new.
  const outer = new El("div", {}, { x: 90, y: 50, w: 330, h: 50 });
  doc.body.append(outer); outer.append(field);
  shown.length = 0;
  before(); shown.push(outer);
  assert.equal(await after(), 0, "an element around the field");
  doc.body.append(field);
  // A panel far from the field (400 px below) is at no point of the area.
  const far = new El("div", {}, { x: 100, y: 500, w: 280, h: 100 });
  doc.body.append(far);
  shown.length = 0;
  before(); shown.push(far);
  assert.equal(await after(), 0, "far below");
  // The kept read: COVER_AFTER with no COVER_BEFORE gives null, and COVER_CLEAR drops a kept read.
  assert.equal(await after(), null, "no read kept after COVER_AFTER");
  before();
  assert.equal(runOn(field, COVER_CLEAR, [], ctx), true);
  assert.equal(await after(), null, "no read kept after COVER_CLEAR");
});
