// The host of a redirect refusal (board ab-nfn): when the extension that guards the agent browser sends a tab whose
// navigation went off its list to about:blank, the tab's URL names no host, and the refusal used to say "(no host)".
// It names the host of the blocked navigation now, the host of the operator's prompt; with none known it says so in
// plain words. No browser starts: the real relay and CLI code run on the fake carrier and Chrome, with made-up hosts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentBrowser } from "../src/browser.ts";
import { commands } from "../src/commands.ts";
import { NotAllowedError, UNREAD_HOST, redirectError } from "../src/errors.ts";
import { backByChrome, harness, lineOf } from "./fake-bridge.ts";
import { FakeChrome, type FakePage, type PageSpec } from "./fake-chrome.ts";
import { consumer } from "./helpers.ts";

const SITE = "files.example";
const BLOCKED = "downloads.example";
const SUBFRAME = "ads.example";
/** Where the tab stays: on the named host ("there"), on the guard's blank page, or on a page with no host it could read. */
const BLANK = "on a blank page", NO_HOST_PAGE = "on a page whose host the agent browser could not read";
const refusal = (to: string, where = BLANK) => `refusing: ${SITE} redirected the tab to ${to}, which is not on the allowlist. The tab stays open ${where}; agent-browser does not touch it`;
const UNVERIFIED = "refusing: about:blank has an unverified document origin; navigate to an allowlisted URL first";

test("redirectError: a refusal whose tab URL names no host takes the blocked navigation's host", () => {
  const blank = new NotAllowedError("about:blank", UNVERIFIED);
  const e = redirectError(blank, `https://${SITE}/get`, BLOCKED);
  assert.ok(e instanceof NotAllowedError);
  assert.equal(e.message, refusal(BLOCKED));
  assert.equal(e.host, BLOCKED);
  // The sign-in hint stays: a blocked sign-in page says how to sign in to the requested site.
  assert.match((redirectError(blank, `https://${SITE}/`, "login.example") as Error).message,
    new RegExp(`^refusing: ${SITE} redirected the tab to login\\.example, which is not on the allowlist; login\\.example is a sign-in page, so the agent browser is not signed in to ${SITE}: `));
  // A refusal that names a host keeps it: the tab is there.
  assert.equal((redirectError(new NotAllowedError("https://other.example/x?code=SECRET"), `https://${SITE}/`, BLOCKED) as Error).message, refusal("other.example", "there"));
  // A page with no host that is not blank: the blocked host, and no claim of a blank page.
  assert.equal((redirectError(new NotAllowedError("data:text/html,x"), `https://${SITE}/get`, BLOCKED) as Error).message, refusal(BLOCKED, NO_HOST_PAGE));
});

test("redirectError: with no known host the refusal says so in plain words, never \"(no host)\" or \"(invalid url)\"", () => {
  for (const [url, where] of [["about:blank", BLANK], ["data:text/html,x", NO_HOST_PAGE], ["", NO_HOST_PAGE]]) {
    const e = redirectError(new NotAllowedError(url), `https://${SITE}/get`);
    assert.ok(e instanceof NotAllowedError);
    assert.equal(e.message, refusal(UNREAD_HOST, where), url);
    assert.equal(e.host, UNREAD_HOST);
    assert.doesNotMatch(e.message, /\(no host\)|\(invalid url\)/);
  }
  assert.equal(UNREAD_HOST, "a host that the agent browser could not read");
});

test("a refusal of a URL with no host names no placeholder", () => {
  for (const url of ["data:text/html,x", "", "not a url"])
    assert.equal(new NotAllowedError(url).message, `refusing: ${UNREAD_HOST} is not on the allowlist`, url);
});

/** The extension's guard (chrome-extension agent/guard.js, #act): it sends the tab to about:blank, a browser-started navigation. */
function guardBlanks(p: FakePage): void {
  p.fake.navigate(p, "about:blank");
  p.securityOrigin = "://"; // measured on the Linux server (Chromium 156): a browser-started about:blank has the origin "://"
}

/** A script's location change: Chrome asks for it and starts it (both measured), and the guard stops it before any commit. */
function scriptGoesTo(p: FakePage, url: string): void {
  p.fake.requestNavigation(p, url);
  p.fake.startNavigation(p, url);
  guardBlanks(p);
}

const PAGES: Record<string, PageSpec> = {
  "/": { title: "files" },
  // A redirect to another page off the list.
  "/away": { title: "away", onload: (p) => p.later(0, () => scriptGoesTo(p, `https://${BLOCKED}/page?code=SECRET-CODE`)) },
  // A redirect to a download off the list: no page of it ever commits, and the guard stops it at its start.
  "/get": { title: "get", onload: (p) => p.later(0, () => scriptGoesTo(p, `https://${BLOCKED}/setup.bin?token=SECRET-CODE`)) },
  // A redirect that commits off the list first (a site's service worker answers it before the extension's rules see it,
  // layer 3 of the guard), then the guard.
  "/worker": { title: "worker", onload: (p) => p.later(0, () => { p.fake.navigate(p, `https://${BLOCKED}/page?code=SECRET-CODE`); guardBlanks(p); }) },
  // The error page of a blocked navigation (its failed URL in unreachableUrl; its own URL names chromewebdata), then the guard.
  "/error": { title: "error", onload: (p) => p.later(0, () => { p.fake.errorPageCommitted(p, `https://${BLOCKED}/page?code=SECRET-CODE`); guardBlanks(p); }) },
  // The tab goes to about:blank with no navigation off the list that agent-browser saw.
  "/blank": { title: "blank", onload: (p) => p.later(0, () => guardBlanks(p)) },
  // The main frame goes off the list, then a subframe goes to another host off the list, then the guard.
  "/frame-after": { title: "frame after", onload: (p) => p.later(0, () => {
    p.fake.requestNavigation(p, `https://${BLOCKED}/page`);
    p.fake.startNavigation(p, `https://${BLOCKED}/page`);
    p.fake.subframeNavigates(p, "SUB-1", `https://${SUBFRAME}/frame`);
    guardBlanks(p);
  }) },
  // Only a subframe goes off the list, then the tab goes to about:blank.
  "/frame-only": { title: "frame only", onload: (p) => p.later(0, () => { p.fake.subframeNavigates(p, "SUB-1", `https://${SUBFRAME}/frame`); guardBlanks(p); }) },
};
const site = (url: URL) => (url.hostname === SITE ? PAGES[url.pathname] : undefined);

async function endpoint() {
  const chrome = await FakeChrome.start(site), h = await harness(), c = consumer([SITE]);
  const end = await backByChrome(h.fake, chrome);
  await h.ready(lineOf([SITE]));
  return { chrome, h, o: c.options({ cdpUrl: h.url("my-repo") }), close: async () => { end(); await h.close(); await chrome.close(); c.remove(); } };
}

async function refused(run: Promise<unknown>): Promise<NotAllowedError> {
  const e = await run.then(() => undefined, (x: unknown) => x);
  assert.ok(e instanceof NotAllowedError, String(e));
  assert.doesNotMatch(e.message, /SECRET-CODE/);
  return e;
}

test("over agent mode's endpoint, a redirect that the guard sends to about:blank names the blocked host: goto and open", async () => {
  const x = await endpoint();
  try {
    await commands.open(x.o, { url: `https://${SITE}/`, name: "t" });
    for (const path of ["/away", "/get", "/worker", "/error"]) {
      const e = await refused(commands.goto(x.o, { tab: "t", url: `https://${SITE}${path}` }));
      assert.equal(e.message, refusal(BLOCKED), path);
      assert.equal(e.host, BLOCKED);
    }
    // open: a new tab whose first page redirects to a download off the list.
    const e = await refused(commands.open(x.o, { url: `https://${SITE}/get`, name: "dl" }));
    assert.equal(e.message, refusal(BLOCKED));
    assert.ok([...x.chrome.pages.values()].filter((p) => p.url === "about:blank").length >= 2, "both tabs stay open on about:blank");
  } finally { await x.close(); }
});

test("over agent mode's endpoint, a redirect refusal with no known host says so in plain words", async () => {
  const x = await endpoint();
  try {
    await commands.open(x.o, { url: `https://${SITE}/`, name: "t" });
    const e = await refused(commands.goto(x.o, { tab: "t", url: `https://${SITE}/blank` }));
    assert.equal(e.message, refusal(UNREAD_HOST));
    assert.doesNotMatch(e.message, /\(no host\)|\(invalid url\)/);
  } finally { await x.close(); }
});

test("over agent mode's endpoint, a subframe's navigation off the list is never the main frame's blocked host", async () => {
  const x = await endpoint();
  try {
    await commands.open(x.o, { url: `https://${SITE}/`, name: "t" });
    assert.equal((await refused(commands.goto(x.o, { tab: "t", url: `https://${SITE}/frame-after` }))).message, refusal(BLOCKED));
    assert.equal((await refused(commands.goto(x.o, { tab: "t", url: `https://${SITE}/frame-only` }))).message, refusal(UNREAD_HOST));
  } finally { await x.close(); }
});

test("one connection, two gotos (a library caller): a second goto that does not commit never shows the first goto's blocked host", async () => {
  const x = await endpoint();
  const b = await AgentBrowser.connect(x.o);
  try {
    const tab = await b.open(`https://${SITE}/`);
    const refusalOf = async (url: string) => {
      const e = await tab.assertAllowed().then(() => undefined, (y: unknown) => y);
      assert.ok(e instanceof NotAllowedError, String(e));
      return (redirectError(e, url, e.host === UNREAD_HOST ? tab.blockedHost() : undefined) as Error).message;
    };
    await tab.goto(`https://${SITE}/away`);
    assert.equal(await refusalOf(`https://${SITE}/away`), refusal(BLOCKED));
    // A navigation that turns into a download (measured on the Linux server, Chromium 156): it starts, Page.navigate answers
    // net::ERR_ABORTED with isDownload true, and no page commits: the tab stays on the guard's blank page.
    const back = x.h.fake.op, dl = `https://${SITE}/setup.bin`;
    x.h.fake.op = async (req) => {
      if (req.op !== "debugger.sendCommand" || req.args[1] !== "Page.navigate" || req.args[2]?.url !== dl) return back(req);
      x.chrome.startNavigation(x.chrome.pages.get(tab.targetId)!, dl);
      return { frameId: `F-${tab.targetId}`, loaderId: "L-download", errorText: "net::ERR_ABORTED", isDownload: true };
    };
    await assert.rejects(tab.goto(dl), /^Error: navigation failed: net::ERR_ABORTED$/);
    assert.equal(tab.blockedHost(), undefined);
    assert.equal(await refusalOf(dl), refusal(UNREAD_HOST));
  } finally { await b.disconnect(); await x.close(); }
});
