// The sign-in hints (ab-b84.19): a redirect or a recording that lands on a sign-in page says how to sign in. Without
// cdpUrl that is `launch --login` (agent mode) or the operator's own window (personal mode). Behind agent mode's
// endpoint (cdpUrl) agent-browser refuses `launch`, so there the hint names the step that works: the operator signs
// in to the site in their own Chrome and sends that site's sign-in to the agent browser with the operator extension.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentBrowser } from "../src/browser.ts";
import { commands } from "../src/commands.ts";
import { ChromeUnreachableError, NotAllowedError, redirectError, signInHint } from "../src/errors.ts";
import { resolveOptions } from "../src/options.ts";
import { stopProxy } from "../src/proxy.ts";
import { findFfmpeg } from "../src/record.ts";
import { FakeChrome } from "./fake-chrome.ts";
import { backByChrome, harness, until } from "./fake-bridge.ts";
import { consumer, fixtureServer, site } from "./helpers.ts";

const CDP_URL = "ws+unix:///run/user/1000/agentwatch/browser-cdp.sock:/devtools/browser/ab-lead";
const AGENT = { mode: "agent", commandName: "vedlo browser" };
const PERSONAL = { mode: "personal", commandName: "vedlo browser" };
const ENDPOINT = { mode: "agent", commandName: "vedlo browser", cdpUrl: CDP_URL };

const operatorHint = (host: string, where: string) => `; ${host} is a sign-in page, so the agent browser is not signed in to ${where}: `
  + `ask the operator to sign in to ${where} in their own Chrome and send that site's sign-in to the agent browser with the operator extension (agentwatch — operator mode)`;

test("signInHint without cdpUrl: agent mode names `launch --login`, personal mode the operator's own window, as before", () => {
  assert.equal(signInHint("accounts.google.com", AGENT, "docs.example.com"),
    "; accounts.google.com is a sign-in page, so this profile is not signed in: run `vedlo browser launch --login` and sign in by hand in the agent browser");
  assert.equal(signInHint("accounts.google.com", AGENT), signInHint("accounts.google.com", AGENT, "docs.example.com"), "the site changes nothing here");
  assert.equal(signInHint("login.example.com", PERSONAL, "docs.example.com"), "; login.example.com is a sign-in page: sign in by hand in that window");
});

test("signInHint with cdpUrl: the operator signs in in their own Chrome and sends the site's sign-in with the operator extension; no launch", () => {
  assert.equal(signInHint("accounts.google.com", ENDPOINT, "docs.example.com"), operatorHint("accounts.google.com", "docs.example.com"));
  assert.equal(signInHint("login.example.com", ENDPOINT), operatorHint("login.example.com", "the site"), "with no site, the hint says \"the site\"");
  for (const hint of [signInHint("accounts.google.com", ENDPOINT, "docs.example.com"), signInHint("sso.example.com", ENDPOINT)]) {
    assert.doesNotMatch(hint, /launch|by hand in the agent browser/, hint);
  }
});

test("signInHint: a host that is not a sign-in page has no hint, with or without cdpUrl", () => {
  for (const s of [AGENT, PERSONAL, ENDPOINT]) assert.equal(signInHint("elsewhere.example", s, "docs.example.com"), "", s.mode);
});

test("redirectError names both hosts and the hint of its settings: launch --login without cdpUrl, the operator extension with it", () => {
  const off = new NotAllowedError("https://accounts.google.com/o/oauth2?code=SECRET");
  const tail = ". The tab stays open there; agent-browser does not touch it";
  const head = "refusing: docs.example.com redirected the tab to accounts.google.com, which is not on the allowlist";
  assert.equal((redirectError(off, "https://docs.example.com/d/1", AGENT) as Error).message,
    `${head}; accounts.google.com is a sign-in page, so this profile is not signed in: run \`vedlo browser launch --login\` and sign in by hand in the agent browser${tail}`);
  assert.equal((redirectError(off, "https://docs.example.com/d/1", PERSONAL) as Error).message,
    `${head}; accounts.google.com is a sign-in page: sign in by hand in that window${tail}`);
  assert.equal((redirectError(off, "https://docs.example.com/d/1", ENDPOINT) as Error).message,
    `${head}${operatorHint("accounts.google.com", "docs.example.com")}${tail}`);
  // Any other error, and a refusal of the requested host itself, stay as they are.
  const other = new Error("boom");
  assert.equal(redirectError(other, "https://docs.example.com/", ENDPOINT), other);
  const same = new NotAllowedError("https://docs.example.com/");
  assert.equal(redirectError(same, "https://docs.example.com/", ENDPOINT), same);
});

test("the unreachable hint: without cdpUrl it names `launch --login`; with cdpUrl the endpoint's error names no launch", async () => {
  const c = consumer(["example.org"]);
  try {
    await assert.rejects(AgentBrowser.connect(c.options({ endpoint: "ws://127.0.0.1:9/devtools/browser/unavailable", commandName: "vedlo browser" })), (e: unknown) => {
      assert.ok(e instanceof ChromeUnreachableError);
      assert.match(e.message, /vedlo browser launch --login/);
      return true;
    });
    const dead = `ws+unix://${join(c.dir, "no.sock")}:/devtools/browser/ab-lead`;
    await assert.rejects(AgentBrowser.connect(c.options({ cdpUrl: dead, commandName: "vedlo browser" })), (e: unknown) => {
      assert.ok(e instanceof ChromeUnreachableError);
      assert.match(e.message, /^agent mode's endpoint did not answer/);
      assert.doesNotMatch(e.message, /launch/);
      return true;
    });
  } finally { c.remove(); }
});

test("over agent mode's endpoint, a redirect to a sign-in page names the operator extension, and the tab stays there", async () => {
  const fx = await fixtureServer(), chrome = await FakeChrome.start(site(fx.base)), h = await harness(), c = consumer();
  const end = await backByChrome(h.fake, chrome);
  try {
    await h.ready();
    const o = c.options({ cdpUrl: h.url("ab-lead") });
    await commands.open(o, { url: fx.base + "/", name: "redir" });
    await assert.rejects(commands.goto(o, { tab: "redir", url: fx.base + "/redirect" }), (e: unknown) => {
      assert.ok(e instanceof NotAllowedError);
      assert.equal(e.message, "refusing: 127.0.0.1 redirected the tab to login.elsewhere.invalid, which is not on the allowlist"
        + `${operatorHint("login.elsewhere.invalid", "127.0.0.1")}. The tab stays open there; agent-browser does not touch it`);
      assert.ok(!e.message.includes("SECRET-CODE"));
      return true;
    });
    assert.ok([...chrome.pages.values()].some((p) => p.url.includes("login.elsewhere.invalid")), "the tab stays open on the sign-in page");
  } finally { end(); await h.close(); await chrome.close(); await fx.close(); c.remove(); }
});

const hasFfmpeg = (() => { try { return !!findFfmpeg(); } catch { return false; } })();

/** Record a wait step on the fixture page, send the tab to a sign-in page during the take, and return the record's error. */
async function recordOntoSignIn(chrome: FakeChrome, o: ReturnType<ReturnType<typeof consumer>["options"]>, dir: string, base: string): Promise<unknown> {
  const opened = await commands.open(o, { url: base + "/", name: "rec" });
  const page = chrome.pages.get(opened.tab.targetId)!;
  const script = join(dir, "steps.json");
  writeFileSync(script, JSON.stringify([{ wait: 20_000 }]));
  const run = commands.record(o, { tab: "rec", out: join(dir, "rec.mp4"), script, settle: 100 }).then(() => undefined, (e: unknown) => e);
  await until(() => chrome.calls.some((x) => x.method === "Page.startScreencast"), "the screencast to start", 10_000);
  chrome.navigate(page, "https://login.elsewhere.invalid/oauth?code=SECRET-CODE");
  return run;
}

const recordRefusal = (hint: string) => `refusing: the tab navigated to login.elsewhere.invalid, which is not on the allowlist${hint}; the recording stopped and nothing was written`;
const needsFfmpeg = { skip: hasFfmpeg ? false : "no ffmpeg on PATH" };

test("a recording that lands on a sign-in page, without cdpUrl: the hint names `launch --login`, as before", needsFfmpeg, async () => {
  const fx = await fixtureServer(), chrome = await FakeChrome.start(site(fx.base)), c = consumer();
  const o = c.options({ endpoint: chrome.ws, commandName: "vedlo browser" });
  try {
    const e = await recordOntoSignIn(chrome, o, c.dir, fx.base);
    assert.ok(e instanceof NotAllowedError, String(e));
    assert.equal(e.message, recordRefusal("; login.elsewhere.invalid is a sign-in page, so this profile is not signed in: "
      + "run `vedlo browser launch --login` and sign in by hand in the agent browser"));
  } finally { stopProxy(resolveOptions(o)); await chrome.close(); await fx.close(); c.remove(); }
});

test("over agent mode's endpoint, a recording that lands on a sign-in page names the operator extension and the recorded site", needsFfmpeg, async () => {
  const fx = await fixtureServer(), chrome = await FakeChrome.start(site(fx.base)), h = await harness(), c = consumer();
  const end = await backByChrome(h.fake, chrome);
  try {
    await h.ready();
    const e = await recordOntoSignIn(chrome, c.options({ cdpUrl: h.url("ab-lead") }), c.dir, fx.base);
    assert.ok(e instanceof NotAllowedError, String(e));
    assert.equal(e.message, recordRefusal(operatorHint("login.elsewhere.invalid", "127.0.0.1")));
  } finally { end(); await h.close(); await chrome.close(); await fx.close(); c.remove(); }
});
