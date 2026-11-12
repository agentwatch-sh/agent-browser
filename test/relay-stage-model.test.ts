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
import { STAGE_GROUP, STAGE_TEST_ENV, WHEEL_ROOT_AT } from "../src/relay/stage.ts";
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

test("review-116b: the model gives the stage the client's Page.disable and Chrome's Page.frameNavigated and Inspector.targetCrashed: each ends the wait for a dialog's close (a press opened it)", async () => {
  for (const signal of ["Page.disable", "Page.frameNavigated", "Inspector.targetCrashed"]) {
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
          h.fake.emit("debugger.onEvent", { source: { tabId: target.tabId }, method: "Page.javascriptDialogOpening", params: { type: "confirm", message: "Sure?", url: "about:blank", hasBrowserHandler: false, defaultPrompt: "" } });
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
      else h.fake.emit("debugger.onEvent", { source: { tabId: p.tab.id }, method: signal, params: signal === "Page.frameNavigated" ? { frame: { id: "main", loaderId: "L2", url: "about:blank#next" } } : {} });
      await until(() => cmds(h, from).some((x) => x.params?.type === "mouseReleased"), `${signal}: a release after the signal (the wait ended)`, 3000);
      for (const k of kept.splice(0)) k();
      await click;
      if (signal === "Page.frameNavigated") assert.match(release, /context/i, "at a navigation the held release gets the error that the context is gone");
      else assert.equal(release, "ok", `${signal}: the held release goes and gets Chrome's answer`);
      await until(() => (h.relay.model as any).stage.lock.held === 0, `${signal}: the lock to be free`);
    } finally { await h.close(); }
  }
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
