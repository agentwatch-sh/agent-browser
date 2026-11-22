// The payment act after the operator's approval (contract C11, the card payment: the act, the table of what the agent
// sees, the keep; C12's `pay`; the secure card checkout design, sections 8.4 to 8.8; board ab-sta.7, the plan's Task 5b
// and its Review Focus; review-227 N1, N5a, N5b, N5c). The real PayRequests with a card that the real `card_seal`
// sealed, the real preparation (act.ts) and the real act (pay-act.ts) over the fakes of pay-fill-fakes.ts, with the
// test merchant's page texts. TEST values only: a provider's published test card (pay-test-cards.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { KEEP_FILE } from "../src/service/pay/keep.ts";
import { PayRequests, type CardBuffers, type PayActContext } from "../src/service/pay/request.ts";
import type { PayFillLimits } from "../src/service/pay/pay-act.ts";
import { PAY_TEXT } from "../src/service/pay/texts.ts";
import { refusesDigits } from "../src/service/pay/digits.ts";
import { ACT_TAB, ACT_WINDOW, field, SHOP, STRIPE } from "./pay-act-fakes.ts";
import { approvalSeal, DAEMON, evs, PAY, payWorld, SCOPE_A, until, withCard, type PayWorld } from "./pay-fakes.ts";
import { CONFIRMATION, confirmation, FillBrowser, fillCheckout, merchantLines, PROVIDER, type FillFrame, type FillPage } from "./pay-fill-fakes.ts";
import { TEST_CARD_VALUES, TEST_CARDS } from "./pay-test-cards.ts";

const CHECKOUT_URL = `${SHOP}/checkout?cart=1`;
const local = (signal?: AbortSignal) => ({ scope: SCOPE_A, admission: "local" as const, ...(signal ? { signal } : {}) });
const PAID = `Paid: 51.00 USD to ${SHOP}, order SHOP-1001`;

type Run = { b: FillBrowser; w: PayWorld; opened: CardBuffers[]; stamps: { pay: string[] } };
/**
 * The card payments' part with the real preparation and the real act over one FillBrowser; `page` is the act page. Each
 * buffer that the act opens is kept (they must be zeros at the act's end), and each `pay` event is stamped in the
 * browser's calls, so a test can prove that no key came before the start.
 */
async function world(o: { page?: FillPage; limits?: Partial<PayFillLimits>; newId?: () => string; dir?: string } = {}): Promise<Run> {
  const b = new FillBrowser();
  b.pages.set(CHECKOUT_URL, o.page ?? fillCheckout());
  const prep = b.prepare();
  const actor = b.payAct({ limits: o.limits });
  const opened: CardBuffers[] = [];
  const stamps = { pay: [] as string[] };
  const w = payWorld({
    ...(o.newId ? { newId: o.newId } : {}), ...(o.dir ? { dir: o.dir } : {}),
    cardPay: {
      prepare: (req, card, signal) => prep.prepare(req, card, signal),
      act: (ctx) => {
        const wrapped: PayActContext = {
          ...ctx, prepared: ctx.prepared, signal: ctx.signal,
          openCard: () => { const r = ctx.openCard(); if ("values" in r) opened.push(r.values); return r; },
          keepUnknown: () => ctx.keepUnknown(),
          pay: (s) => { stamps.pay.push(s); b.rec(`pay ${s}`); ctx.pay(s); },
        };
        return actor.act(wrapped);
      },
    },
  });
  await withCard(w);
  return { b, w, opened, stamps };
}
/** A call of browser_pay and its pay_request; the operator's approval. */
async function approved(r: Run, signal?: AbortSignal) {
  const call = r.w.part.pay!.open(PAY, local(signal));
  await until(() => evs(r.w, "pay_request").length === 1, "the pay_request");
  const ev = evs(r.w, "pay_request")[0];
  return { call, ev, approve: () => r.w.part.pay!.approve(ev.id, approvalSeal(r.w, ev, "approve"), "operator") };
}
/** The keys and the inserted texts that reached Chrome. */
const keys = (b: FillBrowser) => b.calls.filter((c) => c.what === "key" || c.what === "insert");
/** After the act: the card's buffers are zeros, the window ended once, rule 90 and the lock are gone. */
function cleanEnd(r: Run, what: string): void {
  for (const v of r.opened) for (const [k, buf] of Object.entries(v)) assert.ok(buf.every((x) => x === 0), `${what}: the buffer ${k} is zeros`);
  assert.equal(r.b.actEnds, 1, `${what}: act_end once`);
  assert.equal(r.b.rule90, null, `${what}: no rule 90`);
  assert.equal(r.b.lock.held(), null, `${what}: the lock is free`);
}
const settle = () => new Promise((res) => setTimeout(res, 30));

// ---------------------------------------------------------------- the whole act

test("the act in C11's order: the card again, the order's hash, the guard, the fields in the provider frame, the save box unticked, pay start, the person's keys into the provider's fields only, the total, the keep's unknown, the press, Paid with the order number; the fields empty and the buffers zeros at the end", async () => {
  const r = await world();
  const { b, w } = r;
  try {
    let keptAtPress: string[] = [];
    b.onPress = (x) => {
      keptAtPress = JSON.parse(readFileSync(join(w.dir, "state", KEEP_FILE), "utf8")).results.map((e: any) => e.state);
      x.goTo(CONFIRMATION, confirmation());
    };
    const a = await approved(r);
    const before = b.calls.length;
    a.approve();
    const res = await a.call;
    assert.deepEqual([res.state, res.text, res.isError], ["paid", PAID, false]);
    assert.equal(res.answer, `${PAID}\nYour tabs could not reach example.com from the copy of the checkout to the end of the payment.`);
    // The keys: each value into its own field of the provider frame, nothing anywhere else.
    assert.equal(b.typedInto("PF1", 0), TEST_CARDS.visa, "the number into cc-number");
    assert.equal(b.typedInto("PF1", 1), TEST_CARD_VALUES.expiry, "the expiry into cc-exp");
    assert.equal(b.typedInto("PF1", 2), TEST_CARD_VALUES.csc, "the security code into cc-csc");
    assert.equal(b.typedInto("PF1", 3), TEST_CARD_VALUES.postal, "the postal code into postal-code");
    assert.ok(b.typed.every((t) => t.frame === "PF1"), "no key outside the provider frame");
    assert.ok(b.calls.filter((c) => c.what === "key").length > 0, "the generator's keys");
    // The order of the act.
    const at = (what: string, from = before) => { const i = b.calls.findIndex((c, k) => k >= from && c.what === what); assert.ok(i >= 0, `no ${what}`); return i; };
    assert.ok(at("order") < at("fields"), "the order again before the fields");
    assert.ok(at("save read") < at("toggle") && at("toggle") < at("pay start"), "the save box unticked before the start");
    assert.ok(at("pay start") < at("key"), "pay start before the first key");
    assert.ok(at("lock") < at("toggle") && at("mouse") > at("lock"), "the inputs under the input lock");
    assert.equal(b.checked.get("PF1")?.get(4), false, "the save box is unticked");
    assert.deepEqual(b.presses, ["pay $51.00"]);
    assert.deepEqual(keptAtPress, ["unknown"], "the keep says unknown at the press");
    // The end: pay end once, the provider's fields empty (review-227 N5a), the buffers zeros (N5b), the window's clean end.
    assert.deepEqual(r.stamps.pay, ["start", "end"]);
    assert.deepEqual(evs(w, "pay").map((e) => e.state), ["start", "end"]);
    assert.ok(b.cleared.includes("PF1"), "the provider frame's fields are empty");
    await settle();
    cleanEnd(r, "paid");
    assert.ok(r.opened.length >= 2, "the card opened again for the act and before the press");
    assert.deepEqual(evs(w, "pay_result").map((e) => [e.state, e.text, e.alert]), [["paid", PAID, false]]);
    assert.deepEqual(JSON.parse(w.part.pay!.status(SCOPE_A)).results.map((e: any) => [e.state, e.text]), [["paid", PAID]]);
  } finally { w.close(); }
});

test("board ab-sta.8: the act's rules of the fill stay to the act's end (no act_rules after the press: Chrome applies them before the act's Fetch); the guard still decides: the act's provider's API gets the number, the shop and another provider's API never", async () => {
  const r = await world();
  const { b, w } = r;
  try {
    const answers: Record<string, Promise<string>> = {};
    b.onPress = (x) => {
      const number = x.typedInto("PF1", 0);
      answers.api = x.requestIn("S-PF1", "https://api.stripe.com/v1/payment_intents/pi_test/confirm", { method: "POST", postData: `card[number]=${number}&card[cvc]=${x.typedInto("PF1", 2)}` });
      answers.other = x.requestIn("S-PF1", "https://api.braintreegateway.com/merchants/m/client_api/v1/payment_methods/credit_cards", { method: "POST", postData: `number=${number}` });
      answers.shop = x.requestIn(undefined, `${SHOP}/log`, { method: "POST", postData: JSON.stringify({ n: number.replace(/(\d{4})/g, "$1 ").trim() }) });
      answers.receipt = x.requestIn(undefined, "https://receipts.example.net/r.css");
      setTimeout(() => x.goTo(CONFIRMATION, confirmation()), 50);
    };
    const a = await approved(r);
    a.approve();
    assert.equal((await a.call).text, PAID);
    assert.equal(await answers.api, "continue", "the act's provider's API gets the number: that is the payment");
    assert.equal(await answers.other, "fail", "another provider's API never gets it");
    assert.equal(await answers.shop, "fail", "the shop never gets the number, also in groups");
    assert.equal(await answers.receipt, "continue", "the guard lets a request with no number go on (Chrome's act rules decide its host)");
    // Two act_rules, both in the preparation: the providers' frames while the fields mount, then the act's provider.
    const rules = b.calls.map((c, i) => ({ c, i })).filter((x) => x.c.what === "act_rules");
    assert.equal(rules.length, 2, "no act_rules after the preparation");
    assert.ok(rules.every((x) => x.i < b.first("key")), "none after the first key, none after the press");
    const last = rules[1].c.detail;
    assert.equal(last.origin, SHOP);
    assert.deepEqual(last.send_to.slice(0, 8), [SHOP, "https://js.stripe.com", "https://checkout.stripe.com", "https://buy.stripe.com", "https://api.stripe.com", "https://m.stripe.network", "https://hooks.stripe.com", "https://m.stripe.com"], "the request's origin, then the act's provider's frame and API origins");
    assert.ok(!last.send_to.some((o: string) => /braintree|squareup|adyen|paypal|shopify/.test(o)), "no other provider's origin");
    assert.ok(!last.send_to.includes("https://receipts.example.net"), "no origin learnt after the press");
    assert.ok(b.logs.some((l) => l.includes("the guard failed a request that held the card's number")), b.logs.join("\n"));
    await settle();
    assert.equal(b.calls.slice(b.first("act_end")).filter((c) => c.what === "act_rules").length, 0, "no act_rules after act_end");
    cleanEnd(r, "rules");
  } finally { w.close(); }
});

// ---------------------------------------------------------------- the results of C11's table

test("the results: Declined (the page stays and names the decline near the card fields), the bank's second step (Unknown at once), a fee at the press (Paid, but ...; alert), no confirmation within the window (Unknown), a lost tab after the press (Unknown), a confirmation whose order number holds the last four digits (order number not found)", async () => {
  type Case = { what: string; press: (b: FillBrowser) => void; state: string; text: string; alert: boolean };
  const last4 = TEST_CARDS.visa.slice(-4);
  const cases: Case[] = [
    { what: "a decline", press: (b) => { b.fillPage!.lines = [...b.fillPage!.lines, "Payment failed: your card was declined."]; b.fillPage!.alerts = ["Payment failed: your card was declined."]; b.fillPage!.frames[0].lines = [...(b.fillPage!.frames[0].lines ?? []), "Your card was declined."]; }, state: "declined", text: PAY_TEXT.declined, alert: false },
    { what: "a decline in the page's alert only", press: (b) => { b.fillPage!.lines = [...b.fillPage!.lines, "Payment failed: your card was declined."]; b.fillPage!.alerts = ["Payment failed: your card was declined."]; }, state: "declined", text: PAY_TEXT.declined, alert: false },
    { what: "a bank's step", press: (b) => b.addFrame({ id: "BANK", url: "http://bank.localhost/3ds.html", oop: true, fields: [field(0, { autocomplete: "one-time-code", label: "code" })], lines: merchantLines("bank/3ds.html"), title: "Verify - Test Bank" }), state: "unknown", text: PAY_TEXT.bankStep, alert: true },
    { what: "a fee at the press", press: (b) => b.goTo(`${SHOP}/confirmation-fee.html`, confirmation("shop/confirmation-fee.html")), state: "paid", text: "Paid, but the merchant's confirmation shows 54.00 USD", alert: true },
    { what: "no confirmation", press: () => {}, state: "unknown", text: PAY_TEXT.unknown, alert: true },
    { what: "a lost tab", press: (b) => setTimeout(() => b.emit({ t: "ev", ch: "bridge", ev: "debugger.onDetach", source: { tabId: ACT_TAB }, reason: "target_closed" }), 20), state: "unknown", text: PAY_TEXT.unknown, alert: true },
    { what: "an order number with the last four digits", press: (b) => b.goTo(CONFIRMATION, { ...confirmation(), lines: ["Thank you for your order!", `Order number: A${last4}-77`, "Amount charged: $51.00"] }), state: "paid", text: `Paid: 51.00 USD to ${SHOP}, order number not found`, alert: false },
    { what: "the test merchant's confirmation with the last four digits", press: (b) => b.goTo(`${SHOP}/confirmation-last4.html`, { ...confirmation("shop/confirmation-last4.html"), lines: ["Thank you for your order!", `Paid with Visa ending in ${last4}`, ...merchantLines("shop/confirmation-last4.html").slice(1)] }), state: "paid", text: `Paid: 51.00 USD to ${SHOP}, order SHOP-1004`, alert: false },
  ];
  for (const c of cases) {
    const r = await world();
    try {
      r.b.onPress = c.press;
      const a = await approved(r);
      a.approve();
      const res = await a.call;
      assert.deepEqual([res.state, res.text], [c.state, c.text], c.what);
      assert.equal(res.isError, c.state !== "paid", c.what);
      assert.deepEqual(evs(r.w, "pay_result").map((e) => [e.state, e.alert]), [[c.state, c.alert]], c.what);
      assert.deepEqual(r.b.presses, ["pay $51.00"], `${c.what}: one press`);
      assert.deepEqual(evs(r.w, "pay").map((e) => e.state), ["start", "end"], c.what);
      if (c.what !== "a lost tab") assert.ok(r.b.cleared.includes("PF1"), `${c.what}: the provider's fields empty`);
      await settle();
      for (const v of r.opened) for (const buf of Object.values(v)) assert.ok(buf.every((x) => x === 0), `${c.what}: zeros`);
      assert.equal(r.b.lock.held(), null, c.what);
    } finally { r.w.close(); }
  }
});

// ---------------------------------------------------------------- the stops before the first key

test("the stops before the first key: another order after the approval (its hash), card fields outside a provider frame, a frame not on the list, a save box that cannot be unticked, no pay button, a popup or another tab of the act window (review-227 N5c), an open WebSocket outside the act's list (review-227 N1); no key, no press, no pay start", async () => {
  type Case = { what: string; text: string; set?: (p: FillPage, b: FillBrowser) => void; during?: (r: Run) => Promise<void> | void };
  const changed = (f: (p: FillPage) => void) => (p: FillPage) => f(p);
  const cases: Case[] = [
    { what: "another order (a line changed)", text: PAY_TEXT.orderChanged, during: (r) => { r.b.fillPage!.lines = ["Zoo entry – adult × 3: $48.00", ...r.b.fillPage!.lines.slice(1)]; } },
    { what: "another order (the total)", text: PAY_TEXT.orderChanged, during: (r) => { r.b.fillPage!.lines = r.b.fillPage!.lines.map((l) => l.replace("Total: $51.00", "Total: $54.00")); } },
    { what: "card fields on the shop's own page", text: PAY_TEXT.fields, during: (r) => { r.b.fillPage!.fields = [...r.b.fillPage!.fields, field(5, { autocomplete: "cc-number" })]; } },
    { what: "card fields in a frame not on the list", text: PAY_TEXT.fields, during: (r) => { r.b.fillPage!.frames[0].url = "https://fields.not-a-provider.net/card"; r.b.attached.get("S-PF1")!.url = "https://fields.not-a-provider.net/card"; } },
    { what: "a save box that cannot be unticked", text: PAY_TEXT.keepsCard, set: changed((p) => { p.frames[0].fields = [...p.frames[0].fields.slice(0, 4), field(4, { type: "checkbox", enabled: false, label: "your card will be saved for future purchases" })]; }) },
    { what: "a save box that stays ticked", text: PAY_TEXT.keepsCard, set: (_p, b) => { (b as any).toggle = () => {}; } },
    { what: "no pay button", text: PAY_TEXT.noButton, set: changed((p) => { p.buttons = [{ text: "apply coupon" }, { text: "pay with paypal" }]; }) },
    { what: "a popup of the act tab while the request waited", text: PAY_TEXT.lostBefore, during: (r) => r.b.emit({ t: "ev", ch: "bridge", ev: "tabs.onCreated", tab: { id: 44, windowId: 45, incognito: true, openerTabId: ACT_TAB } }) },
    { what: "another tab in the act window", text: PAY_TEXT.lostBefore, during: (r) => { r.b.windowTabs = [ACT_TAB, 46]; } },
    { what: "another tab in the act window (its event)", text: PAY_TEXT.lostBefore, during: (r) => r.b.emit({ t: "ev", ch: "bridge", ev: "tabs.onCreated", tab: { id: 47, windowId: ACT_WINDOW, incognito: true } }) },
    { what: "an open WebSocket outside the act's list", text: PAY_TEXT.rules, during: (r) => r.b.socket("wss://tracker.other-host.net/live") },
    { what: "an open WebSocket of a provider frame outside the list", text: PAY_TEXT.rules, during: (r) => r.b.socket("wss://socket.not-a-provider.net/x", "S-PF1") },
  ];
  for (const c of cases) {
    const page = fillCheckout();
    const r = await world({ page });
    try {
      if (process.env.PAY_DEBUG) console.error(`case: ${c.what}`);
      c.set?.(page, r.b);
      const a = await approved(r);
      await c.during?.(r);
      a.approve();
      const res = await a.call;
      assert.deepEqual([res.state, res.text], ["stopped", c.text], c.what);
      assert.equal(keys(r.b).length, 0, `${c.what}: no key`);
      assert.deepEqual(r.b.presses, [], `${c.what}: no press`);
      assert.deepEqual(r.stamps.pay.filter((s) => s === "start"), [], `${c.what}: no pay start`);
      assert.deepEqual(evs(r.w, "pay"), [], `${c.what}: no pay event`);
      await settle();
      cleanEnd(r, c.what);
    } finally { r.w.close(); }
  }
  // A WebSocket to the shop's own origin (on the act's list) does not stop the act.
  const r = await world();
  try {
    r.b.onPress = (x) => x.goTo(CONFIRMATION, confirmation());
    const a = await approved(r);
    r.b.socket(`wss://shop.example.com/live`);
    a.approve();
    assert.equal((await a.call).text, PAID);
  } finally { r.w.close(); }
});

// ---------------------------------------------------------------- the stops during the fill (the fields empty)

test("the stops during the fill and right before the press: the total changes, the guard finds the number in a URL, the store locks, the keep cannot write, the act's 5 minutes; the fields empty, no press", async () => {
  type Case = { what: string; text: string; at: (r: Run, n: number) => void; limits?: Partial<PayFillLimits>; typing?: false };
  const cases: Case[] = [
    { what: "the total changes at the first key", text: PAY_TEXT.totalChanged, at: (r, n) => { if (n === 1) r.b.fillPage!.lines = r.b.fillPage!.lines.map((l) => l.replace("Total: $51.00", "Total: $54.00")); } },
    { what: "the guard: the number in a URL", text: PAY_TEXT.guard, at: (r, n) => { if (n === 16) void r.b.requestIn("S-PF1", `https://js.stripe.com/collect?n=${r.b.typedInto("PF1", 0)}`); } },
    { what: "the guard: the number in groups in a body to the shop", text: PAY_TEXT.guard, at: (r, n) => { if (n === 16) void r.b.requestIn(undefined, `${SHOP}/beacon`, { method: "POST", postData: `x=${r.b.typedInto("PF1", 0).replace(/(\d{4})(?=\d)/g, "$1%20")}` }); } },
    { what: "the store locks", text: PAY_TEXT.lockedBefore, at: (r, n) => { if (n === 3) void r.w.ask("sign_ins_lock", {}, DAEMON); } },
    { what: "the keep cannot write", text: PAY_TEXT.keepFailed, at: (r, n) => { if (n === 3) mkdirSync(join(r.w.dir, "state", KEEP_FILE), { recursive: true }); } },
    { what: "the act's 5 minutes", text: PAY_TEXT.timeBefore, at: () => {}, limits: { actMs: 30 }, typing: false },
  ];
  for (const c of cases) {
    const r = await world({ limits: c.limits });
    try {
      r.b.onType = (n) => c.at(r, n);
      const a = await approved(r);
      a.approve();
      const res = await a.call;
      assert.deepEqual([res.state, res.text], ["stopped", c.text], c.what);
      assert.deepEqual(r.b.presses, [], `${c.what}: no press`);
      if (c.typing !== false) {
        assert.ok(keys(r.b).length > 0, `${c.what}: the fill began`);
        assert.ok(r.b.cleared.includes("PF1"), `${c.what}: the fields empty`);
      } else assert.equal(keys(r.b).length, 0, `${c.what}: the time ended before the first key`);
      assert.equal(r.b.value("PF1", 0), "", `${c.what}: no number left in the field`);
      assert.deepEqual(evs(r.w, "pay").map((e) => e.state), ["start", "end"], c.what);
      if (c.what !== "the keep cannot write") assert.deepEqual(JSON.parse(r.w.part.pay!.status(SCOPE_A)).results.map((e: any) => e.state), ["stopped"], `${c.what}: the keep says stopped`);
      await settle();
      cleanEnd(r, c.what);
    } finally { r.w.close(); }
  }
});

// ---------------------------------------------------------------- the Review Focus

test("Review Focus: a provider frame that loads again while the act types stops the act and empties the fields; no key goes into the new frame, and no field of it is found or clicked", async () => {
  const r = await world();
  try {
    let mark = -1;
    r.b.onType = (n) => { if (n === 6) { r.b.reloadFrame("PF1"); mark = r.b.calls.length; } };
    const a = await approved(r);
    a.approve();
    const res = await a.call;
    assert.deepEqual([res.state, res.text], ["stopped", PAY_TEXT.frameLoaded]);
    const after = r.b.calls.slice(mark);
    assert.equal(after.filter((c) => c.what === "key" && c.detail === "keyDown").length, 0, "no key after the reload");
    assert.ok(!after.some((c) => c.what === "at" || (c.what === "mouse" && c.detail === "mousePressed")), "no new find, no click");
    assert.ok(r.b.typed.length <= 6 && r.b.typed.every((t) => t.frame === "PF1"));
    assert.ok(r.b.cleared.includes("PF1"), "the fields empty");
    assert.deepEqual(r.b.presses, []);
    await settle();
    cleanEnd(r, "reload");
  } finally { r.w.close(); }
});

test("Review Focus: the service stops (the store locks) between the approval and the press: the act stops before the press (stopped); after the press the keep says Unknown, also for the service's next start", async () => {
  // Before the press: the service's stop during the fill.
  {
    const r = await world();
    try {
      r.b.onType = (n) => { if (n === 4) r.w.part.stop(); };
      const a = await approved(r);
      a.approve();
      const res = await a.call;
      assert.deepEqual([res.state, res.text], ["stopped", PAY_TEXT.lostBefore]);
      await settle();
      await settle();
      assert.deepEqual(r.b.presses, [], "no press after the stop");
      assert.deepEqual(JSON.parse(readFileSync(join(r.w.dir, "state", KEEP_FILE), "utf8")).results.map((e: any) => e.state), ["stopped"]);
      for (const v of r.opened) for (const buf of Object.values(v)) assert.ok(buf.every((x) => x === 0));
    } finally { r.w.close(); }
  }
  // After the press: the service's stop while the reader reads; the keep says unknown, and a new start reads it.
  {
    const r = await world();
    try {
      r.b.onPress = () => setTimeout(() => r.w.part.stop(), 30);
      const a = await approved(r);
      a.approve();
      const res = await a.call;
      assert.deepEqual([res.state, res.text], ["unknown", PAY_TEXT.unknown]);
      assert.deepEqual(r.b.presses, ["pay $51.00"]);
      const again = new PayRequests({ store: r.w.part.store, stateFolder: join(r.w.dir, "state"), log: () => {}, emit: () => {}, world: { notReady: () => null, covers: () => true, tabs: () => [] },
        prepare: async () => ({ stop: "x" }), act: async () => ({ state: "stopped", text: "x" }) });
      assert.deepEqual(JSON.parse(again.status(SCOPE_A)).results.map((e: any) => [e.state, e.text]), [["unknown", PAY_TEXT.unknown]], "the next start reads Unknown");
      await settle();
    } finally { r.w.close(); }
  }
});

// ---------------------------------------------------------------- R1

test("R1: no result, log line, event, answer or keep entry holds the test number, its groups, its last four digits, the security code or the expiry (a payment, a decline, a guard's stop)", async () => {
  const n = TEST_CARDS.visa;
  const card = { number: Buffer.from(n), expiry: Buffer.from(TEST_CARD_VALUES.expiry) };
  const texts: string[] = [];
  const plans: ((b: FillBrowser) => void)[] = [
    (b) => { b.onPress = (x) => x.goTo(`${SHOP}/confirmation-last4.html`, { ...confirmation("shop/confirmation-last4.html"), lines: ["Thank you for your order!", `Paid with Visa ending in ${n.slice(-4)}`, `Card ${n.slice(0, 4)} •••• ${n.slice(-4)} exp ${TEST_CARD_VALUES.expiry}`, "Order number: SHOP-1004", "Amount charged: $51.00"] }); },
    (b) => { b.onPress = (x) => { x.fillPage!.lines = [...x.fillPage!.lines, `Payment failed: the card ending in ${n.slice(-4)} was declined.`]; x.fillPage!.alerts = [`Payment failed: the card ending in ${n.slice(-4)} was declined.`]; }; },
    (b) => { b.onType = (k) => { if (k === 16) void b.requestIn(undefined, `${SHOP}/t?card=${b.typedInto("PF1", 0)}`); }; },
  ];
  let i = 0;
  for (const plan of plans) {
    const ids = [`abcdefabcdefab${String.fromCharCode(97 + i)}${String.fromCharCode(97 + i)}`];
    i++;
    const r = await world({ newId: () => ids.shift() ?? "eeeeeeeeeeeeeeee" });
    try {
      plan(r.b);
      const a = await approved(r);
      a.approve();
      const res = await a.call;
      texts.push(JSON.stringify(res), ...r.w.logs, ...r.w.events.map((e) => JSON.stringify(e)), r.w.part.pay!.status(SCOPE_A), readFileSync(join(r.w.dir, "state", KEEP_FILE), "utf8"), ...r.b.logs);
    } finally { r.w.close(); }
  }
  assert.ok(texts.length > 10);
  for (const raw of texts) {
    // The time that a request took (`<n> ms`) is no value of the card.
    const t = raw.replace(/\b\d+ ms\b/g, "N ms");
    assert.ok(!refusesDigits(t, card), `no run of the number's digits, no last four, no expiry: ${t.slice(0, 160)}`);
    assert.ok(!/(?<![0-9a-f])123(?![0-9a-f])/.test(t), `no security code: ${t.slice(0, 160)}`);
    for (const f of [n, n.match(/.{4}/g)!.join(" "), n.match(/.{4}/g)!.join("-"), TEST_CARD_VALUES.expiry]) assert.ok(!t.includes(f));
  }
  assert.ok(texts.some((t) => t.includes("order SHOP-1004")), "the confirmation's order number passes the filter");
});

// ---------------------------------------------------------------- the window's hold after its end (review-227 N5b)

test("review-227 N5b: a buffer given to the window's hold after its end goes to zeros at once", async () => {
  const r = await world();
  try {
    const { PayActWindow } = await import("../src/service/pay/act.ts");
    let win: InstanceType<typeof PayActWindow> | null = null;
    r.w.part.pay; // the part with the option
    const a = await approved(r);
    // The fake act does not run: the operator refuses; the window's end runs, then a late buffer comes.
    const prepared = (r.w.part.pay as any).live.get(a.ev.id).act;
    assert.ok(prepared instanceof PayActWindow);
    win = prepared;
    r.w.part.pay!.approve(a.ev.id, approvalSeal(r.w, a.ev, "refuse"), "operator");
    await a.call;
    const late = Buffer.from(TEST_CARD_VALUES.csc);
    win!.hold(late);
    assert.ok(late.every((x) => x === 0), "zeros at once");
  } finally { r.w.close(); }
});

void STRIPE; void PROVIDER;

// ---------------------------------------------------------------- review-228's fix round

test("review-228 B1: the main document takes the focus after the click (a page's hidden.focus()): the provider frame keeps its own active field, but the act proves the act page's focus before each key, so it stops, no key reaches the page, and the fields are empty", async () => {
  const r = await world();
  try {
    let at = -1;
    r.b.onType = (n) => { if (n === 3) { r.b.takeFocus(9); at = r.b.typed.length; } };
    const a = await approved(r);
    a.approve();
    const res = await a.call;
    assert.deepEqual([res.state, res.text], ["stopped", PAY_TEXT.frameLoaded]);
    assert.ok(at > 0, "the page took the focus during the fill");
    assert.equal(r.b.typedInto("main", 9), "", "no key reached the page's field");
    assert.ok(r.b.typed.every((t) => t.frame === "PF1"), "keys only into the provider frame");
    assert.equal(r.b.typed.length, at, "no key after the focus moved");
    assert.ok(r.b.cleared.includes("PF1"), "the fields are empty");
    assert.ok(r.b.calls.some((c) => c.what === "resolve"), "the owner element in the act's own world");
    assert.deepEqual(r.b.presses, []);
    await settle();
    cleanEnd(r, "B1");
  } finally { r.w.close(); }
});

test("review-228 N3, N4: the save-card box that the page ticks again during the fill is unticked again before the press; a box ticked again right before the press, or a total that changes after the button's box is read, stops with no press", async () => {
  // N3: ticked again during the fill: unticked again, and the press goes with the box unticked.
  {
    const r = await world();
    try {
      r.b.onType = (n) => { if (n === 5) r.b.checked.get("PF1")!.set(4, true); };
      let atPress: boolean | null = null;
      r.b.onPress = (x) => { atPress = x.checked.get("PF1")!.get(4)!; x.goTo(CONFIRMATION, confirmation()); };
      const a = await approved(r);
      a.approve();
      assert.equal((await a.call).text, PAID);
      assert.equal(atPress, false, "the box is unticked at the press");
    } finally { r.w.close(); }
  }
  // N3: ticked again right before the press (after the button's box): the stop.
  // N4: the total changes after the button's box is read: the total's read is next to the press.
  for (const [what, set, text] of [
    ["a box ticked again right before the press", (b: FillBrowser) => { b.checked.get("PF1")!.set(4, true); }, PAY_TEXT.keepsCard],
    ["the total changes after the button's box", (b: FillBrowser) => { b.fillPage!.lines = b.fillPage!.lines.map((l) => l.replace("Total: $51.00", "Total: $54.00")); }, PAY_TEXT.totalChanged],
  ] as const) {
    const r = await world();
    try {
      r.b.onButtonBox = () => set(r.b);
      const a = await approved(r);
      a.approve();
      const res = await a.call;
      assert.deepEqual([res.state, res.text], ["stopped", text], what);
      assert.deepEqual(r.b.presses, [], `${what}: no press`);
      assert.ok(r.b.cleared.includes("PF1"), `${what}: the fields are empty`);
      await settle();
      cleanEnd(r, what);
    } finally { r.w.close(); }
  }
});

test("review-228 N5, N6: a windows.get that fails stops before the first key; a frame whose guard cannot start (Fetch.enable fails) stops before the first key, with a log line of the kind only; a worker gets Network.enable, so its open WebSocket outside the act's rules stops the act", async () => {
  type Case = { what: string; text: string; set?: (b: FillBrowser) => void; during?: (r: Run) => void };
  const cases: Case[] = [
    { what: "windows.get fails", text: PAY_TEXT.lostBefore, set: (b) => { b.windowsGetFails = true; } },
    { what: "Fetch.enable fails in the provider frame", text: PAY_TEXT.rules, set: (b) => { b.fetchFails.add("iframe"); } },
    { what: "Fetch.enable fails in a worker", text: PAY_TEXT.rules, during: (r) => { r.b.fetchFails.add("worker"); r.b.addWorker("W1"); } },
    { what: "a worker's WebSocket", text: PAY_TEXT.rules, during: (r) => { r.b.addWorker("W2"); r.b.socket("wss://tracker.other-host.net/w", "S-W2"); } },
  ];
  for (const c of cases) {
    const r = await world();
    try {
      c.set?.(r.b);
      const a = await approved(r);
      c.during?.(r);
      await settle();
      a.approve();
      const res = await a.call;
      assert.deepEqual([res.state, res.text], ["stopped", c.text], c.what);
      assert.equal(keys(r.b).length, 0, `${c.what}: no key`);
      assert.deepEqual(r.b.presses, [], c.what);
      if (c.what.startsWith("Fetch.enable")) {
        const line = r.b.logs.find((l) => l.includes("the guard did not start"));
        assert.ok(line, `${c.what}: a log line`);
        assert.ok(!/https?:|S-|PF1|W1|Fetch is not available/.test(line!), `${c.what}: the kind only: ${line}`);
      }
      if (c.what === "a worker's WebSocket") assert.ok(r.b.calls.some((x) => x.what === "child Network.enable" && x.detail === "S-W2"), "the worker's Network.enable");
      await settle();
      cleanEnd(r, c.what);
    } finally { r.w.close(); }
  }
});

test("review-228 N8 (the lead's call): a page that sends the card's number to the provider before the press: the keep says unknown at once, and a later stop before the press is Unknown with the Unknown text (never Not paid); a keep that cannot write at that moment stops at once, also Unknown", async () => {
  // The provider frame posts the number to its API when the card is complete; then the total changes before the press.
  {
    const r = await world();
    try {
      let kept: string[] = [];
      r.b.onType = (n) => {
        if (n === 16) void r.b.requestIn("S-PF1", "https://api.stripe.com/v1/payment_methods", { method: "POST", postData: `card[number]=${r.b.typedInto("PF1", 0)}` });
        if (n === 18) kept = JSON.parse(readFileSync(join(r.w.dir, "state", KEEP_FILE), "utf8")).results.map((e: any) => e.state);
      };
      r.b.onButtonBox = () => { r.b.fillPage!.lines = r.b.fillPage!.lines.map((l) => l.replace("Total: $51.00", "Total: $54.00")); };
      const a = await approved(r);
      a.approve();
      const res = await a.call;
      assert.deepEqual(kept, ["unknown"], "the keep says unknown at once");
      assert.deepEqual([res.state, res.text, res.isError], ["unknown", PAY_TEXT.unknown, true]);
      assert.ok(!res.answer.startsWith("Not paid"));
      assert.deepEqual(r.b.presses, []);
      assert.deepEqual(evs(r.w, "pay_result").map((e) => [e.state, e.text, e.alert]), [["unknown", PAY_TEXT.unknown, true]]);
    } finally { r.w.close(); }
  }
  // The keep cannot write when the number goes: the act stops at once, and its result is Unknown.
  {
    const r = await world();
    try {
      let after = -1;
      r.b.onType = (n) => {
        if (n === 16) {
          mkdirSync(join(r.w.dir, "state", KEEP_FILE), { recursive: true });
          void r.b.requestIn("S-PF1", "https://api.stripe.com/v1/payment_methods", { method: "POST", postData: `card[number]=${r.b.typedInto("PF1", 0)}` });
          after = r.b.typed.length;
        }
      };
      const a = await approved(r);
      a.approve();
      const res = await a.call;
      assert.deepEqual([res.state, res.text], ["unknown", PAY_TEXT.unknown]);
      assert.ok(r.b.typed.length <= after + 2, "the act stops at once");
      assert.deepEqual(r.b.presses, []);
      assert.ok(r.b.cleared.includes("PF1"));
    } finally { r.w.close(); }
  }
});

// ---------------------------------------------------------------- board ab-sta.8: what the live check measured in Chrome

test("board ab-sta.8, the key race: each card key goes on the provider frame's own session, so a page script that takes the focus between the act's focus check and a key gets no digit; the act then stops with no press and empty fields", async () => {
  const r = await world();
  try {
    let moved = -1;
    // Right after the act's fifth check of the page's focus (in the number), before its next key: a page script takes the focus.
    r.b.onOwnerCheck = (n) => { if (n === 5 && moved < 0) { r.b.takeFocus(9); moved = r.b.typed.length; } };
    const a = await approved(r);
    a.approve();
    const res = await a.call;
    assert.deepEqual([res.state, res.text], ["stopped", PAY_TEXT.frameLoaded]);
    assert.ok(moved > 0, "the page took the focus between a check and a key");
    assert.equal(r.b.typedInto("main", 9), "", "no digit reached the page's field");
    assert.ok(r.b.typed.every((t) => t.frame === "PF1"), "keys only into the provider frame");
    assert.ok(r.b.lostKeys >= 1, "the racing key reached no field");
    assert.ok(r.b.keySessions.length > 0 && r.b.keySessions.every((x) => x === "S-PF1"), `each key on the frame's own session: ${[...new Set(r.b.keySessions)].join(",")}`);
    assert.ok(r.b.cleared.includes("PF1"), "the fields are empty");
    assert.deepEqual(r.b.presses, []);
    await settle();
    cleanEnd(r, "the key race");
  } finally { r.w.close(); }
  // With no race the keys on the frame's session fill each field, and the act pays.
  const r2 = await world();
  try {
    r2.b.onPress = (x) => x.goTo(CONFIRMATION, confirmation());
    const a = await approved(r2);
    a.approve();
    const res = await a.call;
    assert.equal(res.state, "paid", res.text);
    assert.equal(r2.b.lostKeys, 0);
    assert.ok(r2.b.keySessions.length > 0 && r2.b.keySessions.every((x) => x === "S-PF1"));
    assert.equal(r2.b.typedInto("PF1", 0), TEST_CARDS.visa, "the number in its field");
    await settle();
    cleanEnd(r2, "no race");
  } finally { r2.w.close(); }
});

test("board ab-sta.8, review-228 N6 in Chrome: a dedicated worker whose own session has no Fetch domain (-32601 through chrome.debugger; the act tab's own Fetch pauses its requests) does not stop the act, with one log line; any other failure of a worker's Fetch still stops it", async () => {
  const NO_FETCH = JSON.stringify({ code: -32601, message: "'Fetch.enable' wasn't found" });
  for (const [what, text, paid, type, line] of [
    ["-32601 in a dedicated worker", NO_FETCH, true, "worker", ""],
    ["another error in a dedicated worker", "Fetch is not available", false, "worker", "the guard did not start in a worker of the act tab (an error)"],
    ["-32601 in a service worker (the tab's Fetch does not hold its requests)", NO_FETCH, false, "service_worker", "the guard did not start in a service worker of the act tab (no Fetch domain)"],
  ] as const) {
    const r = await world();
    try {
      r.b.fetchFailText = text;
      r.b.onPress = (x) => x.goTo(CONFIRMATION, confirmation());
      const a = await approved(r);
      r.b.fetchFails.add("worker");
      r.b.addWorker("W1", type);
      await settle();
      a.approve();
      const res = await a.call;
      if (paid) {
        assert.equal(res.state, "paid", `${what}: ${res.text}`);
        assert.equal(r.b.logs.filter((l) => l.includes("a dedicated worker of the act tab has no Fetch of its own; the act tab's Fetch holds its requests")).length, 1, what);
        assert.ok(!r.b.logs.some((l) => l.includes("the guard did not start")), what);
      } else {
        assert.deepEqual([res.state, res.text], ["stopped", PAY_TEXT.rules], what);
        assert.ok(r.b.logs.some((l) => l.endsWith(line)), `${what}: ${r.b.logs.filter((l) => l.includes("guard")).join(" | ")}`);
      }
      await settle();
      cleanEnd(r, what);
    } finally { r.w.close(); }
  }
});

test("board ab-sta.8: after the approval the card fields are in another provider's frame (the act's rules hold only the provider of the preparation): the act stops before the first key with C11's text of card fields outside a known provider's frame", async () => {
  const r = await world();
  try {
    const a = await approved(r);
    // The page's provider frame now comes from Braintree's origin: no rule of the act holds it.
    r.b.fillPage!.frames[0].url = "https://assets.braintreegateway.com/web/3/html/hosted-fields-frame.min.html";
    a.approve();
    const res = await a.call;
    assert.deepEqual([res.state, res.text], ["stopped", PAY_TEXT.fields]);
    assert.equal(keys(r.b).length, 0, "no key");
    assert.deepEqual(r.b.presses, []);
    await settle();
    cleanEnd(r, "another provider");
  } finally { r.w.close(); }
});

// ---------------------------------------------------------------- review-229's fix round (board ab-sta.8)

const BRAINTREE_FRAME = (o: Partial<FillFrame> = {}): FillFrame => ({ id: "PF2", url: "https://assets.braintreegateway.com/web/3/html/hosted-fields-frame.min.html", fields: [field(0, { autocomplete: "cc-csc", type: "tel" })], oop: true, lines: ["CVV"], ...o });

test("review-229 B1: a full Stripe set and one Braintree security code field (a field that the finder does not keep): frames of two providers stop the act before the first key, after the approval as in the preparation", async () => {
  // After the approval: the Braintree frame comes after the preparation.
  {
    const r = await world();
    try {
      const a = await approved(r);
      r.b.addFrame(BRAINTREE_FRAME());
      await settle();
      a.approve();
      const res = await a.call;
      assert.deepEqual([res.state, res.text], ["stopped", PAY_TEXT.fields]);
      assert.equal(keys(r.b).length, 0, "no key");
      assert.deepEqual(r.b.presses, []);
      await settle();
      cleanEnd(r, "B1 after the approval");
    } finally { r.w.close(); }
  }
  // In the preparation: no pay_request, the request stops with the same text.
  {
    const r = await world({ page: fillCheckout({ frames: [PROVIDER(), BRAINTREE_FRAME()] }) });
    try {
      const res = await r.w.part.pay!.open(PAY, local());
      assert.deepEqual([res.state, res.text], ["stopped", PAY_TEXT.fields]);
      assert.equal(evs(r.w, "pay_request").length, 0);
      assert.equal(keys(r.b).length, 0);
    } finally { r.w.close(); }
  }
});

test("review-229 N2: the act lets a dedicated worker with no Fetch domain go only when Chrome attaches it on the act tab's own session; one that Chrome attaches on a frame's session stops the act before the first key", async () => {
  const NO_FETCH = JSON.stringify({ code: -32601, message: "'Fetch.enable' wasn't found" });
  for (const [what, parent, paid] of [["on the act tab's own session", undefined, true], ["on the provider frame's session", "S-PF1", false]] as const) {
    const r = await world();
    try {
      r.b.fetchFailText = NO_FETCH;
      r.b.onPress = (x) => x.goTo(CONFIRMATION, confirmation());
      const a = await approved(r);
      r.b.fetchFails.add("worker");
      r.b.addWorker("W1", "worker", parent);
      await settle();
      a.approve();
      const res = await a.call;
      if (paid) assert.equal(res.state, "paid", `${what}: ${res.text}`);
      else {
        assert.deepEqual([res.state, res.text], ["stopped", PAY_TEXT.rules], what);
        assert.ok(r.b.logs.some((l) => l.endsWith("the guard did not start in a worker of the act tab (no Fetch domain)")), `${what}: ${r.b.logs.join(" | ")}`);
        assert.equal(keys(r.b).length, 0, `${what}: no key`);
      }
      await settle();
      cleanEnd(r, what);
    } finally { r.w.close(); }
  }
});

test("review-229 N7: a card field in an in-process subframe (no session of its own: its keys would go on the act tab's session) stops the act before the first key with the text of card fields outside a provider frame", async () => {
  const r = await world({ page: fillCheckout({ frames: [PROVIDER({ oop: false })] }) });
  try {
    const a = await approved(r);
    a.approve();
    const res = await a.call;
    assert.deepEqual([res.state, res.text], ["stopped", PAY_TEXT.fields]);
    assert.equal(keys(r.b).length, 0, "no key");
    assert.deepEqual(r.b.presses, []);
    await settle();
    cleanEnd(r, "N7");
  } finally { r.w.close(); }
});

test("review-229 N8: after a field's last key the focus may be on another card field of the same provider frame (the provider moves it when the number is complete): the act goes on; on the top frame, on another frame, or on a field that the act does not fill, it stops", async () => {
  const N = TEST_CARDS.visa.length;
  type Case = { what: string; move: (b: FillBrowser) => void; page?: FillPage; paid: boolean };
  const cases: Case[] = [
    { what: "the frame's next card field", move: (b) => { b.docFocus.set("PF1", 1); }, paid: true },
    { what: "the top frame", move: (b) => { b.takeFocus(9); }, paid: false },
    { what: "another provider frame", move: (b) => { b.mainFocus = { frame: "PF2" }; b.docFocus.set("PF2", 0); }, page: fillCheckout({ frames: [PROVIDER(), PROVIDER({ id: "PF2" })] }), paid: false },
    { what: "the frame's save box (no field that the act fills)", move: (b) => { b.docFocus.set("PF1", 4); }, paid: false },
  ];
  for (const c of cases) {
    const r = await world(c.page ? { page: c.page } : {});
    try {
      r.b.onType = (n) => { if (n === N) c.move(r.b); };
      r.b.onPress = (x) => x.goTo(CONFIRMATION, confirmation());
      const a = await approved(r);
      a.approve();
      const res = await a.call;
      if (c.paid) {
        assert.equal(res.state, "paid", `${c.what}: ${res.text}`);
        assert.equal(r.b.typedInto("PF1", 0), TEST_CARDS.visa, `${c.what}: the number in its field`);
      } else {
        assert.deepEqual([res.state, res.text], ["stopped", PAY_TEXT.frameLoaded], c.what);
        assert.equal(r.b.typed.length, N, `${c.what}: no key after the number`);
        assert.deepEqual(r.b.presses, [], c.what);
      }
      await settle();
      cleanEnd(r, c.what);
    } finally { r.w.close(); }
  }
});
