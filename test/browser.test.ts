// The library against the fake Chrome, through the real proxy (ported from vedlo's chrome.test.ts,
// which used a headless Chrome). No real browser starts and no site is contacted: the fixture
// pages live in the fake, and the only HTTP server is the test's own on 127.0.0.1.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentBrowser } from "../src/browser.ts";
import { NotAllowedError, PinRequiredError } from "../src/errors.ts";
import { resolveOptions } from "../src/options.ts";
import { proxyInfo, stopProxy } from "../src/proxy.ts";
import { FakeChrome } from "./fake-chrome.ts";
import { BIN, consumer, fixtureServer, site, type Consumer, type Fixture } from "./helpers.ts";

let fx: Fixture, fake: FakeChrome, c: Consumer, browser: AgentBrowser, base: string;

before(async () => {
  fx = await fixtureServer();
  base = fx.base;
  fake = await FakeChrome.start(site(base));
  c = consumer();
  browser = await AgentBrowser.connect(c.options({ endpoint: fake.ws }));
});

after(async () => {
  await browser?.disconnect();
  stopProxy(resolveOptions(c.options()));
  await fake?.close();
  await fx?.close();
  c?.remove();
});

test("every connection goes through the consumer's proxy socket, sharing one upstream connection", async () => {
  assert.equal(proxyInfo(resolveOptions(c.options()))?.upstream, fake.ws);
  const second = await AgentBrowser.connect(c.options({ endpoint: fake.ws }));
  try {
    assert.match(second.product, /FakeChrome/);
    assert.equal(fake.connections, 1, "the fake Chrome saw one connection: the proxy's");
  } finally { await second.disconnect(); }
});

test("refuses to open or navigate off the allowlist", async () => {
  await assert.rejects(browser.open("http://localhost:1/"), NotAllowedError);
  const tab = await browser.open(base);
  await assert.rejects(tab.goto("https://example.com/"), NotAllowedError);
  await assert.rejects(tab.goto("file:///etc/passwd"), NotAllowedError);
  await tab.close();
});

test("only allowlisted tabs are listed or findable; another tab is never attached, read or touched", async () => {
  const mail = fake.addPage("https://mail.example.org/inbox");
  fake.otherTargets.push({ targetId: "SW1", type: "service_worker", url: `${base}/sw.js`, title: "" });
  try {
    const pages = await browser.allowedPages();
    assert.ok(!pages.some((p) => p.targetId === mail.targetId));
    assert.ok(!pages.some((p) => p.targetId === "SW1"), "only page targets");
    await assert.rejects(browser.find(mail.targetId), /no allowlisted tab/);
    await assert.rejects(browser.find("inbox"), /no allowlisted tab/);
    await assert.rejects(browser.attach(mail.targetId), NotAllowedError);
    assert.ok((await browser.otherPageCount()) >= 1);
    assert.deepEqual(fake.callsFor(mail.targetId), [], "no CDP call ever named the mail tab");
  } finally {
    fake.otherTargets.length = 0;
    fake.pages.delete(mail.targetId);
  }
});

test("named tabs persist in the consumer's registry", async () => {
  const tab = await browser.open(base, { name: "work" });
  const found = await browser.find("work");
  assert.equal(found.targetId, tab.targetId);
  assert.equal((await browser.allowedPages()).find((p) => p.targetId === tab.targetId)?.name, "work");
  assert.deepEqual(JSON.parse(readFileSync(join(c.stateDir, "tabs.json"), "utf8")), { work: tab.targetId });
  await tab.close();
  await assert.rejects(browser.find("work"));
});

test("evaluate, waitFor, click, type, press, text", async () => {
  const tab = await browser.open(base);
  assert.equal(await tab.evaluate((a: number, b: number) => a + b, 2, 3), 5);
  assert.equal(await tab.waitFor(() => document.querySelector("#later")!.textContent === "ready" && "yes"), "yes");
  await tab.click("#b");
  assert.equal(await tab.evaluate(() => document.title), "clicked");
  await tab.type("hello", "#i");
  assert.equal(await tab.evaluate(() => (document.querySelector("#i") as HTMLInputElement).value), "hello");
  await tab.press("Enter");
  assert.deepEqual(fake.pages.get(tab.targetId)!.keys, ["Enter"]);
  await assert.rejects(tab.press("F13"), /unsupported key/);
  await tab.clickText("go");
  assert.match(await tab.text(), /ready/);
  await assert.rejects(tab.click("#nope"), /no element/);
  await assert.rejects(tab.click("#hidden"), /not visible/);
  await assert.rejects(tab.evaluate(() => { throw new Error("boom"); }), /boom/);
  await tab.close();
});

test("injected code runs in an isolated world, and the Runtime domain is never enabled", async () => {
  const tab = await browser.open(base);
  assert.equal(await tab.evaluate(() => 1 + 1), 2);
  const forTab = fake.callsFor(tab.targetId);
  assert.ok(forTab.some((c) => c.method === "Page.createIsolatedWorld"), "an isolated world is created");
  const evals = forTab.filter((c) => c.method === "Runtime.evaluate");
  assert.ok(evals.length > 0 && evals.every((c) => typeof c.params.contextId === "number"), "every evaluate targets the isolated world");
  assert.ok(!fake.calls.some((c) => c.method === "Runtime.enable"), "the Runtime domain is never enabled");
  await tab.close();
});

test("evaluate recovers after a navigation destroys the isolated world", async () => {
  const tab = await browser.open(base);
  await tab.evaluate(() => 1);
  await tab.goto(`${base}/next`); // destroys the isolated world
  assert.equal(await tab.evaluate(() => document.title), "next", "a new world is made and the call retried");
  const worlds = fake.callsFor(tab.targetId).filter((c) => c.method === "Page.createIsolatedWorld").length;
  assert.ok(worlds >= 2, "a fresh isolated world after the navigation");
  await tab.close();
});

test("a tab that wanders off the allowlist is refused before any read or input", async () => {
  const tab = await browser.open(base);
  await tab.click("#away");
  await new Promise((r) => setTimeout(r, 50));
  await assert.rejects(tab.text(), NotAllowedError);
  await assert.rejects(tab.click("#b"), NotAllowedError);
  await assert.rejects(tab.type("x"), NotAllowedError);
  await assert.rejects(tab.press("Enter"), NotAllowedError);
  await assert.rejects(tab.screenshot(join(c.dir, "off.png")), NotAllowedError);
  await assert.rejects(tab.fetchToFile(`${base}/small.txt`, join(c.dir, "off.txt")), NotAllowedError);
  assert.ok(!(await browser.allowedPages()).some((p) => p.targetId === tab.targetId), "no longer listed");
  await tab.close();
});

test("setFiles fills a file input", async () => {
  const tab = await browser.open(base);
  const f = join(c.dir, "up.txt");
  writeFileSync(f, "x");
  await tab.setFiles("#f", [f]);
  assert.equal(await tab.evaluate(() => (document.querySelector("#f") as HTMLInputElement).files![0].name), "up.txt");
  await tab.close();
});

test("screenshot writes a PNG", async () => {
  const tab = await browser.open(base);
  const p = await tab.screenshot(join(c.dir, "s.png"), { fullPage: true });
  assert.deepEqual([...readFileSync(p).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  const shot = fake.calls.filter((x) => x.method === "Page.captureScreenshot").at(-1)!;
  assert.equal(shot.params.clip.height, 2400, "--full clips to the page's content size");
  await tab.close();
});

test("fetchToFile streams a large file intact", async () => {
  const tab = await browser.open(base);
  const out = join(c.dir, "fetched.bin");
  const r = await tab.fetchToFile(`${base}/file.bin`, out);
  assert.equal(r.bytes, BIN.length);
  assert.equal(r.contentType, "application/octet-stream");
  assert.ok(readFileSync(out).equals(BIN));
  await assert.rejects(tab.fetchToFile(`${base}/missing`, join(c.dir, "missing")), /HTTP 404/);
  await assert.rejects(tab.fetchToFile("https://mail.example.org/export", join(c.dir, "mail")), NotAllowedError, "the URL is fetched with the profile's cookies, so it must be allowlisted");
  await tab.close();
});

test("download streams through Chrome's network stack", async () => {
  const tab = await browser.open(base);
  const out = join(c.dir, "downloaded.bin");
  const r = await tab.download(`${base}/file.bin`, out);
  assert.deepEqual(r, { bytes: BIN.length, status: 200 });
  assert.ok(readFileSync(out).equals(BIN));
  await assert.rejects(tab.download("https://cdn.elsewhere.invalid/media.bin", join(c.dir, "media.bin")), NotAllowedError);
  assert.ok(!fake.calls.some((x) => x.method === "Network.loadNetworkResource" && String(x.params.url).includes("elsewhere")), "never requested");
  await tab.close();
});

test("expectDownload captures a click-triggered download", async () => {
  const tab = await browser.open(base);
  const d = await tab.expectDownload(() => tab.click("#dl"), join(c.dir, "dl"));
  assert.equal(d.suggestedFilename, "out.bin");
  assert.ok(readFileSync(d.path).equals(BIN));
  assert.equal(fake.calls.filter((x) => x.method === "Browser.setDownloadBehavior").at(-1)!.params.behavior, "default", "restored");
  await tab.close();
});

test("expectResponse captures an API response body", async () => {
  const tab = await browser.open(base);
  const r = await tab.expectResponse((u) => u.endsWith("/api/data"), () => tab.click("#api"));
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.body), { ok: true });
  await tab.close();
});

test("a pinned window confines listing, attaching and opening", async () => {
  const a = await browser.open(base, { newWindow: true });
  const b = await browser.open(`${base}/?other`, { newWindow: true });
  const winA = await browser.windowOf(a.targetId);
  assert.notEqual(winA, await browser.windowOf(b.targetId));
  browser.pinWindow(winA);
  try {
    const ids = (await browser.allowedPages()).map((p) => p.targetId);
    assert.ok(ids.includes(a.targetId) && !ids.includes(b.targetId));
    await assert.rejects(browser.find("?other"), /no allowlisted tab/);
    const cTab = await browser.open(`${base}/?third`);
    assert.equal(await browser.windowOf(cTab.targetId), winA, "opened from a tab in the pinned window");
    await cTab.close();
  } finally {
    browser.pinWindow(undefined);
    await a.close();
    await b.close();
  }
});

test("personal mode acts only in the caller's own pinned window, which its first open creates", async () => {
  const p = consumer();
  const operatorTab = fake.addPage(`${base}/?operator`); // an allowlisted tab of the operator's, in their window
  const mail = fake.addPage("https://mail.example.org/");
  const personal = await AgentBrowser.connect(p.options({ mode: "personal", endpoint: fake.ws }));
  try {
    assert.equal(personal.pinnedWindow(), undefined);
    await assert.rejects(personal.find("?operator"), PinRequiredError, "nothing acts before a window is pinned");
    await assert.rejects(personal.open(base, { newWindow: false }), PinRequiredError, "--tab needs a pinned window");
    const own = await personal.open(base);
    const win = personal.pinnedWindow();
    assert.equal(win, await personal.windowOf(own.targetId), "the new window is pinned at once");
    assert.notEqual(win, operatorTab.windowId, "a window of its own, not the operator's");
    const ids = (await personal.allowedPages()).map((t) => t.targetId);
    assert.deepEqual(ids, [own.targetId], "the operator's tabs are out of scope");
    const second = await personal.open(`${base}/next`);
    assert.equal(await personal.windowOf(second.targetId), win, "later tabs open in the same window");
    personal.pinWindow(undefined);
    await assert.rejects(own.text(), PinRequiredError, "an unpinned personal browser stops acting");
    assert.deepEqual(fake.callsFor(mail.targetId), [], "an off-list tab: no call at all");
    assert.deepEqual(fake.callsFor(operatorTab.targetId).filter((x) => x.method !== "Browser.getWindowForTarget"), [],
      "the operator's allowlisted tab: only asked for its window (to keep it out of scope), never attached or read");
    await own.close().catch(() => {});
    await second.close().catch(() => {});
  } finally {
    await personal.disconnect();
    stopProxy(resolveOptions(p.options()));
    fake.pages.delete(operatorTab.targetId);
    fake.pages.delete(mail.targetId);
    p.remove();
  }
});

test("two consumers have their own state, socket, proxy and tab names", async () => {
  const other = consumer();
  const b2 = await AgentBrowser.connect(other.options({ endpoint: fake.ws }));
  try {
    const s1 = resolveOptions(c.options()), s2 = resolveOptions(other.options());
    assert.notEqual(s1.socketPath, s2.socketPath);
    assert.notEqual(s1.profileDir, s2.profileDir);
    assert.notEqual(proxyInfo(s1)?.pid, proxyInfo(s2)?.pid, "a proxy each");
    const mine = await browser.open(base, { name: "mine" });
    await assert.rejects(b2.find("mine"), /no allowlisted tab/, "the name is only in its own registry");
    await mine.close();
  } finally {
    await b2.disconnect();
    stopProxy(resolveOptions(other.options()));
    other.remove();
  }
});
