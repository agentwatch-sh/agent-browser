// The pure rules of the payment act (contract C11, the card payment; the secure card checkout design, sections 8.5 to 8.7;
// board ab-sta.7, the plan's Task 5b): the guard's decision for a paused request (guard.ts), the result reader
// (result.ts) over the test merchant's pages (test/fixtures/pay-merchant/), the pay button and the save-card box
// (pay-act.ts). TEST values only: the providers' published test cards (pay-test-cards.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { holdsNumber, isProviderHost, payGuard } from "../src/service/pay/guard.ts";
import { isSaveBox, payButton, type ButtonRead } from "../src/service/pay/pay-act.ts";
import { baselineOf, orderNumberOf, otherAmountOf, readResult, type FrameView } from "../src/service/pay/result.ts";
import { PAY_TEXT } from "../src/service/pay/texts.ts";
import { merchantLines, merchantTitle } from "./pay-fill-fakes.ts";
import { TEST_CARD_VALUES, TEST_CARDS } from "./pay-test-cards.ts";

const N = TEST_CARDS.visa, AMEX = TEST_CARDS.amex;
const num = (n: string = N) => Buffer.from(n, "latin1");
const card = { number: num(), expiry: Buffer.from(TEST_CARD_VALUES.expiry) };
const groups = (n: string, sep: string) => n.match(/.{1,4}/g)!.join(sep);

// ---------------------------------------------------------------- the guard (design 8.6)

test("the guard's forms of the number: its digits, groups with spaces, dashes, + or %20, also percent-encoded; never the security code or the expiry alone", () => {
  for (const t of [N, `n=${N}`, groups(N, " "), groups(N, "-"), groups(N, "+"), groups(N, "%20"), `{"card":"${groups(N, " ")}"}`, encodeURIComponent(groups(N, " - ")), `x=${groups(N, "%2D")}`, `${N}9`]) {
    assert.ok(holdsNumber(t, num()), t.replace(/\d/g, "d"));
  }
  assert.ok(holdsNumber(`${AMEX.slice(0, 4)} ${AMEX.slice(4, 10)} ${AMEX.slice(10)}`, num(AMEX)), "an American Express number in its own groups");
  for (const t of [TEST_CARD_VALUES.csc, TEST_CARD_VALUES.expiry, `cvc=${TEST_CARD_VALUES.csc}&exp=${TEST_CARD_VALUES.expiry}`, N.slice(0, 15), groups(N, "/"), groups(N, ". "), "", N.slice(-4)]) {
    assert.ok(!holdsNumber(t, num()), `not the number: ${t.replace(/\d/g, "d")}`);
  }
  assert.ok(!holdsNumber(N, Buffer.alloc(16)), "a buffer of zeros (after the act's end) matches nothing");
});

test("the guard's decision: a URL with the number fails on every origin; a body with it fails outside the providers' origins and hosts; a body that Chrome does not give fails outside them; the provider's API gets it", () => {
  const body = (url: string, postData?: string, hasPostData = postData !== undefined) => payGuard({ url, method: "POST", ...(postData !== undefined ? { postData } : {}), hasPostData }, num());
  assert.deepEqual(payGuard({ url: `https://js.stripe.com/x?n=${N}` }, num()), { decision: "fail", number: true }, "a provider's URL with the number");
  assert.deepEqual(payGuard({ url: `https://shop.example.com/p/${groups(N, "-")}` }, num()), { decision: "fail", number: true });
  assert.deepEqual(body("https://api.stripe.com/v1/tokens", `card[number]=${N}`), { decision: "continue", number: false }, "a provider host (the listed host's own domain)");
  assert.deepEqual(body("https://js.stripe.com/collect", `n=${N}`), { decision: "continue", number: false }, "a provider origin");
  assert.deepEqual(body("https://shop.example.com/order", `{"n":"${groups(N, " ")}"}`), { decision: "fail", number: true }, "the shop never");
  assert.deepEqual(body("https://shop.example.com/order", undefined, true), { decision: "fail", number: false }, "a body that Chrome does not give");
  assert.deepEqual(body("https://api.stripe.com/v1/tokens", undefined, true), { decision: "continue", number: false }, "a provider's unread body");
  assert.deepEqual(body("https://shop.example.com/order", "qty=2"), { decision: "continue", number: false });
  assert.deepEqual(payGuard({ url: "https://shop.example.com/a.js" }, num()), { decision: "continue", number: false });
  // The test provider: only through the tests' option.
  assert.deepEqual(payGuard({ url: "http://pay.localhost:8080/charge", postData: `number=${N}`, hasPostData: true }, num()), { decision: "fail", number: true });
  assert.deepEqual(payGuard({ url: "http://pay.localhost:8080/charge", postData: `number=${N}`, hasPostData: true }, num(), ["http://pay.localhost:8080"]), { decision: "continue", number: false });
});

test("the provider hosts: a listed origin, or a host of the listed host's own domain with the same scheme; never a look-alike, another scheme or a bare suffix", () => {
  for (const o of ["https://js.stripe.com", "https://api.stripe.com", "https://stripe.com", "https://m.stripe.com", "https://api.braintreegateway.com", "https://paypal.com", "https://www.paypal.com"]) assert.ok(isProviderHost(o), o);
  for (const o of ["https://js.stripe.com.example.net", "http://api.stripe.com", "https://notstripe.com", "https://com", "https://shop.example.com", "https://api.stripe.com/v1", "nonsense", "https://localhost"]) assert.ok(!isProviderHost(o), o);
  assert.ok(isProviderHost("http://pay.localhost:8080", ["http://pay.localhost:8080"]));
  assert.ok(!isProviderHost("http://shop.localhost:8080", ["http://pay.localhost:8080"]), "localhost has no dot: only the exact test origin");
});

// ---------------------------------------------------------------- the result reader (design 8.7) over the test merchant's pages

const frame = (o: Partial<FrameView> & { key: string }): FrameView => ({ main: false, provider: false, url: "about:blank", title: "", lines: [], code: false, ...o });
const CHECKOUT = frame({ key: "main|F", main: true, url: "https://shop.example.com/checkout", lines: merchantLines("shop/checkout.html"), title: merchantTitle("shop/checkout.html") });
const PROVIDER = frame({ key: "S|PF", provider: true, url: "https://js.stripe.com/v3/fields", lines: merchantLines("pay/fields.html") });
const before = baselineOf([CHECKOUT, PROVIDER]);
const REQ = { amount: "51.00", currency: "USD", origin: "https://shop.example.com" };
const read = (frames: FrameView[], moved = false) => readResult({ request: REQ, card, moved, frames, before });

test("the result reader: the test merchant's confirmation is Paid with its order number; a fee at the press gives Paid, but ...; the confirmation with the last four digits takes its order number and no digit of the card", () => {
  const page = (file: string) => frame({ key: "main|F", main: true, url: `https://shop.example.com/${file.slice(5)}`, lines: merchantLines(file), title: merchantTitle(file) });
  assert.deepEqual(read([page("shop/confirmation.html")], true), { state: "paid", text: "Paid: 51.00 USD to https://shop.example.com, order SHOP-1001" });
  assert.deepEqual(read([page("shop/confirmation-fee.html")], true), { state: "paid", text: "Paid, but the merchant's confirmation shows 54.00 USD" });
  const last4 = { ...page("shop/confirmation-last4.html"), lines: ["Thank you for your order!", `Paid with Visa ending in ${N.slice(-4)}`, ...merchantLines("shop/confirmation-last4.html").slice(1)] };
  assert.deepEqual(read([last4], true), { state: "paid", text: "Paid: 51.00 USD to https://shop.example.com, order SHOP-1004" });
  // A confirmation with no new page (the same document): only the new lines count.
  const same = { ...CHECKOUT, lines: [...CHECKOUT.lines, "Thank you! Your order is confirmed.", "Confirmation number: TKT-88412"] };
  assert.deepEqual(read([same, PROVIDER]), { state: "paid", text: "Paid: 51.00 USD to https://shop.example.com, order TKT-88412" });
  // No new line names a confirmation: no end yet (the checkout's own words do not count).
  assert.equal(read([CHECKOUT, PROVIDER]), null);
  assert.equal(read([{ ...CHECKOUT, lines: [...CHECKOUT.lines, "Paying..."] }, PROVIDER]), null);
});

test("the result reader: the order number and the amount pass C11's digit filter, else the reader takes none (order number not found)", () => {
  assert.equal(orderNumberOf(["Order number: SHOP-1001"], card), "SHOP-1001");
  assert.equal(orderNumberOf([`Order number: ${N.slice(-4)}77`], card), null, "the last four digits");
  assert.equal(orderNumberOf([`Booking reference #${N.slice(2, 8)}`], card), null, "a run of the number's digits");
  assert.equal(orderNumberOf(["Order #12345"], card), "12345");
  assert.equal(orderNumberOf(["Thank you for your order!", "Order total: $51.00", "Order 2 items"], card), null);
  const lines = ["Thank you for your order!", `Order number: A${N.slice(-4)}`, "Amount charged: $51.00"];
  assert.deepEqual(readResult({ request: REQ, card, moved: true, frames: [frame({ key: "main|F", main: true, lines })], before }), { state: "paid", text: PAY_TEXT.paidNoNumber("51.00", "USD", "https://shop.example.com") });
  assert.equal(otherAmountOf(["Amount charged: $51.00", "Tax: $3.00"], REQ, card), null, "the approved amount; a tax is no total");
  assert.equal(otherAmountOf(["Total paid: €51.00"], REQ, card), "51.00 EUR", "another currency");
  assert.equal(otherAmountOf(["Total: USD 61.00"], REQ, card), "61.00 USD");
  assert.equal(otherAmountOf([`Total: $${N.slice(0, 4)}.00`], REQ, card), null, "an amount with four of the number's digits is not taken");
});

test("the result reader: Declined when the page stays and a new line of the page or of the provider frame names a decline; the bank's second step (a new frame of the test bank, a one-time code, a 3-D Secure URL) is Unknown at once; a 3-D Secure word that the checkout showed before the press is none", () => {
  const declined = { ...CHECKOUT, lines: [...CHECKOUT.lines, "Payment failed: your card was declined."] };
  assert.deepEqual(read([declined, PROVIDER]), { state: "declined", text: PAY_TEXT.declined });
  assert.deepEqual(read([CHECKOUT, { ...PROVIDER, lines: [...PROVIDER.lines, "Your card was declined."] }]), { state: "declined", text: PAY_TEXT.declined });
  assert.equal(read([{ ...CHECKOUT, url: "https://shop.example.com/error", lines: ["Your card was declined."] }], true), null, "a new page is no decline of the page that stays");
  const bank = frame({ key: "S2|B", url: "http://bank.localhost/3ds.html", lines: merchantLines("bank/3ds.html"), title: merchantTitle("bank/3ds.html") });
  assert.deepEqual(read([CHECKOUT, PROVIDER, bank]), { state: "unknown", text: PAY_TEXT.bankStep });
  assert.deepEqual(read([CHECKOUT, PROVIDER, frame({ key: "S3|X", url: "https://hooks.stripe.com/3d_secure_2/hosted?x=1" })]), { state: "unknown", text: PAY_TEXT.bankStep });
  assert.deepEqual(read([CHECKOUT, PROVIDER, frame({ key: "S4|Y", url: "https://acs.bank.example/challenge", code: true })]), { state: "unknown", text: PAY_TEXT.bankStep });
  assert.deepEqual(read([{ ...CHECKOUT, url: "https://secure.bank.example/verify", lines: ["Verify this payment"] }], true), { state: "unknown", text: PAY_TEXT.bankStep }, "a bank's page in place of the checkout");
  const secured = { ...CHECKOUT, lines: [...CHECKOUT.lines, "Secured by 3-D Secure"] };
  assert.equal(readResult({ request: REQ, card, moved: false, frames: [secured, PROVIDER], before: baselineOf([secured, PROVIDER]) }), null);
});

// ---------------------------------------------------------------- the pay button and the save-card box

test("the pay button: the submit button of the card fields' form, else a button that says pay, buy or place order, else the agent's hint; a wallet's button never; the hint picks among several", () => {
  const b = (i: number, text: string, o: Partial<ButtonRead> = {}): ButtonRead => ({ i, text, submit: false, cardForm: false, visible: true, enabled: true, ...o });
  assert.equal(payButton([b(0, "apply"), b(1, "pay $51.00")], null, true)?.i, 1);
  assert.equal(payButton([b(0, "apply", { submit: true }), b(1, "pay $51.00"), b(2, "continue", { submit: true, cardForm: true })], null, true)?.i, 2, "the card form's submit button first");
  assert.equal(payButton([b(0, "pay with paypal"), b(1, "apple pay"), b(2, "place order")], null, true)?.i, 2, "no wallet");
  assert.equal(payButton([b(0, "buy gift card"), b(1, "pay $51.00")], "pay $51", true)?.i, 1, "the hint among several");
  assert.equal(payButton([b(0, "finish")], "finish", true)?.i, 0, "the hint alone");
  assert.equal(payButton([b(0, "finish")], null, true), null);
  assert.equal(payButton([b(0, "pay $51.00", { enabled: false })], null, true), null, "a disabled button is no press");
  assert.equal(payButton([b(0, "pay $51.00", { enabled: false })], null, false)?.i, 0, "the check before the fill takes a button that the page turns on later");
  assert.equal(payButton([b(0, "pay $51.00", { visible: false })], null, false), null);
});

test("the save-card box: a label that says save, remember or keep the card; the test merchant's two labels", () => {
  for (const l of ["save this card for future purchases", "your card will be saved for future purchases", "remember my card", "keep my payment details on file", "store card for next time", "save for future use"]) assert.ok(isSaveBox(l), l);
  for (const l of ["i agree to the terms", "subscribe to the newsletter", "send me a receipt", "billing address same as shipping"]) assert.ok(!isSaveBox(l), l);
});
