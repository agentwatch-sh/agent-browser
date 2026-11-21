// The card fields' finder (contract C11, the card payment: "Card fields outside a provider frame", "No payment step";
// the secure card checkout design, section 8.4; board ab-sta.6, the plan's Task 5a): by autocomplete, then by labels and
// names; only provider frames; a card field on the merchant's own page or in a frame of another origin stops. Pure: the
// frames are reads as READ_FIELDS gives them. No value of a field is read: the finder has none.

import { test } from "node:test";
import assert from "node:assert/strict";
import { asksCheck, findCardFields, READ_FIELDS, roleOf, type ActFrame, type FieldRead } from "../src/service/pay/fields.ts";
import { PAY_TEXT } from "../src/service/pay/texts.ts";

const f = (i: number, o: Partial<FieldRead> = {}): FieldRead => ({ i, tag: "input", type: "text", visible: true, enabled: true, autocomplete: "", name: "", id: "", label: "", ...o });
const SHOP = "https://shop.example.com";
const frame = (origin: string, fields: FieldRead[], main = false): ActFrame => ({ origin, main, fields });
const shopPage = (fields: FieldRead[] = [f(0, { autocomplete: "email", type: "email" })]) => frame(SHOP, fields, true);

test("findCardFields: by autocomplete in one provider frame (a card element): the number, the expiry, the security code, and the postal code", () => {
  const card = frame("https://js.stripe.com", [f(0, { autocomplete: "cc-number" }), f(1, { autocomplete: "cc-exp" }), f(2, { autocomplete: "cc-csc" }), f(3, { autocomplete: "billing postal-code" })]);
  assert.deepEqual(findCardFields([shopPage(), card]), { number: { frame: 1, field: 0 }, expiry: { frame: 1, field: 1 }, csc: { frame: 1, field: 2 }, postal: { frame: 1, field: 3 } });
});

test("findCardFields: one field in each provider frame (hosted fields), a month and a year, and the name by its label", () => {
  const frames = [
    shopPage(),
    frame("https://assets.braintreegateway.com", [f(0, { name: "credit-card-number" })]),
    frame("https://assets.braintreegateway.com", [f(0, { tag: "select", type: "select", label: "expiration month" })]),
    frame("https://assets.braintreegateway.com", [f(0, { tag: "select", type: "select", id: "expiration-year" })]),
    frame("https://assets.braintreegateway.com", [f(0, { type: "password", label: "cvv" })]),
    frame("https://assets.braintreegateway.com", [f(0, { label: "name on card" })]),
  ];
  assert.deepEqual(findCardFields(frames), { number: { frame: 1, field: 0 }, expMonth: { frame: 2, field: 0 }, expYear: { frame: 3, field: 0 }, csc: { frame: 4, field: 0 }, name: { frame: 5, field: 0 } });
  // In a provider frame only: a bare month and year.
  const bare = [shopPage(), frame("https://web.squarecdn.com", [f(0, { autocomplete: "cc-number" }), f(1, { tag: "select", type: "select", name: "month" }), f(2, { tag: "select", type: "select", name: "year" }), f(3, { autocomplete: "cc-csc" })])];
  assert.deepEqual(findCardFields(bare), { number: { frame: 1, field: 0 }, expMonth: { frame: 1, field: 1 }, expYear: { frame: 1, field: 2 }, csc: { frame: 1, field: 3 } });
  assert.equal(roleOf(f(0, { name: "month" })), null, "on the merchant's page a month is no card field (a date of birth)");
});

test("findCardFields: the main frame of a provider's hosted payment page is a provider frame; the test provider counts only with the test option", () => {
  const hosted = frame("https://checkout.stripe.com", [f(0, { autocomplete: "email" }), f(1, { autocomplete: "cc-number" }), f(2, { autocomplete: "cc-exp" }), f(3, { autocomplete: "cc-csc" })], true);
  assert.deepEqual(findCardFields([hosted]), { number: { frame: 0, field: 1 }, expiry: { frame: 0, field: 2 }, csc: { frame: 0, field: 3 } });
  const test = [shopPage(), frame("https://pay.localhost", [f(0, { autocomplete: "cc-number" }), f(1, { autocomplete: "cc-exp" }), f(2, { autocomplete: "cc-csc" })])];
  assert.deepEqual(findCardFields(test), { stop: PAY_TEXT.fields }, "not a provider without the option");
  assert.ok(!("stop" in findCardFields(test, ["https://pay.localhost"])));
});

test("findCardFields: a card field on the merchant's own page, in a same-origin frame or in a frame of another origin stops with C11's text; a name or a postal code there is the merchant's own form", () => {
  const provider = frame("https://js.stripe.com", [f(0, { autocomplete: "cc-number" }), f(1, { autocomplete: "cc-exp" }), f(2, { autocomplete: "cc-csc" })]);
  for (const bad of [f(5, { autocomplete: "cc-number" }), f(5, { autocomplete: "billing cc-exp" }), f(5, { autocomplete: "cc-csc" }), f(5, { name: "card_number" }), f(5, { label: "security code" }), f(5, { id: "expiry-date" }), f(5, { label: "mm / yy" })]) {
    assert.deepEqual(findCardFields([shopPage([bad]), provider]), { stop: "This checkout's card fields are not in a known payment provider's frame" }, JSON.stringify(bad));
  }
  assert.deepEqual(findCardFields([shopPage(), frame(SHOP, [f(0, { autocomplete: "cc-number" })]), provider]), { stop: PAY_TEXT.fields }, "a same-origin frame");
  assert.deepEqual(findCardFields([shopPage(), frame("https://js.stripe.com.example.net", [f(0, { autocomplete: "cc-number" })]), provider]), { stop: PAY_TEXT.fields }, "a look-alike origin");
  assert.deepEqual(findCardFields([shopPage(), frame("null", [f(0, { autocomplete: "cc-csc" })]), provider]), { stop: PAY_TEXT.fields }, "an opaque frame");
  // The merchant's own name, postal code, gift card and promo code fields are no card fields.
  const own = shopPage([f(0, { autocomplete: "shipping name" }), f(1, { autocomplete: "postal-code" }), f(2, { label: "zip code" }), f(3, { label: "gift card number" }), f(4, { name: "promo_code" }), f(5, { label: "name on card" }), f(6, { autocomplete: "one-time-code" })]);
  assert.ok(!("stop" in findCardFields([own, provider])));
});

test("findCardFields: no number, no expiry or no security code in provider frames is no payment step; hidden, disabled and type-hidden fields count for nothing", () => {
  const p = "https://js.stripe.com";
  assert.deepEqual(findCardFields([shopPage()]), { stop: "This checkout cannot move to the payment act" });
  assert.deepEqual(findCardFields([shopPage(), frame(p, [f(0, { autocomplete: "cc-number" }), f(1, { autocomplete: "cc-exp" })])]), { stop: PAY_TEXT.noPaymentStep }, "no security code");
  assert.deepEqual(findCardFields([shopPage(), frame(p, [f(0, { autocomplete: "cc-number" }), f(1, { autocomplete: "cc-exp-month" }), f(2, { autocomplete: "cc-csc" })])]), { stop: PAY_TEXT.noPaymentStep }, "a month with no year");
  const hidden = shopPage([f(0, { autocomplete: "cc-number", visible: false }), f(1, { autocomplete: "cc-csc", enabled: false }), f(2, { type: "hidden", name: "card_number" })]);
  assert.deepEqual(findCardFields([hidden]), { stop: PAY_TEXT.noPaymentStep }, "the merchant's hidden fields neither stop nor count");
});

test("roleOf: autocomplete first (its last token), then labels and names; an autocomplete of another value has no role", () => {
  assert.equal(roleOf(f(0, { autocomplete: "section-pay billing cc-number", label: "postal code" })), "number");
  assert.equal(roleOf(f(0, { autocomplete: "email", label: "card number" })), null);
  assert.equal(roleOf(f(0, { autocomplete: "off", name: "cardnumber" })), "number");
  assert.equal(roleOf(f(0, { name: "encryptedcardnumber" })), "number");
  assert.equal(roleOf(f(0, { label: "cvc" })), "csc");
  assert.equal(roleOf(f(0, { label: "expiration date (mm/yy)" })), "expiry");
  assert.equal(roleOf(f(0, { name: "exp_month" })), "expMonth");
  assert.equal(roleOf(f(0, { name: "exp_year" })), "expYear");
  assert.equal(roleOf(f(0, { label: "cardholder name" })), "name");
  assert.equal(roleOf(f(0, { label: "experience" })), null);
  assert.equal(roleOf(f(0, { label: "phone number" })), null);
  assert.equal(roleOf(f(0, { type: "checkbox", label: "save card number" })), null);
});

test("asksCheck: a password field that is no card field, or a one-time code, on the main frame is a check at the payment step", () => {
  assert.equal(asksCheck([f(0, { type: "password" })]), true);
  assert.equal(asksCheck([f(0, { autocomplete: "one-time-code" })]), true);
  assert.equal(asksCheck([f(0, { type: "password", label: "cvv" })]), false, "a hosted page's security code");
  assert.equal(asksCheck([f(0, { type: "password", visible: false })]), false);
  assert.equal(asksCheck([f(0, { type: "email" })]), false);
});

test("READ_FIELDS reads attributes and labels only: no value of a field, and its tag", () => {
  assert.ok(READ_FIELDS.startsWith("/*aw-pay:fields*/"));
  assert.ok(!/\.value\b/.test(READ_FIELDS), "no field's value");
});
