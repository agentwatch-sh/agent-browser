// The CLI's JSON contract: the real bin/agent-browser.js in child processes, against the fake
// Chrome. Each call prints exactly one JSON document; failures carry a stable error code.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { COMMAND_SPECS, commands } from "../src/commands.ts";
import { redact } from "../src/outline.ts";
import { REMOVED_OPTIONS, resolveOptions } from "../src/options.ts";
import { Tab } from "../src/browser.ts";
import { CDPError } from "../src/cdp.ts";
import { optionsFromFlags } from "../src/cli.ts";
import { findFfmpeg, planRecording } from "../src/record.ts";
import { FakeChrome, type FakePage } from "./fake-chrome.ts";
import { BIN, cli, consumer, fixtureServer, flags, site, type CliRun, type Consumer, type Fixture } from "./helpers.ts";

let fx: Fixture, fake: FakeChrome, c: Consumer, mail: FakePage;

/** A cdpUrl whose socket no process serves: a command that gets that far fails with code unreachable, never usage. */
const NO_ENDPOINT = "ws+unix:///tmp/ab-no-endpoint.sock:/devtools/browser/t";

test("an empty path is a usage error, never the current folder: every path flag, shot's path and record's scripts (ab-b84.9)", async () => {
  assert.throws(() => optionsFromFlags({ "state-dir": "/tmp/ab-empty", "cdp-url": NO_ENDPOINT, allowlist: "" }, () => {}), /^UsageError: --allowlist is empty/);
  assert.throws(() => optionsFromFlags({ "state-dir": "", "cdp-url": NO_ENDPOINT }, () => {}), /--state-dir is required/);
  for (const what of ["script", "setup"])
    assert.throws(() => planRecording({ out: "/tmp/ab-empty/c.mp4", [what]: "" }, []), new RegExp(`^UsageError: --${what} is empty`), what);
  assert.throws(() => planRecording({ out: "" }, []), /--out is required/);
  assert.throws(() => findFfmpeg(""), /--ffmpeg must be an absolute path/);
  const own = consumer();
  try {
    // Through the real CLI, in a temp folder: refused before any browser call (not by the endpoint's "did not answer"),
    // with the usage code and exit status 2.
    for (const [args, why] of [[["tabs", "--allowlist", ""], /--allowlist is empty/], [["shot", "work", ""], /path is empty/],
      [["fetch", "work", "https://x.example/", ""], /path is required/], [["record", "work", "--out", "c.mp4", "--script", ""], /--script is empty/]] as [string[], RegExp][]) {
      const allow = args.includes("--allowlist") ? [] : ["--allowlist", own.allowlist];
      const r = await cli([...args, "--state-dir", own.stateDir, ...allow, "--cdp-url", NO_ENDPOINT, "--json"], { cwd: own.dir });
      assert.equal(r.status, 2, `${args.join(" ")}: ${r.stdout}`);
      assert.equal(r.json?.error?.code, "usage", args.join(" "));
      assert.match(r.json.error.message, why, args.join(" "));
    }
  } finally { own.remove(); }
});

test("board ab-v16.9.3: agent mode's endpoint is the only way; each command and flag of the CDP proxy is refused by name, with the way to the endpoint", async () => {
  const own = consumer();
  const WAY = /gone with the CDP proxy; agent mode's endpoint \(cdpUrl; CLI --cdp-url URL; Python cdp_url=\) is the only way to drive the agent browser: get it with `agentwatch browser endpoint`/;
  try {
    const base = ["--state-dir", own.stateDir, "--allowlist", own.allowlist, "--cdp-url", NO_ENDPOINT, "--json"];
    for (const command of ["launch", "quit", "connect", "stop", "chromes", "front", "proxy", "give-back-watch"]) {
      const r = await cli([command, ...base]);
      assert.equal(r.status, 2, command);
      assert.equal(r.json.error.code, "usage", command);
      assert.match(r.json.error.message, new RegExp(`^${command}: this command is ${WAY.source}`), command);
    }
    for (const flag of [["--profile", "p"], ["--socket", "/tmp/s.sock"], ["--mode", "personal"], ["--chrome-bin", "/usr/bin/chromium"], ["--chrome-args", "[]"],
      ["--endpoint", "ws://127.0.0.1:9/devtools/browser/x"], ["--personal-user-data-dir", "/tmp/ud"], ["--no-launch"], ["--no-prompt"], ["--notify"],
      ["--notify-command", "[\"true\"]"], ["--approve", "auto"], ["--approve-command", "[\"true\"]"], ["--approve-after-wake"], ["--proxy-idle-ms", "1"], ["--login"],
      ["--wake-approve", "1"], ["--chrome-pid", "1"], ["--watch-back-command", "[\"true\"]"]]) {
      const r = await cli(["tabs", ...flag, ...base]);
      assert.equal(r.status, 2, flag[0]);
      assert.equal(r.json.error.code, "usage", flag[0]);
      assert.match(r.json.error.message, new RegExp(`^${flag[0]}: ${flag[0] === "--socket" ? "this flag of the CDP proxy is gone \\(it stays the relay's own flag\\); agent mode's endpoint" : `this flag is ${WAY.source}`}`), flag[0]);
    }
    const none = await cli(["tabs", "--state-dir", own.stateDir, "--allowlist", own.allowlist, "--json"]);
    assert.equal(none.json.error.code, "usage");
    assert.match(none.json.error.message, /^--cdp-url is required: agent mode's endpoint/);
    // The library refuses the old options by name too.
    assert.throws(() => resolveOptions({ stateDir: own.stateDir } as never), /^UsageError: cdpUrl is required: agent mode's endpoint/);
    for (const k of REMOVED_OPTIONS)
      assert.throws(() => resolveOptions({ stateDir: own.stateDir, cdpUrl: NO_ENDPOINT, [k]: k === "noLaunch" ? true : "x" } as never), new RegExp(`^UsageError: ${k}: this option is gone with the CDP proxy; `), k);
  } finally { own.remove(); }
});

test("the CLI takes a relative path flag from its current folder; a Node option must be absolute (README: Paths)", () => {
  const own = consumer();
  const before = process.cwd();
  process.chdir(own.dir);
  try {
    const here = process.cwd();
    const o = optionsFromFlags({ "state-dir": "st", allowlist: "allow.json", "cdp-url": NO_ENDPOINT }, () => {});
    assert.deepEqual([o.stateDir, o.allowlistFile], ["st", "allow.json"].map((p) => join(here, p)));
    // record's paths resolve from the current folder too, in the CLI and in the library: the missing script is named there.
    assert.throws(() => planRecording({ out: "c.mp4", script: "nope.json" }, []), (e: Error) => e.message.includes(join(here, "nope.json")));
  } finally {
    process.chdir(before);
    own.remove();
  }
  for (const [k, v] of [["stateDir", "st"], ["allowlistFile", "a.json"]])
    assert.throws(() => resolveOptions({ stateDir: "/tmp/ab-abs", cdpUrl: NO_ENDPOINT, [k]: v }), new RegExp(`${k} must be an absolute path`), k);
  assert.throws(() => findFfmpeg("ffmpeg"), /--ffmpeg must be an absolute path/, "--ffmpeg is the exception");
});

const outputs: CliRun[] = [];

before(async () => {
  fx = await fixtureServer();
  fake = await FakeChrome.start(site(fx.base));
  c = consumer();
  mail = fake.addPage("https://mail.example.org/inbox?thread=secret-subject");
});

after(async () => {
  await fake?.close();
  await fx?.close();
  c?.remove();
});

/** How many calls of `method` the fake browser got for the tab. */
const callCount = (targetId: string, method: string) => fake.callsFor(targetId).filter((x) => x.method === method).length;

/**
 * Waits until the fake browser got more than `before` calls of `method` for the tab, within `ms` (board ab-b84.29: the
 * net tests wait for the event that they need, not a fixed time, so a slow start of the CLI on a loaded box breaks nothing).
 */
async function untilCall(targetId: string, method: string, before: number, ms = 20_000): Promise<void> {
  const t0 = Date.now();
  while (callCount(targetId, method) <= before) {
    if (Date.now() - t0 > ms) throw new Error(`the fake browser got no ${method} for the tab in ${ms} ms`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Run a command for the test consumer with --json, and check the one-document contract. */
async function run(args: string[], opts: { input?: string; consumer?: Consumer; extra?: string[] } = {}): Promise<CliRun> {
  const r = await cli([...args, ...flags(opts.consumer ?? c, fake.cdpUrl, opts.extra), "--json"], { input: opts.input });
  outputs.push(r);
  assert.equal(r.stdout.trim().split("\n").length, 1, `one line on stdout: ${r.stdout}`);
  assert.ok(r.json && typeof r.json === "object", `JSON on stdout: ${r.stdout} ${r.stderr}`);
  assert.equal(typeof r.json.ok, "boolean");
  assert.equal(r.json.command, args[0]);
  if (r.json.ok) assert.equal(r.status, 0, r.stdout);
  else {
    assert.equal(typeof r.json.error.code, "string");
    assert.equal(typeof r.json.error.message, "string");
    assert.equal(r.status, r.json.error.code === "usage" ? 2 : 1);
  }
  return r;
}

const TAB_KEYS = ["id", "name", "targetId", "title", "url"];
const assertTab = (t: any) => {
  assert.deepEqual(Object.keys(t).sort(), TAB_KEYS);
  assert.equal(t.id, t.targetId.slice(0, 8));
};

test("redact masks tokens, keys and JWTs", () => {
  const jwt = "eyJhbGciOiJSUzI1NiJ9.eyJuYW1lIjoiQWxpY2UifQ.c2lnbmF0dXJlc2lnbmF0dXJl";
  const out = redact(`{"idToken":"${jwt}","api_key":"abc123","refresh_token":"zzz","prompt":"a cat"} https://x.io/v1?key=SECRET&q=1 ${jwt}`);
  assert.ok(!out.includes("abc123") && !out.includes("zzz") && !out.includes("SECRET") && !out.includes(jwt));
  assert.match(out, /"prompt":"a cat"/);
  assert.match(out, /q=1/);
});

test("commands --json describes every operation, and the library has exactly those operations", async () => {
  const r = await cli(["commands", "--json"]);
  assert.equal(r.status, 0);
  assert.deepEqual(r.json, { ok: true, command: "commands", commands: COMMAND_SPECS });
  assert.deepEqual(Object.keys(commands).sort(), COMMAND_SPECS.map((s) => s.name).sort());
  for (const spec of COMMAND_SPECS) for (const p of spec.params) {
    assert.match(p.name, /^[a-z][A-Za-z]*$/, `${spec.name}.${p.name}`);
    assert.ok(["string", "boolean", "number"].includes(p.type));
  }
});

test("usage errors are JSON documents with code usage and exit status 2", async () => {
  const cases: [string[], RegExp][] = [
    [["tabs", "--cdp-url", fake.cdpUrl, "--json"], /--state-dir is required/],
    [["tabs", "--state-dir", c.stateDir, "--json"], /--cdp-url is required/],
    [["nonsense", "--json"], /unknown command/],
    [["tabs", "--any", "--state-dir", c.stateDir, "--json"], /Unknown option '--any'/],
    [["tabs", "--text", "x", "--state-dir", c.stateDir, "--json"], /--text is not an option of tabs/],
    [["open", "--state-dir", c.stateDir, "--cdp-url", fake.cdpUrl, "--json"], /usage: agent-browser open <url>/],
    [["click", "x", "--bogus", "--json"], /Unknown option '--bogus'/],
    [["tabs", "--state-dir", "rel/../x", "--cdp-url", "ws://127.0.0.1:9/devtools/browser/x", "--json"], /cdpUrl must be agent mode's endpoint/],
  ];
  for (const [args, message] of cases) {
    // The CLI takes a relative --state-dir from the current folder: run in the consumer's own temp folder.
    const r = await cli(args, { cwd: c.dir });
    assert.equal(r.status, 2, args.join(" "));
    assert.equal(r.json.ok, false);
    assert.equal(r.json.error.code, "usage");
    assert.match(r.json.error.message, message, args.join(" "));
  }
  const help = await cli(["--help", "--json"]);
  assert.equal(help.json.command, "help");
  assert.match(help.json.usage, /--cdp-url URL/);
  assert.doesNotMatch(help.json.usage, /proxy socket|--approve|personal|chrome:\/\/inspect/);
});

test("a full session: every tab command prints its documented JSON shape", async () => {
  const allowBefore = { text: readFileSync(c.allowlist, "utf8"), mtime: statSync(c.allowlist).mtimeMs };

  let r = await run(["tabs"]);
  assert.deepEqual(r.json, { ok: true, command: "tabs", tabs: [], window: null });

  r = await run(["open", fx.base + "/", "--name", "work"]);
  assert.deepEqual(Object.keys(r.json).sort(), ["command", "ok", "tab", "window"]);
  assertTab(r.json.tab);
  assert.equal(r.json.tab.name, "work");
  assert.equal(r.json.tab.url, fx.base + "/");
  assert.equal(r.json.tab.title, "t");
  const id = r.json.tab.id;

  r = await run(["tabs"]);
  assert.equal(r.json.tabs.length, 1);
  assertTab(r.json.tabs[0]);
  assert.equal(r.json.tabs[0].name, "work");

  r = await run(["shot", "work"]);
  assert.equal(r.json.error.code, "read_first", "a screenshot before reading the page is refused");

  r = await run(["outline", "work"]);
  assert.deepEqual(Object.keys(r.json).sort(), ["command", "elements", "ok", "tab"]);
  for (const e of r.json.elements) assert.deepEqual(Object.keys(e).sort(), ["href", "index", "label", "role", "type"]);
  assert.deepEqual(r.json.elements[0], { index: 1, role: "button", type: null, label: "Go", href: null });
  assert.deepEqual(r.json.elements[1], { index: 2, role: "input", type: "text", label: "Name", href: null });
  assert.deepEqual(r.json.elements.find((e: any) => e.label === "Next"), { index: 8, role: "a", type: null, label: "Next", href: "/next" });
  assert.ok(!r.json.elements.some((e: any) => e.label === "Hidden" || e.label === "Below the fold"), "only visible elements in the viewport");
  r = await run(["outline", "work", "--all"]);
  assert.ok(r.json.elements.some((e: any) => e.label === "Below the fold"));

  r = await run(["click", "work", "#1"]);
  assert.deepEqual(r.json, { ok: true, command: "click", tab: r.json.tab, target: "#1", text: null });
  r = await run(["eval", "work", "document.title"]);
  assert.equal(r.json.value, "clicked");
  r = await run(["eval", "work", "--stdin"], { input: "({ a: 1, b: [2, 3] })" });
  assert.deepEqual(r.json.value, { a: 1, b: [2, 3] });
  r = await run(["eval", "work", "undefined"]);
  assert.equal(r.json.value, null);

  r = await run(["click", "work", "--text", "Go"]);
  assert.equal(r.json.text, "Go");
  r = await run(["hover", "work", "#1"]);
  assert.equal(r.json.target, "#1");

  const secret = "hunter2-not-in-argv";
  r = await run(["type", "work", "--stdin", "--into", "#2"], { input: secret });
  assert.deepEqual({ ...r.json, tab: undefined }, { ok: true, command: "type", tab: undefined, into: "#2", length: secret.length });
  assert.ok(!r.stdout.includes(secret) && !r.stderr.includes(secret), "the typed text is never echoed");
  r = await run(["eval", "work", "document.querySelector('#i').value"]);
  assert.equal(r.json.value, secret);

  r = await run(["press", "work", "Enter"]);
  assert.equal(r.json.key, "Enter");
  r = await run(["press", "work", "F13"]);
  assert.equal(r.json.error.code, "usage");

  await new Promise((resolve) => setTimeout(resolve, 350)); // the fixture fills #later after 300 ms
  r = await run(["text", "work"]);
  assert.match(r.json.text, /Fixture page/);
  assert.match(r.json.text, /ready/);
  assert.equal(r.json.selector, null);
  r = await run(["text", "work", "#later"]);
  assert.equal(r.json.text, "ready");

  r = await run(["shot", "work", join(c.dir, "s.png"), "--full"]);
  assert.deepEqual({ ...r.json, tab: undefined }, { ok: true, command: "shot", tab: undefined, path: join(c.dir, "s.png"), fullPage: true });
  assert.deepEqual([...readFileSync(join(c.dir, "s.png")).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);

  r = await run(["fetch", "work", fx.base + "/small.txt", join(c.dir, "small.txt")]);
  assert.deepEqual({ ...r.json, tab: undefined }, { ok: true, command: "fetch", tab: undefined, url: fx.base + "/small.txt", path: join(c.dir, "small.txt"), bytes: 11, contentType: "text/plain" });
  r = await run(["download", "work", fx.base + "/file.bin", join(c.dir, "file.bin")]);
  assert.deepEqual({ ...r.json, tab: undefined }, { ok: true, command: "download", tab: undefined, url: fx.base + "/file.bin", path: join(c.dir, "file.bin"), bytes: BIN.length, status: 200 });
  r = await run(["download", "work", "file:///etc/passwd", join(c.dir, "passwd")]);
  assert.equal(r.json.error.code, "usage");
  assert.equal(existsSync(join(c.dir, "passwd")), false);
  for (const cmd of ["fetch", "download"]) {
    r = await run([cmd, "work", "https://export.example.net/all?token=1", join(c.dir, "export")]);
    assert.equal(r.json.error.code, "not_allowed", `${cmd} of an off-list URL`);
    assert.equal(existsSync(join(c.dir, "export")), false);
  }

  r = await run(["window"]);
  assert.deepEqual(r.json, { ok: true, command: "window", window: null, tabs: [] });
  r = await run(["window", "pin", "work"]);
  assert.equal(typeof r.json.window, "number");
  assert.deepEqual(r.json.tabs.map((t: any) => t.id), [id]);
  r = await run(["window", "unpin"]);
  assert.equal(r.json.window, null);

  r = await run(["goto", "work", fx.base + "/next"]);
  assert.equal(r.json.tab.url, fx.base + "/next");
  assert.equal(r.json.tab.title, "next");
  // An off-list goto: behind agent mode's endpoint the relay refuses it (C11), so it is a test of the relay (and the
  // human output test below checks the command's own check after a navigation that the fake makes).
  r = await run(["shot", "work"]);
  assert.equal(r.json.error.code, "read_first", "a navigation needs a new read before a screenshot");

  r = await run(["status"]);
  assert.equal(r.json.connected, true);
  assert.equal(r.json.target, `agent mode's endpoint ${fake.cdpUrl}`);
  assert.equal(r.json.product, "FakeChrome/1.0");
  assert.equal(r.json.allowedTabs, 1);
  assert.ok(r.json.otherTabs >= 1, "the mail tab is counted, never shown");
  assert.deepEqual(r.json.allowlist, ["127.0.0.1"]);
  assert.deepEqual(Object.keys(r.json).sort(), ["allowedTabs", "allowlist", "command", "connected", "detail", "ok", "otherTabs", "product", "target", "window"]);

  r = await run(["close", "work"]);
  assertTab(r.json.tab);
  r = await run(["tabs"]);
  assert.deepEqual(r.json.tabs, []);
  r = await run(["text", "work"]);
  assert.equal(r.json.error.code, "tab_not_found");

  for (const o of outputs) {
    assert.ok(!o.stdout.includes("mail.example.org") && !o.stderr.includes("mail.example.org"), "an off-list tab's URL is never printed");
  }
  assert.deepEqual(fake.callsFor(mail.targetId), [], "and it is never attached, read or touched");
  assert.equal(readFileSync(c.allowlist, "utf8"), allowBefore.text, "the allowlist file is never written");
  assert.equal(statSync(c.allowlist).mtimeMs, allowBefore.mtime);
});

test("net records a tab's traffic as one JSON document, redacted", async () => {
  const opened = await run(["open", fx.base + "/", "--name", "netted"]);
  const page = fake.pages.get(opened.json.tab.targetId)!;
  try {
    const enables = callCount(page.targetId, "Network.enable");
    const pending = run(["net", "netted", "--seconds", "1", "--match", "/api/"]);
    // The recording starts at its Network.enable (its listeners come before it): the traffic goes after that call.
    await untilCall(page.targetId, "Network.enable", enables);
    fake.traffic(page, { method: "POST", url: `${fx.base}/api/gen?key=K3Y`, postData: '{"prompt":"a cat","api_key":"abc123"}', body: '{"token":"zzz","clips":[]}' });
    fake.traffic(page, { url: `${fx.base}/other`, body: "not matched" });
    const r = await pending;
    assert.equal(r.json.seconds, 1);
    assert.deepEqual(r.json.entries, [{
      kind: "http", method: "POST", url: `${fx.base}/api/gen?key=<redacted>`, body: '{"prompt":"a cat","api_key":"<redacted>"}', status: 200,
      mime: "application/json", resp: '{"token":"<redacted>","clips":[]}',
    }]);
  } finally {
    // Also when an assertion fails: a tab left open would change the next tests' tab lists (board ab-b84.29).
    await run(["close", "netted"]);
  }
});

test("a redirect off the allowlist is refused by host, and its URL is never printed", async () => {
  await run(["open", fx.base + "/", "--name", "redir"]);
  const r = await run(["goto", "redir", fx.base + "/redirect"]);
  assert.equal(r.json.error.code, "not_allowed");
  assert.equal(r.json.error.message, "refusing: 127.0.0.1 redirected the tab to login.elsewhere.invalid, which is not on the allowlist; login.elsewhere.invalid is a sign-in page, "
    + "so the agent browser is not signed in to 127.0.0.1: ask the operator to sign in to 127.0.0.1 in their own Chrome and send that site's sign-in to the agent browser with the operator extension (agentwatch — operator mode). The tab stays open there; agent-browser does not touch it");
  assert.ok(!r.stdout.includes("SECRET-CODE") && !r.stderr.includes("SECRET-CODE"));
  const tabs = await run(["tabs"]);
  assert.ok(!tabs.json.tabs.some((t: any) => t.name === "redir"), "the tab is off the list now");
  const id = [...fake.pages.values()].find((p) => p.url.includes("elsewhere"))!.targetId;
  fake.pages.delete(id);
});

test("net stops recording when the tab navigates off the allowlist", async () => {
  const opened = await run(["open", fx.base + "/", "--name", "wander"]);
  const page = fake.pages.get(opened.json.tab.targetId)!;
  try {
    const enables = callCount(page.targetId, "Network.enable");
    const bodies = callCount(page.targetId, "Network.getResponseBody");
    const pending = run(["net", "wander", "--seconds", "1.5"]);
    // The recording starts at its Network.enable (its listeners come before it): the traffic goes after that call.
    await untilCall(page.targetId, "Network.enable", enables);
    fake.traffic(page, { url: `${fx.base}/api/before`, body: "{}" });
    // Its body is read before the navigation; an entry still in flight then is dropped. The fake answers the read at once;
    // the short wait after it gives the CLI's process the answer in a read of its own, before the navigation's events.
    await untilCall(page.targetId, "Network.getResponseBody", bodies);
    await new Promise((r) => setTimeout(r, 250));
    fake.navigate(page, "https://login.elsewhere.invalid/inbox");
    fake.traffic(page, { url: "https://login.elsewhere.invalid/api/mail", body: '{"subject":"private"}' });
    const r = await pending;
    assert.deepEqual(r.json.entries.map((e: any) => e.url), [`${fx.base}/api/before`]);
    assert.ok(!r.stdout.includes("private"));
  } finally {
    // Off the list now, so no command can close it; also when an assertion fails (board ab-b84.29).
    fake.pages.delete(page.targetId);
  }
  const tooLong = await run(["net", "any", "--seconds", "3601"]);
  assert.equal(tooLong.json.error.code, "usage");
});

test("type: inserted text first, key events when the field ignores it (the Sheets cell editor), an error when nothing arrives", async () => {
  const opened = await run(["open", fx.base + "/editor", "--name", "editor"]);
  const page = fake.pages.get(opened.json.tab.targetId)!;
  let r = await run(["type", "editor", "--stdin", "--into", "#notes"], { input: "plain" });
  assert.equal(r.json.ok, true, r.stdout);
  assert.equal(page.select("#notes")[0].text, "plain");
  assert.equal(page.keyEvents.filter((k) => k.type === "keyDown").map((k) => k.text).join(""), "plain",
    "an editable element gets key events at once: inserted text can reach its DOM and not the app (#6)");
  r = await run(["type", "editor", "--stdin", "--into", "#cell"], { input: "=SUM(1,2)" });
  assert.equal(r.json.ok, true, r.stdout);
  assert.equal(page.select("#cell")[0].text, "=SUM(1,2)", "the cell editor got the text as key events");
  assert.deepEqual(page.keyEvents.filter((k) => k.type === "keyDown").map((k) => k.text).join(""), "plain=SUM(1,2)");
  // A row of cells: Tab and Enter move on (the editor is empty again), so only "a" is checked.
  r = await run(["type", "editor", "--stdin", "--into", "#cell"], { input: "a\tb\tc\n" });
  assert.equal(r.json.ok, true, r.stdout);
  assert.deepEqual(page.cells.slice(-3), ["=SUM(1,2)a", "b", "c"], "Tab and Enter committed three cells");
  r = await run(["type", "editor", "--stdin", "--into", "#label"], { input: "lost" });
  assert.equal(r.json.error.code, "error");
  assert.match(r.json.error.message, /^type: no text field has the focus/);
  page.select("#cell")[0].setAttribute("data-ignores-keys", "");
  page.typeInto = () => {}; // a field that takes nothing at all
  r = await run(["type", "editor", "--stdin", "--into", "#cell"], { input: "secret-text" });
  assert.equal(r.json.error.code, "error");
  assert.equal(r.json.error.message, "type: the text did not arrive: the focused field is unchanged after key events");
  assert.ok(!r.stdout.includes("secret-text") && !r.stderr.includes("secret-text"), "the text is never echoed");
  await run(["close", "editor"]);
});

test("board ab-t30.22: type --stdin marks its text as a secret for the input stage (C11, the paste: AgentBrowser.setSecretInput, enabled true before its first input call and false after its last); a Chrome that does not know the method answers an error, and the text goes as before; a type with the text in argv sends no mark", async () => {
  const opened = await run(["open", fx.base + "/editor", "--name", "marks"]);
  const t = opened.json.tab.targetId, page = fake.pages.get(t)!;
  const seen = (from: number) => fake.callsFor(t).slice(from).filter((x) => x.method === "AgentBrowser.setSecretInput" || x.method.startsWith("Input.")).map((x) => x.method === "AgentBrowser.setSecretInput" ? `mark ${x.params.enabled}` : "input");
  let from = fake.callsFor(t).length;
  let r = await run(["type", "marks", "--stdin", "--into", "#notes"], { input: "test-secret" });
  assert.equal(r.json.ok, true, r.stdout);
  assert.equal(page.select("#notes")[0].text, "test-secret");
  const marks = seen(from);
  assert.deepEqual([marks[0], marks[marks.length - 1], marks.filter((m) => m.startsWith("mark")).length], ["mark true", "mark false", 2], marks.join(", "));
  from = fake.callsFor(t).length;
  r = await run(["type", "marks", "plain", "--into", "#notes"]);
  assert.equal(r.json.ok, true, r.stdout);
  assert.ok(seen(from).length > 0 && seen(from).every((m) => m === "input"), "no mark");
  await run(["close", "marks"]);
});

test("review-129 bar 4: type --stdin fails closed on the mark: an error answer that says the method is not known or not available lets the text go as before; any other error answer stops the text (no input call, a clear error); an error of the type itself still ends the mark (false in the finally)", async () => {
  const opened = await run(["open", fx.base + "/editor", "--name", "marks2"]);
  const t = opened.json.tab.targetId, page = fake.pages.get(t)!;
  const seen = (from: number) => fake.callsFor(t).slice(from).filter((x) => x.method === "AgentBrowser.setSecretInput" || x.method.startsWith("Input.")).map((x) => x.method === "AgentBrowser.setSecretInput" ? `mark ${x.params.enabled}` : "input");
  // An endpoint that predates the mark: its refusal of the method.
  fake.failOnce.set("AgentBrowser.setSecretInput", "Not available in the agent browser: AgentBrowser.setSecretInput.");
  let r = await run(["type", "marks2", "--stdin", "--into", "#notes"], { input: "test-secret-a" });
  assert.equal(r.json.ok, true, r.stdout);
  assert.equal(page.select("#notes")[0].text, "test-secret-a");
  // Any other error answer (the stage stopped the mark's step): no input call, and the command fails.
  let from = fake.callsFor(t).length;
  fake.failOnce.set("AgentBrowser.setSecretInput", "the input stage stopped the plan at an error of an event");
  r = await run(["type", "marks2", "--stdin", "--into", "#notes"], { input: "test-secret-b" });
  assert.equal(r.json.ok, false, r.stdout);
  assert.equal(r.json.error.message, "type: the agent browser did not take the mark of a secret, so no text was sent (AgentBrowser.setSecretInput: the input stage stopped the plan at an error of an event)");
  assert.deepEqual(seen(from), ["mark true"], "no input call");
  assert.ok(!r.stdout.includes("test-secret-b") && !r.stderr.includes("test-secret-b"), "the text is never echoed");
  // An error of the type itself (no text field has the focus): the mark still ends.
  from = fake.callsFor(t).length;
  r = await run(["type", "marks2", "--stdin", "--into", "#label"], { input: "test-secret-c" });
  assert.match(r.json.error.message, /^type: no text field has the focus/);
  // On Linux behind agent mode's endpoint the page has a window of its own, so the text goes as a person's keys, and
  // the field check comes after them: the mark is still the first call and its end the last.
  const calls = seen(from);
  assert.deepEqual([calls[0], calls.at(-1), calls.filter((x) => x.startsWith("mark")).length], ["mark true", "mark false", 2]);
  await run(["close", "marks2"]);
});

test("review-129b N1: type --stdin stops its text, before any input call, on a closed connection and on no answer of the mark in its time limit (60 s), with the clear error", async () => {
  const MARK = "AgentBrowser.setSecretInput";
  for (const err of [new CDPError(MARK, "connection closed"), new CDPError(MARK, "no response after 60000 ms")]) {
    const calls: string[] = [];
    const tab = Object.assign(Object.create(Tab.prototype), { drive: "focus-emulation",
      send: async (m: string, p: any, ms?: number) => { calls.push(`${m}${m === MARK ? ` ${p.enabled}${ms === undefined ? "" : ` ${ms}`}` : ""}`); if (m === MARK && p.enabled) throw err; return {}; },
      assertAllowed: async () => { calls.push("assertAllowed"); }, whileDrawn: async () => { calls.push("whileDrawn"); }, typeNow: async () => { calls.push("typeNow"); } });
    await assert.rejects(tab.type("test-secret-d", undefined, true), (e: Error) => e.message === `type: the agent browser did not take the mark of a secret, so no text was sent (${err.message})`, err.message);
    assert.deepEqual(calls, [`${MARK} true`], `${err.message}: no input call, no other call`);
  }
});

test("human output without --json", async () => {
  await run(["open", fx.base + "/", "--name", "plain"]);
  const r = await cli(["tabs", ...flags(c, fake.cdpUrl)]);
  assert.equal(r.status, 0);
  // id, then the name padded to 10 and the title padded to 50, two spaces apart, then the URL
  assert.match(r.stdout, /^[0-9A-F]{8} {2}plain {7}t {51}http:\/\/127\.0\.0\.1:\d+\/\n$/);
  const bad = await cli(["goto", "plain", "https://example.com/", ...flags(c, fake.cdpUrl)]);
  assert.equal(bad.status, 1);
  assert.equal(bad.stdout, "");
  assert.match(bad.stderr, /^agent-browser: refusing: example\.com is not on the allowlist\n$/);
  await run(["close", "plain"]);
});

test("status: connected over agent mode's endpoint; an endpoint that does not answer gives connected false and its error as the detail", async () => {
  let r = await run(["status"]);
  assert.deepEqual({ ...r.json, otherTabs: undefined }, { ok: true, command: "status", connected: true, target: `agent mode's endpoint ${fake.cdpUrl}`,
    detail: null, product: "FakeChrome/1.0", allowedTabs: r.json.allowedTabs, otherTabs: undefined, allowlist: ["127.0.0.1"], window: null });
  r = await cli(["status", "--state-dir", c.stateDir, "--allowlist", c.allowlist, "--cdp-url", NO_ENDPOINT, "--json"]);
  assert.equal(r.status, 0);
  assert.equal(r.json.connected, false);
  assert.match(r.json.detail, /^agent mode's endpoint did not answer \(/);
  assert.deepEqual([r.json.product, r.json.allowedTabs, r.json.otherTabs, r.json.window], [null, null, null, null]);
  const plain = await cli(["status", "--state-dir", c.stateDir, "--allowlist", c.allowlist, "--cdp-url", fake.cdpUrl]);
  const lines = plain.stdout.split("\n");
  assert.deepEqual([lines[0], lines[1], lines[3], lines[4], lines[5]], [`target: agent mode's endpoint ${fake.cdpUrl}`, "FakeChrome/1.0", "allowlist: 127.0.0.1", "window: not pinned", ""]);
  assert.match(lines[2], /^allowlisted tabs: \d+ {2}\(other tabs, untouched: \d+\)$/);
});
