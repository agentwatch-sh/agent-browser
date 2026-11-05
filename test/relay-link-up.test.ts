// Today's relay at a link up and at the removal of a tab (board task ab-v16.40; contract C10 "The daemon and the
// relay" and C11 "When a connection ends" in chrome-extension's docs/protocol.md). Measured by the orphan-tabs design
// (board ab-v16.39, agent-browser PR #48, cases B and F): a relay that starts with no link change found the tab of the
// relay before it still attached, with the old client's Fetch pattern and user-agent override; and an end_scope that
// removed the browser's only tab ended Chromium. Here the fake receiver of fake-bridge.ts stands in for Chrome: each
// test models the domain state of a tab's attachment (a detach clears it) and the browser's end (no tab is left).

import { test } from "node:test";
import assert from "node:assert/strict";
import type { CDPConnection } from "../src/cdp.ts";
import { NOT_READY } from "../src/relay/model.ts";
import { harness, raw, until, type FakeReceiver, type Harness } from "./fake-bridge.ts";

const failure = (p: Promise<unknown>) => p.then(() => "no error", (e: Error) => e.message.replace(/^[A-Za-z]+\.[A-Za-z]+: /, ""));
const ops = (h: Harness, from = 0) => h.fake.requests.slice(from).map((r) => r.op);

/** A page of the connection's own, with auto-attach on: its target id, its session and the fake's tab. */
async function page(h: Harness, c: CDPConnection) {
  await c.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  const attached = c.waitForEvent("Target.attachedToTarget");
  const { targetId } = await c.send("Target.createTarget", { url: "about:blank" });
  const ev = await attached;
  return { targetId, sessionId: ev.sessionId as string, tab: [...h.fake.tabs.values()].find((t) => t.targetId === targetId)! };
}

/** Chrome's domain state of each tab's chrome.debugger attachment: a client's Fetch patterns and user-agent override. A detach ends it. */
type DomainState = Map<number, { fetch?: unknown; userAgent?: string }>;
function modelDomainState(fake: FakeReceiver, state: DomainState, detach: (tabId: number) => Promise<unknown> = async () => undefined): void {
  fake.command = (target, method, params) => {
    const s = state.get(target.tabId) ?? {};
    if (method === "Fetch.enable") state.set(target.tabId, { ...s, fetch: params.patterns });
    if (method === "Emulation.setUserAgentOverride") state.set(target.tabId, { ...s, userAgent: params.userAgent });
    return undefined;
  };
  fake.op = async ({ op, args }) => {
    if (op !== "debugger.detach") return undefined;
    const answer = await detach(args[0]);
    if (answer === undefined && fake.attached.has(args[0])) state.delete(args[0]);
    return answer;
  };
}

/** The browser ends when a tabs.remove takes its last tab: this records each removal that would have ended it. */
function watchLastTab(fake: FakeReceiver): number[] {
  const ended: number[] = [];
  const before = fake.op;
  fake.op = async (req) => {
    if (req.op === "tabs.remove" && fake.tabs.has(req.args[0]) && fake.tabs.size === 1) ended.push(req.args[0]);
    return before(req);
  };
  return ended;
}

test("a relay that starts with no link change detaches the tab that the relay before it left attached: no Fetch pattern and no user-agent override of the old client stay", async () => {
  const state: DomainState = new Map();
  const first = await harness();
  let second: Harness | undefined;
  try {
    modelDomainState(first.fake, state);
    await first.ready();
    const c = await first.connect("s3");
    const { tab, sessionId } = await page(first, c);
    await c.send("Fetch.enable", { patterns: [{ urlPattern: "*b-fetch*" }] }, sessionId);
    await c.send("Emulation.setUserAgentOverride", { userAgent: "probe-old-client" }, sessionId);
    assert.deepEqual(state.get(tab.id), { fetch: [{ urlPattern: "*b-fetch*" }], userAgent: "probe-old-client" });

    // The old relay ends (its standard input ends); the receiver sees no link change, so its own cleanup does not run.
    first.fake.input.end();
    await first.relay.closed;
    await c.closedPromise;
    assert.ok(first.fake.attached.has(tab.id) && state.has(tab.id), "the old relay leaves the tab attached, with its client's state (case B)");

    // The daemon starts a new relay on the same Chrome and writes the link-up line and the list again.
    second = await harness();
    for (const [id, t] of first.fake.tabs) second.fake.tabs.set(id, t);
    for (const id of first.fake.attached) second.fake.attached.add(id);
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    modelDomainState(second.fake, state, () => gate.then(() => undefined));
    second.fake.line({ t: "link", up: true, version: "0.2.0" });
    second.fake.line({ t: "allowlist", domains: ["a.example"] });
    await until(() => second!.fake.sent("debugger.detach").length, "the detach at the link up");
    // Before the detach answers, the relay admits no connection.
    assert.equal(second.relay.model.notReady(), NOT_READY.link);
    assert.deepEqual(await raw(second.url("s3")).then((r) => [r.status, r.body]), [503, NOT_READY.link]);
    open();
    await until(() => second!.relay.model.notReady() === null, "the new relay to be ready");

    const seen = ops(second).filter((op) => ["bridge.info", "debugger.getTargets", "debugger.detach"].includes(op));
    assert.deepEqual(seen, ["bridge.info", "debugger.getTargets", "debugger.detach"]);
    assert.deepEqual(second.fake.sent("debugger.detach").map((r) => r.args), [[tab.id]]);
    assert.ok(!second.fake.attached.has(tab.id), "the tab is not attached");
    assert.equal(state.has(tab.id), false, "no Fetch pattern and no user-agent override of the old client stay");
    assert.ok(second.fake.tabs.has(tab.id), "the tab stays open");
  } finally {
    await first.close();
    await second?.close();
  }
});

test("at each link up the relay detaches every tab that Chrome reports attached, ignores the errors, and then admits connections", async () => {
  const h = await harness();
  try {
    const restore = h.fake.newTab("https://a.example/restore"), left = h.fake.newTab("https://a.example/left"), free = h.fake.newTab("about:blank");
    h.fake.attached.add(restore.id); h.fake.attached.add(left.id);
    // The restore tab of a running import: the receiver refuses its detach.
    h.fake.op = ({ op, args }) => (op === "debugger.detach" && args[0] === restore.id ? { error: "not an agent tab" } : undefined);
    await h.ready();
    assert.deepEqual(h.fake.sent("debugger.detach").map((r) => r.args[0]).sort(), [restore.id, left.id].sort(), "every attached tab, and no other");
    assert.ok(!h.fake.attached.has(left.id) && !h.fake.attached.has(free.id));
    assert.ok(await h.connect("s1"), "the relay admits a connection after a refused detach");

    // A link change: the relay detaches again at the next link up (the receiver has already detached its bridge tabs).
    h.fake.line({ t: "link", up: false });
    h.fake.attached.add(left.id);
    const from = h.fake.requests.length;
    await h.ready();
    assert.deepEqual(h.fake.requests.slice(from).filter((r) => r.op === "debugger.detach").map((r) => r.args[0]).sort(), [restore.id, left.id].sort());

    // A failed debugger.getTargets is logged, and the relay still gets ready.
    h.fake.line({ t: "link", up: false });
    h.fake.op = ({ op }) => (op === "debugger.getTargets" ? { error: "timeout" } : undefined);
    const detaches = h.fake.sent("debugger.detach").length;
    await h.ready();
    assert.equal(h.fake.sent("debugger.detach").length, detaches);
    assert.ok(h.logs.some((l) => /debugger\.getTargets .*failed: timeout/.test(l)), h.logs.join("\n"));

    // A receiver that is too old for agent mode gets no debugger.getTargets.
    h.fake.line({ t: "link", up: false });
    h.fake.op = ({ op }) => (op === "bridge.info" ? { error: "unknown op" } : undefined);
    const asked = h.fake.sent("debugger.getTargets").length;
    h.fake.line({ t: "link", up: true, version: "0.1.0" });
    h.fake.line({ t: "allowlist", domains: ["a.example"] });
    await until(() => h.relay.model.notReady() === NOT_READY.old, "the too-old answer");
    assert.equal(h.fake.sent("debugger.getTargets").length, asked);
  } finally { await h.close(); }
});

test("end_scope never closes the browser's last window: before it removes the only tab it opens an about:blank window", async () => {
  const h = await harness();
  try {
    const ended = watchLastTab(h.fake);
    await h.ready();
    const c = await h.connect("s4");
    const { tab } = await page(h, c);
    assert.deepEqual([...h.fake.tabs.keys()], [tab.id], "the scope's tab is the browser's only tab");
    const from = h.fake.requests.length;
    h.fake.line({ t: "end_scope", scope: "s4" });
    await c.closedPromise;
    await until(() => !h.fake.tabs.has(tab.id), "the removal of the scope's tab");
    const steps = h.fake.requests.slice(from).filter((r) => ["tabs.query", "windows.create", "tabs.remove"].includes(r.op)).map((r) => [r.op, r.args]);
    assert.deepEqual(steps, [["tabs.query", [{}]], ["windows.create", [{ url: "about:blank", focused: false }]], ["tabs.remove", [tab.id]]]);
    assert.deepEqual(ended, [], "no removal took the browser's last tab");
    assert.deepEqual([...h.fake.tabs.values()].map((t) => t.url), ["about:blank"]);

    // The tab of that window is in no scope.
    const other = await h.connect("s4");
    assert.deepEqual((await other.send("Target.getTargets")).targetInfos, []);

    // With another tab in the browser, end_scope removes the scope's tab and opens no window.
    const d = await h.connect("s5");
    const second = await page(h, d);
    const windows = h.fake.sent("windows.create").length;
    h.fake.line({ t: "end_scope", scope: "s5" });
    await until(() => !h.fake.tabs.has(second.tab.id), "the removal of the second scope's tab");
    assert.equal(h.fake.sent("windows.create").length, windows);
  } finally { await h.close(); }
});

test("two removals at once never both take the browser's last tabs: the relay runs one query and removal at a time", async () => {
  const h = await harness();
  try {
    const ended = watchLastTab(h.fake);
    await h.ready();
    const a = await h.connect("s6"), b = await h.connect("s7");
    const pa = await page(h, a), pb = await page(h, b);
    assert.equal(h.fake.tabs.size, 2);
    const from = h.fake.requests.length;
    h.fake.line({ t: "end_scope", scope: "s6" });
    h.fake.line({ t: "end_scope", scope: "s7" });
    await until(() => !h.fake.tabs.has(pa.tab.id) && !h.fake.tabs.has(pb.tab.id), "both removals");
    assert.deepEqual(ended, []);
    assert.deepEqual(ops(h, from).filter((op) => ["tabs.query", "windows.create", "tabs.remove"].includes(op)), ["tabs.query", "tabs.remove", "tabs.query", "windows.create", "tabs.remove"]);
    assert.deepEqual([...h.fake.tabs.values()].map((t) => t.url), ["about:blank"]);
  } finally { await h.close(); }
});

test("Target.closeTarget of the browser's only tab opens an about:blank window first; a failed query or window keeps the tab", async () => {
  for (const windowPerPage of [true, false]) {
    const h = await harness({ windowPerPage });
    try {
      const ended = watchLastTab(h.fake);
      await h.ready();
      const c = await h.connect("s8");
      const first = await page(h, c);
      let from = h.fake.requests.length;
      assert.deepEqual(await c.send("Target.closeTarget", { targetId: first.targetId }), { success: true });
      assert.deepEqual(ops(h, from).filter((op) => ["tabs.query", "windows.create", "tabs.remove"].includes(op)), ["tabs.query", "windows.create", "tabs.remove"]);
      assert.deepEqual(h.fake.sent("windows.create").at(-1)!.args, [{ url: "about:blank", focused: false }]);
      assert.deepEqual(ended, [], `windowPerPage ${windowPerPage}`);
      assert.deepEqual([...h.fake.tabs.values()].map((t) => t.url), ["about:blank"]);
      assert.deepEqual((await c.send("Target.getTargets")).targetInfos, [], "the about:blank window is in no scope");

      // The operator closes the about:blank window; the scope's next page is the browser's only tab again.
      const second = await page(h, c);
      for (const id of [...h.fake.tabs.keys()]) if (id !== second.tab.id) { h.fake.tabs.delete(id); h.fake.emit("tabs.onRemoved", { tabId: id, removeInfo: { windowId: 1, isWindowClosing: true } }); }
      const watched = h.fake.op;
      // The query fails: the client gets the error, and no tabs.remove goes.
      h.fake.op = (req) => (req.op === "tabs.query" ? { error: "timeout" } : watched(req));
      from = h.fake.requests.length;
      assert.equal(await failure(c.send("Target.closeTarget", { targetId: second.targetId })), "The agent browser did not answer Target.closeTarget in 30 s.");
      assert.deepEqual(ops(h, from), ["tabs.query"]);
      // The window fails: end_scope keeps the tab, and the relay logs it.
      h.fake.op = (req) => (req.op === "windows.create" ? { error: "No current window" } : watched(req));
      from = h.fake.requests.length;
      h.fake.line({ t: "end_scope", scope: "s8" });
      await until(() => h.logs.some((l) => l.includes(`kept tab ${second.tab.id}`)), "the log of the kept tab");
      assert.deepEqual(ops(h, from).filter((op) => ["tabs.query", "windows.create", "tabs.remove"].includes(op)), ["tabs.query", "windows.create"]);
      assert.ok(h.fake.tabs.has(second.tab.id), "the tab stays open");
      assert.deepEqual(ended, []);
    } finally { await h.close(); }
  }
});

/**
 * Chrome's Page.close (Playwright's page.close({ runBeforeUnload: true }) sends it on the page session): it answers
 * at once, and the tab closes `ms` later (tabs.onRemoved), or never (`ms` null: a beforeunload handler keeps it). A
 * close that takes the browser's last tab is recorded in `ended`.
 */
function modelPageClose(fake: FakeReceiver, ended: number[], ms: number | null): void {
  fake.command = (target, method) => {
    if (method !== "Page.close" || target.sessionId) return undefined;
    if (ms !== null) setTimeout(() => {
      if (!fake.tabs.has(target.tabId)) return;
      if (fake.tabs.size === 1) ended.push(target.tabId);
      fake.tabs.delete(target.tabId); fake.attached.delete(target.tabId);
      fake.emit("tabs.onRemoved", { tabId: target.tabId, removeInfo: { windowId: 1, isWindowClosing: true } });
    }, ms);
    return {};
  };
}
const GUARD_OPS = new Set(["tabs.query", "windows.create", "tabs.remove", "Page.close"]);
/** The guard's ops from request `from` on, with a page call by its CDP method. */
const guardOps = (h: Harness, from: number) => h.fake.requests.slice(from).map((r) => (r.op === "debugger.sendCommand" ? r.args[1] : r.op)).filter((op) => GUARD_OPS.has(op));

test("a client's Page.close of the browser's only tab opens an about:blank window first; a failed query sends no Page.close", async () => {
  const h = await harness();
  try {
    const ended: number[] = [];
    modelPageClose(h.fake, ended, 30);
    await h.ready();
    const c = await h.connect("s10");
    const p = await page(h, c);
    let from = h.fake.requests.length;
    assert.deepEqual(await c.send("Page.close", {}, p.sessionId), {});
    await until(() => !h.fake.tabs.has(p.tab.id), "the close of the tab");
    assert.deepEqual(guardOps(h, from), ["tabs.query", "windows.create", "Page.close"]);
    assert.deepEqual(h.fake.sent("windows.create").at(-1)!.args, [{ url: "about:blank", focused: false }]);
    assert.deepEqual(ended, [], "the close did not take the browser's last tab");
    assert.deepEqual([...h.fake.tabs.values()].map((t) => t.url), ["about:blank"]);

    // The query fails: the client gets the error, and no Page.close reaches Chrome.
    const q = await page(h, c);
    for (const id of [...h.fake.tabs.keys()]) if (id !== q.tab.id) { h.fake.tabs.delete(id); h.fake.emit("tabs.onRemoved", { tabId: id, removeInfo: { windowId: 1, isWindowClosing: true } }); }
    h.fake.op = ({ op }) => (op === "tabs.query" ? { error: "timeout" } : undefined);
    from = h.fake.requests.length;
    assert.equal(await failure(c.send("Page.close", {}, q.sessionId)), "The agent browser did not answer Page.close in 30 s.");
    assert.deepEqual(guardOps(h, from), ["tabs.query"]);
    assert.ok(h.fake.tabs.has(q.tab.id));
  } finally { await h.close(); }
});

test("Page.close answers before its tab closes, so the next removal waits for the tab's tabs.onRemoved: Page.close and end_scope at once keep a window", async () => {
  const h = await harness();
  try {
    const ended = watchLastTab(h.fake);
    modelPageClose(h.fake, ended, 150);
    await h.ready();
    const a = await h.connect("s11"), b = await h.connect("s12");
    const pa = await page(h, a), pb = await page(h, b);
    assert.equal(h.fake.tabs.size, 2, "the two pages are the browser's only tabs");
    const from = h.fake.requests.length;
    const closed = a.send("Page.close", {}, pa.sessionId);
    assert.deepEqual(await closed, {});
    // The end_scope comes after Page.close answered, while the page's tab is still open.
    assert.ok(h.fake.tabs.has(pa.tab.id));
    h.fake.line({ t: "end_scope", scope: "s12" });
    await until(() => !h.fake.tabs.has(pa.tab.id) && !h.fake.tabs.has(pb.tab.id), "both tabs closed");
    // Page.close sees two tabs; the end_scope's query comes after the page's tab closed, so it opens the window.
    assert.deepEqual(guardOps(h, from), ["tabs.query", "Page.close", "tabs.query", "windows.create", "tabs.remove"]);
    assert.deepEqual(ended, []);
    assert.deepEqual([...h.fake.tabs.values()].map((t) => t.url), ["about:blank"]);
  } finally { await h.close(); }
});

test("a Page.close whose tab stays open (beforeunload) holds the removals at most a short time; a refused Page.close holds none", async () => {
  const h = await harness();
  try {
    const ended = watchLastTab(h.fake);
    modelPageClose(h.fake, ended, null);
    await h.ready();
    const a = await h.connect("s13"), b = await h.connect("s14");
    const pa = await page(h, a), pb = await page(h, b);
    const t0 = Date.now();
    assert.deepEqual(await a.send("Page.close", {}, pa.sessionId), {});
    h.fake.line({ t: "end_scope", scope: "s14" });
    await until(() => !h.fake.tabs.has(pb.tab.id), "the end_scope's removal after the limit", 6000);
    const waited = Date.now() - t0;
    assert.ok(waited >= 1500 && waited < 5000, `the removal waited ${waited} ms`);
    assert.ok(h.fake.tabs.has(pa.tab.id), "the page's tab stays open");
    assert.deepEqual(ended, []);

    // Chrome refuses Page.close: the client gets its error at once, and the next removal does not wait.
    h.fake.command = (_target, method) => (method === "Page.close" ? { error: JSON.stringify({ code: -32000, message: "refused" }) } : undefined);
    const c = await h.connect("s15");
    const pc = await page(h, c);
    assert.equal(await failure(a.send("Page.close", {}, pa.sessionId)), "refused");
    const t1 = Date.now();
    h.fake.line({ t: "end_scope", scope: "s15" });
    await until(() => !h.fake.tabs.has(pc.tab.id), "the removal after a refused Page.close", 1000);
    assert.ok(Date.now() - t1 < 1000);
  } finally { await h.close(); }
});
