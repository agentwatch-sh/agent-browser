// The input stage in the model (board ab-t30.9; C11 "The input stage": the build switch, the gate, dialogs). With the
// switch off (the default until boards ab-t30.9 to ab-t30.12 are all merged) the relay sends each input call as today:
// unchanged, in the client's order. With the switch on (the model's option, as the tests and the live rows turn it on)
// the stage takes the input calls in the tab's gate, a client's Page.handleJavaScriptDialog goes at once, and the
// stage's events reach Chrome with their timestamps. The fake receiver of fake-bridge.ts stands in for Chrome.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { CDPConnection } from "../src/cdp.ts";
import { Bridge } from "../src/relay/bridge.ts";
import { Model } from "../src/relay/model.ts";
import { STAGE_EVENT_WAIT_MS, STAGE_FLUSH_MS, STAGE_GROUP, STAGE_TEST_ENV, WHEEL_ROOT_AT } from "../src/relay/stage.ts";
import { harness, until, type Harness } from "./fake-bridge.ts";
import { seededRandom } from "../src/human/random.ts";

/** A page of the connection's own (a window of its own), with auto-attach on. */
async function page(h: Harness, c: CDPConnection) {
  await c.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  const attached = c.waitForEvent("Target.attachedToTarget");
  const { targetId } = await c.send("Target.createTarget", { url: "about:blank" });
  const ev = await attached;
  return { targetId, sessionId: ev.sessionId as string, tab: [...h.fake.tabs.values()].find((t) => t.targetId === targetId)! };
}
const cmds = (h: Harness, from = 0) => h.fake.requests.slice(from).filter((r) => r.op === "debugger.sendCommand").map((r) => ({ method: r.args[1] as string, params: r.args[2] }));

/** Playwright's hit-target setup of a click on node 7.3.10 at 100,240 (Playwright 1.65.0's text). */
const SETUP = { functionDeclaration: "(utilityScript, ...args) => utilityScript.evaluate(...args)", objectId: "7.3.1", returnByValue: false, awaitPromise: true, userGesture: true,
  arguments: [{ objectId: "7.3.1" }, { value: true }, { value: false }, { value: "([injected, node, { actionType: actionType2, hitPoint: hitPoint2, trial }]) => injected.setupHitTargetInterceptor(node, actionType2, hitPoint2, trial)" },
    { value: 1 }, { value: { a: [{ h: 0 }, { h: 1 }, { o: [{ k: "actionType", v: "mouse" }, { k: "hitPoint", v: { o: [{ k: "x", v: 100 }, { k: "y", v: 240 }] } }, { k: "trial", v: false }] }] } },
    { objectId: "7.3.2" }, { objectId: "7.3.10" }] };

/** Playwright's focusNode with the caret reset, and fill's call, on node 7.3.18 (Playwright 1.65.0's texts). */
const util = (fn: string, arg: unknown) => ({ functionDeclaration: "(utilityScript, ...args) => utilityScript.evaluate(...args)", objectId: "7.3.1", returnByValue: true, awaitPromise: true, userGesture: true,
  arguments: [{ objectId: "7.3.1" }, { value: true }, { value: true }, { value: fn }, { value: 1 }, { value: { a: [{ h: 0 }, { h: 1 }, arg] } }, { objectId: "7.3.2" }, { objectId: "7.3.18" }] });
/** A retry's script scroll (Playwright 1.65.0's text, the retry scroll recognizer). */
const RETRY = util("([injected, node, options2]) => {\n              if (node.nodeType === 1)\n                node.scrollIntoView({ ...options2, behavior: \"instant\" });\n              return \"done\";\n            }", { o: [{ k: "block", v: "end" }] });
const PW_FOCUS = util("([injected, node, resetSelectionIfNotFocused2]) => injected.focusNode(node, resetSelectionIfNotFocused2)", true);
const PW_FILL = util("async ([injected, node, { value: value3, force, frameVisible: frameVisible2 }]) => {\n            if (!force) {\n              const checkResult = await injected.checkElementStates(node, [\"visible\", \"enabled\", \"editable\", \"non-inert\"], frameVisible2);\n              if (checkResult)\n                return checkResult;\n            }\n            return injected.fill(node, value3);\n          }",
  { o: [{ k: "value", v: "jane.doe@example.com" }, { k: "force", v: false }, { k: "frameVisible", v: true }] });

test("the build switch off (the default): the relay sends each input call as today, unchanged and in the client's order, with no event of its own", async () => {
  const saved = process.env[STAGE_TEST_ENV];
  delete process.env[STAGE_TEST_ENV];
  const h = await harness();
  try {
    assert.equal(h.relay.model.stageOn, false, "the stage is off by default");
    await h.ready();
    const c = await h.connect();
    const p = await page(h, c);
    const from = h.fake.requests.length;
    const calls: [string, any][] = [
      ["Runtime.callFunctionOn", SETUP],
      ["Input.dispatchMouseEvent", { type: "mouseMoved", button: "none", buttons: 0, x: 640.5, y: 360, modifiers: 0, force: 0 }],
      ["Input.dispatchMouseEvent", { type: "mousePressed", button: "left", buttons: 1, x: 640.5, y: 360, modifiers: 0, clickCount: 1, force: 0.5 }],
      ["Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", buttons: 0, x: 640.5, y: 360, modifiers: 0, clickCount: 1 }],
      ["Input.dispatchMouseEvent", { type: "mouseWheel", x: 640, y: 360, deltaX: 0, deltaY: 600, modifiers: 0 }],
      ["Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, modifiers: 8, location: 1 }],
      ["Input.dispatchKeyEvent", { type: "keyUp", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, modifiers: 0, location: 1 }],
      ["Input.insertText", { text: "abc" }],
      // The key and text rows (board ab-t30.10): Playwright's capital with modifiers 0, a char, a chord, the focus and fill
      // calls, a typed-able text, the Delete of clear(): each as the client sent it, with no Shift and no click of the stage.
      ["Runtime.callFunctionOn", PW_FOCUS],
      ["Input.dispatchKeyEvent", { type: "keyDown", modifiers: 0, windowsVirtualKeyCode: 72, code: "KeyH", commands: [], key: "H", text: "H", unmodifiedText: "H", autoRepeat: false, location: 0, isKeypad: false }],
      ["Input.dispatchKeyEvent", { type: "keyUp", modifiers: 0, key: "H", windowsVirtualKeyCode: 72, code: "KeyH", location: 0, isKeypad: false }],
      ["Input.dispatchKeyEvent", { type: "rawKeyDown", modifiers: 0, windowsVirtualKeyCode: 65, code: "KeyA", key: "a" }],
      ["Input.dispatchKeyEvent", { type: "char", modifiers: 0, key: "a", code: "KeyA", text: "a", unmodifiedText: "a", windowsVirtualKeyCode: 65 }],
      ["Input.dispatchKeyEvent", { type: "keyUp", modifiers: 0, key: "a", code: "KeyA", windowsVirtualKeyCode: 65 }],
      ["Input.dispatchKeyEvent", { type: "rawKeyDown", modifiers: 2, windowsVirtualKeyCode: 17, code: "ControlLeft", commands: [], key: "Control", text: "", unmodifiedText: "", autoRepeat: false, location: 1, isKeypad: false }],
      ["Input.dispatchKeyEvent", { type: "rawKeyDown", modifiers: 2, windowsVirtualKeyCode: 65, code: "KeyA", commands: [], key: "A", text: "", unmodifiedText: "", autoRepeat: false, location: 0, isKeypad: false }],
      ["Input.dispatchKeyEvent", { type: "keyUp", modifiers: 2, key: "A", windowsVirtualKeyCode: 65, code: "KeyA", location: 0, isKeypad: false }],
      ["Input.dispatchKeyEvent", { type: "keyUp", modifiers: 0, key: "Control", windowsVirtualKeyCode: 17, code: "ControlLeft", location: 1, isKeypad: false }],
      ["Runtime.callFunctionOn", PW_FILL],
      ["Input.insertText", { text: "jane.doe@example.com" }],
      ["Input.dispatchKeyEvent", { type: "rawKeyDown", modifiers: 0, windowsVirtualKeyCode: 46, code: "Delete", commands: [], key: "Delete", text: "", unmodifiedText: "", autoRepeat: false, location: 0, isKeypad: false }],
      ["Input.dispatchKeyEvent", { type: "keyUp", modifiers: 0, key: "Delete", windowsVirtualKeyCode: 46, code: "Delete", location: 0, isKeypad: false }],
      ["DOM.scrollIntoViewIfNeeded", { objectId: "7.3.10" }],
      // The scroll and wheel rows (board ab-t30.11): a wheel on both axes, a series of small wheels (the residual), a
      // wheel of no delta, a scroll with the call's rect (click({ position })), and a retry's script scroll: each as the
      // client sent it, with no notch, no path and no read of the stage.
      ["Input.dispatchMouseEvent", { type: "mouseWheel", x: 100, y: 200, deltaX: 240, deltaY: -360, modifiers: 0 }],
      ["Input.dispatchMouseEvent", { type: "mouseWheel", x: 100, y: 200, deltaX: 0, deltaY: 100, modifiers: 0 }],
      ["Input.dispatchMouseEvent", { type: "mouseWheel", x: 100, y: 200, deltaX: 0, deltaY: 100, modifiers: 0 }],
      ["Input.dispatchMouseEvent", { type: "mouseWheel", x: 100, y: 200, deltaX: 0, deltaY: 0, modifiers: 0 }],
      ["DOM.scrollIntoViewIfNeeded", { objectId: "7.3.10", rect: { x: 7, y: 9, width: 0, height: 0 } }],
      ["Runtime.callFunctionOn", RETRY],
      ["Page.handleJavaScriptDialog", { accept: true }],
    ];
    await Promise.all(calls.map(([m, params]) => c.send(m, params, p.sessionId)));
    const sent = cmds(h, from).filter((x) => !["Page.createIsolatedWorld", "Runtime.evaluate"].includes(x.method));
    assert.deepEqual(sent, calls.map(([method, params]) => ({ method, params })), "each call as the client sent it, in its order");
    assert.ok(sent.every((x) => x.params.timestamp === undefined), "no timestamp of the stage");
  } finally { await h.close(); if (saved === undefined) delete process.env[STAGE_TEST_ENV]; else process.env[STAGE_TEST_ENV] = saved; }
});

/** A clipboard of the tests: each hold and clear (board ab-t30.19). */
const fakeClipboard = () => { const log: string[] = []; return { log, hold: async (t: string) => { log.push(`hold ${t.length}`); return true; }, clear: () => { log.push("clear"); } }; };
const PRINTABLE = (ch: string) => [
  ["Input.dispatchKeyEvent", { type: "keyDown", modifiers: 0, windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0), code: `Key${ch.toUpperCase()}`, commands: [], key: ch, text: ch, unmodifiedText: ch, autoRepeat: false, location: 0, isKeypad: false }],
  ["Input.dispatchKeyEvent", { type: "keyUp", modifiers: 0, key: ch, windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0), code: `Key${ch.toUpperCase()}`, location: 0, isKeypad: false }],
] as [string, any][];

test("the build switch off (board ab-t30.19): with a clipboard given, a long Input.insertText and a key run of printable keys (Playwright's pressSequentially) go as the client sent them, each in its order with Chrome's own answer, and the clipboard gets no call", async () => {
  const saved = process.env[STAGE_TEST_ENV];
  delete process.env[STAGE_TEST_ENV];
  const clip = fakeClipboard();
  const h = await harness({ clipboard: clip });
  try {
    assert.equal(h.relay.model.stageOn, false);
    await h.ready();
    const c = await h.connect();
    const p = await page(h, c);
    const from = h.fake.requests.length;
    const calls: [string, any][] = [["Input.insertText", { text: "x".repeat(2500) }], ...[..."abcdefghijklmnopqrstuvwxyz".repeat(4)].flatMap(PRINTABLE), ["Input.insertText", { text: "é" }]];
    for (const [m, params] of calls) await c.send(m, params, p.sessionId);
    const sent = cmds(h, from).filter((x) => x.method.startsWith("Input."));
    assert.deepEqual(sent, calls.map(([method, params]) => ({ method, params })), "each call as the client sent it, in its order");
    assert.deepEqual(clip.log, [], "no call of the clipboard");
  } finally { await h.close(); if (saved === undefined) delete process.env[STAGE_TEST_ENV]; else process.env[STAGE_TEST_ENV] = saved; }
});

test("the paste rule's grant (board ab-t30.19; C11, the paste): while a connection holds a grant of the clipboard (clipboardReadWrite or clipboardSanitizedWrite: the content setting clipboard, which acts on the whole profile), the model tells the stage, and a long text goes as one Input.insertText with no clipboard call; after Browser.resetPermissions the stage pastes again", async () => {
  const clip = fakeClipboard();
  const h = await harness({ stage: true, clipboard: clip });
  try {
    await h.ready();
    const c = await h.connect();
    const p = await page(h, c);
    assert.equal(h.relay.model.clipboardGranted(), false);
    for (const name of ["clipboardReadWrite", "clipboardSanitizedWrite"]) {
      await c.send("Browser.grantPermissions", { permissions: [name], origin: "https://a.example" });
      assert.equal(h.relay.model.clipboardGranted(), true, `${name}: a grant of the clipboard`);
      await c.send("Browser.resetPermissions", {});
      assert.equal(h.relay.model.clipboardGranted(), false, `${name}: reset`);
    }
    await c.send("Browser.grantPermissions", { permissions: ["geolocation"] });
    assert.equal(h.relay.model.clipboardGranted(), false, "another permission is no grant of the clipboard");
    await c.send("Browser.grantPermissions", { permissions: ["clipboardReadWrite"], origin: "https://a.example" });
    // A focused input (the stage's own read of the focused element): the fake's world answers it.
    h.fake.command = (_t, method, params) => (method === "Runtime.evaluate" && String(params.expression).includes("__agentBrowserStageField") ? { result: { type: "object", value: { tag: "input", type: "text", editable: false, typing: true, value: "", s: 0, e: 0 } } } : undefined);
    await c.send("Input.insertText", { text: "y".repeat(2500) }, p.sessionId);
    assert.deepEqual(clip.log, [], "no paste while the grant holds");
    assert.equal(h.relay.model.stageCounts()["noPaste:clipboardGrant"], 1);
    assert.ok(cmds(h).some((x) => x.method === "Input.insertText" && x.params.text.length === 2500), "the text as one Input.insertText");
  } finally { await h.close(); }
});

test("review-126 note 2: the stage pastes nothing from a grant's request until the setting is cleared: while Browser.grantPermissions waits for contentSettings.set, and while Browser.resetPermissions and a connection's close wait for contentSettings.clear", async () => {
  const clip = fakeClipboard();
  const h = await harness({ stage: true, clipboard: clip });
  try {
    await h.ready();
    const c = await h.connect();
    await page(h, c);
    let hold: Promise<void> | null = null, open = () => {};
    const stall = () => { hold = new Promise<void>((r) => { open = () => { hold = null; r(); }; }); };
    h.fake.op = async ({ op }) => { if (hold && (op === "contentSettings.set" || op === "contentSettings.clear")) await hold; return undefined; };
    const seen = (op: string, from: number) => h.fake.requests.slice(from).some((r) => r.op === op);
    stall();
    let from = h.fake.requests.length;
    const g = c.send("Browser.grantPermissions", { permissions: ["clipboardReadWrite"], origin: "https://a.example" });
    await until(() => seen("contentSettings.set", from), "the grant's contentSettings.set");
    assert.equal(h.relay.model.clipboardGranted(), true, "a grant counts from its request, before the setting's answer");
    open(); await g;
    assert.equal(h.relay.model.clipboardGranted(), true, "the grant");
    stall();
    from = h.fake.requests.length;
    const rs = c.send("Browser.resetPermissions", {});
    await until(() => seen("contentSettings.clear", from), "the reset's contentSettings.clear");
    assert.equal(h.relay.model.clipboardGranted(), true, "a reset: until the clear's answer");
    open(); await rs;
    assert.equal(h.relay.model.clipboardGranted(), false, "after the clear");
    await c.send("Browser.grantPermissions", { permissions: ["clipboardSanitizedWrite"], origin: "https://a.example" });
    stall();
    from = h.fake.requests.length;
    await c.close();
    await until(() => seen("contentSettings.clear", from), "the close's contentSettings.clear");
    assert.equal(h.relay.model.clipboardGranted(), true, "a connection's close: until the clear's answer");
    open();
    await until(() => h.relay.model.clipboardGranted() === false, "the end of the close's clear");
    assert.deepEqual(clip.log, []);
  } finally { await h.close(); }
});

test("review-126 B3 through the model: the client has the answers of a collected part (pressSequentially), so the part's text goes before the tab's close (Target.closeTarget) and before the detach at the end of the client's session (Target.detachFromTarget, and the connection's close as Playwright's browser.close() over connectOverCDP gives it)", async () => {
  for (const end of ["closeTarget", "detachFromTarget", "close"] as const) {
    const h = await harness({ stage: true });
    try {
      await h.ready();
      const c = await h.connect();
      const p = await page(h, c);
      const from = h.fake.requests.length;
      const word = "hello";
      for (const ch of word) for (const [m, params] of PRINTABLE(ch)) await c.send(m, params, p.sessionId);
      assert.ok(!cmds(h, from).some((x) => x.method.startsWith("Input.")), `${end}: the collected calls have their answers, with no event yet`);
      if (end === "closeTarget") await c.send("Target.closeTarget", { targetId: p.targetId });
      else if (end === "detachFromTarget") await c.send("Target.detachFromTarget", { sessionId: p.sessionId });
      else await c.close();
      const done = end === "closeTarget" ? "tabs.remove" : "debugger.detach";
      await until(() => h.fake.requests.slice(from).some((r) => r.op === done), `${end}: ${done}`);
      const ops = h.fake.requests.slice(from).map((r) => (r.op === "debugger.sendCommand" ? `${r.args[1]}${r.args[1] === "Input.insertText" ? `:${r.args[2].text}` : ""}` : r.op));
      const ins = ops.indexOf(`Input.insertText:${word}`), last = ops.indexOf(done);
      assert.ok(ins >= 0 && ins < last, `${end}: the part's text (${ins}) before ${done} (${last}): ${ops.join(", ")}`);
      assert.equal(h.relay.model.stageCounts().partsFlushed, 1, `${end}: counted`);
    } finally { await h.close(); }
  }
});

test("the build switch: the model is off unless its option or the relay's variable (the live rows) turns it on", () => {
  const saved = process.env[STAGE_TEST_ENV];
  const b = new Bridge(() => {});
  try {
    delete process.env[STAGE_TEST_ENV];
    assert.equal(new Model(b, () => {}).stageOn, false);
    assert.equal(new Model(b, () => {}, { stage: true }).stageOn, true);
    process.env[STAGE_TEST_ENV] = "test";
    assert.equal(new Model(b, () => {}).stageOn, true, "the live rows' variable");
    assert.equal(new Model(b, () => {}, { stage: false }).stageOn, false);
    process.env[STAGE_TEST_ENV] = "1";
    assert.equal(new Model(b, () => {}).stageOn, false, "only the value test");
  } finally { if (saved === undefined) delete process.env[STAGE_TEST_ENV]; else process.env[STAGE_TEST_ENV] = saved; }
});

test("with the stage on: a click becomes a path, a pause, a press and a hold; each event has its timestamp; a Runtime.evaluate after the click waits for the release; the answers come after their events", async () => {
  const h = await harness({ stage: true });
  try {
    await h.ready();
    const c = await h.connect();
    const p = await page(h, c);
    await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", button: "none", buttons: 0, x: 400, y: 300, modifiers: 0 }, p.sessionId);
    const from = h.fake.requests.length, t0 = Date.now();
    const done: string[] = [];
    const go = (m: string, params: any, tag: string) => c.send(m, params, p.sessionId).then(() => done.push(tag));
    await Promise.all([
      go("Input.dispatchMouseEvent", { type: "mouseMoved", button: "none", buttons: 0, x: 700, y: 500, modifiers: 0, force: 0 }, "move"),
      go("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", buttons: 1, x: 700, y: 500, modifiers: 0, clickCount: 1, force: 0.5 }, "press"),
      go("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", buttons: 0, x: 700, y: 500, modifiers: 0, clickCount: 1 }, "release"),
      go("Runtime.evaluate", { expression: "1" }, "evaluate"),
    ]);
    const ms = Date.now() - t0;
    const sent = cmds(h, from).filter((x) => x.method === "Input.dispatchMouseEvent" || x.method === "Runtime.evaluate" && x.params.expression === "1");
    const types = sent.map((x) => x.params.type ?? "evaluate");
    const moves = types.filter((t) => t === "mouseMoved").length;
    assert.ok(moves >= 10, `${moves} moves of a path`);
    assert.deepEqual(types.slice(moves), ["mousePressed", "mouseReleased", "evaluate"], "the press, the release, then the evaluate");
    for (const x of sent.filter((y) => y.method === "Input.dispatchMouseEvent")) {
      assert.equal(typeof x.params.timestamp, "number");
      assert.ok(Math.abs(x.params.timestamp * 1000 - Math.round(x.params.timestamp * 1000)) < 1e-6, "whole ms (Linux)");
    }
    assert.deepEqual(done, ["move", "press", "release", "evaluate"], "the answers in order");
    assert.ok(ms >= 300 + 80 + 60, `a person's time: ${ms} ms`);
  } finally { await h.close(); }
});

test("with the stage on: a client's Page.handleJavaScriptDialog goes to Chrome at once, before the tab's gate and the stage's step that waits", async () => {
  const h = await harness({ stage: true });
  try {
    await h.ready();
    const c = await h.connect();
    const p = await page(h, c);
    // Chrome answers no press while the dialog is open (a confirm() in mousedown); the client answers the dialog.
    let open = false;
    const held: (() => void)[] = [], dropped: string[] = [];
    // Chrome answers input in order: an event after the kept press is answered after it.
    let pressDone: Promise<void> | null = null;
    h.fake.command = (target, method, params) => {
      if (method === "Input.dispatchMouseEvent" && params.type === "mousePressed" && !open) {
        open = true;
        h.fake.emit("debugger.onEvent", { source: { tabId: target.tabId }, method: "Page.javascriptDialogOpening", params: { type: "confirm", message: "Sure?", url: "about:blank", hasBrowserHandler: false, defaultPrompt: "" } });
        const p = new Promise((r) => held.push(() => r({})));
        pressDone = p.then(() => {});
        return p;
      }
      if (method === "Page.handleJavaScriptDialog") {
        open = false;
        setTimeout(() => { for (const r of held.splice(0)) r(); h.fake.emit("debugger.onEvent", { source: { tabId: target.tabId }, method: "Page.javascriptDialogClosed", params: { result: true, userInput: "" } }); }, 5);
        return {};
      }
      // Chrome keeps the press that opened the dialog; it drops an input event that it gets while the dialog is open.
      if (open && method.startsWith("Input.")) { dropped.push(params.type); return {}; }
      if (pressDone && method.startsWith("Input.")) return pressDone.then(() => ({}));
      return undefined;
    };
    const dialog = c.waitForEvent("Page.javascriptDialogOpening", p.sessionId);
    const order: string[] = [];
    const click = Promise.all([
      c.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", buttons: 1, x: 10, y: 10, modifiers: 0, clickCount: 1, force: 0.5 }, p.sessionId).then(() => order.push("press")),
      c.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", buttons: 0, x: 10, y: 10, modifiers: 0, clickCount: 1 }, p.sessionId).then(() => order.push("release")),
    ]);
    await dialog;
    await c.send("Page.handleJavaScriptDialog", { accept: true }, p.sessionId).then(() => order.push("dialog"));
    await click;
    assert.deepEqual(order, ["dialog", "press", "release"], "the dialog's answer first, then Chrome's own answers of the press and the release");
    const sent = cmds(h).map((x) => x.params?.type ?? x.method);
    const d = sent.indexOf("Page.handleJavaScriptDialog");
    assert.ok(d < sent.indexOf("mouseReleased"), "the release waits for the dialog's close: Chrome drops what it gets while the dialog is open");
    assert.deepEqual(dropped, [], "no input event while the dialog is open");
    await until(() => h.relay.model.stageState(p.tab.id)?.action === false, "the lock to be free");
  } finally { await h.close(); }
});

test("with the stage on and the pointer paths on: the window comes forward before the path (C11, the window comes forward for input), and the path starts at the X record of the activation", async () => {
  process.env.AGENT_BROWSER_POINTER_LOG = "1";
  let h: Harness;
  try { h = await harness({ stage: true }); } finally { delete process.env.AGENT_BROWSER_POINTER_LOG; }
  try {
    // A daemon with both pointer ops: the pointer at 640,500 on a 1280 x 900 display (each page's content from y 91).
    let pos = { x: 640, y: 500 };
    h.fake.daemon = ({ op, args }) => {
      if (op === "daemon.pointerAt") return { ...pos, width: 1280, height: 900, views: 0 };
      if (op === "daemon.movePointer") { const last = args[0].path.at(-1); pos = { x: last.x, y: last.y }; return { ...pos, views: 0 }; }
      return { error: "unknown op" };
    };
    await h.ready();
    await until(() => h.relay.model.pointerState().paths === "on", "the paths to turn on");
    const c = await h.connect();
    const A = await page(h, c), B = await page(h, c);
    const move = (p: { sessionId: string }, x: number, y: number) => c.send("Input.dispatchMouseEvent", { type: "mouseMoved", button: "none", buttons: 0, x, y, modifiers: 0 }, p.sessionId);
    await move(A, 100, 100);
    await move(B, 700, 300);
    const from = h.fake.requests.length, l0 = h.logs.length;
    await move(A, 300, 200);
    const ops = h.fake.requests.slice(from).map((r) => (r.op === "debugger.sendCommand" ? `${r.args[1]} ${r.args[2]?.type ?? ""}`.trim() : r.op));
    const raise = ops.indexOf("windows.update"), firstMove = ops.indexOf("Input.dispatchMouseEvent mouseMoved");
    assert.ok(raise >= 0 && firstMove > raise, `the raise before the path's first move: ${ops.slice(0, 12).join(", ")}`);
    assert.ok(h.logs.slice(l0).some((l) => /^relay: step input of tab \d+: a path of \d+ points, ok/.test(l)), "the activation played its X path");
    // The X path ended at A's last point (100,100): the stage's path starts there, one step away at most.
    const first = h.fake.requests.slice(from).find((r) => r.op === "debugger.sendCommand" && r.args[1] === "Input.dispatchMouseEvent")!.args[2];
    assert.ok(Math.hypot(first.x - 100, first.y - 100) <= 60, `the path from the recorded point: ${first.x},${first.y}`);
  } finally { await h!.close(); }
});

test("with the stage on: a client's Page.handleJavaScriptDialog does not wait behind the tab's input that waits for the input lock (another tab's action holds it)", async () => {
  const h = await harness({ stage: true });
  try {
    await h.ready();
    const c = await h.connect();
    const A = await page(h, c), B = await page(h, c);
    // B's client holds a button: B's action keeps the input lock (until STAGE_ACTION_MAX_MS).
    await c.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", buttons: 1, x: 10, y: 10, modifiers: 0, clickCount: 1, force: 0.5 }, B.sessionId);
    // A's client moves: its step waits for the lock in A's gate. A page script of A opened a dialog; A's client answers it.
    void c.send("Input.dispatchMouseEvent", { type: "mouseMoved", button: "none", buttons: 0, x: 300, y: 200, modifiers: 0 }, A.sessionId).catch(() => {});
    await new Promise((r) => setTimeout(r, 100));
    const t0 = Date.now();
    await c.send("Page.handleJavaScriptDialog", { accept: true }, A.sessionId);
    assert.ok(Date.now() - t0 < 1000, `the dialog's answer at once (${Date.now() - t0} ms), not after B's action`);
    assert.ok(cmds(h).some((x) => x.method === "Page.handleJavaScriptDialog"));
    assert.ok(!cmds(h).some((x) => x.method === "Input.dispatchMouseEvent" && x.params.type === "mouseMoved" && x.params.x === 300), "A's move still waits for the lock");
  } finally { await h.close(); }
});

// ---- review-116, round 1 (the model's part)

const FOCUS = { functionDeclaration: "(utilityScript, ...args) => utilityScript.evaluate(...args)", objectId: "9.1.1", returnByValue: true, awaitPromise: true, userGesture: true,
  arguments: [{ objectId: "9.1.1" }, { value: true }, { value: true }, { value: "([injected, node, resetSelectionIfNotFocused2]) => injected.focusNode(node, resetSelectionIfNotFocused2)" }, { value: 1 },
    { value: { a: [{ h: 0 }, { h: 1 }, true] } }, { objectId: "9.1.2" }, { objectId: "9.1.3" }] };

test("review B3 through the model: A holds the lock; B's move waits for it; B's focus call and A's focus call wait in the activation chain; A's release behind them: at STAGE_ACTION_MAX_MS the lock frees, and every call ends", async () => {
  // The stage's clock: the real one, with STAGE_ACTION_MAX_MS of 300 ms (the test's own value).
  const { stageClock: real, STAGE_ACTION_MAX_MS } = await import("../src/relay/stage.ts");
  const clock = { ...real, timer: (ms: number, fn: () => void) => real.timer(ms === STAGE_ACTION_MAX_MS ? 300 : ms, fn) };
  const h = await harness({ stage: true });
  (h.relay.model as any).stage.clock = clock;
  try {
    await h.ready();
    const c = await h.connect();
    const A = await page(h, c), B = await page(h, c);
    const done: string[] = [];
    const go = (p: { sessionId: string }, m: string, params: any, tag: string) => c.send(m, params, p.sessionId).then(() => done.push(tag), () => done.push(`${tag}!`));
    void go(A, "Input.dispatchMouseEvent", { type: "mousePressed", button: "left", buttons: 1, x: 10, y: 10, modifiers: 0, clickCount: 1, force: 0.5 }, "A press");
    await new Promise((r) => setTimeout(r, 50));
    void go(B, "Input.dispatchMouseEvent", { type: "mouseMoved", button: "none", buttons: 0, x: 300, y: 200, modifiers: 0 }, "B move");
    void go(B, "Runtime.callFunctionOn", FOCUS, "B focus");
    void go(A, "Runtime.callFunctionOn", FOCUS, "A focus");
    void go(A, "Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", buttons: 0, x: 10, y: 10, modifiers: 0, clickCount: 1 }, "A release");
    await until(() => done.length === 5, "every call to end", 15_000);
    await until(() => h.relay.model.stageState(A.tab.id)?.action === false && h.relay.model.stageState(B.tab.id)?.action === false, "the lock to be free");
  } finally { await h.close(); }
});

test("review N2: the stage's own sends go as the model's: a move with a button down and no force gets force 0.5; a command that reaches C10's timeout detaches the tab", async () => {
  const h = await harness({ stage: true });
  try {
    await h.ready();
    const c = await h.connect();
    const p = await page(h, c);
    await c.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", buttons: 1, x: 10, y: 10, modifiers: 0, clickCount: 1 }, p.sessionId);
    const from = h.fake.requests.length;
    await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", button: "left", buttons: 1, x: 20, y: 10, modifiers: 0 }, p.sessionId);
    const moved = cmds(h, from).find((x) => x.method === "Input.dispatchMouseEvent" && x.params.type === "mouseMoved")!;
    assert.equal(moved.params.force, 0.5, "withForce, as on main");
    h.fake.command = (_t, method, params) => (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased" ? { error: "timeout" } : undefined);
    const before = h.fake.sent("debugger.detach").length;
    await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", buttons: 0, x: 20, y: 10, modifiers: 0, clickCount: 1 }, p.sessionId).catch(() => {});
    await until(() => h.fake.sent("debugger.detach").length > before, "the tab's detach after the timeout");
  } finally { await h.close(); }
});

test("review N5: with no Page.javascriptDialogClosed, Chrome's answer to the client's Page.handleJavaScriptDialog ends the wait: the held release goes", async () => {
  const h = await harness({ stage: true });
  try {
    await h.ready();
    const c = await h.connect();
    const p = await page(h, c);
    let open = false;
    h.fake.command = (target, method, params) => {
      if (method === "Input.dispatchMouseEvent" && params.type === "mousePressed" && !open) {
        open = true;
        h.fake.emit("debugger.onEvent", { source: { tabId: target.tabId }, method: "Page.javascriptDialogOpening", params: { type: "confirm", message: "Sure?", url: "about:blank", hasBrowserHandler: false, defaultPrompt: "" } });
        return new Promise((r) => setTimeout(() => r({}), 300));
      }
      if (method === "Page.handleJavaScriptDialog") { open = false; return {}; } // no Closed event
      return undefined;
    };
    const dialog = c.waitForEvent("Page.javascriptDialogOpening", p.sessionId);
    const click = Promise.all([
      c.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", buttons: 1, x: 10, y: 10, modifiers: 0, clickCount: 1, force: 0.5 }, p.sessionId),
      c.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", buttons: 0, x: 10, y: 10, modifiers: 0, clickCount: 1 }, p.sessionId),
    ]);
    await dialog;
    await c.send("Page.handleJavaScriptDialog", { accept: true }, p.sessionId);
    await Promise.race([click, new Promise((_, j) => setTimeout(() => j(new Error("the release never went")), 3000))]);
    assert.ok(cmds(h).some((x) => x.params?.type === "mouseReleased"));
  } finally { await h.close(); }
});

// ---- review-116b (the narrow re-check) and the daemon lead's point (the model's part)

const MOVE = (x: number, y: number) => ({ type: "mouseMoved", button: "none", buttons: 0, x, y, modifiers: 0 });
const PRESS = (x: number, y: number) => ({ type: "mousePressed", button: "left", buttons: 1, x, y, modifiers: 0, clickCount: 1, force: 0.5 });
const RELEASE = (x: number, y: number) => ({ type: "mouseReleased", button: "left", buttons: 0, x, y, modifiers: 0, clickCount: 1 });
const ALERT = { type: "alert", message: "hi", url: "about:blank", hasBrowserHandler: false, defaultPrompt: "" };

/**
 * A fake Chrome whose tab `tabId` opens an alert at the fifth move after `arm()` (a mouseover handler on the path): while
 * it is open, Chrome answers each input event of that tab at once and drops it.
 */
function alertOnPath(h: Harness, tabId: () => number, extra: (target: any, method: string, params: any) => any = () => undefined) {
  const s = { armed: false, open: false, moves: 0 };
  h.fake.command = (target, method, params) => {
    const x = extra(target, method, params);
    if (x !== undefined) return x;
    if (target.tabId !== tabId() || !method.startsWith("Input.")) return undefined;
    if (s.open) return {};
    if (s.armed && method === "Input.dispatchMouseEvent" && params.type === "mouseMoved" && ++s.moves === 5) {
      s.open = true;
      h.fake.emit("debugger.onEvent", { source: { tabId: target.tabId }, method: "Page.javascriptDialogOpening", params: ALERT });
    }
    return undefined;
  };
  return s;
}

test("review-116b R1 case 1 through the model: locator.click's move, press and release in one tick, an alert in a mouseover on the path, the tab dropped before the close by each drop path: no call waits for ever, and the next tab's input goes", async () => {
  for (const path of ["the session's end", "the tab's close", "Chrome's detach", "a C10 timeout's detach"]) {
    const h = await harness({ stage: true });
    try {
      await h.ready();
      const c = await h.connect();
      const A = await page(h, c), B = await page(h, c);
      const s = alertOnPath(h, () => A.tab.id, (_t, method) => (path === "a C10 timeout's detach" && method === "Page.handleJavaScriptDialog" ? { error: "timeout" } : undefined));
      await c.send("Input.dispatchMouseEvent", MOVE(100, 100), A.sessionId);
      s.armed = true;
      const dialog = c.waitForEvent("Page.javascriptDialogOpening", A.sessionId);
      const got: string[] = [];
      const a = (params: any, tag: string) => c.send("Input.dispatchMouseEvent", params, A.sessionId, 4000).then(() => got.push(tag), (e) => { if (!/no response/.test(e.message)) got.push(`${tag}!`); });
      const click = Promise.all([a(MOVE(900, 600), "move"), a(PRESS(900, 600), "press"), a(RELEASE(900, 600), "release")]);
      await dialog;
      // The drop, before the close.
      if (path === "the session's end") await c.send("Target.detachFromTarget", { sessionId: A.sessionId });
      else if (path === "the tab's close") { h.fake.attached.delete(A.tab.id); h.fake.tabs.delete(A.tab.id); h.fake.emit("tabs.onRemoved", { tabId: A.tab.id, removeInfo: { windowId: 1, isWindowClosing: false } }); }
      else if (path === "Chrome's detach") { h.fake.attached.delete(A.tab.id); h.fake.emit("debugger.onDetach", { source: { tabId: A.tab.id }, reason: "canceled_by_user" }); }
      else await c.send("Page.handleJavaScriptDialog", { accept: true }, A.sessionId).catch(() => {});
      // The next tab's input goes.
      const t0 = Date.now();
      await Promise.race([
        Promise.all([c.send("Input.dispatchMouseEvent", MOVE(300, 200), B.sessionId), c.send("Input.dispatchMouseEvent", PRESS(300, 200), B.sessionId), c.send("Input.dispatchMouseEvent", RELEASE(300, 200), B.sessionId)]),
        new Promise((_, j) => setTimeout(() => j(new Error(`${path}: B's click waits for ever`)), 5000)),
      ]);
      assert.ok(Date.now() - t0 < 5000);
      await click;
      if (path === "the session's end" || path === "a C10 timeout's detach") assert.deepEqual(got, [], `${path}: nothing goes back to the session that ended`);
      else assert.deepEqual(got.sort(), ["move!", "press!", "release!"], `${path}: each of A's calls gets Chrome's error`);
      await until(() => (h.relay.model as any).stage.lock.held === 0, `${path}: the lock to be free`);
    } finally { await h.close(); }
  }
});

test("review-116b R1 case 2 through the model: the cycle of focus calls across two tabs (A's move, A's focus call, B's focus call, B's move, B's focus call, A's press, A's focus call, A's release; an alert on A's path): every call ends and the lock goes free", async () => {
  // The stage's clock: the real one, with STAGE_ACTION_MAX_MS of 300 ms (the test's own value).
  const { stageClock: real, STAGE_ACTION_MAX_MS } = await import("../src/relay/stage.ts");
  const clock = { ...real, timer: (ms: number, fn: () => void) => real.timer(ms === STAGE_ACTION_MAX_MS ? 300 : ms, fn) };
  const h = await harness({ stage: true });
  (h.relay.model as any).stage.clock = clock;
  try {
    await h.ready();
    const c = await h.connect();
    const A = await page(h, c), B = await page(h, c);
    const s = alertOnPath(h, () => A.tab.id);
    await c.send("Input.dispatchMouseEvent", MOVE(100, 100), A.sessionId);
    s.armed = true;
    const dialog = c.waitForEvent("Page.javascriptDialogOpening", A.sessionId);
    const done: string[] = [];
    const go = (p: { sessionId: string }, m: string, params: any, tag: string) => { void c.send(m, params, p.sessionId, 20_000).then(() => done.push(tag), () => done.push(`${tag}!`)); };
    go(A, "Input.dispatchMouseEvent", MOVE(900, 600), "A move");
    go(A, "Runtime.callFunctionOn", FOCUS, "A focus 1");
    go(B, "Runtime.callFunctionOn", FOCUS, "B focus 2");
    go(B, "Input.dispatchMouseEvent", MOVE(300, 200), "B move");
    go(B, "Runtime.callFunctionOn", FOCUS, "B focus 3");
    go(A, "Input.dispatchMouseEvent", PRESS(900, 600), "A press");
    go(A, "Runtime.callFunctionOn", FOCUS, "A focus 4");
    go(A, "Input.dispatchMouseEvent", RELEASE(900, 600), "A release");
    await dialog;
    s.open = false;
    await c.send("Page.handleJavaScriptDialog", { accept: true }, A.sessionId);
    h.fake.emit("debugger.onEvent", { source: { tabId: A.tab.id }, method: "Page.javascriptDialogClosed", params: { result: true, userInput: "" } });
    // The cycle: A's focus call 4 waits for B's focus call 3 (the activation chain), which waits for B's move (B's gate),
    // which waits for the lock that A's ended events took again, which A's release (behind A's focus call 4) would free.
    // The taken lock's limit breaks it.
    await until(() => done.length === 8, `every call to end (${done.join(", ")})`, 15_000);
    await until(() => (h.relay.model as any).stage.lock.held === 0, "the lock to be free");
  } finally { await h.close(); }
});

// Board ab-t30.17, point 1: "a navigation's close" is Chrome's Page.frameStartedNavigating of the main frame, then its
// Page.javascriptDialogClosed (result false) with no Page.frameNavigated before it (the order measured on Chromium 156);
// "an accepted beforeunload" is the client's Page.handleJavaScriptDialog with accept true (the model's close has its result).
test("review-116b: the model gives the stage the client's Page.disable and Chrome's Page.frameNavigated and Inspector.targetCrashed: each ends the wait for a dialog's close (a press opened it); and a navigation's close (board ab-t30.17)", async () => {
  for (const signal of ["Page.disable", "Page.frameNavigated", "Inspector.targetCrashed", "a navigation's close", "an accepted beforeunload"]) {
    const h = await harness({ stage: true });
    try {
      await h.ready();
      const c = await h.connect();
      const p = await page(h, c);
      let open = false;
      const kept: (() => void)[] = [];
      // The main frame's id is the tab's target id, as in Chrome (review-136 notes 1 and 2: the model gives the stage the tab's targetId).
      h.fake.command = (target, method, params) => {
        if (method === "Input.dispatchMouseEvent" && params.type === "mousePressed" && !open) {
          open = true;
          h.fake.emit("debugger.onEvent", { source: { tabId: target.tabId }, method: "Page.javascriptDialogOpening", params: { type: signal === "an accepted beforeunload" ? "beforeunload" : "confirm", message: "Sure?", url: "about:blank", frameId: p.tab.targetId, hasBrowserHandler: false, defaultPrompt: "" } });
          return new Promise((r) => kept.push(() => r({})));
        }
        return undefined;
      };
      const dialog = c.waitForEvent("Page.javascriptDialogOpening", p.sessionId);
      let release = "";
      const click = Promise.all([
        c.send("Input.dispatchMouseEvent", PRESS(10, 10), p.sessionId, 4000).catch(() => {}),
        c.send("Input.dispatchMouseEvent", RELEASE(10, 10), p.sessionId, 4000).then(() => { release = "ok"; }, (e) => { release = e.message; }),
      ]);
      await dialog;
      await new Promise((r) => setTimeout(r, 50));
      const from = h.fake.requests.length;
      if (signal === "Page.disable") await c.send("Page.disable", {}, p.sessionId);
      else if (signal === "a navigation's close") {
        h.fake.emit("debugger.onEvent", { source: { tabId: p.tab.id }, method: "Page.frameStartedNavigating", params: { frameId: p.tab.targetId, url: "about:blank#next", loaderId: "L2", navigationType: "differentDocument" } });
        h.fake.emit("debugger.onEvent", { source: { tabId: p.tab.id }, method: "Page.javascriptDialogClosed", params: { frameId: p.tab.targetId, result: false, userInput: "" } });
      } else if (signal === "an accepted beforeunload") await c.send("Page.handleJavaScriptDialog", { accept: true }, p.sessionId);
      else h.fake.emit("debugger.onEvent", { source: { tabId: p.tab.id }, method: signal, params: signal === "Page.frameNavigated" ? { frame: { id: "main", loaderId: "L2", url: "about:blank#next" } } : {} });
      await until(() => cmds(h, from).some((x) => x.params?.type === "mouseReleased"), `${signal}: a release after the signal (the wait ended)`, 3000);
      if (signal === "Page.disable") {
        // Board ab-t30.17, point 2: the client's Page.disable goes to Chrome before the tab's gate (the held release waits
        // there for the close), and right after it sends the Page.disable the stage reads the page (in the relay's world) to
        // learn of the close (review-136 note 10: it does not wait for Chrome's answer).
        const sent = cmds(h, from), d = sent.findIndex((x) => x.method === "Page.disable"), r = sent.findIndex((x) => x.params?.type === "mouseReleased");
        assert.ok(d >= 0 && d < r, `the client's Page.disable (${d}) before the release (${r})`);
        assert.ok(sent.slice(d, r).some((x) => x.method === "Runtime.evaluate" && x.params?.expression === "(() => 0)()"), "the stage's read between them");
      }
      for (const k of kept.splice(0)) k();
      await click;
      if (signal === "Page.frameNavigated" || signal === "a navigation's close" || signal === "an accepted beforeunload") assert.match(release, /context/i, `${signal}: at a navigation the held release gets the error that the context is gone`);
      else assert.equal(release, "ok", `${signal}: the held release goes and gets Chrome's answer`);
      await until(() => (h.relay.model as any).stage.lock.held === 0, `${signal}: the lock to be free`);
    } finally { await h.close(); }
  }
});

// Board ab-t30.17, point 2, measured on Chromium 156: Chrome answers a client's Page.disable while a dialog is open only
// after the dialog's close (its dialog manager keeps the dialog; another session's Page.handleJavaScriptDialog closed it
// 3.5 s later), and a read of the page waits for the close too.
test("board ab-t30.17 point 2 (the measured order): Chrome answers the client's Page.disable only after the dialog's close: the model sends it before the tab's gate, and the held release goes after that answer, not at the Page.disable", async () => {
  const h = await harness({ stage: true });
  try {
    await h.ready();
    const c = await h.connect();
    const p = await page(h, c);
    let open = false;
    const kept: (() => void)[] = [];
    h.fake.command = (target, method, params) => {
      if (method === "Input.dispatchMouseEvent" && params.type === "mousePressed" && !open) {
        open = true;
        h.fake.emit("debugger.onEvent", { source: { tabId: target.tabId }, method: "Page.javascriptDialogOpening", params: { type: "confirm", message: "Sure?", url: "about:blank", frameId: "main", hasBrowserHandler: false, defaultPrompt: "" } });
        return new Promise((r) => kept.push(() => r({})));
      }
      // While the dialog is open, Chrome answers Page.disable and a read of the page only after the close.
      if (open && (method === "Page.disable" || method === "Runtime.evaluate")) return new Promise((r) => kept.push(() => r(method === "Runtime.evaluate" ? { result: { type: "number", value: 0 } } : {})));
      return undefined;
    };
    const dialog = c.waitForEvent("Page.javascriptDialogOpening", p.sessionId);
    let release = "";
    const click = Promise.all([
      c.send("Input.dispatchMouseEvent", PRESS(10, 10), p.sessionId, 8000).catch(() => {}),
      c.send("Input.dispatchMouseEvent", RELEASE(10, 10), p.sessionId, 8000).then(() => { release = "ok"; }, (e) => { release = e.message; }),
    ]);
    await dialog;
    await new Promise((r) => setTimeout(r, 50));
    const from = h.fake.requests.length;
    let disabled = false;
    const disable = c.send("Page.disable", {}, p.sessionId, 8000).then(() => { disabled = true; });
    await until(() => cmds(h, from).some((x) => x.method === "Page.disable"), "the client's Page.disable goes to Chrome before the tab's gate", 3000);
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(!disabled && !cmds(h, from).some((x) => x.params?.type === "mouseReleased"), "no release while the dialog is open (Chrome would drop it)");
    // The dialog closes (another session answers it): Chrome answers the press, the Page.disable and the reads.
    open = false;
    for (const k of kept.splice(0)) k();
    await disable;
    await until(() => cmds(h, from).some((x) => x.params?.type === "mouseReleased"), "the release after the close", 3000);
    for (const k of kept.splice(0)) k();
    await click;
    assert.equal(release, "ok", "the held release goes and gets Chrome's answer");
    await until(() => (h.relay.model as any).stage.lock.held === 0, "the lock to be free");
  } finally { await h.close(); }
});

test("with the stage on (board ab-t30.10): keyboard.type('Hi') through the model gets a Shift press and H with modifiers 8; when the last keyUp is answered early, a Runtime.evaluate after it waits in the tab's gate until that keyUp went (the model asks the stage before each call that it does not take)", async () => {
  const kd = (ch: string, code: string, kc: number) => ({ type: "keyDown", modifiers: 0, windowsVirtualKeyCode: kc, code, commands: [], key: ch, text: ch, unmodifiedText: ch, autoRepeat: false, location: 0, isKeypad: false });
  const ku = (ch: string, code: string, kc: number) => ({ type: "keyUp", modifiers: 0, key: ch, windowsVirtualKeyCode: kc, code, location: 0, isKeypad: false });
  let early = 0;
  // Seeded runs (the model's random): the early answer of the last keyUp depends on the draws.
  for (let seed = 1; seed <= 12 && early === 0; seed++) {
    const h = await harness({ stage: true, random: seededRandom(seed) });
    try {
      await h.ready();
      const c = await h.connect();
      const p = await page(h, c);
      const from = h.fake.requests.length;
      for (const [ch, code, kc] of [["H", "KeyH", 72], ["i", "KeyI", 73]] as const) {
        await c.send("Input.dispatchKeyEvent", kd(ch, code, kc), p.sessionId);
        await c.send("Input.dispatchKeyEvent", ku(ch, code, kc), p.sessionId);
      }
      // At the answer of i's keyUp: has its keyUp gone? (no: an early answer)
      const lastUpGone = cmds(h, from).some((x) => x.method === "Input.dispatchKeyEvent" && x.params.type === "keyUp" && x.params.key === "i");
      await c.send("Runtime.evaluate", { expression: "2" }, p.sessionId);
      const sent = cmds(h, from).filter((x) => x.method === "Input.dispatchKeyEvent" || (x.method === "Runtime.evaluate" && x.params.expression === "2"));
      const keys = sent.filter((x) => x.method === "Input.dispatchKeyEvent");
      assert.deepEqual(keys.map((x) => [x.params.type, x.params.key, x.params.modifiers]),
        [["rawKeyDown", "Shift", 8], ["keyDown", "H", 8], ["keyUp", "H", 8], ["keyUp", "Shift", 0], ["keyDown", "i", 0], ["keyUp", "i", 0]]);
      assert.ok(keys.every((x) => typeof x.params.timestamp === "number"), "each key event has the stage's timestamp");
      assert.equal(sent.at(-1)!.params.expression, "2", `seed ${seed}: the evaluate after every key event`);
      if (!lastUpGone) early++;
    } finally { await h.close(); }
  }
  assert.ok(early > 0, "a seed whose last keyUp is answered early");
});

test("with the stage on (board ab-t30.11): mouse.wheel(0, 360) through the model gives three notches of 120 px at the page's last point, each with its timestamp, 35 to 90 ms apart, and the answer after the last; the stage's host resolves a node of the top page into the relay's own world (DOM.resolveNode with that world's context)", async () => {
  const h = await harness({ stage: true });
  try {
    await h.ready();
    const c = await h.connect();
    const p = await page(h, c);
    await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", button: "none", buttons: 0, x: 400, y: 300, modifiers: 0 }, p.sessionId);
    const from = h.fake.requests.length;
    await c.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 400, y: 300, deltaX: 0, deltaY: 360, modifiers: 0 }, p.sessionId);
    const wheels = cmds(h, from).filter((x) => x.method === "Input.dispatchMouseEvent");
    assert.deepEqual(wheels.map((x) => [x.params.type, x.params.x, x.params.y, x.params.deltaX, x.params.deltaY]), Array(3).fill(["mouseWheel", 400, 300, 0, 120]));
    assert.ok(wheels.every((x) => typeof x.params.timestamp === "number" && Math.abs(x.params.timestamp * 1000 - Math.round(x.params.timestamp * 1000)) < 1e-6), "whole-ms timestamps");
    const t = wheels.map((x) => x.params.timestamp * 1000);
    for (let i = 1; i < t.length; i++) assert.ok(t[i] - t[i - 1] >= 35 - 3 && t[i] - t[i - 1] <= 90 + 10, `a gap of ${t[i] - t[i - 1]} ms`);
    // The stage's host: a node of the top page resolved into the relay's own world.
    let resolved: any = null;
    h.fake.command = (_target, method, params) => (method === "DOM.resolveNode" ? ((resolved = params), { object: { type: "object", subtype: "node", objectId: "own-1" } }) : undefined);
    const host = (h.relay.model as any).stagePage((h.relay.model as any).tabs.get(p.tab.id));
    assert.equal(await host.ownNode(900), "own-1");
    const worlds = cmds(h).filter((x) => x.method === "Page.createIsolatedWorld");
    assert.ok(resolved && resolved.backendNodeId === 900 && Number.isInteger(resolved.executionContextId) && worlds.length > 0, "DOM.resolveNode into the relay's own world");
    // review-122 (the lead's option b): a handle of the relay's own world for rule 2 of mouse.wheel's column, in the stage's group.
    let evaluated: any = null;
    h.fake.command = (_target, method, params) => (method === "Runtime.evaluate" && params?.returnByValue === false ? ((evaluated = params), { result: { type: "object", subtype: "node", objectId: "own-2" } }) : undefined);
    assert.equal(await host.ownObject(WHEEL_ROOT_AT, [0]), "own-2");
    assert.ok(evaluated && evaluated.contextId === resolved.executionContextId && evaluated.objectGroup === STAGE_GROUP && evaluated.expression === `(${WHEEL_ROOT_AT})(0)`, "the relay's own world, by handle, in the stage's group");
  } finally { await h.close(); }
});

// ------------------------------------------------------------------ review-126b R3, R4 and R5

/** Each op that the model gives the bridge, at the time of the call (before the receiver reads it). */
function bridgeCalls(h: Harness): string[] {
  const bridge = (h.relay.model as any).bridge, call = bridge.call.bind(bridge), sent: string[] = [];
  bridge.call = (op: string, ...rest: unknown[]) => { sent.push(op); return call(op, ...rest); };
  return sent;
}

test("review-126b R3: with the build switch off, the end of a tab's last session and Target.closeTarget go in the same turn as before the stage: a Target.detachFromTarget and a Target.attachToTarget of the same tab in one read (ws gives both messages of one read at once, and the endpoint gives each to the model at once) detach the tab and attach it again for the new session; a Target.closeTarget sends tabs.remove at once", async () => {
  const h = await harness();
  try {
    await h.ready();
    const c = await h.connect();
    const p = await page(h, c);
    const model = h.relay.model as any;
    assert.equal(model.stage, null, "the switch is off: no stage");
    const conn = [...model.conns][0];
    const sent = bridgeCalls(h);
    // One read: both messages reach the model in one turn, as endpoint.ts gives them.
    const d = model.onMessage(conn, { id: 9001, method: "Target.detachFromTarget", params: { sessionId: p.sessionId } });
    assert.deepEqual(sent, ["debugger.detach"], "the detach goes in the message's own turn (no flush, no extra turn)");
    const a = model.onMessage(conn, { id: 9002, method: "Target.attachToTarget", params: { targetId: p.targetId, flatten: true } });
    assert.deepEqual(sent, ["debugger.detach", "debugger.attach"], "the attach finds the tab detached and attaches it again");
    await Promise.all([d, a]);
    const tab = model.tabs.get(p.tab.id);
    const sid = [...tab.sessions][0];
    assert.ok(tab.attached && h.fake.attached.has(p.tab.id), "the tab is attached");
    assert.ok(sid && sid !== p.sessionId && conn.sessions.get(sid)?.tabId === p.tab.id && tab.owner === conn, "the new session points at the attached tab, which the connection owns");
    const before = h.fake.requests.length;
    await c.send("Runtime.evaluate", { expression: "1" }, sid);
    assert.ok(h.fake.requests.slice(before).some((r) => r.op === "debugger.sendCommand" && r.args[1] === "Runtime.evaluate"), "a call on the new session reaches Chrome");
    sent.length = 0;
    const cl = model.onMessage(conn, { id: 9003, method: "Target.closeTarget", params: { targetId: p.targetId } });
    assert.deepEqual(sent, ["tabs.remove"], "Target.closeTarget sends tabs.remove in the message's own turn");
    await cl;
  } finally { await h.close(); }
});

test("review-126b R4: while the model ends the sessions of a closed connection that holds a grant of the clipboard, the grant counts (the stage pastes nothing) from before the connection leaves the model's set until the close's rebuild has cleared the setting", async () => {
  const clip = fakeClipboard();
  const h = await harness({ stage: true, clipboard: clip });
  try {
    await h.ready();
    const c = await h.connect();
    await page(h, c);
    await c.send("Browser.grantPermissions", { permissions: ["clipboardReadWrite"], origin: "https://a.example" });
    assert.equal(h.relay.model.clipboardGranted(), true, "the grant");
    let open = () => {};
    const held = new Promise<void>((r) => { open = r; });
    let stall = true;
    h.fake.op = async ({ op }) => { if (stall && op === "debugger.detach") await held; return undefined; };
    const from = h.fake.requests.length;
    const seen = (op: string) => h.fake.requests.slice(from).some((r) => r.op === op);
    await c.close();
    await until(() => seen("debugger.detach"), "the close's detach of the connection's tab");
    assert.equal((h.relay.model as any).conns.size, 0, "the connection has left the model's set");
    assert.equal(h.relay.model.clipboardGranted(), true, "while the model ends the closed connection's sessions, the grant counts");
    stall = false;
    open();
    await until(() => seen("contentSettings.clear"), "the close's contentSettings.clear");
    await until(() => h.relay.model.clipboardGranted() === false, "the end of the close's rebuild");
    assert.equal((h.relay.model as any).clipboardBusy, 0, "no count stays behind");
    assert.deepEqual(clip.log, []);
  } finally { await h.close(); }
});

test("review-126b R5: a flush that never ends (another holder keeps the input lock, or the page never answers): Target.closeTarget's tabs.remove, and the debugger.detach at the end of the client's last session (Target.detachFromTarget, and the connection's close), go after STAGE_FLUSH_MS, with the log line", { timeout: 30_000 }, async () => {
  await Promise.all((["closeTarget", "detachFromTarget", "close"] as const).map(async (end) => {
    const h = await harness({ stage: true });
    try {
      await h.ready();
      const c = await h.connect();
      const p = await page(h, c);
      const model = h.relay.model as any;
      model.stagePage(model.tabs.get(p.tab.id));
      let flushes = 0;
      model.stage.flush = () => { flushes++; return new Promise<void>(() => {}); };
      const from = h.fake.requests.length;
      const t0 = Date.now();
      const done = end === "closeTarget" ? "tabs.remove" : "debugger.detach";
      const answer = end === "closeTarget" ? c.send("Target.closeTarget", { targetId: p.targetId }, undefined, STAGE_FLUSH_MS + 5000)
        : end === "detachFromTarget" ? c.send("Target.detachFromTarget", { sessionId: p.sessionId }, undefined, STAGE_FLUSH_MS + 5000) : c.close();
      await until(() => h.fake.requests.slice(from).some((r) => r.op === done), `${end}: ${done}`, STAGE_FLUSH_MS + 3000);
      const ms = Date.now() - t0;
      assert.ok(ms >= STAGE_FLUSH_MS - 5, `${end}: ${done} after STAGE_FLUSH_MS (${ms} ms)`);
      assert.equal(flushes, 1, `${end}: one flush`);
      assert.ok(h.logs.includes(`relay: the input stage: tab ${p.tab.id}: the rest of a collected part did not go in ${STAGE_FLUSH_MS} ms; the close goes on`), `${end}: the log line`);
      await answer;
    } finally { await h.close(); }
  }));
});

const PRESS_B = { type: "mousePressed", button: "left", buttons: 1, x: 10, y: 10, modifiers: 0, clickCount: 1, force: 0.5 };
const RELEASE_B = { type: "mouseReleased", button: "left", buttons: 0, x: 10, y: 10, modifiers: 0, clickCount: 1 };
const opsOf = (h: Harness, from: number) => h.fake.requests.slice(from).map((r) => (r.op === "debugger.sendCommand" ? `${r.args[1]}${r.args[1] === "Input.insertText" ? `:${r.args[2].text}` : ""}` : r.op));

test("review-126b R1 through the model (the re-check's case): another tab's action holds the input lock (its client holds a button); a collected part of pressSequentially waits for the lock; Target.closeTarget: the part goes as the flush, one Input.insertText of the whole text before tabs.remove and within STAGE_EVENT_WAIT_MS, with no wait for the lock; no key of the part goes later", async () => {
  const h = await harness({ stage: true });
  try {
    await h.ready();
    const c = await h.connect();
    const A = await page(h, c), B = await page(h, c);
    // B's client holds a button: B's action keeps the input lock (until STAGE_ACTION_MAX_MS).
    await c.send("Input.dispatchMouseEvent", PRESS_B, B.sessionId);
    const from = h.fake.requests.length, word = "hello";
    for (const ch of word) for (const [m, params] of PRINTABLE(ch)) await c.send(m, params, A.sessionId);
    const st = (h.relay.model as any).stage.tabs.get(A.tab.id);
    await until(() => st.parting, "the part's step waits for the lock (RUN_IDLE_MS after its last call)");
    const t0 = Date.now();
    await c.send("Target.closeTarget", { targetId: A.targetId });
    await until(() => h.fake.requests.slice(from).some((r) => r.op === "tabs.remove"), "tabs.remove", STAGE_FLUSH_MS + 3000);
    const ms = Date.now() - t0, ops = opsOf(h, from);
    const ins = ops.indexOf(`Input.insertText:${word}`), last = ops.indexOf("tabs.remove");
    assert.ok(ins >= 0 && ins < last, `the part's text (${ins}) before tabs.remove (${last}): ${ops.join(", ")}`);
    assert.ok(ms < STAGE_EVENT_WAIT_MS, `tabs.remove ${ms} ms after the close (no wait for the lock)`);
    // B's client releases its button: the lock is free, and no key of A's part goes later.
    await c.send("Input.dispatchMouseEvent", RELEASE_B, B.sessionId);
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(!opsOf(h, from).includes("Input.dispatchKeyEvent"), "no key of the part");
    assert.equal(h.relay.model.stageCounts().partLockFlushed, 1, "the flush ended the part's wait for the lock");
  } finally { await h.close(); }
});

test("review-126b R1 through the model: the tabs of a closed connection (Playwright's browser.close() over connectOverCDP) flush at the same time, each within STAGE_FLUSH_MS: two tabs' collected parts, each Input.insertText answered after 1.5 s: both go before the first answer, and both detaches before 2 x 1.5 s", async () => {
  const h = await harness({ stage: true });
  try {
    await h.ready();
    const c = await h.connect();
    const A = await page(h, c), B = await page(h, c);
    const sentAt: number[] = [];
    h.fake.command = (_t, method) => (method === "Input.insertText" ? (sentAt.push(Date.now()), new Promise((r) => setTimeout(() => r(undefined), 1500))) : undefined);
    const from = h.fake.requests.length;
    for (const [p, word] of [[A, "hello"], [B, "world"]] as const) for (const ch of word) for (const [m, params] of PRINTABLE(ch)) await c.send(m, params, p.sessionId);
    const t0 = Date.now();
    await c.close();
    await until(() => h.fake.requests.slice(from).filter((r) => r.op === "debugger.detach").length >= 2, "two detaches", 2 * STAGE_FLUSH_MS + 3000);
    const ms = Date.now() - t0, ops = opsOf(h, from);
    assert.equal(sentAt.length, 2, `two flushes: ${ops.join(", ")}`);
    assert.ok(Math.abs(sentAt[1] - sentAt[0]) < 700, `the two flushes go at the same time (${sentAt[1] - sentAt[0]} ms apart)`);
    assert.ok(ms < 2 * 1500, `both detaches ${ms} ms after the close`);
    for (const word of ["hello", "world"]) assert.ok(ops.indexOf(`Input.insertText:${word}`) >= 0 && ops.indexOf(`Input.insertText:${word}`) < ops.lastIndexOf("debugger.detach"), `${word} before the detaches: ${ops.join(", ")}`);
    assert.equal(h.relay.model.stageCounts().partFlushes, 2);
  } finally { await h.close(); }
});

test("review-126b R1 through the model (part B1's note): end_scope closes the scope's connections at the same time, so the tabs of two connections flush at the same time, each within STAGE_FLUSH_MS, before tabs.remove (a tab is in use by one connection of a scope at a time)", async () => {
  const h = await harness({ stage: true });
  try {
    await h.ready();
    const c = await h.connect("s4"), d = await h.connect("s4");
    const A = await page(h, c), B = await page(h, d), C = await page(h, d);
    const sentAt: number[] = [];
    h.fake.command = (_t, method) => (method === "Input.insertText" ? (sentAt.push(Date.now()), new Promise((r) => setTimeout(() => r(undefined), 1500))) : undefined);
    const from = h.fake.requests.length;
    for (const [conn, sid, word] of [[c, A.sessionId, "hello"], [d, B.sessionId, "world"], [d, C.sessionId, "again"]] as const) for (const ch of word) for (const [m, params] of PRINTABLE(ch)) await conn.send(m, params, sid);
    const t0 = Date.now();
    h.fake.line({ t: "end_scope", scope: "s4" });
    await until(() => h.fake.requests.slice(from).filter((r) => r.op === "tabs.remove").length >= 3, "three removals", 3 * STAGE_FLUSH_MS + 3000);
    const ms = Date.now() - t0, ops = opsOf(h, from), spread = Math.max(...sentAt) - Math.min(...sentAt);
    assert.equal(sentAt.length, 3, `three flushes, one for each tab: ${ops.join(", ")}`);
    assert.ok(spread < 700, `the flushes go at the same time (${spread} ms apart)`);
    assert.ok(ms < 2 * 1500, `the removals ${ms} ms after end_scope`);
    for (const word of ["hello", "world", "again"]) { const i = ops.indexOf(`Input.insertText:${word}`); assert.ok(i >= 0 && i < ops.indexOf("tabs.remove"), `${word} before the first tabs.remove: ${ops.join(", ")}`); }
    assert.equal(h.relay.model.stageCounts().partFlushes, 3);
  } finally { await h.close(); }
});

test("review-126b R1 through the model (part B1's note): with the build switch off, end_scope closes the scope's connections one after the other, as before the stage", async () => {
  const h = await harness();
  try {
    await h.ready();
    const c = await h.connect("s4"), d = await h.connect("s4");
    await page(h, c); await page(h, d);
    const model = h.relay.model as any, order: string[] = [], close = model.close.bind(model), first = [...model.conns][0];
    model.close = async (k: any) => { if (!model.conns.has(k)) return close(k); const n = k === first ? "first" : "second"; order.push(`${n} starts`); await close(k); order.push(`${n} ends`); };
    h.fake.line({ t: "end_scope", scope: "s4" });
    await until(() => order.length === 4, "both closes");
    assert.deepEqual(order, ["first starts", "first ends", "second starts", "second ends"]);
  } finally { await h.close(); }
});

// ================================================================ the client's mark of a secret (board ab-t30.22)

const MARK = "AgentBrowser.setSecretInput";
/** The stage's read of a focused text input (the fake's world answers it). */
const focusedInput = (h: Harness) => {
  h.fake.command = (_t, method, params) => (method === "Runtime.evaluate" && String(params.expression).includes("__agentBrowserStageField") ? { result: { type: "object", value: { tag: "input", type: "text", editable: false, typing: true, ac: "", value: "", s: 0, e: 0 } } } : undefined);
};

test("board ab-t30.22, the client's mark with the build switch off (C11, the paste): AgentBrowser.setSecretInput on the tab's own session answers {} and never reaches Chrome; with no boolean enabled it fails; on the root, on a browser session and on a frame's own session it is refused", async () => {
  const saved = process.env[STAGE_TEST_ENV];
  delete process.env[STAGE_TEST_ENV];
  const h = await harness({ clipboard: fakeClipboard() });
  try {
    assert.equal(h.relay.model.stageOn, false);
    await h.ready();
    const c = await h.connect();
    const p = await page(h, c);
    const from = h.fake.requests.length;
    assert.deepEqual(await c.send(MARK, { enabled: true }, p.sessionId), {});
    assert.deepEqual(await c.send(MARK, { enabled: false }, p.sessionId), {});
    await assert.rejects(c.send(MARK, {}, p.sessionId), /enabled must be true or false/);
    await assert.rejects(c.send(MARK, { enabled: "yes" }, p.sessionId), /enabled must be true or false/);
    await assert.rejects(c.send(MARK, { enabled: true }), /Not available in the agent browser: AgentBrowser\.setSecretInput\./);
    // review-129 bar 4: a browser session (Target.attachToBrowserTarget) is refused as the root is.
    const { sessionId: browserSession } = await c.send("Target.attachToBrowserTarget", {});
    await assert.rejects(c.send(MARK, { enabled: true }, browserSession), /Not available in the agent browser: AgentBrowser\.setSecretInput\./, "refused on a browser session");
    assert.deepEqual(cmds(h, from), [], "no call reaches Chrome");
    // A frame's own session (an out-of-process frame of the tab): refused, as every other AgentBrowser.* call.
    h.fake.emit("debugger.onEvent", { source: { tabId: p.tab.id }, method: "Target.attachedToTarget", params: { sessionId: "FR1", waitingForDebugger: false,
      targetInfo: { targetId: "FR1T", type: "iframe", title: "", url: "https://a.example/f", attached: true, canAccessOpener: false, browserContextId: "C1" } } });
    await new Promise((r) => setTimeout(r, 20));
    await assert.rejects(c.send(MARK, { enabled: true }, "FR1"), /Not available in the agent browser: AgentBrowser\.setSecretInput\./, "refused on a frame's own session");
    assert.ok(!cmds(h, from).some((x) => x.method === MARK), "the mark never reaches Chrome");
  } finally { await h.close(); if (saved === undefined) delete process.env[STAGE_TEST_ENV]; else process.env[STAGE_TEST_ENV] = saved; }
});

test("board ab-t30.22, the client's mark with the stage on (C11, the paste, rule 8): a step of the tab's gate; while it holds, a long Input.insertText goes as one Input.insertText with no clipboard call; after enabled false, and after the end of the client's last session on the tab, a long text pastes again", async () => {
  const clip = fakeClipboard();
  const h = await harness({ stage: true, clipboard: clip });
  try {
    await h.ready();
    const c = await h.connect();
    const p = await page(h, c);
    focusedInput(h);
    const from = h.fake.requests.length;
    assert.deepEqual(await c.send(MARK, { enabled: true }, p.sessionId), {});
    await c.send("Input.insertText", { text: "y".repeat(2500) }, p.sessionId);
    assert.deepEqual(clip.log, [], "no clipboard call while the mark holds");
    assert.equal(h.relay.model.stageCounts()["noPaste:secretMark"], 1);
    assert.ok(cmds(h, from).some((x) => x.method === "Input.insertText" && x.params.text.length === 2500), "the text as one Input.insertText");
    assert.ok(!cmds(h, from).some((x) => x.method === MARK), "the mark never reaches Chrome");
    assert.deepEqual(await c.send(MARK, { enabled: false }, p.sessionId), {});
    await c.send("Input.insertText", { text: "z".repeat(2500) }, p.sessionId);
    assert.ok(clip.log.includes("hold 2500"), "after enabled false a long text pastes");
    // The mark holds until the stage forgets the tab: the end of the client's last session on it.
    assert.deepEqual(await c.send(MARK, { enabled: true }, p.sessionId), {});
    await c.send("Target.detachFromTarget", { sessionId: p.sessionId });
    const { sessionId } = await c.send("Target.attachToTarget", { targetId: p.targetId, flatten: true });
    clip.log.length = 0;
    await c.send("Input.insertText", { text: "w".repeat(2500) }, sessionId);
    assert.ok(clip.log.includes("hold 2500"), "a new session of the tab has no mark");
  } finally { await h.close(); }
});

test("review-129b N5: in a model with the sign-in act (the service's model), the mark is refused on the root and on a browser session with C11's text, and the tab's own session answers {}", async () => {
  const h = await harness();
  try {
    await h.ready();
    h.relay.model.setSignIns({ signIn: async () => ({}), signIns: async () => ({}) } as any);
    const c = await h.connect();
    const p = await page(h, c);
    assert.deepEqual(await c.send(MARK, { enabled: true }, p.sessionId), {});
    const refusal = (e: Error) => e.message === "AgentBrowser.setSecretInput: Not available in the agent browser: AgentBrowser.setSecretInput.";
    await assert.rejects(c.send(MARK, { enabled: true }), refusal, "the root");
    const { sessionId: browserSession } = await c.send("Target.attachToBrowserTarget", {});
    await assert.rejects(c.send(MARK, { enabled: true }, browserSession), refusal, "a browser session");
    assert.deepEqual(await c.send("AgentBrowser.signIns", {}), {}, "the act's own method is the model's on the root");
  } finally { await h.close(); }
});

test("review-131 B1 through the model: a tab's end where the page can still run keeps the paste path closed for V_READ_MAX_MS while the tab's V or its read was in the closed set (Chrome's detach of the debugger, a tab that leaves the model as an orphan); a close (tabs.onRemoved) ends it at once, also after a detach", async () => {
  const h = await harness({ stage: true, clipboard: fakeClipboard() });
  try {
    await h.ready();
    const c = await h.connect();
    const A = await page(h, c), B = await page(h, c), C = await page(h, c);
    const stage = (h.relay.model as any).stage, model = h.relay.model as any;
    // A read after V's answer that has no answer yet, in each tab's closed set.
    const reading = (id: number) => stage.pendingV.set(id, new Set([{ reading: true, cancel: () => {} }]));
    reading(A.tab.id); reading(B.tab.id); reading(C.tab.id);
    h.fake.attached.delete(A.tab.id);
    h.fake.emit("debugger.onDetach", { source: { tabId: A.tab.id }, reason: "canceled_by_user" });
    await until(() => stage.droppedV.has(A.tab.id), "Chrome's detach: the bound");
    assert.equal(stage.pendingV.has(A.tab.id), false, "Chrome's detach: the tab's own set is gone");
    model.drop(model.tabs.get(B.tab.id));
    assert.equal(stage.droppedV.has(B.tab.id), true, "an orphan: the bound");
    assert.equal(stage.vPending(), true, "the paste path is closed");
    // The close of A after its detach ends A's bound; a close of C with no detach ends C's wait at once.
    h.fake.tabs.delete(A.tab.id);
    h.fake.emit("tabs.onRemoved", { tabId: A.tab.id, removeInfo: { windowId: 1, isWindowClosing: false } });
    await until(() => !stage.droppedV.has(A.tab.id), "the close after the detach: no bound");
    h.fake.attached.delete(C.tab.id); h.fake.tabs.delete(C.tab.id);
    h.fake.emit("tabs.onRemoved", { tabId: C.tab.id, removeInfo: { windowId: 1, isWindowClosing: false } });
    await until(() => !stage.pendingV.has(C.tab.id), "the close: the set is gone");
    assert.equal(stage.droppedV.has(C.tab.id), false, "the close: no bound");
    assert.deepEqual([...stage.droppedV.keys()], [B.tab.id], "only the orphan's bound is left");
  } finally { await h.close(); }
});

test("review-131b F1 (a, b) through the model: a tab that the receiver's map has no more at a link up is a close (the wait ends at once); a tab that Chrome replaces (tabs.onReplaced) is no close and keeps the bound (fail closed)", async () => {
  const h = await harness({ stage: true, clipboard: fakeClipboard() });
  try {
    await h.ready();
    const c = await h.connect();
    const A = await page(h, c), B = await page(h, c);
    const stage = (h.relay.model as any).stage, model = h.relay.model as any;
    const reading = (id: number) => stage.pendingV.set(id, new Set([{ reading: true, cancel: () => {} }]));
    reading(A.tab.id); reading(B.tab.id);
    // (a) The receiver's map at a link up: A came from the map, and Chrome lists it no more.
    model.tabs.get(A.tab.id).fromMap = true;
    h.fake.attached.delete(A.tab.id); h.fake.tabs.delete(A.tab.id);
    await model.targetsAndDetach(model.link, new Set([A.tab.id]));
    assert.equal(stage.pendingV.has(A.tab.id), false, "the receiver's map: the set is gone");
    assert.equal(stage.droppedV.has(A.tab.id), false, "the receiver's map: a close, no bound");
    // (b) Chrome replaces B.
    h.fake.emit("tabs.onReplaced", { addedTabId: 9001, removedTabId: B.tab.id });
    await until(() => stage.droppedV.has(B.tab.id), "a replaced tab: the bound");
    assert.equal(stage.vPending(), true, "a replaced tab: the paste path is closed");
  } finally { await h.close(); }
});

test("review-138 N1: with the stage off too, a drop or a dragCancel that Chrome answers with no error ends the tab's hold of the button; one that gets an error leaves the hold until the release", async () => {
  const h = await harness({ stage: false });
  try {
    await h.ready();
    const c = await h.connect();
    const p = await page(h, c);
    const data = { items: [{ mimeType: "text/plain", data: "payload" }], dragOperationsMask: 16 };
    const press = () => c.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", buttons: 1, x: 100, y: 100, modifiers: 0, clickCount: 1 }, p.sessionId);
    for (const type of ["drop", "dragCancel"]) {
      await press();
      assert.equal(h.relay.model.pointerState().pressed.length, 1, `${type}: the press holds the button`);
      await c.send("Input.dispatchDragEvent", { type, x: 300, y: 200, data, modifiers: 0 }, p.sessionId);
      await until(() => h.relay.model.pointerState().pressed.length === 0, `${type}: Chrome's answer ends the hold`);
    }
    h.fake.command = (_t, method, params) => (method === "Input.dispatchDragEvent" && params.type === "drop" ? { error: "Drop failed" } : undefined);
    await press();
    await assert.rejects(c.send("Input.dispatchDragEvent", { type: "drop", x: 300, y: 200, data, modifiers: 0 }, p.sessionId));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(h.relay.model.pointerState().pressed.length, 1, "an error answer leaves the hold");
    await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", buttons: 0, x: 300, y: 200, modifiers: 0, clickCount: 1 }, p.sessionId);
    await until(() => h.relay.model.pointerState().pressed.length === 0, "the release ends it");
  } finally { await h.close(); }
});

test("with the stage on (board ab-t30.12.3): the model gives the stage Chrome's Input.dragIntercepted (the client gets it too), so dragTo's move goes as a short path with the button down and then drag events; the client's release goes as the drop, and the drop ends the tab's hold of the button", async () => {
  const h = await harness({ stage: true, random: seededRandom(3) });
  try {
    await h.ready();
    const c = await h.connect();
    const p = await page(h, c);
    const data = { items: [{ mimeType: "text/plain", data: "payload" }], dragOperationsMask: 16 };
    let reported = false;
    h.fake.command = (_t, method, params) => {
      if (!reported && method === "Input.dispatchMouseEvent" && params.type === "mouseMoved" && params.buttons === 1 && Math.abs(params.x - 100) > 4) {
        reported = true;
        h.fake.emit("debugger.onEvent", { source: { tabId: p.tab.id }, method: "Input.dragIntercepted", params: { data } });
      }
      return undefined;
    };
    const got = c.waitForEvent("Input.dragIntercepted");
    await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", button: "none", buttons: 0, x: 100, y: 100, modifiers: 0 }, p.sessionId);
    await c.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", buttons: 1, x: 100, y: 100, modifiers: 0, clickCount: 1 }, p.sessionId);
    await c.send("Input.setInterceptDrags", { enabled: true }, p.sessionId);
    const from = h.fake.requests.length;
    await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", button: "left", buttons: 1, x: 400, y: 260, modifiers: 0, force: 0.5 }, p.sessionId);
    assert.deepEqual((await got).data, data, "the client gets Chrome's report");
    await c.send("Input.setInterceptDrags", { enabled: false }, p.sessionId);
    await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", buttons: 0, x: 400, y: 260, modifiers: 0, clickCount: 1 }, p.sessionId);
    const ev = cmds(h, from).filter((x) => x.method === "Input.dispatchMouseEvent" || x.method === "Input.dispatchDragEvent");
    const drags = ev.filter((x) => x.method === "Input.dispatchDragEvent");
    assert.ok(ev.findIndex((x) => x.method === "Input.dispatchDragEvent") > 1, "moves with the button down first");
    assert.equal(drags[0].params.type, "dragEnter");
    assert.deepEqual(drags[0].params.data, data);
    assert.deepEqual([drags.at(-1)!.params.type, drags.at(-1)!.params.x, drags.at(-1)!.params.y], ["drop", 400, 260]);
    assert.equal(ev.filter((x) => x.params.type === "mouseReleased").length, 0, "the drop takes the release's place");
    await until(() => h.relay.model.pointerState().pressed.length === 0, "the drop ends the tab's hold");
    assert.equal(h.relay.model.stageCounts().drops, 1);
  } finally { await h.close(); }
});
