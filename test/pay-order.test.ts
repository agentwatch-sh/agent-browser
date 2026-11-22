// The page's order, the digit filter and the providers' origins of the card payment (contract C11, the card payment;
// C12, the card payments: `pay_request`'s order and the page-order hash; the secure card checkout design, sections 3,
// 8.3, 8.4 and 8.7; board ab-sta.5, the plan's Task 4). The pure part of the order reader with page texts, the read in
// the act's world with a fake session, the hash against the vectors' `cardPay.orderHash`, and the filter with the
// providers' published test numbers (test/pay-test-cards.ts) only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { brandOf, luhn, refusesDigits, type CardView } from "../src/service/pay/digits.ts";
import { canonicalJson, cents, currencyFits, LINE_CHARS, ORDER_LINES, orderForRequest, orderHash, parseOrder, READ_ORDER, readOrder, type ActSession, type PageOrder } from "../src/service/pay/order.ts";
import { isProviderOrigin, PROVIDER_ORIGINS } from "../src/service/pay/providers.ts";
import { PAY_TEXT } from "../src/service/pay/texts.ts";
import { TEST_CARDS, TEST_CARD_VALUES } from "./pay-test-cards.ts";

const control = JSON.parse(readFileSync(new URL("./vectors/control.json", import.meta.url), "utf8"));
const card = (number: string = TEST_CARDS.visa, expiry: string = TEST_CARD_VALUES.expiry): CardView => ({ number: Buffer.from(number), expiry: Buffer.from(expiry) });
const page = (lines: string[], inputs: { autocomplete: string; type: string; value: string }[] = []) => ({ lines, inputs });
const NO_TOTAL = PAY_TEXT.noTotal;

// ---------------------------------------------------------------- the digit filter (C11)

test("C11's digit filter: the last four digits, a run of four or more of the number's digits in their order (also in groups), the expiry; other digits pass", () => {
  const c = card(TEST_CARDS.mastercard, "12/34");
  const last4 = TEST_CARDS.mastercard.slice(-4), mid = TEST_CARDS.mastercard.slice(5, 11);
  for (const t of [`Card ending in ${last4}`, `**** **** **** ${last4}`, `ref ${mid}`, `${TEST_CARDS.mastercard.slice(0, 4)} ${TEST_CARDS.mastercard.slice(4, 8)}`,
    `${TEST_CARDS.mastercard.slice(10, 12)}-${TEST_CARDS.mastercard.slice(12, 14)}`, "Expires 12/34", "exp. 12 / 2034", "valid thru 12-34"]) {
    assert.equal(refusesDigits(t, c), true, t);
  }
  for (const t of ["Order SHOP-1001", "Total: $51.00", "Two tickets", "", "12/35", "11/34", "Tax: 12.34", "Seat 1234 is no run of the number"]) {
    assert.equal(refusesDigits(t, c), t === "Seat 1234 is no run of the number" ? TEST_CARDS.mastercard.includes("1234") : false, t);
  }
  // Three digits of the number are no run of four.
  assert.equal(refusesDigits(`x ${last4.slice(1)} y`, c), false);
  // review-226 N2: an expiry right after another date part is found (the forms overlap: 01/12/34 holds 12/34).
  for (const t of ["01/12/34", "on 01/12/34", "01-12-34", "1/12/2034"]) assert.equal(refusesDigits(t, c), true, t);
  assert.equal(refusesDigits("01/12/35", c), false);
});

test("the check digit and the brand from the first digits (C12, the rules of a card)", () => {
  assert.equal(luhn(TEST_CARDS.visa), true);
  assert.equal(luhn(`${TEST_CARDS.visa.slice(0, -1)}${(Number(TEST_CARDS.visa.at(-1)) + 1) % 10}`), false);
  assert.equal(luhn(""), false);
  assert.equal(luhn("12a4"), false);
  assert.equal(brandOf(TEST_CARDS.visa), "visa");
  assert.equal(brandOf(TEST_CARDS.mastercard), "mastercard");
  assert.equal(brandOf(TEST_CARDS.mastercard2Series), "mastercard");
  assert.equal(brandOf(TEST_CARDS.amex), "amex");
  assert.equal(brandOf(TEST_CARDS.discover), "discover");
  assert.equal(brandOf(TEST_CARDS.jcb), "other");
});

// ---------------------------------------------------------------- the providers' origins (the design, section 8.4)

test("the providers' origins: whole origins of the shipped list; the test merchant's https://pay.localhost only through the tests' option", () => {
  assert.ok(PROVIDER_ORIGINS.length >= 5 && PROVIDER_ORIGINS.every((o) => new URL(o).origin === o && o.startsWith("https://")));
  assert.ok(isProviderOrigin("https://js.stripe.com"));
  for (const o of ["https://js.stripe.com.example.com", "https://js.stripe.com/v3", "http://js.stripe.com", "js.stripe.com", "", "https://evil.example"]) assert.equal(isProviderOrigin(o), false, o);
  assert.ok(!PROVIDER_ORIGINS.some((o) => o.includes("localhost")), "no test origin in the shipped list");
  assert.equal(isProviderOrigin("https://pay.localhost"), false);
  assert.equal(isProviderOrigin("https://pay.localhost", ["https://pay.localhost"]), true);
});

// ---------------------------------------------------------------- the page's order (the pure part)

test("several amounts on a page (subtotal, tax, fees, total): the reader takes the total line; the order lines are the other amounts", () => {
  const o = parseOrder(page(["Your cart", "Zoo entry – adult × 2: $48.00", "Service fee: $3.00", "Subtotal: $51.00", "Tax (8.25%): $4.21", "Total: $55.21", "Pay now"]), card()) as PageOrder;
  assert.deepEqual(o, { lines: ["Zoo entry – adult × 2: $48.00", "Service fee: $3.00", "Subtotal: $51.00", "Tax (8.25%): $4.21"], total: "55.21", currency: "$" });
  // The label and the amount in two columns (two lines of the page's text) are one line.
  const two = parseOrder(page(["Adult ticket", "$20.00", "Order total", "USD 20.00"]), card()) as PageOrder;
  assert.deepEqual(two, { lines: ["Adult ticket $20.00"], total: "20.00", currency: "USD" });
  // A total, a grand total and an amount due are totals; a total of the fees or a subtotal is none.
  assert.equal((parseOrder(page(["Total fees: $3.00", "Amount due: $9.00"]), card()) as PageOrder).total, "9.00");
  assert.equal((parseOrder(page(["Sub-total: €9,00", "Grand total: €10,50"]), card()) as PageOrder).total, "10.50");
  // The same total twice (a summary and its copy) is one total.
  assert.equal((parseOrder(page(["Total: $51.00", "Item: $51.00", "Total $51.00"]), card()) as PageOrder).total, "51.00");
  // Thousands.
  assert.equal((parseOrder(page(["Total: $1,234.50"]), card()) as PageOrder).total, "1234.50");
});

test("two candidate totals stop with C11's text, and so do no total and a total with no currency on the page", () => {
  for (const lines of [
    ["Total: $51.00", "Total: $54.00"],
    ["Total: $51.00 (was $60.00)"],
    ["Total: $51.00", "Total: €51.00"],
    ["Subtotal: $51.00", "Pay $51.00"],
    ["Total: 51.00"],
    [],
  ]) assert.deepEqual(parseOrder(page(lines), card()), { stop: NO_TOTAL }, JSON.stringify(lines));
  assert.equal(NO_TOTAL, "The agent browser cannot read the total of this checkout.");
});

test("a countdown, a hold timer or a banner is no part of the order: the hash is the same; a changed line, total or delivery changes it", () => {
  const base = ["Concert ticket: $35.00", "Total: $35.00", "Email: ann@example.com"];
  const read = (extra: string[]) => orderForRequest(parseOrder(page([...extra, ...base]), card()) as PageOrder, { amount: "35.00", currency: "USD" }, card());
  const h = (extra: string[]) => orderHash(read(extra) as any);
  const first = h(["Your tickets are held for 09:59", "Hurry! Only a few seats left"]);
  assert.equal(h(["Your tickets are held for 09:58", "Hurry! Only a few seats left"]), first, "a countdown");
  assert.equal(h(["Your tickets are held for 9 min 3 s", "Sale ends soon"]), first, "a banner and a timer");
  assert.notEqual(orderHash(orderForRequest(parseOrder(page(["Concert ticket (VIP): $35.00", ...base.slice(1)]), card()) as PageOrder, { amount: "35.00", currency: "USD" }, card()) as any), first, "a changed line");
  assert.notEqual(orderHash(orderForRequest(parseOrder(page([...base.slice(0, 2), "Email: bob@example.com"]), card()) as PageOrder, { amount: "35.00", currency: "USD" }, card()) as any), first, "another delivery email");
  const other = orderForRequest(parseOrder(page(["Concert ticket: $35.00", "Total: $36.00"]), card()) as PageOrder, { amount: "36.00", currency: "USD" }, card());
  assert.notEqual(orderHash(other as any), first, "another total");
});

test("the delivery name and email: from the inputs or from labelled lines; none when the page shows none; a support address is no delivery", () => {
  const withInputs = parseOrder(page(["Total: $5.00"], [{ autocomplete: "name", type: "text", value: "Ann Example" }, { autocomplete: "email", type: "email", value: "ann@example.com" }]), card()) as PageOrder;
  assert.deepEqual(withInputs.delivery, { name: "Ann Example", email: "ann@example.com" });
  const lines = parseOrder(page(["Deliver to: Ann Example", "Tickets will be sent to ann@example.com", "Total: $5.00"]), card()) as PageOrder;
  assert.deepEqual(lines.delivery, { name: "Ann Example", email: "ann@example.com" });
  const none = parseOrder(page(["Questions? help@example.com", "Total: $5.00"]), card()) as PageOrder;
  assert.equal(none.delivery, undefined);
  assert.ok(!Object.hasOwn(none, "delivery"), "no delivery key");
});

test("the filter in the order: a line, a name or an email that holds the card's last four digits, a run of its digits or its expiry is dropped", () => {
  const n = TEST_CARDS.visa;
  const o = parseOrder(page([`Saved card •••• ${n.slice(-4)}: $0.00`, `Ref ${n.slice(0, 4)}-${n.slice(4, 8)}: $1.00`, `Card exp ${TEST_CARD_VALUES.expiry}: $0.00`, "Ticket: $5.00", "Total: $5.00", `Name: Ann ${n.slice(-4)}`]), card()) as PageOrder;
  assert.deepEqual(o.lines, ["Ticket: $5.00"]);
  assert.equal(o.delivery, undefined);
});

test("C12: no order line holds a URL path or a query: a line with a URL is dropped, also a host and a path with no scheme (review-226 N1), and a bare path", () => {
  const o = parseOrder(page(["Ticket: $5.00", "Receipt https://shop.example.com/r/9: $5.00", "Change at /cart?item=2: $0.00", "Manage at shop.example.com/orders/7f3a: $0.00",
    "See www.example.org:8443/a: $0.00", "Open /orders/7f3a/receipt: $0.00", "Adult/Child ticket: $1.00", "Per person / per day: $2.00", "Total: $5.00"]), card()) as PageOrder;
  assert.deepEqual(o.lines, ["Ticket: $5.00", "Adult/Child ticket: $1.00", "Per person / per day: $2.00"]);
});

test("C12's bounds: at most 50 order lines of at most 200 characters each (a surrogate pair is never cut)", () => {
  const many = Array.from({ length: 70 }, (_, i) => `Item ${i}: $1.00`);
  const o = parseOrder(page([...many, "Total: $70.00"]), card()) as PageOrder;
  assert.equal(o.lines.length, ORDER_LINES);
  assert.equal(o.lines[0], "Item 0: $1.00");
  const long = parseOrder(page([`${"x".repeat(199)}\u{1f600} more words: $1.00`, "Total: $1.00"]), card()) as PageOrder;
  assert.ok(long.lines[0].length <= LINE_CHARS && !/[\ud800-\udbff]$/.test(long.lines[0]));
  assert.equal(long.lines[0], "x".repeat(199));
});

test("the order of the request: the page's total must be the request's amount in its currency (a symbol that fits it), else C11's text; total and currency are the request's", () => {
  const o = parseOrder(page(["Ticket: $12.50", "Total: $12.50"]), card()) as PageOrder;
  assert.deepEqual(orderForRequest(o, { amount: "12.5", currency: "USD" }, card()), { lines: ["Ticket: $12.50"], total: "12.5", currency: "USD" });
  assert.deepEqual(orderForRequest(o, { amount: "12.50", currency: "CAD" }, card()), { lines: ["Ticket: $12.50"], total: "12.50", currency: "CAD" }, "$ fits CAD too");
  assert.deepEqual(orderForRequest(o, { amount: "12.51", currency: "USD" }, card()), { stop: "The checkout's total is not 12.51 USD." });
  assert.deepEqual(orderForRequest(o, { amount: "12.50", currency: "EUR" }, card()), { stop: "The checkout's total is not 12.50 EUR." });
  assert.equal(PAY_TEXT.otherTotal("12.51", "USD"), "The checkout's total is not 12.51 USD.");
  assert.equal(currencyFits("USD", "USD"), true);
  assert.equal(currencyFits("€", "EUR"), true);
  assert.equal(currencyFits("EUR", "USD"), false);
  assert.equal(cents("0.05"), 5);
  assert.equal(cents("12"), 1200);
  assert.equal(cents("1.234"), null);
});

// ---------------------------------------------------------------- the page-order hash (C12)

test("the page-order hash is C12's: the vectors' cardPay.orderHash, and the order with another line", () => {
  const v = control.cardPay.orderHash;
  assert.equal(orderHash(v.order), v.hash);
  assert.equal(orderHash(v.otherLine.order), v.otherLine.hash);
  // Sorted keys at each level, compact, no ASCII escape; no delivery key when the page shows none.
  assert.equal(canonicalJson({ b: 1, a: { d: "é", c: [2, 1] } }), '{"a":{"c":[2,1],"d":"é"},"b":1}');
  const { delivery: _, ...noDelivery } = v.order;
  assert.equal(orderHash({ ...noDelivery, delivery: undefined }), orderHash(noDelivery));
  assert.equal(orderHash({ ...noDelivery, delivery: {} }), orderHash(noDelivery));
  assert.match(orderHash(v.order), /^[0-9a-f]{64}$/);
});

// ---------------------------------------------------------------- the read in the act's world

test("readOrder: one evaluation of READ_ORDER in the act's session, then the pure part; a read of another shape cannot give the total", async () => {
  const seen: string[] = [];
  const session = (answer: unknown): ActSession => ({ evaluate: async <T>(e: string) => { seen.push(e); return answer as T; } });
  const o = await readOrder(session({ lines: ["Ticket: $5.00", "Total: $5.00"], inputs: [] }), card());
  assert.deepEqual(o, { lines: ["Ticket: $5.00"], total: "5.00", currency: "$" });
  assert.equal(seen.length, 1);
  assert.ok(seen[0].startsWith("(/*aw-pay:order*/"), "the read's tag");
  assert.equal(seen[0], `(${READ_ORDER})()`);
  for (const bad of [null, "text", { lines: "x", inputs: [] }, { lines: [1], inputs: [] }, { lines: [], inputs: [{ value: 1 }] }]) {
    assert.deepEqual(await readOrder(session(bad), card()), { stop: NO_TOTAL }, JSON.stringify(bad));
  }
  // The read takes no card field: an input whose autocomplete starts with cc- is skipped in the page.
  assert.ok(READ_ORDER.includes("/cc-/.test(autocomplete)"));
});

test("board ab-sta.8: each provider has its frame origins and its API origins (a first value); PROVIDER_ORIGINS are the frames only; providerOf names the one provider of a frame origin, never of an API origin; providerHosts gives its frames, then its API", async () => {
  const { PROVIDERS, providerOf, providerHosts } = await import("../src/service/pay/providers.ts");
  const names = PROVIDERS.map((p) => p.name);
  assert.equal(new Set(names).size, names.length, "one entry for each provider");
  for (const p of PROVIDERS) {
    for (const o of [...p.frames, ...p.api]) assert.ok(new URL(o).origin === o && o.startsWith("https://") && !o.includes("localhost"), `${p.name}: ${o}`);
    assert.ok(p.frames.length > 0, `${p.name}: its frames`);
    assert.ok(Object.isFrozen(p) && Object.isFrozen(p.frames) && Object.isFrozen(p.api));
  }
  assert.deepEqual([...PROVIDER_ORIGINS], PROVIDERS.flatMap((p) => p.frames), "PROVIDER_ORIGINS: the frames only");
  const stripe = providerOf("https://js.stripe.com")!;
  assert.equal(stripe.name, "stripe");
  assert.ok(stripe.api.includes("https://api.stripe.com"));
  assert.deepEqual(providerHosts(stripe), ["https://js.stripe.com", "https://checkout.stripe.com", "https://buy.stripe.com", "https://api.stripe.com", "https://m.stripe.network", "https://hooks.stripe.com", "https://m.stripe.com"]);
  assert.equal(providerOf("https://assets.braintreegateway.com")!.name, "braintree");
  assert.equal(providerOf("https://api.stripe.com"), null, "an API origin is no frame's origin");
  assert.equal(isProviderOrigin("https://api.stripe.com"), false);
  assert.equal(providerOf("http://pay.localhost:8080"), null, "the test provider only through the tests' options");
  assert.deepEqual(providerOf("http://pay.localhost:8080", ["http://pay.localhost:8080"], ["http://payapi.localhost:8080"]), { name: "test", frames: ["http://pay.localhost:8080"], api: ["http://payapi.localhost:8080"] });
  // Adyen's secured fields call their own origins: no API origin of its own, and no duplicate in its hosts.
  const adyen = providerOf("https://checkoutshopper-live.adyen.com")!;
  assert.deepEqual(providerHosts(adyen), [...adyen.frames]);
});

test("board ab-sta.13: Stripe's list after the look at its public test pages: buy.stripe.com (a Payment Link's hosted page, its card fields in its main frame) is a frame origin; m.stripe.com (where the fraud frame of m.stripe.network posts) is an API origin", async () => {
  const { PROVIDERS, providerOf, providerHosts } = await import("../src/service/pay/providers.ts");
  const stripe = PROVIDERS.find((p) => p.name === "stripe")!;
  assert.deepEqual([...stripe.frames], ["https://js.stripe.com", "https://checkout.stripe.com", "https://buy.stripe.com"]);
  assert.deepEqual([...stripe.api], ["https://api.stripe.com", "https://m.stripe.network", "https://hooks.stripe.com", "https://m.stripe.com"]);
  assert.ok(isProviderOrigin("https://buy.stripe.com"), "a Payment Link's hosted page is a provider's hosted page (C11, check 6)");
  assert.equal(providerOf("https://buy.stripe.com")?.name, "stripe");
  assert.equal(isProviderOrigin("https://m.stripe.com"), false, "an API origin is no frame's origin");
  assert.deepEqual(providerHosts(stripe), ["https://js.stripe.com", "https://checkout.stripe.com", "https://buy.stripe.com", "https://api.stripe.com", "https://m.stripe.network", "https://hooks.stripe.com", "https://m.stripe.com"]);
  // The look found these origins on the pages too; they carry no payment (telemetry, error reports, Link's cookies,
  // images, a captcha's and a map's third parties), so the list leaves them out and the act's rules block them.
  for (const o of ["https://r.stripe.com", "https://errors.stripe.com", "https://merchant-ui-api.stripe.com", "https://checkout-cookies.stripe.com", "https://b.stripecdn.com", "https://img.stripecdn.com", "https://hcaptcha.com", "https://api.hcaptcha.com", "https://maps.googleapis.com"]) {
    assert.ok(!providerHosts(stripe).includes(o), o);
  }
});
