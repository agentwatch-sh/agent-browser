// The merge guard's rules (board ab-v16.99; C11, the merge guard; src/relay/merge-guard.ts), with no browser: the PR of a
// URL, the markers, the classes of a write, the judge, the verdicts of GitHub's answers, the clients' Fetch commands, the
// floor's op and the log line. The host github.com and its subdomains are GitHub's; github-standin.localhost is the test
// host of the service's --test mode.
import { test } from "node:test";
import assert from "node:assert/strict";
import { refusal, route } from "../src/relay/policy.ts";
import { ARM_LIMIT_MS, bodyOf, classify, formsIn, GITHUB_HOSTS, globMatch, GUARD_NETWORK, GUARD_TEXT, MARKER_FORMS, markersIn, MergeGuard, nodeIdsIn, prOf, refusalOf, TRIAGE_MARKER, wanted, type Pr } from "../src/relay/merge-guard.ts";

const H = GITHUB_HOSTS;
const S = "github-standin.localhost";
type Sent = { target: any; method: string; params: any };

/** A guard with recording seams: every CDP send and every floor op, and the log. */
function guard(o: { hosts?: string[]; send?: (s: Sent) => any; op?: (args: unknown[]) => any; now?: () => number; armLimitMs?: number } = {}) {
  const sent: Sent[] = [], ops: unknown[][] = [], logs: string[] = [];
  const g = new MergeGuard({
    hosts: o.hosts, log: (l) => logs.push(l), now: o.now, armLimitMs: o.armLimitMs,
    send: async (target, method, params) => { const s = { target, method, params }; sent.push(s); return o.send ? o.send(s) : {}; },
    op: async (args) => { ops.push(args); return o.op ? o.op(args) : null; },
  });
  return { g, sent, ops, logs };
}
const pr = (url: string, hosts: readonly string[] = H) => prOf(url, hosts) as Pr;
const MARKED_HTML = `<title>[agentwatch triage] Fix a typo by MarketDataApp · Pull Request #2</title><a href="/o/r/pull/2">#2</a><a href="/o/r/labels/agentwatch-triage" data-name="agentwatch-triage">agentwatch-triage</a> wants to merge into staging from agentwatch-triage/issue-7 <input name="pr" value="PR_kwDOtest00000002">`;
const UNMARKED_HTML = `<title>Fix a typo by MarketDataApp · Pull Request #1</title><a href="/o/r/pull/1">#1</a> wants to merge into staging from fix-typo; the triage team reviews it <a href="/o/r/labels/needs-triage">needs-triage</a> <input value="PR_kwDOtest00000001">`;
/** A page that shows one form of the marker, and nothing else of it. */
const pageWith = (form: string) => `<html><title>Fix a typo · Pull Request #4</title><a href="/o/r/pull/4">#4</a> wants to merge into staging from fix-typo ${form}</html>`;
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

test("the marker is one definition with both forms: the labels agentwatch-triage and triage, the title prefixes [agentwatch triage] and [triage], the head branch prefix agentwatch-triage/", () => {
  assert.deepEqual(TRIAGE_MARKER, { labels: ["agentwatch-triage", "triage"], titlePrefixes: ["[agentwatch triage]", "[triage]"], headBranchPrefix: "agentwatch-triage/" });
  assert.deepEqual(Object.keys(MARKER_FORMS), ["label agentwatch-triage", "label triage", "title [agentwatch triage]", "title [triage]", "head agentwatch-triage/"]);
  assert.ok(Object.isFrozen(TRIAGE_MARKER) && Object.isFrozen(TRIAGE_MARKER.labels) && Object.isFrozen(TRIAGE_MARKER.titlePrefixes));
  assert.ok(!markersIn(UNMARKED_HTML), "an unmarked PR's page: the word triage and the label needs-triage are no marker");
});

test("the marker's form: the label agentwatch-triage (its link, data-name, JSON name or a search's label:), compared without case", () => {
  for (const t of ['<a href="/o/r/labels/agentwatch-triage">', 'data-name="Agentwatch-Triage"', '{"name": "AGENTWATCH-TRIAGE", "color": "ededed"}', "label:agentwatch-triage+is", "label%3A%22agentwatch-triage%22", "/labels/agentwatch%2Dtriage\""]) {
    assert.deepEqual(formsIn(pageWith(t)), ["label agentwatch-triage"], t);
  }
  for (const t of ["/labels/agentwatch-triage-old", '"name":"agentwatch-triaged"']) assert.deepEqual(formsIn(pageWith(t)), [], t);
});

test("the marker's form: the label triage (the manager's bare form), compared without case, and only as a label's name", () => {
  for (const t of ['<a href="/o/r/labels/triage" class="IssueLabel">', "data-name='Triage'", '"labels":[{"name":"triage"}]', "is%3Apr+label%3Atriage"]) assert.deepEqual(formsIn(pageWith(t)), ["label triage"], t);
  for (const t of ["the triage team", "/labels/triaged", "/labels/needs-triage", '"name":"triage-later"', "Triage", '"permission":"TRIAGE"']) assert.deepEqual(formsIn(pageWith(t)), [], t);
});

test("the marker's form: a title that starts with [agentwatch triage] (no trailing space needed), in the page's title, an element's text, a title attribute or a JSON title", () => {
  for (const t of ["<title>[agentwatch triage]Fix", '<bdi class="js-issue-title">[Agentwatch Triage] Fix</bdi>', '"title": "[agentwatch triage] Fix"', 'title="[agentwatch&nbsp;triage] Fix"', "<h1>\n  [agentwatch  triage] x"]) {
    assert.ok(formsIn(t).includes("title [agentwatch triage]"), t);
  }
  assert.deepEqual(formsIn("<p>Fix [agentwatch triage] later</p>"), [], "a prefix in the middle of a text is no title's start");
});

test("the marker's form: a title that starts with [triage] (the manager's bare form)", () => {
  for (const t of ["<title>[triage] Fix a typo", "<bdi>[TRIAGE] x</bdi>", '"title":"[triage]x"', "title='[triage] x'"]) assert.deepEqual(formsIn(t), ["title [triage]"], t);
  for (const t of ["<p>see [triage]</p>", "<title>[triaged] x", "<title>[triage-x] y"]) assert.deepEqual(formsIn(t), [], t);
});

test("the marker's form: a head branch that starts with agentwatch-triage/ (an extra sign), also escaped in a URL or JSON", () => {
  for (const t of ["from agentwatch-triage/issue-7", "/tree/agentwatch-triage%2Fissue-7", '"headRefName":"agentwatch-triage\\/issue-7"', "AgentWatch-Triage/issue-1"]) {
    assert.ok(formsIn(pageWith(t)).includes("head agentwatch-triage/"), t);
  }
  assert.ok(!formsIn(pageWith("from agentwatch-triage-x")).includes("head agentwatch-triage/"));
  assert.deepEqual(nodeIdsIn(MARKED_HTML), ["PR_kwDOtest00000002"]);
  assert.deepEqual(nodeIdsIn("x MDExOlB1bGxSZXF1ZXN0MTIzNDU2 y PR_short"), ["MDExOlB1bGxSZXF1ZXN0MTIzNDU2"]);
});

test("the classes of a write: a merge-type action of a PR, a merge on no PR, a merge of branches or a write of a ref, a GraphQL endpoint", () => {
  const c = (u: string) => { const x = classify(u, [...H, S]); return { base: x.base, pr: x.pr?.key ?? null, merge: x.merge, refWrite: x.refWrite, graphql: x.graphql }; };
  for (const tail of ["merge", "merge_queue", "auto_merge", "automerge", "ready_for_review", "enqueue", "merge/squash", "reviews", "reviews/7/events"]) assert.deepEqual(c(`https://github.com/o/r/pull/2/${tail}`), { base: "github.com", pr: "github.com/o/r#2", merge: true, refWrite: false, graphql: false }, tail);
  for (const tail of ["comment", "update_branch", "files", ""]) assert.equal(c(`https://github.com/o/r/pull/2/${tail}`).merge, false, tail);
  assert.deepEqual(c("https://github.com/o/r/branches/fetch_and_merge/main"), { base: "github.com", pr: null, merge: true, refWrite: false, graphql: false });
  assert.deepEqual(c("https://api.github.com/repos/o/r/pulls/2/merge"), { base: "github.com", pr: "github.com/o/r#2", merge: true, refWrite: false, graphql: false });
  assert.equal(c("https://api.github.com/repos/o/r/pulls/2/reviews").merge, true, "an approve on the API");
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
  assert.equal(g.judge(9, write("https://github.com/o/r/issue_comments")), "unknown", "any write from a PR page with no verdict, also one that is no merge");
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
  // An approve (a review): as a merge-type action.
  assert.equal(g.judge(10, write("https://github.com/o/r/pull/1/reviews", { postData: "pull_request_review[event]=approve" })), null, "an unmarked PR's approve from its own page goes");
  assert.equal(g.judge(11, write("https://github.com/o/r/pull/9/reviews")), "unknown", "an approve of a PR with no verdict");
  assert.equal(g.judge(11, write("https://api.github.com/repos/o/r/pulls/2/reviews", { postData: "{\"event\":\"APPROVE\"}" })), "marked");
  assert.equal(g.judge(11, write("https://api.github.com/repos/o/r/pulls/9/reviews")), "unknown");
  assert.equal(g.judge(11, write("https://github.com/o/r/star")), null);
  for (const u of ["https://api.github.com/repos/o/r/merges", "https://api.github.com/repos/o/r/git/refs/heads/staging", "https://github.com/o/r.git/git-receive-pack"]) assert.equal(g.judge(10, write(u)), "untied", u);
  // GraphQL.
  const gql = (q: string) => write("https://api.github.com/graphql", { postData: JSON.stringify({ query: q, variables: { id: "PR_kwDOother0000009" } }) });
  assert.equal(g.judge(11, gql("mutation { mergePullRequest(input: {pullRequestId: $id}) { clientMutationId } }")), "unknown");
  assert.equal(g.judge(11, gql("mutation { enablePullRequestAutoMerge(input: {}) { x } }")), "unknown");
  assert.equal(g.judge(11, gql("mutation { markPullRequestReadyForReview(input: {}) { x } }")), "unknown");
  assert.equal(g.judge(11, gql("mutation { enqueuePullRequest(input: {}) { x } }")), "unknown");
  assert.equal(g.judge(11, gql("mutation { addPullRequestReview(input: {event: APPROVE}) { x } }")), "unknown", "an approve by GraphQL");
  assert.equal(g.judge(11, gql("mutation { submitPullRequestReview(input: {}) { x } }")), "unknown");
  assert.equal(g.judge(11, write("https://github.com/_graphql", { postData: JSON.stringify({ query: "9f8e7d", variables: { event: "APPROVE" } }) })), "unknown", "a persisted query with an approve's value");
  assert.equal(g.judge(11, write("https://github.com/_graphql", { postData: JSON.stringify({ query: "0a1b2c", variables: { input: { mergeMethod: "SQUASH" } } }) })), "unknown", "a persisted query with a merge's method");
  assert.equal(g.judge(10, gql("mutation { mergePullRequest(input: {}) { x } }")), null, "from an unmarked PR's page");
  assert.equal(g.judge(10, gql("mutation { mergeBranch(input: {}) { x } }")), "untied");
  assert.equal(g.judge(10, gql("mutation { updateRefs(input: {}) { x } }")), "untied");
  assert.equal(g.judge(11, write("https://github.com/_graphql", { hasPostData: true })), "untied", "a GraphQL body that Chrome did not give");
  assert.equal(g.judge(11, gql("mutation { addStar(input: {}) { x } }")), null, "a GraphQL write that is no merge");
});

test("the verdicts: any 2xx answer of a PR's URL with a marker marks it for good; only the PR's own page (HTML) or its API object says unmarked", () => {
  const { g } = guard({ hosts: [S] });
  g.learn(pr("https://github.com/o/r/pull/3/page_data/merge_box"), "{\"title\":\"[triage] x\"}", "application/json");
  assert.equal(g.verdict("github.com/o/r#3"), "marked", "a JSON part of a PR's page marks");
  g.learn(pr("https://github.com/o/r/pull/3"), UNMARKED_HTML.replaceAll("/pull/1", "/pull/3"), "text/html");
  assert.equal(g.verdict("github.com/o/r#3"), "marked", "a marked PR stays marked");
  g.learn(pr("https://api.github.com/repos/o/r/pulls/3"), "{\"number\": 3, \"title\": \"x\", \"labels\": []}", "application/json");
  assert.equal(g.verdict("github.com/o/r#3"), "marked", "also after an API object with no marker");
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

/** The model's delivery seam: what the owner got, and whether it takes it. */
const owner = (takes = true) => { const got: string[] = []; return { got, forward: (id: string) => () => { got.push(id); return takes; } }; };
const P = (id: string, url: string, method = "GET", more: object = {}) => ({ requestId: id, request: { url, method, headers: {} }, resourceType: "XHR", ...more });

test("a request of a guarded host: a write is judged and refused with HTTP 403 and the rule's text; a GET goes; a PR's answer is read", async () => {
  const { g, sent, logs } = guard({ send: (s) => (s.method === "Fetch.getResponseBody" ? { body: Buffer.from(MARKED_HTML).toString("base64"), base64Encoded: true } : {}) });
  const o = owner(false);
  assert.equal(await g.arm(7), true);
  g.paused(7, undefined, "Fetch.requestPaused", P("r1", "https://github.com/o/r/pull/2", "GET", { resourceType: "Document", frameId: "T7" }), { topFrame: "T7", forward: o.forward("r1") });
  await sleep(5);
  assert.deepEqual(sent.at(-1), { target: { tabId: 7 }, method: "Fetch.continueRequest", params: { requestId: "r1" } });
  g.paused(7, undefined, "Fetch.requestPaused", P("r1", "https://github.com/o/r/pull/2", "GET", { resourceType: "Document", frameId: "T7", responseStatusCode: 200, responseHeaders: [{ name: "Content-Type", value: "text/html" }] }), { topFrame: "T7", forward: o.forward("r1") });
  await sleep(5);
  assert.deepEqual(sent.slice(-2).map((s) => s.method), ["Fetch.getResponseBody", "Fetch.continueRequest"]);
  assert.equal(g.verdict("github.com/o/r#2"), "marked");
  // A form's POST (a document) and a fetch (with its Origin): 403, and the text.
  g.paused(7, undefined, "Fetch.requestPaused", P("r2", "https://github.com/o/r/pull/2/merge", "POST", { resourceType: "Document", frameId: "T7" }), { topFrame: "T7", forward: o.forward("r2") });
  g.paused(7, "W1", "Fetch.requestPaused", { ...P("r3", "https://api.github.com/repos/o/r/pulls/2/merge", "PUT"), request: { url: "https://api.github.com/repos/o/r/pulls/2/merge", method: "PUT", headers: { Origin: "https://github.com" } }, resourceType: "Fetch" }, { topFrame: "T7", forward: o.forward("r3") });
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
  f.g.paused(3, undefined, "Fetch.requestPaused", P("q", "https://github.com/o/r/pull/8/merge", "POST"), { topFrame: "T3", forward: () => false });
  await sleep(5);
  assert.deepEqual(f.sent.at(-1), { target: { tabId: 3 }, method: "Fetch.failRequest", params: { requestId: "q", errorReason: "BlockedByClient" } });
});

test("a client gets a request of a guarded host only after the judge and the read, and only when its own patterns ask for it; any other pause as before", async () => {
  const { g, sent } = guard({ send: (s) => (s.method === "Fetch.getResponseBody" ? { body: Buffer.from(UNMARKED_HTML).toString("base64"), base64Encoded: true } : {}) });
  await g.arm(7);
  const o = owner();
  g.paused(7, undefined, "Fetch.requestPaused", P("a", "https://a.example/"), { topFrame: "T7", forward: o.forward("a") });
  g.command(7, undefined, "Fetch.enable", { patterns: [{ urlPattern: "*" }, { urlPattern: "*", requestStage: "Response" }] });
  g.paused(7, undefined, "Fetch.requestPaused", P("b", "https://a.example/"), { topFrame: "T7", forward: o.forward("b") });
  g.paused(7, undefined, "Fetch.requestPaused", P("c", "https://github.com/o/r/pull/1", "GET", { responseStatusCode: 200, responseHeaders: [{ name: "content-type", value: "text/html" }] }), { topFrame: "T7", forward: o.forward("c") });
  assert.deepEqual(o.got, ["b"], "the read comes before the client");
  await sleep(5);
  assert.deepEqual(o.got, ["b", "c"]);
  assert.equal(g.verdict("github.com/o/r#1"), "unmarked");
  g.paused(7, undefined, "Fetch.requestPaused", P("d", "https://github.com/o/r/pull/1/merge", "POST"), { topFrame: "T7", forward: o.forward("d") });
  await sleep(5);
  assert.deepEqual(o.got, ["b", "c", "d"], "an unmarked PR's merge, after the judge");
  // No owner takes it: it goes on.
  g.paused(7, undefined, "Fetch.requestPaused", P("e", "https://a.example/"), { topFrame: "T7", forward: () => false });
  g.paused(7, undefined, "Fetch.authRequired", P("f", "https://github.com/"), { topFrame: "T7", forward: o.forward("f") });
  g.paused(7, undefined, "Fetch.authRequired", P("g", "https://a.example/"), { topFrame: "T7", forward: o.forward("g") });
  await sleep(5);
  assert.deepEqual(sent.filter((s) => s.method === "Fetch.continueWithAuth").map((s) => s.params.authChallengeResponse.response), ["CancelAuth", "Default"], "no handleAuthRequests");
  assert.ok(sent.some((s) => s.method === "Fetch.continueRequest" && s.params.requestId === "a") && sent.some((s) => s.method === "Fetch.continueRequest" && s.params.requestId === "e"));
  // A pause of the guard's own pattern that the client's patterns do not ask for (a host that starts with github.com).
  g.command(7, undefined, "Fetch.enable", { patterns: [{ urlPattern: "*b.example*" }] });
  g.paused(7, undefined, "Fetch.requestPaused", P("h", "https://github.community/"), { topFrame: "T7", forward: o.forward("h") });
  assert.ok(!o.got.includes("h"));
  // A session that the guard did not arm: every pause of another host is the client's.
  g.paused(9, "C1", "Fetch.requestPaused", P("i", "https://a.example/"), { topFrame: null, forward: o.forward("i") });
  assert.ok(o.got.includes("i"));
});

test("a client's Fetch commands: its patterns join the guard's; its disable keeps the guard's on and lets its requests go; a held request, a change of a GitHub request and a rewrite to GitHub are refused; a refused write's continue becomes the 403", async () => {
  let read: (v: unknown) => void = () => {};
  const { g, sent } = guard({ send: (s) => (s.method === "Fetch.getResponseBody" ? new Promise((r) => { read = r; }) : {}) });
  await g.arm(7);
  const mine = [{ urlPattern: "*" }, { urlPattern: "*", requestStage: "Response" as const }];
  assert.deepEqual(g.command(7, undefined, "Fetch.enable", { patterns: mine, handleAuthRequests: true }), { method: "Fetch.enable", params: { patterns: [...g.patterns, ...mine], handleAuthRequests: true } });
  assert.deepEqual(g.command(9, undefined, "Fetch.enable", { patterns: mine }), { method: "Fetch.enable", params: { patterns: mine } }, "an unarmed tab: as it is");
  const o = owner();
  // Held: the guard reads a PR's answer.
  g.paused(7, undefined, "Fetch.requestPaused", P("h1", "https://github.com/o/r/pull/2", "GET", { resourceType: "Document", responseStatusCode: 200, responseHeaders: [] }), { topFrame: "T7", forward: o.forward("h1") });
  for (const m of ["Fetch.continueRequest", "Fetch.fulfillRequest", "Fetch.failRequest", "Fetch.getResponseBody", "Fetch.continueResponse"]) assert.deepEqual(g.command(7, undefined, m, { requestId: "h1" }), { refuse: GUARD_TEXT.badId }, m);
  read({ body: MARKED_HTML, base64Encoded: false });
  await sleep(5);
  assert.deepEqual(o.got, ["h1"]);
  assert.deepEqual(g.command(7, undefined, "Fetch.fulfillRequest", { requestId: "h1", responseCode: 200, body: "" }), { method: "Fetch.fulfillRequest", params: { requestId: "h1", responseCode: 200, body: "" } });
  // A GitHub request that the client got: it may go on or be answered, but not be changed; the guard answers a changed one
  // itself with a 403 of the text, so that the request never waits for a client that drops the error.
  const text = GUARD_TEXT.rewrite("github.com");
  for (const [n, change] of [{ url: "https://github.com/o/r/pull/2/merge" }, { method: "POST" }, { postData: "x" }, { headers: [{ name: "X-Y", value: "1" }] }].entries()) {
    const id = `c${n}`;
    g.paused(7, undefined, "Fetch.requestPaused", P(id, "https://github.com/o/r/pull/2/files", "GET", { resourceType: "Document" }), { topFrame: "T7", forward: o.forward(id) });
    assert.deepEqual(g.command(7, undefined, "Fetch.continueRequest", { requestId: id, ...change }), { refuse: text, instead: ["Fetch.fulfillRequest", refusalOf(P(id, "", "GET", { resourceType: "Document" }), { text })] }, JSON.stringify(change));
  }
  assert.deepEqual(g.command(7, undefined, "Fetch.continueRequest", { requestId: "c9", url: "https://github.com/x" }), { refuse: text }, "a request that the client never got: the error only");
  // Another host's request that the client got: no rewrite to GitHub.
  g.paused(7, undefined, "Fetch.requestPaused", { ...P("a1", "https://a.example/x"), request: { url: "https://a.example/x", method: "GET", headers: { Origin: "https://a.example" } } }, { topFrame: "T7", forward: o.forward("a1") });
  const re = g.command(7, undefined, "Fetch.continueRequest", { requestId: "a1", url: "https://api.github.com/repos/o/r/pulls/2/merge", method: "PUT" }) as any;
  assert.deepEqual([re.refuse, re.instead[0], JSON.parse(Buffer.from(re.instead[1].body, "base64").toString()).message, re.instead[1].responseHeaders.find((h: any) => h.name === "Access-Control-Allow-Origin")?.value], [text, "Fetch.fulfillRequest", text, "https://a.example"]);
  g.paused(7, undefined, "Fetch.requestPaused", P("a2", "https://a.example/x"), { topFrame: "T7", forward: o.forward("a2") });
  assert.deepEqual(g.command(7, undefined, "Fetch.continueRequest", { requestId: "a2", url: "https://a.example/y" }), { method: "Fetch.continueRequest", params: { requestId: "a2", url: "https://a.example/y" } });
  // A refused write that the client got: its continue becomes the guard's 403.
  g.url(7, "https://github.com/o/r/pull/2");
  g.paused(7, undefined, "Fetch.requestPaused", P("w1", "https://github.com/o/r/pull/2/merge", "POST"), { topFrame: "T7", forward: o.forward("w1") });
  await sleep(5);
  assert.ok(o.got.includes("w1"));
  const cont = g.command(7, undefined, "Fetch.continueRequest", { requestId: "w1" });
  assert.deepEqual(cont, { method: "Fetch.fulfillRequest", params: refusalOf(P("w1", "https://github.com/o/r/pull/2/merge", "POST"), "marked") });
  // Its disable: Chrome gets the guard's patterns, and the guard lets the client's held requests go (a refused one with its 403).
  g.paused(7, undefined, "Fetch.requestPaused", P("k1", "https://b.example/"), { topFrame: "T7", forward: o.forward("k1") });
  g.paused(7, undefined, "Fetch.requestPaused", P("w2", "https://github.com/o/r/pull/2/merge", "POST"), { topFrame: "T7", forward: o.forward("w2") });
  await sleep(5);
  const off = g.command(7, undefined, "Fetch.disable", {}) as any;
  assert.deepEqual([off.method, off.params], ["Fetch.enable", { patterns: [...g.patterns] }]);
  off.after();
  await sleep(5);
  assert.ok(sent.some((s) => s.method === "Fetch.continueRequest" && s.params.requestId === "k1"));
  assert.ok(sent.some((s) => s.method === "Fetch.fulfillRequest" && s.params.requestId === "w2" && s.params.responseCode === 403));
  // On a session that the guard did not arm, the disable goes as it is, after the refusals of the held refused writes.
  g.command(9, "C1", "Fetch.enable", {});
  g.paused(9, "C1", "Fetch.requestPaused", P("w3", "https://github.com/o/r/pull/2/merge", "POST"), { topFrame: null, forward: o.forward("w3") });
  await sleep(5);
  const off2 = g.command(9, "C1", "Fetch.disable", {}) as any;
  assert.deepEqual([off2.method, off2.before.map((b: any) => [b[0], b[1].requestId, b[1].responseCode])], ["Fetch.disable", [["Fetch.fulfillRequest", "w3", 403]]]);
  assert.equal(g.state().counts.clientRefused, 11, "5 held, 4 changes, 2 rewrites");
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

test("the stand-in host: --test-merge-guard-host takes only a normalized host under .localhost, and only --test passes it to the service", async () => {
  const { testMergeGuardHost } = await import("../src/service/main.ts");
  assert.equal(testMergeGuardHost("github-standin.localhost"), "github-standin.localhost");
  for (const bad of ["github.com", "api.github.com", "localhost", "GitHub-Standin.localhost", "x.localhost.evil.example", "http://a.localhost", "a.localhost:8080", "", "a..localhost"]) {
    assert.throws(() => testMergeGuardHost(bad), /--test-merge-guard-host must be a host under \.localhost/, bad);
  }
  const { readFileSync } = await import("node:fs");
  const main = readFileSync(new URL("../src/service/main.ts", import.meta.url), "utf8");
  assert.match(main, /const guardHost = test && str\("test-merge-guard-host"\) \? testMergeGuardHost\(str\("test-merge-guard-host"\)!\) : undefined;/);
  assert.match(main, /\.\.\.\(guardHost \? \{ mergeGuard: \{ testHosts: \[guardHost\] \} \} : \{\}\)/);
  assert.match(main, /"test-merge-guard-host"\]\) if \(v\[k\] !== undefined && !test\) throw new UsageError/);
});

test("Page.setBypassCSP with enabled true is refused while the floor is not confirmed (review-125 note A), and goes with it; enabled false always goes", () => {
  const text = "Not available in the agent browser: Page.setBypassCSP.";
  assert.equal(refusal("Page.setBypassCSP", { enabled: true }, true), text, "no floor named: refused");
  assert.equal(refusal("Page.setBypassCSP", { enabled: true }, true, { floor: false }), text);
  assert.equal(refusal("Page.setBypassCSP", { enabled: true }, true, { floor: true }), null);
  assert.equal(refusal("Page.setBypassCSP", { enabled: false }, true, { floor: false }), null);
  assert.deepEqual(route("Page.setBypassCSP", { enabled: true }, true, { floor: false }), { refused: text });
  assert.equal(route("Page.setBypassCSP", { enabled: true }, true, { floor: true }), "chrome");
});

test("the floor's states: no answer yet, an answer of the current link, an error, unknown op, and an answer from before a link change", async () => {
  let answer: (v: unknown) => void = () => {}, fail: (e: Error) => void = () => {};
  const { g } = guard({ op: () => new Promise((res, rej) => { answer = res; fail = rej; }) });
  const up = g.linkUp();
  assert.equal(g.floor, "unknown", "no answer yet");
  await sleep(1);
  answer(null); await up;
  assert.equal(g.floor, "on", "the answer of the current link");
  // A new link up (also with no reset before it) starts with no confirmed floor, until its own answer.
  const up1 = g.linkUp();
  assert.equal(g.floor, "unknown", "a link up: no answer yet");
  await sleep(1);
  answer(null); await up1;
  assert.equal(g.floor, "on");
  const armed = g.arm(7);
  await sleep(1);
  fail(new Error("timeout")); await armed;
  assert.equal(g.floor, "unknown", "an error confirms no floor");
  // An answer that comes after a link change confirms nothing.
  const late = g.linkUp();
  await sleep(1);
  const stale = answer;
  g.reset();
  stale(null); await late;
  assert.equal(g.floor, "unknown", "an answer from before the link change");
  const up2 = g.linkUp();
  await sleep(1);
  fail(new Error("unknown op")); await up2;
  assert.equal(g.floor, "absent", "an older receiver");
});

const GH = "https://github.com/o/r/pull/1";
const tick = () => new Promise((r) => setTimeout(r, 0));
const pass = (method: string, params: object) => ({ method, params });

test("the bypass on GitHub only (the operator's ab-u92): the arm names the tab to the floor at its Fetch; it turns the service worker's bypass on only in a tab whose page is on a guarded host; there a client's bypass that is not true is refused and bypass true is answered", async () => {
  const { g, sent, ops } = guard();
  assert.equal(await g.arm(6), true);
  assert.deepEqual(sent.map((s) => s.method), ["Fetch.enable"], "a tab of another site: no Network call");
  assert.deepEqual(ops.at(-1), [{ hosts: ["github.com"], tabs: [6] }], "the floor names the tab at its Fetch");
  assert.equal(g.isBypassed(6), false);
  assert.deepEqual(g.command(6, undefined, "Network.setBypassServiceWorker", { bypass: false }), pass("Network.setBypassServiceWorker", { bypass: false }), "the bypass is off: as before");
  assert.deepEqual(g.command(6, undefined, "Network.disable", {}), pass("Network.disable", {}));
  assert.equal(g.hidesNetwork(6, undefined), false);
  sent.length = 0;
  g.url(7, GH);
  assert.equal(await g.arm(7), true);
  assert.deepEqual(sent.map((s) => [s.method, s.params]), [["Fetch.enable", { patterns: [...g.patterns] }], ["Network.enable", GUARD_NETWORK], ["Network.setBypassServiceWorker", { bypass: true }]]);
  assert.deepEqual(GUARD_NETWORK, { maxTotalBufferSize: 0, maxResourceBufferSize: 0 }, "review-125b F2: Chrome keeps no Network data for the guard");
  assert.deepEqual(ops.at(-1), [{ hosts: ["github.com"], tabs: [6, 7] }]);
  assert.equal(g.isBypassed(7), true);
  assert.deepEqual(g.command(7, undefined, "Network.setBypassServiceWorker", { bypass: false }), { refuse: GUARD_TEXT.serviceWorker });
  assert.deepEqual(g.command(7, undefined, "Network.setBypassServiceWorker", {}), { refuse: GUARD_TEXT.serviceWorker }, "a bypass that is not true");
  assert.deepEqual(g.command(7, undefined, "Network.setBypassServiceWorker", { bypass: true }), { answer: {} });
  assert.deepEqual(g.command(9, undefined, "Network.setBypassServiceWorker", { bypass: false }), pass("Network.setBypassServiceWorker", { bypass: false }), "a tab that the guard did not arm: as before");
  g.armChild(7, "F1");
  assert.deepEqual(g.command(7, "F1", "Network.setBypassServiceWorker", { bypass: false }), pass("Network.setBypassServiceWorker", { bypass: false }), "a frame: as before");
  assert.deepEqual(g.command(7, "F1", "Network.disable", {}), pass("Network.disable", {}), "a frame: as before");
  {
    const bad = guard({ send: (s) => { if (s.method === "Fetch.enable") throw new Error("Not supported"); return {}; } });
    bad.g.url(5, GH);
    assert.equal(await bad.g.arm(5), false);
    assert.equal(bad.g.isArmed(5), false, "a failed Fetch.enable: nothing went, the tab is off");
    assert.equal(bad.g.hidesNetwork(5, undefined), false);
    assert.deepEqual(bad.ops, []);
  }
  // review-125b item 4: a partial arm. The guard's Fetch went, so the tab is the guard's and the floor names it; the rules of the
  // bypass hold (its Network calls held, its Network events hidden), as Network can be on in Chrome.
  for (const failing of ["Network.enable", "Network.setBypassServiceWorker"]) {
    const bad = guard({ send: (s) => { if (s.method === failing) throw new Error("Not supported"); return {}; } });
    bad.g.url(5, GH);
    assert.equal(await bad.g.arm(5), true, failing);
    assert.equal(bad.g.isArmed(5), true, `${failing}: the guard's Fetch stays on`);
    assert.equal(bad.g.hidesNetwork(5, undefined), true, `${failing}: no Network event reaches a client that did not turn Network on`);
    assert.deepEqual(bad.g.command(5, undefined, "Network.disable", {}), { answer: {} }, failing);
    assert.deepEqual(bad.ops.at(-1), [{ hosts: ["github.com"], tabs: [5] }], `${failing}: the floor names the tab; a request of a service worker has no tab`);
    assert.ok(bad.logs.some((l) => l === "merge guard: the service worker's bypass did not start in tab 5 (Not supported); the receiver's floor keeps blocking the writes of a request with no tab"), bad.logs.join("\n"));
  }
});

test("the bypass follows the tab's main frame (the operator's ab-u92): a commit on a guarded host turns it on, a commit elsewhere turns it off; a client's Page.navigate to a guarded address turns it on first, to another address changes nothing; a turn on and off keep the client's own Network state", async () => {
  const { g, sent } = guard();
  await g.arm(7);
  // While the bypass is off, the client's own Network calls go to Chrome, and the guard notes them.
  assert.deepEqual(g.command(7, undefined, "Network.enable", { maxTotalBufferSize: 1000 }), pass("Network.enable", { maxTotalBufferSize: 1000 }));
  assert.deepEqual(g.command(7, undefined, "Network.setBypassServiceWorker", { bypass: true }), pass("Network.setBypassServiceWorker", { bypass: true }));
  sent.length = 0;
  g.committed(7, GH);
  await tick();
  assert.deepEqual(sent.map((s) => [s.method, s.params]), [["Network.setBypassServiceWorker", { bypass: true }]], "the client's Network is on: only the bypass, so its buffers stay");
  assert.equal(g.isBypassed(7), true);
  assert.deepEqual(g.command(7, undefined, "Network.disable", {}), { answer: {} }, "the bypass is on: the client's Network.disable is held");
  assert.equal(g.hidesNetwork(7, undefined), true);
  sent.length = 0;
  g.committed(7, "https://a.example/");
  await tick(); await tick();
  assert.deepEqual(sent.map((s) => [s.method, s.params]), [["Network.setBypassServiceWorker", { bypass: true }], ["Network.disable", {}]], "off: the client's own bypass value again, and Network off as the client asked");
  assert.equal(g.isBypassed(7), false);
  assert.equal(g.hidesNetwork(7, undefined), false);
  assert.deepEqual(g.command(7, undefined, "Network.disable", {}), pass("Network.disable", {}), "the bypass is off: as before");
  sent.length = 0;
  await g.beforeNavigate(7, "https://github.com/o/r/pull/2");
  assert.deepEqual(sent.map((s) => [s.method, s.params]), [["Network.enable", GUARD_NETWORK], ["Network.setBypassServiceWorker", { bypass: true }]], "a client's Page.navigate to GitHub: the bypass first (the client's Network is off now)");
  sent.length = 0;
  await g.beforeNavigate(7, "https://a.example/x");
  assert.deepEqual(sent, [], "a navigation to another address changes nothing before its commit");
  g.committed(7, GH);
  await tick();
  assert.deepEqual(sent, [], "on already");
  g.committed(9, GH);
  await tick();
  assert.deepEqual(sent, [], "a tab that the guard did not arm");
  assert.equal(g.isBypassed(9), false);
  // A turn off while the client has Network on keeps it on.
  g.command(7, undefined, "Network.enable", {});
  sent.length = 0;
  g.committed(7, "https://a.example/");
  await tick();
  assert.deepEqual(sent.map((s) => [s.method, s.params]), [["Network.setBypassServiceWorker", { bypass: true }]], "no Network.disable: the client has Network on");
});

test("the arm's limit (review-125b F1): in a tab on a guarded host, a Network call that a page's dialog holds ends the wait at the limit; the floor names the tab at its Fetch, the rules of the bypass hold, and the bypass follows a late answer; a tab of another site makes no Network call at the arm", async () => {
  assert.equal(ARM_LIMIT_MS, 3000);
  let release!: () => void;
  const held = new Promise((r) => { release = () => r({}); });
  const { g, sent, ops, logs } = guard({ armLimitMs: 50, send: (s) => (s.method === "Network.enable" && s.target.tabId === 7 ? held : {}) });
  g.url(7, GH);
  const t0 = Date.now();
  assert.equal(await g.arm(7), true);
  assert.ok(Date.now() - t0 < 1000, "the arm ends at its limit");
  assert.equal(g.isArmed(7), true);
  assert.deepEqual(ops.at(-1), [{ hosts: ["github.com"], tabs: [7] }], "the floor names the tab at its Fetch");
  assert.equal(g.hidesNetwork(7, undefined), true);
  assert.ok(logs.some((l) => l === "merge guard: the service worker's bypass did not start in tab 7 (no answer in 50 ms); the receiver's floor keeps blocking the writes of a request with no tab"), logs.join("\n"));
  assert.ok(!sent.some((s) => s.method === "Network.setBypassServiceWorker"), "no bypass before Network.enable answers");
  release();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(sent.filter((s) => s.target.tabId === 7).at(-1)!.method, "Network.setBypassServiceWorker", "the late answer: the bypass");
  // A client's Page.navigate to GitHub waits at most the limit too.
  const slow = guard({ armLimitMs: 50, send: (s) => (s.method === "Network.enable" ? new Promise(() => {}) : {}) });
  await slow.g.arm(3);
  const t1 = Date.now();
  await slow.g.beforeNavigate(3, GH);
  assert.ok(Date.now() - t1 < 1000, "the navigation goes at the limit");
  // The guard's own Fetch.enable has the same limit: with no answer, the tab is off.
  const noFetch = guard({ armLimitMs: 50, send: (s) => (s.method === "Fetch.enable" ? new Promise(() => {}) : {}) });
  assert.equal(await noFetch.g.arm(9), false);
  assert.equal(noFetch.g.isArmed(9), false);
  assert.ok(noFetch.logs.some((l) => l === "merge guard: the guard's Fetch did not start in tab 9 (no answer in 50 ms); the receiver's floor keeps blocking its writes to GitHub"), noFetch.logs.join("\n"));
});

test("a dedicated worker's session (review-125b check 3; ab-u92): the bypass follows its tab's: on in a worker of a tab on GitHub before the client lets it run, off with the tab's; there the client's bypass false is refused, its Network.disable answered, its Network events hidden until it turns Network on; a frame's session as before", async () => {
  const { g, sent } = guard();
  await g.arm(7);
  sent.length = 0;
  g.armChild(7, "W1", "worker");
  g.armChild(7, "F1", "iframe");
  await tick();
  assert.deepEqual(sent.map((s) => [s.target.sessionId, s.method]), [["W1", "Fetch.enable"], ["F1", "Fetch.enable"]], "the tab's bypass is off: the guard's Fetch only");
  sent.length = 0;
  g.committed(7, GH);
  await tick(); await tick();
  assert.deepEqual(sent.map((s) => [s.target.sessionId, s.method, s.params]), [[undefined, "Network.enable", GUARD_NETWORK], ["W1", "Network.enable", GUARD_NETWORK], [undefined, "Network.setBypassServiceWorker", { bypass: true }], ["W1", "Network.setBypassServiceWorker", { bypass: true }]]);
  assert.deepEqual(g.command(7, "W1", "Network.setBypassServiceWorker", { bypass: false }), { refuse: GUARD_TEXT.serviceWorker });
  assert.deepEqual(g.command(7, "W1", "Network.disable", {}), { answer: {} });
  assert.equal(g.hidesNetwork(7, "W1"), true);
  g.command(7, "W1", "Network.enable", {});
  assert.equal(g.hidesNetwork(7, "W1"), false);
  sent.length = 0;
  g.armChild(7, "W2", "worker");
  await tick(); await tick();
  assert.deepEqual(sent.map((s) => [s.target.sessionId, s.method]), [["W2", "Fetch.enable"], ["W2", "Network.enable"], ["W2", "Network.setBypassServiceWorker"]], "a worker of a tab whose bypass is on: the bypass before it runs");
  assert.deepEqual(g.command(7, "F1", "Network.disable", {}), pass("Network.disable", {}), "a frame: as before");
  assert.equal(g.hidesNetwork(7, "F1"), false);
  sent.length = 0;
  g.committed(7, "https://a.example/");
  await tick(); await tick();
  assert.deepEqual(sent.filter((s) => s.target.sessionId === "W1").map((s) => [s.method, s.params]), [["Network.setBypassServiceWorker", { bypass: false }]], "W1's client has Network on");
  assert.deepEqual(sent.filter((s) => s.target.sessionId === "W2").map((s) => [s.method, s.params]), [["Network.setBypassServiceWorker", { bypass: false }], ["Network.disable", {}]]);
  g.childGone(7, "W1");
  assert.equal(g.hidesNetwork(7, "W1"), false, "the worker's end: its state goes");
  assert.deepEqual(g.command(7, "W1", "Network.disable", {}), pass("Network.disable", {}));
});

test("Network on a tab on GitHub (the lead's focused change; ab-u92): a client's Network.disable is answered and keeps Network on; its Network.enable goes to Chrome and the bypass follows; the tab's Network events go to the client only while it turned Network on; a detach and a link change end the client's state", async () => {
  const { g, sent } = guard();
  g.url(7, GH);
  await g.arm(7);
  assert.equal(g.hidesNetwork(7, undefined), true, "no client asked for Network");
  assert.equal(g.hidesNetwork(7, "F1"), false, "a child session: as before");
  assert.equal(g.hidesNetwork(9, undefined), false, "a tab that the guard did not arm: as before");
  const on = g.command(7, undefined, "Network.enable", { maxPostDataSize: 65536 });
  assert.ok("method" in on && on.method === "Network.enable" && on.params.maxPostDataSize === 65536);
  assert.equal(g.hidesNetwork(7, undefined), false);
  sent.length = 0;
  (on as any).after();
  await Promise.resolve();
  assert.deepEqual(sent.map((s) => [s.target, s.method, s.params]), [[{ tabId: 7 }, "Network.setBypassServiceWorker", { bypass: true }]], "the bypass again after the client's Network.enable");
  assert.deepEqual(g.command(7, undefined, "Network.disable", {}), { answer: {} });
  assert.equal(g.hidesNetwork(7, undefined), true);
  assert.deepEqual(g.command(7, undefined, "Network.setCacheDisabled", { cacheDisabled: true }), pass("Network.setCacheDisabled", { cacheDisabled: true }), "another Network call: as before");
  g.command(7, undefined, "Network.enable", {});
  g.disarm(7);
  assert.equal(g.isBypassed(7), false, "a detach ends it");
  await g.arm(7);
  assert.equal(g.hidesNetwork(7, undefined), true, "a new arm after a detach: the next client starts with no Network");
  g.command(7, undefined, "Network.enable", {});
  g.reset();
  assert.equal(g.isBypassed(7), false, "a link change ends it");
  g.url(7, GH);
  await g.arm(7);
  assert.equal(g.hidesNetwork(7, undefined), true, "a new arm after a link change: the next client starts with no Network");
});

test("a turn off of the bypass (ab-u92) keeps the session's Network events hidden from a client with Network off until Chrome answers the guard's Network.disable", async () => {
  let answer!: () => void;
  const disabled = new Promise((r) => { answer = () => r({}); });
  const { g } = guard({ send: (s) => (s.method === "Network.disable" ? disabled : {}) });
  g.url(7, GH);
  await g.arm(7);
  g.committed(7, "https://a.example/");
  await tick(); await tick();
  assert.equal(g.isBypassed(7), false);
  assert.equal(g.hidesNetwork(7, undefined), true, "Network is still on in Chrome");
  answer();
  await tick(); await tick();
  assert.equal(g.hidesNetwork(7, undefined), false);
});
