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

const MARKED_WRITES: [string, string, string, object?][] = [
  ["m1", "https://github.com/o/r/pull/2/merge", "POST", { resourceType: "Document" }],
  ["m2", "https://github.com/o/r/pull/2/ready_for_review", "POST"],
  ["m3", "https://github.com/o/r/pull/2/auto_merge", "POST"],
  ["m4", "https://github.com/_graphql", "POST", { request: { url: "https://github.com/_graphql", method: "POST", headers: {}, postData: JSON.stringify({ query: "mutation { enablePullRequestAutoMerge(input: {pullRequestId: \"PR_kwDOtest00000002\"}) { x } }" }) } }],
  ["m5", "https://api.github.com/repos/o/r/pulls/2/merge", "PUT", { request: { url: "https://api.github.com/repos/o/r/pulls/2/merge", method: "PUT", headers: { Origin: "https://github.com" } } }],
  ["m6", "https://github.com/o/r/pull/2/reviews", "POST", { request: { url: "https://github.com/o/r/pull/2/reviews", method: "POST", headers: {}, postData: "pull_request_review[event]=approve" } }],
  ["m7", "https://github.com/o/r/issue_comments", "POST"],
];

test("a marked PR: its merge, Ready for review, auto-merge, approve and its GraphQL get HTTP 403 with the rule's text from the guard, when no client asks for them", async () => {
  const h = await harness();
  try {
    await h.ready();
    const c = await h.connect();
    const { tab } = await page(h, c);
    const answer = pages(h, { "https://github.com/o/r/pull/2": MARKED });
    answer(tab.id, "p1", "https://github.com/o/r/pull/2");
    await until(() => h.relay.model.guard.verdict("github.com/o/r#2") === "marked", "the marked verdict");
    h.fake.emit("tabs.onUpdated", { tabId: tab.id, changeInfo: { url: "https://github.com/o/r/pull/2" }, tab: { ...h.fake.chromeTab(tab), url: "https://github.com/o/r/pull/2" } });
    await sleep(10);
    for (const [id, url, method, more] of MARKED_WRITES) paused(h, tab.id, id, url, method, more);
    await until(() => MARKED_WRITES.every(([id]) => answerOf(h, id)), "the guard's answers");
    for (const [id] of MARKED_WRITES) {
      const r = answerOf(h, id)!;
      assert.deepEqual([r.args[1], r.args[2].responseCode, textOf(r)], ["Fetch.fulfillRequest", 403, GUARD_TEXT.marked], id);
    }
    assert.ok(h.logs.includes("merge guard: refused a write to github.com (POST, tab 7): marked; refused so far: 1"), h.logs.join("\n"));
    assert.equal(h.relay.model.guard.state().counts.marked, MARKED_WRITES.length);
  } finally { await h.close(); }
});

test("a client with Fetch on for every URL gets GitHub's requests after the judge: its continue of a refused write becomes the guard's 403, a change of a GitHub request is refused, and the PR's answer comes after the read", async () => {
  const h = await harness();
  try {
    await h.ready();
    const c = await h.connect();
    const { sessionId, tab } = await page(h, c);
    await c.send("Fetch.enable", { patterns: [{ urlPattern: "*" }, { urlPattern: "*", requestStage: "Response" }] }, sessionId);
    const seen: string[] = [];
    c.on("Fetch.requestPaused", (p) => { seen.push(p.requestId); });
    const answer = pages(h, { "https://github.com/o/r/pull/2": MARKED });
    answer(tab.id, "p1", "https://github.com/o/r/pull/2");
    await until(() => seen.includes("p1"), "the PR's answer at the client");
    assert.equal(h.relay.model.guard.verdict("github.com/o/r#2"), "marked", "read before the client got it");
    assert.ok(h.fake.requests.findIndex((r) => r.args?.[1] === "Fetch.getResponseBody") >= 0);
    assert.equal(await failure(c.send("Fetch.continueRequest", { requestId: "p1", url: "https://github.com/o/r/pull/1" }, sessionId)), GUARD_TEXT.rewrite("github.com"));
    await c.send("Fetch.continueRequest", { requestId: "p1" }, sessionId);
    h.fake.emit("tabs.onUpdated", { tabId: tab.id, changeInfo: { url: "https://github.com/o/r/pull/2" }, tab: { ...h.fake.chromeTab(tab), url: "https://github.com/o/r/pull/2" } });
    await sleep(10);
    for (const [id, url, method, more] of MARKED_WRITES) paused(h, tab.id, id, url, method, more);
    await until(() => MARKED_WRITES.every(([id]) => seen.includes(id)), "the writes at the client");
    for (const [id] of MARKED_WRITES) await c.send("Fetch.continueRequest", { requestId: id }, sessionId);
    for (const [id] of MARKED_WRITES) {
      const r = answerOf(h, id)!;
      assert.deepEqual([r.args[1], r.args[2].responseCode, textOf(r)], ["Fetch.fulfillRequest", 403, GUARD_TEXT.marked], id);
    }
    assert.equal(h.fake.requests.filter((r) => r.op === "debugger.sendCommand" && r.args[1] === "Fetch.continueRequest" && MARKED_WRITES.some(([id]) => id === r.args[2].requestId)).length, 0, "no refused write went on");
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

test("a client cannot act on a request that the guard holds, cannot rewrite a request to GitHub (the guard answers it with a 403 of the text), and its Fetch.disable keeps the guard's Fetch on", async () => {
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
    // The rewrite never reaches Chrome: the guard answers the request itself with a 403 of the text (Playwright drops the error).
    await until(() => answerOf(h, "a1"), "the guard's answer");
    const a1 = h.fake.requests.filter((r) => r.op === "debugger.sendCommand" && r.args[2]?.requestId === "a1");
    assert.deepEqual(a1.map((r) => [r.args[1], r.args[2].responseCode, textOf(r)]), [["Fetch.fulfillRequest", 403, GUARD_TEXT.rewrite("github.com")]]);
    // Fetch.disable: Chrome gets the guard's patterns alone.
    await c.send("Fetch.disable", {}, sessionId);
    assert.deepEqual(h.fake.sent("debugger.sendCommand", "Fetch.enable").at(-1)!.args[2], { patterns: [...h.relay.model.guard.patterns] });
    assert.equal(h.fake.sent("debugger.sendCommand", "Fetch.disable").length, 0);
  } finally { await h.close(); }
});

// review-125 note A: Page.setBypassCSP (enabled true) is refused only while the model has no floor that the receiver
// confirmed on the current link; with the floor it goes to Chrome as before.
const BYPASS = "Not available in the agent browser: Page.setBypassCSP.";
async function bypass(h: Harness, c: CDPConnection, sessionId: string) {
  const before = h.fake.sent("debugger.sendCommand", "Page.setBypassCSP").length;
  const r = await failure(c.send("Page.setBypassCSP", { enabled: true }, sessionId));
  const reached = h.fake.sent("debugger.sendCommand", "Page.setBypassCSP").length > before;
  return { r, reached };
}

test("Page.setBypassCSP with enabled true: refused while bridge.mergeGuard has no answer yet; it goes once the receiver confirmed the floor; enabled false always goes", async () => {
  const h = await harness();
  try {
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    h.fake.op = async ({ op }) => (op === "bridge.mergeGuard" ? gate.then(() => null) : undefined);
    await h.ready();
    assert.equal(h.relay.model.guard.floor, "unknown", "the link up's op has no answer yet; the model is ready");
    const c = await h.connect();
    await c.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    const attached = c.waitForEvent("Target.attachedToTarget");
    void c.send("Target.createTarget", { url: "about:blank" });
    await until(() => h.fake.sent("bridge.mergeGuard").length >= 1, "the op");
    // The tab's session comes after the floor's chain: the session of a page that a client opens while the op has no answer.
    open();
    const { sessionId } = await attached;
    assert.equal(h.relay.model.guard.floor, "on");
    assert.deepEqual(await bypass(h, c, sessionId), { r: "no error", reached: true }, "the floor is confirmed: as before");
    await c.send("Page.setBypassCSP", { enabled: false }, sessionId);
    // A raw page session while the op of the link up has no answer: refused.
    const h2 = await harness();
    try {
      h2.fake.op = async ({ op }) => (op === "bridge.mergeGuard" ? new Promise(() => {}) : undefined);
      await h2.ready();
      const c2 = await h2.connect();
      await c2.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
      const att2 = c2.waitForEvent("Target.attachedToTarget", { timeoutMs: 300 }).catch(() => null);
      void c2.send("Target.createTarget", { url: "about:blank" }).catch(() => {});
      assert.equal(await att2, null, "a new session waits for the floor's chain (the arm sends its op after the link up's op)");
      assert.equal(h2.relay.model.guard.floor, "unknown", "no answer yet: no floor is confirmed (the unit tests show the refusal in this state)");
    } finally { await h2.close(); }
  } finally { await h.close(); }
});

test("Page.setBypassCSP with enabled true: refused with an older receiver (unknown op), after an error of bridge.mergeGuard, and after a link change until the new link's answer", async () => {
  // unknown op
  const old = await harness();
  try {
    old.fake.op = ({ op }) => (op === "bridge.mergeGuard" ? { error: "unknown op" } : undefined);
    await old.ready();
    const c = await old.connect();
    const { sessionId } = await page(old, c);
    assert.equal(old.relay.model.guard.floor, "absent");
    assert.deepEqual(await bypass(old, c, sessionId), { r: BYPASS, reached: false });
  } finally { await old.close(); }
  // an error
  const err = await harness();
  try {
    let fail = false;
    err.fake.op = ({ op }) => (op === "bridge.mergeGuard" && fail ? { error: "timeout" } : undefined);
    await err.ready();
    const c = await err.connect();
    const first = await page(err, c);
    assert.deepEqual(await bypass(err, c, first.sessionId), { r: "no error", reached: true });
    fail = true;
    const second = await page(err, c);
    assert.equal(err.relay.model.guard.floor, "unknown", "an error confirms no floor");
    assert.deepEqual(await bypass(err, c, second.sessionId), { r: BYPASS, reached: false });
  } finally { await err.close(); }
  // a link change: the old link's floor goes; the new link's answer confirms it again
  const lc = await harness();
  try {
    await lc.ready();
    const c = await lc.connect();
    const { sessionId } = await page(lc, c);
    assert.deepEqual(await bypass(lc, c, sessionId), { r: "no error", reached: true });
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    lc.fake.op = async ({ op }) => (op === "bridge.mergeGuard" ? gate.then(() => null) : undefined);
    lc.fake.line({ t: "link", up: false });
    await c.closedPromise;
    assert.equal(lc.relay.model.guard.floor, "unknown", "a link change");
    lc.fake.line({ t: "link", up: true, version: "0.3.1" });
    lc.fake.line({ t: "allowlist", lists: { a: ["a.example"] }, scopes: {}, default: "a" });
    await until(() => lc.fake.sent("bridge.mergeGuard").length >= 3, "the new link's op");
    assert.equal(lc.relay.model.guard.floor, "unknown", "no answer yet on the new link");
    open();
    await until(() => lc.relay.model.notReady() === null, "the new link to be ready");
    const c2 = await lc.connect();
    const p2 = await page(lc, c2);
    assert.equal(lc.relay.model.guard.floor, "on");
    assert.deepEqual(await bypass(lc, c2, p2.sessionId), { r: "no error", reached: true });
  } finally { await lc.close(); }
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

// The lead's focused change (board ab-v16.99): a page's service worker (GitHub registers its own on signed-in pages) could take
// a page's requests away from the tab's session. The model turns the page's service worker off in each tab that it arms.
const SW_TEXT = "Not available in the agent browser: Network.setBypassServiceWorker with bypass false. The merge guard keeps a page's service worker off in each tab that a client holds (the merge guard of pull requests from agentwatch issue triage).";

test("the arm sends Network.setBypassServiceWorker {bypass: true} right after the guard's Fetch.enable (with Network on), before bridge.mergeGuard and before the client has the tab's session", async () => {
  const h = await harness();
  try {
    await h.ready();
    const c = await h.connect();
    const { tab } = await page(h, c);
    const calls = h.fake.requests.filter((r) => (r.op === "debugger.sendCommand" && r.args[0].tabId === tab.id && !r.args[0].sessionId) || (r.op === "bridge.mergeGuard" && r.args[0].tabs.includes(tab.id)));
    assert.deepEqual(calls.slice(0, 4).map((r) => r.op === "bridge.mergeGuard" ? "bridge.mergeGuard" : `${r.args[1]} ${JSON.stringify(r.args[2])}`),
      [`Fetch.enable ${JSON.stringify({ patterns: [...h.relay.model.guard.patterns] })}`, "Network.enable {}", `Network.setBypassServiceWorker ${JSON.stringify({ bypass: true })}`, "bridge.mergeGuard"]);
    assert.equal(h.relay.model.guard.isArmed(tab.id), true);
  } finally { await h.close(); }
});

test("a bypass that fails leaves the tab off, as a failed Fetch.enable does: no bridge.mergeGuard names it, and the floor keeps its writes", async () => {
  const h = await harness();
  try {
    h.fake.command = (_t, method) => (method === "Network.setBypassServiceWorker" ? { error: JSON.stringify({ code: -32000, message: "Not supported" }) } : undefined);
    await h.ready();
    const c = await h.connect();
    const { tab } = await page(h, c);
    assert.equal(h.relay.model.guard.isArmed(tab.id), false);
    assert.ok(!h.fake.sent("bridge.mergeGuard").some((r) => r.args[0].tabs.includes(tab.id)), "the floor keeps the tab");
    assert.ok(h.logs.some((l) => l.includes(`the guard's Fetch or the service worker's bypass did not start in tab ${tab.id}`)), h.logs.join("\n"));
  } finally { await h.close(); }
});

test("a client's Network.setBypassServiceWorker on an armed tab: bypass false is refused with the merge guard's text, bypass true is answered with no change; neither reaches Chrome", async () => {
  const h = await harness();
  try {
    await h.ready();
    const c = await h.connect();
    const { sessionId } = await page(h, c);
    const before = h.fake.sent("debugger.sendCommand").length;
    assert.equal(await failure(c.send("Network.setBypassServiceWorker", { bypass: false }, sessionId)), SW_TEXT);
    assert.deepEqual(await c.send("Network.setBypassServiceWorker", { bypass: true }, sessionId), {});
    assert.equal(h.fake.sent("debugger.sendCommand").length, before, "no call reached Chrome");
  } finally { await h.close(); }
});

test("Network stays on in an armed tab: a client's Network.disable is answered and never reaches Chrome; the tab's Network events go to the client only while it turned Network on; its Network.enable goes to Chrome and the bypass follows", async () => {
  const h = await harness();
  try {
    await h.ready();
    const c = await h.connect();
    const { tab, sessionId } = await page(h, c);
    const got: string[] = [];
    c.on("Network.requestWillBeSent", (p, sid) => { if (sid === sessionId) got.push(p.requestId); });
    const net = (id: string) => h.fake.emit("debugger.onEvent", { source: { tabId: tab.id }, method: "Network.requestWillBeSent", params: { requestId: id, request: { url: "https://a.example/", method: "GET", headers: {} } } });
    const mark = async (id: string) => { await c.send("Runtime.evaluate", { expression: "1" }, sessionId); return id; };
    net("n1"); await mark("n1");
    const before = h.fake.sent("debugger.sendCommand", "Network.setBypassServiceWorker").length;
    assert.deepEqual(await c.send("Network.enable", {}, sessionId), {});
    await until(() => h.fake.sent("debugger.sendCommand", "Network.setBypassServiceWorker").length === before + 1, "the bypass after the client's Network.enable");
    assert.ok(h.fake.sent("debugger.sendCommand", "Network.enable").length === 2, "the guard's and the client's Network.enable reached Chrome");
    net("n2"); await mark("n2");
    const sentBefore = h.fake.sent("debugger.sendCommand").length;
    assert.deepEqual(await c.send("Network.disable", {}, sessionId), {});
    assert.equal(h.fake.sent("debugger.sendCommand").length, sentBefore, "no call reached Chrome for the client's Network.disable");
    net("n3"); await mark("n3");
    await until(() => got.length >= 1, "the event of the client's Network");
    assert.deepEqual(got, ["n2"], "only the event while the client turned Network on");
  } finally { await h.close(); }
});
