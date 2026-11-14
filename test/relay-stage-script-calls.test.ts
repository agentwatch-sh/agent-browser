// The script calls of the input stage (board ab-t30.12.1, part 1 of ab-t30.12; the input design's section 5.1, the rows of
// selectOption, fill of a date, time, month, week, color or range input, selectText, focus and blur; C11 "The input
// stage", the script calls). The operator's answer Q3 a (board item ab-0z5): "Translate where a person's input gives the
// same result, and pass the rest": a select gets a click, keys and Enter; a date input gets a click and typed digits;
// selectText on an input or a textarea gets a click and the select-all chord; blur, focus on an element that is no text
// field, and the rest pass and are counted. After the stage's own input of a select or a picker, the client's call goes
// with Playwright's function in SKIP_EVENTS, so the page sees the person's events once and no untrusted event.
//
// The stage's tests run on the fake Chrome of stage-fakes.ts (no browser, a fake clock); SKIP_EVENTS runs here as the
// page runs it, in a context of its own (node:vm), with Playwright's own function texts and a small model of a DOM.

import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { CONTROL, META } from "../src/human/keys.ts";
import { PICKER_TYPES, RANGE_KEYS_MAX, RANGE_THUMB_PX, SELECT_KEYS_MAX, SELECT_TYPE_MAX, SKIP_EVENTS, pickerKeys, selectKeys, selectTarget, skipEvents, type SelectOption } from "../src/relay/stage.ts";
import { runVector, type FakeTab, type Sent } from "./stage-fakes.ts";

const V = JSON.parse(readFileSync(new URL("./vectors/stage.json", import.meta.url), "utf8"));
const vec = (id: string) => structuredClone(V.vectors.find((x: any) => x.id === id));
const fnOfVec = (id: string) => vec(id).in[0].params.arguments[3].value as string;
const SELECT_FN = fnOfVec("select-option"), SELECT_TEXT_FN = fnOfVec("select-text"), FILL_FN = fnOfVec("fill"), BLUR_FN = fnOfVec("blur"), FOCUS_FN = fnOfVec("focus-button");

// ---------------------------------------------------------------- the client's calls, as Playwright sends them

const util = (fn: string, arg: unknown, node: string) => ({ method: "Runtime.callFunctionOn",
  params: { functionDeclaration: "(utilityScript, ...args) => utilityScript.evaluate(...args)", objectId: "7.3.1", returnByValue: true, awaitPromise: true, userGesture: true,
    arguments: [{ objectId: "7.3.1" }, { value: true }, { value: true }, { value: fn }, { value: 1 }, { value: { a: [{ h: 0 }, { h: 1 }, arg] } }, { objectId: "7.3.2" }, { objectId: node }] } });
const byValueOrLabel = (v: string) => ({ o: [{ k: "valueOrLabel", v }] });
const selectCall = (node: string, ...want: unknown[]) => util(SELECT_FN, { o: [{ k: "optionsToSelect", v: { a: want } }, { k: "force", v: false }, { k: "frameVisible", v: true }] }, node);
const fillCall = (node: string, value: string) => util(FILL_FN, { o: [{ k: "value", v: value }, { k: "force", v: false }, { k: "frameVisible", v: true }] }, node);
const selectTextCall = (node: string) => util(SELECT_TEXT_FN, { o: [{ k: "force", v: false }, { k: "frameVisible", v: true }] }, node);
const blurCall = (node: string) => util(BLUR_FN, { o: [] }, node);
const focusCall = (node: string) => util(FOCUS_FN, { v: "undefined" }, node);

/** A vector of the tests' own: the calls in order, each after the answer of the one before. */
function own(calls: any[], page: Partial<any> = {}, extra: Partial<any> = {}) {
  const ins = calls.map((c, i) => ({ id: i + 1, ...(c.at === undefined && c.after === undefined && c.afterEvent === undefined ? (i === 0 ? { at: 0 } : { after: i }) : {}), ...c }));
  return { id: "own", platform: "linux", seed: 11, clock: 0, page: { viewport: { width: 1280, height: 720 }, last: { x: 900, y: 700 }, nodes: {}, focused: null, ...page },
    chrome: { results: {} }, in: ins, out: [], answers: [], ...extra };
}
const OPTIONS: SelectOption[] = [
  { v: "a", l: "Opt A", d: false, h: false }, { v: "b", l: "Opt B", d: false, h: false }, { v: "c", l: "Opt C", d: true, h: false },
  { v: "d", l: "Opt D", d: false, h: false }, { v: "e", l: "Opt E", d: false, h: true }, { v: "f", l: "Opt F", d: false, h: false },
  { v: "g", l: "Opt G", d: false, h: false }, { v: "h", l: "Opt H", d: false, h: false }, { v: "i", l: "Opt I", d: false, h: false }, { v: "j", l: "Opt J", d: false, h: false },
];
const SELECT = (o: object = {}) => ({ tag: "select", box: { x: 200, y: 300, width: 200, height: 24 }, focused: false, options: OPTIONS, selected: 0, ...o });
const DATE = (o: object = {}) => ({ tag: "input", type: "date", box: { x: 200, y: 400, width: 240, height: 30 }, focused: false, fields: ["month", "day", "year"], ...o });
const INPUT = (o: object = {}) => ({ tag: "input", type: "text", box: { x: 200, y: 300, width: 300, height: 30 }, text: 5, focused: false, ...o });
const mouseEvents = (t: FakeTab) => t.sent.filter((s) => s.method === "Input.dispatchMouseEvent" && s.pass === undefined);
const keyEvents = (t: FakeTab) => t.sent.filter((s) => s.method === "Input.dispatchKeyEvent" && s.pass === undefined);
const inputEvents = (t: FakeTab) => t.sent.filter((s) => s.method.startsWith("Input.") && s.pass === undefined);
const passOf = (t: FakeTab, id: number) => t.sent.find((s) => s.pass === id)!;
const fnOf = (s: Sent) => (s.params as any).arguments[3].value;
const downs = (t: FakeTab) => keyEvents(t).filter((s) => s.params.type !== "keyUp").map((s) => s.params.key);
const answerOf = (r: Awaited<ReturnType<typeof runVector>>, id: number) => r.answers.find((a) => a.id === id)!;
const trustedOnly = (t: FakeTab) => t.pageEvents.map((e) => `${e.type}${e.trusted ? "" : "(untrusted)"}=${e.value}`);

// ================================================================ selectOption

test("selectOption on a select: a click on it, the arrow keys past a disabled and a hidden option, Enter, then the client's call in SKIP_EVENTS; the page sees one trusted input and change, and no untrusted one", async () => {
  for (const seed of [11, 112, 213]) {
    const r = await runVector(own([selectCall("s", byValueOrLabel("f"))], { nodes: { s: SELECT() } }), { seed });
    const press = mouseEvents(r.tab).find((s) => s.params.type === "mousePressed")!;
    assert.ok(press && press.params.x >= 200 && press.params.x < 400 && press.params.y >= 300 && press.params.y < 324, `seed ${seed}: a press on the select`);
    // From A: B, D, F (C is disabled, E hidden): three ArrowDown, then Enter (shorter than End and four ArrowUp, or the typed "opt f").
    assert.deepEqual(downs(r.tab), ["ArrowDown", "ArrowDown", "ArrowDown", "Enter"], `seed ${seed}: the keys`);
    assert.ok(keyEvents(r.tab)[0].t > press.t, `seed ${seed}: the keys after the press`);
    const pass = passOf(r.tab, 1);
    assert.ok(r.tab.sent.indexOf(pass) > r.tab.sent.indexOf(keyEvents(r.tab).at(-1)!), `seed ${seed}: the call after the keys`);
    assert.ok(keyEvents(r.tab)[0].t - mouseEvents(r.tab).at(-1)!.t >= 80, `seed ${seed}: a person's pause before the first key (the popup opens)`);
    assert.equal(fnOf(pass), SKIP_EVENTS(SELECT_FN), `seed ${seed}: Playwright's function in SKIP_EVENTS`);
    assert.deepEqual({ ...(pass.params as any), arguments: (pass.params as any).arguments.filter((_: unknown, i: number) => i !== 3) },
      { ...selectCall("s").params, arguments: selectCall("s", byValueOrLabel("f")).params.arguments.filter((_: unknown, i: number) => i !== 3) }, `seed ${seed}: the rest of the call as the client sent it`);
    assert.equal(r.tab.scriptValue("s"), 5);
    assert.deepEqual(trustedOnly(r.tab), ["input=5", "change=5"], `seed ${seed}: one trusted input and change, no untrusted one`);
    assert.equal(r.stage.counts.selectByKeys, 1);
    assert.ok(!answerOf(r, 1).body.error);
  }
  // Upward, by the option's label with other white space (Playwright's normalizeWhiteSpace), from F to B.
  const r = await runVector(own([selectCall("s", { o: [{ k: "label", v: "  Opt  B " }] })], { nodes: { s: SELECT({ selected: 5 }) } }));
  assert.deepEqual(downs(r.tab), ["ArrowUp", "ArrowUp", "Enter"]);
  assert.equal(r.tab.scriptValue("s"), 1);
  assert.deepEqual(trustedOnly(r.tab), ["input=1", "change=1"]);
});

test("selectOption passes as the client sent it, and the stage counts it: the option selected already, a list box, a multiple select, a disabled select, no such option, a disabled option, a hidden option, no select", async () => {
  const cases: [string, any, unknown[], string][] = [
    ["the option is selected already", SELECT(), [byValueOrLabel("a")], "selected"],
    ["a list box (size 4)", SELECT({ size: 4 }), [byValueOrLabel("b")], "listBox"],
    ["a multiple select", SELECT({ multiple: true }), [byValueOrLabel("b"), byValueOrLabel("d")], "listBox"],
    ["a disabled select", SELECT({ disabled: true }), [byValueOrLabel("b")], "disabled"],
    ["no such option", SELECT(), [byValueOrLabel("zz")], "noOption"],
    ["a disabled option", SELECT(), [byValueOrLabel("c")], "noOption"],
    ["a hidden option (the popup's keys do not reach it)", SELECT(), [byValueOrLabel("e")], "noKeys"],
    ["no select", INPUT(), [byValueOrLabel("b")], "notSelect"],
    ["aria-disabled (review-132 note a: Playwright's own enabled check)", SELECT({ ariaDisabled: true }), [byValueOrLabel("b")], "states"],
  ];
  for (const [name, node, want, k] of cases) {
    const r = await runVector(own([selectCall("s", ...want)], { nodes: { s: node } }));
    assert.equal(inputEvents(r.tab).length, 0, `${name}: no input of the stage`);
    assert.equal(fnOf(passOf(r.tab, 1)), SELECT_FN, `${name}: the call as the client sent it`);
    assert.equal(r.stage.counts[`selectPass:${k}`], 1, `${name}: counted selectPass:${k}`);
  }
  // The option selected already: Playwright's own events go (a page can wait for them).
  const r = await runVector(own([selectCall("s", byValueOrLabel("a"))], { nodes: { s: SELECT() } }));
  assert.deepEqual(trustedOnly(r.tab), ["input(untrusted)=0", "change(untrusted)=0"]);
});

test("review-132: on the Mac selectOption passes, counted (a native menu); a page that cancels mousedown on the select: no key goes, and the call passes, counted", async () => {
  const mac = await runVector(own([selectCall("s", byValueOrLabel("f"))], { nodes: { s: SELECT() } }, { platform: "mac" }));
  assert.equal(inputEvents(mac.tab).length, 0);
  assert.equal(fnOf(passOf(mac.tab, 1)), SELECT_FN);
  assert.equal(mac.stage.counts["selectPass:mac"], 1);
  const r = await runVector(own([selectCall("s", byValueOrLabel("f"))], { nodes: { s: SELECT({ cancelsPress: true }) } }));
  assert.equal(mouseEvents(r.tab).filter((s) => s.params.type === "mousePressed").length, 1, "the click");
  assert.equal(keyEvents(r.tab).length, 0, "no key");
  assert.equal(fnOf(passOf(r.tab, 1)), SELECT_FN, "the call as the client sent it");
  assert.equal(r.stage.counts["selectPass:noFocus"], 1);
  assert.equal(r.tab.scriptValue("s"), 5, "Playwright's script selects the option");
  // A picker and a range whose click gives no focus: no key goes either.
  const d = await runVector(own([fillCall("d", "2026-12-31")], { nodes: { d: DATE({ cancelsPress: true }) } }));
  assert.equal(keyEvents(d.tab).length, 0);
  assert.equal(d.stage.counts["pickerPass:noFocus"], 1);
  const g = await runVector(own([fillCall("r", "80")], { nodes: { r: { tag: "input", type: "range", box: { x: 200, y: 400, width: 300, height: 20 }, value: "50", thumb: 40, cancelsPress: true } } }));
  assert.equal(keyEvents(g.tab).length, 0);
  assert.equal(g.stage.counts["rangePass:noFocus"], 1);
});

test("selectOption whose keys miss (a popup that takes no key): Playwright's script selects the option, and its own events go", async () => {
  const r = await runVector(own([selectCall("s", byValueOrLabel("d"))], { nodes: { s: SELECT({ popupKeys: false }) } }));
  assert.deepEqual(downs(r.tab), ["ArrowDown", "ArrowDown", "Enter"]);
  assert.equal(fnOf(passOf(r.tab, 1)), SKIP_EVENTS(SELECT_FN));
  assert.equal(r.stage.counts.selectMissed, 1);
  assert.equal(r.tab.scriptValue("s"), 3);
  assert.deepEqual(trustedOnly(r.tab), ["input(untrusted)=3", "change(untrusted)=3"], "the script's events, as with no stage");
  assert.ok(r.logs.some((l) => /selectOption: the keys did not select the client's option; Playwright's script selects it$/.test(l)));
});

test("selectTarget is Playwright's filter: valueOrLabel by the value or the label, value, label with its white space normalized, index, an option's handle, all of one option, the first match", () => {
  const H = (i: number) => ({ handle: `h${i}` });
  assert.equal(selectTarget([{ valueOrLabel: "d" }], OPTIONS, []), 3);
  assert.equal(selectTarget([{ valueOrLabel: "Opt D" }], OPTIONS, []), 3);
  assert.equal(selectTarget([{ value: "Opt D" }], OPTIONS, []), null);
  assert.equal(selectTarget([{ label: " Opt\nF " }], OPTIONS, []), 5);
  assert.equal(selectTarget([{ index: 1 }], OPTIONS, []), 1);
  assert.equal(selectTarget([{ value: "b", index: 3 }], OPTIONS, []), null, "every given key of one option must match");
  assert.equal(selectTarget([H(0)], OPTIONS, [3]), 3, "an option's handle by its index in the select");
  assert.equal(selectTarget([H(0)], OPTIONS, [-1]), null, "a handle of no option of this select");
  assert.equal(selectTarget([{ valueOrLabel: "f" }, { valueOrLabel: "b" }], OPTIONS, []), 1, "the first option that one of them matches");
  assert.equal(selectTarget([{}], OPTIONS, []), 0);
});

test("selectKeys: the shortest way in the popup: the arrow keys, Home or End and the arrow keys, or the shortest start of the label that no other label has; then Enter", () => {
  const K = (k: { key: string }[] | null) => k?.map((x) => x.key) ?? null;
  const names = ["Afghanistan", "Albania", "Algeria", "Germany", "Georgia", "Ghana", "Niger", "Nigeria", "Llama Land", "Lyon", "United Kingdom", "United States", "Zambia"];
  const o: SelectOption[] = [...names, ...Array.from({ length: 30 }, (_, i) => `Zeta ${i}`)].map((l, i) => ({ v: String(i), l, d: false, h: false }));
  assert.deepEqual(K(selectKeys(o, 0, 3)), ["ArrowDown", "ArrowDown", "ArrowDown", "Enter"], "Germany: the arrow keys (as short as the typed \"ger\")");
  assert.deepEqual(K(selectKeys(o, 0, 5)), ["g", "h", "Enter"], "Ghana: typed, shorter than the arrow keys");
  assert.deepEqual(K(selectKeys(o, 0, 1)), ["ArrowDown", "Enter"]);
  assert.deepEqual(K(selectKeys(o, 20, 0)), ["Home", "Enter"], "the first option: Home");
  assert.deepEqual(K(selectKeys(o, 0, o.length - 1)), ["End", "Enter"], "the last option: End");
  assert.deepEqual(K(selectKeys(o, 0, 7)), ["n", "i", "g", "e", "r", "i", "Enter"], "Nigeria: the start that Niger does not have");
  assert.deepEqual(K(selectKeys(o, 0, 6)), ["ArrowDown", "ArrowDown", "ArrowDown", "ArrowDown", "ArrowDown", "ArrowDown", "Enter"], "Niger: no start of its own (Nigeria has all), so the arrow keys");
  assert.deepEqual(K(selectKeys(o, 0, 8)), ["l", "l", "a", "Enter"], "Llama Land: a start of two same characters is one longer");
  assert.deepEqual(K(selectKeys(o, 0, 12)), ["z", "a", "Enter"], "Zambia: the start that the Zeta options do not have");
  assert.deepEqual(K(selectKeys(o, 40, 11)), ["u", "n", "i", "t", "e", "d", " ", "s", "Enter"], "United States: a space in the start");
  // Far from both ends, with no start of its own and no US key: no way.
  const far: SelectOption[] = Array.from({ length: 40 }, (_, i) => ({ v: String(i), l: i === 20 ? "Ölfus" : `Item ${i}`, d: false, h: false }));
  assert.equal(selectKeys(far, 0, 20), null);
  assert.equal(SELECT_TYPE_MAX, 12, "C11's SELECT_TYPE_MAX");
  assert.equal(SELECT_KEYS_MAX, 8, "C11's SELECT_KEYS_MAX");
});

test("selectKeys: the arrow keys over the options that are not disabled or hidden, then Enter; null past SELECT_KEYS_MAX, from or to an option that the arrows do not reach", () => {
  const K = (k: { key: string }[] | null) => k?.map((x) => x.key) ?? null;
  assert.deepEqual(K(selectKeys(OPTIONS, 0, 5)), ["ArrowDown", "ArrowDown", "ArrowDown", "Enter"]);
  assert.deepEqual(K(selectKeys(OPTIONS, 6, 3)), ["ArrowUp", "ArrowUp", "Enter"]);
  assert.deepEqual(K(selectKeys(OPTIONS, 6, 0)), ["Home", "Enter"]);
  assert.deepEqual(K(selectKeys(OPTIONS, 1, 3)), ["ArrowDown", "Enter"]);
  assert.deepEqual(K(selectKeys(OPTIONS, 2, 5)), ["ArrowDown", "ArrowDown", "Enter"], "from a disabled option (the popup starts there)");
  assert.equal(selectKeys(OPTIONS, 0, 4), null, "to a hidden option");
  assert.equal(selectKeys(OPTIONS, 0, 2), null, "to a disabled option");
  assert.equal(selectKeys([...OPTIONS.slice(0, 4), { ...OPTIONS[4], h: true }, OPTIONS[5]], 4, 5), null, "from a hidden option");
  assert.deepEqual(K(selectKeys(OPTIONS, -1, 3)), ["ArrowDown", "ArrowDown", "ArrowDown", "Enter"], "from no option: before the first");
  assert.deepEqual(K(selectKeys(OPTIONS, 0, 9)), ["End", "Enter"]);
  // Labels with no start of their own (all the same), far from both ends: the arrow keys up to SELECT_KEYS_MAX.
  const many: SelectOption[] = Array.from({ length: 2 * SELECT_KEYS_MAX + 6 }, (_, i) => ({ v: String(i), l: "opt", d: false, h: false }));
  assert.equal(K(selectKeys(many, 0, SELECT_KEYS_MAX))!.length, SELECT_KEYS_MAX + 1);
  assert.equal(selectKeys(many, 0, SELECT_KEYS_MAX + 2), null, "past SELECT_KEYS_MAX from the selected option and from both ends");
  assert.equal(K(selectKeys(OPTIONS, 0, 1))!.at(-1), "Enter");
});

// ================================================================ the fill of a picker input

test("the fill of a date input: a click at its left edge, the digits of each field in the order of the input's fields, then the client's call in SKIP_EVENTS; the page sees the browser's trusted input and change", async () => {
  for (const [fields, keys] of [[["month", "day", "year"], "12312026"], [["day", "month", "year"], "31122026"], [["year", "month", "day"], "20261231"]] as const) {
    const r = await runVector(own([fillCall("d", "2026-12-31")], { nodes: { d: DATE({ fields }) } }));
    const press = mouseEvents(r.tab).find((s) => s.params.type === "mousePressed")!;
    assert.ok(press.params.x >= 202 && press.params.x <= 205, `${fields}: the press 2 to 5 px from the left edge (${press.params.x})`);
    assert.equal(keyEvents(r.tab).filter((s) => s.params.type === "keyDown").map((s) => s.params.text).join(""), keys, `${fields}: the digits in the order of the fields`);
    assert.equal(fnOf(passOf(r.tab, 1)), SKIP_EVENTS(FILL_FN));
    assert.equal(r.tab.scriptValue("d"), "2026-12-31");
    assert.deepEqual(trustedOnly(r.tab), ["input=2026-12-31", "change=2026-12-31"], `${fields}: the browser's events, no untrusted one`);
    assert.equal(r.stage.counts.pickerTyped, 1);
  }
  // A time input of 12 hours: its hour, its minute and its AM/PM letter.
  const r = await runVector(own([fillCall("t", " 21:05 ")], { nodes: { t: DATE({ type: "time", fields: ["hour", "minute", "ampm"] }) } }));
  assert.equal(keyEvents(r.tab).filter((s) => s.params.type === "keyDown").map((s) => s.params.text).join(""), "0905p");
  assert.equal(r.tab.scriptValue("t"), "21:05");
  assert.deepEqual(trustedOnly(r.tab), ["input=21:05", "change=21:05"]);
});

test("the fill of a picker input passes as the client sent it, and the stage counts it: the same value, an empty value, a value with a part that has no field; a color, a range, a disabled and a read-only input get no click", async () => {
  const cases: [string, any, string, string][] = [
    ["the value is the input's already", DATE({ value: "2026-12-31" }), "2026-12-31", "pickerPass:same"],
    ["an empty value", DATE({ value: "2026-12-31" }), "", "pickerPass:empty"],
    ["a second with no second field", DATE({ type: "time", fields: ["hour", "minute", "ampm"] }), "09:30:15", "pickerPass:noKeys"],
    ["a zero second with no second field (review-132 B1)", DATE({ type: "time", fields: ["hour", "minute", "ampm"] }), "21:30:00", "pickerPass:noKeys"],
    ["no second on an input with a second field (review-132 B1)", DATE({ type: "time", fields: ["hour", "minute", "second", "ampm"] }), "21:30", "pickerPass:noKeys"],
    ["a millisecond (review-132 B1)", DATE({ type: "time", fields: ["hour", "minute", "second", "millisecond", "ampm"] }), "21:30:15.5", "pickerPass:noKeys"],
    ["an invalid date (review-132 note b)", DATE(), "2026-02-30", "pickerPass:noKeys"],
    ["aria-readonly (review-132 note a)", DATE({ ariaReadOnly: true }), "2026-12-31", "pickerPass:states"],
    ["a date input in a disabled fieldset (review-132 B2)", DATE({ fieldsetDisabled: true }), "2026-12-31", "fieldNotText"],
    ["a color input", { tag: "input", type: "color", box: { x: 200, y: 400, width: 60, height: 30 } }, "#ff0000", "fieldNotText"],
    ["a disabled date input", DATE({ disabled: true }), "2026-12-31", "fieldNotText"],
    ["a read-only date input", DATE({ readOnly: true }), "2026-12-31", "fieldNotText"],
  ];
  for (const [name, node, value, k] of cases) {
    const r = await runVector(own([fillCall("d", value)], { nodes: { d: node } }));
    assert.equal(inputEvents(r.tab).length, 0, `${name}: no input of the stage`);
    assert.equal(fnOf(passOf(r.tab, 1)), FILL_FN, `${name}: the call as the client sent it`);
    assert.equal(r.stage.counts[k], 1, `${name}: counted ${k}`);
  }
  assert.deepEqual(PICKER_TYPES, ["date", "time", "datetime-local", "month", "week"]);
});

test("pickerKeys: each field's digits with zeros in front, in the input's order; a 12-hour field and its AM/PM letter; null for a value whose form the typed fields do not give (review-132 B1), an invalid value (note b), or another form", () => {
  const T = (type: string, value: string, fields: string[]) => pickerKeys(type, value, fields)?.map((k) => k.text).join("") ?? null;
  assert.equal(T("date", "2026-03-05", ["month", "day", "year"]), "03052026");
  assert.equal(T("month", "2026-03", ["month", "year"]), "032026");
  assert.equal(T("week", "2026-W05", ["week", "year"]), "052026");
  assert.equal(T("time", "00:07", ["hour", "minute", "ampm"]), "1207a");
  assert.equal(T("time", "12:30", ["hour", "minute", "ampm"]), "1230p");
  assert.equal(T("time", "21:30", ["hour", "minute"]), "2130");
  // review-132 B1: the value's form must be the one that the typed fields give.
  assert.equal(T("time", "21:30:15", ["hour", "minute", "second", "ampm"]), "093015p");
  assert.equal(T("time", "21:30", ["hour", "minute", "second", "ampm"]), null, "no second on an input with a second field");
  assert.equal(T("time", "21:30:15.5", ["hour", "minute", "second", "millisecond", "ampm"]), null, "a millisecond");
  assert.equal(T("time", "21:30:15.500", ["hour", "minute", "second", "ampm"]), null, "a millisecond of 3 digits too");
  assert.equal(T("datetime-local", "2026-12-31T21:30:15", ["month", "day", "year", "hour", "minute", "second", "ampm"]), "12312026093015p");
  assert.equal(T("datetime-local", "2026-12-31T21:30", ["month", "day", "year", "hour", "minute", "ampm"]), "123120260930p");
  assert.deepEqual(pickerKeys("datetime-local", "2026-12-31T21:30", ["month", "day", "year", "hour", "minute", "ampm"])!.map((k) => k.key).slice(6, 10), ["2", "6", "ArrowRight", "0"], "ArrowRight after a year that is not the last field");
  assert.equal(pickerKeys("date", "2026-12-31", ["month", "day", "year"])!.at(-1)!.key, "6", "no ArrowRight after the last field");
  assert.equal(T("time", "21:30:15", ["hour", "minute", "ampm"]), null, "a second with no field");
  assert.equal(T("time", "21:30:00", ["hour", "minute", "ampm"]), null, "a zero second with no second field");
  assert.equal(T("time", "21:30:00", ["hour", "minute", "second", "ampm"]), null, "a zero second with a second field");
  // review-132 note b: an invalid value passes (Playwright's script fails with no event).
  for (const [type, value, fields] of [["date", "2026-02-30", ["month", "day", "year"]], ["date", "2025-02-29", ["month", "day", "year"]], ["date", "2026-13-01", ["month", "day", "year"]],
    ["date", "0000-01-01", ["month", "day", "year"]], ["week", "2025-W53", ["week", "year"]], ["week", "2026-W00", ["week", "year"]], ["time", "24:00", ["hour", "minute"]],
    ["time", "12:60", ["hour", "minute"]], ["datetime-local", "2026-04-31T10:00", ["month", "day", "year", "hour", "minute", "ampm"]]] as const) assert.equal(T(type, value, [...fields]), null, `${type} ${value}`);
  assert.equal(T("date", "2024-02-29", ["month", "day", "year"]), "02292024", "a leap day");
  assert.equal(T("week", "2026-W53", ["week", "year"]), "532026", "2026 has 53 weeks");
  assert.equal(T("date", "26-12-31", ["month", "day", "year"]), null);
  assert.equal(T("date", "2026-12-31", ["month", "day", "year", "hour"]), null, "a field of another form");
  assert.equal(T("color", "#ff0000", []), null);
  assert.deepEqual(pickerKeys("month", "2026-03", ["month", "year"])!.map((k) => k.key), ["0", "3", "ArrowRight", "2", "0", "2", "6"], "a month input's month field does not move on");
  assert.deepEqual(pickerKeys("week", "2026-W05", ["week", "year"])!.map((k) => k.key), ["0", "5", "2", "0", "2", "6"], "a week field moves on");
});

test("the fill of a range input: a click at the value's place on its track, the arrow keys for the rest, then the client's call in SKIP_EVENTS; a step of any, a turned range and the same value pass, counted", async () => {
  const RANGE = (o: object = {}) => ({ tag: "input", type: "range", box: { x: 200, y: 400, width: 300, height: 20 }, value: "50", ...o });
  // Chrome's default thumb: the click alone gives the value.
  const r = await runVector(own([fillCall("r", "80")], { nodes: { r: RANGE() } }));
  const press = mouseEvents(r.tab).find((s) => s.params.type === "mousePressed")!;
  assert.equal(press.params.x, Math.round(200 + RANGE_THUMB_PX / 2 + 0.8 * (300 - RANGE_THUMB_PX)), "the press at the value's place");
  assert.equal(keyEvents(r.tab).length, 0);
  assert.equal(r.tab.scriptValue("r"), "80");
  assert.equal(fnOf(passOf(r.tab, 1)), SKIP_EVENTS(FILL_FN));
  assert.deepEqual(trustedOnly(r.tab), ["input=80", "change=80"]);
  assert.equal(r.stage.counts.rangeSet, 1);
  // A wider thumb of the page's own (40 px): the click gives 83, then three ArrowLeft; a step of 5.
  const w = await runVector(own([fillCall("r", "80")], { nodes: { r: RANGE({ thumb: 40 }) } }));
  assert.deepEqual(downs(w.tab), ["ArrowLeft", "ArrowLeft", "ArrowLeft"]);
  assert.equal(w.tab.scriptValue("r"), "80");
  assert.equal(trustedOnly(w.tab).filter((x) => /untrusted/.test(x)).length, 0);
  const s5 = await runVector(own([fillCall("r", "35")], { nodes: { r: RANGE({ step: 5, thumb: 60 }) } }));
  assert.ok(downs(s5.tab).every((k) => k === "ArrowLeft" || k === "ArrowRight"));
  assert.equal(s5.tab.scriptValue("r"), "35");
  for (const [name, node, value, k] of [["a step of any", RANGE({ step: "any" }), "80", "rangePass:stepAny"], ["a range from right to left", RANGE({ turned: true }), "80", "rangePass:turned"],
    ["the same value", RANGE(), "50", "rangePass:same"], ["no number", RANGE(), "x", "rangePass:noKeys"],
    ["a value out of max (review-132 note b)", RANGE(), "150", "rangePass:value"], ["a value off the step", RANGE(), "50.5", "rangePass:value"],
    ["a value not in Chrome's form", RANGE(), "080", "rangePass:value"], ["aria-disabled (review-132 note a)", RANGE({ ariaDisabled: true }), "80", "rangePass:states"]] as const) {
    const q = await runVector(own([fillCall("r", value)], { nodes: { r: node } }));
    assert.equal(inputEvents(q.tab).length, 0, `${name}: no input of the stage`);
    assert.equal(fnOf(passOf(q.tab, 1)), FILL_FN, `${name}: the call as the client sent it`);
    assert.equal(q.stage.counts[k], 1, `${name}: counted ${k}`);
  }
  assert.equal(RANGE_KEYS_MAX, 10, "C11's RANGE_KEYS_MAX");
  assert.equal(RANGE_THUMB_PX, 16, "C11's RANGE_THUMB_PX");
});

// ================================================================ selectText, focus and blur

test("selectText on a text input with no focus: the focus click, then Control+A (on the Mac Meta+A with the command selectAll), then the call; the field's text is selected", async () => {
  for (const platform of ["linux", "mac"]) {
    const r = await runVector(own([selectTextCall("x")], { nodes: { x: INPUT() } }, { platform }));
    const press = mouseEvents(r.tab).find((s) => s.params.type === "mousePressed")!;
    assert.ok(press, `${platform}: the focus click`);
    const k = keyEvents(r.tab), mod = platform === "linux" ? "Control" : "Meta";
    assert.deepEqual(k.map((s) => `${s.params.type} ${s.params.key}`), [`rawKeyDown ${mod}`, "rawKeyDown a", "keyUp a", `keyUp ${mod}`], `${platform}: the chord`);
    assert.equal(k[1].params.modifiers, platform === "linux" ? CONTROL : META);
    if (platform === "mac") assert.deepEqual(k[1].params.commands, ["selectAll"]);
    assert.ok(k[0].t - mouseEvents(r.tab).at(-1)!.t >= 80 && r.tab.sent.indexOf(passOf(r.tab, 1)) > r.tab.sent.indexOf(k.at(-1)!), `${platform}: the click, a person's pause, the chord, then the call`);
    assert.equal(fnOf(passOf(r.tab, 1)), SELECT_TEXT_FN, `${platform}: the call as the client sent it`);
    assert.equal(r.stage.counts.selectAllKeys, 1);
  }
});

test("selectText: on a field with the focus the chord alone; on a read-only input the click and the chord; on a contenteditable, a div or a disabled input no input, counted", async () => {
  const focused = await runVector(own([selectTextCall("x")], { nodes: { x: INPUT({ focused: true }) }, focused: "x" }));
  assert.equal(mouseEvents(focused.tab).length, 0, "no click");
  assert.deepEqual(downs(focused.tab), ["Control", "a"]);
  const ro = await runVector(own([selectTextCall("x")], { nodes: { x: INPUT({ readOnly: true }) } }));
  assert.ok(mouseEvents(ro.tab).some((s) => s.params.type === "mousePressed"), "read-only: the click");
  assert.deepEqual(downs(ro.tab), ["Control", "a"]);
  for (const [name, node, k] of [["a contenteditable", { tag: "div", contenteditable: true, box: { x: 200, y: 300, width: 300, height: 60 }, text: 5 }, "selectTextNotField"],
    ["a div", { tag: "div", box: { x: 200, y: 300, width: 300, height: 60 } }, "selectTextNotField"], ["a disabled input", INPUT({ disabled: true }), "fieldDisabled"]] as const) {
    const r = await runVector(own([selectTextCall("x")], { nodes: { x: node } }));
    assert.equal(inputEvents(r.tab).length, 0, `${name}: no input of the stage`);
    assert.equal(r.stage.counts[k], 1, `${name}: counted ${k}`);
  }
});

test("board ab-t30.12.3: locator.drop and dispatchEvent (Playwright's scripts in the page's main world, no recognizer's) pass as the client sent them, and the stage counts each (noRecognizer)", async () => {
  for (const id of ["drop", "dispatch-event"]) {
    const v = vec(id);
    const r = await runVector(v);
    assert.equal(inputEvents(r.tab).length, 0, `${id}: no input of the stage`);
    assert.deepEqual(passOf(r.tab, 1).params, v.in[0].params, `${id}: the client's own call`);
    assert.equal(r.stage.counts.noRecognizer, 1, `${id}: counted`);
  }
});

test("blur passes, and the stage counts it; focus on a button passes, counted", async () => {
  const r = await runVector(own([blurCall("x")], { nodes: { x: INPUT({ focused: true }) }, focused: "x" }));
  assert.equal(inputEvents(r.tab).length, 0);
  assert.equal(fnOf(passOf(r.tab, 1)), BLUR_FN);
  assert.equal(r.stage.counts.blurs, 1);
  const f = await runVector(own([focusCall("b")], { nodes: { b: { tag: "button", box: { x: 60, y: 220, width: 80, height: 40 } } } }));
  assert.equal(inputEvents(f.tab).length, 0);
  assert.equal(f.stage.counts.fieldNotText, 1);
});

// ================================================================ the ends of a translated call

test("a dialog that the select's change opens at Enter: the plan ends, the client's call goes in SKIP_EVENTS, and the page gets no second change", async () => {
  const v = own([selectCall("s", byValueOrLabel("d")), { afterEvent: "Page.javascriptDialogOpening", waitMs: 500, method: "Page.handleJavaScriptDialog", params: { accept: true } }], { nodes: { s: SELECT() } });
  const r = await runVector(v, { tab: (t) => { t.opensDialog = (s) => s.method === "Input.dispatchKeyEvent" && s.params.key === "Enter" && s.params.type === "keyDown"; } });
  assert.ok(r.logs.some((l) => /a plan of tab \d+ ended \(a dialog\)/.test(l)), "the plan ended at the dialog");
  assert.equal(fnOf(passOf(r.tab, 1)), SKIP_EVENTS(SELECT_FN), "the call in SKIP_EVENTS");
  assert.deepEqual(trustedOnly(r.tab), ["input=3", "change=3"], "one change: the person's");
  assert.ok(!answerOf(r, 1).body.error);
});

test("the end of the client's session during the select's keys: no more key goes, and the call does not go", async () => {
  const v = own([selectCall("s", byValueOrLabel("f"))], { nodes: { s: SELECT() } });
  let k = 0;
  const r = await runVector(v, { tab: (t) => { t.hook = (s) => { if (s.method === "Input.dispatchKeyEvent" && s.params.type === "rawKeyDown" && ++k === 2) setImmediate(() => t.stage.drop(t.id, "session")); return undefined; }; } });
  assert.ok(downs(r.tab).length <= 2, `at most two keys (${downs(r.tab)})`);
  assert.equal(r.tab.sent.filter((s) => s.pass === 1).length, 0, "the call does not go");
});

// ================================================================ SKIP_EVENTS, run as the page runs it

/** A small DOM in a context of its own: EventTarget, Event (isTrusted false), a select with options and an input. */
function dom() {
  const ctx = vm.createContext({});
  vm.runInContext(`
    class EventTarget { constructor() { this.l = []; } addEventListener(t, f) { this.l.push([t, f]); } dispatchEvent(ev) { for (const [t, f] of this.l) if (t === ev.type) f(ev); return true; } }
    class Event { constructor(type) { this.type = type; } get isTrusted() { return false; } }
    class El extends EventTarget { constructor(tag) { super(); this.localName = tag; this.nodeType = 1; this.isContentEditable = false; this.parentElement = null; }
      matches(q) { return q.split(',').map((x) => x.trim()).includes(this.localName); } closest() { return null; } }
    const select = new El('select'); select.options = ['a', 'b', 'c'].map((v) => ({ value: v, selected: false })); select.options[0].selected = true;
    Object.defineProperty(select, 'value', { get() { return (this.options.find((o) => o.selected) || {}).value; }, set(v) { for (const o of this.options) o.selected = o.value === v; } });
    const input = new El('input'); input.value = '';
    const seen = [];
    for (const el of [select, input]) for (const t of ['input', 'change']) el.addEventListener(t, (e) => seen.push(e.type + ':' + el.localName));
    // Playwright's injected script, as far as these two calls need it (its selectOptions and fill set the value, then send input and change).
    const injected = {
      async checkElementStates() { return undefined; },
      selectOptions(node, want) { node.value = undefined; for (const o of node.options) o.selected = want.some((w) => w.valueOrLabel === o.value); node.dispatchEvent(new Event('input')); node.dispatchEvent(new Event('change')); return node.options.filter((o) => o.selected).map((o) => o.value); },
      fill(node, value) { if (value === 'bad') throw new Error('Malformed value'); node.value = value; node.dispatchEvent(new Event('input')); node.dispatchEvent(new Event('change')); return 'done'; },
    };
    globalThis.t = { select, input, seen, injected, proto: EventTarget.prototype.dispatchEvent, EventTarget };
  `, ctx);
  return ctx as any;
}

test("SKIP_EVENTS runs Playwright's own function: with the value that the stage's input gave, its input and change are skipped and its answer stays; with another value both go; the prototype is the same after, also after a throw", async () => {
  const c = dom();
  const run = (fn: string, args: unknown[]) => vm.runInContext(`(${SKIP_EVENTS(fn)})`, c)(args);
  // The stage's keys selected b: Playwright's selectOptions of b changes nothing, so its events do not go.
  c.t.select.value = "b";
  assert.deepEqual([...(await run(SELECT_FN, [c.t.injected, c.t.select, { optionsToSelect: [{ valueOrLabel: "b" }], force: false, frameVisible: true }]))], ["b"]);
  assert.deepEqual([...c.t.seen], [], "no event: the person's input made them");
  // The keys missed (a is still selected): Playwright's script selects c, and its events go.
  c.t.select.value = "a";
  assert.deepEqual([...(await run(SELECT_FN, [c.t.injected, c.t.select, { optionsToSelect: [{ valueOrLabel: "c" }], force: false, frameVisible: true }]))], ["c"]);
  assert.deepEqual([...c.t.seen], ["input:select", "change:select"]);
  c.t.seen.length = 0;
  // fill: the typed value stays, so no event; another value, both go.
  c.t.input.value = "2026-12-31";
  assert.equal(await run(FILL_FN, [c.t.injected, c.t.input, { value: "2026-12-31", force: false, frameVisible: true }]), "done");
  assert.deepEqual([...c.t.seen], []);
  assert.equal(await run(FILL_FN, [c.t.injected, c.t.input, { value: "2027-01-01", force: false, frameVisible: true }]), "done");
  assert.deepEqual([...c.t.seen], ["input:input", "change:input"]);
  c.t.seen.length = 0;
  // A throw of Playwright's function comes to the caller as it is, and the prototype is Playwright's world's own again.
  await assert.rejects(run(FILL_FN, [c.t.injected, c.t.input, { value: "bad", force: false, frameVisible: true }]), /Malformed value/);
  assert.equal(c.t.EventTarget.prototype.dispatchEvent, c.t.proto, "the prototype is the same after");
  // An event of another element, or a trusted one, goes while the call runs.
  const other = vm.runInContext(`(() => { const o = new (Object.getPrototypeOf(t.input).constructor)('input'); o.value = 'x'; o.addEventListener('input', () => t.seen.push('other')); return o; })()`, c);
  const fn = `async ([injected, node]) => { other.dispatchEvent(new Event('input')); return 'done'; }`;
  c.other = other;
  await run(fn, [c.t.injected, c.t.input, {}]);
  assert.deepEqual([...c.t.seen], ["other"]);
});

test("skipEvents changes only the text of the client's function: the call's other fields and arguments stay", () => {
  const call = selectCall("s", byValueOrLabel("b")).params;
  const w = skipEvents(call);
  assert.equal(w.arguments[3].value, SKIP_EVENTS(SELECT_FN));
  assert.deepEqual({ ...w, arguments: w.arguments.filter((_: unknown, i: number) => i !== 3) }, { ...call, arguments: call.arguments.filter((_: unknown, i: number) => i !== 3) });
  assert.equal(call.arguments[3].value, SELECT_FN, "the client's own params are not changed");
});
