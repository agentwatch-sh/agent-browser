// The merge guard's rules (board ab-v16.99; C11, the merge guard; src/relay/merge-guard.ts), with no browser: the PR of a
// URL, the markers, the classes of a write, the judge, the verdicts of GitHub's answers, the clients' Fetch commands, the
// floor's op and the log line. The host github.com and its subdomains are GitHub's; github-standin.localhost is the test
// host of the service's --test mode.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bodyOf, classify, GITHUB_HOSTS, globMatch, GUARD_TEXT, markersIn, MergeGuard, nodeIdsIn, prOf, wanted, type Pr } from "../src/relay/merge-guard.ts";

const H = GITHUB_HOSTS;
const S = "github-standin.localhost";
type Sent = { target: any; method: string; params: any };

/** A guard with recording seams: every CDP send and every floor op, and the log. */
function guard(o: { hosts?: string[]; send?: (s: Sent) => any; op?: (args: unknown[]) => any; now?: () => number } = {}) {
  const sent: Sent[] = [], ops: unknown[][] = [], logs: string[] = [];
  const g = new MergeGuard({
    hosts: o.hosts, log: (l) => logs.push(l), now: o.now,
    send: async (target, method, params) => { const s = { target, method, params }; sent.push(s); return o.send ? o.send(s) : {}; },
    op: async (args) => { ops.push(args); return o.op ? o.op(args) : null; },
  });
  return { g, sent, ops, logs };
}
const pr = (url: string, hosts: readonly string[] = H) => prOf(url, hosts) as Pr;
const MARKED_HTML = `<title>[agentwatch triage] Fix a typo by MarketDataApp · Pull Request #2</title><a href="/o/r/pull/2">#2</a><span class="label">agentwatch-triage</span> wants to merge into staging from agentwatch-triage/issue-7 <input name="pr" value="PR_kwDOtest00000002">`;
const UNMARKED_HTML = `<title>Fix a typo by MarketDataApp · Pull Request #1</title><a href="/o/r/pull/1">#1</a> wants to merge into staging from fix-typo <input value="PR_kwDOtest00000001">`;
const write = (url: string, extra: object = {}) => ({ url, method: "POST", headers: {}, ...extra });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("the PR of a URL: the web's /<owner>/<repo>/pull/<n> and its sub-pages, the API's /repos/.../pulls/<n>, an issue number, on a guarded host only", () => {
  assert.deepEqual(prOf("https://github.com/MarketDataApp/Documentation/pull/12", H), { key: "github.com/marketdataapp/documentation#12", host: "github.com", owner: "MarketDataApp", repo: "Documentation", number: 12, kind: "pull", api: false, rest: null });
  assert.equal(pr("https://github.com/o/r/pull/12/files?w=1#diff").rest, "files");
  assert.equal(pr("https://github.com/o/r/pull/12/merge").rest, "merge");
  assert.equal(pr("https://www.github.com/o/r/pull/12").key, "github.com/o/r#12");
  assert.deepEqual([pr("https://api.github.com/repos/o/r/pulls/12/merge").key, pr("https://api.github.com/repos/o/r/pulls/12/merge").api, pr("https://api.github.com/repos/o/r/pulls/12/merge").rest], ["github.com/o/r#12", true, "merge"]);
  assert.equal(pr("https://api.github.com/repos/o/r/issues/12/labels").kind, "issue");
  assert.equal(pr("https://github.com/o/r/issues/12").kind, "issue");
  for (const u of ["https://github.com/o/r/pull/new/x", "https://github.com/o/r/pulls", "https://github.com/o/r/pull/0", "https://github.com.evil.example/o/r/pull/1", "https://evil.example/o/r/pull/1", "file:///o/r/pull/1", "not a url", "https://api.github.com/o/r/pull/1"]) {
    assert.equal(prOf(u, H), null, u);
  }
  assert.equal(prOf(`http://${S}:8080/o/r/pull/3`, H), null, "the stand-in is no host of production");
  assert.equal(prOf(`http://${S}:8080/o/r/pull/3`, [...H, S])!.key, `${S}/o/r#3`);
});

test("the markers: the label and the head branch (agentwatch-triage), the title prefix ([agentwatch triage]) and the body's line (agentwatch issue triage), also escaped", () => {
  for (const t of ["agentwatch-triage", "[agentwatch triage] Fix", "Opened by agentwatch issue triage for #7.", "AgentWatch-Triage", "agentwatch_triage", "agentwatch%2Dtriage/issue-7",
    "agentwatch%20triage", "agentwatch&#45;triage", "agentwatch&nbsp;triage", "agentwatch\\u002dtriage", "agentwatch  -  triage", "agentwatch&#x2d;triage"]) assert.ok(markersIn(t), t);
  for (const t of ["agentwatch triager", "agentwatch", "triage", "agentwatch/triage", "agentwatchtriage", "agentwatch issue  ", "watch-triage"]) {
    if (t === "agentwatch triager") { assert.ok(markersIn(t), "a longer word still holds the marker: the side the guard fails to is a refusal"); continue; }
    assert.ok(!markersIn(t), t);
  }
  assert.deepEqual(nodeIdsIn(MARKED_HTML), ["PR_kwDOtest00000002"]);
  assert.deepEqual(nodeIdsIn("x MDExOlB1bGxSZXF1ZXN0MTIzNDU2 y PR_short"), ["MDExOlB1bGxSZXF1ZXN0MTIzNDU2"]);
});

test("the classes of a write: a merge-type action of a PR, a merge on no PR, a merge of branches or a write of a ref, a GraphQL endpoint", () => {
  const c = (u: string) => { const x = classify(u, [...H, S]); return { base: x.base, pr: x.pr?.key ?? null, merge: x.merge, refWrite: x.refWrite, graphql: x.graphql }; };
  for (const tail of ["merge", "merge_queue", "auto_merge", "automerge", "ready_for_review", "enqueue", "merge/squash"]) assert.deepEqual(c(`https://github.com/o/r/pull/2/${tail}`), { base: "github.com", pr: "github.com/o/r#2", merge: true, refWrite: false, graphql: false }, tail);
  for (const tail of ["comment", "reviews", "update_branch", "files", ""]) assert.equal(c(`https://github.com/o/r/pull/2/${tail}`).merge, false, tail);
  assert.deepEqual(c("https://github.com/o/r/branches/fetch_and_merge/main"), { base: "github.com", pr: null, merge: true, refWrite: false, graphql: false });
  assert.deepEqual(c("https://api.github.com/repos/o/r/pulls/2/merge"), { base: "github.com", pr: "github.com/o/r#2", merge: true, refWrite: false, graphql: false });
  assert.equal(c("https://api.github.com/repos/o/r/pulls/2/update-branch").merge, false);
  for (const u of ["https://api.github.com/repos/o/r/merges", "https://api.github.com/repos/o/r/git/refs/heads/staging", "https://github.com/o/r.git/git-receive-pack"]) assert.equal(c(u).refWrite, true, u);
  for (const u of ["https://github.com/_graphql", "https://api.github.com/graphql", `http://${S}:9/_graphql`]) assert.equal(c(u).graphql, true, u);
  assert.equal(c("https://example.com/o/r/pull/2/merge").base, null, "no guarded host");
});

test("the request body: postData, the bytes of postDataEntries, none, and null when Chrome did not give it", () => {
  assert.equal(bodyOf({ postData: "a=1" }), "a=1");
  assert.equal(bodyOf({ postDataEntries: [{ bytes: Buffer.from("{\"q\":").toString("base64") }, { bytes: Buffer.from("1}").toString("base64") }] }), "{\"q\":1}");
  assert.equal(bodyOf({}), "");
  assert.equal(bodyOf({ hasPostData: true }), null);
  assert.equal(bodyOf({ postData: "x".repeat((1 << 20) + 1) }), null, "larger than the read limit");
});

test("the judge: a marked or unknown PR page refuses every write; a named marked PR or node id refuses; a ref write is untied; a merge needs a known-unmarked PR", () => {
  const { g } = guard();
  g.learn(pr("https://github.com/o/r/pull/2"), MARKED_HTML, "text/html");
  g.learn(pr("https://github.com/o/r/pull/1"), UNMARKED_HTML, "text/html; charset=utf-8");
  assert.equal(g.verdict("github.com/o/r#2"), "marked");
  assert.equal(g.verdict("github.com/o/r#1"), "unmarked");
  // The page (the tab's top URL, or the Referer).
  g.url(7, "https://github.com/o/r/pull/2");
  assert.equal(g.judge(7, write("https://github.com/o/r/issue_comments")), "marked", "a comment on a marked PR's page");
  assert.equal(g.judge(8, write("https://github.com/_private/browser/stats", { headers: { Referer: "https://github.com/o/r/pull/2/files" } })), "marked", "the Referer names the marked page");
  g.url(9, "https://github.com/o/r/pull/5");
  assert.equal(g.judge(9, write("https://github.com/o/r/pull/5/merge")), "unknown", "a PR page with no verdict");
  g.url(10, "https://github.com/o/r/pull/1");
  assert.equal(g.judge(10, write("https://github.com/o/r/pull/1/merge")), null, "an unmarked PR's merge from its own page goes");
  assert.equal(g.judge(10, write("https://github.com/o/r/pull/1/ready_for_review")), null);
  assert.equal(g.judge(10, write("https://github.com/o/r/pull/2/merge")), "marked", "another, marked PR named from an unmarked page");
  assert.equal(g.judge(10, write("https://github.com/o/r/pull/6/merge")), "unknown", "another PR with no verdict");
  assert.equal(g.judge(10, write("https://github.com/_graphql", { postData: JSON.stringify({ query: "aa11", variables: { input: { pullRequestId: "PR_kwDOtest00000002" } } }) })), "marked", "a marked PR's node id");
  assert.equal(g.judge(10, write("https://github.com/o/r/pull/2/comment?x=PR_kwDOtest00000002")), "marked");
  // From a page that is no PR page.
  g.url(11, "https://github.com/o/r");
  assert.equal(g.judge(11, write("https://github.com/o/r/pull/1/merge")), null, "a known-unmarked PR's merge from another page goes");
  assert.equal(g.judge(11, write("https://api.github.com/repos/o/r/pulls/1/merge", { method: "PUT" })), null);
  assert.equal(g.judge(11, write("https://api.github.com/repos/o/r/pulls/2/merge", { method: "PUT" })), "marked");
  assert.equal(g.judge(11, write("https://api.github.com/repos/o/r/pulls/9/merge", { method: "PUT" })), "unknown");
  assert.equal(g.judge(11, write("https://api.github.com/repos/o/r/issues/2/labels", { method: "DELETE" })), "marked", "the issue number of a marked PR");
  assert.equal(g.judge(11, write("https://github.com/o/r/branches/fetch_and_merge/main")), "unknown", "a merge on no PR from a page that is no PR");
  assert.equal(g.judge(10, write("https://github.com/o/r/branches/fetch_and_merge/main")), null, "a merge on no PR from an unmarked PR's page");
  assert.equal(g.judge(11, write("https://github.com/o/r/pull/3/comment")), null, "a write that is no merge, on a PR with no verdict, from another page goes");
  assert.equal(g.judge(11, write("https://github.com/o/r/star")), null);
  for (const u of ["https://api.github.com/repos/o/r/merges", "https://api.github.com/repos/o/r/git/refs/heads/staging", "https://github.com/o/r.git/git-receive-pack"]) assert.equal(g.judge(10, write(u)), "untied", u);
  // GraphQL.
  const gql = (q: string) => write("https://api.github.com/graphql", { postData: JSON.stringify({ query: q, variables: { id: "PR_kwDOother0000009" } }) });
  assert.equal(g.judge(11, gql("mutation { mergePullRequest(input: {pullRequestId: $id}) { clientMutationId } }")), "unknown");
  assert.equal(g.judge(11, gql("mutation { enablePullRequestAutoMerge(input: {}) { x } }")), "unknown");
  assert.equal(g.judge(11, gql("mutation { markPullRequestReadyForReview(input: {}) { x } }")), "unknown");
  assert.equal(g.judge(11, gql("mutation { enqueuePullRequest(input: {}) { x } }")), "unknown");
  assert.equal(g.judge(11, write("https://github.com/_graphql", { postData: JSON.stringify({ query: "0a1b2c", variables: { input: { mergeMethod: "SQUASH" } } }) })), "unknown", "a persisted query with a merge's method");
  assert.equal(g.judge(10, gql("mutation { mergePullRequest(input: {}) { x } }")), null, "from an unmarked PR's page");
  assert.equal(g.judge(10, gql("mutation { mergeBranch(input: {}) { x } }")), "untied");
  assert.equal(g.judge(10, gql("mutation { updateRefs(input: {}) { x } }")), "untied");
  assert.equal(g.judge(11, write("https://github.com/_graphql", { hasPostData: true })), "untied", "a GraphQL body that Chrome did not give");
  assert.equal(g.judge(11, gql("mutation { addStar(input: {}) { x } }")), null, "a GraphQL write that is no merge");
});

test("the verdicts: any 2xx answer of a PR's URL with a marker marks it for good; only the PR's own page (HTML) or its API object says unmarked", () => {
  const { g } = guard({ hosts: [S] });
  g.learn(pr("https://github.com/o/r/pull/3/page_data/merge_box"), "{\"title\":\"[agentwatch triage] x\"}", "application/json");
  assert.equal(g.verdict("github.com/o/r#3"), "marked", "a JSON part of a PR's page marks");
  g.learn(pr("https://github.com/o/r/pull/3"), UNMARKED_HTML.replaceAll("/pull/1", "/pull/3"), "text/html");
  assert.equal(g.verdict("github.com/o/r#3"), "marked", "a marked PR stays marked");
  g.learn(pr("https://github.com/o/r/pull/4/page_data/merge_box"), "{\"title\":\"x\"}", "application/json");
  assert.equal(g.verdict("github.com/o/r#4"), undefined, "a part of a page with no marker says nothing");
  g.learn(pr("https://github.com/o/r/pull/4"), "<html>Sign in</html>", "text/html");
  assert.equal(g.verdict("github.com/o/r#4"), undefined, "an HTML page that does not name the PR says nothing");
  g.learn(pr("https://github.com/o/r/pull/4/files"), "<a href=\"/o/r/pull/4\">", "text/html");
  assert.equal(g.verdict("github.com/o/r#4"), "unmarked");
  g.learn(pr("https://api.github.com/repos/o/r/pulls/5"), "{\"number\": 5, \"title\": \"x\", \"labels\": []}", "application/json; charset=utf-8");
  assert.equal(g.verdict("github.com/o/r#5"), "unmarked");
  g.learn(pr("https://api.github.com/repos/o/r/issues/6"), "{\"number\": 6, \"title\": \"x\"}", "application/json");
  assert.equal(g.verdict("github.com/o/r#6"), undefined, "an issue's object has no head branch: no unmarked verdict");
  g.learn(pr(`http://${S}:8080/o/r/pull/3`, [...H, S]), MARKED_HTML, "text/html");
  assert.equal(g.verdict(`${S}/o/r#3`), "marked");
  assert.equal(g.verdict("github.com/o/r#2"), undefined, "a stand-in page marks only its own host's PR, never GitHub's");
});

test("CDP's urlPattern and a client's patterns: the URL, the resource type and the stage", () => {
  assert.ok(globMatch("*", "https://a.example/"));
  assert.ok(globMatch("*://a.example/*", "https://a.example/x"));
  assert.ok(!globMatch("*://a.example/*", "https://b.example/x"));
  assert.ok(globMatch("https://a.example/?", "https://a.example/x"));
  assert.ok(!globMatch("https://a.example/?", "https://a.example/xy"));
  assert.ok(globMatch("https://a.example/\\*", "https://a.example/*"));
  assert.ok(!globMatch("https://a.example/\\*", "https://a.example/x"));
  assert.ok(globMatch("*a.example/(x)+.y*", "https://a.example/(x)+.y?z"));
  const p = { request: { url: "https://a.example/x" }, resourceType: "XHR" };
  assert.ok(wanted([{ urlPattern: "*" }], p));
  assert.ok(!wanted([{ urlPattern: "*", requestStage: "Response" }], p));
  assert.ok(wanted([{ urlPattern: "*", requestStage: "Response" }], { ...p, responseStatusCode: 200 }));
  assert.ok(!wanted([{ urlPattern: "*", resourceType: "Document" }], p));
  assert.ok(wanted([{ resourceType: "XHR" }], p));
});

test("a request of a guarded host is the guard's: a write is judged and refused with HTTP 403 and the rule's text; a GET goes; a PR's answer is read", async () => {
  const { g, sent, logs } = guard({ send: (s) => (s.method === "Fetch.getResponseBody" ? { body: Buffer.from(MARKED_HTML).toString("base64"), base64Encoded: true } : {}) });
  assert.equal(await g.arm(7), true);
  assert.equal(g.paused(7, undefined, "Fetch.requestPaused", { requestId: "r1", request: { url: "https://github.com/o/r/pull/2", method: "GET", headers: {} }, resourceType: "Document", frameId: "T7" }, { owner: true, topFrame: "T7" }), true);
  await sleep(5);
  assert.deepEqual(sent.at(-1), { target: { tabId: 7 }, method: "Fetch.continueRequest", params: { requestId: "r1" } });
  g.paused(7, undefined, "Fetch.requestPaused", { requestId: "r1", request: { url: "https://github.com/o/r/pull/2", method: "GET", headers: {} }, resourceType: "Document", frameId: "T7", responseStatusCode: 200, responseHeaders: [{ name: "Content-Type", value: "text/html" }] }, { owner: true, topFrame: "T7" });
  await sleep(5);
  assert.deepEqual(sent.slice(-2).map((s) => s.method), ["Fetch.getResponseBody", "Fetch.continueRequest"]);
  assert.equal(g.verdict("github.com/o/r#2"), "marked");
  // A form's POST (a document) and a fetch (with its Origin): 403, and the text.
  g.paused(7, undefined, "Fetch.requestPaused", { requestId: "r2", request: { url: "https://github.com/o/r/pull/2/merge", method: "POST", headers: {} }, resourceType: "Document", frameId: "T7" }, { owner: true, topFrame: "T7" });
  g.paused(7, "W1", "Fetch.requestPaused", { requestId: "r3", request: { url: "https://api.github.com/repos/o/r/pulls/2/merge", method: "PUT", headers: { Origin: "https://github.com" } }, resourceType: "Fetch" }, { owner: true, topFrame: "T7" });
  await sleep(5);
  const [doc, api] = sent.filter((s) => s.method === "Fetch.fulfillRequest");
  assert.deepEqual([doc.target, doc.params.requestId, doc.params.responseCode, Buffer.from(doc.params.body, "base64").toString()], [{ tabId: 7 }, "r2", 403, GUARD_TEXT.marked]);
  assert.deepEqual(doc.params.responseHeaders, [{ name: "Content-Type", value: "text/plain; charset=utf-8" }, { name: "Cache-Control", value: "no-store" }]);
  assert.deepEqual([api.target, JSON.parse(Buffer.from(api.params.body, "base64").toString())], [{ tabId: 7, sessionId: "W1" }, { message: GUARD_TEXT.marked, errors: [{ type: "FORBIDDEN", message: GUARD_TEXT.marked }] }]);
  assert.ok(api.params.responseHeaders.some((h: any) => h.name === "Access-Control-Allow-Origin" && h.value === "https://github.com"));
  assert.deepEqual(g.state().counts, { writes: 2, refused: 2, marked: 2, unknown: 0, untied: 0, clientRefused: 0, reads: 1, readFailed: 0 });
  // One log line for the reason and host in 5 minutes: a method, a host, a tab, the reason and the count; no path, no query.
  assert.deepEqual(logs, ["merge guard: refused a write to github.com (POST, tab 7): marked; refused so far: 1"]);
  assert.ok(!logs.some((l) => /\/o\/r|pull|repos/.test(l)));
  // A fulfill that fails falls back to a failed request.
  const f = guard({ send: (s) => { if (s.method === "Fetch.fulfillRequest") throw new Error("x"); return {}; } });
  await f.g.arm(3);
  f.g.url(3, "https://github.com/o/r/pull/8");
  f.g.paused(3, undefined, "Fetch.requestPaused", { requestId: "q", request: { url: "https://github.com/o/r/pull/8/merge", method: "POST" }, resourceType: "XHR" }, { owner: true, topFrame: "T3" });
  await sleep(5);
  assert.deepEqual(f.sent.at(-1), { target: { tabId: 3 }, method: "Fetch.failRequest", params: { requestId: "q", errorReason: "BlockedByClient" } });
});

test("no client gets a request of a guarded host; on an armed session a pause goes to the client only when one of its patterns asks for it", async () => {
  const { g, sent } = guard();
  await g.arm(7);
  const req = (id: string, url: string, more: object = {}) => ({ requestId: id, request: { url, method: "GET", headers: {} }, resourceType: "XHR", ...more });
  assert.equal(g.paused(7, undefined, "Fetch.requestPaused", req("a", "https://a.example/"), { owner: true, topFrame: "T7" }), true, "no client Fetch: the guard lets it go");
  g.command(7, undefined, "Fetch.enable", { patterns: [{ urlPattern: "*a.example*" }] });
  assert.equal(g.paused(7, undefined, "Fetch.requestPaused", req("b", "https://a.example/"), { owner: true, topFrame: "T7" }), false, "the client asked for it");
  assert.equal(g.paused(7, undefined, "Fetch.requestPaused", req("c", "https://github.community/"), { owner: true, topFrame: "T7" }), true, "a pause of the guard's own pattern that the client did not ask for");
  assert.equal(g.paused(7, undefined, "Fetch.requestPaused", req("d", "https://a.example/"), { owner: false, topFrame: "T7" }), true, "a tab with no owner");
  assert.equal(g.paused(7, undefined, "Fetch.requestPaused", req("e", "https://api.github.com/user"), { owner: true, topFrame: "T7" }), true);
  assert.equal(g.paused(7, undefined, "Fetch.authRequired", req("f", "https://github.com/"), { owner: true, topFrame: "T7" }), true);
  assert.equal(g.paused(7, undefined, "Fetch.authRequired", req("g", "https://a.example/"), { owner: true, topFrame: "T7" }), true, "no handleAuthRequests");
  await sleep(5);
  assert.deepEqual(sent.filter((s) => s.method === "Fetch.continueWithAuth").map((s) => s.params.authChallengeResponse.response), ["CancelAuth", "Default"]);
  // A session that the guard did not arm (a child that came with no armed tab): every pause of another host is the client's.
  assert.equal(g.paused(9, "C1", "Fetch.requestPaused", req("h", "https://a.example/"), { owner: true, topFrame: null }), false);
  assert.equal(g.paused(9, "C1", "Fetch.requestPaused", req("i", "https://github.com/o/r"), { owner: true, topFrame: null }), true, "but never one of a guarded host");
});

test("a client's Fetch commands: its patterns join the guard's, its disable keeps the guard's and lets its paused requests go, a held request and a rewrite to GitHub are refused", async () => {
  const { g, sent } = guard({ send: (s) => (s.method === "Fetch.getResponseBody" ? new Promise(() => {}) : {}) });
  await g.arm(7);
  const mine = [{ urlPattern: "*b.example*" }];
  assert.deepEqual(g.command(7, undefined, "Fetch.enable", { patterns: mine, handleAuthRequests: true }), { method: "Fetch.enable", params: { patterns: [...g.patterns, ...mine], handleAuthRequests: true } });
  assert.deepEqual(g.command(9, undefined, "Fetch.enable", { patterns: mine }), { method: "Fetch.enable", params: { patterns: mine } }, "an unarmed tab: as it is");
  g.paused(7, undefined, "Fetch.requestPaused", { requestId: "k1", request: { url: "https://b.example/", method: "GET" }, resourceType: "XHR" }, { owner: true, topFrame: "T7" });
  const off = g.command(7, undefined, "Fetch.disable", {});
  assert.ok("method" in off && off.method === "Fetch.enable" && JSON.stringify(off.params) === JSON.stringify({ patterns: g.patterns }));
  (off as any).after();
  await sleep(5);
  assert.deepEqual(sent.at(-1), { target: { tabId: 7 }, method: "Fetch.continueRequest", params: { requestId: "k1" } });
  // A request of a guarded host that the guard holds (it reads the PR's answer): no client command acts on it.
  g.paused(7, undefined, "Fetch.requestPaused", { requestId: "h1", request: { url: "https://github.com/o/r/pull/2", method: "GET" }, resourceType: "Document", responseStatusCode: 200 }, { owner: true, topFrame: "T7" });
  for (const m of ["Fetch.continueRequest", "Fetch.fulfillRequest", "Fetch.failRequest", "Fetch.getResponseBody", "Fetch.continueResponse"]) assert.deepEqual(g.command(7, undefined, m, { requestId: "h1" }), { refuse: GUARD_TEXT.badId }, m);
  assert.deepEqual(g.command(7, undefined, "Fetch.continueRequest", { requestId: "x9", url: "https://api.github.com/repos/o/r/pulls/2/merge", method: "PUT" }), { refuse: GUARD_TEXT.rewrite("github.com") });
  assert.deepEqual(g.command(7, "C1", "Fetch.continueRequest", { requestId: "x9", url: "https://a.example/" }), { method: "Fetch.continueRequest", params: { requestId: "x9", url: "https://a.example/" } });
  assert.equal(g.state().counts.clientRefused, 6);
});

test("the floor: each arm sends bridge.mergeGuard with the hosts and every armed tab; an older receiver (unknown op) has none, said once; a failed Fetch leaves a tab off", async () => {
  const { g, ops } = guard({ hosts: [S] });
  await g.linkUp();
  await g.arm(7); await g.arm(7); await g.arm(4);
  g.armChild(7, "W1");
  assert.deepEqual(ops, [[{ hosts: ["github.com", S], tabs: [] }], [{ hosts: ["github.com", S], tabs: [7] }], [{ hosts: ["github.com", S], tabs: [4, 7] }]]);
  assert.equal(g.floor, "on");
  assert.deepEqual(g.state().armed, ["4|", "7|", "7|W1"]);
  g.disarm(7);
  assert.deepEqual(g.state().armed, ["4|"]);
  const old = guard({ op: () => { throw new Error("unknown op"); } });
  await old.g.linkUp(); await old.g.arm(1); await old.g.arm(2);
  assert.equal(old.g.floor, "absent");
  assert.equal(old.ops.length, 1, "no op after unknown op until the next link up");
  assert.deepEqual(old.logs, ["merge guard: the receiver has no floor (bridge.mergeGuard: unknown op): only the tabs that a client holds are guarded"]);
  const bad = guard({ send: () => { throw new Error("No tab with given id 5"); } });
  assert.equal(await bad.g.arm(5), false);
  assert.equal(bad.g.isArmed(5), false);
  assert.deepEqual(bad.ops, [], "a tab that is not armed is never left to layer 1");
  assert.ok(bad.logs[0].includes("the receiver's floor keeps blocking its writes to GitHub"));
});

test("an event too large for the link fails on a page of a guarded host of an armed tab, else it goes as before", async () => {
  const { g } = guard();
  await g.arm(7);
  assert.equal(g.tooLarge(7), false, "no page yet");
  g.url(7, "https://github.com/o/r/pull/2");
  assert.equal(g.tooLarge(7), true);
  g.url(7, "https://a.example/");
  assert.equal(g.tooLarge(7), false);
  g.url(8, "https://github.com/");
  assert.equal(g.tooLarge(8), false, "not armed");
});
