// The relay serves one allowlist per scope (part 2 of the per-scope build, board ab-v16.35): the allowlist line by
// C4's rules, readiness and the no-list 503 per scope, the 1008 close of a scope that lost its list and the drop of
// its tabs, the scope arg of tabs.create and windows.create, a tab's scope from bridge.tabScope only (with the 500 ms
// wait), the order of bridge.tabScope and tabs.onReplaced, the receiver's map at each link up (bridge.tabScopes), the
// refusal of off-list navigations (layer 1), and grants and content settings per scope. Contracts C4, C10 and C11 of
// chrome-extension's docs/protocol.md (main c99bebb); the vectors are copies of its test/vectors/ at that commit. The
// fake receiver of fake-bridge.ts stands in for the receiver of chrome-extension 0.3.x.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { CDPConnection } from "../src/cdp.ts";
import { CLOSE, NOT_READY, TAB_SCOPE_WAIT_MS } from "../src/relay/model.ts";
import { offList } from "../src/relay/policy.ts";
import { covers, normalizeEntry, parseScopes } from "../src/relay/scopes.ts";
import { harness, raw, until, type Harness } from "./fake-bridge.ts";

const vectors = (name: string) => JSON.parse(readFileSync(new URL(`./vectors/chrome-extension-c99bebb/${name}.json`, import.meta.url), "utf8"));
const scopesV = vectors("scopes"), endpointV = vectors("endpoint"), bridgeV = vectors("bridge");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const failure = (p: Promise<unknown>) => p.then(() => "no error", (e: Error) => e.message.replace(/^[A-Za-z]+\.[A-Za-z]+: /, ""));
const answer = (id: string) => endpointV.upgradeAnswers.find((a: any) => a.id === id);
const closeOf = (id: string) => { const c = endpointV.closes.find((x: any) => x.id === id); return [c.code, c.reason]; };
/** The peer check (and a relay without it that gets roots) is board ab-v16.51. */
const PEER_CHECK = "the peer check and the roots of the line: board ab-v16.51";

/** Two scopes with two lists, as the per-scope design's example. */
const TWO = { t: "allowlist", lists: { a: ["a.example"], b: ["b.example"] }, scopes: { sa: "a", sb: "b" }, default: null };

/** A page of the connection's own, with auto-attach on: its target id, its session and the fake's tab. */
async function page(h: Harness, c: CDPConnection, params: object = { url: "about:blank" }) {
  await c.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  const attached = c.waitForEvent("Target.attachedToTarget");
  const { targetId } = await c.send("Target.createTarget", params);
  const ev = await attached;
  return { targetId, sessionId: ev.sessionId as string, tab: [...h.fake.tabs.values()].find((t) => t.targetId === targetId)! };
}

// ------------------------------------------------------------------ the allowlist line (C4's rules; scopes.json)

test("each set_scopes vector applies to the allowlist line by C4's rules: what applies, the count in refused, each scope's list", () => {
  for (const v of [...scopesV.cases, ...scopesV.raw.map((r: any) => ({ ...r, in: JSON.parse(r.json) }))]) {
    const s = parseScopes(v.in);
    assert.deepEqual(Object.fromEntries(s.lists), v.applies.lists, `${v.note}: lists`);
    assert.deepEqual(Object.fromEntries(s.scopes), v.applies.scopes, `${v.note}: scopes`);
    assert.equal(s.default, v.applies.default, `${v.note}: default`);
    assert.equal(s.refused, v.refused, `${v.note}: refused`);
    for (const [scope, list] of Object.entries(v.listOf ?? {})) assert.equal(s.listOf(scope), list, `${v.note}: the list of ${scope}`);
  }
  // Only a line whose scopes and lists are objects drops the tabs of a scope with no list (C11; the sweep's vectors).
  for (const v of scopesV.sweep) assert.equal(parseScopes(v.in).applied, v.applied, v.note);
  assert.equal(parseScopes(null).refused, 3, "a line with none of the fields");
  assert.equal(parseScopes({ t: "allowlist", domains: ["a.example"] }).listOf("ab-lead"), null, "an old daemon's line gives no scope a list");
  // The daemon's line of the bridge vectors (C10).
  const line = bridgeV.daemonLines.find((l: any) => l.t === "allowlist" && !("roots" in l));
  assert.deepEqual([parseScopes(line).listOf("ab-lead"), parseScopes(line).listOf("md-other"), parseScopes(line).refused], ["md", null, 0]);
});

test("the allowlist line vectors without the peer check: a line without roots applies as set_scopes does; the operator field changes nothing", (t) => {
  for (const v of scopesV.lines.filter((x: any) => !x.peerCheck)) {
    if (v.failClosed) { t.todo(`${v.note} (${PEER_CHECK})`); continue; }
    const s = parseScopes(v.line);
    assert.deepEqual(Object.fromEntries(s.lists), { md: ["a.example"] }, v.note);
    assert.equal(s.listOf("md-lead"), "md", v.note);
  }
});

test("C5's entries: only a normalized entry applies; an entry covers itself and its subdomains, not a longer name", () => {
  for (const e of ["a.example", "sub.a.example", "xn--bcher-kva.example", "a.localhost"]) assert.equal(normalizeEntry(e), e, e);
  for (const e of ["A.example", "https://a.example/", "*.a.example", "localhost", "10.0.0.1", "a..example", "-a.example", "a.example:80", "[::1]", " a.example"])
    assert.notEqual(normalizeEntry(e), e, e);
  assert.ok(covers(["a.example"], "a.example") && covers(["a.example"], "www.a.example"));
  assert.ok(!covers(["a.example"], "xa.example") && !covers(["a.example"], "a.example.b") && !covers([], "a.example"));
});

// ------------------------------------------------------------------ readiness per scope (C11, the order of the checks)

/** A relay in the state of an upgradeChecks vector: the link, bridge.info and the last allowlist line. */
async function inState(h: Harness, relay: { link: boolean; bridge: number | null; line: string | null }): Promise<void> {
  if (relay.bridge === null) h.fake.op = ({ op }) => (op === "bridge.info" ? new Promise(() => {}) : undefined);
  if (relay.bridge === 0) h.fake.info = { ...(h.fake.info as object), bridge: 0 };
  if (!relay.link) return;
  h.fake.line({ t: "link", up: true, version: "0.3.1" });
  if (relay.line) h.fake.line(endpointV.lines[relay.line]);
  if (relay.bridge === null) await until(() => h.fake.sent("bridge.info").length, "bridge.info");
  else if (relay.bridge === 0) await until(() => h.relay.model.notReady() === NOT_READY.old, "the too-old answer");
  else await until(() => h.fake.sent("debugger.getTargets").length && (relay.line ? h.relay.model.notReady() === null : true), "the steps of the link up");
  await sleep(10);
}

test("the order of the checks before the upgrade, without the peer check (upgradeChecks): the 503s, then the no-list 503 of the scope", async (t) => {
  for (const v of endpointV.upgradeChecks.filter((x: any) => !x.peerCheck)) {
    if (v.answer === "rootsWithout") { t.todo(`${v.note} (${PEER_CHECK})`); continue; }
    const h = await harness();
    try {
      await inState(h, v.relay);
      const got = await raw(`ws+unix://${h.socket}:${v.request.path}`, v.request.headers);
      got.ws?.close();
      if (typeof v.answer === "object") assert.equal(got.ws ? 101 : got.status, v.answer.status, `${v.note}: ${got.body}`);
      else assert.deepEqual([got.status, got.body], [answer(v.answer).status, answer(v.answer).body], v.note);
    } finally { await h.close(); }
  }
});

test("a scope with no list gets the no-list 503 at once, until a line gives it a list; a scope whose list is empty is admitted", async () => {
  const h = await harness();
  try {
    await h.ready({ ...TWO, lists: { ...TWO.lists, empty: [] }, scopes: { ...TWO.scopes, se: "empty" } });
    for (const scope of ["s-new", "sc"]) assert.deepEqual(await raw(h.url(scope)).then((r) => [r.status, r.body]), [503, NOT_READY.noList], scope);
    assert.equal(NOT_READY.noList, answer("noList").body);
    const e = await raw(h.url("se"));
    assert.ok(e.ws, "the empty list is a list");
    e.ws!.close();
    // A just-launched session connects again once the daemon's line names its scope.
    h.fake.line({ ...TWO, scopes: { ...TWO.scopes, "s-new": "a" } });
    await until(() => h.relay.model.refuse("s-new") === null, "the new scope's list");
    assert.ok(await h.connect("s-new"));
  } finally { await h.close(); }
});

// ------------------------------------------------------------------ a scope that loses its list (C11, when a connection ends)

test("the 1008 close of each connection whose scope has no list any more (lineCloses, without the peer check)", async (t) => {
  for (const v of endpointV.lineCloses.filter((x: any) => !x.peerCheck)) {
    if (v.line === "plainWithRoots") { t.todo(`${v.note} (${PEER_CHECK})`); continue; }
    const h = await harness();
    try {
      await h.ready(endpointV.lines.plainDefault); // the default list admits every scope of the vectors
      const conn = await raw(h.url(v.connection.scope));
      assert.ok(conn.ws, v.note);
      h.fake.line(endpointV.lines[v.line]);
      const closed = await Promise.race([conn.closed, sleep(150).then(() => null)]);
      if (v.close === null) { assert.equal(closed, null, v.note); conn.ws!.close(); }
      else assert.deepEqual(closed, closeOf(v.close), v.note);
    } finally { await h.close(); }
  }
  assert.deepEqual(CLOSE.noList, closeOf("noList"));
});

test("at a line whose scopes and lists are objects, the model drops each tab of a scope with no list: a later session of the same name never sees one", async () => {
  const h = await harness();
  try {
    await h.ready(TWO);
    const a = await h.connect("sa"), b = await h.connect("sb");
    const pa = await page(h, a), pb = await page(h, b);
    const closed = await raw(h.url("sb"));
    // The session of scope sb ends: the daemon's next set_scopes leaves it out.
    const from = h.fake.requests.length;
    h.fake.line({ ...TWO, scopes: { sa: "a" } });
    assert.deepEqual(await closed.closed, closeOf("noList"));
    await b.closedPromise;
    await until(() => h.fake.requests.slice(from).some((r) => r.op === "debugger.detach" && r.args[0] === pb.tab.id), "the detach of the dropped tab");
    assert.ok(!h.fake.attached.has(pb.tab.id), "no domain state of the old client stays on the tab");
    // A later session of the same name (rule 2 of C4: after one answered set_scopes without it) sees no old tab.
    h.fake.line(TWO);
    const later = await h.connect("sb");
    assert.deepEqual((await later.send("Target.getTargets")).targetInfos, []);
    assert.deepEqual((await a.send("Target.getTargets")).targetInfos.map((x: any) => x.targetId), [pa.targetId], "the other scope keeps its tab");
  } finally { await h.close(); }
});

test("a line whose scopes is not an object drops no tab (every connection closes, its scope has no list), and a tab that waits for its bridge.tabScope stays", async () => {
  const h = await harness();
  try {
    await h.ready(TWO);
    const a = await raw(h.url("sa"));
    const c = await h.connect("sa");
    const pa = await page(h, c);
    h.fake.line({ ...TWO, scopes: ["sa"] });
    assert.deepEqual(await a.closed, closeOf("noList"));
    await c.closedPromise;
    h.fake.line(TWO);
    const again = await h.connect("sa");
    assert.deepEqual((await again.send("Target.getTargets")).targetInfos.map((x: any) => x.targetId), [pa.targetId], "the tab stayed in the model");
    // A new tab that still waits for its bridge.tabScope has no scope yet: a line without sb does not drop it.
    await again.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    const attached = again.waitForEvent("Target.attachedToTarget", { timeoutMs: 2000 });
    const popup = h.fake.newTab("https://a.example/late", pa.tab, 1, 0, null);
    await sleep(50);
    h.fake.line({ ...TWO, scopes: { sa: "a" } });
    h.fake.emit("bridge.tabScope", { tabId: popup.id, scope: "sa" });
    assert.equal((await attached).targetInfo.targetId, popup.targetId);
  } finally { await h.close(); }
});

// ------------------------------------------------------------------ the tabs the relay opens (C10's scope arg)

test("Target.createTarget names the connection's scope as the second arg of windows.create (Linux) and tabs.create (the Mac)", async () => {
  for (const windowPerPage of [true, false]) {
    const h = await harness({ windowPerPage });
    try {
      await h.ready(TWO);
      for (const scope of ["sa", "sb"]) {
        const c = await h.connect(scope);
        await page(h, c);
        await c.send("Target.createTarget", { url: "about:blank", newWindow: true });
      }
      const creates = h.fake.requests.filter((r) => r.op.endsWith(".create")).map((r) => [r.op, r.args]);
      assert.deepEqual(creates, windowPerPage
        ? [["windows.create", [{ url: "about:blank", focused: false }, "sa"]], ["windows.create", [{ url: "about:blank", focused: false }, "sa"]],
          ["windows.create", [{ url: "about:blank", focused: false }, "sb"]], ["windows.create", [{ url: "about:blank", focused: false }, "sb"]]]
        : [["tabs.create", [{ url: "about:blank", active: true }, "sa"]], ["windows.create", [{ url: "about:blank", focused: false }, "sa"]],
          ["tabs.create", [{ url: "about:blank", active: true }, "sb"]], ["windows.create", [{ url: "about:blank", focused: false }, "sb"]]]);
      for (const [op, args] of creates) assert.ok(bridgeV.ops.find((o: any) => o.op === op).kinds[1] === "scope" && args[1] === "sa" || args[1] === "sb");
    } finally { await h.close(); }
  }
});

test("the receiver's 'no list for this scope' reaches the client of Target.createTarget as -32000", async () => {
  const h = await harness();
  try {
    await h.ready(TWO);
    const vector = bridgeV.badRequests.find((v: any) => v.req.op === "windows.create" && v.error === "no list for this scope");
    h.fake.op = ({ op }) => (op === "windows.create" ? { error: vector.error } : undefined);
    const c = await raw(h.url("sa"));
    const got = new Promise<any>((r) => c.ws!.once("message", (d) => r(JSON.parse(String(d)))));
    c.ws!.send(JSON.stringify({ id: 1, method: "Target.createTarget", params: { url: "https://a.example/" } }));
    assert.deepEqual((await got).error, { code: -32000, message: "no list for this scope" });
    c.ws!.close();
  } finally { await h.close(); }
});

// ------------------------------------------------------------------ a tab's scope from bridge.tabScope only (C11)

test("a popup joins the scope that bridge.tabScope names, at once, never its opener's by the relay's own reckoning", async () => {
  const h = await harness();
  try {
    await h.ready({ ...TWO, scopes: { s1: "a", s2: "a" } });
    const a = await h.connect("s1"), b = await h.connect("s2");
    const opener = await page(h, a);
    await b.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    // The receiver's own scope of the popup (here not the opener's) decides: the relay never computes it.
    const toB = b.waitForEvent("Target.attachedToTarget", { timeoutMs: 2000 });
    let toA = 0;
    a.on("Target.attachedToTarget", () => toA++);
    const t0 = Date.now();
    const popup = h.fake.newTab("https://a.example/p", opener.tab, 1, 0, "s2");
    const ev = await toB;
    assert.equal(ev.targetInfo.targetId, popup.targetId);
    assert.equal(ev.targetInfo.openerId, undefined, "the opener is in another scope: no owner from it");
    assert.ok(Date.now() - t0 < TAB_SCOPE_WAIT_MS, "no wait: the event came before tabs.onCreated");
    await sleep(20);
    assert.equal(toA, 0);
    assert.deepEqual((await a.send("Target.getTargets")).targetInfos.map((x: any) => x.targetId), [opener.targetId]);
  } finally { await h.close(); }
});

test("a new tab with no bridge.tabScope waits 500 ms in no scope, then is released and detached; a later bridge.tabScope puts it in its scope as a free tab", async () => {
  const h = await harness();
  try {
    await h.ready();
    const c = await h.connect("s1"), watcher = await h.connect("s1");
    const opener = await page(h, c);
    const created: string[] = [];
    watcher.on("Target.targetCreated", (p: any) => created.push(p.targetInfo.targetId));
    await watcher.send("Target.setDiscoverTargets", { discover: true });
    created.length = 0;
    const t0 = Date.now();
    const popup = h.fake.newTab("https://a.example/p", opener.tab, 1, 0, null); // the receiver gave it no scope
    await until(() => h.fake.sent("debugger.detach").some((r) => r.args[0] === popup.id), "the detach at the end of the wait", 2000);
    const waited = Date.now() - t0;
    assert.ok(waited >= TAB_SCOPE_WAIT_MS - 20 && waited < TAB_SCOPE_WAIT_MS + 400, `waited ${waited} ms`);
    assert.ok(h.fake.sent("bridge.release").some((r) => r.args[0] === popup.id), "released as a tab of no scope");
    assert.deepEqual([created, (await c.send("Target.getTargets")).targetInfos.length], [[], 1], "no connection saw it");
    // The receiver's event comes late: the tab joins the scope, free (it carries no debugger).
    h.fake.emit("bridge.tabScope", { tabId: popup.id, scope: "s1" });
    await until(() => created.includes(popup.targetId), "the late popup's announcement");
    const info = (await watcher.send("Target.getTargets")).targetInfos.find((x: any) => x.targetId === popup.targetId);
    assert.ok(info, "the scope sees it now");
  } finally { await h.close(); }
});

test("the relay keeps a bridge.tabScope for a tab that it does not know yet, and drops it at the tab's tabs.onRemoved", async () => {
  const h = await harness();
  try {
    await h.ready();
    const c = await h.connect("s1");
    await page(h, c);
    // A popup that closes while the receiver holds its tabs.onCreated gets none; its tabs.onRemoved goes as usual.
    h.fake.emit("bridge.tabScope", { tabId: 99, scope: "s1" });
    h.fake.emit("tabs.onRemoved", { tabId: 99, removeInfo: { windowId: 1, isWindowClosing: false } });
    await sleep(20);
    // Chrome never repeats a tab id in a run; this only shows that no stale scope stays: a tab 99 now waits in no scope.
    h.fake.tabs.set(99, { id: 99, windowId: 1, url: "about:blank", title: "", targetId: "T99", active: false });
    h.fake.emit("tabs.onCreated", { tab: h.fake.chromeTab(h.fake.tabs.get(99)!), attached: false, held: false });
    await sleep(TAB_SCOPE_WAIT_MS + 100);
    assert.ok(!(await c.send("Target.getTargets")).targetInfos.some((x: any) => x.targetId === "T99"));
    // Other events of a tab that the relay does not know yet are dropped (tabs.onUpdated, a CDP event).
    h.fake.emit("tabs.onUpdated", { tabId: 98, changeInfo: { url: "https://a.example/" }, tab: { id: 98 } });
    h.fake.emit("debugger.onEvent", { source: { tabId: 98 }, method: "Page.loadEventFired", params: {} });
    await sleep(20);
  } finally { await h.close(); }
});

test("tabs.onReplaced: the added tab takes the scope of the bridge.tabScope that comes right before it; with none, it is in no scope", async () => {
  const h = await harness();
  try {
    await h.ready();
    const c = await h.connect("s1");
    const p = await page(h, c);
    const swapped = c.waitForEvent("Target.attachedToTarget");
    const fresh = h.fake.replace(p.tab); // bridge.tabScope(added), then tabs.onReplaced
    assert.equal((await swapped).targetInfo.targetId, fresh.targetId, "the owner keeps the tab");
    // The receiver gives the added tab no scope (its old scope had no list): it is in no scope, and the old one is gone.
    const detached = c.waitForEvent("Target.detachedFromTarget");
    const added = { ...fresh, id: 77, targetId: "T77" };
    h.fake.tabs.delete(fresh.id); h.fake.tabs.set(77, added);
    h.fake.emit("tabs.onReplaced", { addedTabId: 77, removedTabId: fresh.id });
    await detached;
    await sleep(50);
    assert.deepEqual((await c.send("Target.getTargets")).targetInfos, []);
  } finally { await h.close(); }
});

// ------------------------------------------------------------------ the receiver's map at each link up (C10, step 2)

test("at the link up the relay reads the receiver's map at once: an event between steps 2 and 3 applies on top, step 3 drops only step 2's tabs that are gone", async () => {
  const h = await harness();
  try {
    // Before the link up: tab 7 (s1) and tab 8 (s2) of the map, tab 9 of no scope (the operator's), and tab 42 of the
    // map that closed in the moment before step 3.
    const t7 = h.fake.newTab("https://a.example/7", undefined, 1, 0, "s1", true);
    const t8 = h.fake.newTab("https://a.example/8", undefined, 1, 0, "s2", true);
    const t9 = h.fake.newTab("https://a.example/9");
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    const targetsBefore = () => [...h.fake.tabs.values()].map((t) => ({ id: t.targetId, tabId: t.id, type: "page", title: "", url: t.url, attached: false }));
    let snapshot: any[] | null = null;
    h.fake.op = async ({ op }) => {
      if (op === "bridge.tabScopes") { snapshot = targetsBefore(); return [{ tabId: t7.id, scope: "s1" }, { tabId: t8.id, scope: "s2" }, { tabId: 42, scope: "s1" }]; }
      // Step 3's answer as it was right after step 2; a later debugger.getTargets (the popup's target id) is Chrome's own.
      if (op === "debugger.getTargets" && snapshot) { const s = snapshot; snapshot = null; await gate; return s; }
      return undefined;
    };
    h.fake.line({ t: "link", up: true, version: "0.3.1" });
    h.fake.line({ t: "allowlist", lists: { a: ["a.example"] }, scopes: {}, default: "a" });
    await until(() => h.fake.sent("debugger.getTargets").length, "step 3");
    assert.deepEqual(await raw(h.url("s1")).then((r) => [r.status, r.body]), [503, NOT_READY.link], "no connection before the steps end");
    // Between steps 2 and 3: a popup of tab 7 (bridge.tabScope, then tabs.onCreated), and tab 8 closes.
    const popup = h.fake.newTab("https://a.example/pop", t7);
    h.fake.tabs.delete(t8.id);
    h.fake.emit("tabs.onRemoved", { tabId: t8.id, removeInfo: { windowId: 1, isWindowClosing: false } });
    await sleep(30);
    open();
    await until(() => h.relay.model.notReady() === null, "ready after the steps");
    const s1 = await h.connect("s1"), s2 = await h.connect("s2");
    const listed = (await s1.send("Target.getTargets")).targetInfos.map((x: any) => [x.targetId, x.attached]).sort();
    assert.deepEqual(listed, [[popup.targetId, false], [t7.targetId, false]].sort(), "the map's tab, free, and the popup that step 3 did not list");
    assert.deepEqual((await s2.send("Target.getTargets")).targetInfos, [], "the tab that closed between the steps");
    assert.ok(h.logs.some((l) => /1 tab\(s\) of the receiver's map are gone/.test(l)), h.logs.join("\n"));
    assert.ok(!listed.some(([id]: string[]) => id === t9.targetId), "a tab of no scope stays out");
    // The client of the scope attaches the free tab of before and drives it.
    const { sessionId } = await s1.send("Target.attachToTarget", { targetId: t7.targetId, flatten: true });
    await s1.send("Runtime.evaluate", { expression: "1" }, sessionId);
    assert.deepEqual(h.fake.sent("debugger.sendCommand", "Runtime.evaluate").at(-1)!.args[0], { tabId: t7.id });
  } finally { await h.close(); }
});

test("a failed bridge.tabScopes is logged and the relay goes on with no tab of an earlier link; the order of the steps is C10's", async () => {
  const h = await harness();
  try {
    h.fake.newTab("https://a.example/7", undefined, 1, 0, "s1", true);
    h.fake.op = ({ op }) => (op === "bridge.tabScopes" ? { error: "unknown op" } : undefined);
    await h.ready();
    assert.deepEqual(h.fake.requests.map((r) => r.op).filter((op) => ["bridge.info", "bridge.tabScopes", "debugger.getTargets", "debugger.detach"].includes(op)),
      ["bridge.info", "bridge.tabScopes", "debugger.getTargets"]);
    assert.ok(h.logs.some((l) => /bridge\.tabScopes at the link up failed: unknown op/.test(l)), h.logs.join("\n"));
    const c = await h.connect("s1");
    assert.deepEqual((await c.send("Target.getTargets")).targetInfos, []);
    assert.deepEqual(bridgeV.requests.find((r: any) => r.req.op === "bridge.tabScopes").req.args, []);
  } finally { await h.close(); }
});

// ------------------------------------------------------------------ layer 1: the refusal of off-list navigations

test("two scopes with two lists: each scope's own list loads, the other's is refused before any bridge request; a new line moves the refusals", async () => {
  const h = await harness();
  try {
    await h.ready(TWO);
    const a = await h.connect("sa"), b = await h.connect("sb");
    const pa = await page(h, a), pb = await page(h, b);
    const nav = (c: CDPConnection, sid: string, url: string) => failure(c.send("Page.navigate", { url }, sid));
    assert.equal(await nav(a, pa.sessionId, "https://a.example/x"), "no error");
    assert.equal(await nav(a, pa.sessionId, "https://www.a.example/x"), "no error");
    assert.equal(await nav(b, pb.sessionId, "https://b.example/x"), "no error");
    const before = h.fake.requests.length;
    assert.equal(await nav(a, pa.sessionId, "https://b.example/x"), "Not allowed: b.example is not on the allowlist");
    assert.equal(await nav(b, pb.sessionId, "https://a.example/x"), "Not allowed: a.example is not on the allowlist");
    assert.equal(await failure(a.send("Page.navigate", { url: "https://b.example/", frameId: pa.targetId }, pa.sessionId)), "Not allowed: b.example is not on the allowlist");
    assert.equal(await failure(a.send("Target.createTarget", { url: "https://b.example/" })), "Not allowed: b.example is not on the allowlist");
    assert.equal(await failure(b.send("Target.createTarget", { url: "http://a.example:8080/" })), "Not allowed: a.example is not on the allowlist");
    assert.deepEqual(h.fake.requests.slice(before), [], "no refused call reached the bridge");
    // A frame's navigation, data: and about:blank pass (O11).
    assert.equal(await failure(a.send("Page.navigate", { url: "https://b.example/", frameId: "F2" }, pa.sessionId)), "no error");
    assert.equal(await nav(a, pa.sessionId, "data:text/html,x"), "no error");
    // The daemon gives scope sa list b: the refusals follow the new line.
    h.fake.line({ ...TWO, scopes: { sa: "b", sb: "b" } });
    await until(() => h.relay.model.refuse("sa") === null, "the new line");
    assert.equal(await nav(a, pa.sessionId, "https://b.example/y"), "no error");
    assert.equal(await nav(a, pa.sessionId, "https://a.example/y"), "Not allowed: a.example is not on the allowlist");
  } finally { await h.close(); }
});

test("layer 1 in the policy: the main frame and a new tab's URL only, http(s) and blob: inner hosts, a scope with no list refuses every host", () => {
  const list = ["a.example"];
  assert.equal(offList("Page.navigate", { url: "https://b.example/" }, list, "T1"), "b.example");
  assert.equal(offList("Page.navigate", { url: "https://b.example/", frameId: "T1" }, list, "T1"), "b.example");
  assert.equal(offList("Page.navigate", { url: "https://b.example/", frameId: "F2" }, list, "T1"), null, "a frame");
  assert.equal(offList("Page.navigate", { url: "https://b.example/" }, list, undefined), null, "a child session, or no page session");
  assert.equal(offList("Page.navigate", { url: "https://b.example/", frameId: "F2" }, list, null), "b.example", "a tab whose target id is not known: every navigation is its main frame's");
  assert.equal(offList("Page.navigate", { url: "blob:https://b.example/1b2c" }, list, "T1"), "b.example");
  assert.equal(offList("Page.navigate", { url: "blob:https://a.example/1b2c" }, list, "T1"), null);
  assert.equal(offList("Page.navigate", { url: "HTTPS://WWW.A.EXAMPLE/" }, list, "T1"), null, "the URL's host, lowercased");
  assert.equal(offList("Page.navigate", { url: "data:text/html,x" }, list, "T1"), null);
  assert.equal(offList("Page.navigate", { url: "about:blank" }, list, "T1"), null);
  assert.equal(offList("Page.navigate", { url: "https://a.example/" }, null, "T1"), "a.example", "a scope with no list");
  assert.equal(offList("Page.navigate", { url: "https://a.example/" }, [], "T1"), "a.example", "an empty list: about:blank only");
  assert.equal(offList("Target.createTarget", { url: "https://b.example/" }, list, undefined), "b.example");
  assert.equal(offList("Target.createTarget", { url: "" }, list, undefined), null);
  assert.equal(offList("Target.createTarget", {}, list, undefined), null);
  assert.equal(offList("Page.reload", {}, list, "T1"), null, "other actions: DNR and the receiver's guard");
});

// ------------------------------------------------------------------ grants and content settings per scope

test("grants per scope: no origin covers the scope's own list; an origin off it is refused; each line sets again the grants that their own scope's list still covers", async () => {
  const h = await harness();
  try {
    await h.ready(TWO);
    await until(() => h.fake.sent("contentSettings.set").length === 2, "automatic downloads for every entry of every list");
    assert.deepEqual(h.fake.sent("contentSettings.set").map((r) => r.args[1].primaryPattern).sort(), ["*://*.a.example/*", "*://*.b.example/*"]);
    const a = await h.connect("sa"), b = await h.connect("sb");
    const mark = h.fake.requests.length;
    await a.send("Browser.grantPermissions", { permissions: ["geolocation"] });
    await b.send("Browser.grantPermissions", { permissions: ["notifications"], origin: "https://b.example" });
    assert.equal(await failure(a.send("Browser.grantPermissions", { permissions: ["geolocation"], origin: "https://b.example" })), "Not allowed: b.example is not on the allowlist");
    assert.deepEqual(h.fake.requests.slice(mark).filter((r) => r.op === "contentSettings.set").map((r) => r.args),
      [["location", { primaryPattern: "*://*.a.example/*", setting: "allow" }], ["notifications", { primaryPattern: "https://b.example/*", setting: "allow" }]]);
    // The line gives sa list b: sa's grant for a.example is not set again; sb's grant stays.
    const from = h.fake.requests.length;
    h.fake.line({ ...TWO, scopes: { sa: "b", sb: "b" } });
    await until(() => h.fake.requests.slice(from).filter((r) => r.op === "contentSettings.clear").length === 6, "the rebuild of the six types");
    await sleep(30);
    assert.deepEqual(h.fake.requests.slice(from).filter((r) => r.op === "contentSettings.set").map((r) => [r.args[0], r.args[1].primaryPattern]).sort(),
      [["automaticDownloads", "*://*.a.example/*"], ["automaticDownloads", "*://*.b.example/*"], ["notifications", "https://b.example/*"]]);
  } finally { await h.close(); }
});
