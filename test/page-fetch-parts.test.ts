// PageFetch's parts (board ab-v16.102; contract C11, "PageFetch" and the sign-in act's check 7): the one private
// window's lock that the act and PageFetch share (src/service/fetch/lock.ts), the address rule (address.ts), the
// challenge check (fetch-page.ts), and the conversion with the pinned Defuddle's own browser build on a fake DOM
// (linkedom, which the pinned defuddle installs for its node entry) in a node:vm context, as an isolated world runs it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import { checkHost, checkUrl, refusedIp, refusedName } from "../src/service/fetch/address.ts";
import { CHECK_READ, challengeOf, checkArgs, convertExpression, defuddleBundle, type CheckRead } from "../src/service/fetch/fetch-page.ts";
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
function convert(html: string, mode: "main" | "whole", computed?: (el: any) => { display: string; visibility: string; opacity: string }) {
  const { document, window } = parseHTML(html);
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
