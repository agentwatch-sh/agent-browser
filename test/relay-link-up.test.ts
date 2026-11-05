// The relay at a link up and at the removal of a tab (board tasks ab-v16.40 and ab-v16.35; contract C10 "The daemon
// and the relay" and "Removals and the last window", C11 "When a connection ends", in chrome-extension's
// docs/protocol.md). Measured by the orphan-tabs design (board ab-v16.39, agent-browser PR #48, cases B and F): a relay
// that starts with no link change found the tab of the relay before it still attached, with the old client's Fetch
// pattern and user-agent override; and an end_scope that removed the browser's only tab ended Chromium. In the
// per-scope build the receiver keeps the browser's last window for every close (its removal queue and window rule),
// so the relay sends end_scope's tabs.remove, Target.closeTarget and a client's Page.close as they are (board
// ab-v16.41). Here the fake receiver of fake-bridge.ts stands in for Chrome: each test models the domain state of a
// tab's attachment (a detach clears it).

import { test } from "node:test";
import assert from "node:assert/strict";
import type { CDPConnection } from "../src/cdp.ts";
import { NOT_READY } from "../src/relay/model.ts";
import { harness, LINE, raw, until, type FakeReceiver, type Harness } from "./fake-bridge.ts";

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
    for (const [id, scope] of first.fake.scopes) second.fake.scopes.set(id, scope);
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    modelDomainState(second.fake, state, () => gate.then(() => undefined));
    second.fake.line({ t: "link", up: true, version: "0.3.1" });
    second.fake.line(LINE);
    await until(() => second!.fake.sent("debugger.detach").length, "the detach at the link up");
    // Before the detach answers, the relay admits no connection.
    assert.equal(second.relay.model.notReady(), NOT_READY.link);
    assert.deepEqual(await raw(second.url("s3")).then((r) => [r.status, r.body]), [503, NOT_READY.link]);
    open();
    await until(() => second!.relay.model.notReady() === null, "the new relay to be ready");

    const seen = ops(second).filter((op) => ["bridge.info", "bridge.tabScopes", "debugger.getTargets", "debugger.detach"].includes(op));
    assert.deepEqual(seen, ["bridge.info", "bridge.tabScopes", "debugger.getTargets", "debugger.detach"]);
    assert.deepEqual(second.fake.sent("debugger.detach").map((r) => r.args), [[tab.id]]);
    assert.ok(!second.fake.attached.has(tab.id), "the tab is not attached");
    assert.equal(state.has(tab.id), false, "no Fetch pattern and no user-agent override of the old client stay");
    assert.ok(second.fake.tabs.has(tab.id), "the tab stays open");
    // The receiver's map kept the tab's scope (bridge.tabScopes): a client of the scope that connects again sees it, free.
    const again = await second.connect("s3");
    assert.deepEqual((await again.send("Target.getTargets")).targetInfos.map((t: any) => [t.targetId, t.attached]), [[tab.targetId, false]]);
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
    h.fake.line(LINE);
    await until(() => h.relay.model.notReady() === NOT_READY.old, "the too-old answer");
    assert.equal(h.fake.sent("debugger.getTargets").length, asked);
  } finally { await h.close(); }
});


test("end_scope closes the scope's connections and sends tabs.remove for each of its tabs at once, with no query, window or queue of its own", async () => {
  const h = await harness();
  try {
    await h.ready();
    const c = await h.connect("s4"), d = await h.connect("s4"), other = await h.connect("s5");
    const p1 = await page(h, c), p2 = await page(h, d), kept = await page(h, other);
    // The receiver answers the removals in its own queue: here the first one waits until both were sent.
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    h.fake.op = async ({ op, args }) => { if (op === "tabs.remove" && args[0] === p1.tab.id) await gate; return undefined; };
    const from = h.fake.requests.length;
    h.fake.line({ t: "end_scope", scope: "s4" });
    assert.deepEqual(await Promise.all([c.closedPromise, d.closedPromise]).then(() => "closed"), "closed");
    await until(() => h.fake.sent("tabs.remove").length === 2, "both removals sent before the first one answered");
    open();
    await until(() => !h.fake.tabs.has(p1.tab.id) && !h.fake.tabs.has(p2.tab.id), "the removal of the scope's tabs");
    assert.deepEqual(h.fake.sent("tabs.remove").map((r) => r.args).sort(), [[p1.tab.id], [p2.tab.id]].sort());
    assert.deepEqual(ops(h, from).filter((op) => ["tabs.query", "windows.create", "tabs.create"].includes(op)), [], "no last-window guard of the relay's own");
    assert.ok(h.fake.tabs.has(kept.tab.id), "another scope's tab stays");
    assert.deepEqual((await other.send("Target.getTargets")).targetInfos.map((t: any) => t.targetId), [kept.targetId]);
  } finally { await h.close(); }
});

test("a late end_scope: a tabs.remove that gets 'not an agent tab' is done for the relay, with no error in its log; another error is logged and the tab stays", async () => {
  const h = await harness();
  try {
    await h.ready();
    const c = await h.connect("s6");
    const orphan = await page(h, c), other = await page(h, c);
    // The receiver's sweep took the first tab out of its scope into its orphan set (C5); the second one is already gone.
    h.fake.op = ({ op, args }) => (op === "tabs.remove" && args[0] === orphan.tab.id ? { error: "not an agent tab" }
      : op === "tabs.remove" && args[0] === other.tab.id ? { error: `No tab with id: ${other.tab.id}.` } : undefined);
    h.fake.line({ t: "end_scope", scope: "s6" });
    await c.closedPromise;
    await until(() => h.logs.some((l) => l.includes(`kept tab ${other.tab.id}`)), "the log of the other error");
    assert.ok(!h.logs.some((l) => l.includes(String(orphan.tab.id)) && /kept|fail|error/i.test(l)), h.logs.join("\n"));
    assert.ok(h.fake.tabs.has(orphan.tab.id), "the tab stays open until the receiver's next sweep item closes it");
    // The relay dropped the orphan's tab from its model: a later connection of the scope never sees it.
    const later = await h.connect("s6");
    assert.deepEqual((await later.send("Target.getTargets")).targetInfos.map((t: any) => t.targetId), [other.targetId]);
  } finally { await h.close(); }
});

test("Target.closeTarget is the receiver's close (tabs.remove), with no query or window of the relay's own; the client gets the receiver's answer", async () => {
  for (const windowPerPage of [true, false]) {
    const h = await harness({ windowPerPage });
    try {
      await h.ready();
      const c = await h.connect("s8");
      const first = await page(h, c);
      let from = h.fake.requests.length;
      assert.deepEqual(await c.send("Target.closeTarget", { targetId: first.targetId }), { success: true });
      assert.deepEqual(ops(h, from), ["tabs.remove"], `windowPerPage ${windowPerPage}`);
      assert.deepEqual(h.fake.sent("tabs.remove").at(-1)!.args, [first.tab.id]);
      // The receiver's window rule failed (its query has not answered in REMOVAL_WAIT_MS): the client gets that error.
      const second = await page(h, c);
      h.fake.op = ({ op }) => (op === "tabs.remove" ? { error: "timeout" } : undefined);
      from = h.fake.requests.length;
      assert.equal(await failure(c.send("Target.closeTarget", { targetId: second.targetId })), "The agent browser did not answer Target.closeTarget in 30 s.");
      h.fake.op = ({ op }) => (op === "tabs.remove" ? { error: "not an agent tab" } : undefined);
      assert.equal(await failure(c.send("Target.closeTarget", { targetId: second.targetId })), "not an agent tab");
      assert.deepEqual(ops(h, from), ["tabs.remove", "tabs.remove"]);
    } finally { await h.close(); }
  }
});

test("a client's Page.close goes to Chrome as a plain debugger.sendCommand, in the tab's order; on a child session too; Chrome's error reaches the client", async () => {
  const h = await harness();
  try {
    await h.ready();
    const c = await h.connect("s10");
    const p = await page(h, c);
    let answer!: () => void;
    const held = new Promise<void>((r) => { answer = r; });
    // Chrome answers Page.close before the tab closes; a beforeunload handler can hold the close (the receiver's queue).
    h.fake.command = async (_t, method) => { if (method === "Page.close") { await held; return {}; } return undefined; };
    const from = h.fake.requests.length;
    const closing = c.send("Page.close", {}, p.sessionId);
    const next = c.send("Runtime.evaluate", { expression: "1" }, p.sessionId);
    await until(() => h.fake.sent("debugger.sendCommand", "Runtime.evaluate").length, "the next command");
    const sent = h.fake.requests.slice(from).map((r) => (r.op === "debugger.sendCommand" ? r.args[1] : r.op));
    assert.deepEqual(sent, ["Page.close", "Runtime.evaluate"], "both go at once, in the client's order; the receiver's gate keeps the tab's order");
    assert.deepEqual(h.fake.sent("debugger.sendCommand", "Page.close")[0].args, [{ tabId: p.tab.id }, "Page.close", {}]);
    await next;
    answer();
    assert.deepEqual(await closing, {});
    // A frame's session (an out-of-process frame): Page.close goes to Chrome there, as any call (Chrome refuses it).
    h.fake.emit("debugger.onEvent", { source: { tabId: p.tab.id }, method: "Target.attachedToTarget", params: { sessionId: "FR1", waitingForDebugger: false,
      targetInfo: { targetId: "FR1T", type: "iframe", title: "", url: "https://a.example/f", attached: true, canAccessOpener: false, browserContextId: "C1" } } });
    await new Promise((r) => setTimeout(r, 20));
    h.fake.command = (target, method) => (method === "Page.close" && target.sessionId ? { error: JSON.stringify({ code: -32000, message: "Command can only be executed on top-level targets" }) } : undefined);
    assert.equal(await failure(c.send("Page.close", {}, "FR1")), "Command can only be executed on top-level targets");
    assert.deepEqual(h.fake.sent("debugger.sendCommand", "Page.close").at(-1)!.args[0], { tabId: p.tab.id, sessionId: "FR1" });
    assert.deepEqual(ops(h, from).filter((op) => ["tabs.query", "windows.create", "tabs.remove"].includes(op)), [], "no last-window guard of the relay's own");
  } finally { await h.close(); }
});
