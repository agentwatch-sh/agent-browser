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
import { STAGE_TEST_ENV } from "../src/relay/stage.ts";
import { harness, until, type Harness } from "./fake-bridge.ts";

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
      ["DOM.scrollIntoViewIfNeeded", { objectId: "7.3.10" }],
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
    const held: (() => void)[] = [];
    h.fake.command = (target, method, params) => {
      if (method === "Input.dispatchMouseEvent" && params.type === "mousePressed") { open = true; h.fake.emit("debugger.onEvent", { source: { tabId: target.tabId }, method: "Page.javascriptDialogOpening", params: { type: "confirm", message: "Sure?", url: "about:blank", hasBrowserHandler: false, defaultPrompt: "" } }); }
      if (method === "Page.handleJavaScriptDialog") { open = false; setTimeout(() => { for (const r of held.splice(0)) r(); }, 5); return {}; }
      if (open && method.startsWith("Input.")) return new Promise((r) => held.push(() => r({})));
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
    assert.ok(d > sent.indexOf("mouseReleased"), "the release went at once when the dialog opened, before the dialog's answer");
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
