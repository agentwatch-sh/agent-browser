// The host of a redirect refusal (board ab-nfn): when the extension that guards the agent browser sends a tab whose
// navigation went off its list to about:blank, the tab's URL names no host, and the refusal used to say "(no host)".
// It names the host of the blocked navigation now, the host of the operator's prompt; with none known it says so in
// plain words. No browser starts: the real relay and CLI code run on the fake carrier and Chrome, with made-up hosts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { commands } from "../src/commands.ts";
import { NotAllowedError, UNREAD_HOST, redirectError } from "../src/errors.ts";
import { backByChrome, harness, lineOf } from "./fake-bridge.ts";
import { FakeChrome, type FakePage, type PageSpec } from "./fake-chrome.ts";
import { consumer } from "./helpers.ts";

const SITE = "files.example";
const BLOCKED = "downloads.example";
const TAIL = ". The tab stays open there; agent-browser does not touch it";
const refusal = (to: string) => `refusing: ${SITE} redirected the tab to ${to}, which is not on the allowlist${TAIL}`;
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
  assert.equal((redirectError(new NotAllowedError("https://other.example/x?code=SECRET"), `https://${SITE}/`, BLOCKED) as Error).message, refusal("other.example"));
});

test("redirectError: with no known host the refusal says so in plain words, never \"(no host)\" or \"(invalid url)\"", () => {
  for (const url of ["about:blank", "data:text/html,x", ""]) {
    const e = redirectError(new NotAllowedError(url), `https://${SITE}/get`);
    assert.ok(e instanceof NotAllowedError);
    assert.equal(e.message, refusal(UNREAD_HOST), url);
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
};
const site = (url: URL) => (url.hostname === SITE ? PAGES[url.pathname] : undefined);

async function endpoint() {
  const chrome = await FakeChrome.start(site), h = await harness(), c = consumer([SITE]);
  const end = await backByChrome(h.fake, chrome);
  await h.ready(lineOf([SITE]));
  return { chrome, o: c.options({ cdpUrl: h.url("my-repo") }), close: async () => { end(); await h.close(); await chrome.close(); c.remove(); } };
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

test("over agent mode's endpoint, a redirect refusal with no known host says so in plain words, and no earlier goto's host stays", async () => {
  const x = await endpoint();
  try {
    await commands.open(x.o, { url: `https://${SITE}/`, name: "t" });
    assert.equal((await refused(commands.goto(x.o, { tab: "t", url: `https://${SITE}/away` }))).message, refusal(BLOCKED));
    const e = await refused(commands.goto(x.o, { tab: "t", url: `https://${SITE}/blank` }));
    assert.equal(e.message, refusal(UNREAD_HOST));
    assert.doesNotMatch(e.message, /\(no host\)|\(invalid url\)/);
  } finally { await x.close(); }
});
