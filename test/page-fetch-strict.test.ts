// PageFetch in strict mode (board ab-v16.113; the option fetchList, which `agent-browser page-fetch` always passes and the
// service never does), on the fakes of test/fetch-fakes.ts: a caller with a fetch list fetches only URLs on it. The call's URL is checked before the
// read on, the address rule, the rate and any window; each request of the window that the list refuses (its address, or
// a method other than GET and HEAD) fails and is counted, and the fetch goes on; a request of the main document that the
// list refuses ends the fetch, and it is never followed. With no fetch list (the service) PageFetch is exactly C11's. No Chrome.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FetchRefusal } from "../src/service/fetch/page-fetch.ts";
import { FetchWorld, sleep } from "./fetch-fakes.ts";

const URL1 = "https://pages.example.test/docs/a-secret-path?token=test-query-value";
const LOCAL = { scope: "web-1", admission: "local" as const };
const LIST = ["pages.example.test/docs", "cdn.example.test"];
/** The name of the list's allow file, which each text of strict mode names (a test value). */
const NAME = "support-fetch.json";
const OFF = `Not fetched (refused): The URL is not on the fetch list in ${NAME}.`;
const OFF_MAIN = `Not fetched (refused): The page went on to an address that is not on the fetch list in ${NAME}.`;

async function refusal(p: Promise<unknown>): Promise<FetchRefusal> {
  try { await p; } catch (e) { assert.ok(e instanceof FetchRefusal, String(e)); return e; }
  assert.fail("the call did not fail");
}
const header = (text: string) => text.slice(0, text.indexOf("\n\n"));
const windows = (w: FetchWorld) => w.calls.filter((c) => c.op === "windows.create").length;
/** `url` with a user name in it (made by the URL parser). */
const withUser = (url: string) => { const u = new URL(url); u.username = "someone"; return u.href; };
/** A world whose resolver records each lookup, and a fetcher whose fetch list is `list` for every scope (the test can change it). */
function strictWorld(list: readonly string[] | null = LIST) {
  const w = new FetchWorld();
  w.resolver["cdn.example.test"] = ["203.0.113.12"];
  w.resolver["ads.example.test"] = ["203.0.113.13"];
  const lookups: string[] = [];
  const state = { list, name: NAME, scopes: [] as string[] };
  const f = w.fetcher({
    resolve: async (h) => { lookups.push(h); const a = w.resolver[h]; if (!a) throw new Error("ENOTFOUND"); return a; },
    fetchList: (scope) => { state.scopes.push(scope); return state.list === null ? null : { entries: state.list, name: state.name }; },
  });
  return { w, f, lookups, state };
}

test("strict mode: a URL that is not on the fetch list is refused before the read on, the address rule, the rate and any window: no window, no lookup of its host, no fetch of the rate", async () => {
  const { w, f, lookups, state } = strictWorld();
  for (const url of [
    "https://other.example.test/", "https://pages.example.test/", "https://pages.example.test/docsX", "http://pages.example.test/docs/a",
    "https://pages.example.test:8443/docs/a", withUser("https://pages.example.test/docs/a"), "https://sub.cdn.example.test/x", "https://pages.example.test/docs/../admin",
    "http://127.0.0.1/", "https://nowhere.example.test/",
  ]) {
    const e = await refusal(f.fetch(LOCAL, { url }));
    assert.equal(e.code, "refused", url);
    assert.equal(e.message, OFF, url);
  }
  const e = await refusal(f.fetch(LOCAL, { url: "https://other.example.test/", offset: 5 }));
  assert.equal(e.message, OFF, "a read on too");
  assert.equal(windows(w), 0, "no window");
  assert.deepEqual(lookups, [], "no lookup of a host that is not on the list");
  assert.deepEqual([...new Set(state.scopes)], ["web-1"], "the list of the calling scope, at each call");
  assert.equal(state.scopes.length, 11, "read at each call");
  assert.match(w.log[0], /^page-fetch: scope web-1, host other\.example\.test, result refused, status none, \d+ ms, 0 characters, 0 downloads, 0 websockets, 0 blocked by the fetch list$/);
  // A refusal costs no fetch of the rate: 30 fetches on the list still pass.
  for (let i = 0; i < 30; i++) await f.fetch(LOCAL, { url: `https://pages.example.test/docs/p${i}` });
  assert.equal(windows(w), 30);
});

test("strict mode: an empty fetch list refuses every URL with its own text, before any window", async () => {
  const { w, f, lookups } = strictWorld([]);
  for (const url of [URL1, "https://cdn.example.test/"]) {
    const e = await refusal(f.fetch(LOCAL, { url }));
    assert.equal(e.message, `Not fetched (refused): The fetch list in ${NAME} has no entry, so PageFetch fetches no URL.`);
  }
  assert.equal(windows(w), 0);
  assert.deepEqual(lookups, []);
});

test("strict mode: a page on the list gives its text, the header gets the line of the fetch list after the length, the address rule stays on top, and the log line counts the blocked requests", async () => {
  const { w, f } = strictWorld();
  w.pages[URL1] = { status: 200, title: "The Test Page" };
  const text = await f.fetch(LOCAL, { url: URL1 });
  const lines = header(text).split("\n");
  assert.deepEqual(lines.slice(0, 4), [`URL: ${URL1}`, "Title: The Test Page", "Status: 200", "Kind: html"]);
  assert.match(lines[5], /^Length: \d+ characters$/);
  assert.equal(lines[6], "Fetch list: strict (0 requests blocked)");
  assert.equal(lines.length, 7);
  assert.match(w.log[0], /^page-fetch: scope web-1, host pages\.example\.test, result ok, status 200, \d+ ms, \d+ characters, 0 downloads, 0 websockets, 0 blocked by the fetch list$/);
  // The address rule stays on top: a host on the list with a loopback address is refused by it.
  const { w: v, f: g } = strictWorld(["rebind.example.test"]);
  v.resolver["rebind.example.test"] = ["127.0.0.1"];
  const e = await refusal(g.fetch(LOCAL, { url: "https://rebind.example.test/" }));
  assert.equal(e.message, "Not fetched (refused): The host rebind.example.test has a loopback address; PageFetch never reaches the box itself or a private network.");
  assert.equal(windows(v), 0);
});

test("strict mode: each request of the window that the list refuses fails at once and is counted (an asset of another host, a frame, a worker's request, a POST, a popup's request); requests on the list and data: go on; the fetch goes on", async () => {
  const { w, f, lookups } = strictWorld();
  const answers: Record<string, string> = {};
  w.pages[URL1] = {
    after: async (x) => {
      // One request stays open while the page's script runs, so the page is not ready before its end.
      x.cdp("Network.requestWillBeSent", { requestId: "hold", request: { url: "https://cdn.example.test/hold" } });
      x.emit({ ev: "tabs.onCreated", tab: { id: 61, incognito: true, openerTabId: 51, windowId: 60 } });
      await sleep(20);
      x.emit({ ev: "debugger.onEvent", source: { tabId: 61 }, method: "Fetch.requestPaused", params: { requestId: "pop-1", request: { url: "https://ads.example.test/pop", method: "GET" } } });
      answers.asset = await x.pause("https://ads.example.test/tracker.js", { type: "Script" });
      answers.frame = await x.pause("https://ads.example.test/frame.html", { type: "Document", frameId: "F2" });
      answers.post = await x.pause("https://pages.example.test/docs/api", { method: "POST" });
      answers.beacon = await x.pause("https://cdn.example.test/collect", { method: "PUT", type: "Ping" });
      answers.head = await x.pause("https://cdn.example.test/x.css", { method: "HEAD", type: "Stylesheet" });
      answers.ok = await x.pause("https://cdn.example.test/app.js", { type: "Script" });
      answers.offPath = await x.pause("https://pages.example.test/admin/x.js", { type: "Script" });
      answers.data = await x.pause("data:text/plain,hi");
      x.cdp("Target.attachedToTarget", { sessionId: "S-worker", targetInfo: { type: "worker", url: "https://cdn.example.test/w.js" }, waitingForDebugger: true });
      await sleep(30);
      answers.worker = await x.pause("https://ads.example.test/w-data", { session: "S-worker" });
      answers.workerOk = await x.pause("https://cdn.example.test/w-data", { session: "S-worker" });
      x.cdp("Network.loadingFinished", { requestId: "hold" });
    },
  };
  const text = await f.fetch(LOCAL, { url: URL1 });
  assert.deepEqual(answers, { asset: "fail", frame: "fail", post: "fail", beacon: "fail", head: "continue", ok: "continue", offPath: "fail", data: "continue", worker: "fail", workerOk: "continue" });
  assert.equal(w.answered.get("pop-1"), "fail", "a popup's request fails");
  assert.ok(header(text).split("\n").includes("Fetch list: strict (7 requests blocked)"), header(text));
  assert.match(w.log[0], /, 7 blocked by the fetch list$/);
  assert.ok(!lookups.includes("ads.example.test"), "no lookup of a host that is not on the list");
  const failed = w.sent.filter((s) => s.method === "Fetch.failRequest").map((s) => s.params.errorReason);
  assert.ok(failed.length >= 7 && failed.every((r) => r === "BlockedByClient"), "BlockedByClient");
});

test("strict mode: a redirect of the main document off the list ends the fetch (refused) and is never followed; a redirect on the list is followed", async () => {
  const { w, f } = strictWorld();
  w.pages[URL1] = { redirects: ["https://pages.example.test/docs/b", "https://other.example.test/landing"] };
  const e = await refusal(f.fetch(LOCAL, { url: URL1 }));
  assert.equal(e.code, "refused");
  assert.equal(e.message, OFF_MAIN);
  assert.deepEqual([...w.answered.values()], ["continue", "continue", "fail"], "the redirect off the list fails: Chrome never follows it");
  assert.ok(!w.sent.some((s) => s.method === "Runtime.evaluate" && String(s.params.expression).includes("/*aw-fetch:convert*/")), "no conversion");
  assert.equal(w.fetchEnds, 1, "the window ends");
  assert.match(w.log[0], /result refused, .*, 1 blocked by the fetch list$/);

  const { w: v, f: g } = strictWorld();
  v.pages[URL1] = { redirects: ["https://pages.example.test/docs/b", "https://pages.example.test/docs/c"] };
  const text = await g.fetch(LOCAL, { url: URL1 });
  assert.deepEqual([...v.answered.values()].slice(0, 3), ["continue", "continue", "continue"]);
  assert.ok(header(text).includes("Fetch list: strict (0 requests blocked)"));
});

test("strict mode: the page's own navigation off the list ends the fetch (refused); a navigation of the main document with another method than GET or HEAD ends it too", async () => {
  const { w, f } = strictWorld();
  w.pages[URL1] = { after: async (x) => { await x.pageNavigates("https://other.example.test/next"); } };
  assert.equal((await refusal(f.fetch(LOCAL, { url: URL1 }))).message, OFF_MAIN);
  const { w: v, f: g } = strictWorld();
  v.pages[URL1] = { after: async (x) => { await x.pause("https://pages.example.test/docs/form", { type: "Document", method: "POST" }); } };
  assert.equal((await refusal(g.fetch(LOCAL, { url: URL1 }))).message, `Not fetched (refused): The page sent a request of its document with a method other than GET or HEAD, which the fetch list in ${NAME} never lets go.`);
});

test("strict mode: a read on comes from memory only for a result that a fetch in strict mode made and whose final URL is on the list now; else it goes on as a new fetch, or is refused", async () => {
  const { w, f, state } = strictWorld();
  w.pages[URL1] = { main: "x".repeat(250_000) };
  const a = await f.fetch(LOCAL, { url: URL1 });
  assert.match(header(a), /\nPart: characters 0 to 100000; the next part starts at offset 100000\nFetch list: strict \(0 requests blocked\)$/);
  const b = await f.fetch(LOCAL, { url: URL1, offset: 100_000 });
  assert.match(header(b), /\nPart: characters 100000 to 200000; the next part starts at offset 200000\nFetch list: strict \(0 requests blocked\)$/);
  assert.equal(windows(w), 1, "from memory");
  assert.match(w.log[1], /result ok \(from memory\), .*, 0 blocked by the fetch list$/);
  // The operator takes the URL off the list: the read on is refused, with no window.
  state.list = ["cdn.example.test"];
  assert.equal((await refusal(f.fetch(LOCAL, { url: URL1, offset: 100_000 }))).message, OFF);
  assert.equal(windows(w), 1);
  // A result of a fetch with no fetch list: a read on in strict mode fetches again (in strict mode).
  state.list = null;
  const U2 = "https://pages.example.test/docs/long";
  w.pages[U2] = { main: "y".repeat(150_000) };
  const c = await f.fetch(LOCAL, { url: U2 });
  assert.ok(!header(c).includes("Fetch list"), "no line with no fetch list");
  state.list = LIST;
  const d = await f.fetch(LOCAL, { url: U2, offset: 100_000 });
  assert.equal(windows(w), 3, "a new fetch for the read on");
  assert.match(header(d), /Fetch list: strict \(0 requests blocked\)$/);
  // A result of a fetch in strict mode, read on with no fetch list: from memory, and its header says how it was fetched.
  state.list = null;
  const e = await f.fetch(LOCAL, { url: U2, offset: 100_000 });
  assert.equal(windows(w), 3);
  assert.match(header(e), /Fetch list: strict \(0 requests blocked\)$/);
  assert.doesNotMatch(w.log[w.log.length - 1], /blocked by the fetch list/, "the log line of a call with no fetch list");
});

test("strict mode: the header says 1 request for one blocked request", async () => {
  const { w, f } = strictWorld();
  w.pages[URL1] = { after: async (x) => { await x.pause("https://ads.example.test/one.js", { type: "Script" }); } };
  assert.ok(header(await f.fetch(LOCAL, { url: URL1 })).endsWith("\nFetch list: strict (1 request blocked)"));
});

test("a scope with no fetch list is as before: any public URL, the same answers to the same requests, no line of the fetch list in the header and none in the log line", async () => {
  const run = async (o: { fetchList?: () => null }) => {
    const w = new FetchWorld();
    w.resolver["ads.example.test"] = ["203.0.113.13"];
    const answers: Record<string, string> = {};
    w.pages[URL1] = {
      status: 200, title: "The Test Page", redirects: ["https://other.example.test/landing"],
      after: async (x) => {
        answers.asset = await x.pause("https://ads.example.test/tracker.js", { type: "Script" });
        answers.post = await x.pause("https://other.example.test/api", { method: "POST" });
        answers.local = await x.pause("http://10.0.0.1/x");
      },
    };
    const text = await w.fetcher(o).fetch(LOCAL, { url: URL1 });
    return { text, answers, log: w.log, methods: w.methods().filter((m) => m !== "Runtime.evaluate" && m !== "Page.createIsolatedWorld") };
  };
  const before = await run({});
  const none = await run({ fetchList: () => null });
  assert.deepEqual(none.answers, { asset: "continue", post: "continue", local: "fail" });
  assert.deepEqual(none.answers, before.answers);
  assert.equal(header(none.text), header(before.text));
  assert.ok(!header(none.text).includes("Fetch list"));
  assert.deepEqual(none.methods, before.methods);
  assert.match(none.log[0], /, 0 downloads, 0 websockets$/);
});

test("strict mode: a PDF on the list gives its text, and its header gets the line of the fetch list", async () => {
  const { makePdf } = await import("./pdf-fixture.ts");
  const { w, f } = strictWorld();
  const U = "https://pages.example.test/docs/chapter.pdf";
  w.pages[U] = { status: 200, mime: "application/pdf", body: makePdf([["PDF-TEXT: a line of the strict test."]]) };
  const text = await f.fetch(LOCAL, { url: U });
  assert.match(header(text), /\nKind: pdf\nMode: main\nLength: \d+ characters\nFetch list: strict \(0 requests blocked\)$/);
  assert.match(text, /PDF-TEXT: a line of the strict test\./);
});

test("strict mode: each refusal text names the list file and never the URL, its query or its fragment; no log line holds the query or the fragment (the daemon lead's point b)", async () => {
  const SECRET_URL = "https://other.example.test/a-secret-path?token=test-query-value#test-fragment-value";
  const texts: string[] = [];
  const logs: string[] = [];
  const keep = (w: FetchWorld) => logs.push(...w.log);
  // The call's URL off the list, with a query and a fragment; and a read on of it.
  { const { w, f } = strictWorld(); texts.push((await refusal(f.fetch(LOCAL, { url: SECRET_URL }))).message, (await refusal(f.fetch(LOCAL, { url: SECRET_URL, offset: 3 }))).message); keep(w); }
  // An empty fetch list.
  { const { w, f, state } = strictWorld([]); state.name = "other-list.json"; texts.push((await refusal(f.fetch(LOCAL, { url: SECRET_URL }))).message); keep(w); }
  // A redirect of the main document off the list, to a URL with a query and a fragment.
  { const { w, f } = strictWorld(); w.pages[`${URL1}#a-first-fragment`] = { redirects: [SECRET_URL] }; texts.push((await refusal(f.fetch(LOCAL, { url: `${URL1}#a-first-fragment` }))).message); keep(w); }
  // A POST of the main document to a URL on the list with a query.
  { const { w, f } = strictWorld(); w.pages[URL1] = { after: async (x) => { await x.pause("https://pages.example.test/docs/form?token=test-query-value#test-fragment-value", { type: "Document", method: "POST" }); } }; texts.push((await refusal(f.fetch(LOCAL, { url: URL1 }))).message); keep(w); }
  assert.deepEqual(texts, [OFF, OFF, "Not fetched (refused): The fetch list in other-list.json has no entry, so PageFetch fetches no URL.", OFF_MAIN,
    `Not fetched (refused): The page sent a request of its document with a method other than GET or HEAD, which the fetch list in ${NAME} never lets go.`]);
  for (const t of [...texts, ...logs]) for (const bit of ["?", "#", "token", "test-query-value", "test-fragment-value", "a-first-fragment", "a-secret-path", "/docs"]) assert.ok(!t.includes(bit), `${bit} in ${t}`);
  assert.ok(logs.length >= 5 && logs.every((l) => /^page-fetch: scope web-1, host [a-z.]+, result refused, /.test(l)), logs.join("\n"));
});

test("the service's PageFetch is C11's (the re-scope of board ab-v16.113): the service passes no fetch list, and C11 and C12 name no fetch list", () => {
  const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
  const svc = read("src/service/service.ts");
  assert.ok(svc.includes("pageFetch = new PageFetch({"), "the service makes its PageFetch");
  assert.ok(!svc.includes("fetchList"), "with no fetch list");
  for (const c of ["docs/contracts/C11.md", "docs/contracts/C12.md"]) assert.ok(!/fetch list|fetchList|fetch_list|page-fetch </i.test(read(c)), `${c} names no fetch list`);
});
