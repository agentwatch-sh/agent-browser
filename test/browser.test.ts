// The library against the fake Chrome, through the real proxy (ported from vedlo's chrome.test.ts,
// which used a headless Chrome). No real browser starts and no site is contacted: the fixture
// pages live in the fake, and the only HTTP server is the test's own on 127.0.0.1.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentBrowser } from "../src/browser.ts";
import { parseKey, sendKey } from "../src/record.ts";
import { NotAllowedError, PinRequiredError, UsageError } from "../src/errors.ts";
import { resolveOptions } from "../src/options.ts";
import { proxyInfo, stopProxy } from "../src/proxy.ts";
import { TEXT } from "../src/relay/policy.ts";
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
  // In a window of its own (Linux, ab-v16.26) type sends one key-event pair per character; elsewhere inserted text.
  assert.deepEqual(fake.pages.get(tab.targetId)!.keys, tab.drive === "window" ? [..."hello", "Enter"] : ["Enter"]);
  await assert.rejects(tab.press("F13"), /unsupported key/);
  await tab.clickText("go");
  assert.match(await tab.text(), /ready/);
  await assert.rejects(tab.click("#nope"), /no element/);
  await assert.rejects(tab.click("#hidden"), /not visible/);
  await assert.rejects(tab.evaluate(() => { throw new Error("boom"); }), /boom/);
  await tab.close();
});

test("a function key goes to the page only: without nativeVirtualKeyCode, so Chrome never runs it as its own shortcut (#7)", async () => {
  const tab = await browser.open(base);
  const page = fake.pages.get(tab.targetId)!;
  const fkeys = Array.from({ length: 12 }, (_, i) => `F${i + 1}`);
  for (const f of fkeys) {
    await tab.press(f); // the press command
    await sendKey(tab, parseKey(`Shift+${f}`)); // record's press step
  }
  await tab.press("Enter");
  await sendKey(tab, parseKey("Shift+ArrowDown"));
  const fields = (key: string) => page.keyEvents.filter((k) => k.key === key).map((k) => [k.type, k.modifiers, k.keyCode, k.native]);
  for (const [i, f] of fkeys.entries())
    assert.deepEqual(fields(f), [["keyDown", 0, 112 + i, undefined], ["keyUp", 0, 112 + i, undefined], ["rawKeyDown", 8, 112 + i, undefined], ["keyUp", 8, 112 + i, undefined]], f);
  assert.deepEqual(fields("Enter"), [["keyDown", 0, 13, 13], ["keyUp", 0, 13, 13]], "other keys keep their native key code");
  assert.deepEqual(fields("ArrowDown"), [["rawKeyDown", 8, 40, 40], ["keyUp", 8, 40, 40]]);
  await tab.close();
});

test("a Tab method with an empty path is a usage error before any CDP call, never the current folder (ab-b84.9)", async () => {
  const tab = await browser.open(base);
  const calls = fake.callsFor(tab.targetId).length;
  for (const [what, run] of [
    ["screenshot", () => tab.screenshot("")], ["fetchToFile", () => tab.fetchToFile(base + "/", "")], ["download", () => tab.download(base + "/", "")],
    ["expectDownload", () => tab.expectDownload(async () => {}, "")], ["setFiles", () => tab.setFiles("#i", ["/tmp/a.txt", ""])],
  ] as [string, () => Promise<unknown>][]) {
    await assert.rejects(run(), (e: Error) => e instanceof UsageError && /empty/.test(e.message), what);
  }
  assert.equal(fake.callsFor(tab.targetId).length, calls, "no CDP call reached the tab");
  assert.equal(existsSync(".part"), false, "fetchToFile and download wrote no ./.part");
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

/** The calls of `fn` to the page of `targetId` that run code in it (an isolated world, an evaluate, a function call). */
async function pageCode(targetId: string, fn: () => Promise<unknown>): Promise<string[]> {
  const from = fake.calls.length;
  await fn();
  return fake.calls.slice(from).filter((x) => x.targetId === targetId && /^Runtime\.(evaluate|callFunctionOn|compileScript|runScript)$|^Page\.createIsolatedWorld$/.test(x.method)).map((x) => x.method);
}

test("ab-b84.20: the allowlist check runs no code in a page that is off the list: each refusal reads Chrome's target list and frame tree", async () => {
  // review-65 N4, review-70 note 7: assertAllowed read location.href with Runtime.evaluate in our isolated world, also in
  // an off-list page.
  const tab = await browser.open(base);
  await tab.click("#away");
  await new Promise((r) => setTimeout(r, 50));
  const from = fake.calls.length;
  const code = await pageCode(tab.targetId, async () => {
    for (const run of [() => tab.assertAllowed(), () => tab.text(), () => tab.click("#b"), () => tab.type("x"), () => tab.press("Enter"),
      () => tab.screenshot(join(c.dir, "off2.png")), () => tab.fetchToFile(`${base}/small.txt`, join(c.dir, "off2.txt"))])
      await assert.rejects(run(), NotAllowedError);
  });
  assert.deepEqual(code, [], "no code in the off-list page");
  const methods = new Set(fake.calls.slice(from).filter((x) => x.targetId === tab.targetId).map((x) => x.method));
  assert.ok(methods.has("Target.getTargetInfo"), [...methods].join(" "));
  assert.equal(await tab.url(), "https://elsewhere.invalid/", "Tab.url reads the frame tree");
  await tab.close();
});

test("ab-b84.20: the target list's URL can run ahead of the document (a navigation that the browser started, a new tab's first URL, an error page): the page passes only when both are on the list", async () => {
  const tab = await browser.open(base);
  const page = fake.pages.get(tab.targetId)!;
  try {
    // The document is on the list; the list shows an off-list navigation that has not committed: refused at once.
    page.listedUrl = "https://elsewhere.invalid/";
    assert.deepEqual(await pageCode(tab.targetId, () => assert.rejects(tab.assertAllowed(), /elsewhere\.invalid is not on the allowlist/)), []);
    // An off-list document under an allowlisted listed URL (a navigation from it that the browser started): refused, with
    // no code in that page.
    page.url = "https://elsewhere.invalid/";
    page.listedUrl = `${base}/next`;
    assert.deepEqual(await pageCode(tab.targetId, () => assert.rejects(tab.click("#b"), /elsewhere\.invalid is not on the allowlist/)), []);
    // An error page: the list shows the URL that failed, the document is Chrome's own error page.
    page.url = "chrome-error://chromewebdata/";
    assert.deepEqual(await pageCode(tab.targetId, () => assert.rejects(tab.text(), NotAllowedError)), []);
    // Both on the list: the page passes.
    page.url = `${base}/next`;
    page.listedUrl = undefined;
    await tab.assertAllowed();
  } finally { page.listedUrl = undefined; await tab.close(); }
});

// These URLs are identical in the target list and the frame tree. Only securityOrigin exposes the off-list opener.
for (const action of ["click", "type", "press", "shot"] as const) {
  test(`ab-b84.24: ${action} refuses about:blank of an off-list origin before code, input or capture`, async () => {
    const page = fake.addPage("about:blank");
    page.securityOrigin = "https://elsewhere.invalid";
    const tab = await browser.attach(page.targetId);
    try {
      const from = fake.calls.length;
      const run = action === "click" ? () => tab.click("#b") : action === "type" ? () => tab.type("x")
        : action === "press" ? () => tab.press("Enter") : () => tab.screenshot(join(c.dir, "blank-off.png"));
      await assert.rejects(run(), /elsewhere\.invalid is not on the allowlist/);
      const calls = fake.calls.slice(from).filter((x) => x.targetId === page.targetId);
      assert.deepEqual(calls.map((x) => x.method), ["Target.getTargetInfo", "Page.getFrameTree"],
        "one browser-side read first, one frame-tree read, no page code or capture");
      assert.equal(existsSync(join(c.dir, "blank-off.png")), false);
    } finally { await tab.close(); }
  });
}

test("ab-b84.24: an on-list blank origin passes; an external opaque blank fails even without its opener", async () => {
  const opener = fake.addPage(base);
  const page = fake.openFrom(opener, "about:blank");
  const tab = await browser.attach(page.targetId);
  try {
    page.securityOrigin = new URL(base).origin;
    assert.deepEqual(await pageCode(page.targetId, () => tab.assertAllowed()), []);
    for (const origin of ["null", "://", "", "about:blank"]) {
      page.securityOrigin = origin;
      assert.deepEqual(await pageCode(page.targetId, () => assert.rejects(tab.assertAllowed(), /unverified document origin/)), []);
    }
    page.url = "about:srcdoc"; // still refused by the URL check
    await assert.rejects(tab.assertAllowed(), NotAllowedError);
    page.url = "about:blank";
    // Losing the opener never proves a fresh origin (review I1).
    fake.closePage(opener);
    const lost = (await browser.conn.send("Target.getTargetInfo", { targetId: page.targetId })).targetInfo;
    assert.equal(lost.openerId, undefined);
    assert.equal(lost.openerFrameId, `F-${opener.targetId}`);
    for (const origin of ["null", "://", ""]) {
      page.securityOrigin = origin;
      assert.deepEqual(await pageCode(page.targetId, () => assert.rejects(tab.assertAllowed(), /unverified document origin/)), []);
    }
    page.securityOrigin = "https://elsewhere.invalid";
    await assert.rejects(tab.assertAllowed(), /elsewhere\.invalid is not on the allowlist/);
  } finally { await tab.close(); fake.pages.delete(opener.targetId); }
});

test("ab-b84.24: a new blank tab without an opener accepts input and a shot", async () => {
  const tab = await browser.open("about:blank");
  try {
    fake.pages.get(tab.targetId)!.securityOrigin = "://";
    await tab.press("Enter");
    const file = join(c.dir, "blank-new.png");
    await tab.screenshot(file);
    assert.ok(existsSync(file));
  } finally { await tab.close(); }
});

test("ab-b84.24: a created blank loses its trust after navigation or a new connection", async () => {
  const tab = await browser.open("about:blank");
  const other = await AgentBrowser.connect(c.options({ endpoint: fake.ws }));
  try {
    const attached = await other.attach(tab.targetId);
    await assert.rejects(attached.assertAllowed(), /unverified document origin/);
    await tab.assertAllowed();
    fake.navigate(fake.pages.get(tab.targetId)!, "about:blank");
    await assert.rejects(tab.assertAllowed(), /unverified document origin/);
  } finally { await other.disconnect(); await tab.close(); }
});

test("ab-b84.24: noopener links have no opener metadata", async () => {
  const tab = await browser.open(base);
  try {
    const page = fake.pages.get(tab.targetId)!;
    const link = page.select("#next")[0];
    link.setAttribute("href", `${base}/next`);
    link.setAttribute("target", "_blank");
    const from = new Set(fake.pages.keys());
    await tab.click("#next");
    const linked = [...fake.pages.values()].find((p) => !from.has(p.targetId))!;
    assert.ok(linked, "the noopener link opened a tab");
    assert.equal((await browser.conn.send("Target.getTargetInfo", { targetId: linked.targetId })).targetInfo.openerId, undefined);
    fake.closePage(linked);
  } finally { await tab.close(); }
});

test("ab-b84.24 round 2: a personal pinned window opens a usable blank", async () => {
  const owner = consumer();
  const personal = await AgentBrowser.connect(owner.options({ mode: "personal", endpoint: fake.ws }));
  try {
    const opener = await personal.open(base);
    const blank = await personal.open("about:blank");
    assert.equal(fake.pages.get(blank.targetId)!.opener?.targetId, opener.targetId);
    await blank.press("Enter");
    await blank.screenshot(join(owner.dir, "pinned-blank.png"));
    assert.ok(existsSync(join(owner.dir, "pinned-blank.png")));
    await blank.close();
    // The source must pass the document check before openInWindow runs any page code.
    const page = fake.pages.get(opener.targetId)!;
    page.url = "about:blank";
    page.securityOrigin = "https://elsewhere.invalid";
    assert.deepEqual(await pageCode(page.targetId, () => assert.rejects(personal.open("about:blank"), NotAllowedError)), []);
    await opener.close();
  } finally { await personal.disconnect(); stopProxy(resolveOptions(owner.options())); owner.remove(); }
});

test("ab-b84.24 round 2: navigation during attach clears blank trust before sessions.set", async () => {
  fake.onCreateTarget = (page) => { page.onPageEnable = () => { fake.navigate(page, "about:blank"); }; };
  try {
    const tab = await browser.open("about:blank");
    try { await assert.rejects(tab.assertAllowed(), /unverified document origin/); }
    finally { await tab.close(); }
  } finally { fake.onCreateTarget = undefined; }
});

test("ab-b84.24 round 2: goto clears blank trust without a frameNavigated event", async () => {
  const tab = await browser.open("about:blank");
  const page = fake.pages.get(tab.targetId)!;
  try {
    await tab.assertAllowed();
    page.suppressFrameNavigated = true;
    await tab.goto("about:blank");
    await assert.rejects(tab.assertAllowed(), /unverified document origin/);
  } finally { page.suppressFrameNavigated = false; await tab.close(); }
});

test("ab-b84.24 round 2: a created target still needs a known opaque origin or an on-list HTTP origin", async () => {
  const tab = await browser.open("about:blank");
  const page = fake.pages.get(tab.targetId)!;
  try {
    for (const origin of ["null", "://", "", new URL(base).origin]) {
      page.securityOrigin = origin;
      await tab.assertAllowed();
    }
    for (const origin of ["file://", "about:blank", "data:"]) {
      page.securityOrigin = origin;
      await assert.rejects(tab.assertAllowed(), /unverified document origin/);
    }
    page.securityOrigin = "https://elsewhere.invalid";
    await assert.rejects(tab.assertAllowed(), /elsewhere\.invalid is not on the allowlist/);
  } finally { await tab.close(); }
});

test("ab-b84.24 round 2: absent targetInfo fails with NotAllowedError before a frame read", async () => {
  const tab = await browser.open(base);
  const page = fake.pages.get(tab.targetId)!;
  try {
    page.omitTargetInfo = true;
    const from = fake.calls.length;
    await assert.rejects(tab.assertAllowed(), NotAllowedError);
    assert.deepEqual(fake.calls.slice(from).filter((x) => x.targetId === page.targetId).map((x) => x.method), ["Target.getTargetInfo"]);
  } finally { page.omitTargetInfo = false; await tab.close(); }
});

for (const kind of ["iframe", "other-tab", "second-top", "null-return", "iframe-only"] as const) {
  test(`ab-b84.24 round 3: a pinned blank excludes ${kind} popups from its creation trust`, async () => {
    const owner = consumer(), before = new Set(fake.pages.keys());
    const personal = await AgentBrowser.connect(owner.options({ mode: "personal", endpoint: fake.ws }));
    try {
      const opener = await personal.open(base);
      const page = fake.pages.get(opener.targetId)!;
      let own: string | undefined;
      page.onWindowOpen = () => {
        const source = kind === "other-tab" ? fake.addPage(base) : page;
        source.windowId = page.windowId;
        const intruder = fake.openFrom(source, "about:blank");
        if (kind === "iframe" || kind === "iframe-only") intruder.openerFrameId = `child-${page.targetId}`;
        if (kind !== "null-return" && kind !== "iframe-only") own = fake.openFrom(page, "about:blank").targetId;
        return kind !== "null-return";
      };
      if (kind === "iframe" || kind === "other-tab") {
        const tab = await personal.open("about:blank");
        assert.equal(tab.targetId, own, "only the source top frame's own target is selected");
        await tab.press("Enter");
      } else {
        const reason = kind === "second-top" ? /2 matching tabs.*all remain open/
          : kind === "null-return" ? /window.open returned no window/ : /timed out opening a tab in the pinned window/;
        await assert.rejects(personal.open("about:blank", { name: "mine" }), reason);
        const blanks = [...fake.pages.values()].filter((candidate) => !before.has(candidate.targetId)
          && candidate.targetId !== page.targetId && candidate.url === "about:blank");
        assert.ok(blanks.length > 0);
        for (const candidate of blanks) {
          assert.equal((await personal.allowedPages()).find((info) => info.targetId === candidate.targetId)?.name, undefined);
          assert.deepEqual(fake.callsFor(candidate.targetId).filter((call) => ["Target.attachToTarget", "Target.closeTarget"].includes(call.method)), [],
            "an uncertain target is neither taken nor closed");
        }
        // A known id still supports the goto escape after the failed open.
        const attached = await personal.attach(blanks[0].targetId);
        await assert.rejects(attached.assertAllowed(), /unverified document origin/);
        await attached.goto(base);
        await attached.assertAllowed();
      }
    } finally {
      await personal.disconnect();
      stopProxy(resolveOptions(owner.options()));
      owner.remove();
      for (const candidate of [...fake.pages.values()]) if (!before.has(candidate.targetId)) fake.closePage(candidate);
    }
  });
}

test("ab-b84.24 round 3: pinned creation never retries in a document that replaced its checked source", async () => {
  const owner = consumer(), before = new Set(fake.pages.keys());
  const personal = await AgentBrowser.connect(owner.options({ mode: "personal", endpoint: fake.ws }));
  try {
    const opener = await personal.open(base);
    const page = fake.pages.get(opener.targetId)!;
    let executed = 0, navigated = false;
    page.onWindowOpen = () => { executed++; fake.openFrom(page, "about:blank"); return true; };
    page.onEvaluate = ({ expression }) => {
      if (!navigated && expression?.includes("window.open")) {
        navigated = true;
        fake.navigate(page, "https://elsewhere.invalid/");
      }
    };
    const from = fake.calls.length;
    await assert.rejects(personal.open("about:blank"), /context/);
    assert.equal(executed, 0, "no window.open code executes in the replacement document");
    const calls = fake.calls.slice(from).filter((call) => call.targetId === page.targetId);
    const evals = calls.filter((call) => call.method === "Runtime.evaluate" && String(call.params.expression).includes("window.open"));
    assert.equal(evals.length, 1, "one call against the old world, with no retry");
    const world = calls.findIndex((call) => call.method === "Page.createIsolatedWorld");
    const check = calls.findIndex((call) => call.method === "Target.getTargetInfo");
    assert.ok(world >= 0 && check > world, "the world exists before the source check");
    assert.equal([...fake.pages.values()].filter((candidate) => !before.has(candidate.targetId)).length, 1, "no new popup gets trust");
  } finally {
    await personal.disconnect(); stopProxy(resolveOptions(owner.options())); owner.remove();
    for (const candidate of [...fake.pages.values()]) if (!before.has(candidate.targetId)) fake.closePage(candidate);
  }
});

test("ab-b84.24 round 4: a person's new tab during an unmatched open is neither taken nor closed", async () => {
  const owner = consumer(), before = new Set(fake.pages.keys());
  const personal = await AgentBrowser.connect(owner.options({ mode: "personal", endpoint: fake.ws }));
  let person: string | undefined;
  try {
    const opener = await personal.open(base), source = fake.pages.get(opener.targetId)!;
    source.onWindowOpen = () => {
      const page = fake.addPage("about:blank");
      page.windowId = source.windowId;
      person = page.targetId;
      return true;
    };
    await assert.rejects(personal.open("about:blank", { name: "mine" }), /timed out opening a tab in the pinned window/);
    assert.ok(person && fake.pages.has(person), "the person's tab stays open");
    assert.equal((await personal.allowedPages()).find((page) => page.targetId === person)?.name, undefined, "no name is assigned to the person's tab");
    assert.deepEqual(fake.callsFor(person!).filter((call) => ["Target.attachToTarget", "Target.closeTarget"].includes(call.method)), []);
  } finally {
    await personal.disconnect(); stopProxy(resolveOptions(owner.options())); owner.remove();
    for (const candidate of [...fake.pages.values()]) if (!before.has(candidate.targetId)) fake.closePage(candidate);
  }
});

test("ab-b84.24 round 4: the confirmed blank outside the pinned window is closed with the original error", async () => {
  const owner = consumer(), before = new Set(fake.pages.keys());
  const personal = await AgentBrowser.connect(owner.options({ mode: "personal", endpoint: fake.ws }));
  let misplaced: string | undefined;
  try {
    const opener = await personal.open(base), source = fake.pages.get(opener.targetId)!;
    source.onWindowOpen = () => {
      const page = fake.openFrom(source, "about:blank");
      page.windowId = source.windowId + 1000;
      misplaced = page.targetId;
      return true;
    };
    await assert.rejects(personal.open("about:blank"), /new tab landed outside the pinned window; closed it/);
    assert.ok(misplaced && !fake.pages.has(misplaced), "only the confirmed misplaced tab is closed");
    assert.ok(fake.pages.has(source.targetId), "the source stays open");
    assert.equal(fake.callsFor(misplaced!).filter((call) => call.method === "Target.closeTarget").length, 1);
  } finally {
    await personal.disconnect(); stopProxy(resolveOptions(owner.options())); owner.remove();
    for (const candidate of [...fake.pages.values()]) if (!before.has(candidate.targetId)) fake.closePage(candidate);
  }
});

test("ab-b84.24: Tab.url joins the frame URL and urlFragment without page code", async () => {
  const tab = await browser.open(`${base}/next#part?x=1`);
  try {
    assert.deepEqual(await pageCode(tab.targetId, async () => {
      assert.equal(await tab.url(), `${base}/next#part?x=1`);
      await tab.assertAllowed();
    }), []);
  } finally { await tab.close(); }
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
  await browser.pinWindow(winA);
  try {
    const ids = (await browser.allowedPages()).map((p) => p.targetId);
    assert.ok(ids.includes(a.targetId) && !ids.includes(b.targetId));
    await assert.rejects(browser.find("?other"), /no allowlisted tab/);
    const cTab = await browser.open(`${base}/?third`);
    assert.equal(await browser.windowOf(cTab.targetId), winA, "opened from a tab in the pinned window");
    await cTab.close();
  } finally {
    await browser.pinWindow(undefined);
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
    await personal.pinWindow(undefined);
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

test("a refused open closes the empty tab that it created, and reports the refusal (ab-v16.59)", async () => {
  const before = new Set(fake.pages.keys());
  // The relay refuses an off-list navigation with this CDP error (relay/policy.ts TEXT.notAllowed).
  fake.failOnce.set("Page.navigate", "Not allowed: other.example.org is not on the allowlist");
  await assert.rejects(browser.open(base), /Not allowed: other\.example\.org/);
  assert.deepEqual([...fake.pages.keys()].filter((id) => !before.has(id)), [], "the empty tab is closed: no new tab stays");
});

test("a failed navigation that is not a refusal keeps the tab of open, and a tab that open did not create stays (ab-v16.59)", async () => {
  const existing = await browser.open(base);
  fake.failOnce.set("Page.navigate", "net::ERR_CONNECTION_REFUSED");
  const ids = new Set(fake.pages.keys());
  await assert.rejects(browser.open(base), /ERR_CONNECTION_REFUSED/);
  assert.equal(fake.pages.size, ids.size + 1, "a load error is not a refusal: the new tab stays");
  assert.ok(fake.pages.has(existing.targetId), "the other tab stays");
  fake.failOnce.set("Page.navigate", "Not allowed: x.example.org is not on the allowlist");
  await assert.rejects(existing.goto(base), /Not allowed/);
  assert.ok(fake.pages.has(existing.targetId), "goto of an existing tab never closes it");
});

test("a failed Page.navigate of goto leaves no unseen rejection of the load wait, also after its short timeout (ab-v16.61)", async () => {
  const tab = await browser.open(base);
  const unseen: unknown[] = [];
  const on = (e: unknown) => { unseen.push(e); };
  process.on("unhandledRejection", on);
  try {
    // The command fails at once; the load wait (timeoutMs 40) would reject 40 ms later, with nobody to see it.
    fake.failOnce.set("Page.navigate", "net::ERR_CONNECTION_REFUSED");
    await assert.rejects(tab.goto(base, { timeoutMs: 40 }), /ERR_CONNECTION_REFUSED/);
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(unseen, [], "no unhandled rejection");
  } finally { process.off("unhandledRejection", on); }
  await tab.close();
});

test("open closes the empty tab for the relay's refusal text TEXT.notAllowed, so a change of that text fails here (ab-v16.61)", async () => {
  const before = new Set(fake.pages.keys());
  // The text that the relay sends (src/relay/policy.ts), not a copy of it: open's match must follow it.
  fake.failOnce.set("Page.navigate", TEXT.notAllowed("other.example.org"));
  await assert.rejects(browser.open(base), /^Error: Page\.navigate: Not allowed: other\.example\.org/);
  assert.deepEqual([...fake.pages.keys()].filter((id) => !before.has(id)), [], "the empty tab is closed");
});
