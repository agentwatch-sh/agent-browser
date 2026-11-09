// The real CLI, a fake Chrome, and agent mode's real relay download emulation. No browser starts.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs, { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { AgentBrowser } from "../src/browser.ts";
import { commands } from "../src/commands.ts";
import { NotAllowedError, UsageError } from "../src/errors.ts";
import { withInputLock } from "../src/input.ts";
import { resolveOptions } from "../src/options.ts";
import { stopProxy } from "../src/proxy.ts";
import { FakeChrome } from "./fake-chrome.ts";
import { backByChrome, harness, lineOf, type Harness } from "./fake-bridge.ts";
import { cli, consumer, flags, FIXTURE_HOST, fixtureServer, site } from "./helpers.ts";

const CONTENT = "date,value\n2026-11-08,42\n";

async function setup(agent = false) {
  const fx = await fixtureServer(FIXTURE_HOST), c = consumer([FIXTURE_HOST]);
  const chrome = await FakeChrome.start(site(fx.base));
  let h: Harness | undefined, end: (() => void) | undefined;
  if (agent) { h = await harness(); end = await backByChrome(h.fake, chrome); await h.ready(lineOf([FIXTURE_HOST])); }
  const o = c.options(agent ? { cdpUrl: h!.url("download-test") } : { endpoint: chrome.ws, noLaunch: true });
  const opened = await commands.open(o, { url: fx.base, name: "export" });
  const page = chrome.pages.get(opened.tab.targetId)!;
  await commands.outline(o, { tab: "export" });
  const args = agent ? ["--state-dir", c.stateDir, "--allowlist", c.allowlist, "--cdp-url", h!.url("download-test")] : flags(c, chrome.ws);
  let serial = 0;
  // The stand-in browser emits real CDP events. The relay must copy the file from Chrome's folder.
  // `follow`: the click requests `url`, and the events give the URL after every redirect, as Chrome does (fetchDownload).
  function download(url = fx.base + "/export.csv", state = "completed", immediate = true, dangerous = false, follow = false) {
    page.select("#b")[0].onclick = !follow ? () => start(url) : async () => {
      const { url: final, response } = await chrome.fetchDownload(url);
      await response.body?.cancel();
      start(final);
    };
    function start(url: string) {
      page.title = "download-started";
      const guid = `download-${++serial}`;
      const event = (method: string, params: object) => {
        if (h) {
          const tabId = h.fake.sent("debugger.sendCommand").at(-1)!.args[0].tabId;
          h.fake.emit("debugger.onEvent", { source: { tabId }, method: method.replace("Browser.", "Page."), params });
        } else (chrome as any).broadcast(method, params);
      };
      if (h) {
        const saved = join(c.dir, guid + ".chrome");
        writeFileSync(saved, CONTENT);
        h.fake.downloads.push({ id: serial, url, filename: saved, state: state === "completed" ? "complete" : "in_progress" });
      } else {
        const behavior = chrome.calls.filter((x) => x.method === "Browser.setDownloadBehavior").at(-1)?.params;
        if (behavior?.downloadPath) writeFileSync(join(behavior.downloadPath, guid), CONTENT);
      }
      event("Browser.downloadWillBegin", { guid, frameId: `F-${page.targetId}`, url, suggestedFilename: "report.csv" });
      if (h) h.fake.emit("downloads.onCreated", { item: { id: serial, url, state: "in_progress", danger: "safe" } });
      if (dangerous && h) h.fake.emit("downloads.onChanged", { delta: { id: serial, danger: { current: "file" } } });
      const progress = () => event("Browser.downloadProgress", { guid, state, totalBytes: CONTENT.length, receivedBytes: CONTENT.length });
      if (state !== "inProgress") { if (immediate) progress(); else setTimeout(progress, 30); }
    }
  }
  return { fx, c, chrome, page, h, o, args, download,
    run: (tail: string[], json = true) => cli(["click", "export", ...tail, ...args, ...(json ? ["--json"] : [])], { cwd: c.dir }),
    async close() { stopProxy(resolveOptions(o)); end?.(); await h?.close(); await chrome.close(); await fx.close(); c.remove(); },
  };
}

for (const agent of [false, true]) {
  const mode = agent ? "agent relay" : "default proxy";
  test(`${mode}: CLI click saves a download and reports path, suggested name, URL and bytes`, async () => {
    const f = await setup(agent);
    try {
      f.download();
      const r = await f.run(["#1", "--download", "downloads"]);
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.deepEqual(r.json.download, { path: join(f.c.dir, "downloads/report.csv"), suggestedFilename: "report.csv", url: f.fx.base + "/export.csv", bytes: CONTENT.length });
      assert.equal(readFileSync(r.json.download.path, "utf8"), CONTENT);
      assert.deepEqual(readdirSync(join(f.c.dir, "downloads")), ["report.csv"]);
      f.download("blob:" + f.fx.base + "/uuid");
      const text = await f.run(["--text", "Go", "--download", "downloads", "--timeout", "5000"], false);
      assert.equal(text.status, 0, text.stderr);
      assert.match(text.stdout, /report.*csv/);
      assert.ok(text.stdout.includes("blob:" + f.fx.base + "/uuid"));
      assert.ok(text.stdout.includes(`${CONTENT.length} bytes`));
      assert.equal(readdirSync(join(f.c.dir, "downloads")).length, 2, "a later download keeps the first file");
      f.download("data:text/csv,local-export");
      const data = await f.run(["#b", "--download", "downloads", "--timeout", "5000"]);
      assert.equal(data.status, 0, data.stdout + data.stderr);
      assert.equal(data.json.download.url, "data:text/csv,local-export");
      assert.equal(readFileSync(data.json.download.path, "utf8"), CONTENT);
      if (agent) {
        assert.equal(f.chrome.calls.some((x) => x.method === "Browser.setDownloadBehavior"), false, "the relay emulates the browser method");
        assert.ok(f.h!.fake.sent("downloads.search").length, "the relay searched Chrome's downloads");
      } else assert.equal(f.chrome.calls.filter((x) => x.method === "Browser.setDownloadBehavior").at(-1)!.params.behavior, "default");
    } finally { await f.close(); }
  });

  test(`${mode}: CLI rejects an off-list HTTP download and removes its output`, async () => {
    const f = await setup(agent);
    try {
      const url = "https://elsewhere.invalid/private.csv?export=1";
      f.download(url);
      const r = await f.run(["#b", "--download", "downloads", "--timeout", "5000"]);
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.equal(r.json.error.code, "not_allowed", r.stdout + JSON.stringify(f.h?.logs));
      assert.equal(r.json.error.message, agent
        ? "refusing download from elsewhere.invalid: URL is not on the allowlist. Ask the operator to add elsewhere.invalid to your browser list."
        : `refusing download from ${url}: URL is not on the allowlist`);
      assert.deepEqual(readdirSync(join(f.c.dir, "downloads")), [], "no refused file or staging folder remains");
      if (!agent) assert.equal(f.chrome.calls.filter((x) => x.method === "Browser.setDownloadBehavior").at(-1)!.params.behavior, "default", "restored after refusal");
    } finally { await f.close(); }
  });

  test(`${mode}: CLI timeout bounds a download waiting for a person`, async () => {
    const f = await setup(agent);
    try {
      f.download(f.fx.base + "/waiting.exe", "inProgress");
      const start = Date.now();
      const r = await f.run(["#b", "--download", "downloads", "--timeout", "2000"]);
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.match(r.json.error.message, /download.*timed out.*2000 ms/);
      assert.match(r.json.error.message, /dangerous|person/);
      assert.ok(Date.now() - start < 6000, "the caller's timeout applies before completion");
      assert.equal(f.page.title, "download-started", "the click starts the waiting download before its timeout");
      if (!agent) assert.equal(f.chrome.calls.filter((x) => x.method === "Browser.setDownloadBehavior").at(-1)!.params.behavior, "default", "restored after timeout");
      assert.deepEqual(readdirSync(join(f.c.dir, "downloads")), []);
    } finally { await f.close(); }
  });
}

test("capture checks the live page before changing download behavior or capturing or clearing a size override", async () => {
  const f = await setup();
  const b = await AgentBrowser.connect(f.o);
  try {
    const tab = await b.attach(f.page.targetId);
    await f.chrome.navigate(f.page, "https://elsewhere.invalid/");
    const from = f.chrome.calls.length;
    const dir = join(f.c.dir, "never-created");
    let acted = false;
    await assert.rejects(tab.expectDownload(async () => { acted = true; await tab.click("#b"); }, dir, 100), /not on the allowlist/);
    assert.equal(acted, false);
    assert.equal(existsSync(dir), false);
    assert.deepEqual(f.chrome.calls.slice(from).filter((x) => /Browser.setDownloadBehavior|Page.captureScreenshot|Emulation.clearDeviceMetricsOverride|Input\./.test(x.method)), []);
  } finally { await b.disconnect(); await f.close(); }
});

test("CLI validates the download path and timeout before connecting; normal click keeps its result", async () => {
  const f = await setup();
  try {
    for (const tail of [["#b", "--download", ""], ["#b", "--timeout", "12"], ...["0", "-1", "NaN", "1.5", "Infinity"].map((t) => ["#b", "--download", "downloads", "--timeout", t])]) {
      const r = await f.run(tail);
      assert.equal(r.status, 2, r.stdout + r.stderr);
      assert.equal(r.json.error.code, "usage");
    }
    const r = await f.run(["#b"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(Object.hasOwn(r.json, "download"), false);
  } finally { await f.close(); }
});

test("agent relay: Chrome's dangerous-file event fails clearly and never confirms the file", async () => {
  const f = await setup(true);
  try {
    f.download(f.fx.base + "/danger.exe", "inProgress", true, true);
    const r = await f.run(["#b", "--download", "downloads", "--timeout", "5000"]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.json.error.message, /canceled.*dangerous|dangerous.*canceled/);
    assert.ok(f.h!.fake.sent("downloads.cancel").length);
    assert.deepEqual(readdirSync(join(f.c.dir, "downloads")), []);
    assert.equal(f.h!.fake.requests.some((x) => /acceptDanger/.test(x.op)), false);
  } finally { await f.close(); }
});

test("capture ignores another tab's browser download events", async () => {
  const f = await setup();
  try {
    f.download();
    const click = f.page.select("#b")[0].onclick!;
    f.page.select("#b")[0].onclick = (...args) => {
      (f.chrome as any).broadcast("Browser.downloadWillBegin", { guid: "foreign", frameId: "other-frame", suggestedFilename: "private.csv", url: "https://elsewhere.invalid/private.csv" });
      (f.chrome as any).broadcast("Browser.downloadProgress", { guid: "foreign", state: "completed" });
      return click(...args);
    };
    const r = await f.run(["#b", "--download", "downloads", "--timeout", "5000"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.json.download.suggestedFilename, "report.csv");
    assert.equal(readFileSync(r.json.download.path, "utf8"), CONTENT);
  } finally { await f.close(); }
});

test("a click error restores download behavior and removes the capture folder", async () => {
  const f = await setup();
  try {
    const start = Date.now();
    const r = await f.run(["#missing", "--download", "downloads", "--timeout", "10000"]);
    assert.ok(Date.now() - start < 5000, "a failed click does not wait for a download that never starts");
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.json.error.message, /no element matches/);
    assert.deepEqual(readdirSync(join(f.c.dir, "downloads")), []);
    assert.equal(f.chrome.calls.filter((x) => x.method === "Browser.setDownloadBehavior").at(-1)!.params.behavior, "default");
  } finally { await f.close(); }
});


test("personal mode refuses library and CLI capture without a directory or download behavior change", async () => {
  const f = await setup();
  const b = await AgentBrowser.connect({ ...f.o, mode: "personal" });
  try {
    const tab = await b.open(f.fx.base, { name: "personal-export" });
    const dir = join(f.c.dir, "personal-downloads"), from = f.chrome.calls.length;
    let acted = false;
    await assert.rejects(tab.expectDownload(async () => { acted = true; }, dir, 200), /personal mode.*operator.*Chrome/);
    assert.equal(acted, false);
    assert.deepEqual(f.chrome.calls.slice(from), [], "the library refuses before any CDP call");
    assert.equal(existsSync(dir), false);
    const r = await cli(["click", "personal-export", "#b", "--mode", "personal", "--download", dir, "--timeout", "200", ...f.args, "--json"]);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.equal(r.json.error.code, "usage");
    assert.match(r.json.error.message, /personal mode.*operator.*Chrome/);
    assert.equal(existsSync(dir), false);
    assert.equal(f.chrome.calls.slice(from).some((x) => x.method === "Browser.setDownloadBehavior"), false);
  } finally { await b.disconnect(); await f.close(); }
});

test("commands.click refuses a personal-mode capture before it connects or attaches a tab", async () => {
  const f = await setup();
  try {
    const dir = join(f.c.dir, "personal-before-connect"), connections = f.chrome.connections, from = f.chrome.calls.length;
    await assert.rejects(commands.click({ ...f.o, mode: "personal" }, { tab: "export", target: "#b", download: dir, timeout: 200 }),
      (e: unknown) => e instanceof UsageError && /personal mode.*operator.*Chrome/.test(e.message));
    assert.equal(f.chrome.connections, connections, "no connection to Chrome");
    assert.deepEqual(f.chrome.calls.slice(from).map((x) => x.method), [], "no CDP call: no tab is resolved or attached");
    assert.equal(existsSync(dir), false);
  } finally { await f.close(); }
});

test("capture rechecks the page after another chain releases the input lock", async () => {
  const f = await setup(), b = await AgentBrowser.connect(f.o);
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), checked = Promise.withResolvers<void>();
  const holder = withInputLock(b.settings, async () => { entered.resolve(); await release.promise; });
  try {
    const tab = await b.attach(f.page.targetId), dir = join(f.c.dir, "after-lock");
    const original = tab.assertAllowed.bind(tab);
    tab.assertAllowed = async () => { await original(); checked.resolve(); };
    await entered.promise;
    let acted = false;
    const capture = tab.expectDownload(async () => { acted = true; await tab.click("#b"); }, dir, 150);
    void capture.catch(() => {});
    await checked.promise;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(existsSync(dir), false, "the capture waits for the other chain");
    await f.chrome.navigate(f.page, "https://elsewhere.invalid/");
    const from = f.chrome.calls.length;
    release.resolve(); await holder;
    await assert.rejects(capture, NotAllowedError);
    assert.equal(acted, false);
    assert.equal(existsSync(dir), false);
    assert.deepEqual(f.chrome.calls.slice(from).filter((x) => /Browser.setDownloadBehavior|Page.captureScreenshot|Emulation.clearDeviceMetricsOverride|Input\./.test(x.method)), []);
  } finally { release.resolve(); await holder; await b.disconnect(); await f.close(); }
});

test("an off-list page refuses capture before waiting for another chain's input lock", async () => {
  const f = await setup(), b = await AgentBrowser.connect({ ...f.o, inputTiming: { lockWaitMs: 250 } });
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const holder = withInputLock(b.settings, async () => { entered.resolve(); await release.promise; });
  try {
    const tab = await b.attach(f.page.targetId), dir = join(f.c.dir, "before-lock");
    await entered.promise;
    await f.chrome.navigate(f.page, "https://elsewhere.invalid/");
    await assert.rejects(tab.expectDownload(() => tab.click("#b"), dir, 150), NotAllowedError);
    assert.equal(existsSync(dir), false);
    assert.equal(f.chrome.calls.some((x) => x.method === "Browser.setDownloadBehavior"), false);
  } finally { release.resolve(); await holder; await b.disconnect(); await f.close(); }
});

for (const agent of [false, true]) test(`${agent ? "agent relay" : "default proxy"}: capture refuses a blob URL with an off-list HTTP origin`, async () => {
  const f = await setup(agent);
  try {
    const url = "blob:https://elsewhere.invalid/private-export";
    f.download(url);
    const r = await f.run(["#b", "--download", "downloads", "--timeout", "5000"]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.equal(r.json.error.code, "not_allowed");
    assert.equal(r.json.error.message, agent
        ? "refusing download from elsewhere.invalid: blob origin is not on the allowlist. Ask the operator to add elsewhere.invalid to your browser list."
        : `refusing download from ${url}: blob origin is not on the allowlist`);
    assert.deepEqual(readdirSync(join(f.c.dir, "downloads")), []);
  } finally { await f.close(); }
});

for (const agent of [false, true]) test(`${agent ? "agent relay" : "default proxy"}: capture refuses a malformed download URL as not_allowed and names it`, async () => {
  const f = await setup(agent);
  try {
    const url = "http://[malformed/export.csv";
    f.download(url);
    const r = await f.run(["#b", "--download", "downloads", "--timeout", "5000"]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.equal(r.json.error.code, "not_allowed", r.stdout);
    assert.equal(r.json.error.message, `refusing download from ${url}: not a valid URL`);
    assert.deepEqual(readdirSync(join(f.c.dir, "downloads")), [], "no refused file or staging folder remains");
  } finally { await f.close(); }
});

for (const agent of [false, true]) test(`${agent ? "agent relay" : "default proxy"}: a download that an allowlisted URL redirects to an off-list host is refused by its URL after the redirect`, async () => {
  const f = await setup(agent);
  // One local server for two names (the fake Chrome sends each *.localhost name to 127.0.0.1): fixture.localhost is on
  // the list (at any port), and its /export redirects to elsewhere.localhost, which is off the list.
  const server = createServer((req, res) => {
    const port = (server.address() as { port: number }).port;
    if (req.url === "/export") { res.writeHead(302, { location: `http://elsewhere.localhost:${port}/private.csv` }); res.end(); return; }
    if (req.url === "/private.csv") { res.writeHead(200, { "content-type": "text/csv", "content-disposition": 'attachment; filename="private.csv"' }); res.end(CONTENT); return; }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as { port: number }).port, url = `http://${FIXTURE_HOST}:${port}/export`;
    // The default proxy: the fake Chrome's own download. The agent relay: the relay's download events (Page.downloadWillBegin).
    if (agent) f.download(url, "completed", true, false, true);
    else f.page.select("#b")[0].onclick = (page) => { void f.chrome.download(page, url, "private.csv"); };
    const r = await f.run(["#b", "--download", "downloads", "--timeout", "5000"]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.equal(r.json.error.code, "not_allowed", r.stdout);
    assert.equal(r.json.error.message, agent
      ? "refusing download from elsewhere.localhost: URL is not on the allowlist. Ask the operator to add elsewhere.localhost to your browser list."
      : `refusing download from http://elsewhere.localhost:${port}/private.csv: URL is not on the allowlist`);
    assert.deepEqual(readdirSync(join(f.c.dir, "downloads")), [], "no refused file or staging folder remains");
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await f.close(); }
});

// As in Chrome, a download that the capture cancels, or whose folder the capture removed, writes nothing and throws nothing.
test("fake Chrome: a download that gets Browser.cancelDownload before its body writes nothing", async () => {
  const f = await setup(), b = await AgentBrowser.connect(f.o);
  try {
    const dir = join(f.c.dir, "fake-cancel");
    mkdirSync(dir);
    await b.conn.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: dir, eventsEnabled: true });
    const result = await f.chrome.download(f.page, f.fx.base + "/file.bin", "file.bin", { beforeBody: (guid) => b.conn.send("Browser.cancelDownload", { guid }) });
    assert.equal(result, "canceled");
    assert.deepEqual(readdirSync(dir), [], "Chrome writes nothing for a canceled download");
  } finally { await b.disconnect(); await f.close(); }
});

test("fake Chrome: a download whose folder is gone before its body is canceled, not a throw", async () => {
  const f = await setup(), b = await AgentBrowser.connect(f.o);
  try {
    const dir = join(f.c.dir, "fake-gone");
    mkdirSync(dir);
    await b.conn.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: dir, eventsEnabled: true });
    const result = f.chrome.download(f.page, f.fx.base + "/file.bin", "file.bin", { beforeBody: () => rmSync(dir, { recursive: true }) });
    assert.equal(await result, "canceled");
    assert.equal(existsSync(dir), false);
  } finally { await b.disconnect(); await f.close(); }
});

test("default proxy: a refused capture's download whose body comes after the cleanup writes nothing and throws nothing", async () => {
  const f = await setup(), b = await AgentBrowser.connect(f.o);
  try {
    const tab = await b.attach(f.page.targetId), dir = join(f.c.dir, "late-body"), cleaned = Promise.withResolvers<void>();
    const url = f.fx.base.replace(FIXTURE_HOST, "elsewhere.localhost") + "/file.bin"; // off the list; the fake Chrome reaches it
    let fake: Promise<string> | undefined;
    f.page.select("#b")[0].onclick = (page) => { fake = f.chrome.download(page, url, "file.bin", { beforeBody: () => cleaned.promise }); };
    await assert.rejects(tab.expectDownload(() => tab.click("#b"), dir, 5000), /refusing download from .*elsewhere\.localhost.*not on the allowlist/);
    // The capture canceled the download, restored the behavior and removed its staging folder. Now the body comes.
    assert.ok(f.chrome.calls.some((x) => x.method === "Browser.cancelDownload"));
    cleaned.resolve();
    assert.equal(await fake, "canceled");
    assert.deepEqual(readdirSync(dir), []);
  } finally { await b.disconnect(); await f.close(); }
});

test("the start URL check refuses an off-list download before it completes", async () => {
  const f = await setup();
  try {
    const url = "https://elsewhere.invalid/unfinished.csv";
    f.download(url, "inProgress");
    const r = await f.run(["#b", "--download", "downloads", "--timeout", "5000"]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.equal(r.json.error.code, "not_allowed");
    assert.equal(r.json.error.message, `refusing download from ${url}: URL is not on the allowlist`);
    assert.equal(f.chrome.calls.filter((x) => x.method === "Browser.setDownloadBehavior").at(-1)!.params.behavior, "default");
    assert.deepEqual(readdirSync(join(f.c.dir, "downloads")), []);
  } finally { await f.close(); }
});

test("a download that starts after the timeout is canceled and leaves no captured output", async () => {
  const f = await setup(), b = await AgentBrowser.connect(f.o);
  try {
    const tab = await b.attach(f.page.targetId), dir = join(f.c.dir, "late-download");
    await assert.rejects(tab.expectDownload(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      const behavior = f.chrome.calls.filter((x) => x.method === "Browser.setDownloadBehavior").at(-1)!.params;
      writeFileSync(join(behavior.downloadPath, "late-guid"), CONTENT);
      (f.chrome as any).broadcast("Browser.downloadWillBegin", { guid: "late-guid", frameId: `F-${f.page.targetId}`, url: f.fx.base + "/late.csv", suggestedFilename: "late.csv" });
      // Let the browser event reach the capture before the action returns.
      await new Promise((resolve) => setTimeout(resolve, 30));
    }, dir, 20), /download timed out/);
    assert.ok(f.chrome.calls.some((x) => x.method === "Browser.cancelDownload" && x.params.guid === "late-guid"));
    assert.deepEqual(readdirSync(dir), []);
    assert.equal(f.chrome.calls.filter((x) => x.method === "Browser.setDownloadBehavior").at(-1)!.params.behavior, "default");
    await f.chrome.download(f.page, f.fx.base + "/file.bin", "after-restore.bin");
    assert.deepEqual(readdirSync(dir), [], "a download after restoration stays outside DIR");
  } finally { await b.disconnect(); await f.close(); }
});

test("a timeout explains that iframe and new-tab downloads are ignored", async () => {
  const f = await setup(), b = await AgentBrowser.connect(f.o);
  try {
    const tab = await b.attach(f.page.targetId);
    for (const frameId of ["child-frame", "new-tab-main-frame"]) {
      const dir = join(f.c.dir, frameId);
      await assert.rejects(tab.expectDownload(async () => {
        (f.chrome as any).broadcast("Browser.downloadWillBegin", { guid: frameId, frameId, url: f.fx.base + "/export.csv", suggestedFilename: "ignored.csv" });
        (f.chrome as any).broadcast("Browser.downloadProgress", { guid: frameId, state: "completed" });
      }, dir, 30), /iframe.*new tab/);
      assert.deepEqual(readdirSync(dir), []);
    }
  } finally { await b.disconnect(); await f.close(); }
});

test("staging cleanup failure preserves the original click error and logs the folder, code and message", async (t) => {
  const f = await setup(), logs: string[] = [], b = await AgentBrowser.connect({ ...f.o, log: (line) => { logs.push(line); } });
  const original = fs.rmSync;
  try {
    const tab = await b.attach(f.page.targetId), dir = join(f.c.dir, "cleanup-error");
    t.mock.method(fs, "rmSync", (path, options) => {
      if (String(path).startsWith(dir + "/.download-")) throw Object.assign(new Error("late copy blocks cleanup"), { code: "EBUSY" });
      return original(path, options);
    });
    syncBuiltinESMExports();
    await assert.rejects(tab.expectDownload(async () => { throw new Error("original click error"); }, dir, 100), /original click error/);
    const [staging] = readdirSync(dir);
    assert.match(staging, /^\.download-/, "the staging folder stays when its cleanup fails");
    const line = logs.find((l) => l.includes("download staging folder"));
    assert.equal(line, `agent-browser: could not remove download staging folder ${join(dir, staging)}; it stays and can hold an unfinished or refused file: EBUSY: late copy blocks cleanup`);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await b.disconnect(); await f.close(); }
});
