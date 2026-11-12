// The sign-in act in the model (contract C11, the sign-in act: the entry, the act window hidden from every client; C10's
// list N4 of what still reaches the relay for incognito tabs; board ab-v16.97.4): AgentBrowser.signIn and signIns on the
// root and on a browser session of a model with the act, refused by the relay and on a page session; the connection's
// admission for check 1; the act tab and its window in no client's answer, event or window lookup; every event and read
// of N4 kept from each client and given to the act's listeners; the downloads of an incognito tab; the input lock. The
// receiver is test/fake-bridge.ts. Every value is a made-up TEST value.

import { test } from "node:test";
import assert from "node:assert/strict";
import { harness, lineOf, until, type Harness } from "./fake-bridge.ts";
import type { Conn } from "../src/relay/model.ts";

const CANARY = "Canary-Model-Pass-3Z";
type Client = { conn: Conn; got: any[]; ask: (method: string, params?: object, sessionId?: string) => Promise<any> };

/** A client of the model with a recording socket (the endpoint's admission is outside these tests). */
function client(h: Harness, scope = "s1", admission: "local" | "remote" = "local"): Client {
  const got: any[] = [];
  const answers = new Map<number, (m: any) => void>();
  const conn = h.relay.model.open(scope, { send: (t) => { const m = JSON.parse(t); if (typeof m.id === "number" && answers.has(m.id)) { answers.get(m.id)!(m); answers.delete(m.id); } else got.push(m); }, close: () => {} }, null, admission);
  let id = 0;
  const ask = (method: string, params: object = {}, sessionId?: string) => new Promise<any>((resolve) => {
    const n = ++id;
    answers.set(n, resolve);
    void h.relay.model.onMessage(conn, { id: n, method, params, ...(sessionId ? { sessionId } : {}) });
  });
  return { conn, got, ask };
}
const settle = () => new Promise((r) => setTimeout(r, 30));
/** The stub act: it records its calls and answers. */
function stubAct() {
  const calls: any[] = [];
  return {
    calls,
    signIn: async (c: any, p: any) => { calls.push(["signIn", c, p]); return { signedIn: true, name: p.name, origin: "http://login.localhost:8080" }; },
    signIns: (c: any) => { calls.push(["signIns", c]); return { state: "open", signIns: [] }; },
  };
}

async function ready(o: { stage?: boolean } = {}): Promise<Harness> {
  const h = await harness(o);
  await h.ready(lineOf(["login.localhost", "a.example"]));
  return h;
}

test("AgentBrowser.signIn and signIns: the relay refuses them as calls outside its set; a model with the act answers them on the root and on a browser session; every model refuses them on a page session", async () => {
  const h = await ready();
  try {
    const c = client(h);
    for (const m of ["AgentBrowser.signIn", "AgentBrowser.signIns"]) assert.deepEqual((await c.ask(m, { name: "staging" })).error, { code: -32000, message: `Not available in the agent browser: ${m}.` }, `the relay: ${m}`);
    const act = stubAct();
    h.relay.model.setSignIns(act);
    assert.deepEqual((await c.ask("AgentBrowser.signIn", { name: "staging" })).result, { signedIn: true, name: "staging", origin: "http://login.localhost:8080" });
    assert.deepEqual((await c.ask("AgentBrowser.signIns")).result, { state: "open", signIns: [] });
    const { sessionId } = (await c.ask("Target.attachToBrowserTarget")).result;
    assert.equal((await c.ask("AgentBrowser.signIn", { name: "staging" }, sessionId)).result.signedIn, true, "a browser session");
    // A page session: refused, and nothing reaches Chrome or the act.
    const { targetId } = (await c.ask("Target.createTarget", { url: "about:blank" })).result;
    const page = (await c.ask("Target.attachToTarget", { targetId, flatten: true })).result.sessionId;
    const before = h.fake.requests.length, n = act.calls.length;
    for (const m of ["AgentBrowser.signIn", "AgentBrowser.signIns"]) assert.deepEqual((await c.ask(m, { name: "staging" }, page)).error, { code: -32000, message: `Not available in the agent browser: ${m}.` });
    assert.equal(h.fake.requests.slice(before).filter((r) => r.op === "debugger.sendCommand").length, 0);
    assert.equal(act.calls.length, n);
    // The act's refusal reaches the client as C11's CDP error.
    h.relay.model.setSignIns({ signIn: async () => { throw new Error("Not signed in: There is no stored sign-in named staging for this repo."); }, signIns: () => ({}) });
    assert.deepEqual((await c.ask("AgentBrowser.signIn", { name: "staging" })).error, { code: -32000, message: "Not signed in: There is no stored sign-in named staging for this repo." });
  } finally { await h.close(); }
});

test("check 1's admission: the act gets the connection's scope and admission (the agent door and an MCP ticket are local; a remote one is remote), never a scope from the request", async () => {
  const h = await ready();
  try {
    const act = stubAct();
    h.relay.model.setSignIns(act);
    await client(h, "s1").ask("AgentBrowser.signIn", { name: "staging", scope: "s9" });
    await client(h, "s2", "remote").ask("AgentBrowser.signIns", { scope: "s1" });
    assert.deepEqual(act.calls.map((c) => [c[0], c[1]]), [["signIn", { scope: "s1", admission: "local" }], ["signIns", { scope: "s2", admission: "remote" }]]);
  } finally { await h.close(); }
});

/** The act's window through the act port: the receiver's windows.create with incognito and the mark act; the tab hidden; the act's own attach. */
async function actWindow(h: Harness) {
  const port = h.relay.model.actPort();
  const heard: any[] = [];
  const off = port.listen((ev) => heard.push(ev));
  const w = await port.call("windows.create", [{ url: "about:blank", focused: false, incognito: true }, "s1", "act"]);
  const tab = w.tabs[0].id as number;
  port.hide(tab);
  await port.call("debugger.attach", [tab]);
  await settle();
  return { port, heard, off, window: w.id as number, tab, targetId: h.fake.tabs.get(tab)!.targetId };
}

test("the act tab is hidden: no client's Target.getTargets, discover, auto-attach, target call or window lookup sees it; the model never detaches the act's session", async () => {
  const h = await ready();
  try {
    const c = client(h);
    await c.ask("Target.setDiscoverTargets", { discover: true });
    await c.ask("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    const own = (await c.ask("Target.createTarget", { url: "about:blank" })).result.targetId;
    const a = await actWindow(h);
    assert.ok(h.relay.model.isHidden(a.tab));
    await settle();
    const infos = (await c.ask("Target.getTargets")).result.targetInfos;
    assert.deepEqual(infos.map((t: any) => t.targetId), [own], "only the client's own page");
    for (const m of ["Target.attachToTarget", "Target.getTargetInfo", "Target.closeTarget", "Target.activateTarget", "Browser.getWindowForTarget"]) {
      assert.deepEqual((await c.ask(m, { targetId: a.targetId, flatten: true })).error?.message, "No target with given id found", m);
    }
    for (const m of ["Browser.getWindowBounds", "Browser.setWindowBounds"]) {
      assert.deepEqual((await c.ask(m, { windowId: a.window, bounds: { left: 0 } })).error?.message, "Browser window not found", m);
    }
    // A window that holds an incognito tab is in no window lookup, also when a tab of the scope were in it too.
    const ownTab = [...h.fake.tabs.values()].find((t) => t.targetId === own)!;
    h.fake.op = ({ op, args }) => (op === "tabs.query" && args[0]?.windowId === a.window ? [h.fake.chromeTab(h.fake.tabs.get(a.tab)!), h.fake.chromeTab(ownTab)] : undefined);
    assert.deepEqual((await c.ask("Browser.getWindowBounds", { windowId: a.window })).error?.message, "Browser window not found", "a window with an incognito tab");
    h.fake.op = () => undefined;
    const text = JSON.stringify(c.got);
    assert.ok(!text.includes(a.targetId) && !text.includes(`"tabId":${a.tab}`), "no event names the act tab");
    // No request of the model names the act tab, except the act's own create and attach.
    const named = h.fake.requests.filter((r) => (r.args[0] === a.tab || r.args[0]?.tabId === a.tab));
    assert.deepEqual(named.map((r) => r.op), ["debugger.attach"]);
    a.off();
  } finally { await h.close(); }
});

test("C10's list N4: each event of an incognito tab (the act tab, its popup, the operator's private tab) reaches the act's listeners and no client: tabs.onCreated, onUpdated, onRemoved, onReplaced, onCreatedNavigationTarget, webNavigation.onErrorOccurred, bridge.tabScope, bridge.tooLarge, and the act tab's debugger.onEvent and debugger.onDetach", async () => {
  const h = await ready();
  try {
    const c = client(h);
    await c.ask("Target.setDiscoverTargets", { discover: true });
    await c.ask("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    await c.ask("Target.createTarget", { url: "about:blank" });
    await settle();
    const a = await actWindow(h);
    // The act window's own tabs.onCreated (incognito) went to the act's listeners already, and to no client.
    assert.deepEqual(a.heard.map((e) => e.ev), ["tabs.onCreated"]);
    const before = c.got.length, reqs = h.fake.requests.length, start = a.heard.length;
    const evs: [string, object][] = [
      ["tabs.onUpdated", { tabId: a.tab, changeInfo: { url: `http://login.localhost:8080/login?u=${CANARY}` }, tab: { id: a.tab, windowId: a.window, incognito: true, url: `http://login.localhost:8080/login?u=${CANARY}`, title: CANARY } }],
      ["debugger.onEvent", { source: { tabId: a.tab }, method: "Network.requestWillBeSent", params: { request: { url: "http://login.localhost:8080/login", postData: `p=${CANARY}` } } }],
      ["debugger.onEvent", { source: { tabId: a.tab }, method: "Target.targetCreated", params: { targetInfo: { targetId: "POPUP", type: "page", url: "about:blank" } } }],
      ["webNavigation.onCreatedNavigationTarget", { details: { sourceTabId: a.tab, sourceFrameId: 0, tabId: 61, url: `http://login.localhost:8080/p?${CANARY}` } }],
      ["tabs.onCreated", { tab: { id: 61, windowId: 62, incognito: true, openerTabId: a.tab, url: "" }, attached: false, held: false }],
      ["bridge.tabScope", { tabId: 61, scope: "s1" }],
      ["webNavigation.onErrorOccurred", { details: { tabId: 61, frameId: 0, url: `http://tracker.localhost:8081/?${CANARY}`, error: "net::ERR_BLOCKED_BY_CLIENT" } }],
      ["tabs.onReplaced", { addedTabId: 63, removedTabId: 61 }],
      ["tabs.onUpdated", { tabId: 63, changeInfo: { title: CANARY }, tab: { id: 63, windowId: 62, incognito: true, title: CANARY } }],
      ["bridge.tooLarge", { of: "debugger.onEvent", method: "Fetch.requestPaused", tabId: a.tab, requestId: "r1" }],
      // The operator's own private tab: the same rule.
      ["tabs.onCreated", { tab: { id: 70, windowId: 71, incognito: true, url: `http://private.example.net/${CANARY}` }, attached: false, held: false }],
      ["tabs.onRemoved", { tabId: 70, removeInfo: { windowId: 71, isWindowClosing: true } }],
      ["tabs.onRemoved", { tabId: 63, removeInfo: { windowId: 62, isWindowClosing: true } }],
      ["debugger.onDetach", { source: { tabId: a.tab }, reason: "target_closed" }],
    ];
    for (const [ev, fields] of evs) h.fake.emit(ev, fields);
    await until(() => a.heard.length - start >= evs.length, "the act's listeners got each event", 2000);
    await new Promise((r) => setTimeout(r, 600)); // past the model's wait for a new tab's scope
    assert.deepEqual(a.heard.slice(start).map((e) => e.ev), evs.map(([ev]) => ev), "each event, in order, to the act");
    assert.equal(c.got.length, before, `no client message: ${JSON.stringify(c.got.slice(before)).slice(0, 300)}`);
    // No bridge request for any of them (no tabs.get of a popup, no release, no detach, no continue of a too-large event).
    const later = h.fake.requests.slice(reqs);
    assert.deepEqual(later.filter((r) => [a.tab, 61, 63, 70].includes(r.args[0]) || [a.tab, 61, 63, 70].includes(r.args[0]?.tabId)).map((r) => r.op), []);
    assert.ok(!JSON.stringify((await c.ask("Target.getTargets")).result).includes(CANARY));
    a.off();
  } finally { await h.close(); }
});

test("C10's list N4: a download of an incognito tab never binds to a client's download (no cancel, no canceled event); a client's own download still does", async () => {
  const h = await ready();
  try {
    const c = client(h);
    const { targetId } = (await c.ask("Target.createTarget", { url: "about:blank" })).result;
    const s = (await c.ask("Target.attachToTarget", { targetId, flatten: true })).result.sessionId;
    await c.ask("Browser.setDownloadBehavior", { behavior: "allow", eventsEnabled: true });
    const tabId = [...h.fake.tabs.values()].find((t) => t.targetId === targetId)!.id;
    const url = "http://a.example/file.bin";
    h.fake.emit("debugger.onEvent", { source: { tabId }, method: "Page.downloadWillBegin", params: { guid: "g1", url, suggestedFilename: "file.bin", frameId: "F" } });
    await settle();
    const n = c.got.length;
    h.fake.emit("downloads.onCreated", { item: { id: 77, url, incognito: true, state: "in_progress" } });
    h.fake.emit("downloads.onChanged", { delta: { id: 77, danger: { current: "dangerous", previous: "safe" } } });
    await settle();
    assert.deepEqual(h.fake.requests.filter((r) => r.op === "downloads.cancel").map((r) => r.args), [], "no cancel of the incognito download");
    assert.equal(c.got.slice(n).filter((m) => m.method === "Browser.downloadProgress").length, 0, "the client's download is not reported canceled");
    // The client's own item binds as before.
    h.fake.emit("downloads.onCreated", { item: { id: 78, url, state: "in_progress" } });
    h.fake.emit("downloads.onChanged", { delta: { id: 78, danger: { current: "dangerous", previous: "safe" } } });
    await until(() => h.fake.requests.some((r) => r.op === "downloads.cancel"), "the cancel of the client's dangerous download");
    assert.deepEqual(h.fake.requests.filter((r) => r.op === "downloads.cancel").map((r) => r.args), [[78]]);
    void s;
  } finally { await h.close(); }
});

test("the input lock: while the act holds it, a client's input that starts an action waits; it goes after the act's release", async () => {
  const h = await ready();
  try {
    const c = client(h);
    const { targetId } = (await c.ask("Target.createTarget", { url: "about:blank" })).result;
    const s = (await c.ask("Target.attachToTarget", { targetId, flatten: true })).result.sessionId;
    const port = h.relay.model.actPort();
    let released = 0, pressedAt = 0;
    h.fake.command = (_t, method) => { if (method === "Input.dispatchMouseEvent") pressedAt = performance.now(); return undefined; };
    const held = port.inputLock(async () => { await new Promise((r) => setTimeout(r, 300)); released = performance.now(); });
    await settle();
    const press = c.ask("Input.dispatchMouseEvent", { type: "mousePressed", x: 10, y: 10, button: "left", clickCount: 1 }, s);
    await held;
    await press;
    const sent = h.fake.requests.filter((r) => r.op === "debugger.sendCommand" && r.args[1] === "Input.dispatchMouseEvent");
    assert.equal(sent.length, 1);
    assert.ok(released > 0 && pressedAt >= released, "the client's press reached Chrome only after the act's release");
  } finally { await h.close(); }
});
