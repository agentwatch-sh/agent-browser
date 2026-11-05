// The relay's anti-detect drive on Linux (board task ab-v16.28; docs/research/2026-11-05-anti-detect-drive.md,
// "The answer" steps 1, 2 and 5, sections 6 and 8): one window per page, focus emulation answered by the relay, and
// the page's window brought forward before an input that starts an action. On the Mac the relay keeps today's tabs
// (until board task ab-v16.27). The fake receiver of fake-bridge.ts models windows, their focus and each window's
// active tab.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { CDPConnection } from "../src/cdp.ts";
import { Bridge } from "../src/relay/bridge.ts";
import { Model } from "../src/relay/model.ts";
import { harness, until, type Harness } from "./fake-bridge.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const failure = (p: Promise<unknown>) => p.then(() => "no error", (e: Error) => e.message.replace(/^[A-Za-z]+\.[A-Za-z]+: /, ""));
/** The ops from request `from` on; a CDP command by its method (with its input type). */
const ops = (h: Harness, from: number) => h.fake.requests.slice(from).map((r) => {
  if (r.op !== "debugger.sendCommand") return r.op;
  return r.args[2]?.type ? `${r.args[1]} ${r.args[2].type}` : r.args[1];
});
const WINDOW_OPS = new Set(["tabs.get", "tabs.update", "windows.get", "windows.update"]);

/** A page of the connection's own, with auto-attach on: its target id, its session and the fake's tab. */
async function page(h: Harness, c: CDPConnection, params: object = { url: "about:blank" }) {
  await c.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  const attached = c.waitForEvent("Target.attachedToTarget");
  const { targetId } = await c.send("Target.createTarget", params);
  const ev = await attached;
  return { targetId, sessionId: ev.sessionId as string, tab: [...h.fake.tabs.values()].find((t) => t.targetId === targetId)! };
}

test("every Target.createTarget opens a window of its own, not focused, also when the client asks for a tab", async () => {
  const h = await harness();
  try {
    await h.ready();
    const c = await h.connect();
    const asks = [{ url: "about:blank" }, { url: "https://a.example/x", background: true }, { url: "", newWindow: false }, {}, { url: "https://a.example/y", newWindow: true }];
    const windows = new Set<number>();
    for (const params of asks) {
      const from = h.fake.requests.length;
      const { tab } = await page(h, c, params);
      assert.deepEqual(h.fake.requests.slice(from).filter((r) => r.op === "windows.create" || r.op === "tabs.create").map((r) => [r.op, r.args]),
        [["windows.create", [{ url: "about:blank", focused: false }, "s1"]]], JSON.stringify(params));
      windows.add(tab.windowId);
    }
    assert.equal(windows.size, asks.length, "each page has a window of its own");
    assert.equal(h.fake.focusedWindow, 1, "a new window takes no focus");
    // The client's URL still comes after the hold (C10), as with a tab.
    await until(() => h.fake.sent("debugger.sendCommand", "Page.navigate").some((r) => r.args[2].url === "https://a.example/y"), "the navigation of the last page");
  } finally { await h.close(); }
});

test("the relay answers Emulation.setFocusEmulationEnabled itself and never sends it to Chrome; on the root it stays refused", async () => {
  const h = await harness();
  try {
    await h.ready();
    const c = await h.connect();
    const { sessionId, tab } = await page(h, c);
    // A frame of the page (a child session) too.
    h.fake.emit("debugger.onEvent", { source: { tabId: tab.id }, method: "Target.attachedToTarget", params: { sessionId: "FR1", waitingForDebugger: false,
      targetInfo: { targetId: "FR1T", type: "iframe", title: "", url: "https://a.example/f", attached: true, canAccessOpener: false, browserContextId: "C1" } } });
    await sleep(20);
    const from = h.fake.requests.length;
    assert.deepEqual(await c.send("Emulation.setFocusEmulationEnabled", { enabled: true }, sessionId), {});
    assert.deepEqual(await c.send("Emulation.setFocusEmulationEnabled", { enabled: false }, sessionId), {});
    assert.deepEqual(await c.send("Emulation.setFocusEmulationEnabled", { enabled: true }, "FR1"), {});
    assert.deepEqual(h.fake.requests.slice(from), [], "no bridge request");
    assert.equal(await failure(c.send("Emulation.setFocusEmulationEnabled", { enabled: true })), "Not available in the agent browser: Emulation.setFocusEmulationEnabled.");
    // Other Emulation calls still go to Chrome.
    await c.send("Emulation.setDeviceMetricsOverride", { width: 900, height: 700, deviceScaleFactor: 1, mobile: false }, sessionId);
    assert.equal(h.fake.sent("debugger.sendCommand", "Emulation.setDeviceMetricsOverride").length, 1);
  } finally { await h.close(); }
});

test("before an input that starts an action, the relay focuses the page's window; the rest of the input goes at once", async () => {
  const h = await harness();
  try {
    await h.ready();
    const c = await h.connect();
    const { sessionId, tab } = await page(h, c);
    const win = tab.windowId;
    const mouse = (type: string) => c.send("Input.dispatchMouseEvent", { type, x: 5, y: 5, button: type === "mouseMoved" ? "none" : "left", clickCount: 1 }, sessionId);
    let from = h.fake.requests.length;
    await mouse("mouseMoved");
    assert.deepEqual(ops(h, from), ["Input.dispatchMouseEvent mouseMoved"], "a move takes no window");
    from = h.fake.requests.length;
    await mouse("mousePressed");
    assert.deepEqual(ops(h, from), ["tabs.get", "windows.get", "windows.update", "Input.dispatchMouseEvent mousePressed"]);
    assert.deepEqual(h.fake.sent("windows.update").at(-1)!.args, [win, { focused: true }]);
    assert.equal(h.fake.focusedWindow, win);
    assert.equal(h.fake.sent("debugger.sendCommand", "Input.dispatchMouseEvent").at(-1)!.args[2].force, 0.5, "the press keeps its force");
    from = h.fake.requests.length;
    await mouse("mouseReleased");
    assert.deepEqual(ops(h, from), ["Input.dispatchMouseEvent mouseReleased"]);
    // The window has the focus now: the relay reads it and sends no update.
    from = h.fake.requests.length;
    await c.send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", text: "a" }, sessionId);
    await c.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a" }, sessionId);
    assert.deepEqual(ops(h, from), ["tabs.get", "windows.get", "Input.dispatchKeyEvent keyDown", "Input.dispatchKeyEvent keyUp"]);
    // Another window took the focus (the operator, or another agent): each kind of start brings this window back.
    for (const [method, params] of [["Input.insertText", { text: "hi" }], ["Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter" }],
      ["Input.dispatchKeyEvent", { type: "char", text: "b" }], ["Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 5, y: 5 }] }]] as const) {
      h.fake.focusedWindow = 1;
      from = h.fake.requests.length;
      await c.send(method, params, sessionId);
      assert.deepEqual(ops(h, from).slice(0, 3), ["tabs.get", "windows.get", "windows.update"], `${method} ${(params as any).type ?? ""}`);
      assert.equal(h.fake.focusedWindow, win);
    }
    for (const [method, params] of [["Input.dispatchMouseEvent", { type: "mouseWheel", x: 5, y: 5, deltaX: 0, deltaY: 100 }],
      ["Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }], ["Input.dispatchKeyEvent", { type: "keyUp", key: "b" }]] as const) {
      h.fake.focusedWindow = 1;
      from = h.fake.requests.length;
      await c.send(method, params, sessionId);
      assert.ok(!ops(h, from).some((o) => WINDOW_OPS.has(o)), `${method} ${params.type}: ${ops(h, from).join(" ")}`);
    }
  } finally { await h.close(); }
});

test("Playwright's focus of an element (its injected focusNode) brings the window forward first, so Playwright keeps the caret", async () => {
  // Playwright 1.64.1 (locator.pressSequentially, press, type, focus) calls injected.focusNode, which moves the caret of
  // an input to its start when document.hasFocus() is false. The function's text is a string argument of the call.
  const h = await harness();
  try {
    await h.ready();
    const c = await h.connect();
    const { sessionId, tab } = await page(h, c);
    const call = (fn: string) => c.send("Runtime.callFunctionOn", { functionDeclaration: "(utilityScript, ...args) => utilityScript.evaluate(...args)", objectId: "U1",
      arguments: [{ objectId: "U1" }, { value: true }, { value: true }, { value: fn }, { value: 1 }, { value: { v: "undefined" } }, { objectId: "N1" }],
      returnByValue: true, awaitPromise: true, userGesture: true }, sessionId);
    let from = h.fake.requests.length;
    await call("([injected, node, resetSelectionIfNotFocused2]) => injected.focusNode(node, resetSelectionIfNotFocused2)");
    assert.deepEqual(ops(h, from), ["tabs.get", "windows.get", "windows.update", "Runtime.callFunctionOn"]);
    assert.equal(h.fake.focusedWindow, tab.windowId);
    // The unbundled form of the same function (Playwright's source names the argument without the 2).
    h.fake.focusedWindow = 1;
    from = h.fake.requests.length;
    await call("([injected, node, resetSelectionIfNotFocused]) => injected.focusNode(node, resetSelectionIfNotFocused)");
    assert.deepEqual(ops(h, from), ["tabs.get", "windows.get", "windows.update", "Runtime.callFunctionOn"]);
    // Any other call of a function goes at once: another injected function, a name that only starts like it, and a
    // client's own function or string that mentions focusNode (page.evaluate((s) => s.length, "see el.focusNode(x)")).
    for (const fn of ["([injected, node]) => injected.blurNode(node)", "([injected, node]) => injected.focusNodeLater(node)",
      "([injected, node]) => injected.focusNode", "([page, node]) => page.focusNode(node)", "(s) => s.length", "see el.focusNode(x)",
      "focusNode", "() => injected.focusNode(document.body)"]) {
      h.fake.focusedWindow = 1;
      from = h.fake.requests.length;
      await call(fn);
      assert.deepEqual(ops(h, from), ["Runtime.callFunctionOn"], fn);
    }
    from = h.fake.requests.length;
    await c.send("Runtime.callFunctionOn", { functionDeclaration: "function () { return this.focusNode; }", objectId: "N1" }, sessionId);
    await c.send("Runtime.callFunctionOn", { functionDeclaration: "(s) => s.length", objectId: "U1", arguments: [{ value: "see el.focusNode(x)" }] }, sessionId);
    assert.deepEqual(ops(h, from), ["Runtime.callFunctionOn", "Runtime.callFunctionOn"]);
  } finally { await h.close(); }
});

test("a call that comes behind an input that waits for its window reaches Chrome behind that input", async () => {
  const h = await harness();
  try {
    await h.ready();
    const c = await h.connect();
    const { sessionId } = await page(h, c);
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    h.fake.op = async ({ op }) => { if (op === "windows.get") await gate; return undefined; };
    const from = h.fake.requests.length;
    // Sent at once, without waiting for answers, as a CDP client may.
    const sent = [c.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 5, y: 5, button: "left", clickCount: 1 }, sessionId),
      c.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 5, y: 5, button: "left", clickCount: 1 }, sessionId),
      c.send("Runtime.evaluate", { expression: "1" }, sessionId)];
    await until(() => h.fake.sent("windows.get").length, "the window read");
    await sleep(30);
    assert.deepEqual(ops(h, from), ["tabs.get", "windows.get"], "nothing overtakes the press");
    open();
    await Promise.all(sent);
    assert.deepEqual(ops(h, from), ["tabs.get", "windows.get", "windows.update", "Input.dispatchMouseEvent mousePressed", "Input.dispatchMouseEvent mouseReleased", "Runtime.evaluate"]);
  } finally { await h.close(); }
});

test("two pages' activations never interleave: each activation and its input reach the bridge before the next activation", async () => {
  const h = await harness();
  try {
    await h.ready();
    const a = await h.connect("s1"), b = await h.connect("s2");
    const pa = await page(h, a), pb = await page(h, b);
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    let gated = false;
    h.fake.op = async ({ op }) => { if (op === "windows.get" && !gated) { gated = true; await gate; } return undefined; };
    const from = h.fake.requests.length;
    const key = (c: CDPConnection, sid: string) => c.send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", text: "a" }, sid);
    const both = [key(a, pa.sessionId), key(b, pb.sessionId)];
    await until(() => h.fake.sent("windows.get").length, "the first window read");
    await sleep(30);
    assert.deepEqual(ops(h, from), ["tabs.get", "windows.get"], "the second activation waits");
    open();
    await Promise.all(both);
    const keys = h.fake.requests.slice(from).filter((r) => r.op === "windows.update" || r.args[1] === "Input.dispatchKeyEvent").map((r) => r.op === "windows.update" ? `focus ${r.args[0]}` : `key ${r.args[0].tabId}`);
    assert.deepEqual(keys, [`focus ${pa.tab.windowId}`, `key ${pa.tab.id}`, `focus ${pb.tab.windowId}`, `key ${pb.tab.id}`]);
  } finally { await h.close(); }
});

test("a page that a popup tab hides gets a tab switch before its input; the relay never moves a tab or opens a window for a popup", async () => {
  const h = await harness();
  try {
    await h.ready();
    const c = await h.connect();
    const opener = await page(h, c);
    // The site opens a tab in the opener's window (target=_blank, window.open with no features): it is in front there.
    const attached = c.waitForEvent("Target.attachedToTarget");
    const from = h.fake.requests.length;
    const popup = h.fake.newTab("https://a.example/popup", opener.tab, opener.tab.windowId);
    const ev = await attached;
    assert.equal(ev.targetInfo.targetId, popup.targetId);
    assert.ok(!ops(h, from).some((o) => o === "windows.create" || o === "tabs.create" || o === "windows.update"), ops(h, from).join(" "));
    assert.deepEqual([h.fake.tabs.get(opener.tab.id)!.active, popup.active], [false, true]);
    // Input to the popup: its window comes forward; it is the active tab already.
    let at = h.fake.requests.length;
    await c.send("Input.insertText", { text: "x" }, ev.sessionId);
    assert.deepEqual(ops(h, at), ["tabs.get", "windows.get", "windows.update", "Input.insertText"]);
    // Input to the opener: the person's tab switch, in the same window.
    at = h.fake.requests.length;
    await c.send("Input.insertText", { text: "y" }, opener.sessionId);
    assert.deepEqual(ops(h, at), ["tabs.get", "tabs.update", "windows.get", "Input.insertText"]);
    assert.deepEqual(h.fake.sent("tabs.update").at(-1)!.args, [opener.tab.id, { active: true }]);
    assert.deepEqual([h.fake.tabs.get(opener.tab.id)!.active, h.fake.tabs.get(popup.id)!.active, popup.windowId], [true, false, opener.tab.windowId]);
  } finally { await h.close(); }
});

test("Target.activateTarget only selects the tab in its window; Page.bringToFront goes to Chrome", async () => {
  const h = await harness();
  try {
    await h.ready();
    const c = await h.connect();
    const { targetId, sessionId, tab } = await page(h, c);
    let from = h.fake.requests.length;
    await c.send("Target.activateTarget", { targetId });
    assert.deepEqual(h.fake.requests.slice(from).map((r) => [r.op, r.args]), [["tabs.update", [tab.id, { active: true }]]]);
    from = h.fake.requests.length;
    await c.send("Page.bringToFront", {}, sessionId);
    assert.deepEqual(ops(h, from), ["Page.bringToFront"]);
  } finally { await h.close(); }
});

test("a failed activation is logged and the input still goes to Chrome", async () => {
  const h = await harness();
  try {
    await h.ready();
    const c = await h.connect();
    const { sessionId, tab } = await page(h, c);
    h.fake.op = ({ op }) => (op === "windows.update" ? { error: "No window with id: 9." } : undefined);
    await c.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 5, y: 5, button: "left", clickCount: 1 }, sessionId);
    assert.equal(h.fake.sent("debugger.sendCommand", "Input.dispatchMouseEvent").length, 1);
    assert.ok(h.logs.some((l) => l === `relay: the activation of tab ${tab.id} failed: No window with id: 9.`), h.logs.join("\n"));
  } finally { await h.close(); }
});

test("an activation whose bridge op does not answer holds its input for 2 s at most", async () => {
  const h = await harness();
  try {
    await h.ready();
    const c = await h.connect();
    const { sessionId, tab } = await page(h, c);
    let open!: () => void;
    const never = new Promise<void>((r) => (open = r));
    h.fake.op = async ({ op }) => { if (op === "windows.get") await never; return undefined; };
    const t0 = Date.now();
    await c.send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", text: "a" }, sessionId);
    const waited = Date.now() - t0;
    assert.ok(waited >= 1900 && waited < 4000, `${waited} ms`);
    assert.ok(h.logs.includes(`relay: the activation of tab ${tab.id} took more than 2000 ms; the input goes on`), h.logs.join("\n"));
    open();
  } finally { await h.close(); }
});

test("an activation that gave up changes no window when its bridge op answers late: the next page keeps the focus", async () => {
  const h = await harness();
  try {
    await h.ready();
    const a = await h.connect("s1"), b = await h.connect("s2");
    const pa = await page(h, a), pb = await page(h, b);
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    h.fake.op = async ({ op, args }) => { if (op === "windows.get" && args[0] === pa.tab.windowId) await gate; return undefined; };
    const from = h.fake.requests.length;
    await a.send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", text: "a" }, pa.sessionId); // its activation gives up after 2 s
    await b.send("Input.dispatchKeyEvent", { type: "keyDown", key: "b", text: "b" }, pb.sessionId);
    assert.equal(h.fake.focusedWindow, pb.tab.windowId);
    open();
    await sleep(100);
    const seq = h.fake.requests.slice(from).filter((r) => r.op === "windows.update" || r.op === "tabs.update" || r.args[1] === "Input.dispatchKeyEvent")
      .map((r) => r.op === "debugger.sendCommand" ? `key ${r.args[0].tabId}` : `${r.op} ${r.args[0]}`);
    assert.deepEqual(seq, [`key ${pa.tab.id}`, `windows.update ${pb.tab.windowId}`, `key ${pb.tab.id}`]);
    assert.equal(h.fake.focusedWindow, pb.tab.windowId, "the late activation left the focus where it is");
  } finally { await h.close(); }
});

test("an activation that gave up selects no tab when its read answers late: a popup tab stays in front", async () => {
  const h = await harness();
  try {
    await h.ready();
    const c = await h.connect();
    const opener = await page(h, c);
    const attached = c.waitForEvent("Target.attachedToTarget");
    const popup = h.fake.newTab("https://a.example/popup", opener.tab, opener.tab.windowId);
    await attached;
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    h.fake.op = async ({ op, args }) => { if (op === "tabs.get" && args[0] === opener.tab.id) await gate; return undefined; };
    const from = h.fake.requests.length;
    await c.send("Input.insertText", { text: "x" }, opener.sessionId); // its activation gives up after 2 s
    open();
    await sleep(100);
    assert.deepEqual(ops(h, from), ["tabs.get", "Input.insertText", "windows.get"], "no tabs.update and no windows.update after the give-up");
    assert.deepEqual([h.fake.tabs.get(opener.tab.id)!.active, h.fake.tabs.get(popup.id)!.active], [false, true]);
  } finally { await h.close(); }
});

test("on the Mac the relay keeps today's tabs: tabs.create, focus emulation to Chrome, no window op before an input", async () => {
  const h = await harness({ windowPerPage: false });
  try {
    await h.ready();
    const c = await h.connect();
    let from = h.fake.requests.length;
    const { sessionId } = await page(h, c);
    assert.deepEqual(h.fake.requests.slice(from).filter((r) => r.op.endsWith(".create")).map((r) => [r.op, r.args]), [["tabs.create", [{ url: "about:blank", active: true }, "s1"]]]);
    from = h.fake.requests.length;
    await page(h, c, { url: "about:blank", background: true });
    assert.deepEqual(h.fake.requests.slice(from).filter((r) => r.op.endsWith(".create")).map((r) => [r.op, r.args]), [["tabs.create", [{ url: "about:blank", active: false }, "s1"]]]);
    from = h.fake.requests.length;
    await page(h, c, { url: "about:blank", newWindow: true });
    assert.deepEqual(h.fake.requests.slice(from).filter((r) => r.op.endsWith(".create")).map((r) => r.op), ["windows.create"]);
    await c.send("Emulation.setFocusEmulationEnabled", { enabled: true }, sessionId);
    assert.deepEqual(h.fake.sent("debugger.sendCommand", "Emulation.setFocusEmulationEnabled").map((r) => r.args[2]), [{ enabled: true }]);
    from = h.fake.requests.length;
    await c.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 5, y: 5, button: "left", clickCount: 1 }, sessionId);
    await c.send("Input.insertText", { text: "x" }, sessionId);
    assert.deepEqual(ops(h, from), ["Input.dispatchMouseEvent mousePressed", "Input.insertText"]);
  } finally { await h.close(); }
});

test("one window per page follows the platform when the relay is not told: Linux only", () => {
  const bridge = new Bridge(() => {});
  assert.equal(new Model(bridge, () => {}).windowPerPage, process.platform === "linux");
  assert.equal(new Model(bridge, () => {}, { windowPerPage: false }).windowPerPage, false);
  assert.equal(new Model(bridge, () => {}, { windowPerPage: true }).windowPerPage, true);
});
