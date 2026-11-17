// The sign-in hints (ab-b84.19): a redirect or a recording that lands on a sign-in page says how to sign in. Behind agent
// mode's endpoint (the only way since board ab-v16.9.3: `launch --login` and personal mode are gone) the hint names the
// step that works: the operator signs in to the site in their own Chrome and sends that site's sign-in to the agent
// browser with the operator extension.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentBrowser } from "../src/browser.ts";
import { commands } from "../src/commands.ts";
import { ChromeUnreachableError, NotAllowedError, redirectError, signInHint } from "../src/errors.ts";
import { findFfmpeg } from "../src/record.ts";
import type { BrowserOptions } from "../src/options.ts";
import { FakeChrome, type FakePage } from "./fake-chrome.ts";
import { backByChrome, harness, lineOf, until } from "./fake-bridge.ts";
import { consumer, FIXTURE_HOST, fixtureServer, site } from "./helpers.ts";


const operatorHint = (host: string, where: string) => `; ${host} is a sign-in page, so the agent browser is not signed in to ${where}: `
  + `ask the operator to sign in to ${where} in their own Chrome and send that site's sign-in to the agent browser with the operator extension (agentwatch — operator mode)`;

test("signInHint: the operator signs in in their own Chrome and sends the site's sign-in with the operator extension; no launch", () => {
  assert.equal(signInHint("accounts.google.com", "docs.example.com"), operatorHint("accounts.google.com", "docs.example.com"));
  assert.equal(signInHint("login.example.com"), operatorHint("login.example.com", "the site"), "with no site, the hint says \"the site\"");
  for (const hint of [signInHint("accounts.google.com", "docs.example.com"), signInHint("sso.example.com")]) {
    assert.doesNotMatch(hint, /launch|by hand in the agent browser/, hint);
  }
});

test("signInHint: a host that is not a sign-in page has no hint", () => {
  assert.equal(signInHint("elsewhere.example", "docs.example.com"), "");
});

test("redirectError names both hosts and the hint: the operator extension", () => {
  const off = new NotAllowedError("https://accounts.google.com/o/oauth2?code=SECRET");
  const tail = ". The tab stays open there; agent-browser does not touch it";
  const head = "refusing: docs.example.com redirected the tab to accounts.google.com, which is not on the allowlist";
  assert.equal((redirectError(off, "https://docs.example.com/d/1") as Error).message,
    `${head}${operatorHint("accounts.google.com", "docs.example.com")}${tail}`);
  // Any other error, and a refusal of the requested host itself, stay as they are.
  const other = new Error("boom");
  assert.equal(redirectError(other, "https://docs.example.com/"), other);
  const same = new NotAllowedError("https://docs.example.com/");
  assert.equal(redirectError(same, "https://docs.example.com/"), same);
});

test("the unreachable hint: the endpoint's error names no launch", async () => {
  const c = consumer(["example.org"]);
  try {
    const dead = `ws+unix://${join(c.dir, "no.sock")}:/devtools/browser/my-repo`;
    await assert.rejects(AgentBrowser.connect(c.options({ cdpUrl: dead, commandName: "vedlo browser" })), (e: unknown) => {
      assert.ok(e instanceof ChromeUnreachableError);
      assert.match(e.message, /^agent mode's endpoint did not answer/);
      assert.doesNotMatch(e.message, /launch/);
      return true;
    });
  } finally { c.remove(); }
});

test("over agent mode's endpoint, a redirect to a sign-in page names the operator extension, and the tab stays there", async () => {
  const fx = await fixtureServer(FIXTURE_HOST), chrome = await FakeChrome.start(site(fx.base)), h = await harness(), c = consumer([FIXTURE_HOST]);
  const end = await backByChrome(h.fake, chrome);
  try {
    await h.ready(lineOf([FIXTURE_HOST]));
    const o = c.options({ cdpUrl: h.url("my-repo") });
    await commands.open(o, { url: fx.base + "/", name: "redir" });
    await assert.rejects(commands.goto(o, { tab: "redir", url: fx.base + "/redirect" }), (e: unknown) => {
      assert.ok(e instanceof NotAllowedError);
      assert.equal(e.message, `refusing: ${FIXTURE_HOST} redirected the tab to login.elsewhere.invalid, which is not on the allowlist`
        + `${operatorHint("login.elsewhere.invalid", FIXTURE_HOST)}. The tab stays open there; agent-browser does not touch it`);
      assert.ok(!e.message.includes("SECRET-CODE"));
      return true;
    });
    assert.ok([...chrome.pages.values()].some((p) => p.url.includes("login.elsewhere.invalid")), "the tab stays open on the sign-in page");
  } finally { end(); await h.close(); await chrome.close(); await fx.close(); c.remove(); }
});

const hasFfmpeg = (() => { try { return !!findFfmpeg(); } catch { return false; } })();

type Options = BrowserOptions;

/** Record `steps` on a fresh tab of the fixture page; `during` runs once the screencast is on. The record's error, if any. */
async function recordTake(chrome: FakeChrome, o: Options, dir: string, base: string, steps: unknown[], during: (page: FakePage) => void = () => {}): Promise<unknown> {
  const opened = await commands.open(o, { url: base + "/", name: "rec" });
  const page = chrome.pages.get(opened.tab.targetId)!;
  const script = join(dir, "steps.json");
  writeFileSync(script, JSON.stringify(steps));
  const run = commands.record(o, { tab: "rec", out: join(dir, "rec.mp4"), script, settle: 100 }).then(() => undefined, (e: unknown) => e);
  await until(() => chrome.calls.some((x) => x.method === "Page.startScreencast"), "the screencast to start", 10_000);
  during(page);
  return run;
}

/** Record a wait step on the fixture page and send the tab to a sign-in page during the take. */
const recordOntoSignIn = (chrome: FakeChrome, o: Options, dir: string, base: string) =>
  recordTake(chrome, o, dir, base, [{ wait: 20_000 }], (page) => chrome.navigate(page, "https://login.elsewhere.invalid/oauth?code=SECRET-CODE"));

const recordRefusal = (hint: string, host = "login.elsewhere.invalid") => `refusing: the tab navigated to ${host}, which is not on the allowlist${hint}; the recording stopped and nothing was written`;
const needsFfmpeg = { skip: hasFfmpeg ? false : "no ffmpeg on PATH" };

test("over agent mode's endpoint, a recording that lands on a sign-in page names the operator extension and the recorded site", needsFfmpeg, async () => {
  const fx = await fixtureServer(FIXTURE_HOST), chrome = await FakeChrome.start(site(fx.base)), h = await harness(), c = consumer([FIXTURE_HOST]);
  const end = await backByChrome(h.fake, chrome);
  try {
    await h.ready(lineOf([FIXTURE_HOST]));
    const e = await recordOntoSignIn(chrome, c.options({ cdpUrl: h.url("my-repo") }), c.dir, fx.base);
    assert.ok(e instanceof NotAllowedError, String(e));
    assert.equal(e.message, recordRefusal(operatorHint("login.elsewhere.invalid", FIXTURE_HOST)));
  } finally { end(); await h.close(); await chrome.close(); await fx.close(); c.remove(); }
});

// A second allowlisted site (review-50 F1): the hint names the site that the take was on last, not the first one.
const SECOND = "docs.second.invalid";
const secondSite = (base: string) => (url: URL) => url.hostname === SECOND ? { title: "second", text: "the second site" } : site(base)(url);

test("over agent mode's endpoint, a goto step to a second site that redirects to a sign-in page: the hint names the second site", needsFfmpeg, async () => {
  const fx = await fixtureServer(FIXTURE_HOST), chrome = await FakeChrome.start(secondSite(fx.base)), h = await harness(), c = consumer([FIXTURE_HOST, SECOND]);
  const end = await backByChrome(h.fake, chrome);
  // An HTTP redirect: the main frame commits on the sign-in page only, never on the second site first.
  const navigate = chrome.navigate.bind(chrome);
  chrome.navigate = (page, url) => navigate(page, new URL(url).hostname === SECOND ? "https://accounts.second.invalid/signin?code=SECRET-CODE" : url);
  try {
    await h.ready(lineOf([FIXTURE_HOST, SECOND]));
    const e = await recordTake(chrome, c.options({ cdpUrl: h.url("my-repo") }), c.dir, fx.base, [{ goto: `https://${SECOND}/doc` }, { wait: 20_000 }]);
    assert.ok(e instanceof NotAllowedError, String(e));
    assert.equal(e.message, recordRefusal(operatorHint("accounts.second.invalid", SECOND), "accounts.second.invalid"));
  } finally { end(); await h.close(); await chrome.close(); await fx.close(); c.remove(); }
});

test("over agent mode's endpoint, a navigation to a second allowlisted site, then to a sign-in page: the hint names the second site", needsFfmpeg, async () => {
  const fx = await fixtureServer(FIXTURE_HOST), chrome = await FakeChrome.start(secondSite(fx.base)), h = await harness(), c = consumer([FIXTURE_HOST, SECOND]);
  const end = await backByChrome(h.fake, chrome);
  try {
    await h.ready(lineOf([FIXTURE_HOST, SECOND]));
    const e = await recordTake(chrome, c.options({ cdpUrl: h.url("my-repo") }), c.dir, fx.base, [{ wait: 20_000 }], (page) => {
      chrome.navigate(page, `https://${SECOND}/doc`); // a link the page follows: an allowlisted main-frame navigation
      setTimeout(() => chrome.navigate(page, "https://login.elsewhere.invalid/oauth?code=SECRET-CODE"), 300);
    });
    assert.ok(e instanceof NotAllowedError, String(e));
    assert.equal(e.message, recordRefusal(operatorHint("login.elsewhere.invalid", SECOND)));
  } finally { end(); await h.close(); await chrome.close(); await fx.close(); c.remove(); }
});

