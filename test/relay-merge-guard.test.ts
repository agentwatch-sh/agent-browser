// The merge guard in the model (board ab-v16.99; C11, the merge guard): real CDP clients on the relay's socket, the fake
// receiver behind its bridge. The fake gives the PR pages' answers (Fetch.getResponseBody) and records every command, so
// the tests show what reached "Chrome", what the guard answered itself, and that no client ever saw a request to GitHub.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CDPConnection } from "../src/cdp.ts";
import { GUARD_TEXT } from "../src/relay/merge-guard.ts";
import { harness, until, type Harness } from "./fake-bridge.ts";

const S = "github-standin.localhost";
const MARKED = `<title>[agentwatch triage] Fix a typo · Pull Request #2</title><a href="/o/r/pull/2">#2</a> agentwatch-triage/issue-7 <i>PR_kwDOtest00000002</i>`;
const UNMARKED = `<title>Fix a typo · Pull Request #1</title><a href="/o/r/pull/1">#1</a> from fix-typo`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const failure = (p: Promise<unknown>) => p.then(() => "no error", (e: Error) => e.message.replace(/^[A-Za-z]+\.[A-Za-z]+: /, ""));

/** A tab of the connection's own, with auto-attach on. */
async function page(h: Harness, c: CDPConnection) {
  await c.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  const attached = c.waitForEvent("Target.attachedToTarget");
  const { targetId } = await c.send("Target.createTarget", { url: "about:blank" });
  const ev = await attached;
  return { targetId, sessionId: ev.sessionId as string, tab: [...h.fake.tabs.values()].find((t) => t.targetId === targetId)! };
}

/** The fake's answers of the PR pages: the body of each paused response, by URL. */
function pages(h: Harness, bodies: Record<string, string>) {
  const ids = new Map<string, string>();
  h.fake.command = (_t, method, params) => {
    if (method === "Fetch.getResponseBody") { const url = ids.get(params.requestId); return url && bodies[url] !== undefined ? { body: Buffer.from(bodies[url]).toString("base64"), base64Encoded: true } : { error: JSON.stringify({ code: -32000, message: "No resource with given identifier found" }) }; }
    return undefined;
  };
  return (tabId: number, requestId: string, url: string, more: object = {}) => {
    ids.set(requestId, url);
    h.fake.emit("debugger.onEvent", { source: { tabId }, method: "Fetch.requestPaused", params: { requestId, request: { url, method: "GET", headers: {} }, resourceType: "Document", frameId: "x", responseStatusCode: 200, responseHeaders: [{ name: "content-type", value: "text/html" }], ...more } });
  };
}
const paused = (h: Harness, tabId: number, requestId: string, url: string, method = "POST", more: object = {}) =>
  h.fake.emit("debugger.onEvent", { source: { tabId }, method: "Fetch.requestPaused", params: { requestId, request: { url, method, headers: {} }, resourceType: "XHR", frameId: "x", ...more } });
/** The guard's answer of a request: the CDP command that the model sent for it. */
const answerOf = (h: Harness, requestId: string) => h.fake.requests.find((r) => r.op === "debugger.sendCommand" && r.args[2]?.requestId === requestId && r.args[1] !== "Fetch.getResponseBody");
const textOf = (r: any) => { const b = Buffer.from(r.args[2].body, "base64").toString(); try { return JSON.parse(b).message; } catch { return b; } };

test("a client's session arms the tab before the client has it: the guard's Fetch, then bridge.mergeGuard with the tab", async () => {
  const h = await harness();
  try {
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    h.fake.op = async ({ op }) => (op === "bridge.mergeGuard" && h.relay.model.guard.isArmed(7) ? gate.then(() => null) : undefined);
    await h.ready();
    const c = await h.connect();
    await c.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    let got = false;
    const attached = c.waitForEvent("Target.attachedToTarget").then((e) => { got = true; return e; });
    const created = c.send("Target.createTarget", { url: "about:blank" });
    await until(() => h.fake.sent("bridge.mergeGuard").some((r) => r.args[0].tabs.includes(7)), "the floor op of the tab");
    await sleep(30);
    assert.equal(got, false, "no session before the floor leaves the tab to the guard");
    const enable = h.fake.sent("debugger.sendCommand", "Fetch.enable");
    assert.deepEqual(enable.map((r) => r.args), [[{ tabId: 7 }, "Fetch.enable", { patterns: [...h.relay.model.guard.patterns] }]]);
    assert.ok(h.fake.requests.indexOf(enable[0]) < h.fake.requests.indexOf(h.fake.sent("bridge.mergeGuard").at(-1)!), "the Fetch first");
    assert.deepEqual(h.fake.sent("bridge.mergeGuard")[0].args, [{ hosts: ["github.com"], tabs: [] }], "the link up's op: the hosts, no tab");
    assert.deepEqual(h.fake.sent("bridge.mergeGuard").at(-1)!.args, [{ hosts: ["github.com"], tabs: [7] }]);
    open();
    await attached; await created;
    assert.equal(h.relay.model.guard.floor, "on");
    // The client leaves: the tab is detached, and the guard keeps nothing of it.
    await c.close();
    await until(() => h.fake.sent("debugger.detach").some((r) => r.args[0] === 7), "the detach");
    assert.equal(h.relay.model.guard.isArmed(7), false);
  } finally { await h.close(); }
});

test("a marked PR: its merge, Ready for review, auto-merge and its GraphQL get HTTP 403 with the rule's text; no client sees a request to GitHub, also with Fetch on for every URL", async () => {
  const h = await harness();
  try {
    await h.ready();
    const c = await h.connect();
    const { sessionId, tab } = await page(h, c);
    await c.send("Fetch.enable", { patterns: [{ urlPattern: "*" }, { urlPattern: "*", requestStage: "Response" }] }, sessionId);
    const seen: string[] = [];
    c.on("Fetch.requestPaused", (p) => { seen.push(p.request.url); });
    const answer = pages(h, { "https://github.com/o/r/pull/2": MARKED });
    answer(tab.id, "p1", "https://github.com/o/r/pull/2");
    await until(() => h.relay.model.guard.verdict("github.com/o/r#2") === "marked", "the marked verdict");
    h.fake.emit("tabs.onUpdated", { tabId: tab.id, changeInfo: { url: "https://github.com/o/r/pull/2" }, tab: { ...h.fake.chromeTab(tab), url: "https://github.com/o/r/pull/2" } });
    await sleep(10);
    const writes: [string, string, string, object?][] = [
      ["m1", "https://github.com/o/r/pull/2/merge", "POST", { resourceType: "Document" }],
      ["m2", "https://github.com/o/r/pull/2/ready_for_review", "POST"],
      ["m3", "https://github.com/o/r/pull/2/auto_merge", "POST"],
      ["m4", "https://github.com/_graphql", "POST", { request: { url: "https://github.com/_graphql", method: "POST", headers: {}, postData: JSON.stringify({ query: "mutation { enablePullRequestAutoMerge(input: {pullRequestId: \"PR_kwDOtest00000002\"}) { x } }" }) } }],
      ["m5", "https://api.github.com/repos/o/r/pulls/2/merge", "PUT", { request: { url: "https://api.github.com/repos/o/r/pulls/2/merge", method: "PUT", headers: { Origin: "https://github.com" } } }],
      ["m6", "https://github.com/o/r/issue_comments", "POST"],
    ];
    for (const [id, url, method, more] of writes) paused(h, tab.id, id, url, method, more);
    // A request of another site goes to the client as before.
    paused(h, tab.id, "a1", "https://a.example/form", "POST");
    await until(() => seen.length === 1, "the other site's request at the client");
    await until(() => writes.every(([id]) => answerOf(h, id)), "the guard's answers");
    for (const [id] of writes) {
      const r = answerOf(h, id)!;
      assert.deepEqual([r.args[1], r.args[2].responseCode, textOf(r)], ["Fetch.fulfillRequest", 403, GUARD_TEXT.marked], id);
    }
    assert.deepEqual(seen, ["https://a.example/form"], "the client saw no request to GitHub");
    assert.ok(h.logs.includes("merge guard: refused a write to github.com (POST, tab 7): marked; refused so far: 1"), h.logs.join("\n"));
    assert.equal(h.relay.model.guard.state().counts.marked, 6);
  } finally { await h.close(); }
});

test("an unmarked PR's merge, Ready for review and auto-merge go; a PR page with no verdict refuses with the text that says to load it", async () => {
  const h = await harness();
  try {
    await h.ready();
    const c = await h.connect();
    const { tab } = await page(h, c);
    const answer = pages(h, { "https://github.com/o/r/pull/1": UNMARKED });
    answer(tab.id, "p1", "https://github.com/o/r/pull/1");
    await until(() => h.relay.model.guard.verdict("github.com/o/r#1") === "unmarked", "the unmarked verdict");
    // The page as its top-frame document request gives it (Request stage, the tab's own frame id).
    h.fake.emit("debugger.onEvent", { source: { tabId: tab.id }, method: "Fetch.requestPaused", params: { requestId: "d1", request: { url: "https://github.com/o/r/pull/1", method: "GET", headers: {} }, resourceType: "Document", frameId: tab.targetId } });
    for (const [id, tail] of [["u1", "merge"], ["u2", "ready_for_review"], ["u3", "auto_merge"]]) paused(h, tab.id, id, `https://github.com/o/r/pull/1/${tail}`);
    await until(() => ["d1", "u1", "u2", "u3"].every((id) => answerOf(h, id)), "the answers");
    for (const id of ["d1", "u1", "u2", "u3"]) assert.equal(answerOf(h, id)!.args[1], "Fetch.continueRequest", id);
    // Another tab of the same scope on a PR with no verdict.
    const other = await page(h, c);
    h.fake.emit("tabs.onUpdated", { tabId: other.tab.id, changeInfo: { url: "https://github.com/o/r/pull/9" }, tab: { ...h.fake.chromeTab(other.tab), url: "https://github.com/o/r/pull/9" } });
    await sleep(10);
    paused(h, other.tab.id, "k1", "https://github.com/o/r/pull/9/merge");
    await until(() => answerOf(h, "k1"), "the refusal");
    assert.deepEqual([answerOf(h, "k1")!.args[1], textOf(answerOf(h, "k1"))], ["Fetch.fulfillRequest", GUARD_TEXT.unknown]);
  } finally { await h.close(); }
});

test("a client cannot act on a request that the guard holds, cannot rewrite a request to GitHub, and its Fetch.disable keeps the guard's Fetch on", async () => {
  const h = await harness();
  try {
    await h.ready();
    const c = await h.connect();
    const { sessionId, tab } = await page(h, c);
    await c.send("Fetch.enable", { patterns: [{ urlPattern: "*a.example*" }] }, sessionId);
    assert.deepEqual(h.fake.sent("debugger.sendCommand", "Fetch.enable").at(-1)!.args[2], { patterns: [...h.relay.model.guard.patterns, { urlPattern: "*a.example*" }] });
    // The guard holds a PR page's answer while it reads it (the fake never answers the read).
    h.fake.command = (_t, method) => (method === "Fetch.getResponseBody" ? new Promise(() => {}) : undefined);
    h.fake.emit("debugger.onEvent", { source: { tabId: tab.id }, method: "Fetch.requestPaused", params: { requestId: "h1", request: { url: "https://github.com/o/r/pull/2", method: "GET", headers: {} }, resourceType: "Document", responseStatusCode: 200, responseHeaders: [] } });
    await until(() => h.fake.sent("debugger.sendCommand", "Fetch.getResponseBody").length, "the read");
    assert.equal(await failure(c.send("Fetch.fulfillRequest", { requestId: "h1", responseCode: 200, body: "" }, sessionId)), GUARD_TEXT.badId);
    assert.equal(await failure(c.send("Fetch.continueRequest", { requestId: "h1" }, sessionId)), GUARD_TEXT.badId);
    // A request of another site that the client got: it may go on, but not to GitHub.
    const got = c.waitForEvent("Fetch.requestPaused", { sessionId });
    paused(h, tab.id, "a1", "https://a.example/x", "GET");
    await got;
    assert.equal(await failure(c.send("Fetch.continueRequest", { requestId: "a1", url: "https://github.com/o/r/pull/2/merge", method: "POST", postData: "x" }, sessionId)), GUARD_TEXT.rewrite("github.com"));
    assert.equal(h.fake.requests.filter((r) => r.op === "debugger.sendCommand" && r.args[2]?.requestId === "a1").length, 0, "neither reached Chrome");
    await c.send("Fetch.continueRequest", { requestId: "a1" }, sessionId);
    // Fetch.disable: Chrome gets the guard's patterns alone.
    await c.send("Fetch.disable", {}, sessionId);
    assert.deepEqual(h.fake.sent("debugger.sendCommand", "Fetch.enable").at(-1)!.args[2], { patterns: [...h.relay.model.guard.patterns] });
    assert.equal(h.fake.sent("debugger.sendCommand", "Fetch.disable").length, 0);
  } finally { await h.close(); }
});

test("Page.setBypassCSP with enabled true is refused before any bridge request; enabled false goes", async () => {
  const h = await harness();
  try {
    await h.ready();
    const c = await h.connect();
    const { sessionId } = await page(h, c);
    const before = h.fake.requests.length;
    assert.equal(await failure(c.send("Page.setBypassCSP", { enabled: true }, sessionId)), "Not available in the agent browser: Page.setBypassCSP.");
    assert.deepEqual(h.fake.requests.slice(before), []);
    await c.send("Page.setBypassCSP", { enabled: false }, sessionId);
    assert.equal(h.fake.sent("debugger.sendCommand", "Page.setBypassCSP").length, 1);
  } finally { await h.close(); }
});

test("an older receiver: bridge.mergeGuard gets unknown op, the floor is absent, the log says so once, and the tab is still guarded while a client holds it", async () => {
  const h = await harness();
  try {
    h.fake.op = ({ op }) => (op === "bridge.mergeGuard" ? { error: "unknown op" } : undefined);
    await h.ready();
    const c = await h.connect();
    const { tab } = await page(h, c);
    assert.equal(h.relay.model.guard.floor, "absent");
    assert.equal(h.logs.filter((l) => l.startsWith("merge guard: the receiver has no floor")).length, 1);
    assert.equal(h.fake.sent("bridge.mergeGuard").length, 1, "no op after unknown op");
    h.fake.emit("tabs.onUpdated", { tabId: tab.id, changeInfo: { url: "https://github.com/o/r/pull/4" }, tab: { ...h.fake.chromeTab(tab), url: "https://github.com/o/r/pull/4" } });
    await sleep(10);
    paused(h, tab.id, "k", "https://github.com/o/r/pull/4/merge");
    await until(() => answerOf(h, "k"), "the refusal");
    assert.equal(textOf(answerOf(h, "k")), GUARD_TEXT.unknown);
  } finally { await h.close(); }
});

test("an event too large for the link of a GitHub page fails; of another page it goes as before", async () => {
  const h = await harness();
  try {
    await h.ready();
    const c = await h.connect();
    const { tab } = await page(h, c);
    h.fake.emit("bridge.tooLarge", { of: "debugger.onEvent", tabId: tab.id, method: "Fetch.requestPaused", requestId: "big-1" });
    await until(() => answerOf(h, "big-1"), "the first answer");
    assert.equal(answerOf(h, "big-1")!.args[1], "Fetch.continueRequest");
    h.fake.emit("tabs.onUpdated", { tabId: tab.id, changeInfo: { url: "https://github.com/o/r/pull/2" }, tab: { ...h.fake.chromeTab(tab), url: "https://github.com/o/r/pull/2" } });
    await sleep(10);
    h.fake.emit("bridge.tooLarge", { of: "debugger.onEvent", tabId: tab.id, method: "Fetch.requestPaused", requestId: "big-2" });
    await until(() => answerOf(h, "big-2"), "the second answer");
    assert.deepEqual(answerOf(h, "big-2")!.args.slice(1), ["Fetch.failRequest", { requestId: "big-2", errorReason: "BlockedByClient" }]);
  } finally { await h.close(); }
});

test("the hosts: GitHub's always; the stand-in host only when the endpoint has it (the service's --test), and its page marks only its own host's PR", async () => {
  const plain = await harness();
  try { assert.deepEqual(plain.relay.model.guard.hosts, ["github.com"]); } finally { await plain.close(); }
  const h = await harness({ mergeGuardHosts: [S] });
  try {
    assert.deepEqual(h.relay.model.guard.hosts, ["github.com", S]);
    await h.ready();
    const c = await h.connect();
    const { tab } = await page(h, c);
    const answer = pages(h, { [`http://${S}:9/o/r/pull/2`]: MARKED });
    answer(tab.id, "p1", `http://${S}:9/o/r/pull/2`);
    await until(() => h.relay.model.guard.verdict(`${S}/o/r#2`) === "marked", "the stand-in's verdict");
    assert.equal(h.relay.model.guard.verdict("github.com/o/r#2"), undefined);
    assert.ok(h.relay.model.guard.patterns.some((p) => p.urlPattern === `*://${S}*`));
  } finally { await h.close(); }
});

test("a child session that the client's auto-attach brings (a worker) gets the guard's Fetch before it runs; its write to GitHub is judged; it ends with its detach", async () => {
  const h = await harness();
  try {
    await h.ready();
    const c = await h.connect();
    const { tab } = await page(h, c);
    h.fake.emit("debugger.onEvent", { source: { tabId: tab.id }, method: "Target.attachedToTarget", params: { sessionId: "W1", waitingForDebugger: true,
      targetInfo: { targetId: "W1T", type: "worker", title: "", url: "blob:https://github.com/x", attached: true, canAccessOpener: false, browserContextId: "C1" } } });
    await until(() => h.fake.sent("debugger.sendCommand", "Fetch.enable").some((r) => r.args[0].sessionId === "W1"), "the worker's Fetch");
    assert.equal(h.relay.model.guard.isArmed(tab.id, "W1"), true);
    h.fake.emit("tabs.onUpdated", { tabId: tab.id, changeInfo: { url: "https://github.com/o/r/pull/5" }, tab: { ...h.fake.chromeTab(tab), url: "https://github.com/o/r/pull/5" } });
    await sleep(10);
    h.fake.emit("debugger.onEvent", { source: { tabId: tab.id, sessionId: "W1" }, method: "Fetch.requestPaused", params: { requestId: "w1", request: { url: "https://github.com/o/r/pull/5/merge", method: "POST", headers: {} }, resourceType: "Fetch" } });
    await until(() => answerOf(h, "w1"), "the refusal");
    assert.deepEqual([answerOf(h, "w1")!.args[0], textOf(answerOf(h, "w1"))], [{ tabId: tab.id, sessionId: "W1" }, GUARD_TEXT.unknown]);
    h.fake.emit("debugger.onEvent", { source: { tabId: tab.id }, method: "Target.detachedFromTarget", params: { sessionId: "W1", targetId: "W1T" } });
    await sleep(10);
    assert.equal(h.relay.model.guard.isArmed(tab.id, "W1"), false);
  } finally { await h.close(); }
});
