// The card payment's act window up to the operator's approval (contract C11, the card payment: check 8, the request,
// the one private window, the texts; chrome-extension's C4 pay_merchant_block, pay_cookies_copy, act_rules, act_end and
// C5's rule 90; the secure card checkout design, sections 8.1 to 8.4, 8.6 and 8.8; board ab-sta.6, the plan's Task 5a).
// The real preparation (src/service/pay/act.ts) over the fakes of test/pay-act-fakes.ts: the agent's tab, the act tab
// with its pages and frames, the receiver with rule 90 as a state, and the real lock of the one private window. TEST
// values only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { merchantDomain, PayActWindow, MAX_SEND_TO } from "../src/service/pay/act.ts";
import { PROVIDER_ORIGINS } from "../src/service/pay/providers.ts";
import type { Prepared } from "../src/service/pay/request.ts";
import { PAY_TEXT } from "../src/service/pay/texts.ts";
import { ACT_TAB, AGENT_TAB, CARD_FIELDS, cardView, checkoutPage, field, PayBrowser, requestView, SHOP, STORAGE, STRIPE } from "./pay-act-fakes.ts";

const prepare = (b: PayBrowser, o: Parameters<PayBrowser["prepare"]>[0] = {}, req = requestView(), signal = new AbortController().signal) => b.prepare(o).prepare(req, cardView(), signal);
const ok = (p: Prepared) => { assert.ok("order" in p, JSON.stringify(p)); return p as Extract<Prepared, { order: unknown }>; };
/** After a stop: the window's end ran (act_end once when the window opened), rule 90 is off and the lock is free. */
function ended(b: PayBrowser, opened: boolean, what: string): void {
  assert.equal(b.actEnds, opened ? 1 : 0, `${what}: act_end ${opened ? "once" : "never"}`);
  assert.equal(b.rule90, null, `${what}: no rule 90 left`);
  assert.equal(b.lock.held(), null, `${what}: the lock is free`);
}

// ---------------------------------------------------------------- the whole preparation, in C11's order

test("prepare: check 8's lock, the domain from Chrome, the act window, rule 90, the cookies, the storage in a blank document, the act page, the act's rules, the fields, the order; the window lives until its end", async () => {
  const b = new PayBrowser();
  const p = ok(await prepare(b));
  assert.deepEqual(p.order, { lines: ["Zoo entry – adult × 2: $48.00", "Service fee: $3.00"], total: "51.00", currency: "$", delivery: { name: "Ann Example", email: "ann@example.com" } });
  assert.equal(p.domain, "example.com");
  assert.equal("providerOrigin" in p, false, "the act page is the merchant's own");
  assert.ok(p.act instanceof PayActWindow);
  const w = p.act as PayActWindow;
  // The order of C11: no receiver request before the domain; the block before the copy, the copy before the storage.
  const at = (what: string) => { const i = b.first(what); assert.ok(i >= 0, `no ${what}`); return i; };
  assert.ok(at("agent Page.getFrameTree") < at("windows.create"), "the domain before the window");
  assert.ok(at("windows.create") < at("pay_merchant_block") && at("pay_merchant_block") < at("pay_cookies_copy") && at("pay_cookies_copy") < at("agent DOMStorage.getDOMStorageItems"));
  assert.ok(b.calls.slice(0, at("agent Page.getFrameTree")).every((c) => c.lock === "act"), "the lock first");
  assert.equal(b.calls[at("windows.create")].detail[2], "act", "C10's act window with the mark act");
  assert.deepEqual(b.calls[at("windows.create")].detail[0], { url: "about:blank", focused: false, incognito: true });
  assert.ok(at("moveOff") < at("pay_merchant_block"), "outside the screen before the merchant's session");
  assert.deepEqual(b.calls[at("pay_merchant_block")].detail, { tab: ACT_TAB, domain: "example.com", on: true });
  assert.deepEqual(b.calls[at("pay_cookies_copy")].detail, { tab: ACT_TAB, domain: "example.com" });
  assert.deepEqual(b.calls[at("agent DOMStorage.getDOMStorageItems")].detail, { storageId: { securityOrigin: SHOP, isLocalStorage: true } });
  // The storage: a blank document of the origin that the act's Fetch answered, the write there, then the act page.
  const navs = b.calls.filter((c) => c.what === "navigate").map((c) => c.detail as string);
  assert.equal(navs.length, 2);
  assert.match(navs[0], /^https:\/\/shop\.example\.com\/__agentwatch_pay_[0-9a-f]{16}__$/);
  assert.equal(navs[1], `${SHOP}/checkout?cart=1`, "the act tab loads the agent tab's URL");
  const fulfil = b.calls.find((c) => c.what === "Fetch.fulfillRequest")!;
  assert.equal(fulfil.detail.body, '<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><title>agentwatch</title>');
  assert.deepEqual(fulfil.detail.headers, [{ name: "Content-Type", value: "text/html; charset=utf-8" }, { name: "Cache-Control", value: "no-store" }]);
  const write = b.calls.find((c) => c.what === "write")!;
  assert.deepEqual(write.detail, { url: navs[0], at: navs[0], n: STORAGE.length }, "the write ran on the blank document");
  assert.ok(at("write") < b.calls.findIndex((c) => c.what === "navigate" && c.detail === navs[1]), "the write before the act page's load");
  assert.deepEqual(b.local.get(SHOP), STORAGE, "the act's localStorage holds the agent tab's items");
  assert.equal(b.calls.filter((c) => c.what.startsWith("agent ")).map((c) => c.what).join(","), "agent Page.getFrameTree,agent DOMStorage.getDOMStorageItems", "no page script in the agent's tab");
  // The act's rules after the act page, before the fields: the origin, the providers' origins, the domain's origins that the page used.
  assert.ok(b.calls.findIndex((c) => c.what === "navigate" && c.detail === navs[1]) < at("act_rules") && at("act_rules") < at("fields"));
  assert.deepEqual(b.calls[at("act_rules")].detail.origin, SHOP);
  assert.deepEqual(b.sendTo, [SHOP, ...PROVIDER_ORIGINS, "https://api.shop.example.com"], "no host of another domain (cdn.other-host.net)");
  assert.ok(b.sendTo!.length <= MAX_SEND_TO);
  // The act tab: hidden, the service's own session, Fetch on, the frames attached (flatten) and run.
  assert.ok(b.calls.some((c) => c.what === "hide" && c.detail === ACT_TAB));
  assert.deepEqual(b.calls.find((c) => c.what === "autoAttach")!.detail, { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  assert.ok(b.calls.some((c) => c.what === "child Runtime.runIfWaitingForDebugger"));
  assert.deepEqual(w.fields, { number: { frame: 1, field: 0 }, expiry: { frame: 1, field: 1 }, csc: { frame: 1, field: 2 }, postal: { frame: 1, field: 3 } });
  assert.deepEqual(w.frames.map((f) => [f.origin, f.main, f.session ?? null]), [[SHOP, true, null], [STRIPE, false, "S-PF1"]]);
  assert.equal(b.count("Input.insertText") + b.count("Input.dispatchKeyEvent"), 0, "no key");
  // The window lives until its end: rule 90 and the lock hold; the end is the clean end, once.
  assert.equal(b.rule90, "example.com");
  assert.equal(b.lock.held(), "act");
  assert.equal(b.actEnds, 0);
  const e1 = w.end(), e2 = w.end();
  assert.equal(e1, e2, "a second end is the first");
  await e1;
  ended(b, true, "the end");
  assert.ok(b.historyCleared && !b.fetchOn, "the history cleared and Fetch off before act_end");
  assert.ok(b.first("resetHistory") < b.first("act_end") && b.first("fetchOff") < b.first("act_end"));
  for (const l of b.logs) for (const v of [...STORAGE.flat(), "/checkout", "cart=1"]) assert.ok(!l.includes(v), `no storage item or path in the log: ${l}`);
});

test("prepare: a provider's hosted payment page (the agent's tab and the act page on checkout.stripe.com) gives providerOrigin; its domain is the hosted page's", async () => {
  const b = new PayBrowser();
  const hosted = "https://checkout.stripe.com/c/pay/cs_test_x";
  b.agentUrl = hosted;
  b.agentDomain = "stripe.com";
  b.pages.set(hosted, checkoutPage({ fields: CARD_FIELDS, frames: [], requests: [] }));
  const p = ok(await prepare(b, {}, requestView({ tab: { id: AGENT_TAB, url: hosted } })));
  assert.equal(p.providerOrigin, "https://checkout.stripe.com");
  assert.equal(p.domain, "stripe.com");
  assert.deepEqual(b.calls.find((c) => c.what === "agent DOMStorage.getDOMStorageItems")!.detail.storageId.securityOrigin, "https://checkout.stripe.com");
  assert.equal(b.sendTo![0], SHOP, "act_rules' origin is the request's origin");
  await p.act!.end();
  ended(b, true, "hosted");
});

// ---------------------------------------------------------------- b. the merchant's registrable domain

test("b: the merchant's registrable domain is Chrome's domainAndRegistry; a public suffix (empty), an IP literal or a value that is not the host's stops before any receiver request; a loopback test host is its own domain", async () => {
  assert.equal(merchantDomain("shop.example.com", "example.com"), "example.com");
  assert.equal(merchantDomain("example.co.uk", "example.co.uk"), "example.co.uk");
  assert.equal(merchantDomain("ann.github.io", "ann.github.io"), "ann.github.io");
  for (const [host, chrome] of [["co.uk", ""], ["github.io", ""], ["192.0.2.10", "192.0.2.10"], ["[2001:db8::1]", "2001:db8::1"], ["shop.example.com", "other.com"], ["shop.example.com", "com"], ["shop.example.com", undefined], ["localhost", ""], ["127.0.0.1", ""]] as const) {
    assert.equal(merchantDomain(host, chrome), null, `${host} ${String(chrome)}`);
  }
  assert.equal(merchantDomain("shop.localhost", ""), "shop.localhost", "a loopback test host");
  assert.equal(merchantDomain("pay.shop.localhost", "x"), "pay.shop.localhost");
  // In the preparation: the stop, no receiver request, no window, the lock free.
  const cases: { url: string; domain: unknown }[] = [
    { url: "https://github.io/checkout", domain: "" },
    { url: "https://co.uk/checkout", domain: "" },
    { url: "https://192.0.2.10/checkout", domain: "192.0.2.10" },
  ];
  for (const c of cases) {
    const b = new PayBrowser();
    b.agentUrl = c.url;
    b.agentDomain = c.domain;
    const origin = new URL(c.url).origin;
    const p = await prepare(b, {}, requestView({ origin, tab: { id: AGENT_TAB, url: c.url } }));
    assert.deepEqual(p, { stop: "The agent browser could not copy the checkout's session.", blocked: 0, guarded: 0 }, c.url);
    assert.equal(b.count("pay_cookies_copy") + b.count("pay_merchant_block") + b.count("act_rules") + b.count("windows.create"), 0, `${c.url}: no receiver request, no window`);
    ended(b, false, c.url);
  }
  // The agent's tab left the origin since check 6, or Chrome cannot read it: the same stop.
  const moved = new PayBrowser();
  moved.agentUrl = "https://other.example.net/";
  assert.equal((await prepare(moved) as { stop: string }).stop, PAY_TEXT.copy);
  assert.equal(moved.count("windows.create") + moved.count("pay_merchant_block"), 0);
  const unread = new PayBrowser();
  unread.agentFails.add("Page.getFrameTree");
  assert.equal((await prepare(unread) as { stop: string }).stop, PAY_TEXT.copy);
  ended(unread, false, "unread");
  // A loopback test origin: the domain is the host (Chrome's list has no localhost), with the test provider.
  const loop = new PayBrowser();
  const shop = "http://shop.localhost:8080", url = `${shop}/checkout`;
  loop.agentUrl = url;
  loop.agentDomain = "";
  loop.pages.set(url, checkoutPage({ frames: [{ id: "PF1", url: "https://pay.localhost/fields", fields: CARD_FIELDS, oop: true }], requests: [`${shop}/app.js`] }));
  const p = ok(await prepare(loop, { providerOrigins: ["https://pay.localhost"] }, requestView({ origin: shop, tab: { id: AGENT_TAB, url } })));
  assert.equal(p.domain, "shop.localhost");
  assert.deepEqual(loop.calls.find((c) => c.what === "pay_merchant_block")!.detail.domain, "shop.localhost");
  assert.ok(loop.sendTo!.includes("https://pay.localhost"));
  await p.act!.end();
  ended(loop, true, "loopback");
});

// ---------------------------------------------------------------- a. check 8

test("a: check 8: another holder of the one private window for the busy time gives C11's busy text with noRequest, and nothing goes", async () => {
  const b = new PayBrowser();
  const other = await b.lock.act(1000);
  const p = await prepare(b, { limits: { busyMs: 60 } });
  assert.deepEqual(p, { stop: "Another payment or sign-in runs now. Try again in a minute.", noRequest: true, blocked: 0, guarded: 0 });
  assert.equal(b.calls.length, 0, "no call at all");
  other!();
  assert.equal(b.lock.held(), null);
  // A wait that ends in time: the request goes on when the holder releases.
  const holder = await b.lock.act(1000);
  setTimeout(() => holder!(), 30);
  const q = ok(await prepare(b, { limits: { busyMs: 500 } }));
  await q.act!.end();
  ended(b, true, "after a wait");
});

// ---------------------------------------------------------------- c to f: each stop has its text, and the window ends

test("c to f: each step that fails stops with C11's text; the act window ends (act_end once when it opened), no rule 90 stays, the lock is free", async () => {
  type Case = { what: string; set: (b: PayBrowser) => void; text: string; opened: boolean; domain?: boolean };
  const cases: Case[] = [
    { what: "another private window", set: (b) => { b.windowError = "another private window is open"; }, text: PAY_TEXT.privateWindow, opened: false },
    { what: "windows.create fails", set: (b) => { b.windowError = "bad args"; }, text: PAY_TEXT.noWindow, opened: false },
    { what: "no feature pay (an older receiver)", set: (b) => { b.features = new Set(["scopes", "act", "fetch"]); }, text: PAY_TEXT.noWindow, opened: false },
    { what: "the window stays on the screen", set: (b) => { b.movesOff = false; }, text: PAY_TEXT.noWindow, opened: true },
    { what: "pay_merchant_block refused", set: (b) => { b.blockAnswer = () => ({ error: "bad request" }); }, text: PAY_TEXT.rules, opened: true },
    { what: "pay_merchant_block: rule 90 not held", set: (b) => { b.blockAnswer = () => ({ rules: [] }); }, text: PAY_TEXT.rules, opened: true },
    { what: "pay_merchant_block: no answer", set: (b) => { b.blockAnswer = () => ({ late: true }); }, text: PAY_TEXT.rules, opened: true },
    { what: "pay_cookies_copy fails", set: (b) => { b.cookiesAnswer = () => ({ error: "cookies failed" }); }, text: PAY_TEXT.copy, opened: true, domain: true },
    { what: "pay_cookies_copy: no count", set: (b) => { b.cookiesAnswer = () => ({ cookies: [] }); }, text: PAY_TEXT.copy, opened: true, domain: true },
    { what: "the storage read fails", set: (b) => { b.agentFails.add("DOMStorage.getDOMStorageItems"); }, text: PAY_TEXT.copy, opened: true, domain: true },
    { what: "the storage read has another shape", set: (b) => { b.agentStorage = [["k", 1]]; }, text: PAY_TEXT.copy, opened: true, domain: true },
    { what: "the blank document's answer fails", set: (b) => { b.fulfillFails = true; }, text: PAY_TEXT.copy, opened: true, domain: true },
    { what: "the storage write fails", set: (b) => { b.writeAnswer = () => ({ ok: false, n: 0 }); }, text: PAY_TEXT.copy, opened: true, domain: true },
    { what: "the storage write writes fewer items", set: (b) => { b.writeAnswer = () => ({ ok: true, n: 1 }); }, text: PAY_TEXT.copy, opened: true, domain: true },
    { what: "the act page does not load", set: (b) => { b.pages.set(`${SHOP}/checkout?cart=1`, checkoutPage({ noLoad: true })); }, text: PAY_TEXT.noPaymentStep, opened: true, domain: true },
    { what: "act_rules refused", set: (b) => { b.rulesAnswer = () => ({ error: "rules not held" }); }, text: PAY_TEXT.rules, opened: true, domain: true },
    { what: "act_rules: no rule", set: (b) => { b.rulesAnswer = () => ({ rules: [] }); }, text: PAY_TEXT.rules, opened: true, domain: true },
    { what: "the act page on another origin", set: (b) => { b.pages.set(`${SHOP}/checkout?cart=1`, checkoutPage({ redirect: "https://login.other-host.net/sign-in" })); }, text: PAY_TEXT.noPaymentStep, opened: true, domain: true },
    { what: "no card fields (an empty cart)", set: (b) => { b.pages.set(`${SHOP}/checkout?cart=1`, checkoutPage({ frames: [], lines: ["Your cart is empty"] })); }, text: PAY_TEXT.noPaymentStep, opened: true, domain: true },
    { what: "a sign-in page with no card fields", set: (b) => { b.pages.set(`${SHOP}/checkout?cart=1`, checkoutPage({ frames: [], fields: [field(0, { type: "email", autocomplete: "username" }), field(1, { type: "password" })] })); }, text: PAY_TEXT.noPaymentStep, opened: true, domain: true },
    { what: "card fields on the merchant's own page", set: (b) => { b.pages.set(`${SHOP}/checkout?cart=1`, checkoutPage({ frames: [], fields: [...CARD_FIELDS] })); }, text: PAY_TEXT.fields, opened: true, domain: true },
    { what: "card fields by label on the merchant's own page", set: (b) => { b.pages.set(`${SHOP}/checkout?cart=1`, checkoutPage({ fields: [field(0, { label: "card number" })] })); }, text: PAY_TEXT.fields, opened: true, domain: true },
    { what: "card fields in a frame that is not a provider's", set: (b) => { b.pages.set(`${SHOP}/checkout?cart=1`, checkoutPage({ frames: [{ id: "PF1", url: "https://fields.not-a-provider.net/card", fields: CARD_FIELDS, oop: true }] })); }, text: PAY_TEXT.fields, opened: true, domain: true },
    { what: "card fields in a same-origin frame", set: (b) => { b.pages.set(`${SHOP}/checkout?cart=1`, checkoutPage({ frames: [{ id: "SF1", url: `${SHOP}/card-frame`, fields: CARD_FIELDS, oop: false }] })); }, text: PAY_TEXT.fields, opened: true, domain: true },
    { what: "a captcha at the payment step", set: (b) => { b.pages.set(`${SHOP}/checkout?cart=1`, checkoutPage({ check: { frames: [{ src: "https://newassets.hcaptcha.com/captcha/v1/x", visible: true }] } })); }, text: PAY_TEXT.check, opened: true, domain: true },
    { what: "a sign-in at the payment step", set: (b) => { b.pages.set(`${SHOP}/checkout?cart=1`, checkoutPage({ fields: [...SHOP_FIELDS_WITH(field(2, { type: "password" }))] })); }, text: PAY_TEXT.check, opened: true, domain: true },
    { what: "a phone code at the payment step", set: (b) => { b.pages.set(`${SHOP}/checkout?cart=1`, checkoutPage({ fields: [...SHOP_FIELDS_WITH(field(2, { autocomplete: "one-time-code" }))] })); }, text: PAY_TEXT.check, opened: true, domain: true },
    { what: "a popup at the act page's load", set: (b) => { b.pages.set(`${SHOP}/checkout?cart=1`, checkoutPage({ popup: true })); }, text: PAY_TEXT.noPaymentStep, opened: true, domain: true },
    { what: "no total on the act page", set: (b) => { b.pages.set(`${SHOP}/checkout?cart=1`, checkoutPage({ lines: ["Zoo entry: $48.00", "Service fee: $3.00"] })); }, text: PAY_TEXT.noTotal, opened: true, domain: true },
  ];
  for (const c of cases) {
    const b = new PayBrowser();
    c.set(b);
    const p = await prepare(b);
    assert.ok("stop" in p, `${c.what}: ${JSON.stringify(p)}`);
    assert.equal(p.stop, c.text, c.what);
    assert.equal("noRequest" in p, false, `${c.what}: a request`);
    assert.equal(p.domain, c.domain ? "example.com" : undefined, `${c.what}: the block's line only after rule 90 held`);
    assert.equal("act" in p, false, `${c.what}: no window in the answer`);
    ended(b, c.opened, c.what);
    assert.equal(b.count("Input.insertText") + b.count("Input.dispatchKeyEvent"), 0, `${c.what}: no key`);
  }
});

const SHOP_FIELDS_WITH = (f: ReturnType<typeof field>) => [field(0, { autocomplete: "email", type: "email" }), field(1, { autocomplete: "shipping postal-code" }), f];

test("c: a lost act tab during the preparation stops with C11's lost text, and act_end still goes", async () => {
  const b = new PayBrowser();
  b.onCall = (what) => { if (what === "act_rules") { b.onCall = () => {}; b.emit({ t: "ev", ch: "bridge", ev: "debugger.onDetach", source: { tabId: ACT_TAB }, reason: "target_closed" }); } };
  const p = await prepare(b);
  assert.equal((p as { stop: string }).stop, "The agent browser lost the payment window before the payment.");
  ended(b, true, "lost");
});

test("c: an act_end that fails twice leaves its end to the window's next holder, which sends act_end before it gets the window (no rule 90 stays)", async () => {
  const b = new PayBrowser();
  const p = ok(await prepare(b));
  let fails = 2;
  b.endAnswer = () => (fails-- > 0 ? { error: "act not closed" } : { closed: 0 });
  await p.act!.end();
  assert.equal(b.actEnds, 2);
  assert.ok(b.logs.some((l) => l.includes("act_end failed twice")), b.logs.join("\n"));
  const next = await b.lock.act(1000);
  assert.equal(b.actEnds, 3, "the next holder's turn ends the left act first");
  assert.equal(b.rule90, null);
  next!();
});

// ---------------------------------------------------------------- the abort

test("the abort (the agent's cancel, the service's stop) ends the preparation at each step, and ends the act window: act_end once when it opened, no rule 90, the lock free", async () => {
  const points: [string, boolean][] = [["agent Page.getFrameTree", false], ["windows.create", true], ["pay_merchant_block", true], ["pay_cookies_copy", true], ["agent DOMStorage.getDOMStorageItems", true],
    ["write", true], ["act_rules", true], ["fields", true], ["check", true], ["order", true]];
  for (const [at, opened] of points) {
    const b = new PayBrowser();
    const ac = new AbortController();
    b.onCall = (what) => { if (what === at) ac.abort(); };
    const p = await prepare(b, {}, requestView(), ac.signal);
    assert.equal((p as { stop: string }).stop, PAY_TEXT.cancelled, at);
    ended(b, opened, at);
  }
  // During check 8's wait: the turn, when it comes, goes at once.
  const b = new PayBrowser();
  const holder = await b.lock.act(1000);
  const ac = new AbortController();
  const p = prepare(b, { limits: { busyMs: 1000 } }, requestView(), ac.signal);
  setTimeout(() => ac.abort(), 20);
  assert.equal((await p as { stop: string }).stop, PAY_TEXT.cancelled);
  holder!();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(b.lock.held(), null, "the late turn went at once");
  assert.equal(b.calls.length, 0);
  // While the act page loads (an abort between the events).
  const c = new PayBrowser();
  c.pages.set(`${SHOP}/checkout?cart=1`, checkoutPage({ noLoad: true }));
  const ac2 = new AbortController();
  c.onCall = (what) => { if (what === "navigate" && c.count("navigate") === 2) setTimeout(() => ac2.abort(), 20); };
  assert.equal((await prepare(c, {}, requestView(), ac2.signal) as { stop: string }).stop, PAY_TEXT.cancelled);
  ended(c, true, "the act page's load");
});

// ---------------------------------------------------------------- PayRequests with the real preparation: each end ends the window

/** The card payments' part (pay-fakes.ts) whose preparation is the real one over a PayBrowser. */
async function payWithWindow(o: { waitMs?: number; limits?: Parameters<PayBrowser["prepare"]>[0] } = {}) {
  const { payWorld, withCard } = await import("./pay-fakes.ts");
  const b = new PayBrowser();
  b.pages.set(`${SHOP}/checkout?cart=2`, checkoutPage());
  const prep = b.prepare(o.limits);
  const w = payWorld({ waitMs: o.waitMs, cardPay: { prepare: (req, card, signal) => prep.prepare(req, card, signal) } });
  await withCard(w);
  return { b, w };
}

test("each end of a request without an act ends its act window once: the refusal, the expiry, a mismatch, a cancel (waiting and preparing), the service's stop (waiting and preparing), another total; act_end once, the lock free, no rule 90; the answer comes after the end", async () => {
  const { approvalSeal, evs, PAY, SCOPE_A } = await import("./pay-fakes.ts");
  const local = (signal?: AbortSignal) => ({ scope: SCOPE_A, admission: "local" as const, ...(signal ? { signal } : {}) });
  /** Start a call; wait for its pay_request, then end it by `how`; check the end and the answer's time. */
  const ends: [string, (w: any, ev: any, ac: AbortController) => void, string][] = [
    ["the operator's refusal", (w, ev) => w.part.pay.approve(ev.id, approvalSeal(w, ev, "refuse"), "operator"), PAY_TEXT.refused],
    ["a mismatch", (w, ev) => w.part.pay.approve(ev.id, approvalSeal(w, ev, "approve", { fields: { amount: "1.00" } }), "operator"), PAY_TEXT.mismatch],
    ["the agent's cancel while it waits", (_w, _ev, ac) => ac.abort(), PAY_TEXT.cancelled],
    ["the service's stop while it waits", (w) => w.part.pay.stop(), PAY_TEXT.lostBefore],
  ];
  for (const [what, how, text] of ends) {
    const { b, w } = await payWithWindow();
    try {
      const ac = new AbortController();
      let endsAtAnswer = -1;
      const call = w.part.pay!.open(PAY, local(ac.signal)).then((r) => { endsAtAnswer = b.actEnds; return r; });
      const { until } = await import("./pay-fakes.ts");
      await until(() => evs(w, "pay_request").length === 1, `${what}: the pay_request`);
      assert.equal(b.rule90, "example.com", `${what}: rule 90 holds while the operator approves`);
      assert.equal(b.lock.held(), "act", `${what}: the one private window is held`);
      how(w, evs(w, "pay_request")[0], ac);
      const r = await call;
      assert.equal(r.text, text, what);
      assert.equal(endsAtAnswer, 1, `${what}: the answer comes after act_end`);
      assert.ok(r.answer.endsWith("\nYour tabs could not reach example.com from the copy of the checkout to the end of the payment."), `${what}: the block's line`);
      await new Promise((res) => setTimeout(res, 20));
      ended(b, true, what);
    } finally { w.close(); }
  }
  // The expiry (a short wait).
  {
    const { b, w } = await payWithWindow({ waitMs: 80 });
    try {
      const r = await w.part.pay!.open(PAY, local());
      assert.equal(r.text, PAY_TEXT.expired);
      ended(b, true, "the expiry");
    } finally { w.close(); }
  }
  // Another total: the preparation's order is not the amount (no pay_request), and the window ends.
  {
    const { b, w } = await payWithWindow();
    try {
      const r = await w.part.pay!.open({ ...PAY, amount: "50.00" }, local());
      assert.equal(r.text, "The checkout's total is not 50.00 USD.");
      assert.equal(evs(w, "pay_request").length, 0);
      ended(b, true, "another total");
    } finally { w.close(); }
  }
  // A cancel and the service's stop during the preparation: the preparation ends its own window.
  for (const what of ["cancel", "stop"] as const) {
    const { b, w } = await payWithWindow();
    try {
      const ac = new AbortController();
      b.onCall = (c) => { if (c === "act_rules") { b.onCall = () => {}; if (what === "cancel") ac.abort(); else w.part.pay!.stop(); } };
      const r = await w.part.pay!.open(PAY, local(ac.signal));
      assert.equal(r.text, what === "cancel" ? PAY_TEXT.cancelled : PAY_TEXT.lostBefore);
      await new Promise((res) => setTimeout(res, 30));
      ended(b, true, `a ${what} during the preparation`);
      assert.equal(evs(w, "pay_request").length, 0);
    } finally { w.close(); }
  }
});

test("after the approval the act gets the prepared window (PayActContext.prepared); the request's end ends it once, also when the act ended it itself; a second request waits for the one private window and gets the busy text", async () => {
  const { approvalSeal, evs, PAY, SCOPE_A, SCOPE_B, until } = await import("./pay-fakes.ts");
  const { b, w } = await payWithWindow({ limits: { limits: { busyMs: 100 } } });
  try {
    let seen: unknown = null;
    w.actDoes = async (ctx) => {
      seen = ctx.prepared;
      assert.equal(b.rule90, "example.com", "rule 90 still holds in the act");
      await ctx.prepared!.end();
      return { state: "declined", text: PAY_TEXT.declined };
    };
    const call = w.part.pay!.open(PAY, { scope: SCOPE_A, admission: "local" });
    await until(() => evs(w, "pay_request").length === 1, "the pay_request");
    // Another scope's request waits for the one private window, which the first holds while the operator approves.
    const other = await w.part.pay!.open(PAY, { scope: SCOPE_B, admission: "local" });
    assert.equal(other.text, "Another payment or sign-in runs now. Try again in a minute.");
    assert.equal(b.count("windows.create"), 1);
    const ev = evs(w, "pay_request")[0];
    w.part.pay!.approve(ev.id, approvalSeal(w, ev, "approve"), "operator");
    const r = await call;
    assert.equal(r.text, PAY_TEXT.declined);
    assert.ok(seen instanceof PayActWindow, "the act's context holds the window");
    ended(b, true, "after the act");
    // The act that never ends its window: the request's end does.
    w.actDoes = async () => ({ state: "stopped", text: PAY_TEXT.noButton });
    const second = w.part.pay!.open(PAY, { scope: SCOPE_A, admission: "local" });
    await until(() => evs(w, "pay_request").length === 2, "the second pay_request");
    const ev2 = evs(w, "pay_request")[1];
    w.part.pay!.approve(ev2.id, approvalSeal(w, ev2, "approve"), "operator");
    assert.equal((await second).text, PAY_TEXT.noButton);
    assert.equal(b.actEnds, 2);
    assert.equal(b.rule90, null);
    assert.equal(b.lock.held(), null);
  } finally { w.close(); }
});
