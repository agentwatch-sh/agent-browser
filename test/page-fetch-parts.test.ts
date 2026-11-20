// PageFetch's parts (board ab-v16.102; contract C11, "PageFetch" and the sign-in act's check 7): the one private
// window's lock that the act and PageFetch share (src/service/fetch/lock.ts), the address rule (address.ts), the
// challenge check (fetch-page.ts), and the conversion with the pinned Defuddle's own browser build on a fake DOM
// (linkedom, which the pinned defuddle installs for its node entry) in a node:vm context, as an isolated world runs it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import { checkHost, checkUrl, refusedIp, refusedName } from "../src/service/fetch/address.ts";
import { CHECK_PAGE_TITLES, CHECK_READ, challengeOf, checkArgs, convertExpression, defuddleBundle, looksLikeCheckPage, type CheckRead } from "../src/service/fetch/fetch-page.ts";
import { LOCK_LIMITS, WindowLock } from "../src/service/fetch/lock.ts";
import { ActRefusal } from "../src/service/signins/act.ts";
import { ACT_TEXT } from "../src/service/signins/act-rules.ts";
import { ActWorld } from "./act-fakes.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ the lock

test("the lock: one holder at a time; a waiting act goes before every waiting fetch, after the acts before it; a fetch past 8 waiting is busy", async () => {
  const lock = new WindowLock();
  const order: string[] = [];
  const first = await lock.fetch(1000);
  assert.equal(typeof first, "function");
  assert.equal(lock.held(), "fetch");
  const f1 = lock.fetch(5000).then((r) => { order.push("f1"); return r as () => void; });
  const f2 = lock.fetch(5000).then((r) => { order.push("f2"); return r as () => void; });
  const a1 = lock.act(5000).then((r) => { order.push("a1"); return r!; });
  const a2 = lock.act(5000).then((r) => { order.push("a2"); return r!; });
  for (let i = 0; i < 6; i++) void lock.fetch(50);
  assert.equal(lock.fetchesWaiting(), 8);
  assert.equal(await lock.fetch(5000), "busy");
  (first as () => void)();
  (await a1)(); (await a2)(); (await f1)(); (await f2)();
  assert.deepEqual(order, ["a1", "a2", "f1", "f2"]);
  assert.equal(LOCK_LIMITS.queue, 8);
});

test("the lock: an act waits at most its limit, plus a fetch's longest hold when a fetch holds the window; a fetch's wait has its limit; a release frees the place at once", async () => {
  const lock = new WindowLock({ fetchHoldMs: 300 });
  const held = await lock.act(10);
  const t0 = performance.now();
  assert.equal(await lock.act(100), null, "an act behind an act: its limit only");
  assert.ok(performance.now() - t0 < 250);
  assert.equal(await lock.fetch(80), "timeout");
  (held as () => void)();
  const fetch = await lock.fetch(10);
  const t1 = performance.now();
  const late = lock.act(100);
  await sleep(250);
  (fetch as () => void)();
  const got = await late;
  assert.equal(typeof got, "function", "an act behind a fetch also waits the fetch's longest hold");
  assert.ok(performance.now() - t1 >= 240);
  got!();
  assert.equal(lock.held(), null);
  assert.equal(LOCK_LIMITS.fetchHoldMs, 80_000);
});

test("the sign-in act's check 7 with the shared lock: an act waits behind a fetch to the fetch's longest hold, not busy at its own 60 s; behind an act it is busy at its limit as before", async () => {
  const lock = new WindowLock({ fetchHoldMs: 600 });
  const w = new ActWorld();
  const act = w.act({ lock });
  const fetch = (await lock.fetch(10)) as () => void;
  const done = act.signIn({ scope: "web-1", admission: "local" }, { name: "staging" });
  await sleep(500); // past the act's own limit of 400 ms in the fakes
  assert.equal(w.first("windows.create"), -1, "the act waits for the fetch's window");
  fetch();
  assert.equal((await done).signedIn, true);
  // Behind an act: busy at the act's limit (400 ms), as before.
  const held = (await lock.act(10)) as () => void;
  await assert.rejects(act.signIn({ scope: "web-1", admission: "local" }, { name: "staging" }), (e) => e instanceof ActRefusal && e.message === `Not signed in: ${ACT_TEXT.busy}`);
  held();
});

// ------------------------------------------------------------------ the address rule

test("the address rule: each refused range, its IPv4-mapped, IPv4-compatible and NAT64 forms, and public addresses that pass", () => {
  const refused: [string, string][] = [
    ["127.0.0.1", "a loopback address"], ["127.255.255.254", "a loopback address"], ["10.0.0.1", "a private address"], ["172.16.0.1", "a private address"],
    ["172.31.255.255", "a private address"], ["192.168.0.1", "a private address"], ["169.254.169.254", "a link-local address"], ["100.64.0.1", "a carrier-grade NAT address"],
    ["100.127.255.255", "a carrier-grade NAT address"], ["0.0.0.0", "an unspecified address"], ["0.1.2.3", "an unspecified address"], ["224.0.0.251", "a multicast address"],
    ["239.255.255.250", "a multicast address"], ["255.255.255.255", "a reserved address"], ["::", "an unspecified address"], ["::1", "a loopback address"],
    ["fc00::1", "a unique local address"], ["fdff::1", "a unique local address"], ["fe80::1", "a link-local address"], ["febf::1", "a link-local address"],
    ["fec0::1", "a site-local address"], ["ff02::fb", "a multicast address"], ["::ffff:127.0.0.1", "a loopback address in an IPv6 form"],
    ["::ffff:7f00:1", "a loopback address in an IPv6 form"], ["::ffff:192.168.1.1", "a private address in an IPv6 form"], ["::127.0.0.1", "a loopback address in an IPv6 form"],
    ["64:ff9b::10.0.0.1", "a private address in an IPv6 form"], ["::ffff:0:169.254.1.1", "a link-local address in an IPv6 form"], ["::ffff:100.64.0.1", "a carrier-grade NAT address in an IPv6 form"],
  ];
  for (const [ip, why] of refused) assert.equal(refusedIp(ip), why, ip);
  for (const ip of ["8.8.8.8", "203.0.113.10", "172.32.0.1", "100.128.0.1", "169.255.0.1", "192.169.0.1", "2606:4700::1111", "2001:db8::1", "::ffff:8.8.8.8", "64:ff9b::8.8.8.8"]) assert.equal(refusedIp(ip), null, ip);
  assert.equal(refusedIp("not-an-ip"), "no IP address");
  for (const n of ["localhost", "LOCALHOST.", "a.b.localhost", "printer.local", "x.internal", "internal"]) assert.ok(refusedName(n), n);
  for (const n of ["example.test", "localhost.example.test", "local.example.test", "internal.example.test"]) assert.equal(refusedName(n), null, n);
});

test("the address rule: a name by every address of the resolver (one refused address refuses it; none refuses it); URLs of the page's requests: ws and wss by host, data, blob and about pass, other schemes are refused", async () => {
  const resolve = async (h: string) => ({ "a.example.test": ["203.0.113.1", "2001:db8::1"], "b.example.test": ["203.0.113.1", "fd00::5"] } as Record<string, string[]>)[h] ?? [];
  assert.deepEqual(await checkHost("a.example.test", resolve), { ok: true });
  assert.deepEqual(await checkHost("b.example.test", resolve), { ok: false, why: "b.example.test has a unique local address" });
  assert.deepEqual(await checkHost("c.example.test", resolve), { ok: false, why: "c.example.test has no address in the box's resolver" });
  assert.deepEqual(await checkHost("c.example.test", async () => { throw new Error("ENOTFOUND"); }), { ok: false, why: "c.example.test has no address in the box's resolver" });
  assert.deepEqual(await checkUrl("wss://a.example.test/s", resolve), { ok: true });
  assert.deepEqual(await checkUrl("ws://[::1]:9/", resolve), { ok: false, why: "::1 is a loopback address" });
  for (const u of ["data:text/plain,x", "blob:https://a.example.test/0f", "about:blank"]) assert.deepEqual(await checkUrl(u, resolve), { ok: true }, u);
  for (const u of ["file:///etc/hostname", "chrome://settings", "ftp://a.example.test/"]) assert.equal((await checkUrl(u, resolve)).ok, false, u);
  assert.deepEqual(await checkUrl("ws://a.example.test/", resolve, { main: true }), { ok: false, why: "the URL must use http or https" });
  assert.deepEqual(await checkUrl("http://127.0.0.1:8080/", resolve, { main: true, admit: (u) => u.host === "127.0.0.1:8080" }), { ok: true }, "the tests' one local server");
});

// ------------------------------------------------------------------ the challenge check

const read = (o: Partial<CheckRead>): CheckRead => ({ title: "A page", text: "", frames: [], marks: { click: [], check: [] }, ...o });
test("the challenge check: the frames, marks and texts of a check that needs a click; the marks and titles of a check page; none on a page", () => {
  assert.deepEqual(challengeOf(read({ frames: [{ src: "https://newassets.hcaptcha.com/captcha/v1/x/static/hcaptcha.html#frame=checkbox", visible: true }] }), []), { click: "hCaptcha" });
  assert.deepEqual(challengeOf(read({ frames: [{ src: "https://www.google.com/recaptcha/api2/anchor?k=x&size=normal", visible: true }] }), []), { click: "reCAPTCHA" });
  assert.equal(challengeOf(read({ frames: [{ src: "https://www.google.com/recaptcha/api2/anchor?k=x&size=invisible", visible: true }] }), []), null, "invisible reCAPTCHA needs no click");
  assert.equal(challengeOf(read({ frames: [{ src: "https://www.google.com/recaptcha/api2/anchor?k=x", visible: false }] }), []), null, "a frame with no box");
  assert.deepEqual(challengeOf(read({}), ["https://geo.captcha-delivery.com/captcha/?initialCid=x"]), { click: "DataDome" }, "a frame that CDP gives");
  assert.deepEqual(challengeOf(read({ marks: { click: ["#px-captcha"], check: [] } }), []), { click: "HUMAN (PerimeterX)" });
  assert.deepEqual(challengeOf(read({ text: "example.test\nVerify you are human by completing the action below." }), []), { click: "Cloudflare" });
  assert.deepEqual(challengeOf(read({ title: "Just a moment..." }), []), { check: "Cloudflare" });
  assert.deepEqual(challengeOf(read({ marks: { click: [], check: ["#anubis_challenge, script[src*='/.within.website/x/cmd/anubis/']"] } }), []), { check: "Anubis" });
  assert.deepEqual(challengeOf(read({ title: "Making sure you're not a bot!" }), []), { check: "Anubis" });
  assert.equal(challengeOf(read({ title: "Just a moment... of reading", text: "An article about checks." }), []), null);
});

// ------------------------------------------------------------------ the conversion on a fake DOM, with the pinned Defuddle

const { parseHTML } = createRequire(import.meta.url)("linkedom");
const ARTICLE = "Some text of the article that a person reads. ".repeat(12);
const PAGE = `<html><head><title>The Test Title</title></head><body>
<nav><ul><li><a href="/a">Home link</a></li><li><a href="/b">Docs link</a></li></ul></nav>
<main><article><h1>Hello</h1><p>${ARTICLE}</p><p style="display:none">The hidden test text.</p></article>
<aside><h2>Prices</h2><ul><li>Item one 5 USD</li><li>Item two 7 USD</li></ul></aside></main><footer>The footer text</footer></body></html>`;

/** The conversion expression in a node:vm context with linkedom's document, as an isolated world: its own globals. */
function convert(html: string, mode: "main" | "whole", computed?: (el: any) => { display: string; visibility: string; opacity: string }, prepare?: (document: any) => void) {
  const { document, window } = parseHTML(html);
  if (prepare) prepare(document);
  // A rendered page's computed style (linkedom has no layout): the window's getComputedStyle, as Chrome's.
  if (computed) window.getComputedStyle = computed;
  const before = document.documentElement.outerHTML;
  const quiet = { log() {}, warn() {}, error() {}, debug() {}, info() {} };
  const ctx = vm.createContext({ document, window, self: window, location: { href: "https://pages.example.test/a" }, console: quiet, URL });
  let out;
  // linkedom's windows share their properties: the fake computed style goes after its call.
  try { out = JSON.parse(JSON.stringify(vm.runInContext(convertExpression(defuddleBundle(), "https://pages.example.test/a", mode, 200), ctx))); }
  finally { if (computed) delete window.getComputedStyle; }
  return { out, globals: Object.keys(ctx), domSame: document.documentElement.outerHTML === before, ownClone: Object.prototype.hasOwnProperty.call(document, "cloneNode") };
}

test("the conversion with the pinned Defuddle (defuddle/full) on a fake DOM: main gives the article, whole the whole body, hidden text is gone in both; no global; the DOM stays as it is", () => {
  const main = convert(PAGE, "main");
  assert.equal(main.out.title, "The Test Title");
  assert.match(main.out.content, /^## Hello\n\nSome text of the article/);
  assert.ok(!main.out.content.includes("Prices") && !main.out.content.includes("Home link"), "main: no menu and no aside");
  assert.equal(main.out.whole, false);
  assert.equal(main.out.fallback, false);
  const whole = convert(PAGE, "whole");
  for (const s of ["[Home link](https://pages.example.test/a)", "## Hello", "## Prices", "- Item one 5 USD", "The footer text"]) assert.ok(whole.out.content.includes(s), `whole: ${s}`);
  for (const r of [main, whole]) {
    assert.ok(!r.out.content.includes("The hidden test text."), "hidden text is gone");
    assert.deepEqual(r.globals.sort(), ["URL", "console", "document", "location", "self", "window"], "the build sets no global");
    assert.ok(r.domSame, "the live DOM stays as it is");
  }
  assert.equal(defuddleBundle(), defuddleBundle(), "read once");
});

test("the conversion: text that a style sheet hides (the rendered page's computed style: display none, visibility hidden) is gone in both modes, and text at opacity 0 stays (a fade-in on scroll; review-171 N1), as inline-hidden text; the live DOM stays as it is (the first live run, board ab-v16.102)", () => {
  const sheet = `<html><head><title>The Test Title</title><style>.gone{display:none}.ghost{visibility:hidden}.clear{opacity:0}</style></head><body>
<main><article><h1>Hello</h1><p>${ARTICLE}</p><p class="gone">The text of display none.</p><p class="ghost">The text of visibility hidden.</p>
<div class="clear"><p>The text of opacity zero.</p></div><p>The last visible text.</p></article></main></body></html>`;
  const rendered = (el: any) => ({
    display: el.classList?.contains("gone") || ["HEAD", "STYLE", "TITLE", "SCRIPT"].includes(el.tagName) ? "none" : "block",
    visibility: el.classList?.contains("ghost") ? "hidden" : "visible",
    opacity: el.classList?.contains("clear") ? "0" : "1",
  });
  for (const mode of ["main", "whole"] as const) {
    const r = convert(sheet, mode, rendered);
    for (const hidden of ["The text of display none.", "The text of visibility hidden."]) assert.ok(!r.out.content.includes(hidden), `${mode}: ${hidden}`);
    for (const shown of ["## Hello", "Some text of the article", "The text of opacity zero.", "The last visible text."]) assert.ok(r.out.content.includes(shown), `${mode}: ${shown}`);
    assert.ok(r.domSame, "the live DOM stays as it is");
    assert.deepEqual(r.globals.sort(), ["URL", "console", "document", "location", "self", "window"], "no global");
    assert.equal(r.ownClone, false, "no own cloneNode is left on the document");
  }
  // With no computed style (no layout), the conversion is as before: only Defuddle's own rules.
  const flat = convert(sheet, "whole");
  assert.ok(flat.out.content.includes("The text of display none."));
});

test("the conversion's fallback: main with fewer than 200 characters converts the whole page and says so", () => {
  const short = `<html><head><title>A list</title></head><body><nav><a href="/x">Menu</a></nav><ul><li>One</li><li>Two</li></ul><footer>Foot</footer></body></html>`;
  const r = convert(short, "main");
  assert.equal(r.out.whole, true);
  assert.equal(r.out.fallback, true);
  assert.ok(r.out.content.includes("One") && r.out.content.includes("Two"));
});

// ------------------------------------------------------------------ the consent layer (board ab-v16.107)
// The real-page check of 2026-11-15: a museum's object page gave 833,174 characters of a consent manager's partner list
// in mode main, not the object record. The copy that Defuddle reads drops the consent managers' roots (CONSENT_ROOTS).

const RECORD = "The object record: an intaglio of carnelian, cut in the Roman period, about the second century. The museum holds it in its department of Greece and Rome; the stone shows a standing figure with a staff.";
const PARTNERS = (n: number) => Array.from({ length: n }, (_, i) => `<div class="vendor"><h4>Partner ${i + 1}</h4><p>Purposes (Consent): Store and/or access information on a device; Use limited data to select advertising; Create profiles for personalised advertising; Measure advertising performance.</p><p>Data Retention Period: 180 days</p><a href="#">Show details</a></div>`).join("");
const RECORD_PAGE = (layer: string) => `<html><head><title>intaglio</title></head><body>
<header><nav><a href="/">Home</a> <a href="/collection">Collection</a></nav></header>
<main><article><h1>Intaglio</h1><p>${RECORD}</p></article></main>${layer}<footer>The museum's footer</footer></body></html>`;
const ONETRUST = `<div id="onetrust-consent-sdk"><div id="onetrust-banner-sdk"><p>We use cookies. See the partners we work with below. Expand each one to see how they process your data.</p><button>Accept all</button></div>
<div id="onetrust-pc-sdk" class="otPcCenter"><h3>Our partners</h3>${PARTNERS(300)}</div><div class="onetrust-pc-dark-filter"></div></div>`;

test("the consent layer: a page with a OneTrust layer (a large partner list) and a short article: main gives the article, also when a style sheet hides the list; whole drops the layer too; the live DOM stays as it is", () => {
  // The preference center closed by a style sheet: Defuddle's own retry for little content reads hidden elements again.
  const closed = (el: any) => ({ display: el.getAttribute?.("id") === "onetrust-pc-sdk" || ["HEAD", "STYLE", "TITLE", "SCRIPT"].includes(el.tagName) ? "none" : "block", visibility: "visible", opacity: "1" });
  for (const computed of [undefined, closed]) {
    for (const mode of ["main", "whole"] as const) {
      const r = convert(RECORD_PAGE(ONETRUST), mode, computed);
      const how = `${mode}${computed ? ", the list closed" : ""}`;
      assert.ok(r.out.content.includes("an intaglio of carnelian"), `${how}: the record: ${r.out.content.slice(0, 200)}`);
      for (const gone of ["Purposes (Consent)", "Partner 1", "See the partners we work with", "Accept all"]) assert.ok(!r.out.content.includes(gone), `${how}: no ${gone}`);
      assert.ok(r.out.content.length < 2000, `${how}: ${r.out.content.length} characters`);
      assert.ok(r.domSame, `${how}: the live DOM stays as it is`);
      assert.equal(r.ownClone, false);
      assert.deepEqual(r.globals.sort(), ["URL", "console", "document", "location", "self", "window"], "no global");
    }
  }
  const main = convert(RECORD_PAGE(ONETRUST), "main");
  assert.equal(main.out.whole, false, "main, with no fallback");
});

test("the consent layer: a page with a Sourcepoint container (its id with the message's number) and a short article: main gives the article", () => {
  const sp = `<div id="sp_message_container_1180232" class="message-container"><div class="message"><p>We and our partners process your data.</p>${PARTNERS(200)}</div></div>`;
  for (const mode of ["main", "whole"] as const) {
    const r = convert(RECORD_PAGE(sp), mode);
    assert.ok(r.out.content.includes("an intaglio of carnelian"), `${mode}: the record`);
    assert.ok(!r.out.content.includes("Purposes (Consent)") && !r.out.content.includes("We and our partners"), `${mode}: no partner list`);
    assert.ok(r.domSame);
  }
});

test("the consent layer: a root matches by its whole id or class name only; an article about consent (class consent-article) stays, and so do names that hold a root's name", () => {
  const essay = "Consent is the agreement of a person to a use of their data. ".repeat(8);
  const page = `<html><head><title>On consent</title></head><body><main><article class="consent-article" id="consent"><h1>What consent means</h1><p>${essay}</p>
<div class="cookie-consent fc-consent-root-notes my-onetrust-consent-sdk"><p>NOTES-KEPT: the notes of the article.</p></div><div id="sp_message_container_notes"><p>SP-NOTES-KEPT: no number after the prefix.</p></div><div id="Klaro"><p>CASE-KEPT: an id in another case.</p></div></article></main></body></html>`;
  for (const mode of ["main", "whole"] as const) {
    const r = convert(page, mode);
    for (const kept of ["What consent means", "Consent is the agreement of a person", "NOTES-KEPT", "SP-NOTES-KEPT", "CASE-KEPT"]) assert.ok(r.out.content.includes(kept), `${mode}: ${kept}`);
  }
});

test("the consent layer: the safety rule: a page whose text is only a consent layer keeps the layer (fewer than 200 characters without it), with no part that the page marks hidden (aria-hidden true, the hidden attribute)", () => {
  const wall = `<html><head><title>Before you continue</title></head><body><div id="CybotCookiebotDialog"><h2>This website uses cookies</h2>
<p>WALL-TEXT: we use cookies to personalise content and ads, to provide social media features and to analyse our traffic. Choose below.</p><button>Allow all</button>
<div id="CybotCookiebotDialogDetail" aria-hidden="true">${PARTNERS(50)}</div><div hidden><p>HIDDEN-ATTRIBUTE-PART of the layer.</p></div></div></body></html>`;
  for (const mode of ["main", "whole"] as const) {
    const r = convert(wall, mode);
    assert.ok(r.out.content.includes("WALL-TEXT"), `${mode}: the layer stays: ${r.out.content.slice(0, 200)}`);
    for (const gone of ["Partner 1", "Purposes (Consent)", "HIDDEN-ATTRIBUTE-PART"]) assert.ok(!r.out.content.includes(gone), `${mode}: no ${gone}`);
    assert.ok(r.domSame);
  }
  // aria-hidden outside the layer is the page's own matter: it stays (Defuddle's own rules).
  const own = convert(RECORD_PAGE(`<div aria-hidden="true"><p>OWN-ARIA-HIDDEN: a part of the page itself.</p></div>`), "whole");
  assert.ok(own.out.content.includes("OWN-ARIA-HIDDEN"));
});

// Board ab-v16.109: the live check of 2026-11-16: the museum's object page (Cookiebot) still gave 833,174 characters of
// the partner list in main. Fewer than 200 characters are outside the root, so the safety rule keeps it; its partner
// list is closed by a style sheet, and Defuddle's retries for little content (no hidden-element removal, then the
// largest hidden subtree, which Defuddle finds by .hidden and .invisible too) took it.
const COOKIEBOT_WALL = (detail: string) => `<html><head><title>Object page</title><style>.panel-closed{display:none}.hidden{display:none}.invisible{visibility:hidden}</style></head><body>
<header><nav><a href="/">Home</a> <a href="/collection">Collection</a> <a href="/visit">Visit</a></nav></header>
<div id="CybotCookiebotDialog"><h2>Responsible use of your data</h2><p>WALL-TEXT: we and our partners process personal data. Choose below.</p>
<div id="CybotCookiebotDialogBodyButtons"><button>Allow all cookies</button> <button>Manage cookies</button> <button>Reject all cookies</button></div>${detail}</div></body></html>`;
// The rendered page's computed style for the style sheet above (linkedom has no layout); visibility is inherited, as in
// Chrome (board ab-v16.110: an element with no mark in a hidden one is one that the page shows again).
const closedBySheet = (el: any) => ({
  display: el.classList?.contains("panel-closed") || el.classList?.contains("hidden") || ["HEAD", "STYLE", "TITLE", "SCRIPT"].includes(el.tagName) ? "none" : "block",
  visibility: el.closest?.(".invisible") ? "hidden" : "visible", opacity: "1",
});

test("board ab-v16.109: the safety rule: a page whose text is only a Cookiebot layer, its partner list closed by a style sheet (a class rule, not inline): both modes give the layer's visible text, not the list, and say that the safety rule kept the layer", () => {
  const page = COOKIEBOT_WALL(`<div id="CybotCookiebotDialogTabContent" class="panel-closed"><h3>Our partners</h3>${PARTNERS(60)}</div>`);
  for (const mode of ["main", "whole"] as const) {
    const r = convert(page, mode, closedBySheet);
    for (const kept of ["WALL-TEXT", "Responsible use of your data", "Allow all cookies", "Reject all cookies"]) assert.ok(r.out.content.includes(kept), `${mode}: ${kept}: ${r.out.content.slice(0, 300)}`);
    for (const gone of ["Partner 1", "Purposes (Consent)", "Our partners"]) assert.ok(!r.out.content.includes(gone), `${mode}: no ${gone}`);
    assert.ok(r.out.content.length < 1000, `${mode}: ${r.out.content.length} characters`);
    assert.equal(r.out.consentLayer, true, `${mode}: the safety rule kept the layer`);
    assert.ok(r.domSame, `${mode}: the live DOM stays as it is`);
    assert.equal(r.ownClone, false);
  }
});

test("board ab-v16.109: the safety rule: in the layer, an element with the class hidden or invisible goes only when the rendered page hides it (a style sheet's rule); with no computed hiding (Tailwind's hidden md:block at a wide window) it stays (review note N4)", () => {
  for (const cls of ["hidden", "invisible", "tab hidden"]) {
    const page = COOKIEBOT_WALL(`<div id="CybotCookiebotDialogTabContent" class="${cls}"><h3>Our partners</h3>${PARTNERS(60)}</div>`);
    for (const mode of ["main", "whole"] as const) {
      const r = convert(page, mode, closedBySheet);
      const how = `${mode}, class ${cls}, hidden by the style sheet`;
      assert.ok(r.out.content.includes("WALL-TEXT") && r.out.content.includes("Allow all cookies"), `${how}: the layer's text: ${r.out.content.slice(0, 300)}`);
      for (const gone of ["Partner 1", "Purposes (Consent)"]) assert.ok(!r.out.content.includes(gone), `${how}: no ${gone}`);
      assert.equal(r.out.consentLayer, true, how);
    }
  }
  // The class alone is no mark: at a wide window Tailwind's "hidden md:block" shows the element, and a page with no
  // layout (no computed style) has no mark either. The drop leaves it; Defuddle's own rules apply to it.
  const wide = `<div class="hidden md:block"><p>${"WIDE-PART: a line of the layer that a wide window shows. ".repeat(6)}</p></div>`;
  const shown = (el: any) => ({ display: ["HEAD", "STYLE", "TITLE", "SCRIPT"].includes(el.tagName) ? "none" : "block", visibility: "visible", opacity: "1" });
  for (const computed of [shown, undefined]) {
    for (const mode of ["main", "whole"] as const) {
      const r = convert(COOKIEBOT_WALL(wide), mode, computed);
      const how = `${mode}${computed ? ", shown by the computed style" : ", no computed style"}`;
      assert.ok(r.out.content.includes("WIDE-PART"), `${how}: ${r.out.content.slice(0, 300)}`);
      assert.equal(r.out.consentLayer, true, how);
    }
  }
});

test("board ab-v16.109: the consent drop touches nothing outside the layer: the answer is the same as for the page without the layer's closed list (review gap T1); board ab-v16.110 decides first for the page's own notes outside the layer that a style hides: they go too", () => {
  // Two notes of the page outside the layer, each closed by the style sheet (so neither counts in the 200 characters):
  // one by its class hidden, one by another class rule. Each is long enough for Defuddle's retries to read it.
  const outside = `<div class="hidden"><p>${"OUT-CLASS: a note of the page that its class hides. ".repeat(8)}</p></div><div class="panel-closed"><p>${"OUT-STYLE: a note of the page that a style rule hides. ".repeat(8)}</p></div>`;
  const wall = (detail: string) => COOKIEBOT_WALL(detail).replace("</nav></header>", `</nav></header>${outside}`);
  const closed = wall(`<div id="CybotCookiebotDialogTabContent" class="panel-closed"><h3>Our partners</h3>${PARTNERS(60)}</div>`);
  const open = wall("");
  // The rendered page's style closes the list and the note OUT-STYLE; OUT-CLASS has the class hidden and its sheet rule.
  {
    for (const mode of ["main", "whole"] as const) {
      const how = mode;
      const a = convert(closed, mode, closedBySheet), b = convert(open, mode, closedBySheet);
      assert.equal(a.out.consentLayer, true, `${how}: the safety rule kept the layer`);
      assert.equal(b.out.consentLayer, true, `${how}: the same without the list`);
      assert.equal(a.out.content, b.out.content, `${how}: the same answer as with no closed list`);
      assert.equal(a.out.whole, b.out.whole, how);
    }
  }
  // Board ab-v16.110: the copy has no element that the rendered page hides, so Defuddle's retries for little content no
  // longer read the page's own hidden notes again (before, they gave OUT-CLASS and OUT-STYLE).
  for (const mode of ["main", "whole"] as const) {
    const r = convert(closed, mode, closedBySheet);
    for (const gone of ["OUT-CLASS", "OUT-STYLE"]) assert.ok(!r.out.content.includes(gone), `${mode}: no ${gone}: ${r.out.content.slice(0, 300)}`);
    assert.ok(!r.out.content.includes("Partner 1"), `${mode}: no partner list`);
  }
});

test("board ab-v16.109: a page with 200 or more characters outside the layer is as before: the root goes with its hidden and visible parts, and the safety rule kept no layer; a page with no layer keeps no layer", () => {
  const page = RECORD_PAGE(`<div id="CybotCookiebotDialog"><p>WALL-TEXT: we use cookies.</p><button>Allow all cookies</button><div class="panel-closed">${PARTNERS(60)}</div></div>`);
  for (const mode of ["main", "whole"] as const) {
    const r = convert(page, mode, closedBySheet);
    assert.ok(r.out.content.includes("an intaglio of carnelian"), `${mode}: the record`);
    for (const gone of ["WALL-TEXT", "Allow all cookies", "Partner 1"]) assert.ok(!r.out.content.includes(gone), `${mode}: no ${gone}`);
    assert.equal(r.out.consentLayer, false, `${mode}: no layer kept`);
  }
  assert.equal(convert(PAGE, "main").out.consentLayer, false, "no layer");
});

test("the consent layer: the drop comes after Defuddle's flattening of shadow roots, which pairs the live elements with the copy's by their order: a shadow root after the layer stays in its own place, and a layer in a shadow host goes", () => {
  const page = RECORD_PAGE(`${ONETRUST}<section><x-card id="card"></x-card></section><div id="usercentrics-root"></div>`);
  const shadows = (doc: any) => {
    doc.getElementById("card").attachShadow({ mode: "open" }).innerHTML = `<p>SHADOW-CARD: the text of the page's own card, ${"with enough words for a block. ".repeat(3)}</p>`;
    doc.getElementById("usercentrics-root").attachShadow({ mode: "open" }).innerHTML = `<div><p>UC-LAYER: we use cookies.</p>${PARTNERS(100)}</div>`;
  };
  const r = convert(page, "whole", undefined, shadows);
  assert.ok(r.out.content.includes("an intaglio of carnelian") && r.out.content.includes("SHADOW-CARD"), `the record and the card: ${r.out.content.slice(0, 300)}`);
  assert.ok(r.out.content.indexOf("SHADOW-CARD") > r.out.content.indexOf("an intaglio of carnelian"), "the card after the record, in its own place");
  for (const gone of ["UC-LAYER", "Partner 1", "We use cookies. See the partners"]) assert.ok(!r.out.content.includes(gone), `no ${gone}`);
});

// ------------------------------------------------------------------ no hidden element in the copy (board ab-v16.110)
// The live check of 2026-11-16: the museum's object page (a Cookiebot layer with the site's own dialog id, which no
// consent root matches) still gave 833,174 characters of the closed partner list in main: Defuddle's first parse found
// little, and its retries read hidden elements again. The copy that Defuddle reads has no element that the rendered page
// hides, so no retry brings one back.

const VENDORS = (n: number) => Array.from({ length: n }, (_, i) => `<li><h4>VENDOR-${i + 1}</h4><p>Purposes: store and access information on a device; select personalised advertising; measure advertising performance; develop and improve services.</p></li>`).join("");
/** A page with a visible record and a large vendor list that a style sheet's rule closes (not an inline style). */
const WALL_PAGE = (record: string, wallClass: string) => `<html><head><title>Object page</title><style>.site-wall{display:none}</style></head><body>
<header><nav><a href="/">Home</a> <a href="/collection">Collection</a></nav></header>
<main><article><h1>Intaglio</h1><p>${record}</p></article></main>
<div id="site-consent-dialog" class="${wallClass}"><h3>Our vendors</h3><ul>${VENDORS(400)}</ul></div><footer>The museum's footer</footer></body></html>`;
// The rendered page's computed style (linkedom has no layout): display none by the classes `closedBy`; visibility hidden
// in a .ghost and visible again in a .seen, inherited as in Chrome (the nearer of the two decides).
const sheetStyle = (closedBy: (el: any) => boolean) => (el: any) => {
  const g = el.closest?.(".ghost"), s = el.closest?.(".seen");
  return {
    display: closedBy(el) || ["HEAD", "STYLE", "TITLE", "SCRIPT"].includes(el.tagName) ? "none" : "block",
    visibility: g && !(s && g.contains(s)) ? "hidden" : "visible",
    opacity: "1",
  };
};
const wallClosed = sheetStyle((el) => el.classList?.contains("site-wall"));
// 41 words and more than 200 characters: main keeps its own answer, and Defuddle's retries for fewer than 50 words run.
const SHORT_RECORD = "The object record: an intaglio of carnelian, cut in the Roman period, about the second century. The stone shows a standing figure with a staff. The museum holds it in its department of Greece and Rome, room 70.";
// 17 words and fewer than 200 characters: main falls back to whole.
const TINY_RECORD = "The object record: an intaglio of carnelian, Roman, about the second century; a figure with a staff.";

test("board ab-v16.110: a short visible record and a large block that a style sheet closes (not inline): both modes give the record and never the block, also with fewer than 50 words (Defuddle's retries for little content, its largest hidden block, its index retry) and through main's fallback to whole; the live DOM stays as it is", () => {
  for (const [record, name] of [[SHORT_RECORD, "41 words"], [TINY_RECORD, "17 words"]] as const) {
    // The class hidden also makes the block Defuddle's largest hidden block (its hidden-content selector).
    for (const wallClass of ["site-wall", "site-wall hidden"]) {
      for (const mode of ["main", "whole"] as const) {
        const r = convert(WALL_PAGE(record, wallClass), mode, wallClosed);
        const how = `${mode}, ${name}, class ${wallClass}`;
        assert.ok(r.out.content.includes("an intaglio of carnelian"), `${how}: the record: ${r.out.content.slice(0, 300)}`);
        for (const gone of ["VENDOR-1", "Purposes: store", "Our vendors"]) assert.ok(!r.out.content.includes(gone), `${how}: no ${gone}: ${r.out.content.length} characters`);
        assert.ok(r.out.content.length < 1000, `${how}: ${r.out.content.length} characters`);
        assert.ok(r.domSame, `${how}: the live DOM stays as it is`);
        assert.equal(r.ownClone, false, how);
        assert.equal(r.out.consentLayer, false, `${how}: no consent root`);
      }
    }
  }
  const short = convert(WALL_PAGE(SHORT_RECORD, "site-wall"), "main", wallClosed);
  assert.equal(short.out.whole, false, "41 words: main's own answer");
  const tiny = convert(WALL_PAGE(TINY_RECORD, "site-wall"), "main", wallClosed);
  assert.equal(tiny.out.fallback, true, "17 words: main's fallback to whole");
});

test("board ab-v16.110: Defuddle's schema.org retry (the page's articleBody matches a closed block) never gives the block: both modes give the visible article", () => {
  const body = "SCHEMA-BODY: the full text of a record that only a closed panel holds. ".repeat(40);
  const ld = JSON.stringify({ "@context": "https://schema.org", "@type": "Article", headline: "Hello", articleBody: body });
  const page = `<html><head><title>The Test Title</title><style>.site-wall{display:none}</style><script type="application/ld+json">${ld}</script></head><body>
<main><article><h1>Hello</h1><p>${ARTICLE}</p></article></main><div id="full-record" class="site-wall"><p>${body}</p></div></body></html>`;
  for (const mode of ["main", "whole"] as const) {
    const r = convert(page, mode, wallClosed);
    assert.ok(r.out.content.includes("Some text of the article"), `${mode}: the article: ${r.out.content.slice(0, 300)}`);
    assert.ok(!r.out.content.includes("SCHEMA-BODY"), `${mode}: no closed block: ${r.out.content.slice(0, 300)}`);
    assert.ok(r.domSame, `${mode}: the live DOM stays as it is`);
  }
});

test("board ab-v16.110: a closed tab (display none by a style sheet) loses its text in main, also when the visible text has fewer than 50 words; the open tab stays (the cost that the manager accepted)", () => {
  const page = `<html><head><title>Opening times</title><style>.tab{display:none}.tab.open{display:block}</style></head><body>
<main><article><h1>Opening times</h1><p>The museum opens every day from ten in the morning to five in the afternoon. On Fridays, some galleries stay open until half past eight in the evening. Entry is free.</p>
<div class="tabs"><div class="tab open"><p>OPEN-TAB: the galleries of the ground floor.</p></div><div class="tab"><p>${"CLOSED-TAB: the text of a closed tab, which a person sees only after a click. ".repeat(10)}</p></div>
<div class="tab"><p>${"SECOND-CLOSED-TAB: another closed tab of the page. ".repeat(20)}</p></div></div></article></main></body></html>`;
  const tabs = sheetStyle((el) => el.classList?.contains("tab") && !el.classList.contains("open"));
  const r = convert(page, "main", tabs);
  assert.equal(r.out.whole, false, "main's own answer");
  for (const kept of ["The museum opens every day", "OPEN-TAB"]) assert.ok(r.out.content.includes(kept), `${kept}: ${r.out.content.slice(0, 300)}`);
  for (const gone of ["CLOSED-TAB", "SECOND-CLOSED-TAB"]) assert.ok(!r.out.content.includes(gone), `no ${gone}: ${r.out.content.slice(0, 300)}`);
  assert.ok(r.domSame, "the live DOM stays as it is");
});

test("board ab-v16.110: a parent that visibility hidden hides, with a child that visibility visible shows: both modes keep the child's text, never the parent's own text; a hidden parent with no shown child goes", () => {
  const page = `<html><head><title>The Test Title</title><style>.ghost{visibility:hidden}.seen{visibility:visible}</style></head><body>
<main><article><h1>Hello</h1><p>${ARTICLE}</p><div class="ghost">GHOST-LOOSE: the parent's own text. <p>GHOST-OWN: a hidden child.</p><div><p class="seen">SEEN-CHILD: the text that the page shows.</p></div></div>
<div class="ghost"><p>GHOST-ALL: a hidden parent with no shown child.</p></div><p>The last visible text.</p></article></main></body></html>`;
  for (const mode of ["main", "whole"] as const) {
    const r = convert(page, mode, sheetStyle(() => false));
    for (const kept of ["Some text of the article", "SEEN-CHILD", "The last visible text."]) assert.ok(r.out.content.includes(kept), `${mode}: ${kept}: ${r.out.content.slice(-300)}`);
    for (const gone of ["GHOST-LOOSE", "GHOST-OWN", "GHOST-ALL"]) assert.ok(!r.out.content.includes(gone), `${mode}: no ${gone}`);
    assert.ok(r.domSame, `${mode}: the live DOM stays as it is`);
  }
});

test("board ab-v16.110: the removal comes after Defuddle's flattening of shadow roots, which pairs the live elements with the copy's by their order: a shadow root after a closed block stays in its own place", () => {
  const page = `<html><head><title>intaglio</title><style>.site-wall{display:none}</style></head><body><main><article><h1>Intaglio</h1><p>${RECORD}</p>
<div class="site-wall"><p>${"HIDDEN-BEFORE: a closed block before the card. ".repeat(10)}</p><p>A second closed paragraph.</p></div><section><x-card id="card"></x-card></section><p>AFTER-CARD: the last line.</p></article></main></body></html>`;
  const shadows = (doc: any) => { doc.getElementById("card").attachShadow({ mode: "open" }).innerHTML = `<p>SHADOW-CARD: the text of the page's own card, ${"with enough words for a block. ".repeat(3)}</p>`; };
  for (const mode of ["main", "whole"] as const) {
    const r = convert(page, mode, wallClosed, shadows);
    const at = (s: string) => r.out.content.indexOf(s);
    assert.ok(at("an intaglio of carnelian") >= 0 && at("SHADOW-CARD") > at("an intaglio of carnelian") && at("AFTER-CARD") > at("SHADOW-CARD"), `${mode}: the record, the card, the last line, in order: ${r.out.content.slice(0, 400)}`);
    assert.ok(!r.out.content.includes("HIDDEN-BEFORE") && !r.out.content.includes("A second closed paragraph."), `${mode}: no closed block`);
  }
});

test("board ab-v16.110 (review-183 B2): Defuddle's flattening inserts a shadow root's elements with no mark: a region that visibility hidden hides, with a web component in it, gives no text of the component; a custom-element host that display none hides keeps its mark on Defuddle's replacement, so its shadow text does not come; both modes", () => {
  const page = `<html><head><title>The Test Title</title><style>.ghost{visibility:hidden}.shut{display:none}</style></head><body>
<main><article><h1>Hello</h1><p>${ARTICLE}</p><div class="ghost"><x-card id="ghost-card"></x-card></div><x-card id="shut-card" class="shut"></x-card><section><x-card id="open-card"></x-card></section><p>The last visible text.</p></article></main></body></html>`;
  const shadows = (doc: any) => {
    doc.getElementById("ghost-card").attachShadow({ mode: "open" }).innerHTML = `<p>GHOST-SHADOW: the text of a component in a hidden region, ${"with enough words for a block. ".repeat(3)}</p>`;
    doc.getElementById("shut-card").attachShadow({ mode: "open" }).innerHTML = `<p>SHUT-SHADOW: the text of a component that display none hides, ${"with enough words for a block. ".repeat(3)}</p>`;
    doc.getElementById("open-card").attachShadow({ mode: "open" }).innerHTML = `<p>OPEN-SHADOW: the text of a shown component, ${"with enough words for a block. ".repeat(3)}</p>`;
  };
  const style = sheetStyle((el) => el.classList?.contains("shut"));
  for (const mode of ["main", "whole"] as const) {
    const r = convert(page, mode, style, shadows);
    for (const kept of ["Some text of the article", "OPEN-SHADOW", "The last visible text."]) assert.ok(r.out.content.includes(kept), `${mode}: ${kept}: ${r.out.content.slice(-400)}`);
    for (const gone of ["GHOST-SHADOW", "SHUT-SHADOW"]) assert.ok(!r.out.content.includes(gone), `${mode}: no ${gone}`);
    assert.ok(r.domSame, `${mode}: the live DOM stays as it is`);
    assert.equal(r.ownClone, false, mode);
  }
});

test("the check page note: a status of 401, 403, 429 or 503 and a check page's whole title (any case, spaces collapsed); not another status, not a title that only holds one", () => {
  assert.ok(looksLikeCheckPage(401, "Security Verification"));
  assert.ok(looksLikeCheckPage(403, "  ACCESS   denied "));
  assert.ok(looksLikeCheckPage(429, "Vercel Security Checkpoint"));
  assert.ok(looksLikeCheckPage(503, "Attention Required! | Cloudflare"));
  assert.ok(looksLikeCheckPage(403, "Access to this page has been denied."));
  assert.ok(!looksLikeCheckPage(200, "Security Verification"), "200");
  assert.ok(!looksLikeCheckPage(404, "Access denied"), "404");
  assert.ok(!looksLikeCheckPage(null, "Access denied"), "no status");
  assert.ok(!looksLikeCheckPage(403, "Access denied | example.test used a rule"), "only a part of the title");
  assert.ok(!looksLikeCheckPage(403, "403 Forbidden"), "a plain error page");
  for (const [t] of CHECK_PAGE_TITLES) assert.equal(t, t.toLowerCase(), "each title in lower case");
});

test("the check read on a fake DOM: its marks, its frames and its text", () => {
  const { document, window } = parseHTML(`<html><head><title>Just a moment...</title></head><body><div id="challenge-running">Checking</div><iframe src="https://www.google.com/recaptcha/api2/anchor?k=x"></iframe><div id="px-captcha"></div></body></html>`);
  for (const el of document.querySelectorAll("iframe")) el.getBoundingClientRect = () => ({ width: 300, height: 80 });
  const ctx = vm.createContext({ document, window });
  const r = JSON.parse(JSON.stringify(vm.runInContext(`(${CHECK_READ})(${checkArgs().map((a) => JSON.stringify(a)).join(", ")})`, ctx)));
  assert.equal(r.title, "Just a moment...");
  assert.deepEqual(r.frames, [{ src: "https://www.google.com/recaptcha/api2/anchor?k=x", visible: true }]);
  assert.deepEqual(r.marks, { click: ["#px-captcha"], check: ["#challenge-running, #challenge-stage, #challenge-form, #cf-challenge-running"] });
  assert.deepEqual(challengeOf(r, []), { click: "reCAPTCHA" });
});

// ------------------------------------------------------------------ the daemon lead's rule: an act waits for a running fetch

test("the daemon lead's rule: an act waits for a running fetch and never fails because of it; the lock ends a fetch's hold at its longest hold, also when the fetch's code has not ended", async () => {
  const lock = new WindowLock({ fetchHoldMs: 300 });
  await lock.fetch(10); // a fetch that never releases (its code hangs)
  const t0 = performance.now();
  const got = await lock.act(100);
  assert.equal(typeof got, "function", "the act gets the window, not busy");
  assert.ok(performance.now() - t0 >= 250, "after the fetch's longest hold");
  assert.equal(lock.held(), "act");
  got!();
});

test("a fetch window that did not end: the window's next holder (an act or a fetch) runs its end first, at most leftMs, then gets its own window", async () => {
  const lock = new WindowLock({ leftMs: 200 });
  const order: string[] = [];
  const f = (await lock.fetch(10)) as (left?: () => Promise<void>) => void;
  const act = lock.act(1000).then((r) => { order.push("act"); return r!; });
  f(async () => { order.push("left end"); });
  (await act)();
  assert.deepEqual(order, ["left end", "act"]);
  // An end that never answers holds the next holder at most leftMs.
  const g = (await lock.fetch(10)) as (left?: () => Promise<void>) => void;
  g(() => new Promise(() => {}));
  const t0 = performance.now();
  const next = await lock.fetch(1000);
  assert.equal(typeof next, "function");
  assert.ok(performance.now() - t0 >= 190 && performance.now() - t0 < 800);
  (next as () => void)();
});

test("PageFetch with the lock: a fetch whose fetch_end failed leaves its end to the next holder; the act's window opens after it", async () => {
  const { FetchWorld } = await import("./fetch-fakes.ts");
  const lock = new WindowLock();
  const w = new FetchWorld();
  let fail = true;
  w.fetchEnd = async () => { if (fail) throw new Error("fetch not closed"); return { closed: 1 }; };
  await w.fetcher({ lock }).fetch({ scope: "web-1", admission: "local" }, { url: "https://pages.example.test/a" });
  assert.equal(w.fetchEnds, 2, "fetch_end and its one more try");
  fail = false;
  const a = new ActWorld();
  const act = a.act({ lock });
  assert.equal((await act.signIn({ scope: "web-1", admission: "local" }, { name: "staging" })).signedIn, true);
  assert.equal(w.fetchEnds, 3, "the act's turn ended the left fetch window first");
  assert.ok(w.log.includes("page-fetch: the left fetch window ended before the next private window"), w.log.join("\n"));
});
