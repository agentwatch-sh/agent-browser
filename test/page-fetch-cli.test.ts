// `agent-browser page-fetch` (board ab-v16.113; src/page-fetch-cli.ts; the README, "PageFetch without agentwatch"): the
// usage errors, the allow file's checks (before Chrome starts), the exit codes, the text and the JSON forms, the core's
// ports over direct CDP (a fake browser in this process), the cleanup of the profile folder after a fetch, an error and a
// signal, Chrome's arguments, and the launcher over a real pipe with a fake Chromium. No real Chrome, no network: every
// host here is a test value, and the fake resolver gives test addresses.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmodSync, chownSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, relative } from "node:path";
import { PassThrough } from "node:stream";
import { main } from "../src/cli.ts";
import { CHROME_ENV_KEYS, chromeArgs, chromeEnv, directPorts, launchChrome, runPageFetchCommand, PROFILE_PREFIX, readAllowFile, type Cdp, type Launched, type PageFetchDeps } from "../src/page-fetch-cli.ts";
import { tempDir } from "./temp-dirs.ts";

const URL1 = "https://pages.example.test/docs/a-secret-path?token=test-query-value#test-fragment";
const RESOLVE = async (h: string) => (h.endsWith(".example.test") ? ["203.0.113.10"] : Promise.reject(new Error("ENOTFOUND")));

function io() {
  const out: string[] = [], err: string[] = [];
  const stdout = new PassThrough(), stderr = new PassThrough();
  stdout.on("data", (d) => out.push(String(d)));
  stderr.on("data", (d) => err.push(String(d)));
  return { io: { stdout, stderr, stdin: new PassThrough() }, out: () => out.join(""), err: () => err.join("") };
}
/** An allow file of `body` with `mode` (0600 by default) in a new temp folder. */
function allowFile(body: string, mode = 0o600, name = "support-fetch.json"): { dir: string; file: string } {
  const dir = tempDir("ab-page-fetch-cli-");
  const file = join(dir, name);
  writeFileSync(file, body);
  chmodSync(file, mode);
  return { dir, file };
}
const LIST = '{"allow":["pages.example.test/docs","cdn.example.test"]}';

/**
 * A fake browser on one CDP connection, as Chrome answers page-fetch's commands: a browser context, a target and its
 * flat session, the page's commands, a navigation whose requests pause in Fetch, a child session (a frame) and a popup,
 * and the conversion's answer. `requests` are the page's own requests after its load (each answered continue or fail).
 */
class FakeBrowser implements Cdp {
  readonly sent: { method: string; params: any; sessionId?: string }[] = [];
  readonly answers = new Map<string, "continue" | "fail">();
  private readonly fns = new Set<(m: any) => void>();
  private readonly waiting = new Map<string, (how: "continue" | "fail") => void>();
  private n = 0;
  hang = new Set<string>();
  failing = new Set<string>();
  requests: { url: string; method?: string; session?: "frame" | "popup" | "shared" | "sw" | "socket" | "worklet" }[] = [];
  /** The requests that left before their guard (as Chrome sends them when nothing holds the target). */
  readonly leaked: string[] = [];
  /** The sessions on which the code sent Runtime.runIfWaitingForDebugger, and those that it detached. */
  readonly resumed: string[] = [];
  readonly detached: string[] = [];
  /** The browser's own auto-attach with waitForDebuggerOnStart (Target.setAutoAttach with no session). */
  private autoAttach = false;
  private readonly runs = new Map<string, () => void>();
  closed = 0;
  disposed: string[] = [];
  private readonly closers = new Set<() => void>();
  private readonly hung = new Set<(e: Error) => void>();
  private dead = false;
  listen(fn: (m: any) => void) { this.fns.add(fn); }
  onClose(fn: () => void) { this.closers.add(fn); }
  /** Chrome ends by itself (a signal to the process group, a crash): its pipe closes, and each command fails. */
  crash() { this.dead = true; for (const r of [...this.hung]) r(new Error("Chrome closed its debugging pipe")); for (const f of [...this.closers]) f(); }
  /** A new target of the browser: with the browser's auto-attach it waits for its session's run; else it runs at once. */
  private async start(sessionId: string, info: any, url: string, type: string): Promise<"held" | "continue" | "fail" | "leaked"> {
    if (!this.autoAttach) { this.leaked.push(url); return "leaked"; }
    this.emit("Target.attachedToTarget", { sessionId, targetInfo: info, waitingForDebugger: true });
    const ran = new Promise<void>((r) => this.runs.set(sessionId, r));
    const out = await Promise.race([ran.then(() => "ran" as const), new Promise<"held">((r) => setTimeout(() => r("held"), 400))]);
    if (out === "held") return "held";
    // It runs: its first request pauses only on a session that enabled Fetch before the run.
    if (!this.sent.some((x) => x.method === "Fetch.enable" && x.sessionId === sessionId)) { this.leaked.push(url); return "leaked"; }
    return this.pause(url, sessionId, type);
  }
  private emit(method: string, params: any, sessionId?: string) { setImmediate(() => { for (const f of [...this.fns]) f({ method, params, ...(sessionId ? { sessionId } : {}) }); }); }
  private pause(url: string, sessionId: string, type = "Fetch", method = "GET", frameId = "F1"): Promise<"continue" | "fail"> {
    const id = `req-${++this.n}`;
    const p = new Promise<"continue" | "fail">((r) => this.waiting.set(id, r));
    this.emit("Fetch.requestPaused", { requestId: id, request: { url, method }, resourceType: type, frameId, networkId: id }, sessionId);
    return p.then((how) => { this.answers.set(url, how); return how; });
  }
  async send(method: string, params: any = {}, sessionId?: string): Promise<any> {
    this.sent.push({ method, params, sessionId });
    if (this.dead) throw new Error("Chrome closed its debugging pipe");
    if (this.hang.has(method)) return new Promise((_, reject) => this.hung.add(reject));
    if (this.failing.has(method)) throw new Error(`${method} failed`);
    switch (method) {
      case "Target.createBrowserContext": return { browserContextId: "CTX" };
      case "Target.setAutoAttach":
        if (sessionId === undefined && params.waitForDebuggerOnStart === true) {
          this.autoAttach = true;
          // A page of another context (Chrome's default one): the code lets it run and detaches it.
          this.emit("Target.attachedToTarget", { sessionId: "O1", targetInfo: { type: "page", targetId: "T0", browserContextId: "DEFAULT", url: "about:blank" }, waitingForDebugger: false });
        }
        return {};
      case "Runtime.runIfWaitingForDebugger": this.resumed.push(sessionId!); this.runs.get(sessionId!)?.(); return {};
      case "Target.detachFromTarget": this.detached.push(params.sessionId); return {};
      case "Target.createTarget":
        if (this.autoAttach) this.emit("Target.attachedToTarget", { sessionId: "S1", targetInfo: { type: "page", targetId: "T1", browserContextId: "CTX", url: "about:blank" }, waitingForDebugger: true });
        return { targetId: "T1" };
      case "Target.attachToTarget": return { sessionId: params.targetId === "T1" ? "S1" : "P1" };
      case "Target.disposeBrowserContext": this.disposed.push(params.browserContextId); return {};
      case "Page.getFrameTree": return { frameTree: { frame: { id: sessionId === "S1" ? "F1" : "PF" } } };
      case "Page.createIsolatedWorld": return { executionContextId: ++this.n };
      case "Fetch.continueRequest": case "Fetch.failRequest": {
        const r = this.waiting.get(params.requestId);
        this.waiting.delete(params.requestId);
        r?.(method === "Fetch.continueRequest" ? "continue" : "fail");
        return {};
      }
      case "Runtime.evaluate": {
        const e = String(params.expression);
        if (e.includes("/*aw-fetch:check*/")) return { result: { value: { title: "A test page", text: "", frames: [], marks: { click: [], check: [] } } } };
        if (e.includes("/*aw-fetch:convert*/")) return { result: { value: { title: "A test page", url: "https://pages.example.test/docs/a-secret-path?token=test-query-value", content: "# A test page\n\n" + "The text of the test page. ".repeat(20), whole: false, fallback: false, consentLayer: false } } };
        return { result: {} };
      }
      case "Page.navigate": return this.navigate(String(params.url));
      default: return {};
    }
  }
  private async navigate(url: string): Promise<any> {
    // Chrome's request of a URL has no fragment.
    url = url.replace(/#.*$/, "");
    if ((await this.pause(url, "S1", "Document")) === "fail") return { frameId: "F1", errorText: "net::ERR_BLOCKED_BY_CLIENT" };
    void (async () => {
      this.emit("Network.requestWillBeSent", { requestId: "doc", request: { url }, type: "Document", frameId: "F1" }, "S1");
      this.emit("Network.responseReceived", { requestId: "doc", type: "Document", frameId: "F1", response: { url, status: 200, mimeType: "text/html" } }, "S1");
      this.emit("Page.frameNavigated", { frame: { id: "F1", url } }, "S1");
      this.emit("Network.loadingFinished", { requestId: "doc" }, "S1");
      // The page stays busy while its own requests run.
      this.emit("Network.requestWillBeSent", { requestId: "hold", request: { url: "https://cdn.example.test/hold" } }, "S1");
      this.emit("Page.loadEventFired", { timestamp: 1 }, "S1");
      await new Promise((r) => setTimeout(r, 10));
      for (const q of this.requests) {
        if (q.session === "frame") {
          this.emit("Target.attachedToTarget", { sessionId: "C1", targetInfo: { type: "iframe", url: q.url, targetId: "C1T" }, waitingForDebugger: true }, "S1");
          await new Promise((r) => setTimeout(r, 30));
          await this.pause(q.url, "C1", "Document", q.method ?? "GET", "F2");
        } else if (q.session === "popup") {
          // Chrome's discover event of a new page; with the browser's auto-attach the page also waits for its run.
          this.emit("Target.targetCreated", { targetInfo: { type: "page", targetId: "T2", openerId: "T1", browserContextId: "CTX", url: "" } });
          this.answers.set(q.url, (await this.start("P1", { type: "page", targetId: "T2", openerId: "T1", browserContextId: "CTX", url: "" }, q.url, "Document")) as any);
        } else if (q.session === "shared") {
          this.answers.set(q.url, (await this.start("W1", { type: "shared_worker", targetId: "W1T", browserContextId: "CTX", url: "https://pages.example.test/docs/shared.js" }, q.url, "Fetch")) as any);
        } else if (q.session === "sw") {
          // A service worker: the browser attaches it, and so does the tab's own auto-attach.
          this.emit("Target.attachedToTarget", { sessionId: "SW2", targetInfo: { type: "service_worker", targetId: "SWT", browserContextId: "CTX", url: "https://pages.example.test/docs/sw.js" }, waitingForDebugger: true }, "S1");
          const out = await this.start("SW1", { type: "service_worker", targetId: "SWT", browserContextId: "CTX", url: "https://pages.example.test/docs/sw.js" }, q.url, "Fetch");
          this.answers.set(q.url, (this.resumed.includes("SW2") ? "leaked" : out) as any);
        } else if (q.session === "worklet") {
          // A target of the fetch's context of a type that has no guard (board ab-v16.114).
          this.answers.set(q.url, (await this.start("WL1", { type: "worklet", targetId: "WLT", browserContextId: "CTX", url: "https://pages.example.test/docs/worklet.js" }, q.url, "Fetch")) as any);
        } else if (q.session === "socket") {
          this.emit("Network.webSocketCreated", { requestId: `ws-${++this.n}`, url: q.url }, "S1");
          await new Promise((r) => setTimeout(r, 20));
        } else await this.pause(q.url, "S1", "Script", q.method ?? "GET");
      }
      this.emit("Network.loadingFinished", { requestId: "hold" }, "S1");
    })();
    return { frameId: "F1", loaderId: "L1" };
  }
}

/** runPageFetchCommand with a fake browser: the deps, what the launch got, and the profile folders that it made. */
function rig(browser = new FakeBrowser()) {
  const tmp = tempDir("ab-page-fetch-tmp-");
  const launches: { chrome: string; args: string[]; home: string }[] = [];
  let closes = 0;
  const signals = new EventEmitter();
  const exits: number[] = [];
  const deps: PageFetchDeps = {
    tmp, resolve: RESOLVE, signals, exit: (c) => exits.push(c),
    limits: { readyMs: 1_500, wholeMs: 4_000, settleMs: 40, quietMs: 10, endMs: 600, receiverMs: 200, goneMs: 150 },
    launch: async (o): Promise<Launched> => { launches.push({ chrome: o.chrome, args: o.args, home: o.home }); return { cdp: browser, close: async () => { closes++; browser.closed++; } }; },
  };
  return { browser, deps, tmp, launches, closes: () => closes, signals, exits, profiles: () => readdirSync(tmp) };
}
const run = (r: ReturnType<typeof rig>, args: string[], json = false) => {
  const o = io();
  const values: Record<string, string | boolean> = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) { const k = args[i].slice(2); if (["json", "help"].includes(k)) values[k] = true; else values[k] = args[++i]; }
    else rest.push(args[i]);
  }
  if (json) values.json = true;
  return runPageFetchCommand(values, rest, o.io, r.deps).then((code) => ({ code, out: o.out(), err: o.err() }));
};

test("page-fetch: a page on the list: exit 0, the MCP answer's text on standard output (the header with the fetch list's line, an empty line, the markdown); one Chrome with a new profile folder, which goes after the fetch", async () => {
  const { file } = allowFile(LIST);
  const r = rig();
  const a = await run(r, [URL1, "--allow-file", file]);
  assert.equal(a.code, 0, a.out + a.err);
  const [head, body] = [a.out.slice(0, a.out.indexOf("\n\n")), a.out.slice(a.out.indexOf("\n\n") + 2)];
  assert.deepEqual(head.split("\n"), ["URL: https://pages.example.test/docs/a-secret-path?token=test-query-value", "Title: A test page", "Status: 200", "Kind: html", "Mode: main", `Length: ${body.replace(/\n$/, "").length} characters`, "Fetch list: strict (0 requests blocked)"]);
  assert.match(body, /^# A test page\n\nThe text of the test page/);
  assert.equal(r.launches.length, 1);
  assert.equal(r.launches[0].chrome, "/usr/bin/chromium", "the default Chromium");
  const profile = r.launches[0].args.find((x) => x.startsWith("--user-data-dir="))!.slice("--user-data-dir=".length);
  assert.ok(profile.startsWith(join(r.tmp, PROFILE_PREFIX)), profile);
  assert.equal(existsSync(profile), false, "the profile folder is gone");
  assert.deepEqual(r.profiles(), []);
  assert.equal(r.closes(), 1, "Chrome ends");
  assert.deepEqual(r.browser.disposed, ["CTX"], "fetch_end disposes the browser context");
  const m = r.browser.sent.map((s) => s.method);
  for (const x of ["Target.createBrowserContext", "Browser.setDownloadBehavior", "Target.setAutoAttach", "Target.createTarget", "Runtime.runIfWaitingForDebugger", "Fetch.enable", "Target.setAutoAttach", "Page.navigate", "Target.disposeBrowserContext"]) assert.ok(m.includes(x), x);
  assert.deepEqual(r.browser.sent.find((s) => s.method === "Browser.setDownloadBehavior")!.params, { behavior: "deny", browserContextId: "CTX" }, "downloads denied");
  assert.deepEqual(r.browser.sent.find((s) => s.method === "Target.createTarget")!.params, { url: "about:blank", browserContextId: "CTX", newWindow: true, background: true, width: 1280, height: 900 });
  assert.ok(r.browser.sent.filter((s) => s.method.startsWith("Page.") || s.method.startsWith("Fetch.")).every((s) => s.sessionId === "S1"), "the tab's commands on its own session");
  assert.ok(!m.some((x) => x.startsWith("Input.")), "no input");
  assert.equal(r.launches[0].home, profile, "Chrome's HOME is the profile folder");
  assert.ok(a.err.startsWith(`page-fetch: profile ${profile}\n`), a.err);
  assert.match(a.err.slice(a.err.indexOf("\n") + 1), /^page-fetch: scope page-fetch, host pages\.example\.test, result ok, status 200, \d+ ms, \d+ characters, 0 downloads, 0 websockets, 0 blocked by the fetch list\n$/);
  for (const s of ["a-secret-path", "token", "test-query-value", "test-fragment"]) assert.ok(!a.err.includes(s), `${s} in the log`);
});

test("page-fetch: each request of the window that the list refuses fails and is counted (an asset, a frame through its child session, a POST, a popup's request), requests on the list go on, and --json gives one document", async () => {
  const { file } = allowFile(LIST);
  const r = rig();
  r.browser.requests = [
    { url: "https://ads.example.test/tracker.js" }, { url: "https://cdn.example.test/app.js" }, { url: "https://pages.example.test/docs/api", method: "POST" },
    { url: "https://ads.example.test/frame.html", session: "frame" }, { url: "https://cdn.example.test/frame.html", session: "frame" }, { url: "https://ads.example.test/pop", session: "popup" },
  ];
  const a = await run(r, [URL1, "--allow-file", file, "--max-chars", "100"], true);
  assert.equal(a.code, 0, a.out + a.err);
  assert.deepEqual(Object.fromEntries(r.browser.answers), {
    [URL1.replace(/#.*$/, "")]: "continue", "https://ads.example.test/tracker.js": "fail", "https://cdn.example.test/app.js": "continue", "https://pages.example.test/docs/api": "fail",
    "https://ads.example.test/frame.html": "fail", "https://cdn.example.test/frame.html": "continue", "https://ads.example.test/pop": "fail",
  });
  assert.ok(r.browser.sent.some((s) => s.method === "Fetch.enable" && s.sessionId === "C1"), "the frame's own guard on its child session");
  assert.ok(r.browser.sent.some((s) => s.method === "Fetch.enable" && s.sessionId === "P1"), "the popup is held");
  assert.deepEqual(r.browser.leaked, [], "no request left before its guard");
  assert.ok(r.browser.sent.some((s) => s.method === "Runtime.evaluate" && s.sessionId === "P1" && s.params.expression === "window.close()"), "and it closes");
  const doc = JSON.parse(a.out);
  assert.deepEqual(Object.keys(doc), ["ok", "url", "title", "status", "kind", "mode", "fallback", "length", "cut", "part", "notes", "blocked", "markdown"]);
  assert.equal(doc.ok, true);
  assert.equal(doc.blocked, 4);
  assert.deepEqual(doc.part, { from: 0, to: 100, next: 100 }, "--max-chars cuts this fetch's markdown");
  assert.equal(doc.markdown.length, 100);
  assert.deepEqual([doc.status, doc.kind, doc.mode, doc.fallback, doc.cut, doc.notes], [200, "html", "main", false, false, []]);
  assert.equal(a.out.split("\n").length, 2, "one line");
  // --offset: a new fetch, cut from the offset; the part says where the next one starts.
  const b = await run(rig(), [URL1, "--allow-file", file, "--max-chars", "100", "--offset", "100"], true);
  assert.deepEqual(JSON.parse(b.out).part, { from: 100, to: 200, next: 200 });
  assert.deepEqual(r.profiles(), []);
});

test("page-fetch: a URL off the list, a refused address, and a URL with a query and a fragment: exit 1, the refusal's text (never the query or the fragment), and Chrome never starts", async () => {
  const { file } = allowFile(LIST);
  const cases: [string, string, string][] = [
    ["https://other.example.test/a-secret-path?token=test-query-value#test-fragment", LIST, "Not fetched (refused): The URL is not on the fetch list in support-fetch.json."],
    ["http://pages.example.test/docs/a", LIST, "Not fetched (refused): The URL is not on the fetch list in support-fetch.json."],
    ["https://app.localhost/x?token=test-query-value", '{"allow":["app.localhost"]}', "Not fetched (refused): The host app.localhost is a name of the box itself; PageFetch never reaches the box itself or a private network."],
    ["not a url", LIST, "Not fetched (refused): The URL must be an absolute http or https URL."],
  ];
  for (const [url, body, text] of cases) {
    const f = body === LIST ? file : allowFile(body).file;
    const r = rig();
    const a = await run(r, [url, "--allow-file", f]);
    assert.deepEqual([a.code, a.out], [1, `${text}\n`], url);
    assert.equal(r.launches.length, 0, `${url}: no Chrome`);
    assert.deepEqual(r.profiles(), [], "no profile folder");
    for (const s of ["token", "test-query-value", "test-fragment", "a-secret-path"]) assert.ok(!a.out.includes(s) && !a.err.includes(s), `${s}: ${a.out}${a.err}`);
    const j = await run(rig(), [url, "--allow-file", f], true);
    assert.deepEqual(JSON.parse(j.out), { ok: false, code: "refused", message: text });
    assert.equal(j.code, 1);
  }
  // An off-list redirect of the main document: refused, never followed, and the profile goes.
  const r = rig();
  r.browser.requests = [];
  const orig = r.browser.send.bind(r.browser);
  r.browser.send = async (m: string, p: any = {}, s?: string) => (m === "Page.navigate" ? orig(m, { ...p, url: "https://other.example.test/landing?token=test-query-value" }, s) : orig(m, p, s));
  const a = await run(r, [URL1, "--allow-file", file]);
  assert.deepEqual([a.code, a.out], [1, "Not fetched (refused): The page went on to an address that is not on the fetch list in support-fetch.json.\n"]);
  assert.deepEqual(r.profiles(), []);
});

test("page-fetch: an error and a signal end Chrome and remove the profile folder; the exit is 1 with code unavailable", async () => {
  const { file } = allowFile(LIST);
  // Chrome's target fails: the core's window does not open.
  const r = rig();
  r.browser.failing.add("Target.createTarget");
  const a = await run(r, [URL1, "--allow-file", file], true);
  assert.equal(a.code, 1);
  assert.deepEqual(JSON.parse(a.out), { ok: false, code: "unavailable", message: "Not fetched (unavailable): The agent browser could not open its fetch window." });
  assert.equal(r.closes(), 1);
  assert.deepEqual(r.profiles(), []);
  // The launch fails (no Chromium): the profile folder goes too.
  const n = rig();
  n.deps.launch = async () => { throw new Error("Chrome did not start (ENOENT)"); };
  const b = await run(n, [URL1, "--allow-file", file]);
  assert.deepEqual([b.code, b.out], [1, "Not fetched (unavailable): The agent browser could not open its fetch window.\n"]);
  assert.match(b.err, /windows\.create failed: Chrome did not start \(ENOENT\)/);
  assert.deepEqual(n.profiles(), []);
  // A signal while the page loads: Chrome ends, the profile goes, the call fails, and the forced exit is not needed.
  const s = rig();
  s.browser.hang.add("Page.navigate");
  const p = run(s, [URL1, "--allow-file", file], true);
  for (let i = 0; i < 100 && !s.browser.sent.some((x) => x.method === "Page.navigate"); i++) await new Promise((x) => setTimeout(x, 20));
  assert.equal(s.profiles().length, 1, "the profile folder while Chrome runs");
  s.signals.emit("SIGTERM");
  s.browser.hang.clear();
  const c = await p;
  assert.equal(c.code, 1);
  assert.equal(JSON.parse(c.out).code, "unavailable");
  assert.match(JSON.parse(c.out).message, /page-fetch stopped at SIGTERM/);
  assert.ok(s.closes() >= 1);
  assert.deepEqual(s.profiles(), [], "the profile folder is gone");
  assert.deepEqual(s.exits, [], "the forced exit is cleared");
  assert.equal(s.signals.listenerCount("SIGTERM"), 0, "the handlers go");
});

test("page-fetch's usage errors (exit 2, before Chrome starts): no URL, two URLs, no --allow-file, a bad --mode, --offset or --max-chars, a --chrome that cannot run, a flag of another command; --json gives {ok:false, code:usage}", async () => {
  const { file } = allowFile(LIST);
  const cases: [string[], RegExp][] = [
    [[], /usage: agent-browser page-fetch <url> --allow-file FILE/], [[URL1, URL1, "--allow-file", file], /usage: agent-browser page-fetch/],
    [[URL1], /--allow-file is required/], [[URL1, "--allow-file", ""], /--allow-file is required/],
    [[URL1, "--allow-file", file, "--mode", "all"], /--mode must be main or whole/], [[URL1, "--allow-file", file, "--offset", "-1"], /--offset must be a whole number/],
    [[URL1, "--allow-file", file, "--offset", "1.5"], /--offset must be a whole number/], [[URL1, "--allow-file", file, "--max-chars", "0"], /--max-chars must be a whole number from 1 to 5000000/],
    [[URL1, "--allow-file", file, "--max-chars", "5000001"], /--max-chars must be a whole number/], [[URL1, "--allow-file", file, "--chrome", "/no/such/chromium"], /--chrome: no program/],
    [[URL1, "--allow-file", file, "--chrome", ""], /--chrome is empty/], [[URL1, "--allow-file", file, "--cdp-url", "x"], /--cdp-url is not an option of page-fetch/],
    [[URL1, "--allow-file", file, "--state-dir", "x"], /--state-dir is not an option of page-fetch/],
  ];
  for (const [args, re] of cases) {
    const r = rig();
    const a = await run(r, args);
    assert.equal(a.code, 2, args.join(" "));
    assert.match(a.err, re, args.join(" "));
    assert.equal(a.out, "");
    assert.equal(r.launches.length, 0);
    const j = await run(rig(), args, true);
    assert.equal(j.code, 2);
    const d = JSON.parse(j.out);
    assert.deepEqual([d.ok, d.code, Object.keys(d)], [false, "usage", ["ok", "code", "message"]]);
  }
});

test("the allow file (the daemon lead's condition 3): a missing, unreadable, invalid or empty file, one that is not a regular file (a folder, a FIFO, a symbolic link), and one that its group or others can write are refused with exit 2 before Chrome starts", async () => {
  const d = tempDir("ab-page-fetch-allow-");
  const ok = join(d, "ok.json"); writeFileSync(ok, LIST); chmodSync(ok, 0o600);
  const link = join(d, "link.json"); symlinkSync(ok, link);
  const folder = join(d, "folder.json"); mkdirSync(folder);
  const fifo = join(d, "fifo.json"); execFileSync("mkfifo", [fifo]);
  const unreadable = join(d, "unreadable.json"); writeFileSync(unreadable, LIST); chmodSync(unreadable, 0o200);
  const cases: [string, RegExp][] = [
    [join(d, "none.json"), /the allow file does not exist/], [link, /the allow file is a symbolic link; give the file itself/],
    [folder, /the allow file is not a regular file/], [fifo, /the allow file is not a regular file/],
    [allowFile(LIST, 0o620).file, /its group or others can write the allow file; the run that asks for a fetch must not be able to write it/],
    [allowFile(LIST, 0o602).file, /its group or others can write the allow file/], [allowFile(LIST, 0o666).file, /its group or others can write the allow file/],
    [allowFile("{not json").file, /the allow file is not JSON/], [allowFile('{"allow":"pages.example.test"}').file, /the allow file is not \{"allow":\[<entry>\.\.\.\]\}/],
    [allowFile('{"allow":[]}').file, /the allow file has no entry/], [allowFile('{"allow":["https://pages.example.test/"]}').file, /entry 1 of the allow file is refused: give the entry with no scheme/],
    [allowFile(Buffer.from([0x7b, 0xff, 0x7d]).toString("latin1")).file, /not JSON|not UTF-8/], [allowFile(`{"allow":["a.example"],"pad":"${"x".repeat(1024 * 1024)}"}`).file, /larger than 1048576 bytes/],
  ];
  if (process.getuid?.() !== 0) cases.push([unreadable, /the allow file cannot be read \(EACCES\)/]);
  for (const [file, re] of cases) {
    const r = rig();
    const a = await run(r, [URL1, "--allow-file", file]);
    assert.equal(a.code, 2, `${file}: ${a.out}${a.err}`);
    assert.match(a.err, re, file);
    assert.equal(r.launches.length, 0, `${file}: no Chrome`);
  }
  assert.deepEqual(readAllowFile(ok), { entries: ["cdn.example.test", "pages.example.test/docs"], name: "ok.json" });
  assert.equal(readAllowFile(allowFile(LIST, 0o600, "two\nlines\u0007.json").file).name, "two?lines?.json", "the name in a text holds no control character");
  for (const mode of [0o600, 0o644, 0o400, 0o640]) assert.equal(readAllowFile(allowFile(LIST, mode).file).entries.length, 2, mode.toString(8));
  // The mode comes from the opened descriptor, so a swap between the check and the read does not pass.
  const code = readFileSync(new URL("../src/page-fetch-cli.ts", import.meta.url), "utf8");
  assert.ok(code.includes("openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)") && code.includes("const st = fstatSync(fd);") && code.includes("readSync(fd, buf"), "open once, then fstat and read the same descriptor");
  assert.ok(!/\b(statSync|lstatSync|readFileSync)\(/.test(code.slice(code.indexOf("export function readAllowFile"), code.indexOf("// ------------------------------------------------------------------ Chrome"))), "no check by path");
});

test("page-fetch through the CLI: no --cdp-url and no --state-dir; its usage error exits 2; a URL off the list exits 1 with no Chrome; other commands refuse its flags; the help names it", async () => {
  const { file } = allowFile(LIST);
  const a = io();
  assert.equal(await main(["page-fetch", "https://other.example.test/", "--allow-file", file], a.io), 1);
  assert.equal(a.out(), "Not fetched (refused): The URL is not on the fetch list in support-fetch.json.\n");
  const b = io();
  assert.equal(await main(["page-fetch", "https://other.example.test/", "--json"], b.io), 2);
  assert.equal(JSON.parse(b.out()).code, "usage");
  const c = io();
  assert.equal(await main(["page-fetch", "https://other.example.test/", "--allow-file", file, "--mode", "whole", "--json"], c.io), 1, "page-fetch takes --mode");
  for (const args of [["tabs", "--allow-file", file], ["status", "--chrome", "/usr/bin/chromium"], ["text", "t", "--max-chars", "5"], ["commands", "--offset", "3"]]) {
    const d = io();
    assert.equal(await main([...args, "--json"], d.io), 2, args.join(" "));
    assert.match(JSON.parse(d.out()).error.message, /is only for page-fetch/);
  }
  const e = io();
  assert.equal(await main(["tabs", "--mode", "x", "--json"], e.io), 2);
  assert.match(JSON.parse(e.out()).error.message, /--mode: this flag is gone with the CDP proxy/, "other commands keep the old refusal of --mode");
  const h = io();
  assert.equal(await main(["--help"], h.io), 0);
  assert.match(h.out(), /page-fetch <url> --allow-file FILE/);
});

test("Chrome's arguments: headless, the new profile, the debugging pipe (no port), the host resolver rules of the list's hosts only, no extension, the background services off", () => {
  const args = chromeArgs({ profile: "/tmp/agent-browser-page-fetch-x", hosts: ["marketdata.app", "www.marketdata.app"] });
  for (const a of ["--headless", "--user-data-dir=/tmp/agent-browser-page-fetch-x", "--remote-debugging-pipe", "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE marketdata.app, EXCLUDE www.marketdata.app",
    "--disable-extensions", "--disable-background-networking", "--disable-component-update", "--disable-sync", "--no-first-run", "--disable-domain-reliability",
    "--disable-client-side-phishing-detection", "--safebrowsing-disable-auto-update", "--no-pings", "--dns-prefetch-disable", "--disable-breakpad", "--window-size=1280,900"]) assert.ok(args.includes(a), a);
  assert.ok(!args.some((a) => /^--(remote-debugging-port|load-extension|remote-allow-origins|enable-automation|proxy-server)/.test(a)), "no port, no extension");
  // Board ab-v16.114, item 2: the Reporting API's and NEL's uploads leave outside the tab's guard, so both are off, in
  // the one --disable-features flag (a second flag would replace the first).
  const off = args.filter((a) => a.startsWith("--disable-features="));
  assert.equal(off.length, 1, "one --disable-features flag");
  const features = off[0].slice("--disable-features=".length).split(",");
  for (const f of ["Reporting", "NetworkErrorLogging", "Translate", "OptimizationHints", "MediaRouter", "NetworkTimeServiceQuerying"]) assert.ok(features.includes(f), f);
  assert.ok(!args.some((a) => a.startsWith("--enable-features=")), "no feature turned on");
  assert.throws(() => chromeArgs({ profile: "/tmp/x", hosts: [] }), /normalized hosts/);
  assert.throws(() => chromeArgs({ profile: "/tmp/x", hosts: ["a.example, MAP * 127.0.0.1"] }), /normalized hosts/, "no rule can come in through a host");
});

test("the launcher over a real pipe with a fake Chromium: it waits for the pipe's answer, gives Chrome no DISPLAY, ends it with Browser.close (a signal if it stays), and an early exit gives Chrome's error", async () => {
  const dir = tempDir("ab-page-fetch-fake-chrome-");
  const script = join(dir, "fake-chrome.mjs");
  writeFileSync(script, `import { createReadStream, createWriteStream, writeFileSync } from "node:fs";
const out = createWriteStream(null, { fd: 4 });
writeFileSync(process.argv.find((a) => a.startsWith("--out="))?.slice(6) ?? "/dev/null", JSON.stringify({ argv: process.argv.slice(2), display: process.env.DISPLAY ?? null, home: process.env.HOME ?? null, env: Object.keys(process.env).sort() }));
if (process.argv.includes("--early-exit")) { process.stderr.write("a test error of the fake Chromium\\n"); process.exit(3); }
let buf = "";
createReadStream(null, { fd: 3 }).on("data", (d) => {
  buf += d;
  for (let at = buf.indexOf("\\0"); at >= 0; at = buf.indexOf("\\0")) {
    const m = JSON.parse(buf.slice(0, at)); buf = buf.slice(at + 1);
    if (m.method === "Browser.close" && process.argv.includes("--stay")) continue;
    out.write(JSON.stringify({ id: m.id, result: m.method === "Browser.getVersion" ? { product: "FakeChrome/1" } : {} }) + "\\0");
    if (m.method === "Browser.close") setTimeout(() => process.exit(0), 10);
  }
});
process.on("SIGTERM", () => { if (!process.argv.includes("--stay-on-term")) process.exit(0); });
`);
  const chrome = join(dir, "chromium");
  writeFileSync(chrome, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  chmodSync(chrome, 0o700);
  const argvFile = join(dir, "argv.json");
  const home = join(dir, "agent-browser-page-fetch-test");
  mkdirSync(home);
  const saved = { DISPLAY: process.env.DISPLAY, https_proxy: process.env.https_proxy, CHROMIUM_FLAGS: process.env.CHROMIUM_FLAGS };
  process.env.DISPLAY = ":169";
  process.env.https_proxy = "socks5://127.0.0.1:1080";
  process.env.CHROMIUM_FLAGS = "--load-extension=/nowhere";
  // Each launch ends in the finally too, so a failed assertion leaves no fake Chromium that holds the test process.
  const open: Launched[] = [];
  try {
    const l = await launchChrome({ chrome, args: ["--headless", "--remote-debugging-pipe", `--out=${argvFile}`], home, log: () => {} });
    open.push(l);
    assert.deepEqual(await l.cdp.send("Browser.getVersion"), { product: "FakeChrome/1" });
    const got = JSON.parse(readFileSync(argvFile, "utf8"));
    assert.deepEqual([got.argv, got.display], [["--headless", "--remote-debugging-pipe", `--out=${argvFile}`], null], "no DISPLAY for Chrome");
    assert.equal(got.home, home, "Chrome's HOME is the folder that the launch gets (the fetch's profile folder), never the user's own");
    // The shell of the fake's wrapper adds its own PWD (and SHLVL, _): the rest is the minimal environment.
    assert.ok(got.env.every((k: string) => (CHROME_ENV_KEYS as readonly string[]).includes(k) || ["HOME", "PWD", "OLDPWD", "SHLVL", "_"].includes(k)), `Chrome's environment: ${got.env.join(" ")}`);
    assert.ok(got.env.includes("PATH") && !got.env.includes("https_proxy") && !got.env.includes("CHROMIUM_FLAGS"), "no proxy variable, no CHROMIUM_FLAGS");
    await l.close();
    await assert.rejects(l.cdp.send("Browser.getVersion"), /Chrome/);
    const t0 = Date.now();
    const stay = await launchChrome({ chrome, args: ["--stay"], home, log: () => {} });
    open.push(stay);
    await stay.close();
    assert.ok(Date.now() - t0 < 8000, "a Chrome that stays after Browser.close ends at a signal");
    await assert.rejects(launchChrome({ chrome, args: ["--early-exit"], home, log: () => {} }), /Chrome ended at its start \(exit code 3\): a test error of the fake Chromium/);
    await assert.rejects(launchChrome({ chrome: join(dir, "none"), args: [], home, log: () => {} }), /Chrome did not start \(ENOENT\)/);
  } finally {
    for (const x of open) await x.close().catch(() => {});
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

test("the core's ports over direct CDP: windows.create makes a browser context, the browser's auto-attach and a target, debugger.attach runs the tab on its auto-attached session, sendCommand goes on the tab's or a child's session, each session's events come as debugger.onEvent, a page of the context is a popup (tabs.onCreated), a target of another context runs and is detached, a detach and a removed target end the tab, fetch_end disposes the context", async () => {
  const b = new FakeBrowser();
  let started = 0;
  const { model, receiver } = directPorts(async () => { started++; return b; });
  const evs: any[] = [];
  model.listen((e) => evs.push(e));
  assert.equal(model.notReady(), null);
  assert.deepEqual([...receiver.features()], ["fetch"]);
  const w = await model.call("windows.create", [{ url: "about:blank", focused: false, incognito: true, width: 1280, height: 900 }, "page-fetch", "fetch"]);
  assert.deepEqual(w, { id: 1, incognito: true, focused: false, tabs: [{ id: 10, windowId: 1, incognito: true }] });
  assert.equal(started, 1, "Chrome starts at the first window");
  await model.call("debugger.attach", [10]);
  assert.ok(b.sent.some((x) => x.method === "Target.setAutoAttach" && x.sessionId === undefined && x.params.waitForDebuggerOnStart === true && x.params.flatten === true), "the browser's auto-attach");
  assert.ok(!b.sent.some((x) => x.method === "Target.attachToTarget"), "the tab's session comes from the auto-attach");
  assert.ok(b.resumed.includes("S1"), "the tab runs once attached (it waits at about:blank)");
  for (let i = 0; i < 50 && !b.detached.includes("O1"); i++) await new Promise((x) => setTimeout(x, 10));
  assert.ok(b.resumed.includes("O1") && b.detached.includes("O1"), "a target of another context runs and is detached");
  await model.call("debugger.sendCommand", [{ tabId: 10 }, "Page.enable", {}]);
  await model.call("debugger.sendCommand", [{ tabId: 10, sessionId: "C9" }, "Fetch.enable", {}]);
  assert.deepEqual(b.sent.slice(-2).map((s) => [s.method, s.sessionId]), [["Page.enable", "S1"], ["Fetch.enable", "C9"]]);
  const raw = (m: any) => (b as any).fns.forEach((f: any) => f(m));
  raw({ method: "Page.loadEventFired", params: { timestamp: 1 }, sessionId: "S1" });
  raw({ method: "Target.attachedToTarget", params: { sessionId: "C1", targetInfo: { type: "iframe" } }, sessionId: "S1" });
  raw({ method: "Fetch.requestPaused", params: { requestId: "r" }, sessionId: "C1" });
  raw({ method: "Fetch.requestPaused", params: { requestId: "x" }, sessionId: "OTHER" });
  raw({ method: "Target.attachedToTarget", params: { sessionId: "P1", targetInfo: { type: "page", targetId: "T2", openerId: "T1", browserContextId: "CTX" }, waitingForDebugger: true } });
  raw({ method: "Target.attachedToTarget", params: { sessionId: "P9", targetInfo: { type: "page", targetId: "T3", browserContextId: "OTHER" }, waitingForDebugger: true } });
  raw({ method: "Target.attachedToTarget", params: { sessionId: "SWX", targetInfo: { type: "service_worker", targetId: "SWT", browserContextId: "CTX" }, waitingForDebugger: true } });
  raw({ method: "Target.attachedToTarget", params: { sessionId: "SWY", targetInfo: { type: "service_worker", targetId: "SWT", browserContextId: "CTX" }, waitingForDebugger: true }, sessionId: "S1" });
  raw({ method: "Target.detachedFromTarget", params: { sessionId: "S1" } });
  raw({ method: "Target.targetDestroyed", params: { targetId: "T1" } });
  assert.deepEqual(evs, [
    { ev: "debugger.onEvent", source: { tabId: 10 }, method: "Page.loadEventFired", params: { timestamp: 1 } },
    { ev: "debugger.onEvent", source: { tabId: 10 }, method: "Target.attachedToTarget", params: { sessionId: "C1", targetInfo: { type: "iframe" } } },
    { ev: "debugger.onEvent", source: { tabId: 10, sessionId: "C1" }, method: "Fetch.requestPaused", params: { requestId: "r" } },
    { ev: "tabs.onCreated", tab: { id: 11, incognito: true, openerTabId: 10, windowId: 1 } },
    { ev: "debugger.onDetach", source: { tabId: 10 } },
    { ev: "tabs.onRemoved", tabId: 10 },
  ], "no event of another session, of another context's page or of a service worker");
  for (let i = 0; i < 50 && !b.resumed.includes("P1"); i++) await new Promise((x) => setTimeout(x, 10));
  const p1 = b.sent.filter((x) => x.sessionId === "P1").map((x) => x.method);
  assert.deepEqual(p1, ["Fetch.enable", "Target.setAutoAttach", "Runtime.runIfWaitingForDebugger"], "the popup's guard, then its run");
  assert.ok(b.resumed.includes("P9") && b.detached.includes("P9"), "another context's page runs and is detached");
  assert.ok(!b.resumed.includes("SWX") && !b.resumed.includes("SWY") && !b.detached.includes("SWX"), "a service worker never runs");
  await assert.rejects(model.call("downloads.cancel", [1]), /no such op/);
  assert.equal(await model.call("windows.get", [1]), null);
  assert.deepEqual(await receiver.request("fetch_end", {}, 1000), { closed: 1 });
  assert.deepEqual(b.disposed, ["CTX"]);
  await receiver.request("fetch_end", {}, 1000);
  assert.deepEqual(b.disposed, ["CTX"], "once");
});

test("page-fetch: Chrome that ends by itself while the page loads (a signal to its process group): the core's wait ends at once, the exit is 1 with unavailable, and the profile folder goes; with the command's own signal too", async () => {
  const { file } = allowFile(LIST);
  for (const signal of [false, true]) {
    const r = rig();
    r.browser.hang.add("Page.navigate");
    const t0 = Date.now();
    const p = run(r, [URL1, "--allow-file", file], true);
    for (let i = 0; i < 100 && !r.browser.sent.some((x) => x.method === "Page.navigate"); i++) await new Promise((x) => setTimeout(x, 20));
    if (signal) r.signals.emit("SIGTERM");
    r.browser.crash();
    const a = await p;
    assert.equal(a.code, 1);
    const d = JSON.parse(a.out);
    assert.equal(d.code, "unavailable");
    assert.match(d.message, signal ? /stopped at SIGTERM/ : /lost its fetch window/);
    assert.ok(Date.now() - t0 < 1200, `at once: ${Date.now() - t0} ms (the ready wait is 1.5 s)`);
    assert.deepEqual(r.profiles(), []);
    assert.deepEqual(r.exits, []);
  }
});

test("page-fetch: a signal while Chrome starts ends it as soon as it runs, and the profile folder goes only after Chrome's exit", async () => {
  const { file } = allowFile(LIST);
  const r = rig();
  const seen: boolean[] = [];
  let profile = "";
  r.deps.launch = async (o) => {
    profile = o.args.find((x) => x.startsWith("--user-data-dir="))!.slice("--user-data-dir=".length);
    await new Promise((x) => setTimeout(x, 100));
    return { cdp: r.browser, close: async () => { seen.push(existsSync(profile)); await new Promise((x) => setTimeout(x, 50)); seen.push(existsSync(profile)); } };
  };
  const p = run(r, [URL1, "--allow-file", file], true);
  for (let i = 0; i < 100 && profile === ""; i++) await new Promise((x) => setTimeout(x, 5));
  r.signals.emit("SIGINT");
  const a = await p;
  assert.equal(a.code, 1);
  assert.match(JSON.parse(a.out).message, /stopped at SIGINT/);
  assert.deepEqual(seen, [true, true], "Chrome ends (once) while its profile folder is still there");
  assert.equal(existsSync(profile), false, "then the folder goes");
  assert.ok(!r.browser.sent.some((x) => x.method === "Target.createTarget"), "no window after the signal");
});

test("page-fetch (the review of PR #214, note 2): with the browser's auto-attach a popup, a shared worker and a service worker wait before their first request; the popup's and the shared worker's requests pause in their guard, a service worker never runs, and nothing leaves before its guard", async () => {
  const { file } = allowFile(LIST);
  const r = rig();
  r.browser.requests = [
    { url: "https://ads.example.test/pop", session: "popup" },
    { url: "https://ads.example.test/shared-data", session: "shared" },
    { url: "https://ads.example.test/sw-data", session: "sw" },
  ];
  const a = await run(r, [URL1, "--allow-file", file], true);
  assert.equal(a.code, 0, a.out + a.err);
  assert.deepEqual(r.browser.leaked, [], "no request left before its guard (the old code: the three left)");
  assert.equal(r.browser.answers.get("https://ads.example.test/pop"), "fail", "the popup's first request pauses, and it fails");
  assert.equal(r.browser.answers.get("https://ads.example.test/shared-data"), "fail", "the shared worker's request pauses in its guard, off the list");
  assert.equal(r.browser.answers.get("https://ads.example.test/sw-data"), "held", "the service worker never runs");
  assert.ok(!r.browser.resumed.includes("SW1") && !r.browser.resumed.includes("SW2"));
  assert.ok(r.browser.sent.some((x) => x.method === "Fetch.enable" && x.sessionId === "W1"), "the shared worker's own guard");
  assert.equal(JSON.parse(a.out).blocked, 2, "the popup's request and the shared worker's");
});

test("page-fetch (the review of PR #214, note 1): a WebSocket off the list ends the fetch refused, with no lookup of its host, and the text names the allow file, never the query; one on the list (wss) passes the address rule", async () => {
  const { file } = allowFile(LIST);
  for (const url of ["wss://ads.example.test/socket?token=test-query-value#test-fragment", "ws://cdn.example.test/live", "wss://pages.example.test/other"]) {
    const r = rig();
    const looked: string[] = [];
    r.deps.resolve = async (h) => { looked.push(h); return RESOLVE(h); };
    r.browser.requests = [{ url, session: "socket" }];
    const a = await run(r, [URL1, "--allow-file", file], true);
    assert.equal(a.code, 1, url);
    assert.deepEqual(JSON.parse(a.out), { ok: false, code: "refused", message: "Not fetched (refused): The page opened a connection to an address that is not on the fetch list in support-fetch.json." }, url);
    assert.ok(!looked.includes("ads.example.test") && !looked.includes("cdn.example.test") || url.startsWith("wss://pages"), `${url}: no lookup of its host`);
    for (const x of ["token", "test-query-value", "test-fragment"]) assert.ok(!a.out.includes(x) && !a.err.includes(x));
    assert.deepEqual(r.profiles(), []);
  }
  const r = rig();
  const looked: string[] = [];
  r.deps.resolve = async (h) => { looked.push(h); return RESOLVE(h); };
  r.browser.requests = [{ url: "wss://cdn.example.test/live", session: "socket" }];
  const a = await run(r, [URL1, "--allow-file", file], true);
  assert.equal(a.code, 0, a.out);
  assert.ok(looked.includes("cdn.example.test"), "a socket on the list passes the address rule");
  assert.match(a.err, /, 1 websockets, 0 blocked by the fetch list\n$/);
});

test("page-fetch --json (the review of PR #214, note 5): each usage failure, also one of the parser (an unknown flag, a missing value, --offset -1), gives {ok:false,code:usage,message} and exit 2", async () => {
  const { file } = allowFile(LIST);
  for (const args of [
    ["page-fetch", URL1, "--allow-file", file, "--bogus", "--json"], ["page-fetch", URL1, "--json", "--allow-file"], ["page-fetch", URL1, "--allow-file", file, "--offset", "-1", "--json"],
    ["--json", "page-fetch", URL1, "--allow-file", file, "--nope"], ["page-fetch", URL1, "--allow-file", file, "--state-dir", "x", "--json"],
  ]) {
    const o = io();
    assert.equal(await main(args, o.io), 2, args.join(" "));
    const d = JSON.parse(o.out());
    assert.deepEqual([d.ok, d.code, Object.keys(d)], [false, "usage", ["ok", "code", "message"]], args.join(" "));
    assert.equal(o.out().split("\n").length, 2, "one document");
  }
  const o = io();
  assert.equal(await main(["tabs", "--bogus", "--json"], o.io), 2);
  assert.deepEqual(Object.keys(JSON.parse(o.out())), ["ok", "command", "error"], "the tab commands keep their own form");
});

test("Chrome's environment and proxy (the review of PR #214, note 6; board ab-v16.114, item 3): only the minimal variables go to Chrome (no proxy, no CHROMIUM_FLAGS, no display, no XDG folder, no other variable), HOME is the fetch's profile folder, and its arguments say --no-proxy-server", () => {
  const profile = "/tmp/agent-browser-page-fetch-test";
  const env = chromeEnv(profile, { PATH: "/usr/bin:/bin", HOME: "/srv/fetch-route", LANG: "C.UTF-8", TMPDIR: "/tmp", https_proxy: "socks5://127.0.0.1:1080", HTTPS_PROXY: "x", all_proxy: "x", ALL_PROXY: "x", http_proxy: "x", no_proxy: "x",
    CHROMIUM_FLAGS: "--load-extension=/x", CHROME_WRAPPER: "x", DISPLAY: ":169", WAYLAND_DISPLAY: "w", XDG_RUNTIME_DIR: "/run/user/1", XDG_CONFIG_HOME: "/srv/fetch-route/.config", XDG_CACHE_HOME: "/srv/fetch-route/.cache", GH_TOKEN: "test-token-value", SSH_AUTH_SOCK: "/x" });
  assert.deepEqual(env, { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", TMPDIR: "/tmp", HOME: profile }, "the route's own HOME never reaches Chrome");
  assert.deepEqual(chromeEnv(profile, {}), { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: profile }, "a default PATH, and HOME also with no HOME in the environment");
  assert.throws(() => chromeEnv("", {}), /absolute path/);
  assert.throws(() => chromeEnv("profile", {}), /absolute path/);
  assert.deepEqual([...CHROME_ENV_KEYS], ["PATH", "USER", "LOGNAME", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "LC_MESSAGES", "TZ", "TMPDIR"]);
  assert.ok(chromeArgs({ profile: "/tmp/x", hosts: ["a.example"] }).includes("--no-proxy-server"));
});

test("the allow file's owner (board ab-v16.114, item 1): a file that another user owns (neither root nor the user that runs the command) is refused with exit 2 before Chrome starts, and the text names no path; root's file and the user's own pass", async (t) => {
  const me = process.geteuid!();
  const { dir, file } = allowFile(LIST);
  // Root's file passes for every user, and as root the test's file is root's (review-215 note 1): as root the file gets
  // another owner (no such user needs to exist), and a root that cannot do that (a user namespace) skips the test.
  let owner = me;
  if (me === 0) {
    try { chownSync(file, 4242, 4242); owner = 4242; }
    catch { t.skip("root that cannot give the test's file another owner"); return; }
  }
  const other = owner + 1;
  assert.throws(() => readAllowFile(file, other), /^UsageError: --allow-file: another user owns the allow file; root or the user that runs page-fetch must own it \(chown\)$/);
  assert.throws(() => readAllowFile(file, 0), /another user owns the allow file/, "root's run takes only root's file");
  assert.equal(readAllowFile(file, owner).entries.length, 2, "the owner's own file");
  if (me === 0) assert.throws(() => readAllowFile(file), /another user owns the allow file/, "root's run (process.geteuid() by default) refuses another user's file");
  else assert.equal(readAllowFile(file).entries.length, 2, "the user's own file (process.geteuid() by default)");
  // Through the command: exit 2, no Chrome, no profile folder, and no path of the box in the text.
  for (const json of [false, true]) {
    const r = rig();
    r.deps.euid = other;
    const a = await run(r, [URL1, "--allow-file", file], json);
    assert.equal(a.code, 2, a.out + a.err);
    assert.match(json ? JSON.parse(a.out).message : a.err, /another user owns the allow file/);
    assert.equal(r.launches.length, 0, "no Chrome");
    assert.deepEqual(r.profiles(), []);
    assert.ok(!(a.out + a.err).includes(dir) && !(a.out + a.err).includes("support-fetch.json"), `no path in the text: ${a.out}${a.err}`);
  }
  // A file of root passes the owner rule (here it is no allow file: the next check refuses it).
  const rootFile = "/etc/hosts";
  if (existsSync(rootFile) && lstatSync(rootFile).isFile() && lstatSync(rootFile).uid === 0 && (lstatSync(rootFile).mode & 0o022) === 0) {
    assert.throws(() => readAllowFile(rootFile, other), (e: Error) => !/another user owns/.test(e.message) && /--allow-file: /.test(e.message), "root's file passes the owner rule");
  }
});

test("page-fetch (board ab-v16.114, item 4): a target of the fetch's context of a type with no guard (a worklet, other) stays held and never runs, also after fetch_end; targets of another context and Chrome's own UI targets still run and are detached", async () => {
  // Through the command: the page's worklet target never runs, so its request never leaves.
  const { file } = allowFile(LIST);
  const r = rig();
  r.browser.requests = [{ url: "https://ads.example.test/worklet-data", session: "worklet" }];
  const a = await run(r, [URL1, "--allow-file", file], true);
  assert.equal(a.code, 0, a.out + a.err);
  assert.equal(r.browser.answers.get("https://ads.example.test/worklet-data"), "held", "the worklet never runs (the old code: it ran with no guard, and its request left)");
  assert.deepEqual(r.browser.leaked, []);
  assert.ok(!r.browser.resumed.includes("WL1") && !r.browser.detached.includes("WL1"));
  // The ports alone.
  const b = new FakeBrowser();
  const { model, receiver } = directPorts(async () => b);
  const evs: any[] = [];
  model.listen((e) => evs.push(e));
  await model.call("windows.create", [{ url: "about:blank", focused: false, incognito: true, width: 1280, height: 900 }, "page-fetch", "fetch"]);
  await model.call("debugger.attach", [10]);
  const raw = (m: any) => (b as any).fns.forEach((f: any) => f(m));
  const attach = (sessionId: string, type: string, browserContextId?: string, url = "") => raw({ method: "Target.attachedToTarget", params: { sessionId, targetInfo: { type, targetId: `${sessionId}T`, url, ...(browserContextId ? { browserContextId } : {}) }, waitingForDebugger: true } });
  const before = evs.length;
  attach("WK1", "worklet", "CTX");
  attach("OT1", "other", "CTX");
  attach("NEW1", "a_type_of_a_later_chrome", "CTX");
  attach("WK2", "worklet", "OTHER");
  attach("UI1", "browser_ui", "CTX", "chrome://omnibox-popup.top-chrome/");
  attach("UI2", "browser_ui", undefined, "chrome://omnibox-popup.top-chrome/");
  for (let i = 0; i < 50 && !["WK2", "UI1", "UI2"].every((x) => b.detached.includes(x)); i++) await new Promise((x) => setTimeout(x, 10));
  for (const x of ["WK1", "OT1", "NEW1"]) assert.ok(!b.resumed.includes(x) && !b.detached.includes(x), `${x}: held, never runs`);
  for (const x of ["WK2", "UI1", "UI2"]) assert.ok(b.resumed.includes(x) && b.detached.includes(x), `${x}: runs and is detached`);
  assert.equal(evs.length, before, "the core gets no event of them");
  // After fetch_end the context is still the fetch's: a target that attaches while it ends is held (a worklet, a
  // service worker), and a page gets its guard before it runs.
  await receiver.request("fetch_end", {}, 1000);
  attach("WK3", "worklet", "CTX");
  attach("SW3", "service_worker", "CTX");
  attach("PG3", "page", "CTX");
  for (let i = 0; i < 50 && !b.resumed.includes("PG3"); i++) await new Promise((x) => setTimeout(x, 10));
  for (const x of ["WK3", "SW3"]) assert.ok(!b.resumed.includes(x) && !b.detached.includes(x), `${x} after fetch_end: held`);
  assert.deepEqual(b.sent.filter((x) => x.sessionId === "PG3").map((x) => x.method), ["Fetch.enable", "Target.setAutoAttach", "Runtime.runIfWaitingForDebugger"], "a page after fetch_end: its guard, then its run (the old code: it ran with no guard)");
});

test("page-fetch (board ab-v16.114, item 5): one line on standard error names the profile folder before Chrome starts, so a route that kills the command can remove that one folder; no line when Chrome never starts; a temp folder whose path holds a control character starts no Chrome", async () => {
  const { file } = allowFile(LIST);
  const r = rig();
  let errAtLaunch = "";
  const o = io();
  const launch = r.deps.launch!;
  r.deps.launch = async (x) => { errAtLaunch = o.err(); return launch(x); };
  assert.equal(await runPageFetchCommand({ "allow-file": file }, [URL1], o.io, r.deps), 0, o.out() + o.err());
  const profile = r.launches[0].args.find((x) => x.startsWith("--user-data-dir="))!.slice("--user-data-dir=".length);
  const lines = o.err().split("\n").filter((l) => l.startsWith("page-fetch: profile "));
  assert.deepEqual(lines, [`page-fetch: profile ${profile}`], "one line, with the folder's absolute path");
  assert.ok(profile.startsWith("/") && profile.startsWith(join(r.tmp, PROFILE_PREFIX)), profile);
  assert.equal(errAtLaunch, `page-fetch: profile ${profile}\n`, "the line comes before Chrome starts");
  assert.deepEqual(r.profiles(), []);
  // A URL off the list starts no Chrome and makes no folder: no line.
  const n = rig();
  const b = await run(n, ["https://other.example.test/", "--allow-file", file]);
  assert.equal(b.code, 1);
  assert.ok(!b.err.includes("page-fetch: profile"), b.err);
  // A relative temp folder (a relative TMPDIR, review-215 note 2) is made absolute: the line names an absolute path,
  // Chrome's HOME is it, and the folder goes after the fetch.
  const rel = rig();
  rel.deps.tmp = relative(process.cwd(), rel.tmp);
  assert.ok(!rel.deps.tmp.startsWith("/"), rel.deps.tmp);
  const e = await run(rel, [URL1, "--allow-file", file]);
  assert.equal(e.code, 0, e.out + e.err);
  const line = e.err.split("\n").find((l) => l.startsWith("page-fetch: profile "))!;
  assert.ok(line.startsWith(`page-fetch: profile ${join(rel.tmp, PROFILE_PREFIX)}`), line);
  assert.equal(rel.launches[0].home, line.slice("page-fetch: profile ".length));
  assert.deepEqual(rel.profiles(), []);
  // A temp folder with a newline, another C0 character, DEL, a C1 character (U+0085 is a line end for some readers) or a
  // line or paragraph separator in its path would break the one line (review-215 note 3): no folder, no Chrome, exit 1.
  for (const name of ["two\nlines", "a\tb", "a\x7fb", "a\u0085b", "a\u009fb", "a\u0080b", "a\u2028b", "a\u2029b"]) {
    const c = rig();
    const odd = join(c.tmp, name);
    mkdirSync(odd);
    c.deps.tmp = odd;
    const d = await run(c, [URL1, "--allow-file", file], true);
    assert.equal(d.code, 1, JSON.stringify(name));
    assert.equal(JSON.parse(d.out).code, "unavailable");
    assert.equal(c.launches.length, 0, `${JSON.stringify(name)}: no Chrome`);
    assert.deepEqual(readdirSync(odd), [], "no profile folder");
    assert.ok(!d.err.includes("page-fetch: profile"));
  }
  // Other characters outside ASCII pass (a folder name in UTF-8).
  const u = rig();
  const utf = join(u.tmp, "dossier-é");
  mkdirSync(utf);
  u.deps.tmp = utf;
  assert.equal((await run(u, [URL1, "--allow-file", file])).code, 0);
});

test("page-fetch (review-215 note 8): the removal of the profile folder retries a late write, and a removal that fails changes neither the exit code nor the output; a log line says so", async () => {
  const { file } = allowFile(LIST);
  const r = rig();
  let profile = "";
  const launch = r.deps.launch!;
  // Chrome leaves a folder in the profile that this user cannot empty (root can: then the removal works).
  r.deps.launch = async (x) => {
    profile = x.home;
    mkdirSync(join(profile, "locked"));
    writeFileSync(join(profile, "locked", "late"), "x");
    chmodSync(join(profile, "locked"), 0o500);
    return launch(x);
  };
  try {
    const a = await run(r, [URL1, "--allow-file", file], true);
    assert.equal(a.code, 0, a.out + a.err);
    assert.equal(JSON.parse(a.out).ok, true, "the output is the answer");
    if (process.getuid?.() !== 0) {
      assert.match(a.err, /\nagent-browser: page-fetch: the profile folder could not be removed \(EACCES\)\n/);
      assert.ok(existsSync(profile), "the folder stays for the route, which has its name from the profile line");
    } else assert.equal(existsSync(profile), false);
  } finally {
    if (existsSync(join(profile, "locked"))) chmodSync(join(profile, "locked"), 0o700);
  }
  // The removal retries (Node's rmSync retries ENOTEMPTY and EBUSY only with maxRetries).
  const code = readFileSync(new URL("../src/page-fetch-cli.ts", import.meta.url), "utf8");
  assert.ok(code.includes("rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })"));
});
