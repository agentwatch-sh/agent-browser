// The card payment's requests (contract C11, the card payment: the checks 1 to 7, the request, the approval, the texts,
// the keep; C12, the card payments: `pay_approve`, `pay_request`, `pay_result`, `pay`; the secure card checkout design,
// sections 7 and 8.7; board ab-sta.5, the plan's Task 4 and its Review Focus). The real store with a card that the real
// `card_seal` sealed, the operator's approvals as real seals of the purpose `browser-pay`, and fakes of the plan's
// Task 5 (the facts of the model, the page's preparation, the act). TEST values only (pay-test-cards.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkRequest } from "../src/service/control.ts";
import { KEEP_FILE } from "../src/service/pay/keep.ts";
import { AMOUNT, APPROVE_TEXT, PayRequests } from "../src/service/pay/request.ts";
import { PAY_TEXT } from "../src/service/pay/texts.ts";
import { SERVICE_TOOLS } from "../src/service/mcp/allow-list.ts";
import { approvalSeal, cardForm, CHECKOUT, control, evs, ORIGIN, PAY, payWorld, SCOPE_A, SCOPE_B, setUp, T0, TOKEN, DAEMON, until, withCard, type PayWorld } from "./pay-fakes.ts";
import { TEST_CARD_VALUES, TEST_CARDS } from "./pay-test-cards.ts";

const C11 = readFileSync(new URL("../docs/contracts/C11.md", import.meta.url), "utf8");
const local = (scope = SCOPE_A, signal?: AbortSignal) => ({ scope, admission: "local" as const, ...(signal ? { signal } : {}) });
const pay = (w: PayWorld) => w.part.pay!;
/** Start a call; wait for its pay_request (or its end). */
async function request(w: PayWorld, input: Record<string, unknown> = PAY, scope = SCOPE_A, signal?: AbortSignal) {
  const before = evs(w, "pay_request").length;
  let ended = false;
  const call = pay(w).open(input, local(scope, signal)).finally(() => { ended = true; });
  await until(() => ended || evs(w, "pay_request").length > before, "a pay_request or the end");
  return { call, ev: evs(w, "pay_request").at(-1) };
}

// ---------------------------------------------------------------- the texts are C11's

test("PAY_TEXT is C11's table, word for word: each text of the code is a row's text", () => {
  const p = C11.slice(C11.indexOf("**The card payment (board goal ab-sta"));
  const rows = p.split("\n").filter((l) => l.startsWith("| ") && l.split(" | ").length === 3).map((l) => l.slice(2, -2).split(" | ")[2].replace(/^`|`$/g, ""));
  const fill = (t: string) => t.replace(/<[a-z]+>/g, "X");
  const filled = new Set(rows.map(fill));
  for (const [k, v] of Object.entries(PAY_TEXT)) {
    const text = typeof v === "string" ? v : (v as (...a: string[]) => string)("X", "X", "X", "X");
    if (k === "key") { for (const key of ["card", "origin", "button"] as const) assert.ok(rows.includes(`The <key> of the payment request is not valid.`) && PAY_TEXT.key(key) === `The ${key} of the payment request is not valid.`); continue; }
    assert.ok(filled.has(text), `${k}: ${text}`);
  }
  assert.ok(C11.includes("`Your tabs could not reach <domain> from the copy of the checkout to the end of the payment.`"));
  // The amount's form is the allow list's pattern (C11, the keys).
  assert.equal(AMOUNT.source.replaceAll("(?:", "("), (SERVICE_TOOLS.browser_pay.schema as any).properties.amount.pattern);
});

// ---------------------------------------------------------------- checks 1 to 7, in order

test("C11's checks 1 to 7 in their order, each with its text; a refusal starts no request, sends no event and is not kept", async () => {
  const w = payWorld();
  try {
    const stop = async (input: Record<string, unknown>, caller: any = local()) => {
      const r = await pay(w).open(input, caller);
      assert.equal(r.state, "stopped");
      assert.equal(r.isError, true);
      assert.equal(r.answer, `Not paid: ${r.text}`);
      return r.text;
    };
    // Check 1: a remote admission, then the readiness.
    assert.equal(await stop(PAY, { scope: SCOPE_A, admission: "remote" }), PAY_TEXT.remote);
    w.facts.notReady = "The agent browser is not ready: its extension is not connected.";
    assert.equal(await stop(PAY), "The agent browser is not ready: its extension is not connected.");
    w.facts.notReady = null;
    // Check 2: each key.
    assert.equal(await stop({ ...PAY, card: "Not A Name!" }), "The card of the payment request is not valid.");
    assert.equal(await stop({ ...PAY, origin: "https://shop.example.com/checkout" }), "The origin of the payment request is not valid.");
    assert.equal(await stop({ ...PAY, origin: "http://shop.example.com" }), "The origin of the payment request is not valid.");
    for (const amount of ["0", "0.00", "-1", "1.234", "1,00", "", 12, "01.00"]) assert.equal(await stop({ ...PAY, amount }), PAY_TEXT.amount, String(amount));
    for (const currency of ["usd", "US", "USDT", 1]) assert.equal(await stop({ ...PAY, currency }), PAY_TEXT.currency, String(currency));
    assert.equal(await stop({ ...PAY, description: "x".repeat(501) }), PAY_TEXT.description);
    assert.equal(await stop({ ...PAY, description: undefined }), PAY_TEXT.description);
    assert.equal(await stop({ ...PAY, button: "x".repeat(101) }), "The button of the payment request is not valid.");
    // Check 3: the store is open (no snapshot, not set up, locked).
    assert.equal(await stop(PAY), PAY_TEXT.locked);
    const { key, file } = await withCard(w);
    await w.ask("sign_ins_lock", {}, DAEMON);
    assert.equal(await stop(PAY), "The stored sign-ins and cards are locked. The operator unlocks them in the Browser pane.");
    // Check 4: a card of the name; a sign-in of that name is no card; a card that does not open.
    const w2 = payWorld();
    try {
      const signIn = { v: 1, id: "c-0000000a", gen: 1, name: "staging", origin: ORIGIN, path: "/login", send_to: [ORIGIN], repos: null, by: "operator", approved: true, state: "usable", added: null, changed: null, sealed: { epk: "AA", iv: "AA", ct: "AA", tag: "AA" } };
      const { key: key2, file: file2 } = await withCard(w2, cardForm(), [signIn]);
      assert.equal(await pay(w2).open({ ...PAY, card: "staging" }, local()).then((r) => r.text), "There is no stored card named staging.");
      assert.equal(await pay(w2).open({ ...PAY, card: "other" }, local()).then((r) => r.text), "There is no stored card named other.");
      // A card whose seal is changed does not open.
      const bad = { ...file2, sealed: { ...file2.sealed, tag: file2.sealed.iv.padEnd(22, "A").slice(0, 22) } };
      await w2.ask("sign_ins", { key: key2, records: [signIn, bad] }, DAEMON);
      assert.equal(await pay(w2).open(PAY, local()).then((r) => r.text), PAY_TEXT.cardCannotOpen);
      // A card's record with a sign-in's AD (no kind) is no card at all.
      const noKind = { ...file2 } as Record<string, unknown>;
      delete noKind.kind;
      await w2.ask("sign_ins", { key: key2, records: [noKind] }, DAEMON);
      assert.equal(await pay(w2).open(PAY, local()).then((r) => r.text), "There is no stored card named travel.");
    } finally { w2.close(); }
    // Unlock again: the set-up's key, the passphrase.
    const { formSeal, PASSPHRASE } = await import("./pay-fakes.ts");
    assert.deepEqual(await w.ask("sign_ins_unlock", { sealed: formSeal(w, "sign_ins_unlock", { passphrase: PASSPHRASE }) }), { data: {} });
    void key; void file;
    // Check 5: the scope's list covers the origin's host.
    w.facts.covers = false;
    assert.equal(await stop(PAY), "Not allowed: shop.example.com is not on the allowlist");
    w.facts.covers = true;
    // Check 6: exactly one tab of the origin, or of a known provider's hosted payment page.
    const tabs = w.facts.tabs[SCOPE_A];
    w.facts.tabs[SCOPE_A] = [];
    assert.equal(await stop(PAY), `Exactly one tab of this session must show the checkout of ${ORIGIN}.`);
    w.facts.tabs[SCOPE_A] = [...tabs, { id: 9, url: `${ORIGIN}/cart` }];
    assert.equal(await stop(PAY), `Exactly one tab of this session must show the checkout of ${ORIGIN}.`);
    w.facts.tabs[SCOPE_A] = [...tabs, { id: 9, url: "https://checkout.stripe.com/c/pay/x" }];
    assert.equal(await stop(PAY), `Exactly one tab of this session must show the checkout of ${ORIGIN}.`, "a provider's hosted page counts as a tab of the checkout");
    w.facts.tabs[SCOPE_A] = [{ id: 9, url: "https://checkout.stripe.com/c/pay/x" }, { id: 10, url: "https://other.example.com/" }];
    assert.equal(evs(w, "pay_request").length, 0);
    const viaProvider = await request(w);
    assert.equal(viaProvider.ev.origin, ORIGIN, "origin stays the merchant's origin");
    assert.equal(w.prepared.at(-1)!.req.tab.id, 9, "the agent's tab");
    // Check 7: no other payment request of the scope waits.
    assert.equal(await stop(PAY), PAY_TEXT.scopeWaits);
    // No event and no keep for the refusals: only the request that passed sent one.
    assert.equal(w.events.filter((e) => e.ev !== "sign_ins").length, 1);
    assert.equal(pay(w).status(SCOPE_A), '{"results":[]}');
    assert.ok(w.logs.some((l) => /^pay: request none: user \S+, scope web-1, repo agent-browser, card none, origin https:\/\/shop\.example\.com, amount 51\.00 USD, state stopped/.test(l)), "a log line of a refusal; a key of another form is not logged");
    pay(w).stop();
    await viaProvider.call;
  } finally { w.close(); }
});

test("Review Focus: two browser_pay calls of one scope at the same time: the second gets \"A payment request of this scope waits\"; another scope's call goes on", async () => {
  const w = payWorld();
  try {
    await withCard(w);
    let open!: () => void;
    w.page.gate = new Promise<void>((r) => { open = r; });
    const a = pay(w).open(PAY, local());
    const b = pay(w).open(PAY, local());
    const r = await b;
    assert.equal(r.text, "A payment request of this scope waits.");
    assert.equal(w.prepared.length, 1, "the second never reaches the preparation");
    const other = pay(w).open(PAY, local(SCOPE_B));
    await until(() => w.prepared.length === 2, "the other scope's preparation");
    open();
    await until(() => evs(w, "pay_request").length === 2, "both pay_requests");
    pay(w).stop();
    await Promise.all([a, other]);
  } finally { w.close(); }
});

// ---------------------------------------------------------------- the request and the pay_request

test("the request: the page's order, C12's pay_request (id, scope, origin, order with the request's total and currency, description, card, expires in 10 minutes, earlier), and the approval binds it", async () => {
  const w = payWorld();
  try {
    await withCard(w);
    const { call, ev } = await request(w);
    assert.deepEqual(Object.keys(ev).sort(), ["card", "description", "earlier", "ev", "expires", "id", "order", "origin", "scope", "t"]);
    assert.match(ev.id, /^[0-9a-f]{16}$/);
    assert.equal(ev.scope, SCOPE_A);
    assert.equal(ev.origin, ORIGIN);
    assert.deepEqual(ev.order, { lines: ["Zoo entry – adult × 2: $48.00", "Service fee: $3.00"], total: "51.00", currency: "USD", delivery: { name: "Ann Example", email: "ann@example.com" } });
    assert.equal(ev.description, PAY.description);
    assert.equal(ev.card, "travel");
    assert.equal(ev.expires, "2026-11-21T14:10:00Z");
    assert.deepEqual(ev.earlier, []);
    // The preparation got the request's view (no value of the card) and the card's view for the filter only.
    const p = w.prepared[0];
    assert.deepEqual({ ...p.req, id: "x" }, { id: "x", scope: SCOPE_A, origin: ORIGIN, amount: "51.00", currency: "USD", card: "travel", description: PAY.description, button: null, tab: { id: 7, url: `${ORIGIN}/checkout?cart=1` } });
    assert.ok(p.card.number.every((b) => b === 0) && p.card.expiry.every((b) => b === 0), "the card's view is zeros after the read");
    // The operator approves: the act runs once with the approved hash, and the call ends with its result.
    assert.deepEqual(pay(w).approve(ev.id, approvalSeal(w, ev, "approve"), "operator"), { data: {} });
    const r = await call;
    assert.equal(w.acts.length, 1);
    assert.equal(w.acts[0].order, (await import("./pay-fakes.ts")).hashOf(ev));
    assert.deepEqual(w.acts[0].approval, { at: T0, until: T0 + 10 * 60_000 }, "an approval good for one act within 10 minutes");
    assert.deepEqual({ ...r }, { state: "paid", text: `Paid: 51.00 USD to ${ORIGIN}, order SHOP-1001`, at: T0, origin: ORIGIN, answer: `Paid: 51.00 USD to ${ORIGIN}, order SHOP-1001`, isError: false });
    const results = evs(w, "pay_result");
    assert.deepEqual(results, [{ t: "ev", ev: "pay_result", id: ev.id, scope: SCOPE_A, origin: ORIGIN, state: "paid", text: r.text, at: "2026-11-21T14:00:00Z", alert: false }]);
  } finally { w.close(); }
});

test("a provider's hosted page gives provider_origin; a page with no delivery gives no delivery key; the session copy's line follows the agent's text", async () => {
  const w = payWorld();
  try {
    await withCard(w);
    w.page.lines = ["One concert ticket: $35.00", "Total: $35.00"];
    w.page.providerOrigin = "https://checkout.stripe.com";
    w.page.domain = "example.com";
    const { call, ev } = await request(w, { ...PAY, amount: "35", button: "Pay now" });
    assert.equal(ev.provider_origin, "https://checkout.stripe.com");
    assert.deepEqual(ev.order, { lines: ["One concert ticket: $35.00"], total: "35", currency: "USD" });
    assert.equal(w.prepared[0].req.button, "Pay now");
    pay(w).approve(ev.id, approvalSeal(w, ev, "refuse"), "operator");
    const r = await call;
    assert.equal(r.answer, "Not paid: The operator refused this payment.\nYour tabs could not reach example.com from the copy of the checkout to the end of the payment.");
  } finally { w.close(); }
});

test("a total that differs from the amount: \"The checkout's total is not <amount> <currency>.\", no pay_request and no pay_result; a page with two totals: cannot read the total", async () => {
  const w = payWorld();
  try {
    await withCard(w);
    const r = await pay(w).open({ ...PAY, amount: "50.00" }, local());
    assert.equal(r.answer, "Not paid: The checkout's total is not 50.00 USD.");
    const eur = await pay(w).open({ ...PAY, currency: "EUR" }, local());
    assert.equal(eur.text, "The checkout's total is not 51.00 EUR.");
    w.page.lines = ["Ticket: $51.00", "Total: $51.00", "Total: $54.00"];
    assert.equal((await pay(w).open(PAY, local())).text, "The agent browser cannot read the total of this checkout.");
    // A stop of the preparation (Task 5's texts) ends the request with its text; check 8's refusal is no request.
    w.page.stop = { stop: PAY_TEXT.noPaymentStep };
    assert.equal((await pay(w).open(PAY, local())).text, PAY_TEXT.noPaymentStep);
    w.page.stop = { stop: PAY_TEXT.busy, noRequest: true };
    assert.equal((await pay(w).open(PAY, local())).text, PAY_TEXT.busy);
    assert.equal(evs(w, "pay_request").length + evs(w, "pay_result").length, 0);
    // The request results are kept (not check 8's), the newest first.
    assert.deepEqual(JSON.parse(pay(w).status(SCOPE_A)).results.map((x: any) => x.text), [PAY_TEXT.noPaymentStep, PAY_TEXT.noTotal, "The checkout's total is not 51.00 EUR.", "The checkout's total is not 50.00 USD."]);
  } finally { w.close(); }
});

// ---------------------------------------------------------------- pay_approve

test("pay_approve: kind token or daemon gets \"not the operator\" (also at the control door), no act; the request still waits", async () => {
  const w = payWorld();
  try {
    await withCard(w);
    const { call, ev } = await request(w);
    for (const kind of ["token", "daemon"] as const) assert.deepEqual(pay(w).approve(ev.id, approvalSeal(w, ev, "approve"), kind), { error: "not the operator" });
    for (const by of [TOKEN, DAEMON]) assert.equal(checkRequest({ t: "req", id: "x", op: "pay_approve", by, request: ev.id, sealed: approvalSeal(w, ev, "approve") }, () => true), "not the operator");
    assert.equal(checkRequest({ t: "req", id: "x", op: "pay_approve", by: TOKEN, request: "PAY-1", sealed: approvalSeal(w, ev, "approve") }, () => true), "bad request", "the shape before the kind");
    assert.equal(w.acts.length, 0);
    assert.equal(pay(w).waiting(), 1);
    pay(w).approve(ev.id, approvalSeal(w, ev, "refuse"), "operator");
    assert.equal((await call).text, PAY_TEXT.refused);
  } finally { w.close(); }
});

test("pay_approve: a used id is refused; an unknown id is gone; the approval runs the act once", async () => {
  const w = payWorld();
  try {
    await withCard(w);
    let release!: () => void;
    w.actDoes = () => new Promise((r) => { release = () => r({ state: "declined", text: PAY_TEXT.declined }); });
    const { call, ev } = await request(w);
    assert.deepEqual(pay(w).approve(ev.id, approvalSeal(w, ev, "approve"), "operator"), { data: {} });
    await until(() => w.acts.length === 1, "the act");
    assert.deepEqual(pay(w).approve(ev.id, approvalSeal(w, ev, "approve"), "operator"), { error: APPROVE_TEXT.gone }, "during the act");
    release();
    const r = await call;
    assert.deepEqual([r.state, r.answer, r.isError], ["declined", PAY_TEXT.declined, true]);
    assert.deepEqual(pay(w).approve(ev.id, approvalSeal(w, ev, "approve"), "operator"), { error: "this payment request is gone" }, "after its end");
    assert.deepEqual(pay(w).approve("aaaabbbbccccdddd", approvalSeal(w, ev, "approve"), "operator"), { error: "this payment request is gone" });
    assert.equal(w.acts.length, 1);
  } finally { w.close(); }
});

test("Review Focus: an approval after its request expired is refused, and the expiry ends the request (10 minutes) with its pay_result; no act", async () => {
  const w = payWorld();
  try {
    await withCard(w);
    const { call, ev } = await request(w);
    w.clock.t = T0 + 10 * 60_000;
    assert.deepEqual(pay(w).approve(ev.id, approvalSeal(w, ev, "approve"), "operator"), { error: "this payment request is gone" });
    const r = await call;
    assert.equal(r.text, "The operator did not answer the payment request within 10 minutes.");
    assert.deepEqual(evs(w, "pay_result").map((e) => [e.id, e.state, e.text, e.at, e.alert]), [[ev.id, "stopped", r.text, "2026-11-21T14:10:00Z", false]]);
    assert.equal(w.acts.length, 0);
  } finally { w.close(); }
  // The expiry's timer (a short wait in the test).
  const w2 = payWorld({ waitMs: 20 });
  try {
    await withCard(w2);
    const { call } = await request(w2);
    assert.equal((await call).text, PAY_TEXT.expired);
    assert.equal(evs(w2, "pay_result").length, 1);
  } finally { w2.close(); }
});

test("Review Focus: an approval made for a request of another scope does not match: that request ends with C11's text and no act; the other one still waits", async () => {
  const w = payWorld();
  try {
    await withCard(w);
    const a = await request(w, PAY, SCOPE_A);
    const b = await request(w, PAY, SCOPE_B);
    assert.notEqual(a.ev.id, b.ev.id);
    assert.deepEqual(pay(w).approve(b.ev.id, approvalSeal(w, a.ev, "approve"), "operator"), { error: "this approval does not match the payment request" });
    const rb = await b.call;
    assert.deepEqual([rb.state, rb.text], ["stopped", "This approval does not match the payment request"]);
    assert.equal(w.acts.length, 0);
    assert.deepEqual(evs(w, "pay_result").map((e) => [e.id, e.text]), [[b.ev.id, PAY_TEXT.mismatch]]);
    assert.equal(pay(w).waiting(), 1, "A still waits");
    // Each binding field is bound: another origin, amount, currency, card or order does not match; nor the sign-in purpose.
    const changes: Record<string, string>[] = [{ origin: "https://other.example.com" }, { amount: "51" }, { currency: "CAD" }, { card: "other" }, { order: "0".repeat(64) }, { request: b.ev.id }];
    for (const fields of changes) {
      const c = await request(w, PAY, SCOPE_B);
      assert.deepEqual(pay(w).approve(c.ev.id, approvalSeal(w, c.ev, "approve", { fields }), "operator"), { error: APPROVE_TEXT.mismatch }, JSON.stringify(fields));
      assert.equal((await c.call).text, PAY_TEXT.mismatch);
    }
    const d = await request(w, PAY, SCOPE_B);
    assert.deepEqual(pay(w).approve(d.ev.id, approvalSeal(w, d.ev, "approve", { purpose: "browser-sign-in" }), "operator"), { error: APPROVE_TEXT.mismatch }, "the purpose browser-sign-in");
    await d.call;
    assert.equal(w.acts.length, 0);
    pay(w).approve(a.ev.id, approvalSeal(w, a.ev, "approve"), "operator");
    assert.equal((await a.call).state, "paid");
  } finally { w.close(); }
});

test("pay_approve's checks in C12's order: the snapshot and the state, the request, then the seal (its rid and at: the request still waits)", async () => {
  const w = payWorld();
  try {
    assert.deepEqual(pay(w).approve("aaaabbbbccccdddd", { text: "aw1:AA", sender: "AA==", rid: "x", at: "y" }, "operator"), { error: "the stored sign-ins have no snapshot yet" });
    await withCard(w);
    const { call, ev } = await request(w);
    // A stale seal, a seal of another form, a kept rid: the sealed value cannot be opened, and the request waits.
    const stale = approvalSeal(w, ev, "approve", { at: "2026-11-21T13:57:59Z" });
    assert.deepEqual(pay(w).approve(ev.id, stale, "operator"), { error: "the sealed value cannot be opened" });
    assert.deepEqual(pay(w).approve(ev.id, { ...approvalSeal(w, ev, "approve"), rid: "short" }, "operator"), { error: "the sealed value cannot be opened" });
    const once = approvalSeal(w, ev, "maybe");
    assert.deepEqual(pay(w).approve(ev.id, once, "operator"), { error: "the sealed value cannot be opened" }, "an answer that is neither approve nor refuse");
    assert.deepEqual(pay(w).approve(ev.id, approvalSeal(w, ev, "approve", { rid: once.rid }), "operator"), { error: "the sealed value cannot be opened" }, "a kept rid");
    assert.deepEqual(pay(w).approve("aaaabbbbccccdddd", approvalSeal(w, ev, "approve"), "operator"), { error: "this payment request is gone" });
    assert.equal(pay(w).waiting(), 1);
    // A lock: the state's text first, also for an unknown request.
    await w.ask("sign_ins_lock", {}, DAEMON);
    assert.deepEqual(pay(w).approve("aaaabbbbccccdddd", approvalSeal(w, ev, "approve"), "operator"), { error: "the store is locked" });
    assert.deepEqual(pay(w).approve(ev.id, approvalSeal(w, ev, "approve"), "operator"), { error: "the store is locked" });
    assert.equal(pay(w).waiting(), 1);
    // review-226 N4: each pay_approve logs the request's id with its outcome, and never the seal.
    for (const what of ["an approval whose seal breaks the rid or at rules", "an approval while the store cannot approve (the store is locked)"]) {
      assert.ok(w.logs.includes(`pay: request ${ev.id}: ${what}`), `${what}:\n${w.logs.join("\n")}`);
    }
    assert.ok(w.logs.includes("pay: request aaaabbbbccccdddd: an approval of a request that is gone"), w.logs.join("\n"));
    assert.ok(w.logs.includes("pay: request aaaabbbbccccdddd: an approval while the store cannot approve (the stored sign-ins have no snapshot yet)"), w.logs.join("\n"));
    for (const l of w.logs) assert.ok(!l.includes("aw1:") && !l.includes(stale.rid) && !l.includes(once.rid), `no seal in the log: ${l}`);
    pay(w).stop();
    assert.equal((await call).text, PAY_TEXT.lostBefore);
    // A stop during the preparation: the request ends, and the late preparation sends no pay_request.
    const { formSeal, PASSPHRASE } = await import("./pay-fakes.ts");
    assert.deepEqual(await w.ask("sign_ins_unlock", { sealed: formSeal(w, "sign_ins_unlock", { passphrase: PASSPHRASE }) }), { data: {} });
    let open!: () => void;
    w.page.gate = new Promise<void>((r) => { open = r; });
    const late = pay(w).open(PAY, local());
    await until(() => w.prepared.length === 2, "the preparation");
    pay(w).stop();
    assert.equal((await late).text, PAY_TEXT.lostBefore);
    assert.equal(w.prepared[1].signal.aborted, true);
    open();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(evs(w, "pay_request").length, 1, "no pay_request after the end");
    assert.equal(pay(w).waiting(), 0);
  } finally { w.close(); }
});

// ---------------------------------------------------------------- the cancel, the act's context, the pay event

test("the agent's cancel before the approval ends the request (pay_result); a cancel after the approval does not stop the act, and its result stays", async () => {
  const w = payWorld();
  try {
    await withCard(w);
    const ac = new AbortController();
    const { call, ev } = await request(w, PAY, SCOPE_A, ac.signal);
    ac.abort();
    const r = await call;
    assert.deepEqual([r.state, r.text], ["stopped", "The agent cancelled the payment request."]);
    assert.deepEqual(evs(w, "pay_result").map((e) => [e.id, e.text]), [[ev.id, PAY_TEXT.cancelled]]);
    // A cancel during the preparation: the preparation's signal ends it, then the request ends (no pay_request).
    let open!: () => void;
    w.page.gate = new Promise<void>((res) => { open = res; });
    const ac2 = new AbortController();
    const p = pay(w).open(PAY, local(SCOPE_A, ac2.signal));
    await until(() => w.prepared.length === 2, "the preparation");
    ac2.abort();
    assert.equal(w.prepared[1].signal.aborted, true);
    open();
    assert.equal((await p).text, PAY_TEXT.cancelled);
    assert.equal(evs(w, "pay_request").length, 1);
    w.page.gate = null;
    // After the approval: the act goes on to its result.
    let release!: () => void;
    w.actDoes = () => new Promise((res) => { release = () => res({ state: "paid", text: `Paid: 51.00 USD to ${ORIGIN}, order SHOP-1002` }); });
    const ac3 = new AbortController();
    const c = await request(w, PAY, SCOPE_A, ac3.signal);
    pay(w).approve(c.ev.id, approvalSeal(w, c.ev, "approve"), "operator");
    await until(() => w.acts.length === 1, "the act");
    ac3.abort();
    release();
    assert.equal((await c.call).state, "paid");
    assert.equal(JSON.parse(pay(w).status(SCOPE_A)).results[0].text, `Paid: 51.00 USD to ${ORIGIN}, order SHOP-1002`);
  } finally { w.close(); }
});

test("the act's context: the card's values again from the store (locked: C11's text), the keep's unknown before the press, the pay events; an end after the press that is no paid or declined is unknown", async () => {
  const w = payWorld();
  try {
    await withCard(w);
    w.actDoes = async (ctx) => {
      const opened = ctx.openCard();
      assert.ok("values" in opened);
      assert.equal(opened.values.number.toString("latin1"), TEST_CARDS.visa);
      assert.equal(opened.values.csc.toString("latin1"), TEST_CARD_VALUES.csc);
      for (const b of Object.values(opened.values)) b.fill(0);
      ctx.pay("start");
      ctx.pay("start");
      assert.equal(ctx.keepUnknown(), true);
      // The keep holds unknown before the press (a stop of the service after the press leaves it).
      assert.deepEqual(JSON.parse(pay(w).status(SCOPE_A)).results.map((x: any) => [x.state, x.text]), [["unknown", PAY_TEXT.unknown]]);
      return { state: "stopped", text: PAY_TEXT.totalChanged };
    };
    const { call, ev } = await request(w);
    pay(w).approve(ev.id, approvalSeal(w, ev, "approve"), "operator");
    const r = await call;
    assert.deepEqual([r.state, r.text, r.isError], ["unknown", PAY_TEXT.unknown, true]);
    assert.deepEqual(evs(w, "pay").map((e) => e.state), ["start", "end"], "one start, and the end that the act owed");
    assert.deepEqual(evs(w, "pay_result").map((e) => [e.state, e.alert]), [["unknown", true]]);
    // Locked before the act opens the card.
    w.actDoes = async (ctx) => {
      await w.ask("sign_ins_lock", {}, DAEMON);
      const o = ctx.openCard();
      return { state: "stopped", text: "stop" in o ? o.stop : "no" };
    };
    const second = await request(w);
    pay(w).approve(second.ev.id, approvalSeal(w, second.ev, "approve"), "operator");
    assert.equal((await second.call).text, "The stored sign-ins and cards were locked before the payment.");
    // review-226 N5: the act's signal: the service's stop aborts it (Task 5's act refuses the press at the abort).
    let signal: AbortSignal | null = null, release!: () => void;
    w.actDoes = (ctx) => new Promise((r) => { signal = ctx.signal; release = () => r({ state: "stopped", text: PAY_TEXT.lostBefore }); });
    const { formSeal: fs0, PASSPHRASE: pp0 } = await import("./pay-fakes.ts");
    await w.ask("sign_ins_unlock", { sealed: fs0(w, "sign_ins_unlock", { passphrase: pp0 }) });
    const held = await request(w);
    pay(w).approve(held.ev.id, approvalSeal(w, held.ev, "approve"), "operator");
    await until(() => signal !== null, "the act");
    assert.equal(signal!.aborted, false, "not aborted while the act runs");
    pay(w).stop();
    assert.equal(signal!.aborted, true, "the stop aborts the act's signal");
    assert.equal((await held.call).text, PAY_TEXT.lostBefore);
    release();
    // A throw of the act before the press: lost before the payment.
    const { formSeal, PASSPHRASE } = await import("./pay-fakes.ts");
    await w.ask("sign_ins_unlock", { sealed: formSeal(w, "sign_ins_unlock", { passphrase: PASSPHRASE }) });
    w.actDoes = async () => { throw new Error("the tab went"); };
    const third = await request(w);
    pay(w).approve(third.ev.id, approvalSeal(w, third.ev, "approve"), "operator");
    assert.equal((await third.call).text, PAY_TEXT.lostBefore);
    // Paid, but the confirmation shows another amount: alert.
    w.actDoes = async () => ({ state: "paid", text: PAY_TEXT.paidOther("54.00 USD") });
    const fourth = await request(w);
    pay(w).approve(fourth.ev.id, approvalSeal(w, fourth.ev, "approve"), "operator");
    const r4 = await fourth.call;
    assert.deepEqual([r4.state, r4.isError], ["paid", false]);
    assert.deepEqual(evs(w, "pay_result").at(-1)!.alert, true);
  } finally { w.close(); }
});

// ---------------------------------------------------------------- the keep, the status, the hello

test("the keep: pay-results.json with mode 0600 and C12's pay_result fields only; it survives a restart; earlier in the next pay_request of the origin; 24 hours; status is the scope's compact JSON", async () => {
  const w = payWorld();
  const dir = w.dir;
  try {
    await withCard(w);
    const a = await request(w);
    pay(w).approve(a.ev.id, approvalSeal(w, a.ev, "refuse"), "operator");
    await a.call;
    w.clock.t += 60_000;
    const b = await request(w);
    pay(w).approve(b.ev.id, approvalSeal(w, b.ev, "approve"), "operator");
    await b.call;
    const file = join(dir, "state", KEEP_FILE);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const kept = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(kept.v, 1);
    for (const e of kept.results) assert.deepEqual(Object.keys(e).sort(), ["alert", "at", "id", "origin", "scope", "state", "text"]);
    assert.ok(!JSON.stringify(kept).includes("Zoo") && !JSON.stringify(kept).includes(PAY.description) && !JSON.stringify(kept).includes("checkout?"), "no order line, description or path");
    // The status: the scope's results, the newest first, with no other field.
    assert.equal(pay(w).status(SCOPE_A), JSON.stringify({ results: [
      { state: "paid", text: `Paid: 51.00 USD to ${ORIGIN}, order SHOP-1001`, at: "2026-11-21T14:01:00Z", origin: ORIGIN },
      { state: "stopped", text: PAY_TEXT.refused, at: "2026-11-21T14:00:00Z", origin: ORIGIN },
    ] }));
    assert.equal(pay(w).status(SCOPE_B), '{"results":[]}');
    assert.deepEqual(pay(w).results(SCOPE_A).map((x) => x.at), [T0 + 60_000, T0]);
    // The next pay_request of the origin carries them as earlier, the newest first.
    const c = await request(w);
    assert.deepEqual(c.ev.earlier, [
      { state: "paid", text: `Paid: 51.00 USD to ${ORIGIN}, order SHOP-1001`, at: "2026-11-21T14:01:00Z" },
      { state: "stopped", text: PAY_TEXT.refused, at: "2026-11-21T14:00:00Z" },
    ]);
    // A new hello of the daemon: the waiting pay_request goes again with the same id and fields, earlier read again.
    w.part.onHello();
    const again = evs(w, "pay_request").at(-1);
    assert.deepEqual(again, c.ev);
    assert.notEqual(again, c.ev);
    pay(w).approve(c.ev.id, approvalSeal(w, c.ev, "refuse"), "operator");
    await c.call;
    w.part.onHello();
    assert.equal(evs(w, "pay_request").length, 4, "no resend of an ended request");
  } finally { w.part.stop(); }
  // A restart: a new service reads the keep; 24 hours later the results are gone.
  const w2 = payWorld({ dir });
  try {
    w2.clock.t = T0 + 60_000;
    assert.equal(JSON.parse(pay(w2).status(SCOPE_A)).results.length, 3);
    w2.clock.t = T0 + 24 * 3_600_000 + 1;
    assert.equal(JSON.parse(pay(w2).status(SCOPE_A)).results.length, 2, "the first result is older than 24 hours");
  } finally { w2.close(); }
  // An unreadable keep counts as none, and the service logs the error's kind.
  const w3 = payWorld();
  try {
    mkdirSync(join(w3.dir, "state"), { recursive: true, mode: 0o700 });
    writeFileSync(join(w3.dir, "state", KEEP_FILE), "{not json");
    const w4 = payWorld({ dir: w3.dir });
    assert.equal(pay(w4).status(SCOPE_A), '{"results":[]}');
    assert.ok(w4.logs.includes("pay: the keep cannot be read (SyntaxError); the service starts with no earlier result"), w4.logs.join("\n"));
    w4.part.stop();
  } finally { w3.close(); }
});

// ---------------------------------------------------------------- R1: no test number in a log line, an event or an answer

test("no log line, event or answer of the payment holds the test card's number, its groups, its last four digits or its expiry; the page's lines that hold them are dropped", async () => {
  const n = TEST_CARDS.mastercard;
  const w = payWorld({ newId: (() => { let i = 0; return () => ["abcdefabcdefabcd", "fedcbafedcbafedc", "aaaaaaaaaaaaaaaa"][i++]; })() });
  try {
    await withCard(w, cardForm("travel", n));
    w.page.lines = [...CHECKOUT, `Saved card •••• ${n.slice(-4)}: $0.00`, `${n.slice(0, 4)} ${n.slice(4, 8)} ${n.slice(8, 12)} ${n.slice(12)}: $1.00`, `Expires ${TEST_CARD_VALUES.expiry}: $0.00`];
    const answers: string[] = [];
    const a = await request(w);
    pay(w).approve(a.ev.id, approvalSeal(w, a.ev, "approve"), "operator");
    answers.push(JSON.stringify(await a.call));
    w.actDoes = async () => ({ state: "unknown", text: PAY_TEXT.bankStep });
    const b = await request(w);
    pay(w).approve(b.ev.id, approvalSeal(w, b.ev, "approve"), "operator");
    answers.push(JSON.stringify(await b.call));
    answers.push(JSON.stringify(await pay(w).open({ ...PAY, amount: "9.99" }, local())));
    answers.push(pay(w).status(SCOPE_A));
    const groups = n.match(/.{4}/g)!;
    const forms = [n, groups.join(" "), groups.join("-"), ...groups, n.slice(-4), TEST_CARD_VALUES.expiry, TEST_CARD_VALUES.csc === "123" ? null : TEST_CARD_VALUES.csc].filter((x): x is string => x !== null);
    const texts = [...w.logs, ...w.events.map((e) => JSON.stringify(e)), ...answers, readFileSync(join(w.dir, "state", KEEP_FILE), "utf8")];
    for (const t of texts) for (const f of forms) assert.ok(!t.includes(f), `${f.slice(0, 2)}.. in: ${t.slice(0, 160)}`);
    assert.deepEqual(a.ev.order.lines, ["Zoo entry – adult × 2: $48.00", "Service fee: $3.00"], "the lines with the card's digits are dropped");
    assert.ok(w.logs.some((l) => l.startsWith("sign-ins: sealed card card-")), "the card_seal's log line: its id and name");
  } finally { w.close(); }
  void control;
});

test("PayRequests alone: no store snapshot means locked; a new instance on an empty folder has no result", () => {
  const w = payWorld({ cardPay: false });
  try {
    assert.equal(w.part.pay, null);
    const p = new PayRequests({ store: w.part.store, stateFolder: join(w.dir, "state"), log: () => {}, emit: () => {}, world: { notReady: () => null, covers: () => true, tabs: () => [] },
      prepare: async () => ({ stop: "x" }), act: async () => ({ state: "stopped", text: "x" }) });
    assert.equal(p.status(SCOPE_A), '{"results":[]}');
    assert.ok(!existsSync(join(w.dir, "state", KEEP_FILE)));
    return p.open(PAY, local()).then((r) => assert.equal(r.text, PAY_TEXT.locked));
  } finally { w.close(); }
});

void setUp;
