// PageFetch in the service (src/service/fetch/page-fetch.ts; contract C11, "PageFetch"; the PageFetch design, sections
// 5.1 to 5.9; board ab-v16.102), on fakes (test/fetch-fakes.ts): a fake receiver with the `fetch` feature, a fake fetch
// tab, a fake resolver and a fake Defuddle. Each error code, the window and its end, the guard of every request, the
// waits, the no-input rules, the conversion's fallback, paging and the memory, the limits and the log line. No Chrome.

import { test } from "node:test";
import assert from "node:assert/strict";
import { FetchRefusal, FETCH_LIMITS, PAGE_FETCH } from "../src/service/fetch/page-fetch.ts";
import { WindowLock } from "../src/service/fetch/lock.ts";
import { FetchWorld, sleep } from "./fetch-fakes.ts";
import { OFF_SCREEN_GAP, xScreen } from "../src/service/signins/screen.ts";

const URL1 = "https://pages.example.test/docs/a-secret-path?token=test-query-value";
const LOCAL = { scope: "web-1", admission: "local" as const };

async function refusal(p: Promise<unknown>): Promise<FetchRefusal> {
  try { await p; } catch (e) { assert.ok(e instanceof FetchRefusal, String(e)); return e; }
  assert.fail("the call did not fail");
}
const header = (text: string) => text.slice(0, text.indexOf("\n\n"));
const body = (text: string) => text.slice(text.indexOf("\n\n") + 2);

test("a page: the window (C10: windows.create with the mark fetch), its hidden tab, the session's guard before the navigation, the move off the screen, the ready wait, Defuddle, fetch_end; the answer's header and markdown", async () => {
  const w = new FetchWorld();
  w.pages[URL1] = { status: 200, title: "The Test Page" };
  const text = await w.fetcher().fetch(LOCAL, { url: URL1 });
  assert.equal(PAGE_FETCH, "PageFetch");
  const create = w.calls.find((c) => c.op === "windows.create")!;
  assert.deepEqual(create.args, [{ url: "about:blank", focused: false, incognito: true }, "web-1", "fetch"]);
  assert.ok(w.hidden.has(51), "the tab is hidden from every client");
  const m = w.methods();
  const order = ["Page.enable", "Network.enable", "Network.setBypassServiceWorker", "Page.setDownloadBehavior", "Fetch.enable", "Target.setAutoAttach", "Page.getFrameTree", "Page.navigate"];
  assert.deepEqual(order.map((x) => m.indexOf(x)).every((i, k, a) => i >= 0 && (k === 0 || i > a[k - 1])), true, `the order: ${m.join(", ")}`);
  assert.deepEqual(w.sent.find((s) => s.method === "Fetch.enable")!.params, { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
  assert.deepEqual(w.sent.find((s) => s.method === "Target.setAutoAttach")!.params, { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  assert.deepEqual(w.sent.find((s) => s.method === "Page.setDownloadBehavior")!.params, { behavior: "deny" });
  assert.ok(m.indexOf("Runtime.evaluate") < m.indexOf("Page.navigate"), "the title marker and the move before the navigation");
  for (const s of w.sent.filter((x) => x.method === "Page.createIsolatedWorld")) assert.equal(s.params.grantUniversalAccess, false);
  assert.equal(w.fetchEnds, 1, "fetch_end once");
  assert.ok(!w.calls.some((c) => c.op === "tabs.remove" || c.op === "windows.remove"), "the service never closes the window itself");
  assert.equal(header(text), [
    `URL: ${URL1}`, "Title: The Test Page", "Status: 200", "Kind: html", "Mode: main", `Length: ${body(text).length} characters`,
  ].join("\n"));
  assert.match(body(text), /^# A test page\n\nThe text of the test page/);
  assert.deepEqual(w.seen[0], { url: URL1, markdown: true, useAsync: false, removeHiddenElements: true }, "Defuddle's options in main");
});

test("the move off the screen with the real X mover (the first live run, board ab-v16.102): xScreen takes PageFetch's title marker (aw-fetch- and 16 hex digits), searches by it and moves its window right of the screen", async () => {
  const w = new FetchWorld();
  w.pages[URL1] = { status: 200, title: "The Test Page" };
  const calls: string[][] = [];
  const run = () => async (args: string[]) => { calls.push(args); return { code: 0, out: args[0] === "search" ? "22\n" : "" }; };
  const screen = xScreen({ display: () => ({ display: ":171", xauth: "/x/auth", size: { width: 1280, height: 800 } }), xdotool: "/usr/bin/xdotool", run });
  const text = await w.fetcher({ screen }).fetch(LOCAL, { url: URL1 });
  assert.match(header(text), /^URL: /, "the fetch passes the move");
  const search = calls.find((c) => c[0] === "search");
  assert.ok(search && search[1] === "--name" && /^aw-fetch-[0-9a-f]{16}$/.test(search[2]), `the search by the marker: ${JSON.stringify(calls)}`);
  assert.deepEqual(calls.find((c) => c[0] === "windowmove"), ["windowmove", "22", String(1280 + OFF_SCREEN_GAP), "0"]);
  calls.length = 0;
  for (const bad of ["aw-fetch-0123", "aw-other-0123456789abcdef", "aw-fetch-0123456789abcdef; rm"]) assert.equal(await screen.moveOff(bad), 0, bad);
  assert.deepEqual(calls, [], "only a marker of the act or of PageFetch, with 16 hex digits");
});

test("no input: no Input.* event, no key, no permission grant; a dialog is dismissed, a popup closes (its requests fail); a download is counted, and the service calls no downloads.cancel (the receiver cancels it)", async () => {
  const w = new FetchWorld();
  w.pages[URL1] = {
    after: async (x) => {
      x.cdp("Page.javascriptDialogOpening", { type: "confirm", message: "Leave?" });
      x.emit({ ev: "tabs.onCreated", tab: { id: 61, incognito: true, openerTabId: 51, windowId: 60 } });
      await sleep(20);
      x.emit({ ev: "debugger.onEvent", source: { tabId: 61 }, method: "Fetch.requestPaused", params: { requestId: "pop-1", request: { url: "https://other.example.test/" } } });
      x.emit({ ev: "downloads.onCreated", item: { id: 7, incognito: true } });
    },
  };
  await w.fetcher().fetch(LOCAL, { url: URL1 });
  const m = w.methods();
  assert.ok(!m.some((x) => x.startsWith("Input.")), "no Input.* event");
  assert.ok(!m.some((x) => x.startsWith("Browser.")), "no Browser.* command (no permission grant)");
  assert.deepEqual(w.sent.find((s) => s.method === "Page.handleJavaScriptDialog")!.params, { accept: false });
  assert.ok(w.hidden.has(61), "the popup is hidden");
  assert.ok(w.calls.some((c) => c.op === "debugger.attach" && c.args[0] === 61), "the service's own session on the popup");
  assert.ok(w.sent.some((s) => s.tab === 61 && s.method === "Runtime.evaluate" && s.params.expression === "window.close()"), "the popup closes from an isolated world");
  assert.ok(w.sent.some((s) => s.tab === 61 && s.method === "Page.createIsolatedWorld"));
  assert.equal(w.answered.get("pop-1"), "fail", "a request of the popup fails");
  assert.ok(!w.calls.some((c) => c.op === "downloads.cancel"), "no downloads.cancel (review-168 B2: the receiver cancels a fetch window's download)");
  assert.match(w.log[0], /, 1 downloads, 0 websockets$/, "the log line counts the download");
});

test("a popup that the service cannot hold ends the fetch (unavailable), and the window ends", async () => {
  const w = new FetchWorld();
  w.failing.add("attach 61");
  w.pages[URL1] = { after: (x) => { x.emit({ ev: "webNavigation.onCreatedNavigationTarget", details: { sourceTabId: 51, tabId: 61 } }); } };
  const e = await refusal(w.fetcher().fetch(LOCAL, { url: URL1 }));
  assert.equal(e.code, "unavailable");
  assert.equal(e.message, "Not fetched (unavailable): The agent browser could not guard a frame, a worker or a popup of the page.");
  assert.equal(w.fetchEnds, 1);
});

// ------------------------------------------------------------------ the address rule

test("refused before any window: a scheme other than http(s), an IP literal of a refused range, a refused name, a name with a refused address among its addresses, a name with no address", async () => {
  const w = new FetchWorld();
  w.resolver["mixed.example.test"] = ["203.0.113.5", "10.0.0.7"];
  w.resolver["rebind.example.test"] = ["::ffff:127.0.0.1"];
  const f = w.fetcher();
  const cases: [string, string][] = [
    ["ftp://pages.example.test/", "The URL must use http or https."],
    ["file:///etc/hostname", "The URL must use http or https."],
    ["javascript:alert(1)", "The URL must use http or https."],
    ["not a url", "The URL must be an absolute http or https URL."],
    ["http://127.0.0.1:8080/", "The host 127.0.0.1 is a loopback address; PageFetch never reaches the box itself or a private network."],
    ["http://0x7f.1/", "The host 127.0.0.1 is a loopback address; PageFetch never reaches the box itself or a private network."],
    ["http://[::1]/", "The host ::1 is a loopback address; PageFetch never reaches the box itself or a private network."],
    ["http://169.254.169.254/latest/meta-data/", "The host 169.254.169.254 is a link-local address; PageFetch never reaches the box itself or a private network."],
    ["http://192.168.1.1/", "The host 192.168.1.1 is a private address; PageFetch never reaches the box itself or a private network."],
    ["http://100.64.0.9/", "The host 100.64.0.9 is a carrier-grade NAT address; PageFetch never reaches the box itself or a private network."],
    ["http://[fd12::1]/", "The host fd12::1 is a unique local address; PageFetch never reaches the box itself or a private network."],
    ["http://[::ffff:10.0.0.1]/", "The host ::ffff:a00:1 is a private address in an IPv6 form; PageFetch never reaches the box itself or a private network."],
    ["http://0.0.0.0/", "The host 0.0.0.0 is an unspecified address; PageFetch never reaches the box itself or a private network."],
    ["http://224.0.0.1/", "The host 224.0.0.1 is a multicast address; PageFetch never reaches the box itself or a private network."],
    ["http://app.localhost/", "The host app.localhost is a name of the box itself; PageFetch never reaches the box itself or a private network."],
    ["http://printer.local/", "The host printer.local is a name of the local network; PageFetch never reaches the box itself or a private network."],
    ["http://db.corp.internal/", "The host db.corp.internal is a name of a private network; PageFetch never reaches the box itself or a private network."],
    ["https://mixed.example.test/", "The host mixed.example.test has a private address; PageFetch never reaches the box itself or a private network."],
    ["https://rebind.example.test/", "The host rebind.example.test has a loopback address in an IPv6 form; PageFetch never reaches the box itself or a private network."],
    ["https://nowhere.example.test/", "The host nowhere.example.test has no address in the box's resolver; PageFetch never reaches the box itself or a private network."],
  ];
  for (const [url, text] of cases) {
    const e = await refusal(f.fetch(LOCAL, { url }));
    assert.equal(e.code, "refused", url);
    assert.equal(e.message, `Not fetched (refused): ${text}`, url);
  }
  assert.equal(w.calls.filter((c) => c.op === "windows.create").length, 0, "no window");
  // A refusal costs no fetch of the rate: 30 fetches still pass.
  for (let i = 0; i < 30; i++) await f.fetch(LOCAL, { url: `https://pages.example.test/p${i}` });
});

test("the guard: a redirect of the main document to a refused address fails it and refuses the fetch; a subrequest to one fails and the fetch goes on; a frame or worker gets the same guard before it runs", async () => {
  const w = new FetchWorld();
  w.pages["https://pages.example.test/r"] = { redirects: ["https://pages.example.test/r2", "http://10.1.1.1/admin"] };
  const e = await refusal(w.fetcher().fetch(LOCAL, { url: "https://pages.example.test/r" }));
  assert.equal(e.message, "Not fetched (refused): The page went on to another address, and the host 10.1.1.1 is a private address; PageFetch never reaches the box itself or a private network.");
  assert.deepEqual([...w.answered.values()], ["continue", "continue", "fail"]);
  assert.equal(w.fetchEnds, 1, "the window ends after the refusal");

  const v = new FetchWorld();
  const answers: Record<string, string> = {};
  v.pages[URL1] = {
    after: async (x) => {
      answers.sub = await x.pause("http://192.168.0.10/x.json");
      answers.ws = await x.pause("ws://127.0.0.1:9222/devtools");
      answers.ok = await x.pause("https://other.example.test/app.js", { type: "Script" });
      answers.data = await x.pause("data:text/plain,hi");
      x.cdp("Target.attachedToTarget", { sessionId: "S-worker", targetInfo: { type: "worker", url: "https://pages.example.test/w.js" }, waitingForDebugger: true });
      await sleep(30);
      answers.worker = await x.pause("http://[fe80::1]/", { session: "S-worker" });
      answers.workerOk = await x.pause("https://other.example.test/w-data", { session: "S-worker" });
    },
  };
  const text = await v.fetcher().fetch(LOCAL, { url: URL1 });
  assert.ok(text.startsWith(`URL: ${URL1}`));
  assert.deepEqual(answers, { sub: "fail", ws: "fail", ok: "continue", data: "continue", worker: "fail", workerOk: "continue" });
  const child = v.sent.filter((s) => s.session === "S-worker").map((s) => s.method);
  assert.deepEqual(child.slice(0, 4), ["Fetch.enable", "Target.setAutoAttach", "Network.enable", "Runtime.runIfWaitingForDebugger"], "the guard and the network events before the worker runs");
});

test("a frame or a worker whose guard fails ends the fetch, and it never runs", async () => {
  const w = new FetchWorld();
  w.failing.add("Fetch.enable S-frame");
  w.pages[URL1] = { after: (x) => { x.cdp("Target.attachedToTarget", { sessionId: "S-frame", targetInfo: { type: "iframe", url: "https://other.example.test/f" }, waitingForDebugger: true }); } };
  const e = await refusal(w.fetcher().fetch(LOCAL, { url: URL1 }));
  assert.equal(e.code, "unavailable");
  assert.ok(!w.sent.some((s) => s.session === "S-frame" && s.method === "Runtime.runIfWaitingForDebugger"));
});

test("review-168 B1: the service reads WebSockets and WebTransports in every session (the tab, a frame, a worker) and counts them: the fetch goes on; one whose host fails the address rule ends the fetch (refused)", async () => {
  const frame = (x: FetchWorld, id: string, type = "iframe") => x.cdp("Target.attachedToTarget", { sessionId: id, targetInfo: { type, url: "https://other.example.test/f" }, waitingForDebugger: true });
  // Public hosts in each session: counted, and the page's content comes (the receiver's rule blocks each connection).
  const w = new FetchWorld();
  w.pages[URL1] = {
    after: async (x) => {
      x.cdp("Network.webSocketCreated", { requestId: "ws1", url: "wss://pages.example.test/chat" });
      frame(x, "S-frame"); frame(x, "S-worker", "worker");
      await sleep(30);
      x.cdp("Network.webSocketCreated", { requestId: "ws2", url: "wss://other.example.test/live" }, "S-frame");
      x.cdp("Network.webTransportCreated", { transportId: "t1", url: "https://other.example.test/wt" }, "S-worker");
      await sleep(30);
    },
  };
  const text = await w.fetcher().fetch(LOCAL, { url: URL1 });
  assert.ok(text.startsWith(`URL: ${URL1}`), "the fetch goes on");
  assert.match(w.log[0], /, 0 downloads, 3 websockets$/, "three counted, no host or URL in the line");
  assert.ok(!/chat|live|\/wt/.test(w.log[0]));
  for (const id of ["S-frame", "S-worker"]) assert.ok(w.sent.some((s) => s.session === id && s.method === "Network.enable"), `${id}: its network events`);
  // A frame's WebSocket to a refused name, a worker's to a refused literal: refused.
  const text2 = (host: string, why: string) => `Not fetched (refused): The page opened a connection, and the host ${host} ${why}; PageFetch never reaches the box itself or a private network.`;
  const v = new FetchWorld();
  v.pages[URL1] = { after: async (x) => { frame(x, "S-frame"); await sleep(30); x.cdp("Network.webSocketCreated", { requestId: "ws3", url: "ws://localhost:6000/" }, "S-frame"); } };
  assert.equal((await refusal(v.fetcher().fetch(LOCAL, { url: URL1 }))).message, text2("localhost", "is a name of the box itself"), "a frame's WebSocket to a refused name");
  const x = new FetchWorld();
  x.pages[URL1] = { after: async (y) => { frame(y, "S-worker", "worker"); await sleep(30); y.cdp("Network.webTransportCreated", { transportId: "t2", url: "https://10.2.3.4:4433/wt" }, "S-worker"); } };
  assert.equal((await refusal(x.fetcher().fetch(LOCAL, { url: URL1 }))).message, text2("10.2.3.4", "is a private address"), "a worker's WebTransport to a refused literal");
  // A public name that resolves to a private address: the resolver's answer refuses it.
  const z = new FetchWorld();
  z.resolver["rebind.example.test"] = ["192.168.7.7"];
  z.pages[URL1] = { after: (y) => { y.cdp("Network.webSocketCreated", { requestId: "ws4", url: "wss://rebind.example.test/" }); } };
  assert.equal((await refusal(z.fetcher().fetch(LOCAL, { url: URL1 }))).message, text2("rebind.example.test", "has a private address"));
  assert.equal(z.fetchEnds, 1);
});


test("review-168 N1: a live child whose Target.setAutoAttach fails ends the fetch, and it never runs (fail closed)", async () => {
  for (const method of ["Target.setAutoAttach"]) {
    const w = new FetchWorld();
    w.failing.add(`${method} S-frame`);
    w.pages[URL1] = { after: (x) => { x.cdp("Target.attachedToTarget", { sessionId: "S-frame", targetInfo: { type: "iframe", url: "https://other.example.test/f" }, waitingForDebugger: true }); } };
    const e = await refusal(w.fetcher().fetch(LOCAL, { url: URL1 }));
    assert.equal(e.message, "Not fetched (unavailable): The agent browser could not guard a frame, a worker or a popup of the page.", method);
    assert.ok(!w.sent.some((s) => s.session === "S-frame" && s.method === "Runtime.runIfWaitingForDebugger"), `${method}: the child never runs`);
  }
});

test("the live run (board ab-v16.102): a child that Chrome detached before its guard (its Fetch.enable or Target.setAutoAttach failed) is skipped: the fetch goes on, the child never runs, and a log line says so", async () => {
  for (const method of ["Fetch.enable", "Target.setAutoAttach"]) {
    const w = new FetchWorld();
    w.failing.add(`${method} S-gone`);
    w.pages[URL1] = { after: (x) => {
      x.cdp("Target.attachedToTarget", { sessionId: "S-gone", targetInfo: { type: "iframe", url: "https://other.example.test/f" }, waitingForDebugger: true });
      x.cdp("Target.detachedFromTarget", { sessionId: "S-gone" });
    } };
    const text = await w.fetcher().fetch(LOCAL, { url: URL1 });
    assert.match(text, /^URL: /, method);
    assert.ok(!w.sent.some((s) => s.session === "S-gone" && s.method === "Runtime.runIfWaitingForDebugger"), `${method}: the child never runs`);
    assert.ok(w.log.includes(`page-fetch: a frame of the fetch ended before its guard (${method})`), `${method}: ${w.log.join(" | ")}`);
  }
});

test("the live run (board ab-v16.102): a child whose Network.enable alone fails runs with its guard, the fetch goes on, and a log line says so (the receiver's rule blocks every WebSocket of a fetch tab)", async () => {
  const w = new FetchWorld();
  w.failing.add("Network.enable S-worker");
  w.pages[URL1] = { after: (x) => { x.cdp("Target.attachedToTarget", { sessionId: "S-worker", targetInfo: { type: "worker", url: "https://pages.example.test/w.js" }, waitingForDebugger: true }); } };
  const text = await w.fetcher().fetch(LOCAL, { url: URL1 });
  assert.match(text, /^URL: /);
  const m = w.sent.filter((s) => s.session === "S-worker").map((s) => s.method);
  assert.ok(m.indexOf("Fetch.enable") >= 0 && m.indexOf("Target.setAutoAttach") > m.indexOf("Fetch.enable") && m.indexOf("Runtime.runIfWaitingForDebugger") > m.indexOf("Target.setAutoAttach"), `the guard first, then the run: ${m.join(", ")}`);
  assert.ok(w.log.includes("page-fetch: a worker of the fetch runs with no WebSocket reads (Network.enable failed: Network.enable failed)"), w.log.join(" | "));
});

test("the live run (board ab-v16.102): a popup that closed before its hold ended (window.close, or Chrome) is gone, and the fetch goes on; a live popup that cannot be held still ends the fetch", async () => {
  const w = new FetchWorld();
  // The popup's window.close() ends its page before the evaluation answers: the evaluation fails, and Chrome removes the tab.
  w.failing.add("Runtime.evaluate tab 61");
  w.pages[URL1] = { after: async (x) => {
    x.emit({ ev: "tabs.onCreated", tab: { id: 61, incognito: true, openerTabId: 51, windowId: 60 } });
    await sleep(20);
    x.emit({ ev: "tabs.onRemoved", tabId: 61 });
  } };
  const text = await w.fetcher().fetch(LOCAL, { url: URL1 });
  assert.match(text, /^URL: /);
  assert.ok(w.log.includes("page-fetch: a popup of the fetch closed before its hold ended (window.close)"), w.log.join(" | "));
  // A live popup (no removal) whose hold fails still ends the fetch.
  const v = new FetchWorld();
  v.failing.add("Runtime.evaluate tab 61");
  v.pages[URL1] = { after: (x) => { x.emit({ ev: "tabs.onCreated", tab: { id: 61, incognito: true, openerTabId: 51, windowId: 60 } }); } };
  const e = await refusal(v.fetcher().fetch(LOCAL, { url: URL1 }));
  assert.equal(e.message, "Not fetched (unavailable): The agent browser could not guard a frame, a worker or a popup of the page.");
  assert.ok(v.log.includes("page-fetch: a popup of the fetch got no guard (window.close failed: Runtime.evaluate failed)"), v.log.join(" | "));
});

test("the fourth live run (board ab-v16.102): a dedicated worker whose session has no Fetch domain (Chrome's -32601) loads through its frame, whose guard holds its requests: it runs, and the fetch goes on; a frame with no Fetch domain, and a worker whose Fetch.enable fails otherwise, still end the fetch", async () => {
  const worker = (x: FetchWorld, id: string, type: string) => x.cdp("Target.attachedToTarget", { sessionId: id, targetInfo: { type, url: "https://pages.example.test/w.js" }, waitingForDebugger: true });
  const w = new FetchWorld();
  for (const m of ["Fetch.enable", "Target.setAutoAttach", "Network.enable"]) w.missing.add(`${m} S-worker`);
  w.pages[URL1] = { after: async (x) => {
    worker(x, "S-worker", "worker");
    await sleep(30);
    // The worker's request comes to the tab's own guard (its frame's network stack): a refused address fails.
    void x.pause("http://127.0.0.1/leak", { type: "Fetch" }).then((how) => { (x as any).workerLeak = how; });
  } };
  const text = await w.fetcher().fetch(LOCAL, { url: URL1 });
  assert.match(text, /^URL: /);
  assert.ok(w.sent.some((s) => s.session === "S-worker" && s.method === "Runtime.runIfWaitingForDebugger"), "the worker runs");
  assert.equal((w as any).workerLeak, "fail", "the tab's guard fails the worker's request to a refused address");
  assert.ok(w.log.includes("page-fetch: a worker of the fetch has no Fetch domain; its frame's guard holds its requests"), w.log.join(" | "));
  // A frame with no Fetch domain has no such path: it ends the fetch, and it never runs.
  const f = new FetchWorld();
  f.missing.add("Fetch.enable S-frame");
  f.pages[URL1] = { after: (x) => { worker(x, "S-frame", "iframe"); } };
  assert.equal((await refusal(f.fetcher().fetch(LOCAL, { url: URL1 }))).code, "unavailable");
  assert.ok(!f.sent.some((s) => s.session === "S-frame" && s.method === "Runtime.runIfWaitingForDebugger"));
  // A worker whose Fetch.enable fails with another error is a live child with no guard.
  const v = new FetchWorld();
  v.failing.add("Fetch.enable S-worker");
  v.pages[URL1] = { after: (x) => { worker(x, "S-worker", "worker"); } };
  assert.equal((await refusal(v.fetcher().fetch(LOCAL, { url: URL1 }))).code, "unavailable");
  assert.ok(!v.sent.some((s) => s.session === "S-worker" && s.method === "Runtime.runIfWaitingForDebugger"));
});

test("review-168 N4: at most 64 different hosts in one fetch: each request to another host fails with no lookup, also a navigation, and the fetch goes on", async () => {
  const w = new FetchWorld();
  const looked: string[] = [];
  for (let i = 0; i < 70; i++) w.resolver[`h${i}.example.test`] = ["203.0.113.20"];
  const answers: string[] = [];
  w.pages[URL1] = {
    after: async (x) => {
      for (let i = 0; i < 70; i++) answers.push(await x.pause(`https://h${i}.example.test/a.js`, { type: "Script" }));
      answers.push(await x.pause("https://h1.example.test/again.js", { type: "Script" }));
      answers.push(await x.pageNavigates("https://h69.example.test/next"));
    },
  };
  const f = w.fetcher({ resolve: async (h) => { looked.push(h); const a = w.resolver[h]; if (!a) throw new Error("ENOTFOUND"); return a; } });
  const text = await f.fetch(LOCAL, { url: URL1 });
  assert.ok(text.startsWith(`URL: ${URL1}`), "the fetch goes on");
  assert.deepEqual(answers.slice(0, 63), Array(63).fill("continue"), "the page's host and 63 more");
  assert.deepEqual(answers.slice(63, 70), Array(7).fill("fail"), "the hosts past 64 fail");
  assert.equal(answers[70], "continue", "a host that the fetch checked before still passes");
  assert.equal(answers[71], "fail", "a navigation to a host past the limit fails, and the fetch is no refusal");
  assert.equal(looked.length, 65, "the URL's check before the window, then 64 hosts in the fetch: no lookup past the limit");
});


test("navigations: redirects and the page's own navigations count, at most 10 after the first (blocked past them); each is checked", async () => {
  const w = new FetchWorld();
  const chain = Array.from({ length: 10 }, (_, i) => `https://pages.example.test/hop${i + 1}`);
  w.pages["https://pages.example.test/hops"] = { redirects: chain };
  const ok = await w.fetcher().fetch(LOCAL, { url: "https://pages.example.test/hops" });
  assert.ok(ok.startsWith("URL: https://pages.example.test/hop10"), "10 navigations after the first pass");
  const v = new FetchWorld();
  v.pages["https://pages.example.test/hops"] = { redirects: [...chain, "https://pages.example.test/hop11"] };
  const e = await refusal(v.fetcher().fetch(LOCAL, { url: "https://pages.example.test/hops" }));
  assert.equal(e.message, "Not fetched (blocked): The page went through more than 10 navigations.");
  assert.equal(v.answered.size, 12);
  assert.equal([...v.answered.values()].pop(), "fail");
});

// ------------------------------------------------------------------ the waits

test("ready: the load event, no navigation for the settle time, no open request for the quiet time; a page that never loads gets timeout at the ready limit", async () => {
  const w = new FetchWorld();
  let finished = 0;
  w.pages[URL1] = {
    after: async (x) => {
      x.cdp("Network.requestWillBeSent", { requestId: "slow-1", request: { url: "https://other.example.test/slow" } });
      await sleep(200);
      finished = performance.now();
      x.cdp("Network.loadingFinished", { requestId: "slow-1" });
    },
  };
  await w.fetcher().fetch(LOCAL, { url: URL1 });
  const convert = w.sent.find((s) => s.method === "Runtime.evaluate" && s.params.expression.includes("aw-fetch:convert"))!;
  assert.ok(finished > 0 && convert.at >= finished + 10, "the conversion waits for the open request and the quiet time");
  const v = new FetchWorld();
  v.pages[URL1] = { noLoad: true };
  const t0 = performance.now();
  const e = await refusal(v.fetcher().fetch(LOCAL, { url: URL1 }));
  assert.equal(e.message, "Not fetched (timeout): The page did not load within 1.5 s.");
  assert.ok(performance.now() - t0 >= 1_400);
  assert.equal(v.fetchEnds, 1);
});

test("a page whose request never ends is converted at the ready limit; a navigation error is timeout; the whole limit is timeout", async () => {
  const w = new FetchWorld();
  w.pages[URL1] = { after: (x) => { x.cdp("Network.requestWillBeSent", { requestId: "stream", request: { url: "https://other.example.test/events" } }); } };
  const t0 = performance.now();
  await w.fetcher().fetch(LOCAL, { url: URL1 });
  assert.ok(performance.now() - t0 >= 1_400, "at the ready limit");
  const v = new FetchWorld();
  v.pages[URL1] = { navError: "net::ERR_CONNECTION_REFUSED" };
  assert.equal((await refusal(v.fetcher().fetch(LOCAL, { url: URL1 }))).message, "Not fetched (timeout): The page did not load (net::ERR_CONNECTION_REFUSED).");
  // The receiver's rule blocked the page or a redirect before the guard saw it (the fourth live run, board ab-v16.102: a
  // redirect of the main document to 127.0.0.1): refused, with no URL in the text.
  const b = new FetchWorld();
  b.pages[URL1] = { navError: "net::ERR_BLOCKED_BY_CLIENT" };
  assert.equal((await refusal(b.fetcher().fetch(LOCAL, { url: URL1 }))).message, "Not fetched (refused): The page or a redirect went to an address that the agent browser blocks; PageFetch never reaches the box itself or a private network.");
  assert.match(b.log.at(-1)!, /result refused,/);
  const x = new FetchWorld();
  x.pages[URL1] = { noLoad: true };
  const e = await refusal(x.fetcher({ limits: { readyMs: 5_000, wholeMs: 300 } }).fetch(LOCAL, { url: URL1 }));
  assert.equal(e.message, "Not fetched (timeout): The page did not finish within 0.3 s.");
  assert.equal(x.fetchEnds, 1, "the window ends after the whole limit");
});

test("a check that needs a click gives blocked at once; a check page that navigates on passes; one that stays gives blocked at the ready limit", async () => {
  const w = new FetchWorld();
  w.pages[URL1] = { check: { marks: { click: [".h-captcha"], check: [] } } };
  const t0 = performance.now();
  const e = await refusal(w.fetcher().fetch(LOCAL, { url: URL1 }));
  assert.equal(e.message, "Not fetched (blocked): The page shows a check that needs a person's click (hCaptcha); PageFetch never clicks.");
  assert.ok(performance.now() - t0 < 1_000, "at once, not at the limit");
  const v = new FetchWorld();
  v.pages[URL1] = { title: "Making sure you're not a bot!", check: { title: "Making sure you're not a bot!" }, after: async (x) => { await sleep(150); await x.pageNavigates("https://pages.example.test/passed"); } };
  v.pages["https://pages.example.test/passed"] = { title: "Passed" };
  const ok = await v.fetcher().fetch(LOCAL, { url: URL1 });
  assert.ok(ok.startsWith("URL: https://pages.example.test/passed\nTitle: Passed"), ok.slice(0, 80));
  const x = new FetchWorld();
  x.pages[URL1] = { check: { title: "Just a moment..." } };
  const b = await refusal(x.fetcher().fetch(LOCAL, { url: URL1 }));
  assert.equal(b.message, "Not fetched (blocked): The page stayed on a check page (Cloudflare) for 1.5 s.");
});

// ------------------------------------------------------------------ busy, unavailable

test("unavailable: a receiver with no fetch feature, an agent browser that is not ready, a remote admission; each before any window", async () => {
  const w = new FetchWorld();
  w.features = new Set(["scopes", "act"]);
  assert.equal((await refusal(w.fetcher().fetch(LOCAL, { url: URL1 }))).message, "Not fetched (unavailable): The agent extension has no fetch window; it needs a newer release.");
  w.features = new Set(["fetch"]);
  w.notReady = "The agent browser is not ready: its extension is not connected.";
  assert.equal((await refusal(w.fetcher().fetch(LOCAL, { url: URL1 }))).message, "Not fetched (unavailable): The agent browser is not ready: its extension is not connected.");
  assert.equal((await refusal(w.fetcher().fetch({ scope: "web-1", admission: "remote" }, { url: URL1 }))).message, "Not fetched (unavailable): PageFetch works only for sessions of this box.");
  assert.equal(w.calls.filter((c) => c.op === "windows.create").length, 0);
});

test("busy: an open private window of the operator; the queue past 8 waiting fetches; the scope's rate of 30 in 10 minutes, with the time to wait", async () => {
  const w = new FetchWorld();
  w.windowCreate = () => { throw new Error("another private window is open"); };
  assert.equal((await refusal(w.fetcher().fetch(LOCAL, { url: URL1 }))).message, "Not fetched (busy): A private window of the operator is open in the agent browser; try again after it closes.");
  assert.equal(w.fetchEnds, 0, "no window, no end");
  // The queue: one fetch holds the window, 8 wait, the next is busy.
  const lock = new WindowLock();
  const release = await lock.act(1000);
  const v = new FetchWorld();
  const f = v.fetcher({ lock });
  const waiting = Array.from({ length: 8 }, (_, i) => f.fetch(LOCAL, { url: `https://pages.example.test/q${i}` }));
  await sleep(20);
  assert.equal(lock.fetchesWaiting(), 8);
  assert.equal((await refusal(f.fetch(LOCAL, { url: URL1 }))).message, "Not fetched (busy): Eight fetches already wait for the agent browser's private window; try again later.");
  release!();
  await Promise.all(waiting);
  // The rate: 30 fetches in 10 minutes (the clock is the test's).
  let now = 1_000_000;
  const x = new FetchWorld();
  const g = x.fetcher({ now: () => now });
  for (let i = 0; i < 30; i++) { await g.fetch(LOCAL, { url: `https://pages.example.test/r${i}` }); now += 1_000; }
  assert.equal((await refusal(g.fetch(LOCAL, { url: URL1 }))).message, "Not fetched (busy): This session made 30 fetches in 10 minutes; try again in 570 s.");
  await g.fetch({ scope: "web-2", admission: "local" }, { url: URL1 });
  now += 570_000;
  await g.fetch(LOCAL, { url: URL1 });
});

test("the window's turn waits at most its limit: busy after it", async () => {
  const lock = new WindowLock();
  const release = await lock.act(1000);
  const w = new FetchWorld();
  const e = await refusal(w.fetcher({ lock, limits: { waitMs: 100 } }).fetch(LOCAL, { url: URL1 }));
  assert.equal(e.message, "Not fetched (busy): PageFetch waited 0 minutes for the agent browser's private window; try again later.");
  release!();
});

// ------------------------------------------------------------------ the conversion, paging, memory, limits

test("the conversion: mode whole gives Defuddle's whole options; main with fewer than 200 characters falls back to whole and says so", async () => {
  const w = new FetchWorld();
  w.pages[URL1] = { main: "Short." };
  const t = await w.fetcher().fetch(LOCAL, { url: URL1 });
  assert.match(header(t), /\nMode: whole \(main gave fewer than 200 characters\)\n/);
  assert.equal(body(t), "Menu\n\n# A test page\n\nThe whole test page.");
  assert.equal(w.seen.length, 2);
  assert.deepEqual(w.seen[1], { url: URL1, markdown: true, useAsync: false, removeHiddenElements: true, contentSelector: "body", removeLowScoring: false, removeExactSelectors: false, removePartialSelectors: false, removeContentPatterns: false });
  const v = new FetchWorld();
  const u = await v.fetcher().fetch(LOCAL, { url: URL1, mode: "whole" });
  assert.match(header(u), /\nMode: whole\n/);
  assert.equal(v.seen.length, 1);
  assert.equal(v.seen[0].contentSelector, "body");
  const x = new FetchWorld();
  for (const [args, text] of [[{ url: URL1, mode: "all" }, "mode must be main or whole."], [{ url: URL1, offset: -1 }, "offset must be a whole number of 0 or more."], [{ url: URL1, offset: 1.5 }, "offset must be a whole number of 0 or more."], [{}, "Give the URL of a page as the argument url."]] as const) {
    assert.equal((await refusal(x.fetcher().fetch(LOCAL, args as any))).message, `Not fetched (refused): ${text}`);
  }
  const y = new FetchWorld();
  y.failing.add("Runtime.evaluate");
  assert.equal((await refusal(y.fetcher({ screen: null }).fetch(LOCAL, { url: URL1 }))).code, "timeout", "no read of the page: timeout at the limit");
});

test("paging: at most 100,000 characters in one answer with the next offset; a read on comes from the scope's memory with no second window; past the end is refused", async () => {
  const w = new FetchWorld();
  const big = "x".repeat(250_000);
  w.pages[URL1] = { main: big };
  const f = w.fetcher();
  const a = await f.fetch(LOCAL, { url: URL1 });
  assert.match(header(a), /\nLength: 250000 characters\nPart: characters 0 to 100000; the next part starts at offset 100000$/);
  assert.equal(body(a).length, FETCH_LIMITS.partChars);
  const b = await f.fetch(LOCAL, { url: URL1, offset: 100_000 });
  assert.match(header(b), /Part: characters 100000 to 200000; the next part starts at offset 200000$/);
  const c = await f.fetch(LOCAL, { url: URL1, offset: 200_000 });
  assert.match(header(c), /Part: characters 200000 to 250000; the last part$/);
  assert.equal(body(c).length, 50_000);
  assert.equal(w.calls.filter((x) => x.op === "windows.create").length, 1, "one window for the three reads");
  assert.ok(w.log[1].includes("(from memory)") && w.log[2].includes("(from memory)"));
  assert.equal((await refusal(f.fetch(LOCAL, { url: URL1, offset: 250_000 }))).message, "Not fetched (refused): offset 250000 is past the end of the page's 250000 characters.");
  // Another scope has no memory of it: its read on fetches again; another mode too.
  await f.fetch({ scope: "web-2", admission: "local" }, { url: URL1, offset: 100_000 });
  assert.equal(w.calls.filter((x) => x.op === "windows.create").length, 2);
});

test("the memory: 15 minutes for each result, at most 20 results for each scope", async () => {
  let now = 5_000_000;
  const w = new FetchWorld();
  w.pages["*"] = { main: "y".repeat(150_000) };
  const f = w.fetcher({ now: () => now });
  const windows = () => w.calls.filter((x) => x.op === "windows.create").length;
  await f.fetch(LOCAL, { url: URL1 });
  now += FETCH_LIMITS.memoryMs - 1;
  await f.fetch(LOCAL, { url: URL1, offset: 100_000 });
  assert.equal(windows(), 1, "inside 15 minutes: from memory");
  now += 2;
  await f.fetch(LOCAL, { url: URL1, offset: 100_000 });
  assert.equal(windows(), 2, "after 15 minutes: a new fetch");
  for (let i = 0; i < 20; i++) await f.fetch(LOCAL, { url: `https://pages.example.test/m${i}` });
  const before = windows();
  await f.fetch(LOCAL, { url: "https://pages.example.test/m19", offset: 100_000 });
  assert.equal(windows(), before, "the 20th result is kept");
  await f.fetch(LOCAL, { url: URL1, offset: 100_000 });
  assert.equal(windows(), before + 1, "the oldest of 21 results is gone");
});

test("the service keeps at most keepChars characters of one page, and the header says so", async () => {
  const w = new FetchWorld();
  w.pages[URL1] = { main: "z".repeat(1_000) };
  const t = await w.fetcher({ limits: { keepChars: 600, partChars: 1_000 } }).fetch(LOCAL, { url: URL1 });
  assert.match(header(t), /\nLength: 600 characters \(the service keeps at most 600 characters of a page\)$/);
});

// ------------------------------------------------------------------ the end, the log

test("the end: fetch_end once more after 500 ms when it fails, within the end's limit; the window ends after every error that opened it", async () => {
  const w = new FetchWorld();
  let n = 0;
  w.fetchEnd = async () => { n++; if (n === 1) throw new Error("timeout"); return { closed: 1 }; };
  await w.fetcher().fetch(LOCAL, { url: URL1 });
  assert.equal(w.fetchEnds, 2);
  const v = new FetchWorld();
  v.fetchEnd = () => new Promise(() => {});
  const t0 = performance.now();
  await v.fetcher({ limits: { endMs: 300, receiverMs: 100 } }).fetch(LOCAL, { url: URL1 });
  assert.ok(performance.now() - t0 < 1_500, "a receiver that never answers holds the window at most the end's limit");
  assert.ok(v.log.some((l) => l === "page-fetch: fetch_end failed at the end's limit (timeout); the next private window or the receiver's start ends the fetch window"), v.log.join("\n"));
  const x = new FetchWorld();
  x.pages[URL1] = { check: { text: "Verify you are human by completing the action below." } };
  await refusal(x.fetcher().fetch(LOCAL, { url: URL1 }));
  assert.equal(x.fetchEnds, 1);
});

test("the log: one line for each call with the scope, the host, the result, the status, the time and the size; never the path, the query or the page's text", async () => {
  const w = new FetchWorld();
  w.pages[URL1] = { status: 403, main: "The secret page text of the test. ".repeat(10) };
  const t = await w.fetcher().fetch(LOCAL, { url: URL1 });
  assert.match(header(t), /\nStatus: 403\n/, "a status of 400 or more is no error");
  await refusal(w.fetcher().fetch(LOCAL, { url: "http://10.0.0.1/a-secret-path?token=test-query-value" }));
  assert.equal(w.log.length, 2);
  assert.match(w.log[0], /^page-fetch: scope web-1, host pages\.example\.test, result ok, status 403, \d+ ms, \d+ characters, 0 downloads, 0 websockets$/);
  assert.match(w.log[1], /^page-fetch: scope web-1, host 10\.0\.0\.1, result refused, status none, \d+ ms, 0 characters, 0 downloads, 0 websockets$/);
  for (const l of w.log) for (const s of ["a-secret-path", "token", "test-query-value", "secret page text", "/docs"]) assert.ok(!l.includes(s), `${s} in ${l}`);
});

test("review-168 N3: at each call the service removes the old results (15 minutes) and the old rate entries (10 minutes) of every scope, also of a scope that does not come back", async () => {
  let now = 9_000_000;
  const w = new FetchWorld();
  const f = w.fetcher({ now: () => now });
  for (const scope of ["web-1", "web-2", "web-3"]) await f.fetch({ scope, admission: "local" }, { url: URL1 });
  assert.deepEqual(f.kept(), { results: 3, scopes: 3, rates: 3 });
  now += FETCH_LIMITS.rateMs;
  await f.fetch({ scope: "web-4", admission: "local" }, { url: URL1, offset: 0 });
  assert.deepEqual(f.kept(), { results: 4, scopes: 4, rates: 1 }, "the rate's old fetches of web-1 to web-3 are gone; their results stay for 15 minutes");
  now += FETCH_LIMITS.memoryMs - FETCH_LIMITS.rateMs + 1;
  await refusal(f.fetch({ scope: "web-5", admission: "local" }, { url: "http://10.0.0.1/" }));
  assert.deepEqual(f.kept(), { results: 1, scopes: 1, rates: 1 }, "a refused call of another scope removes the old results of every scope");
});

test("review-168 B2, through the real model: an incognito download's events reach PageFetch's listener and no client; the log line counts it; the service calls no downloads.cancel", async () => {
  const { harness, lineOf } = await import("./fake-bridge.ts");
  const h = await harness();
  try {
    await h.ready(lineOf(["a.example"]));
    const model = h.relay.model;
    const port = model.actPort();
    const got: any[] = [];
    const client = model.open("s1", { send: (t: string) => got.push(JSON.parse(t)), close: () => {} }, null, "local");
    const w = new FetchWorld();
    // The fake tab's events go through the real model (C10's bridge events), as the receiver sends them.
    (w as any).emit = (ev: Record<string, any>) => { const { ev: name, ...fields } = ev; h.fake.emit(name, fields); };
    w.pages[URL1] = {
      after: async () => {
        h.fake.emit("downloads.onCreated", { item: { id: 501, url: "https://pages.example.test/file.bin", incognito: true, state: "in_progress" } });
        h.fake.emit("downloads.onChanged", { delta: { id: 501, state: { current: "interrupted", previous: "in_progress" } } });
        await sleep(30);
      },
    };
    const f = w.fetcher({ model: { notReady: () => null, call: w.model().call, hide: port.hide, listen: port.listen } });
    const text = await f.fetch(LOCAL, { url: URL1 });
    assert.ok(text.startsWith(`URL: ${URL1}`), "the page's events came through the real model");
    assert.match(w.log.at(-1)!, /, 1 downloads, 0 websockets$/, "the real model gave the download to PageFetch's listener");
    assert.equal(h.fake.requests.filter((r: any) => r.op === "downloads.cancel").length, 0, "no downloads.cancel");
    assert.ok(!got.some((m) => String(m.method ?? "").startsWith("Browser.download") || String(m.method ?? "").startsWith("Page.download")), "no client hears of it");
    void client;
  } finally { await h.close(); }
});
