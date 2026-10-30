// The CLI's JSON contract: the real bin/agent-browser.js in child processes, against the fake
// Chrome. Each call prints exactly one JSON document; failures carry a stable error code.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { COMMAND_SPECS, commands } from "../src/commands.ts";
import { redact } from "../src/outline.ts";
import { resolveOptions } from "../src/options.ts";
import { optionsFromFlags } from "../src/cli.ts";
import { stopProxy } from "../src/proxy.ts";
import { FakeChrome, type FakePage } from "./fake-chrome.ts";
import { BIN, cli, consumer, fixtureServer, flags, site, type CliRun, type Consumer, type Fixture } from "./helpers.ts";

let fx: Fixture, fake: FakeChrome, c: Consumer, mail: FakePage;

test("--chrome-args parses a JSON array into chromeArgs; a non-array or bad JSON is a usage error", () => {
  const opts = optionsFromFlags({ "state-dir": "/tmp/ab-chrome-args", "chrome-args": '["--enable-unsafe-swiftshader","--lang=en-US"]' }, () => {});
  assert.deepEqual(opts.chromeArgs, ["--enable-unsafe-swiftshader", "--lang=en-US"]);
  assert.equal(optionsFromFlags({ "state-dir": "/tmp/ab-chrome-args" }, () => {}).chromeArgs, undefined);
  assert.throws(() => optionsFromFlags({ "state-dir": "/tmp/ab-chrome-args", "chrome-args": "not json" }, () => {}), /--chrome-args must be a JSON array/);
  assert.throws(() => optionsFromFlags({ "state-dir": "/tmp/ab-chrome-args", "chrome-args": '{"a":1}' }, () => {}), /--chrome-args must be a JSON array/);
});
const outputs: CliRun[] = [];

before(async () => {
  fx = await fixtureServer();
  fake = await FakeChrome.start(site(fx.base));
  c = consumer();
  mail = fake.addPage("https://mail.example.org/inbox?thread=secret-subject");
});

after(async () => {
  stopProxy(resolveOptions(c.options()));
  await fake?.close();
  await fx?.close();
  c?.remove();
});

/** Run a command for the test consumer with --json, and check the one-document contract. */
async function run(args: string[], opts: { input?: string; consumer?: Consumer; extra?: string[] } = {}): Promise<CliRun> {
  const r = await cli([...args, ...flags(opts.consumer ?? c, fake.ws, opts.extra), "--json"], { input: opts.input });
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
    [["tabs", "--json"], /--state-dir is required/],
    [["nonsense", "--json"], /unknown command/],
    [["tabs", "--notify", "--state-dir", c.stateDir, "--json"], /--notify is not an option of tabs/],
    [["open", "--state-dir", c.stateDir, "--json"], /usage: agent-browser open <url>/],
    [["click", "x", "--bogus", "--json"], /Unknown option '--bogus'/],
    [["tabs", "--state-dir", "rel/../x", "--mode", "shared", "--json"], /mode must be/],
    [["status", "--state-dir", c.stateDir, "--notify-command", "agentwatch inbox", "--json"], /JSON array/],
  ];
  for (const [args, message] of cases) {
    const r = await cli(args);
    assert.equal(r.status, 2, args.join(" "));
    assert.equal(r.json.ok, false);
    assert.equal(r.json.error.code, "usage");
    assert.match(r.json.error.message, message);
  }
  const help = await cli(["--help", "--json"]);
  assert.equal(help.json.command, "help");
  assert.match(help.json.usage, /--remote-debugging-port/);
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
  r = await run(["goto", "work", "https://example.com/"]);
  assert.equal(r.json.error.code, "not_allowed");
  assert.match(r.json.error.message, /example\.com is not on the allowlist/);
  r = await run(["shot", "work"]);
  assert.equal(r.json.error.code, "read_first", "a navigation needs a new read before a screenshot");

  r = await run(["status"]);
  assert.equal(r.json.connected, true);
  assert.equal(r.json.mode, "agent");
  assert.equal(r.json.product, "FakeChrome/1.0");
  assert.equal(r.json.proxy.upstream, fake.ws);
  assert.equal(r.json.allowedTabs, 1);
  assert.ok(r.json.otherTabs >= 1, "the mail tab is counted, never shown");
  assert.deepEqual(r.json.allowlist, ["127.0.0.1"]);
  assert.deepEqual(Object.keys(r.json).sort(), ["allowedTabs", "allowlist", "command", "connected", "detail", "mode", "notification", "ok", "otherTabs", "product", "profileDir", "proxy", "target", "window"]);

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
  const pending = run(["net", "netted", "--seconds", "1", "--match", "/api/"]);
  await new Promise((r) => setTimeout(r, 600));
  fake.traffic(page, { method: "POST", url: `${fx.base}/api/gen?key=K3Y`, postData: '{"prompt":"a cat","api_key":"abc123"}', body: '{"token":"zzz","clips":[]}' });
  fake.traffic(page, { url: `${fx.base}/other`, body: "not matched" });
  const r = await pending;
  assert.equal(r.json.seconds, 1);
  assert.deepEqual(r.json.entries, [{
    kind: "http", method: "POST", url: `${fx.base}/api/gen?key=<redacted>`, body: '{"prompt":"a cat","api_key":"<redacted>"}', status: 200,
    mime: "application/json", resp: '{"token":"<redacted>","clips":[]}',
  }]);
  await run(["close", "netted"]);
});

test("a redirect off the allowlist is refused by host, and its URL is never printed", async () => {
  await run(["open", fx.base + "/", "--name", "redir"]);
  const r = await run(["goto", "redir", fx.base + "/redirect"]);
  assert.equal(r.json.error.code, "not_allowed");
  assert.equal(r.json.error.message, "refusing: 127.0.0.1 redirected the tab to login.elsewhere.invalid, which is not on the allowlist; login.elsewhere.invalid is a sign-in page, "
    + "so this profile is not signed in: run `agent-browser launch --login` and sign in by hand in the agent browser. The tab stays open there; agent-browser does not touch it");
  assert.ok(!r.stdout.includes("SECRET-CODE") && !r.stderr.includes("SECRET-CODE"));
  const tabs = await run(["tabs"]);
  assert.ok(!tabs.json.tabs.some((t: any) => t.name === "redir"), "the tab is off the list now");
  const id = [...fake.pages.values()].find((p) => p.url.includes("elsewhere"))!.targetId;
  fake.pages.delete(id);
});

test("net stops recording when the tab navigates off the allowlist", async () => {
  const opened = await run(["open", fx.base + "/", "--name", "wander"]);
  const page = fake.pages.get(opened.json.tab.targetId)!;
  const pending = run(["net", "wander", "--seconds", "1.5"]);
  await new Promise((r) => setTimeout(r, 600));
  fake.traffic(page, { url: `${fx.base}/api/before`, body: "{}" });
  await new Promise((r) => setTimeout(r, 200)); // its body is read before the navigation; an entry still in flight then is dropped
  fake.navigate(page, "https://login.elsewhere.invalid/inbox");
  fake.traffic(page, { url: "https://login.elsewhere.invalid/api/mail", body: '{"subject":"private"}' });
  const r = await pending;
  assert.deepEqual(r.json.entries.map((e: any) => e.url), [`${fx.base}/api/before`]);
  assert.ok(!r.stdout.includes("private"));
  fake.pages.delete(page.targetId); // off the list now, so no command can close it
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

test("human output without --json", async () => {
  await run(["open", fx.base + "/", "--name", "plain"]);
  const r = await cli(["tabs", ...flags(c, fake.ws)]);
  assert.equal(r.status, 0);
  // id, then the name padded to 10 and the title padded to 50, two spaces apart, then the URL
  assert.match(r.stdout, /^[0-9A-F]{8} {2}plain {7}t {51}http:\/\/127\.0\.0\.1:\d+\/\n$/);
  const bad = await cli(["goto", "plain", "https://example.com/", ...flags(c, fake.ws)]);
  assert.equal(bad.status, 1);
  assert.equal(bad.stdout, "");
  assert.match(bad.stderr, /^agent-browser: refusing: example\.com is not on the allowlist\n$/);
  await run(["close", "plain"]);
});

test("launch with a known endpoint starts nothing; --login opens each allowlisted site", async () => {
  const r = await run(["launch", "--login"]);
  assert.deepEqual({ ...r.json, profileDir: undefined }, {
    ok: true, command: "launch", started: false, endpoint: fake.ws, profileDir: undefined, login: true, opened: ["https://127.0.0.1/"], errors: [],
  });
  const tabs = await run(["tabs"]);
  for (const t of tabs.json.tabs) await run(["close", t.id]);
});

test("stop, status without a proxy, status --notify, and quit", async () => {
  let r = await run(["stop"]);
  assert.deepEqual(r.json, { ok: true, command: "stop", stopped: true });
  r = await run(["stop"]);
  assert.deepEqual(r.json, { ok: true, command: "stop", stopped: false });

  // Unattended: no approved connection, so --no-prompt fails at once, names the last end, and starts nothing.
  r = await run(["tabs"], { extra: ["--no-prompt"] });
  assert.equal(r.json.error.code, "approval_needed");
  assert.match(r.json.error.message, /^no approved connection to .*; the last approved connection ended at \S+ \(SIGTERM\)\. noPrompt \(--no-prompt\) opens no new one/);

  r = await run(["status"]);
  assert.equal(r.json.connected, false);
  assert.match(r.json.detail, /proxy not connected; approval status unknown/);
  assert.equal(r.json.product, null);
  assert.equal(r.json.notification, null);

  const notified = join(c.dir, "notified.txt");
  const command = JSON.stringify([process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1], process.argv[2])", notified, "{message}"]);
  r = await run(["status", "--notify"], { extra: ["--notify-command", command, "--command-name", "agentwatch browser"] });
  assert.deepEqual(r.json.notification, { delivery: "queued", detail: "notification queued" });
  assert.match(readFileSync(notified, "utf8"), /^agentwatch browser connection needs attention: .*approval status unknown/);

  r = await run(["quit"]);
  assert.deepEqual(r.json, { ok: true, command: "quit", proxyStopped: false, chromePid: null, closed: false }, "no Chrome runs on this consumer's profile");
  r = await run(["quit"], { extra: ["--mode", "personal"] });
  assert.equal(r.json.error.code, "usage");
  assert.match(r.json.error.message, /never closes the operator's Chrome/);
  r = await run(["launch"], { extra: ["--mode", "personal"] });
  assert.equal(r.json.error.code, "usage");
});

test("personal mode through the CLI: nothing acts before its own window is pinned; connect remembers the endpoint", async () => {
  const p = consumer();
  try {
    const extra = ["--mode", "personal"];
    let r = await run(["connect", fake.ws], { consumer: p, extra });
    assert.deepEqual(r.json, { ok: true, command: "connect", endpoint: fake.ws, product: "FakeChrome/1.0" });
    assert.deepEqual(JSON.parse(readFileSync(join(p.stateDir, "chrome.json"), "utf8")), { ws: fake.ws });
    const operator = fake.addPage(fx.base + "/?operator");
    r = await run(["text", "operator"], { consumer: p, extra });
    assert.equal(r.json.error.code, "pin_required");
    r = await run(["open", fx.base + "/", "--tab"], { consumer: p, extra });
    assert.equal(r.json.error.code, "pin_required");
    r = await run(["open", fx.base + "/", "--name", "mine"], { consumer: p, extra });
    assert.equal(typeof r.json.window, "number");
    r = await run(["tabs"], { consumer: p, extra });
    assert.deepEqual(r.json.tabs.map((t: any) => t.name), ["mine"], "only its own window's tabs");
    r = await run(["text", "operator"], { consumer: p, extra });
    assert.equal(r.json.error.code, "tab_not_found");
    await run(["close", "mine"], { consumer: p, extra });
    fake.pages.delete(operator.targetId);
  } finally {
    stopProxy(resolveOptions(p.options()));
    p.remove();
  }
});
