// The relay plays a person-shaped pointer path at each activation through the daemon (board ab-v16.71; the agent
// pointer design, docs/superpowers/specs/2026-11-06-agent-pointer-move-design.md, sections 3 and 7; contract C11 "The
// pointer at an activation" in chrome-extension's docs/protocol.md). The fake receiver of fake-bridge.ts stands in for
// Chrome and, with `fake.daemon`, for the daemon's two ops (its default is a daemon from before them: `unknown op`).
// Each window of the fake is at 0,0 on a 1280 x 900 display with its content from y 91 (GEO), so a page's point (x, y)
// is the display point (x, y + 91).

import { test } from "node:test";
import assert from "node:assert/strict";
import type { CDPConnection } from "../src/cdp.ts";
import { moveProblem, monotonicMs, moveWait, type Pt } from "../src/relay/pointer.ts";
import { GEO, harness, until, type Harness } from "./fake-bridge.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ops = (h: Harness, from = 0) => h.fake.requests.slice(from).map((r) => (r.op !== "debugger.sendCommand" ? r.op : r.args[2]?.type ? `${r.args[1]} ${r.args[2].type}` : r.args[1]));
const OFFSET = GEO.oh - GEO.ih; // 91: a page's y on the display is y + 91

/** A daemon with both ops: it answers daemon.pointerAt with the pointer and plays each path to its last point. */
function newDaemon(h: Harness, pos: Pt = { x: 640, y: 500 }, size = { width: 1280, height: 900 }) {
  const d = { pos, views: 0, moves: [] as any[], answer: undefined as undefined | ((move: any) => any) };
  h.fake.daemon = ({ op, args }) => {
    if (op === "daemon.pointerAt") return { ...d.pos, ...size, views: d.views };
    if (op === "daemon.movePointer") {
      d.moves.push(args[0]);
      if (d.answer) return d.answer(args[0]);
      const last = args[0].path.at(-1);
      d.pos = { x: last.x, y: last.y };
      return { ...d.pos, views: d.views };
    }
    return { error: "unknown op" };
  };
  return d;
}

/** The relay with a daemon of both ops, ready, with the paths on. */
async function onHarness(pos?: Pt) {
  const h = await harness();
  const d = newDaemon(h, pos);
  await h.ready();
  await until(() => h.relay.model.pointerState().paths === "on", "the paths to turn on");
  return { h, d };
}

/** As onHarness, with the relay's step lines (AGENT_BROWSER_POINTER_LOG): a test reads the cause of a step's outcome. */
async function onHarnessLogged(pos?: Pt) {
  process.env.AGENT_BROWSER_POINTER_LOG = "1";
  try { return await onHarness(pos); } finally { delete process.env.AGENT_BROWSER_POINTER_LOG; }
}
/** The step lines of a tab: `relay: step <kind> of tab <id>: <what>; <ms> ms`. */
const stepLines = (h: Harness, tabId: number) => h.logs.filter((l) => l.startsWith("relay: step ") && l.includes(` of tab ${tabId}: `));

/** A page of the connection's own (a window of its own), with auto-attach on. */
async function page(h: Harness, c: CDPConnection) {
  await c.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  const attached = c.waitForEvent("Target.attachedToTarget");
  const { targetId } = await c.send("Target.createTarget", { url: "about:blank" });
  const ev = await attached;
  return { targetId, sessionId: ev.sessionId as string, tab: [...h.fake.tabs.values()].find((t) => t.targetId === targetId)! };
}
type Page = Awaited<ReturnType<typeof page>>;
const mouse = (c: CDPConnection, p: Page, type: string, x: number, y: number, extra: object = {}) =>
  c.send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" || type === "mouseWheel" ? "none" : "left", clickCount: 1, ...extra }, p.sessionId);
const click = async (c: CDPConnection, p: Page, x: number, y: number) => { await mouse(c, p, "mousePressed", x, y); await mouse(c, p, "mouseReleased", x, y); };
const state = (h: Harness) => h.relay.model.pointerState();
const pointOf = (h: Harness, p: Page) => state(h).points[p.targetId] ?? null;

/** Two pages A and B of one client; B (made last) is the front page; each has a last point. */
async function twoPages(h: Harness, a: Pt = { x: 100, y: 100 }, b: Pt = { x: 700, y: 300 }) {
  const c = await h.connect();
  const A = await page(h, c), B = await page(h, c);
  assert.equal(state(h).front, B.tab.id, "a new window is the front page");
  await mouse(c, A, "mouseMoved", a.x, a.y);
  await mouse(c, B, "mouseMoved", b.x, b.y);
  return { c, A, B };
}

/** The order of the ops of the receiver and the daemon from now on, by name. */
function sequence(h: Harness): string[] {
  const seq: string[] = [];
  const op = h.fake.op, daemon = h.fake.daemon;
  h.fake.op = (r) => { seq.push(r.op !== "debugger.sendCommand" ? r.op : r.args[2]?.type ? `${r.args[1]} ${r.args[2].type}` : r.args[1]); return op(r); };
  h.fake.daemon = (r) => { seq.push(r.op); return daemon(r); };
  return seq;
}

// ------------------------------------------------------------------ the path at an activation

test("a page that comes under the pointer: the relay plays a path from the front page's last point S to the entering page's T, then the window comes forward, then the input", async () => {
  const { h, d } = await onHarness({ x: 640, y: 500 });
  try {
    const { c, A, B } = await twoPages(h);
    const seq = sequence(h);
    const t0 = monotonicMs();
    await click(c, A, 100, 100);
    assert.equal(d.moves.length, 1);
    const move = d.moves[0], req = h.fake.daemonRequests.find((r) => r.op === "daemon.movePointer")!;
    assert.deepEqual([move.at, move.from, move.path.at(-1).x, move.path.at(-1).y], [{ x: 640, y: 500 }, { x: 700, y: 300 + OFFSET }, 100, 100 + OFFSET]);
    assert.deepEqual([move.width, move.height, move.views], [1280, 900, 0]);
    assert.ok(move.notAfter >= t0 + 300 && move.notAfter <= monotonicMs() + 300, "notAfter: CLOCK_MONOTONIC + POINTER_START_MS");
    assert.equal(moveProblem([move], monotonicMs()), null, "the move passes C10's checks");
    assert.equal(req.wait, moveWait(move.path), "the request's wait");
    const at = (name: string) => seq.indexOf(name);
    assert.deepEqual(seq.slice(0, 2), ["tabs.get", "windows.get"]);
    assert.ok(at("Runtime.evaluate") < at("daemon.movePointer") && at("daemon.movePointer") < at("windows.update") && at("windows.update") < at("Input.dispatchMouseEvent mousePressed"), seq.join(" "));
    assert.ok(!seq.includes("Page.enable") && !seq.includes("Runtime.enable") && !seq.includes("debugger.attach"), "no enable and no attach of the relay's own");
    // The X records: the answered end is both pages' last point; the entering page is the front page now.
    assert.equal(state(h).front, A.tab.id);
    assert.deepEqual(pointOf(h, B), { x: 100, y: 100, x11: true });
    assert.deepEqual(state(h).at, { x: 100, y: 100 + OFFSET });
    // The client's own press and release set A's point again (no X record).
    assert.deepEqual(pointOf(h, A), { x: 100, y: 100, x11: false });
  } finally { await h.close(); }
});

test("the front page decides, not the focus: the raise sends windows.update with focused true also to a focused window; the same page again plays no path", async () => {
  const { h, d } = await onHarness();
  try {
    const { c, A } = await twoPages(h);
    h.fake.focusedWindow = A.tab.windowId; // A's window has the focus, under B's newer window
    let from = h.fake.requests.length;
    await click(c, A, 100, 100);
    assert.equal(d.moves.length, 1);
    assert.deepEqual(h.fake.sent("windows.update").at(-1)!.args, [A.tab.windowId, { focused: true }]);
    assert.ok(ops(h, from).includes("windows.update"));
    // A is the front page now: its next press is today's activation (focused: no update), with no path.
    from = h.fake.requests.length;
    await click(c, A, 120, 110);
    assert.equal(d.moves.length, 1);
    assert.deepEqual(ops(h, from), ["tabs.get", "windows.get", "Input.dispatchMouseEvent mousePressed", "Input.dispatchMouseEvent mouseReleased"]);
  } finally { await h.close(); }
});

test("Page.bringToFront and Target.activateTarget go through the step with the paths on: behind their tab's gate, a path first, the answer after the step", async () => {
  const { h, d } = await onHarness();
  try {
    const { c, A, B } = await twoPages(h);
    const seq = sequence(h);
    assert.deepEqual(await c.send("Page.bringToFront", {}, A.sessionId), {});
    assert.equal(d.moves.length, 1, "a path for Page.bringToFront");
    assert.ok(seq.indexOf("daemon.movePointer") < seq.indexOf("Page.bringToFront"), seq.join(" "));
    assert.ok(!seq.includes("windows.update"), "the client's own Page.bringToFront raises the window");
    assert.equal(state(h).front, A.tab.id);
    // Target.activateTarget: a path only for a tab that is not active in the front page's window.
    const popup = h.fake.newTab("https://a.example/popup", A.tab, A.tab.windowId);
    await until(() => state(h).front === popup.id, "the popup tab, active in the front page's window, is the front page");
    await mouse(c, A, "mouseMoved", 50, 60);
    await until(() => h.fake.attached.has(popup.id) && state(h).points[popup.targetId] === undefined, "the popup");
    seq.length = 0;
    await c.send("Target.activateTarget", { targetId: A.targetId });
    assert.ok(seq.includes("tabs.update"), seq.join(" "));
    // The popup has no last point: no path, and the read of the pointer records A's point.
    assert.equal(d.moves.length, 1);
    assert.ok(seq.includes("daemon.pointerAt"), seq.join(" "));
    assert.equal(state(h).front, A.tab.id);
    // An active tab's Target.activateTarget: no page comes under the pointer, no path, no read.
    seq.length = 0;
    await c.send("Target.activateTarget", { targetId: A.targetId });
    assert.deepEqual(seq.filter((s) => s.startsWith("daemon.")), []);
    void B;
  } finally { await h.close(); }
});

test("with an old daemon (unknown op) the relay is exactly as today: no path, no read, no catch-up; Page.bringToFront and Target.activateTarget go as today", async () => {
  const h = await harness();
  try {
    await h.ready();
    await until(() => state(h).paths === "off", "the probe's unknown op turns the paths off");
    assert.deepEqual(h.fake.daemonRequests.map((r) => [r.op, r.args, r.wait]), [["daemon.pointerAt", [], 1200]], "one probe at the link up");
    const c = await h.connect();
    const A = await page(h, c), B = await page(h, c);
    await mouse(c, A, "mouseMoved", 100, 100);
    await mouse(c, B, "mouseMoved", 700, 300);
    let from = h.fake.requests.length;
    await click(c, A, 600, 500);
    assert.deepEqual(ops(h, from), ["tabs.get", "windows.get", "windows.update", "Input.dispatchMouseEvent mousePressed", "Input.dispatchMouseEvent mouseReleased"]);
    from = h.fake.requests.length;
    await c.send("Page.bringToFront", {}, B.sessionId);
    await c.send("Target.activateTarget", { targetId: A.targetId });
    assert.deepEqual(ops(h, from), ["Page.bringToFront", "tabs.update"]);
    assert.equal(h.fake.daemonRequests.length, 1, "no daemon op after the probe");
    assert.ok(!h.fake.requests.some((r) => r.args?.[1] === "Page.createIsolatedWorld"), "no geometry read");
  } finally { await h.close(); }
});

test("the probe's states: unknown before its first answer; busy, too many moves and the relay's timer leave them unknown and the next step probes again; an answer turns them on", async () => {
  const h = await harness();
  try {
    const answers: any[] = [{ error: "busy" }, { error: "too many moves" }, undefined, { x: 640, y: 500, width: 1280, height: 900, views: 0 }];
    h.fake.daemon = ({ op }) => (op === "daemon.pointerAt" ? answers.shift() : { error: "unknown op" });
    await h.ready();
    await until(() => h.fake.daemonRequests.length === 1, "the probe");
    await sleep(30);
    assert.equal(state(h).paths, "unknown");
    const c = await h.connect();
    const A = await page(h, c), B = await page(h, c);
    await mouse(c, A, "mouseMoved", 100, 100);
    await mouse(c, B, "mouseMoved", 700, 300);
    await click(c, A, 100, 100); // unknown: no path; the step probes again (too many moves)
    await until(() => h.fake.daemonRequests.length === 2, "the second probe");
    assert.equal(state(h).paths, "unknown");
    await click(c, B, 700, 300); // the third probe gets no answer: the relay's timer
    await until(() => h.fake.daemonRequests.length === 3, "the third probe");
    await sleep(1300);
    assert.equal(state(h).paths, "unknown");
    await click(c, A, 100, 100);
    await until(() => state(h).paths === "on", "the fourth probe's answer");
    assert.equal(state(h).front, null, "the front page is unknown each time the paths turn on");
    assert.ok(!h.fake.daemonRequests.some((r) => r.op === "daemon.movePointer"));
  } finally { await h.close(); }
});

test("unknown op, wrong display and not connected turn the paths off until the next link up; no display for 60 s", async () => {
  for (const [error, until60] of [["unknown op", false], ["wrong display", false], ["not connected", false], ["no display", true]] as const) {
    const h = await harness();
    try {
      h.fake.daemon = () => ({ error });
      await h.ready();
      await until(() => state(h).paths === "off", `${error}: off`);
      assert.equal(state(h).offFor60s, until60, error);
      // The next link up probes again.
      h.fake.daemon = () => ({ x: 1, y: 1, width: 1280, height: 900, views: 0 });
      h.fake.line({ t: "link", up: false });
      await h.ready();
      await until(() => state(h).paths === "on", `${error}: on after the next link up`);
    } finally { await h.close(); }
  }
});

// ------------------------------------------------------------------ the records of step 6

test("the records: ok (both pages, the answered position), at is T (no op), pointer moved (at and the entering page; the front page unknown)", async () => {
  const { h, d } = await onHarness({ x: 640, y: 500 });
  try {
    const { c, A, B } = await twoPages(h);
    // ok, with an end 1 px off T: the answered position is the record, and a log line names it (no point).
    d.answer = (move) => { const last = move.path.at(-1); d.pos = { x: last.x + 1, y: last.y }; return { ...d.pos, views: 0 }; };
    await mouse(c, A, "mousePressed", 100, 100);
    assert.deepEqual([pointOf(h, A), pointOf(h, B)], [{ x: 100, y: 100, x11: false }, { x: 101, y: 100, x11: true }]);
    assert.ok(h.logs.some((l) => /ended .* from its target/.test(l) && !/\d+,\d+/.test(l)), h.logs.join("\n"));
    await mouse(c, A, "mouseReleased", 100, 100);
    // at is T: B's point is where the pointer is; no op, and B's record is T.
    d.answer = undefined;
    await mouse(c, B, "mouseMoved", 101, 100);
    await click(c, B, 101, 100);
    assert.equal(d.moves.length, 1, "no path when at is T");
    assert.equal(state(h).front, B.tab.id);
    // pointer moved: someone moved the pointer; its data is at and the entering page's point; the front page's is unknown.
    await mouse(c, A, "mouseMoved", 300, 200);
    d.answer = () => ({ error: "pointer moved", data: { x: 900, y: 431, views: 2 } });
    await mouse(c, A, "mousePressed", 300, 200);
    assert.deepEqual(state(h).at, { x: 900, y: 431 });
    assert.equal(state(h).views, 2);
    assert.equal(pointOf(h, B), null, "the front page saw the other mover's moves");
    assert.equal(state(h).front, A.tab.id);
  } finally { await h.close(); }
});

test("a failed path (no display, not now, the relay's timer): the relay reads the pointer and records it as at and as both pages' points; a failed read leaves them unknown", async () => {
  for (const fail of ["no display", "not now", "timer"]) {
    const { h, d } = await onHarness({ x: 640, y: 500 });
    try {
      const { c, A, B } = await twoPages(h);
      d.answer = (move) => {
        d.pos = { x: move.path[1].x, y: move.path[1].y }; // the path played a part
        return fail === "timer" ? undefined : { error: fail };
      };
      const t0 = Date.now();
      await mouse(c, A, "mousePressed", 100, 100);
      if (fail === "timer") assert.ok(Date.now() - t0 >= moveWait(d.moves[0].path) - 50, "the relay's timer ended the wait");
      const reads = h.fake.daemonRequests.filter((r) => r.op === "daemon.pointerAt");
      assert.equal(reads.length, 2, `${fail}: the probe and the read after the failed path`);
      assert.deepEqual(state(h).at, d.pos, fail);
      assert.deepEqual(pointOf(h, B), { x: d.pos.x, y: d.pos.y - OFFSET, x11: true }, `${fail}: the front page saw a part of the path`);
      assert.equal(state(h).front, A.tab.id);
      if (fail === "no display") assert.equal(state(h).paths, "off", "no display: off for 60 s");
    } finally { await h.close(); }
  }
  // A failed read after the failed path: the place and both points are unknown.
  const { h, d } = await onHarness();
  try {
    const { c, A, B } = await twoPages(h);
    d.answer = () => ({ error: "not now" });
    const daemon = h.fake.daemon;
    h.fake.daemon = (r) => (r.op === "daemon.pointerAt" ? { error: "busy" } : daemon(r));
    await mouse(c, A, "mousePressed", 100, 100);
    assert.deepEqual([state(h).at, pointOf(h, B)], [null, null]);
    assert.equal(pointOf(h, A)?.x11, false, "A's own press set its point after the step");
  } finally { await h.close(); }
});

test("a step with no path that brings a page under the pointer reads the pointer and records it for the entering page (an X record: the press gets a catch-up from it)", async () => {
  const { h, d } = await onHarness({ x: 640, y: 500 });
  try {
    const c = await h.connect();
    const A = await page(h, c), B = await page(h, c); // B is the front page, with no last point
    void B;
    const reads = h.fake.daemonRequests.filter((r) => r.op === "daemon.pointerAt").length;
    const from = h.fake.requests.length;
    await mouse(c, A, "mousePressed", 30, 30);
    assert.equal(d.moves.length, 0, "S is unknown: no path");
    assert.equal(h.fake.daemonRequests.filter((r) => r.op === "daemon.pointerAt").length, reads + 1, "one read of the pointer");
    assert.equal(state(h).front, A.tab.id);
    // A's record was the pointer (640, 409): the press 600 px from it gets a catch-up of CDP moves first.
    const seq = ops(h, from), press = seq.indexOf("Input.dispatchMouseEvent mousePressed");
    assert.ok(seq.slice(0, press).filter((o) => o === "Input.dispatchMouseEvent mouseMoved").length >= 5, seq.join(" "));
    const moves = h.fake.sent("debugger.sendCommand", "Input.dispatchMouseEvent").slice(0, -1).map((r) => r.args[2]);
    assert.ok(Math.hypot(moves[0].x - 640, moves[0].y - 409) <= 50, "the catch-up starts at the record");
    assert.deepEqual([moves.at(-1).x, moves.at(-1).y], [30, 30], "a press's catch-up ends with a move at its point");
  } finally { await h.close(); }
});

/** A second client after a link change: its sessions on the scope's tabs (auto-attach), by target id. */
async function reattach(h: Harness, n: number) {
  const c = await h.connect();
  const sessions = new Map<string, string>();
  c.on("Target.attachedToTarget", (p: any) => sessions.set(p.targetInfo.targetId, p.sessionId));
  await c.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await until(() => sessions.size >= n, "the sessions of the scope's tabs");
  return { c, sessions };
}

test("a link change: the points of the targets that step 3 lists again stay; at and the front page are unknown; the first activation after it has no path, the next one plays", async () => {
  const { h, d } = await onHarness({ x: 640, y: 500 });
  try {
    const { A, B } = await twoPages(h);
    h.fake.line({ t: "link", up: false });
    await h.ready();
    await until(() => state(h).paths === "on", "on again");
    assert.deepEqual([state(h).front, state(h).at && "known"], [null, "known"], "the probe gave at; the front page is unknown");
    assert.deepEqual([pointOf(h, A), pointOf(h, B)], [{ x: 100, y: 100, x11: false }, { x: 700, y: 300, x11: false }]);
    const { c, sessions } = await reattach(h, 2);
    const PA = { ...A, sessionId: sessions.get(A.targetId)! }, PB = { ...B, sessionId: sessions.get(B.targetId)! };
    await mouse(c, PA, "mousePressed", 100, 100);
    await mouse(c, PA, "mouseReleased", 100, 100);
    assert.equal(d.moves.length, 0, "the front page was unknown");
    assert.equal(state(h).front, A.tab.id);
    await mouse(c, PB, "mousePressed", 700, 300);
    assert.equal(d.moves.length, 1, "from its record on, the front page is known");
  } finally { await h.close(); }
});

// ------------------------------------------------------------------ when no path plays

test("no path when S or T is unknown, outside the front page's viewport, a geometry is not usable, or the path does not fit", async () => {
  const cases: [string, (h: Harness, x: { c: CDPConnection; A: Page; B: Page }) => Promise<void> | void][] = [
    ["T unknown (a child session's input)", async (h, { A }) => {
      h.fake.emit("debugger.onEvent", { source: { tabId: A.tab.id }, method: "Target.attachedToTarget", params: { sessionId: "FR1", waitingForDebugger: false,
        targetInfo: { targetId: "FR1T", type: "iframe", title: "", url: "https://a.example/f", attached: true, canAccessOpener: false, browserContextId: "C1" } } });
      await sleep(20);
      await (h as any).c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5, button: "none" }, "FR1");
    }],
    ["S outside the front page's viewport", async (_h, { c, B }) => { await mouse(c, B, "mouseMoved", 1500, 300); }],
    ["T outside the front page's viewport (A's window moved down)", (h, { A }) => { h.fake.geometry = (id) => (id === A.tab.id ? { ...GEO, sy: 750 } : GEO); }],
    ["a device pixel ratio of 2", (h) => { h.fake.geometry = () => ({ ...GEO, dpr: 2 }); }],
    ["a page scale of 1.5", (h) => { h.fake.geometry = () => ({ ...GEO, scale: 1.5 }); }],
    ["a screen that is not the display's size", (h) => { h.fake.geometry = () => ({ ...GEO, sw: 1920, sh: 1080 }); }],
    ["a device-metrics override on the front page", async (_h, { c, B }) => { await c.send("Emulation.setDeviceMetricsOverride", { width: 600, height: 400, deviceScaleFactor: 1, mobile: false }, B.sessionId); }],
  ];
  for (const [name, setUp] of cases) {
    const { h, d } = await onHarness({ x: 640, y: 500 });
    try {
      const x = await twoPages(h);
      (h as any).c = x.c;
      await setUp(h, x);
      await mouse(x.c, x.A, "mousePressed", 100, 100);
      assert.equal(d.moves.length, 0, name);
      assert.equal(state(h).front, x.A.tab.id, `${name}: the entering page is the front page`);
    } finally { await h.close(); }
  }
});

test("no path when it does not fit the limits (more than 1500 ms: a far target on a large display)", async () => {
  const h = await harness();
  try {
    const d = newDaemon(h, { x: 100, y: 100 }, { width: 3840, height: 2160 });
    h.fake.geometry = () => ({ ...GEO, ow: 3840, oh: 2160, iw: 3840, ih: 2069, sw: 3840, sh: 2160 });
    await h.ready();
    await until(() => state(h).paths === "on", "on");
    const { c, A } = await twoPages(h, { x: 3830, y: 2060 }, { x: 5, y: 5 });
    await mouse(c, A, "mousePressed", 3830, 2060);
    assert.equal(d.moves.length, 0);
  } finally { await h.close(); }
});

test("S equal to T and at elsewhere: a short out-and-back of 2 to 4 px", async () => {
  const { h, d } = await onHarness({ x: 640, y: 500 });
  try {
    const { c, A } = await twoPages(h, { x: 300, y: 200 }, { x: 300, y: 200 });
    await mouse(c, A, "mousePressed", 300, 200);
    assert.equal(d.moves.length, 1);
    const path = d.moves[0].path;
    assert.equal(path.length, 2);
    const out = Math.hypot(path[0].x - 300, path[0].y - (200 + OFFSET));
    assert.ok(out >= 2 && out <= 4, String(out));
    assert.deepEqual([path[1].x, path[1].y], [300, 200 + OFFSET]);
  } finally { await h.close(); }
});

test("at unknown (a failed path whose read failed): the next step reads it first (step 4), then plays", async () => {
  const { h, d } = await onHarness({ x: 640, y: 500 });
  try {
    const { c, A, B } = await twoPages(h);
    d.answer = () => ({ error: "not now" });
    const daemon = h.fake.daemon;
    let busy = true;
    h.fake.daemon = (r) => (r.op === "daemon.pointerAt" && busy ? { error: "busy" } : daemon(r));
    await click(c, A, 100, 100);
    assert.equal(state(h).at, null);
    busy = false; d.answer = undefined;
    await mouse(c, B, "mouseMoved", 700, 300);
    const seq = sequence(h);
    await mouse(c, B, "mousePressed", 700, 300);
    assert.ok(seq.indexOf("daemon.pointerAt") >= 0 && seq.indexOf("daemon.pointerAt") < seq.indexOf("daemon.movePointer"), seq.join(" "));
    assert.deepEqual(d.moves.at(-1).at, { x: 640, y: 500 });
  } finally { await h.close(); }
});

test("at already equal to T: no path; once the live view exists (views above 0) the relay reads the pointer first (build point 2)", async () => {
  const reads = (h: Harness) => h.fake.daemonRequests.filter((r) => r.op === "daemon.pointerAt").length;
  // No live view (views 0): no read, no path; T is the record.
  {
    const { h, d } = await onHarness({ x: 100, y: 100 + OFFSET });
    try {
      const { c, A } = await twoPages(h);
      const n = reads(h);
      await mouse(c, A, "mousePressed", 100, 100);
      assert.deepEqual([d.moves.length, reads(h)], [0, n]);
      assert.equal(state(h).front, A.tab.id);
    } finally { await h.close(); }
  }
  // The live view exists and the pointer did not move: one read, no path.
  for (const moved of [false, true]) {
    const h = await harness();
    try {
      const d = newDaemon(h, { x: 100, y: 100 + OFFSET });
      d.views = 1;
      await h.ready();
      await until(() => state(h).paths === "on", "on");
      const { c, A } = await twoPages(h);
      const n = reads(h);
      if (moved) d.pos = { x: 500, y: 500 }; // the operator's live-view input moved the pointer
      await mouse(c, A, "mousePressed", 100, 100);
      assert.equal(reads(h), n + 1, "a read first");
      assert.equal(d.moves.length, moved ? 1 : 0, moved ? "the pointer moved: a path from the read place" : "still at T: no path");
      if (moved) assert.deepEqual(d.moves[0].at, { x: 500, y: 500 });
    } finally { await h.close(); }
  }
});

// ------------------------------------------------------------------ what the relay keeps: the last points, the front page, the held buttons

test("the last points: both methods set it when sent, on the tab's own session only; a far wheel, a child session's and touch input make it unknown; a near wheel keeps it", async () => {
  const { h } = await onHarness();
  try {
    const c = await h.connect();
    const A = await page(h, c);
    await mouse(c, A, "mouseMoved", 10.5, 20);
    assert.deepEqual(pointOf(h, A), { x: 10.5, y: 20, x11: false });
    await c.send("Input.dispatchDragEvent", { type: "dragOver", x: 30, y: 40, data: { items: [], dragOperationsMask: 1 } }, A.sessionId);
    assert.deepEqual(pointOf(h, A), { x: 30, y: 40, x11: false });
    await mouse(c, A, "mouseWheel", 31, 41, { deltaX: 0, deltaY: 100 });
    assert.deepEqual(pointOf(h, A), { x: 30, y: 40, x11: false }, "a wheel within 2 px keeps the point");
    await mouse(c, A, "mouseWheel", 33, 40, { deltaX: 0, deltaY: 100 });
    assert.equal(pointOf(h, A), null, "a wheel 3 px away: unknown");
    await mouse(c, A, "mouseMoved", 50, 50);
    await c.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 5, y: 5 }] }, A.sessionId);
    assert.equal(pointOf(h, A), null, "touch input: unknown");
    for (const [method, params] of [["Input.emulateTouchFromMouseEvent", { type: "mousePressed", x: 5, y: 5, button: "left" }], ["Input.synthesizeTapGesture", { x: 5, y: 5 }]] as const) {
      await mouse(c, A, "mouseMoved", 50, 50);
      await c.send(method, params, A.sessionId);
      assert.equal(pointOf(h, A), null, method);
    }
    await mouse(c, A, "mouseMoved", 50, 50);
    h.fake.emit("debugger.onEvent", { source: { tabId: A.tab.id }, method: "Target.attachedToTarget", params: { sessionId: "FR1", waitingForDebugger: false,
      targetInfo: { targetId: "FR1T", type: "iframe", title: "", url: "https://a.example/f", attached: true, canAccessOpener: false, browserContextId: "C1" } } });
    await sleep(20);
    await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5, button: "none" }, "FR1");
    assert.equal(pointOf(h, A), null, "a child session's input (a frame's own space): unknown");
  } finally { await h.close(); }
});

test("a point goes at tabs.onRemoved and tabs.onReplaced; the front page is unknown then, and after any Browser.setWindowBounds", async () => {
  const { h } = await onHarness();
  try {
    const { c, A, B } = await twoPages(h);
    assert.equal(state(h).front, B.tab.id);
    const replaced = h.fake.replace(B.tab);
    await until(() => state(h).points[B.targetId] === undefined, "the replaced tab's point goes");
    assert.equal(state(h).front, null);
    await click(c, A, 100, 100);
    assert.equal(state(h).front, A.tab.id);
    await c.send("Target.closeTarget", { targetId: A.targetId });
    await until(() => state(h).points[A.targetId] === undefined, "the removed tab's point goes");
    assert.equal(state(h).front, null);
    const C = await page(h, c);
    assert.equal(state(h).front, C.tab.id);
    const { windowId } = await c.send("Browser.getWindowForTarget", { targetId: C.targetId });
    await c.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
    assert.equal(state(h).front, null, "a normal state can bring a minimized window on top");
    void replaced;
  } finally { await h.close(); }
});

test("the held buttons: a press holds until Chrome answered its release; the hold also ends at tabs.onRemoved, the connection's close, debugger.onDetach and a link change", async () => {
  const { h } = await onHarness();
  try {
    const c = await h.connect();
    const A = await page(h, c);
    let open!: () => void;
    const late = new Promise<void>((r) => (open = r));
    h.fake.command = async (_t, method, params) => { if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased") await late; return undefined; };
    await mouse(c, A, "mousePressed", 5, 5);
    assert.deepEqual(state(h).pressed, [A.tab.id]);
    const released = mouse(c, A, "mouseReleased", 5, 5);
    await sleep(30);
    assert.deepEqual(state(h).pressed, [A.tab.id], "the release is sent, not answered");
    open();
    await released;
    assert.deepEqual(state(h).pressed, []);
    h.fake.command = () => undefined;
    // debugger.onDetach.
    await mouse(c, A, "mousePressed", 5, 5);
    h.fake.emit("debugger.onDetach", { source: { tabId: A.tab.id }, reason: "target_closed" });
    await until(() => !state(h).pressed.length, "the hold ends at debugger.onDetach");
    // The connection's close.
    const c2 = await h.connect();
    const B = await page(h, c2);
    await mouse(c2, B, "mousePressed", 5, 5);
    await c2.close();
    await until(() => !state(h).pressed.length, "the hold ends when the client's connection closes");
    // tabs.onRemoved and a link change.
    const C = await page(h, c);
    await mouse(c, C, "mousePressed", 5, 5);
    h.fake.emit("tabs.onRemoved", { tabId: C.tab.id, removeInfo: { windowId: 1, isWindowClosing: true } });
    await until(() => !state(h).pressed.length, "the hold ends at tabs.onRemoved");
    const D = await page(h, c);
    await mouse(c, D, "mousePressed", 5, 5);
    h.fake.line({ t: "link", up: false });
    await until(() => !state(h).pressed.length, "the hold ends at a link change");
  } finally { await h.close(); }
});

// ------------------------------------------------------------------ step 3: wait and hold

test("step 3: the step waits for the front page's release, then plays; a button of another page does not count", async () => {
  const { h, d } = await onHarness();
  try {
    const c = await h.connect();
    const X = await page(h, c);
    await mouse(c, X, "mouseMoved", 5, 5);
    await mouse(c, X, "mousePressed", 5, 5); // X holds a button; it is not the front page after A and B open
    const A = await page(h, c), B = await page(h, c);
    await mouse(c, A, "mouseMoved", 100, 100);
    await mouse(c, B, "mouseMoved", 700, 300);
    await mouse(c, B, "mousePressed", 700, 300); // the front page B holds a button (its own step: no path)
    const step = mouse(c, A, "mousePressed", 100, 100);
    await sleep(200);
    assert.equal(d.moves.length, 0, "no path while the front page holds a button");
    await mouse(c, X, "mouseReleased", 5, 5);
    await sleep(100);
    assert.equal(d.moves.length, 0, "another page's release changes nothing");
    await mouse(c, B, "mouseReleased", 700, 300);
    await step;
    assert.equal(d.moves.length, 1, "the path after the front page's release");
  } finally { await h.close(); }
});

test("step 3's limit: a front page that holds its button for 3 s gets no path at 2 s, and the input goes on; no real move comes between its press and release", async () => {
  const { h, d } = await onHarnessLogged();
  try {
    const { c, A, B } = await twoPages(h);
    await mouse(c, B, "mousePressed", 700, 300);
    await mouse(c, A, "mousePressed", 100, 100);
    assert.match(stepLines(h, A.tab.id).at(-1) ?? "", /no path \(step 3 reached its limit\)/, "the limit ended the wait");
    assert.equal(d.moves.length, 0, "no path at the limit");
    assert.equal(state(h).front, A.tab.id);
  } finally { await h.close(); }
});

test("step 3: no path when the front page holds a button and its tab has a call that waits in the activation chain (its gate is set, or becomes set during the wait); the chain goes on at once", async () => {
  const { h, d } = await onHarnessLogged();
  try {
    const { c, A, B } = await twoPages(h);
    // B holds a button; its release would wait behind B's next press in the chain, which waits behind A's step.
    await mouse(c, B, "mousePressed", 700, 300);
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    let first = true;
    h.fake.op = async ({ op }) => { if (op === "tabs.get" && first) { first = false; await gate; } return undefined; };
    const a = click(c, A, 100, 100);
    await until(() => h.fake.sent("tabs.get").length, "A's step");
    const b = c.send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", text: "a" }, B.sessionId); // B's call waits in the chain
    const rel = mouse(c, B, "mouseReleased", 700, 300);
    open();
    await Promise.all([a, b, rel]);
    assert.match(stepLines(h, A.tab.id)[0] ?? "", /no path \(the front page holds a button and its next call waits in the activation chain\)/,
      "the gate rule ended the step at once, not a wait for a release that waits behind it");
    assert.equal(d.moves.filter((m) => m.path.at(-1).x === 100 && m.path.at(-1).y === 100 + OFFSET).length, 0, "A's step played no path (B's own step after it may)");
  } finally { await h.close(); }
});

test("step 3: a front page that holds no button plays the path also when its next call waits in the chain (the gate rule is for a held button's release)", async () => {
  const { h, d } = await onHarness();
  try {
    const { c, A, B } = await twoPages(h);
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    let first = true;
    h.fake.op = async ({ op }) => { if (op === "tabs.get" && first) { first = false; await gate; } return undefined; };
    const a = mouse(c, A, "mousePressed", 100, 100);
    await until(() => h.fake.sent("tabs.get").length, "A's step");
    const b = c.send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", text: "a" }, B.sessionId); // B's call waits in the chain; B holds no button
    open();
    await Promise.all([a, b]);
    assert.equal(d.moves.filter((m) => m.path.at(-1).x === 100 && m.path.at(-1).y === 100 + OFFSET).length, 1, "A's step played its path");
  } finally { await h.close(); }
});

test("step 3: the front page's later calls wait behind the step (its gate chained on its old gate), and both pages' pointer input in flight is answered first; a page that holds that answer: no path at 2 s, and the chain goes on", async () => {
  const { h, d } = await onHarness();
  try {
    const { c, A, B } = await twoPages(h);
    // B's move during A's path waits until after the raise.
    const seq = sequence(h);
    d.answer = (move) => { const last = move.path.at(-1); d.pos = { x: last.x, y: last.y }; return new Promise((r) => setTimeout(() => r({ ...d.pos, views: 0 }), 150)); };
    const a = mouse(c, A, "mousePressed", 100, 100);
    await until(() => seq.includes("daemon.movePointer"), "the path");
    const b = mouse(c, B, "mouseMoved", 690, 300);
    await Promise.all([a, b]);
    assert.ok(seq.lastIndexOf("Input.dispatchMouseEvent mouseMoved") > seq.indexOf("windows.update"), seq.join(" "));
    await mouse(c, A, "mouseReleased", 100, 100);
    d.answer = undefined;
    // A's move that Chrome does not answer (a mousemove handler that opens a dialog): A is the front page; B's step waits 2 s, no path.
    h.fake.command = async (_t, method, params) => (method === "Input.dispatchMouseEvent" && params.type === "mouseMoved" && params.x === 77 ? new Promise(() => {}) : undefined);
    void mouse(c, A, "mouseMoved", 77, 77).catch(() => {});
    await sleep(20);
    const t0 = Date.now();
    await mouse(c, B, "mousePressed", 690, 300);
    assert.ok(Date.now() - t0 >= 1900, "the step waited for the in-flight answer up to its limit");
    assert.equal(d.moves.length, 1, "no path at the limit");
    assert.equal(state(h).front, B.tab.id, "the chain went on");
  } finally { await h.close(); }
});

// ------------------------------------------------------------------ the geometry read

test("the geometry read: the relay's own isolated world on the main frame, one evaluate, no enable; the world again when its context is gone; no client sees the world's events", async () => {
  const { h, d } = await onHarness();
  try {
    const { c, A, B } = await twoPages(h);
    await c.send("Runtime.enable", {}, A.sessionId);
    const seen: string[] = [];
    for (const m of ["Runtime.executionContextCreated", "Runtime.executionContextDestroyed", "Debugger.scriptParsed"]) c.on(m, (p: any) => seen.push(`${m} ${JSON.stringify(p)}`));
    await click(c, A, 100, 100);
    const worlds = h.fake.sent("debugger.sendCommand", "Page.createIsolatedWorld");
    assert.deepEqual(worlds.map((r) => [r.args[0], r.args[2].frameId]).sort(), [[{ tabId: A.tab.id }, A.targetId], [{ tabId: B.tab.id }, B.targetId]].sort());
    const name = worlds[0].args[2].worldName;
    const evals = h.fake.sent("debugger.sendCommand", "Runtime.evaluate");
    assert.ok(evals.every((r) => r.args[2].returnByValue === true && r.args[2].contextId !== undefined && r.wait === 600_000), "C10's default wait");
    // Chrome's events of the world (as with Runtime.enable): the relay drops them.
    const ctx = worlds.find((r) => r.args[0].tabId === A.tab.id)!;
    const id = [...h.fake.worlds].find(([, tab]) => tab === A.tab.id)![0];
    h.fake.emit("debugger.onEvent", { source: { tabId: A.tab.id }, method: "Runtime.executionContextCreated", params: { context: { id, origin: "", name, uniqueId: "u1", auxData: { frameId: A.targetId, isDefault: false, type: "isolated" } } } });
    h.fake.emit("debugger.onEvent", { source: { tabId: A.tab.id }, method: "Debugger.scriptParsed", params: { scriptId: "9", url: "", executionContextId: id } });
    h.fake.emit("debugger.onEvent", { source: { tabId: A.tab.id }, method: "Runtime.executionContextDestroyed", params: { executionContextId: id, executionContextUniqueId: "u1" } });
    h.fake.emit("debugger.onEvent", { source: { tabId: A.tab.id }, method: "Runtime.executionContextCreated", params: { context: { id: 5, origin: "https://a.example", name: "", uniqueId: "u5", auxData: { frameId: A.targetId, isDefault: true, type: "default" } } } });
    await until(() => seen.length, "the page's own context");
    await sleep(30);
    assert.deepEqual(seen.map((s) => s.split(" ")[0]), ["Runtime.executionContextCreated"], seen.join("\n"));
    assert.ok(!seen[0].includes(name));
    void ctx;
    // A navigation took the world: the next read gets "Cannot find context" and makes the world again.
    h.fake.worlds.clear();
    await mouse(c, B, "mouseMoved", 700, 300);
    const n = worlds.length;
    await click(c, B, 700, 300);
    assert.equal(d.moves.length, 2);
    assert.ok(h.fake.sent("debugger.sendCommand", "Page.createIsolatedWorld").length >= n + 1, "the world again");
    assert.ok(!h.fake.requests.some((r) => r.args?.[1] === "Page.enable" || (r.args?.[1] === "Runtime.enable" && r.args?.[0].tabId !== A.tab.id)));
  } finally { await h.close(); }
});

test("the geometry read: only for a bridge tab, one in flight per tab, its own 200 ms", async () => {
  const { h, d } = await onHarnessLogged({ x: 100, y: 100 + OFFSET }); // the pointer at A's point: no catch-up after the step
  try {
    const { c, A, B } = await twoPages(h);
    // B's evaluate never answers: the step stops waiting after 200 ms, and plays no path.
    h.fake.command = (_t, method, params) => (method === "Runtime.evaluate" && params.contextId !== undefined && _t.tabId === B.tab.id ? new Promise(() => {}) : undefined);
    await click(c, A, 100, 100);
    assert.match(stepLines(h, A.tab.id).at(-1) ?? "", /no path \(the front page's geometry is not usable \(a read in flight\)\)/,
      "the step went on while B's read was still in flight: the relay's own wait ended");
    assert.equal(d.moves.length, 0);
    // A second step with B: its read is still in flight, so no second evaluate goes to B.
    const evals = () => h.fake.sent("debugger.sendCommand", "Runtime.evaluate").filter((r) => r.args[0].tabId === B.tab.id).length;
    const n = evals();
    await click(c, B, 700, 300);
    assert.equal(evals(), n, "one read in flight per tab");
    assert.equal(d.moves.length, 0);
    // A front page that is no bridge tab (its client detached): no read, no path.
    h.fake.command = () => undefined;
    const c2 = await h.connect("s2");
    const X = await page(h, c2);
    await mouse(c2, X, "mouseMoved", 50, 50);
    await c2.close();
    await until(() => !h.fake.attached.has(X.tab.id), "X detached");
    const worlds = h.fake.sent("debugger.sendCommand", "Page.createIsolatedWorld").length;
    await click(c, A, 100, 100);
    assert.equal(h.fake.sent("debugger.sendCommand", "Page.createIsolatedWorld").filter((r) => r.args[0].tabId === X.tab.id).length, 0);
    assert.ok(h.fake.sent("debugger.sendCommand", "Page.createIsolatedWorld").length >= worlds);
    assert.equal(d.moves.length, 0);
  } finally { await h.close(); }
});

// ------------------------------------------------------------------ the catch-up

test("the catch-up: after an X record, a client's move more than 50 px from it gets CDP moves along a path first, the client's move as its last step; once only", async () => {
  const { h } = await onHarness();
  try {
    const { c, A, B } = await twoPages(h);
    await click(c, A, 100, 100); // a path from B to A: B's point is an X record at (100, 100); A is the front page
    let from = h.fake.requests.length;
    await mouse(c, B, "mouseMoved", 140, 120); // 45 px: no catch-up
    assert.deepEqual(ops(h, from), ["Input.dispatchMouseEvent mouseMoved"]);
    // A path from A to B makes A's point an X record at B's point (140, 120); then A's client moves far.
    await c.send("Page.bringToFront", {}, B.sessionId);
    assert.deepEqual(pointOf(h, A), { x: 140, y: 120, x11: true });
    from = h.fake.requests.length;
    const t0 = Date.now();
    await mouse(c, A, "mouseMoved", 600, 500);
    const sent = h.fake.requests.slice(from).map((r) => r.args[2]);
    assert.ok(sent.length >= 6, `${sent.length} moves`);
    assert.deepEqual([sent.at(-1).x, sent.at(-1).y], [600, 500], "the client's move is the last step");
    let last = { x: 140, y: 120 };
    for (const m of sent) { assert.ok(Math.hypot(m.x - last.x, m.y - last.y) <= 50, "steps of 50 px at most"); assert.equal(m.type, "mouseMoved"); last = m; }
    assert.ok(Math.hypot(sent[0].x - 140, sent[0].y - 120) >= 2, "a first step of 2 px or more");
    assert.ok(Date.now() - t0 >= 250, "the catch-up takes the path's time");
    // Once only: the next far move is the client's own.
    from = h.fake.requests.length;
    await mouse(c, A, "mouseMoved", 100, 100);
    assert.deepEqual(ops(h, from), ["Input.dispatchMouseEvent mouseMoved"]);
  } finally { await h.close(); }
});

test("the catch-up's thresholds: a press or a wheel more than 2 px away (the path ends with a move at its point), never a release or while a button is held", async () => {
  for (const [type, x, want] of [["mousePressed", 103, true], ["mousePressed", 102, false], ["mouseWheel", 103, true], ["mouseReleased", 300, false]] as const) {
    const { h } = await onHarness();
    try {
      const { c, A, B } = await twoPages(h);
      await click(c, A, 100, 100); // B's point is an X record at (100, 100)
      const from = h.fake.requests.length;
      await mouse(c, B, type, x, 100, type === "mouseWheel" ? { deltaX: 0, deltaY: 100 } : {});
      const seq = ops(h, from).filter((o) => o.startsWith("Input."));
      const moves = seq.filter((o) => o === "Input.dispatchMouseEvent mouseMoved").length;
      assert.equal(moves > 0, want, `${type} at ${x}: ${seq.join(" ")}`);
      if (want) assert.deepEqual([h.fake.requests.at(-2)!.args[2].x, h.fake.requests.at(-2)!.args[2].type], [x, "mouseMoved"], "the last move is at the event's point");
    } finally { await h.close(); }
  }
  // While a button is held: no catch-up.
  const { h } = await onHarness();
  try {
    const { c, A, B } = await twoPages(h);
    await click(c, A, 100, 100);
    await c.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 100, y: 100, button: "left", clickCount: 1 }, B.sessionId);
    const from = h.fake.requests.length;
    await mouse(c, B, "mouseMoved", 400, 400, { buttons: 1 });
    assert.deepEqual(ops(h, from), ["Input.dispatchMouseEvent mouseMoved"]);
  } finally { await h.close(); }
});

test("the catch-up is decided when the event leaves the tab's gate (a move that waited behind a step starts at its record), and it is a step of the gate: later calls wait behind it", async () => {
  const { h } = await onHarness();
  try {
    const { c, A, B } = await twoPages(h);
    const seq = sequence(h);
    // A's press: a path from B to A. B's client sends a far move during the path: it waits behind the step, then the
    // catch-up from B's record (100, 100) runs, then B's move, then B's evaluate.
    const a = mouse(c, A, "mousePressed", 100, 100);
    await until(() => seq.includes("daemon.movePointer"), "the path");
    const b = mouse(c, B, "mouseMoved", 600, 600);
    const e = c.send("Runtime.evaluate", { expression: "1" }, B.sessionId);
    await Promise.all([a, b, e]);
    const after = seq.slice(seq.indexOf("windows.update"));
    const moves = after.filter((o) => o === "Input.dispatchMouseEvent mouseMoved").length;
    assert.ok(moves >= 6, after.join(" "));
    assert.equal(after.at(-1), "Runtime.evaluate", "the evaluate waited behind the catch-up");
  } finally { await h.close(); }
});

/** The order of the ops, with the tab of each CDP command. */
function sequenceByTab(h: Harness): string[] {
  const seq: string[] = [];
  const op = h.fake.op, daemon = h.fake.daemon;
  h.fake.op = (r) => { seq.push(r.op !== "debugger.sendCommand" ? r.op : `${r.args[1]} ${r.args[2]?.type ?? ""} tab ${r.args[0].tabId}`); return op(r); };
  h.fake.daemon = (r) => { seq.push(r.op); return daemon(r); };
  return seq;
}

test("a step waits for a catch-up that runs in its front page: the two never overlap on one page", async () => {
  const { h, d } = await onHarness();
  try {
    const { c, A, B } = await twoPages(h);
    await c.send("Page.bringToFront", {}, A.sessionId); // a path from B to A: A is the front page, its point an X record
    assert.equal(d.moves.length, 1);
    await mouse(c, B, "mouseMoved", 130, 100); // 30 px from B's record: no catch-up; B's point is not at

    const seq = sequenceByTab(h);
    const a = mouse(c, A, "mouseMoved", 700, 600); // a catch-up in the front page A
    await until(() => seq.filter((o) => o.startsWith(`Input.dispatchMouseEvent mouseMoved tab ${A.tab.id}`)).length >= 2, "the catch-up runs");
    const b = mouse(c, B, "mousePressed", 130, 100); // B's step: it waits for A's catch-up
    await Promise.all([a, b]);
    const lastA = seq.lastIndexOf(`Input.dispatchMouseEvent mouseMoved tab ${A.tab.id}`);
    assert.ok(seq.indexOf("daemon.movePointer") > lastA, seq.join("\n"));
    assert.equal(d.moves.length, 2);
    assert.deepEqual(d.moves[1].from, { x: 700, y: 600 + OFFSET }, "S is the client's move after the catch-up");
  } finally { await h.close(); }
});

test("a page that answers no move: the catch-up stops at 4 unanswered moves (per tab), the client's event goes, and its Page.handleJavaScriptDialog reaches Chrome; the stops are counted and logged", async () => {
  const { h } = await onHarness();
  try {
    const { c, A, B } = await twoPages(h);
    await click(c, A, 100, 100); // B's point is an X record at (100, 100)
    // B's page has an open dialog: Chrome answers none of its moves.
    h.fake.command = (t, method, params) => (t.tabId === B.tab.id && method === "Input.dispatchMouseEvent" && params.type === "mouseMoved" ? new Promise(() => {}) : undefined);
    const from = h.fake.requests.length;
    void mouse(c, B, "mouseMoved", 900, 700).catch(() => {}); // over 800 px: a catch-up of more than 4 moves
    await until(() => h.fake.requests.slice(from).filter((r) => r.args?.[2]?.x === 900).length, "the client's move");
    const moves = h.fake.requests.slice(from).filter((r) => r.args?.[1] === "Input.dispatchMouseEvent");
    assert.equal(moves.length, 5, "4 catch-up moves, then the client's move");
    assert.equal(state(h).catchUpStops, 1);
    assert.ok(h.logs.some((l) => /catch-up .* stopped at 4 unanswered moves/.test(l)), h.logs.join("\n"));
    assert.deepEqual(await c.send("Page.handleJavaScriptDialog", { accept: true }, B.sessionId), {});
    // Per tab (review-63e note E): while its 4 moves wait, no catch-up starts. B comes forward with no path (its moves in
    // flight hold step 3 to its limit), and the read gives it a new X record; B's next far move goes as it is.
    await c.send("Page.bringToFront", {}, B.sessionId);
    assert.equal(pointOf(h, B)?.x11, true);
    const at = h.fake.requests.length;
    void mouse(c, B, "mouseMoved", 10, 10).catch(() => {});
    await until(() => h.fake.requests.length > at, "B's move");
    await sleep(100);
    assert.deepEqual(ops(h, at), ["Input.dispatchMouseEvent mouseMoved"]);
    void A;
  } finally { await h.close(); }
});

// ------------------------------------------------------------------ the geometry cache (ab-lead's decision on point 1) and the content box (point 5)

test("a front page that is no bridge tab (its client left, as agent-browser's CLI does after each command) uses its last geometry from the relay's own read: the path plays; with no such read, no path", async () => {
  const { h, d } = await onHarness();
  try {
    const c = await h.connect();
    const A = await page(h, c);
    const c2 = await h.connect("s2");
    const B = await page(h, c2);
    await mouse(c, A, "mouseMoved", 100, 100);
    await mouse(c2, B, "mouseMoved", 700, 300);
    // B's step: a path from A (B's geometry is read live: B is a bridge tab); then B's client leaves and B is detached.
    await click(c2, B, 700, 300);
    assert.equal(d.moves.length, 0, "A was no front page yet (B, the newer window, was): no path, a read");
    await click(c, A, 100, 100); // a path from B to A: both geometries read live
    assert.equal(d.moves.length, 1);
    await mouse(c2, B, "mouseMoved", 700, 300); // B's point is its client's again (after a catch-up from its record)
    await click(c2, B, 700, 300); // a path from A to B: B is the front page now, its geometry read
    assert.equal(d.moves.length, 2);
    await c2.close();
    await until(() => !h.fake.attached.has(B.tab.id), "B detached");
    const reads = h.fake.sent("debugger.sendCommand", "Runtime.evaluate").filter((r) => r.args[0].tabId === B.tab.id).length;
    const attaches = h.fake.sent("debugger.attach").filter((r) => r.args[0] === B.tab.id).length;
    await mouse(c, A, "mouseMoved", 300, 200);
    await mouse(c, A, "mousePressed", 300, 200);
    assert.equal(d.moves.length, 3, "a path from B's last point with B's last geometry");
    assert.deepEqual(d.moves[2].from, { x: 700, y: 300 + OFFSET });
    assert.equal(h.fake.sent("debugger.sendCommand", "Runtime.evaluate").filter((r) => r.args[0].tabId === B.tab.id).length, reads, "no read of a tab that is no bridge tab");
    assert.equal(h.fake.sent("debugger.attach").filter((r) => r.args[0] === B.tab.id).length, attaches, "no attach of the relay's own");
  } finally { await h.close(); }
});

test("the cached geometry goes at Browser.setWindowBounds, a device-metrics override and Page.frameResized (a replaced tab and a link change leave no entry of the tab): then no path from that page", async () => {
  const drops: [string, (h: Harness, x: { c: CDPConnection; c2: CDPConnection; A: Page; B: Page }) => Promise<void>][] = [
    // Browser.setWindowBounds also makes the front page unknown: B comes forward again with no path, and the read of the
    // pointer fails, so that step reads no geometry of B; B is the front page with no geometry read since the change.
    ["Browser.setWindowBounds", async (h, { c, c2, A, B }) => {
      const { windowId } = await c.send("Browser.getWindowForTarget", { targetId: A.targetId });
      await c.send("Browser.setWindowBounds", { windowId, bounds: { left: 10 } });
      const daemon = h.fake.daemon;
      let busy = true;
      h.fake.daemon = (r) => (r.op === "daemon.pointerAt" && busy ? (busy = false, { error: "busy" }) : daemon(r));
      h.fake.focusedWindow = 1; // another window has the focus: the relay raises B's window (a front page only by a raise)
      await click(c2, B, 700, 300);
      assert.equal(h.relay.model.pointerState().front, B.tab.id);
    }],
    ["Emulation.setDeviceMetricsOverride", async (_h, { c2, B }) => { await c2.send("Emulation.setDeviceMetricsOverride", { width: 600, height: 400, deviceScaleFactor: 1, mobile: false }, B.sessionId); }],
    ["Page.frameResized", async (h, { B }) => { h.fake.emit("debugger.onEvent", { source: { tabId: B.tab.id }, method: "Page.frameResized", params: {} }); await sleep(20); }],
  ];
  for (const [name, drop] of drops) {
    const { h, d } = await onHarness();
    try {
      const c = await h.connect(), c2 = await h.connect("s2");
      const A = await page(h, c), B = await page(h, c2);
      await mouse(c, A, "mouseMoved", 100, 100);
      await mouse(c2, B, "mouseMoved", 700, 300);
      await click(c, A, 100, 100);
      await click(c2, B, 700, 300); // B is the front page; its geometry is in the cache
      const n = d.moves.length;
      await drop(h, { c, c2, A, B });
      await c2.close();
      await until(() => !h.fake.attached.has(B.tab.id), "B detached");
      await mouse(c, A, "mouseMoved", 300, 200);
      await mouse(c, A, "mousePressed", 300, 200);
      assert.equal(d.moves.length, n, `${name}: no cached geometry, no path`);
    } finally { await h.close(); }
  }
});

test("the clamp is the content box: no path point over a scrollbar, and S or T over a scrollbar gives no path", async () => {
  const { h, d } = await onHarness({ x: 640, y: 500 });
  try {
    // A vertical scrollbar (15 px) and a horizontal one (15 px) in both pages: content 1265 x 794 of a 1280 x 809 viewport.
    h.fake.geometry = () => ({ ...GEO, cw: 1265, ch: 794 });
    const { c, A, B } = await twoPages(h, { x: 1255, y: 780 }, { x: 60, y: 60 });
    for (let i = 0; i < 4; i++) {
      await mouse(c, A, "mouseMoved", 1255 - i, 780 - i);
      await click(c, A, 1255 - i, 780 - i);
      await mouse(c, B, "mouseMoved", 40 + i * 30, 785 - i);
      await click(c, B, 40 + i * 30, 785 - i);
    }
    assert.ok(d.moves.length >= 6, `${d.moves.length} paths`);
    for (const m of d.moves) for (const p of m.path) assert.ok(p.x <= 1262 && p.y <= OFFSET + 791, `${p.x},${p.y} over a scrollbar`);
    // T over the vertical scrollbar (x 1270 of 1280): no path.
    const n = d.moves.length;
    await mouse(c, A, "mouseMoved", 1270, 300);
    await click(c, A, 1270, 300);
    assert.equal(d.moves.length, n, "T over the scrollbar: no path");
  } finally { await h.close(); }
});

test("the catch-up is clamped to the content box too; the event's own point stays where the client sent it", async () => {
  const { h } = await onHarness();
  try {
    h.fake.geometry = () => ({ ...GEO, cw: 1265, ch: 794 });
    const { c, A, B } = await twoPages(h, { x: 100, y: 100 }, { x: 600, y: 760 });
    await click(c, A, 100, 100); // a path from B to A: B's point is an X record at (100, 100)
    const from = h.fake.requests.length;
    await mouse(c, B, "mousePressed", 1272, 790); // a press over the vertical scrollbar, far from the record
    const sent = h.fake.requests.slice(from).filter((r) => r.args?.[1] === "Input.dispatchMouseEvent").map((r) => r.args[2]);
    const moves = sent.filter((p) => p.type === "mouseMoved");
    assert.ok(moves.length >= 6, `${moves.length} catch-up moves`);
    for (const p of moves.slice(0, -1)) assert.ok(p.x <= 1262 && p.y <= 791, `${p.x},${p.y} over a scrollbar`);
    assert.deepEqual([moves.at(-1).x, moves.at(-1).y, sent.at(-1).type], [1272, 790, "mousePressed"], "the path ends with a move at the press's own point");
  } finally { await h.close(); }
});

// ------------------------------------------------------------------ review-68 (B1-B3, N1-N4, a minimized window)

test("review-68 B1: each geometry read makes the relay's world first and evaluates in the id that it returns; an old id that now names a page's world is never read, and its events reach the client", async () => {
  const { h, d } = await onHarness();
  try {
    const { c, A, B } = await twoPages(h);
    await c.send("Runtime.enable", {}, A.sessionId);
    const seen: string[] = [];
    c.on("Debugger.scriptParsed", (p: any) => seen.push(`scriptParsed ${p.executionContextId}`));
    c.on("Runtime.executionContextDestroyed", (p: any) => seen.push(`destroyed ${p.executionContextId}`));
    await click(c, A, 100, 100); // a path from B to A: one world and one read for each page
    const worldOf = (tabId: number) => h.fake.sent("debugger.sendCommand", "Page.createIsolatedWorld").filter((r) => r.args[0].tabId === tabId).length;
    const old = [...h.fake.worlds].filter(([, tab]) => tab === A.tab.id).map(([id]) => id).at(-1)!;
    // A cross-site navigation of A with no Runtime events: Chromium gives the old id to a page's own world, whose
    // screenX getter lies (4242).
    h.fake.pageWorlds.set(old, { ...GEO, sx: 4242 });
    const n = worldOf(A.tab.id);
    await mouse(c, B, "mouseMoved", 700, 300);
    await click(c, B, 700, 300); // a path from A to B: A's read makes a world again
    assert.equal(worldOf(A.tab.id), n + 1, "Page.createIsolatedWorld before the read");
    const evals = h.fake.sent("debugger.sendCommand", "Runtime.evaluate").filter((r) => r.args[0].tabId === A.tab.id && r.args[2].contextId !== undefined);
    assert.notEqual(evals.at(-1)!.args[2].contextId, old, "the read names the id that the new world got");
    assert.equal(d.moves.length, 2);
    assert.deepEqual(d.moves[1].from, { x: 100, y: 100 + OFFSET }, "S mapped with the honest geometry, not the page's 4242");
    // The old id's events are the page's now: the client gets them.
    h.fake.emit("debugger.onEvent", { source: { tabId: A.tab.id }, method: "Debugger.scriptParsed", params: { scriptId: "9", url: "", executionContextId: old } });
    h.fake.emit("debugger.onEvent", { source: { tabId: A.tab.id }, method: "Runtime.executionContextDestroyed", params: { executionContextId: old, executionContextUniqueId: "page-u" } });
    await until(() => seen.length >= 2, "the page's events");
    assert.deepEqual(seen, [`scriptParsed ${old}`, `destroyed ${old}`]);
  } finally { await h.close(); }
});

test("review-68 B2: a press on a frame's (child) session is a held button of its page: no path while it holds", async () => {
  // The step's log line (times and counts) names why the step played no path: the release, not step 3's limit.
  const { h, d } = await onHarnessLogged();
  try {
    const c = await h.connect(), c2 = await h.connect("s2");
    const A = await page(h, c2), B = await page(h, c);
    h.fake.emit("debugger.onEvent", { source: { tabId: B.tab.id }, method: "Target.attachedToTarget", params: { sessionId: "FR1", waitingForDebugger: false,
      targetInfo: { targetId: "FR1T", type: "iframe", title: "", url: "https://a.example/f", attached: true, canAccessOpener: false, browserContextId: "C1" } } });
    await sleep(30);
    await mouse(c2, A, "mouseMoved", 100, 100);
    await c.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 5, y: 5, button: "left", clickCount: 1 }, "FR1");
    await mouse(c, B, "mouseMoved", 700, 300);
    assert.deepEqual(state(h).pressed, [B.tab.id]);
    const seq: string[] = [];
    const op = h.fake.op;
    h.fake.op = (r) => {
      if (r.op === "windows.update") seq.push("A's raise");
      if (r.op === "debugger.sendCommand" && r.args[0].sessionId === "FR1" && r.args[2]?.type === "mouseReleased") seq.push("the frame's release");
      return op(r);
    };
    const step = mouse(c2, A, "mousePressed", 100, 100);
    await sleep(300);
    assert.equal(d.moves.length, 0, "no path while the frame holds the button");
    await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 5, y: 5, button: "left", clickCount: 1 }, "FR1");
    await step;
    assert.deepEqual(seq, ["the frame's release", "A's raise"], "A's step waited for the frame's release");
    // The release ended the wait, not step 3's limit: the frame's release is a child session's input, so B's point is
    // unknown after it, and that is the step's reason for no path.
    const line = h.logs.find((l) => l.startsWith(`relay: step input of tab ${A.tab.id}:`));
    assert.match(line ?? "", /no path \(a last point is unknown\)/, h.logs.join("\n"));
    assert.equal(d.moves.length, 0);
  } finally { await h.close(); }
});

test("review-68 B3: a client's Browser.setWindowBounds waits for a step that plays a path; the window moves after the path", async () => {
  const { h, d } = await onHarness();
  try {
    const c = await h.connect(), c2 = await h.connect("s2");
    const A = await page(h, c2), B = await page(h, c);
    await mouse(c2, A, "mouseMoved", 100, 100);
    await mouse(c, B, "mouseMoved", 700, 300);
    const seq: string[] = [];
    const op = h.fake.op;
    h.fake.op = (r) => { if (r.op === "windows.update") seq.push(`windows.update ${r.args[1].left !== undefined ? "bounds" : "focus"}`); return op(r); };
    d.answer = (move) => { seq.push("path"); const last = move.path.at(-1); d.pos = { x: last.x, y: last.y };
      return new Promise((r) => setTimeout(() => { seq.push("path end"); r({ ...d.pos, views: 0 }); }, 400)); };
    const a = mouse(c2, A, "mousePressed", 100, 100);
    await until(() => d.moves.length === 1, "the path");
    const { windowId } = await c.send("Browser.getWindowForTarget", { targetId: B.targetId });
    await c.send("Browser.setWindowBounds", { windowId, bounds: { left: 300, top: 200 } });
    await a;
    assert.deepEqual(seq, ["path", "path end", "windows.update focus", "windows.update bounds"]);
  } finally { await h.close(); }
});

test("review-68 N1: with the front page unknown, a page whose window has the focus gets no raise and does not become the front page; the next step plays no path", async () => {
  const { h, d } = await onHarness();
  try {
    const c = await h.connect();
    const A = await page(h, c);
    await click(c, A, 100, 100); // A's window gets the focus (front unknown? A was the newest window: the front page)
    const B = await page(h, c);
    await mouse(c, B, "mouseMoved", 700, 300);
    const W = await page(h, c); // the newest window: on top, no focus
    const { windowId } = await c.send("Browser.getWindowForTarget", { targetId: W.targetId });
    await c.send("Browser.setWindowBounds", { windowId, bounds: { left: 0, top: 0 } });
    assert.equal(state(h).front, null);
    const from = h.fake.requests.length;
    await click(c, A, 100, 100);
    assert.deepEqual(h.fake.requests.slice(from).filter((r) => r.op === "windows.update" || r.op === "tabs.update").length, 0, "no raise: A's window has the focus");
    assert.equal(state(h).front, null, "no raise that the relay sent: the front page stays unknown");
    await click(c, B, 700, 300);
    assert.equal(d.moves.length, 0, "no path over A's area, where W's window can be on top");
    assert.equal(state(h).front, B.tab.id, "B's window got windows.update: B is the front page");
  } finally { await h.close(); }
});

test("review-68 N2 and a minimized or hidden page: a read that is not usable drops the kept geometry, and such a read is never kept", async () => {
  const cases: [string, (h: Harness, B: Page) => void][] = [
    ["a scale of 2", (h, B) => { h.fake.geometry = (id) => (id === B.tab.id ? { ...GEO, scale: 2 } : GEO); }],
    ["a hidden page", (h, B) => { h.fake.geometry = (id) => (id === B.tab.id ? { ...GEO, vis: "hidden" } : GEO); }],
    ["a minimized window", (h, B) => { const op = h.fake.op; h.fake.op = (r) => (r.op === "windows.get" && r.args[0] === B.tab.windowId ? { id: r.args[0], left: 0, top: 0, width: 1280, height: 800, state: "minimized", type: "normal", focused: false } : op(r)); }],
  ];
  for (const [name, spoil] of cases) {
    const { h, d } = await onHarness();
    try {
      const c = await h.connect(), c2 = await h.connect("s2");
      const A = await page(h, c2), B = await page(h, c);
      await mouse(c2, A, "mouseMoved", 100, 100);
      await mouse(c, B, "mouseMoved", 700, 300);
      await click(c2, A, 100, 100); // a path from B to A: B's usable geometry is kept
      assert.equal(d.moves.length, 1);
      spoil(h, B);
      await mouse(c, B, "mouseMoved", 650, 300);
      await click(c, B, 650, 300); // B's step: its read is not usable (no path), and B is the front page
      const n = d.moves.length;
      await c.close();
      await until(() => !h.fake.attached.has(B.tab.id), "B detached");
      await mouse(c2, A, "mouseMoved", 300, 300);
      await mouse(c2, A, "mousePressed", 300, 300);
      assert.equal(d.moves.length, n, `${name}: the older geometry was dropped: no path`);
    } finally { await h.close(); }
  }
});

test("review-68 N3: when the step's first reads fail, Target.activateTarget's tabs.update has the step's 2 s limit too", async () => {
  const { h } = await onHarness();
  try {
    const { c, A } = await twoPages(h);
    let open!: () => void;
    const never = new Promise<void>((r) => (open = r));
    h.fake.op = async ({ op, args }) => { if ((op === "tabs.get" || op === "tabs.update") && args[0] === A.tab.id) await never; return undefined; };
    await c.send("Target.activateTarget", { targetId: A.targetId });
    // The cause: two limits ended it (the reads of steps 1 and 2, then the tabs.update), not the bridge's 30 s wait.
    assert.equal(h.logs.filter((l) => l === `relay: the activation of tab ${A.tab.id} took more than 2000 ms; the input goes on`).length, 2, h.logs.join("\n"));
    open();
  } finally { await h.close(); }
});

test("review-68 N4: step 3's wait for a release keeps one wait at a time on the front page", async () => {
  const { h } = await onHarness();
  try {
    const { c, A, B } = await twoPages(h);
    await mouse(c, B, "mousePressed", 700, 300); // B, the front page, holds its button
    const step = mouse(c, A, "mousePressed", 100, 100);
    let most = 0;
    for (let i = 0; i < 20; i++) { await sleep(30); most = Math.max(most, state(h).releaseWaits); }
    await mouse(c, B, "mouseReleased", 700, 300);
    await step;
    assert.ok(most <= 1, `${most} waits at once`);
    assert.equal(state(h).releaseWaits, 0);
  } finally { await h.close(); }
});

test("review-68 N1: with the front page unknown, a tab switch in a focused window (an input, or Target.activateTarget) raises no window: no record, and the front page stays unknown", async () => {
  for (const how of ["input", "activateTarget"] as const) {
    const { h } = await onHarness();
    try {
      const c = await h.connect();
      const A = await page(h, c);
      await click(c, A, 100, 100); // A's window has the focus
      const popup = h.fake.newTab("https://a.example/popup", A.tab, A.tab.windowId); // a popup tab in front of A in A's window
      await until(() => h.fake.attached.has(popup.id), "the popup");
      const { windowId } = await c.send("Browser.getWindowForTarget", { targetId: A.targetId });
      await c.send("Browser.setWindowBounds", { windowId, bounds: { left: 0, top: 0 } });
      assert.equal(state(h).front, null);
      const reads = h.fake.daemonRequests.filter((r) => r.op === "daemon.pointerAt").length, from = h.fake.requests.length;
      if (how === "input") await c.send("Input.insertText", { text: "x" }, A.sessionId);
      else await c.send("Target.activateTarget", { targetId: A.targetId });
      assert.deepEqual(h.fake.requests.slice(from).filter((r) => r.op === "tabs.update" || r.op === "windows.update").map((r) => r.op), ["tabs.update"], how);
      assert.equal(state(h).front, null, `${how}: a tab switch raises no window`);
      assert.equal(h.fake.daemonRequests.filter((r) => r.op === "daemon.pointerAt").length, reads, `${how}: no record`);
    } finally { await h.close(); }
  }
});

// ------------------------------------------------------------------ round 3 (review-68c)

test("round 3: a read keeps or drops the kept geometry only when it answers within its wait and no drop event came after it started; a late answer changes nothing", async () => {
  // A drop event (Page.frameResized) while B's read runs: the read answers within its wait, but nothing is kept.
  {
    const { h } = await onHarness();
    try {
      const { c, A, B } = await twoPages(h);
      h.fake.command = async (t, method, params) => {
        if (method === "Runtime.evaluate" && params.contextId !== undefined && t.tabId === B.tab.id) {
          await sleep(60);
          h.fake.emit("debugger.onEvent", { source: { tabId: B.tab.id }, method: "Page.frameResized", params: {} });
          await sleep(60);
        }
        return undefined;
      };
      await click(c, A, 100, 100); // A's step reads B, the front page
      assert.equal(state(h).kept[B.tab.id], undefined, "a drop event after the read started: the read keeps nothing");
      assert.ok(state(h).kept[A.tab.id], "A's own read is kept");
    } finally { await h.close(); }
  }
  // A late answer: B's kept geometry stays as it was (sx 0), also when the late read gives another one (sx 50).
  {
    const { h } = await onHarness();
    try {
      const { c, A, B } = await twoPages(h);
      await click(c, A, 100, 100); // B's read is kept (sx 0)
      assert.equal(state(h).kept[B.tab.id]?.sx, 0);
      h.fake.geometry = (id) => (id === B.tab.id ? { ...GEO, sx: 50 } : GEO);
      h.fake.command = async (t, method, params) => { if (method === "Runtime.evaluate" && params.contextId !== undefined && t.tabId === B.tab.id) await sleep(350); return undefined; };
      await mouse(c, B, "mouseMoved", 700, 300);
      await click(c, B, 700, 300); // B's step reads B (the entering page): its answer comes after 200 ms
      await sleep(400);
      assert.equal(state(h).kept[B.tab.id]?.sx, 0, "the late answer changed nothing");
    } finally { await h.close(); }
  }
});

test("round 3: the one more try: when the first evaluate names an unknown context, the relay makes its world again and reads once more", async () => {
  const { h, d } = await onHarness();
  try {
    const { c, A, B } = await twoPages(h);
    let failed = false;
    h.fake.command = (t, method, params) => {
      if (method === "Runtime.evaluate" && params.contextId !== undefined && t.tabId === A.tab.id && !failed) {
        failed = true;
        return { error: JSON.stringify({ code: -32000, message: "Cannot find context with specified id" }) };
      }
      return undefined;
    };
    await click(c, A, 100, 100);
    assert.ok(failed);
    assert.equal(h.fake.sent("debugger.sendCommand", "Page.createIsolatedWorld").filter((r) => r.args[0].tabId === A.tab.id).length, 2, "a world again for the second try");
    assert.equal(d.moves.length, 1, "the second read gave the geometry: the path plays");
    void B;
  } finally { await h.close(); }
});

test("round 3: Runtime.executionContextsCleared empties the set of the world's ids and still goes to the client", async () => {
  const { h } = await onHarness();
  try {
    const { c, A } = await twoPages(h);
    await c.send("Runtime.enable", {}, A.sessionId);
    const seen: string[] = [];
    c.on("Runtime.executionContextsCleared", () => seen.push("cleared"));
    c.on("Debugger.scriptParsed", (p: any) => seen.push(`scriptParsed ${p.executionContextId}`));
    await click(c, A, 100, 100); // A's read: its world's id is in the set
    const id = [...h.fake.worlds].filter(([, tab]) => tab === A.tab.id).map(([i]) => i).at(-1)!;
    h.fake.emit("debugger.onEvent", { source: { tabId: A.tab.id }, method: "Debugger.scriptParsed", params: { scriptId: "1", url: "", executionContextId: id } });
    h.fake.emit("debugger.onEvent", { source: { tabId: A.tab.id }, method: "Runtime.executionContextsCleared", params: {} });
    h.fake.emit("debugger.onEvent", { source: { tabId: A.tab.id }, method: "Debugger.scriptParsed", params: { scriptId: "2", url: "", executionContextId: id } });
    await until(() => seen.length >= 2, "the events");
    await sleep(30);
    assert.deepEqual(seen, ["cleared", `scriptParsed ${id}`], "the world's script is dropped before the clear; after it the id is the page's");
  } finally { await h.close(); }
});

test("round 3: B3's wait behind the window's catch-ups: a client's Browser.setWindowBounds moves the window after the catch-up in its page", async () => {
  const { h } = await onHarness();
  try {
    const { c, A, B } = await twoPages(h);
    await click(c, A, 100, 100); // a path from B to A: B's point is an X record at (100, 100)
    const seq: string[] = [];
    const op = h.fake.op;
    h.fake.op = (r) => {
      if (r.op === "windows.update") seq.push(`windows.update ${r.args[1].left !== undefined ? "bounds" : "focus"}`);
      if (r.op === "debugger.sendCommand" && r.args[1] === "Input.dispatchMouseEvent" && r.args[0].tabId === B.tab.id) seq.push(`move ${r.args[2].x}`);
      return op(r);
    };
    const far = mouse(c, B, "mouseMoved", 900, 600); // a catch-up in B
    await until(() => seq.filter((x) => x.startsWith("move")).length >= 2, "the catch-up");
    const { windowId } = await c.send("Browser.getWindowForTarget", { targetId: B.targetId });
    await c.send("Browser.setWindowBounds", { windowId, bounds: { left: 300 } });
    await far;
    assert.equal(seq.at(-1), "windows.update bounds", seq.join(" "));
    assert.equal(seq.at(-2), "move 900", "the client's own move, the catch-up's last step, came first");
  } finally { await h.close(); }
});

test("round 3: a failed read drops the kept geometry", async () => {
  const { h } = await onHarness();
  try {
    const { c, A, B } = await twoPages(h);
    await click(c, A, 100, 100);
    assert.ok(state(h).kept[B.tab.id], "B's read is kept");
    h.fake.command = (t, method, params) => (method === "Runtime.evaluate" && params.contextId !== undefined && t.tabId === B.tab.id ? { error: JSON.stringify({ code: -32000, message: "Target closed" }) } : undefined);
    await mouse(c, B, "mouseMoved", 700, 300);
    await click(c, B, 700, 300);
    assert.equal(state(h).kept[B.tab.id], undefined);
  } finally { await h.close(); }
});

test("round 3: a catch-up's own read keeps no geometry", async () => {
  const { h } = await onHarness();
  try {
    const { c, A, B } = await twoPages(h);
    await click(c, A, 100, 100); // a path from B to A: B's point is an X record; B's read is kept
    h.fake.emit("debugger.onEvent", { source: { tabId: B.tab.id }, method: "Page.frameResized", params: {} });
    await until(() => state(h).kept[B.tab.id] === undefined, "the drop");
    const reads = h.fake.sent("debugger.sendCommand", "Runtime.evaluate").filter((r) => r.args[0].tabId === B.tab.id).length;
    await mouse(c, B, "mouseMoved", 900, 600); // a catch-up in B: it reads B's geometry for its clamp
    assert.equal(h.fake.sent("debugger.sendCommand", "Runtime.evaluate").filter((r) => r.args[0].tabId === B.tab.id).length, reads + 1, "the catch-up read");
    assert.equal(state(h).kept[B.tab.id], undefined, "and kept nothing");
  } finally { await h.close(); }
});

test("round 3: the record's read of a minimized window keeps no geometry (step 6, the front page unknown)", async () => {
  const { h } = await onHarness();
  try {
    const c = await h.connect();
    const A = await page(h, c), B = await page(h, c);
    await mouse(c, B, "mouseMoved", 700, 300);
    const { windowId } = await c.send("Browser.getWindowForTarget", { targetId: A.targetId });
    await c.send("Browser.setWindowBounds", { windowId, bounds: { left: 0 } }); // the front page is unknown
    const op = h.fake.op;
    h.fake.op = (r) => (r.op === "windows.get" && r.args[0] === B.tab.windowId ? { id: r.args[0], left: 0, top: 0, width: 1280, height: 800, state: "minimized", type: "normal", focused: false } : op(r));
    await click(c, B, 700, 300); // the raise of B (windows.update) and the record's read of B's minimized window
    assert.ok(h.fake.sent("debugger.sendCommand", "Runtime.evaluate").some((r) => r.args[0].tabId === B.tab.id), "the record read B");
    assert.equal(state(h).kept[B.tab.id], undefined);
  } finally { await h.close(); }
});

test("round 3: with an old daemon (paths off) a client's Browser.setWindowBounds goes at once, as before (no wait behind an activation)", async () => {
  const h = await harness();
  try {
    await h.ready();
    await until(() => state(h).paths === "off", "off");
    const c = await h.connect();
    const A = await page(h, c), B = await page(h, c);
    const { windowId } = await c.send("Browser.getWindowForTarget", { targetId: B.targetId });
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    h.fake.op = async ({ op, args }) => { if (op === "tabs.get" && args[0] === A.tab.id) await gate; return undefined; };
    const n = h.fake.sent("tabs.get").length;
    const press = mouse(c, A, "mousePressed", 100, 100); // A's activation waits for its tabs.get
    await until(() => h.fake.sent("tabs.get").length > n, "A's activation");
    // The cause, by the order of the fake's calls: the window changes while A's activation still waits, before the
    // activation's limit (its log line) and before A's press.
    let when: { limit: boolean; presses: number } | null = null;
    const op = h.fake.op;
    h.fake.op = async (r) => {
      if (r.op === "windows.update" && r.args[1]?.left === 300) when = { limit: h.logs.some((l) => /took more than/.test(l)), presses: h.fake.sent("debugger.sendCommand", "Input.dispatchMouseEvent").length };
      return op(r);
    };
    await c.send("Browser.setWindowBounds", { windowId, bounds: { left: 300 } });
    assert.deepEqual(when, { limit: false, presses: 0 }, "it went while A's activation waits");
    assert.deepEqual(h.fake.sent("windows.update").map((r) => r.args), [[windowId, { left: 300 }]]);
    open();
    await press;
  } finally { await h.close(); }
});

test("round 4: a viewport call on the page's own session during a read is a drop event: the read keeps nothing", async () => {
  // The tab's gate and the activation chain keep a client's calls away from the relay's reads of that page; the
  // count guards the order anyway, so the test calls the site (the bookkeeping of a call sent to Chrome) while B's read runs.
  const { h } = await onHarness();
  try {
    const { c, A, B } = await twoPages(h);
    const model = h.relay.model as any;
    h.fake.command = async (t, method, params) => {
      if (method === "Runtime.evaluate" && params.contextId !== undefined && t.tabId === B.tab.id) {
        await sleep(60);
        model.tracked(model.tabs.get(B.tab.id), undefined, "Emulation.setScrollbarsHidden", { hidden: true }, Promise.resolve({}));
        await sleep(60);
      }
      return undefined;
    };
    await click(c, A, 100, 100); // A's step reads B, the front page: its answer comes in 120 ms, within its wait
    assert.equal(state(h).kept[B.tab.id], undefined, "a viewport call after the read started: the read keeps nothing");
    assert.ok(state(h).kept[A.tab.id], "A's read is kept");
  } finally { await h.close(); }
});

test("round 4: a client's Browser.setWindowBounds during a read is a drop event of every page: the read keeps nothing", async () => {
  // With the paths on, Browser.setWindowBounds waits behind the step, so no step's read runs during it; with the paths
  // off it goes at once. The test turns the paths off while B's read runs, so that the window change comes during it.
  const { h } = await onHarness();
  try {
    const { c, A, B } = await twoPages(h);
    const model = h.relay.model as any;
    const { windowId } = await c.send("Browser.getWindowForTarget", { targetId: B.targetId });
    let changed = false;
    h.fake.command = async (t, method, params) => {
      if (method === "Runtime.evaluate" && params.contextId !== undefined && t.tabId === B.tab.id) {
        await sleep(40);
        model.paths = "off";
        await c.send("Browser.setWindowBounds", { windowId, bounds: { left: 30 } });
        changed = true;
        await sleep(20);
      }
      return undefined;
    };
    await click(c, A, 100, 100); // A's step reads B; the window change comes while B's read runs
    assert.ok(changed);
    assert.equal(state(h).kept[B.tab.id], undefined, "Browser.setWindowBounds after the read started: the read keeps nothing");
  } finally { await h.close(); }
});

// ------------------------------------------------------------------ round 4 (ab-lead): the drop count, Page's device metrics

test("round 4: a late read after a drop event keeps and drops nothing; a late read drops no kept geometry; the count is per tab", async () => {
  // B's read answers after its wait; a drop event came while it ran: the kept geometry stays dropped (the late usable read keeps nothing).
  {
    const { h } = await onHarness();
    try {
      const { c, A, B } = await twoPages(h);
      await click(c, A, 100, 100);
      assert.ok(state(h).kept[B.tab.id]);
      h.fake.command = async (t, method, params) => {
        if (method === "Runtime.evaluate" && params.contextId !== undefined && t.tabId === B.tab.id) {
          await sleep(60);
          h.fake.emit("debugger.onEvent", { source: { tabId: B.tab.id }, method: "Page.frameResized", params: {} });
          await sleep(300);
        }
        return undefined;
      };
      await mouse(c, B, "mouseMoved", 700, 300);
      await click(c, B, 700, 300);
      await sleep(400);
      assert.equal(state(h).kept[B.tab.id], undefined, "the late read after the drop kept nothing");
    } finally { await h.close(); }
  }
  // B's late read is not usable (a scale of 2): it drops nothing, and B's kept geometry stays.
  {
    const { h } = await onHarness();
    try {
      const { c, A, B } = await twoPages(h);
      await click(c, A, 100, 100);
      const kept = state(h).kept[B.tab.id];
      assert.ok(kept);
      h.fake.geometry = (id) => (id === B.tab.id ? { ...GEO, scale: 2 } : GEO);
      h.fake.command = async (t, method, params) => { if (method === "Runtime.evaluate" && params.contextId !== undefined && t.tabId === B.tab.id) await sleep(350); return undefined; };
      await mouse(c, B, "mouseMoved", 700, 300);
      await click(c, B, 700, 300);
      await sleep(400);
      assert.deepEqual(state(h).kept[B.tab.id], kept, "the late read dropped nothing");
    } finally { await h.close(); }
  }
  // Only the late-answer rule decides: B has no kept geometry, no drop event comes, and B's usable read answers late:
  // it keeps nothing.
  {
    const { h } = await onHarness();
    try {
      const { c, A, B } = await twoPages(h);
      await click(c, A, 100, 100);
      h.fake.emit("debugger.onEvent", { source: { tabId: B.tab.id }, method: "Page.frameResized", params: {} });
      await until(() => state(h).kept[B.tab.id] === undefined, "no kept geometry of B");
      h.fake.command = async (t, method, params) => { if (method === "Runtime.evaluate" && params.contextId !== undefined && t.tabId === B.tab.id) await sleep(350); return undefined; };
      await mouse(c, B, "mouseMoved", 700, 300);
      await click(c, B, 700, 300);
      await sleep(400);
      assert.equal(state(h).kept[B.tab.id], undefined, "the late usable read kept nothing");
    } finally { await h.close(); }
  }
  // The count is per tab: a drop event of A while B's read runs changes nothing of B's read.
  {
    const { h } = await onHarness();
    try {
      const { c, A, B } = await twoPages(h);
      h.fake.command = async (t, method, params) => {
        if (method === "Runtime.evaluate" && params.contextId !== undefined && t.tabId === B.tab.id) {
          await sleep(40);
          h.fake.emit("debugger.onEvent", { source: { tabId: A.tab.id }, method: "Page.frameResized", params: {} });
          await sleep(40);
        }
        return undefined;
      };
      await click(c, A, 100, 100); // A's step reads A and B; A's drop event comes while B's read runs
      assert.ok(state(h).kept[B.tab.id], "B's read is kept: the drop was A's");
    } finally { await h.close(); }
  }
});

test("round 4: Page.setDeviceMetricsOverride and Page.clearDeviceMetricsOverride act as the Emulation calls: an override in force (no path into or out of that page) and a drop of the kept geometry", async () => {
  const { h, d } = await onHarnessLogged();
  try {
    const { c, A, B } = await twoPages(h);
    await click(c, A, 100, 100); // a path from B to A; B's geometry is kept
    assert.ok(state(h).kept[B.tab.id]);
    await c.send("Page.setDeviceMetricsOverride", { width: 600, height: 400, deviceScaleFactor: 1, mobile: false }, B.sessionId);
    assert.equal(state(h).kept[B.tab.id], undefined, "Page.setDeviceMetricsOverride drops the kept geometry");
    const n = d.moves.length;
    await mouse(c, B, "mouseMoved", 700, 300);
    await click(c, B, 700, 300);
    assert.equal(d.moves.length, n, "no path into a page with an override");
    assert.match(stepLines(h, B.tab.id).at(-1) ?? "", /a device-metrics override/);
    await c.send("Page.clearDeviceMetricsOverride", {}, B.sessionId);
    await mouse(c, A, "mouseMoved", 300, 200); // A's point is not where the pointer is
    await click(c, A, 300, 200);
    assert.equal(d.moves.length, n + 1, "after the clear, a path again");
    // A's step read B, the front page, with no override: B's geometry is kept again. A read while an override is in
    // force keeps nothing, so the clear's own drop shows with a clear that follows no set.
    assert.ok(state(h).kept[B.tab.id], "B's geometry is kept again");
    await c.send("Page.clearDeviceMetricsOverride", {}, B.sessionId);
    assert.equal(state(h).kept[B.tab.id], undefined, "Page.clearDeviceMetricsOverride drops the kept geometry too");
  } finally { await h.close(); }
});
