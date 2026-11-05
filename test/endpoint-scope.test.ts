// Each endpoint scope keeps its own tab record (board task ab-v16.58; vedlo-codex's report, mail p135308c8): behind
// agent mode's endpoint (cdpUrl: the relay's ws+unix://<socket>:/devtools/browser/<scope>), Target.getTargets lists
// only the scope's own tabs, so a record that two scopes share loses each scope's entries at the other scope's next
// change (updateRecord drops every entry whose tab the connection does not list). The record (tabs.json,
// tab-scopes.json, reads.json, window.json, tab-pages.json and their lock tabs.lock) lives in
// <stateDir>/endpoint-scopes/<scope's folder name>; with no endpoint scope it stays in the state folder. The input lock
// (input.lock) and pointer.json stay one per agent browser, in the state folder, for every endpoint scope.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { AgentBrowser } from "../src/browser.ts";
import { commands } from "../src/commands.ts";
import { INPUT_LOCK, POINTER_FILE } from "../src/input.ts";
import { ENDPOINT_SCOPE_RE, ENDPOINT_SCOPES_DIR, endpointScope, recordDir, resolveOptions, scopeFolderName, TAB_SCOPE_RE, type InputTiming } from "../src/options.ts";
import { SCOPE } from "../src/relay/endpoint.ts";
import { FakeChrome, type FakePage } from "./fake-chrome.ts";
import { backByChrome, harness } from "./fake-bridge.ts";
import { cli, consumer, fixtureServer, site } from "./helpers.ts";

const RECORD_FILES = ["tabs.json", "tab-scopes.json", "reads.json", "window.json", "tab-pages.json"];

/**
 * A fake CDP endpoint on a Unix socket, as the relay serves one agent browser: each endpoint scope
 * (/devtools/browser/<scope>) answers Target.getTargets with its own tabs only. It answers Browser.getVersion too, and
 * every other call with {}.
 */
async function scopedEndpoint(tabs: Record<string, { targetId: string; url: string }[]>) {
  const dir = mkdtempSync(join(tmpdir(), "ab-scopes-")), socket = join(dir, "cdp.sock");
  const http = createServer((_req, res) => { res.writeHead(404).end(); });
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  const lists: string[] = [];
  http.on("upgrade", (req, sock, head) => {
    const scope = /^\/devtools\/browser\/([^/]+)$/.exec(req.url ?? "")?.[1];
    if (scope === undefined || !(scope in tabs)) { sock.destroy(); return; }
    wss.handleUpgrade(req, sock, head, (ws) => {
      ws.on("message", (data) => {
        const m = JSON.parse(String(data));
        let result: object = {};
        if (m.method === "Browser.getVersion") result = { product: "Chrome/1.0.0.0", protocolVersion: "1.3" };
        if (m.method === "Target.getTargets") {
          lists.push(scope);
          result = { targetInfos: tabs[scope].map((t) => ({ ...t, type: "page", title: "", attached: false })) };
        }
        ws.send(JSON.stringify({ id: m.id, result }));
      });
    });
  });
  await new Promise<void>((r) => http.listen(socket, r));
  return {
    lists,
    url: (scope: string) => `ws+unix://${socket}:/devtools/browser/${scope}`,
    close: async () => {
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((r) => http.close(() => r()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("vedlo-codex's reproduction: two endpoint scopes of one agent browser, one state folder: each scope keeps its own read marks and pin", async () => {
  const urlA = "http://127.0.0.1/a", urlB = "http://127.0.0.1/b";
  const end = await scopedEndpoint({ A: [{ targetId: "TA", url: urlA }], B: [{ targetId: "TB", url: urlB }] }), c = consumer();
  const options = (scope: string) => c.options({ cdpUrl: end.url(scope), display: { own: true, xdotool: false } });
  const a = await AgentBrowser.connect(options("A")), b = await AgentBrowser.connect(options("B"));
  try {
    await a.markRead("TA", urlA);
    await b.markRead("TB", urlB);
    assert.equal(a.readMark("TA"), urlA, "scope B's change kept scope A's read mark");
    assert.equal(b.readMark("TB"), urlB);
    await a.markRead("TA", urlA); // A's next change keeps B's mark too
    assert.equal(b.readMark("TB"), urlB, "scope A's change kept scope B's read mark");
    assert.ok(end.lists.includes("A") && end.lists.includes("B"), "each change read its own scope's tabs");
    // The pinned window belongs to the endpoint scope's record.
    await a.pinWindow(7);
    assert.deepEqual([a.pinnedWindow(), b.pinnedWindow()], [7, undefined]);
    await a.pinWindow(undefined);
    // The layout: the record of each endpoint scope in its own folder (a capital letter as "+" and its small letter); none
    // in the state folder.
    assert.deepEqual(readdirSync(join(c.stateDir, ENDPOINT_SCOPES_DIR)).sort(), ["+a", "+b"]);
    for (const [scope, folder] of [["A", "+a"], ["B", "+b"]]) {
      const dir = join(c.stateDir, ENDPOINT_SCOPES_DIR, folder);
      assert.equal(recordDir(resolveOptions(options(scope))), dir);
      assert.deepEqual(readdirSync(dir), ["reads.json"], `${scope}: no tabs.lock left, no window.json after the unpin`);
      assert.equal(statSync(dir).mode & 0o777, 0o700, `${scope}: private`);
    }
    assert.equal(statSync(join(c.stateDir, ENDPOINT_SCOPES_DIR)).mode & 0o777, 0o700);
    for (const f of [...RECORD_FILES, "tabs.lock"]) assert.equal(existsSync(join(c.stateDir, f)), false, `no ${f} in the state folder`);
    assert.deepEqual(JSON.parse(readFileSync(join(c.stateDir, ENDPOINT_SCOPES_DIR, "+a", "reads.json"), "utf8")), { TA: urlA });
  } finally { await a.disconnect(); await b.disconnect(); await end.close(); c.remove(); }
});

test("an endpoint scope's folder name: the scope, a capital letter as + and its small letter; any other scope is refused", () => {
  // The relay's scope, agent-browser's endpoint scope and the tab scope are one pattern.
  assert.equal(ENDPOINT_SCOPE_RE.source, SCOPE.source);
  assert.equal(ENDPOINT_SCOPE_RE.source, TAB_SCOPE_RE.source);
  assert.equal(scopeFolderName("ab-lead"), "ab-lead");
  assert.equal(scopeFolderName("a.b_c-9"), "a.b_c-9");
  assert.equal(scopeFolderName("Ab-Lead"), "+ab-+lead");
  // On a disk that ignores case (the Mac's), two scopes that differ only in case still get two folders: no folder name
  // has a capital letter, and no two scopes get one name.
  const names = ["ab", "Ab", "aB", "AB", "a+b", "x".repeat(64), "X".repeat(64)].filter((s) => ENDPOINT_SCOPE_RE.test(s)).map(scopeFolderName);
  assert.equal(new Set(names.map((n) => n.toLowerCase())).size, names.length, names.join(" "));
  assert.ok(names.every((n) => n === n.toLowerCase() && n.length <= 128));
  for (const bad of ["", ".", "..", ".x", "-x", "_x", "a/b", "../a", "a b", "a:b", "a+b", "x".repeat(65), "é", "a\n"])
    assert.throws(() => scopeFolderName(bad), /an endpoint scope is 1 to 64/, JSON.stringify(bad));
  assert.throws(() => scopeFolderName(undefined as never), /an endpoint scope is 1 to 64/);
  // The endpoint scope comes from cdpUrl only; with no cdpUrl (the proxy, a direct Chrome) the record stays in the state folder.
  const c = consumer();
  try {
    const good = "ws+unix:///run/user/1000/agentwatch/browser-cdp.sock:/devtools/browser/Ab-Lead";
    assert.equal(endpointScope(resolveOptions(c.options({ cdpUrl: good }))), "Ab-Lead");
    assert.equal(recordDir(resolveOptions(c.options({ cdpUrl: good }))), join(c.stateDir, ENDPOINT_SCOPES_DIR, "+ab-+lead"));
    assert.equal(endpointScope(resolveOptions(c.options())), undefined);
    assert.equal(recordDir(resolveOptions(c.options())), c.stateDir);
    assert.equal(recordDir(resolveOptions(c.options({ endpoint: "ws://127.0.0.1:9/devtools/browser/x" }))), c.stateDir);
    // A settings object whose cdpUrl names no endpoint scope never reaches a folder (resolveOptions refuses it first).
    assert.throws(() => recordDir({ ...resolveOptions(c.options()), cdpUrl: "ws+unix:///tmp/x.sock:/devtools/browser/../x" }), /cdpUrl names no endpoint scope/);
  } finally { c.remove(); }
});

/** Short input times, so that the suite stays fast (as input-lock.test.ts). */
const FAST: Partial<InputTiming> = { pressMs: [6, 9], keyMs: [6, 9], holdMs: [1, 2], settleMs: [1, 3], wheelMs: [1, 3], moveScale: 0.05, activateMs: 300 };

test("over the relay, two sessions' commands with one state folder, as agentwatch runs them: each endpoint scope keeps its names, tab scopes and read marks", async () => {
  const fx = await fixtureServer(), chrome = await FakeChrome.start(site(fx.base)), h = await harness(), c = consumer();
  const end = await backByChrome(h.fake, chrome);
  // agentwatch browser <command>: --cdp-url <the session's URL> --state-dir <one folder> --tab-scope <session>.
  const session = (name: string) => c.options({ cdpUrl: h.url(name), tabScope: name, platform: "linux", inputTiming: FAST,
    display: { own: true, xdotool: false } });
  const A = session("s-a"), B = session("S-B");
  try {
    await h.ready();
    const a = await commands.open(A, { url: `${fx.base}/?a`, name: "main" });
    await commands.text(A, { tab: "main" });
    const b = await commands.open(B, { url: `${fx.base}/?b`, name: "main" });
    await commands.text(B, { tab: "main" });
    // Each session still finds its own tab "main", and its read mark: shot needs it (the read-first rule).
    for (const [o, t] of [[A, a], [B, b]] as const) {
      assert.deepEqual((await commands.tabs(o)).tabs.map((x) => [x.targetId, x.name, x.scope]), [[t.tab.targetId, "main", o.tabScope]]);
      const shot = await commands.shot(o, { tab: "main", path: join(c.dir, `${o.tabScope}.png`) });
      assert.ok(existsSync(shot.path), `${o.tabScope}: shot`);
    }
    // In another process too (agentwatch's CLI call), after the other session's changes.
    const r = await cli(["tabs", "--json", "--state-dir", c.stateDir, "--allowlist", c.allowlist, "--cdp-url", h.url("s-a"), "--tab-scope", "s-a"]);
    assert.deepEqual(r.json.tabs.map((x: { name: string }) => x.name), ["main"], r.stdout + r.stderr);
    // The layout: one record folder for each endpoint scope; the browser-wide files stay in the state folder.
    assert.deepEqual(readdirSync(join(c.stateDir, ENDPOINT_SCOPES_DIR)).sort(), ["+s-+b", "s-a"]);
    for (const dir of ["+s-+b", "s-a"]) {
      const scopes = JSON.parse(readFileSync(join(c.stateDir, ENDPOINT_SCOPES_DIR, dir, "tab-scopes.json"), "utf8"));
      assert.equal(Object.keys(scopes).length, 1, `${dir}: only its own tab`);
    }
    for (const f of [...RECORD_FILES, "tabs.lock"]) assert.equal(existsSync(join(c.stateDir, f)), false, `no ${f} in the state folder`);
    await commands.close(A, { tab: "main" });
    assert.deepEqual((await commands.tabs(B)).tabs.map((x) => x.name), ["main"], "A's close kept B's tab");
    await commands.close(B, { tab: "main" });
  } finally { end(); await h.close(); await chrome.close(); await fx.close(); c.remove(); }
});

test("over the relay, two endpoint scopes share the one input lock: their input never overlaps (ab-1bi)", async () => {
  const fx = await fixtureServer(), chrome = await FakeChrome.start(site(fx.base)), h = await harness(), c = consumer();
  const end = await backByChrome(h.fake, chrome);
  const session = (name: string, extra: Partial<InputTiming> = {}) => c.options({ cdpUrl: h.url(name), tabScope: name, platform: "linux",
    inputTiming: { ...FAST, ...extra }, display: { own: true, xdotool: false } });
  const lock = join(c.stateDir, INPUT_LOCK);
  const ours = () => { try { return readFileSync(lock, "utf8") === String(process.pid); } catch { return false; } };
  try {
    await h.ready();
    const pages: FakePage[] = [], seen: boolean[][] = [];
    for (const name of ["s-a", "s-b"]) {
      const opened = await commands.open(session(name), { url: fx.base, name: "main" });
      const page = chrome.pages.get(opened.tab.targetId)!, mine: boolean[] = [];
      page.select("#b")[0].onclick = (p: FakePage) => { p.title = "clicked"; mine.push(ours()); };
      pages.push(page); seen.push(mine);
    }
    const span = (p: FakePage, from: number): [number, number] => {
      const xs = chrome.calls.filter((x) => x.t >= from && x.targetId === p.targetId && (x.method === "Input.dispatchMouseEvent" || x.method === "Page.bringToFront"));
      return [xs[0].t, xs.at(-1)!.t];
    };
    const t = Date.now();
    await Promise.all(["s-a", "s-b"].map((name) => commands.click(session(name, { pressMs: [150, 160] }), { tab: "main", target: "#b" })));
    const [sa, sb] = [span(pages[0], t), span(pages[1], t)];
    assert.ok(sa[1] <= sb[0] || sb[1] <= sa[0], `two endpoint scopes: never at once (s-a ${sa}, s-b ${sb})`);
    assert.deepEqual(seen, [[true], [true]], "each click ran inside the state folder's one input.lock");
    assert.deepEqual(pages.map((p) => p.title), ["clicked", "clicked"]);
    // input.lock and pointer.json are the agent browser's, in the state folder: no endpoint scope has its own.
    assert.equal(existsSync(lock), false, "released");
    const pointer = JSON.parse(readFileSync(join(c.stateDir, POINTER_FILE), "utf8")).pages;
    assert.ok(pointer[pages[0].targetId] && pointer[pages[1].targetId], JSON.stringify(Object.keys(pointer)));
    for (const dir of readdirSync(join(c.stateDir, ENDPOINT_SCOPES_DIR)))
      for (const f of [INPUT_LOCK, POINTER_FILE]) assert.equal(existsSync(join(c.stateDir, ENDPOINT_SCOPES_DIR, dir, f)), false, `no ${f} in ${dir}`);
    for (const name of ["s-a", "s-b"]) await commands.close(session(name), { tab: "main" });
  } finally { end(); await h.close(); await chrome.close(); await fx.close(); c.remove(); }
});
