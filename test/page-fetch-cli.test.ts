// `agent-browser page-fetch` (board ab-v16.113; src/page-fetch-cli.ts; the README, "PageFetch without agentwatch"): the
// usage errors, the allow file's checks (before Chrome starts), the exit codes, the text and the JSON forms, the core's
// ports over direct CDP (a fake browser in this process), the cleanup of the profile folder after a fetch, an error and a
// signal, Chrome's arguments, and the launcher over a real pipe with a fake Chromium. No real Chrome, no network: every
// host here is a test value, and the fake resolver gives test addresses.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { main } from "../src/cli.ts";
import { chromeArgs, directPorts, launchChrome, runPageFetchCommand, PROFILE_PREFIX, readAllowFile, type Cdp, type Launched, type PageFetchDeps } from "../src/page-fetch-cli.ts";
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
  requests: { url: string; method?: string; session?: "frame" | "popup" }[] = [];
  closed = 0;
  disposed: string[] = [];
  private readonly closers = new Set<() => void>();
  private readonly hung = new Set<(e: Error) => void>();
  private dead = false;
  listen(fn: (m: any) => void) { this.fns.add(fn); }
  onClose(fn: () => void) { this.closers.add(fn); }
  /** Chrome ends by itself (a signal to the process group, a crash): its pipe closes, and each command fails. */
  crash() { this.dead = true; for (const r of [...this.hung]) r(new Error("Chrome closed its debugging pipe")); for (const f of [...this.closers]) f(); }
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
      case "Target.createTarget": return { targetId: "T1" };
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
          this.emit("Target.targetCreated", { targetInfo: { type: "page", targetId: "T2", openerId: "T1", browserContextId: "CTX", url: "" } });
          await new Promise((r) => setTimeout(r, 30));
          await this.pause(q.url, "P1", "Document", q.method ?? "GET", "PF");
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
  const launches: { chrome: string; args: string[] }[] = [];
  let closes = 0;
  const signals = new EventEmitter();
  const exits: number[] = [];
  const deps: PageFetchDeps = {
    tmp, resolve: RESOLVE, signals, exit: (c) => exits.push(c),
    limits: { readyMs: 1_500, wholeMs: 4_000, settleMs: 40, quietMs: 10, endMs: 600, receiverMs: 200, goneMs: 150 },
    launch: async (o): Promise<Launched> => { launches.push({ chrome: o.chrome, args: o.args }); return { cdp: browser, close: async () => { closes++; browser.closed++; } }; },
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
  for (const x of ["Target.createBrowserContext", "Browser.setDownloadBehavior", "Target.createTarget", "Target.attachToTarget", "Fetch.enable", "Target.setAutoAttach", "Page.navigate", "Target.disposeBrowserContext"]) assert.ok(m.includes(x), x);
  assert.deepEqual(r.browser.sent.find((s) => s.method === "Browser.setDownloadBehavior")!.params, { behavior: "deny", browserContextId: "CTX" }, "downloads denied");
  assert.deepEqual(r.browser.sent.find((s) => s.method === "Target.createTarget")!.params, { url: "about:blank", browserContextId: "CTX", newWindow: true, background: true, width: 1280, height: 900 });
  assert.ok(r.browser.sent.filter((s) => s.method.startsWith("Page.") || s.method.startsWith("Fetch.")).every((s) => s.sessionId === "S1"), "the tab's commands on its own session");
  assert.ok(!m.some((x) => x.startsWith("Input.")), "no input");
  assert.match(a.err, /^page-fetch: scope page-fetch, host pages\.example\.test, result ok, status 200, \d+ ms, \d+ characters, 0 downloads, 0 websockets, 0 blocked by the fetch list\n$/);
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
  assert.ok(r.browser.sent.some((s) => s.method === "Target.attachToTarget" && s.params.targetId === "T2"), "the popup is held");
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
  assert.throws(() => chromeArgs({ profile: "/tmp/x", hosts: [] }), /normalized hosts/);
  assert.throws(() => chromeArgs({ profile: "/tmp/x", hosts: ["a.example, MAP * 127.0.0.1"] }), /normalized hosts/, "no rule can come in through a host");
});

test("the launcher over a real pipe with a fake Chromium: it waits for the pipe's answer, gives Chrome no DISPLAY, ends it with Browser.close (a signal if it stays), and an early exit gives Chrome's error", async () => {
  const dir = tempDir("ab-page-fetch-fake-chrome-");
  const script = join(dir, "fake-chrome.mjs");
  writeFileSync(script, `import { createReadStream, createWriteStream, writeFileSync } from "node:fs";
const out = createWriteStream(null, { fd: 4 });
writeFileSync(process.env.FAKE_CHROME_ARGV, JSON.stringify({ argv: process.argv.slice(2), display: process.env.DISPLAY ?? null }));
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
  process.env.FAKE_CHROME_ARGV = argvFile;
  const before = process.env.DISPLAY;
  process.env.DISPLAY = ":169";
  try {
    const l = await launchChrome({ chrome, args: ["--headless", "--remote-debugging-pipe"], log: () => {} });
    assert.deepEqual(await l.cdp.send("Browser.getVersion"), { product: "FakeChrome/1" });
    assert.deepEqual(JSON.parse(readFileSync(argvFile, "utf8")), { argv: ["--headless", "--remote-debugging-pipe"], display: null }, "no DISPLAY for Chrome");
    await l.close();
    await assert.rejects(l.cdp.send("Browser.getVersion"), /Chrome/);
    const t0 = Date.now();
    const stay = await launchChrome({ chrome, args: ["--stay"], log: () => {} });
    await stay.close();
    assert.ok(Date.now() - t0 < 8000, "a Chrome that stays after Browser.close ends at a signal");
    await assert.rejects(launchChrome({ chrome, args: ["--early-exit"], log: () => {} }), /Chrome ended at its start \(exit code 3\): a test error of the fake Chromium/);
    await assert.rejects(launchChrome({ chrome: join(dir, "none"), args: [], log: () => {} }), /Chrome did not start \(ENOENT\)/);
  } finally {
    if (before === undefined) delete process.env.DISPLAY; else process.env.DISPLAY = before;
    delete process.env.FAKE_CHROME_ARGV;
  }
});

test("the core's ports over direct CDP: windows.create makes a browser context and a target, debugger.attach the target's flat session, sendCommand goes on the tab's or a child's session, each session's events come as debugger.onEvent, a popup is tabs.onCreated, a detach and a removed target end the tab, fetch_end disposes the context", async () => {
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
  await model.call("debugger.sendCommand", [{ tabId: 10 }, "Page.enable", {}]);
  await model.call("debugger.sendCommand", [{ tabId: 10, sessionId: "C9" }, "Fetch.enable", {}]);
  assert.deepEqual(b.sent.slice(-2).map((s) => [s.method, s.sessionId]), [["Page.enable", "S1"], ["Fetch.enable", "C9"]]);
  const raw = (m: any) => (b as any).fns.forEach((f: any) => f(m));
  raw({ method: "Page.loadEventFired", params: { timestamp: 1 }, sessionId: "S1" });
  raw({ method: "Target.attachedToTarget", params: { sessionId: "C1", targetInfo: { type: "iframe" } }, sessionId: "S1" });
  raw({ method: "Fetch.requestPaused", params: { requestId: "r" }, sessionId: "C1" });
  raw({ method: "Fetch.requestPaused", params: { requestId: "x" }, sessionId: "OTHER" });
  raw({ method: "Target.targetCreated", params: { targetInfo: { type: "page", targetId: "T2", openerId: "T1", browserContextId: "CTX" } } });
  raw({ method: "Target.targetCreated", params: { targetInfo: { type: "page", targetId: "T3", openerId: "T9", browserContextId: "CTX" } } });
  raw({ method: "Target.detachedFromTarget", params: { sessionId: "S1" } });
  raw({ method: "Target.targetDestroyed", params: { targetId: "T1" } });
  assert.deepEqual(evs, [
    { ev: "debugger.onEvent", source: { tabId: 10 }, method: "Page.loadEventFired", params: { timestamp: 1 } },
    { ev: "debugger.onEvent", source: { tabId: 10 }, method: "Target.attachedToTarget", params: { sessionId: "C1", targetInfo: { type: "iframe" } } },
    { ev: "debugger.onEvent", source: { tabId: 10, sessionId: "C1" }, method: "Fetch.requestPaused", params: { requestId: "r" } },
    { ev: "tabs.onCreated", tab: { id: 11, incognito: true, openerTabId: 10, windowId: 1 } },
    { ev: "debugger.onDetach", source: { tabId: 10 } },
    { ev: "tabs.onRemoved", tabId: 10 },
  ], "no event of another session or of a page that no tab of the context opened");
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
