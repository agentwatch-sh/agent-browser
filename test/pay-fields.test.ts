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

test("roleOf and findCardFields: a field of the shipping section is no card field (board ab-sta.13: Stripe's real pages show a shipping address with `shipping postal-code` beside the card), so the card's postal code goes only to the billing one", () => {
  assert.equal(roleOf(f(0, { autocomplete: "shipping postal-code", label: "zip" }), true), null);
  assert.equal(roleOf(f(0, { autocomplete: "section-a shipping postal-code" }), true), null);
  assert.equal(roleOf(f(0, { autocomplete: "shipping cc-name" }), true), null, "a shipping token names no card value");
  assert.equal(roleOf(f(0, { autocomplete: "billing postal-code", label: "zip" }), true), "postal");
  assert.equal(roleOf(f(0, { autocomplete: "postal-code" }), true), "postal");
  // The order of Stripe's hosted page (a Payment Link with a shipping address, measured on the Linux server): the
  // shipping address first, then the card, then the billing name, country and ZIP.
  const hosted = frame("https://buy.stripe.com", [
    f(0, { autocomplete: "email" }), f(1, { autocomplete: "shipping name" }), f(2, { tag: "select", type: "select", autocomplete: "shipping country" }),
    f(3, { autocomplete: "shipping address-line1" }), f(4, { autocomplete: "shipping postal-code", label: "zip" }),
    f(5, { autocomplete: "cc-number" }), f(6, { autocomplete: "cc-exp" }), f(7, { autocomplete: "cc-csc" }), f(8, { autocomplete: "cc-name" }),
    f(9, { tag: "select", type: "select", autocomplete: "billing country" }), f(10, { autocomplete: "billing postal-code", label: "zip" }),
  ], true);
  assert.deepEqual(findCardFields([hosted]), { number: { frame: 0, field: 5 }, csc: { frame: 0, field: 7 }, expiry: { frame: 0, field: 6 }, name: { frame: 0, field: 8 }, postal: { frame: 0, field: 10 } });
  // A shipping address on the merchant's own page beside a provider frame: no card field there, no stop.
  const shop = shopPage([f(0, { autocomplete: "shipping postal-code", label: "zip" }), f(1, { autocomplete: "shipping name" })]);
  const card = frame("https://js.stripe.com", [f(0, { autocomplete: "cc-number" }), f(1, { autocomplete: "cc-exp" }), f(2, { autocomplete: "cc-csc" })]);
  assert.deepEqual(findCardFields([shop, card]), { number: { frame: 1, field: 0 }, expiry: { frame: 1, field: 1 }, csc: { frame: 1, field: 2 } });
});

test("roleOf and findCardFields: a shipping token takes away only a role that is no card field's (review-231 N1): `shipping cc-number` keeps its card role, so it stops on the shop's own page", () => {
  for (const [ac, role] of [["shipping cc-number", "number"], ["shipping cc-exp", "expiry"], ["shipping cc-exp-month", "expMonth"], ["shipping cc-exp-year", "expYear"], ["shipping cc-csc", "csc"], ["section-a shipping cc-number", "number"]] as const) {
    assert.equal(roleOf(f(0, { autocomplete: ac })), role, ac);
    assert.equal(roleOf(f(0, { autocomplete: ac }), true), role, `${ac} in a provider frame`);
  }
  assert.equal(roleOf(f(0, { autocomplete: "shipping cc-name" }), true), null, "the name is no card field's role");
  assert.equal(roleOf(f(0, { autocomplete: "shipping postal-code" }), true), null, "the postal code is no card field's role");
  const provider = frame("https://js.stripe.com", [f(0, { autocomplete: "cc-number" }), f(1, { autocomplete: "cc-exp" }), f(2, { autocomplete: "cc-csc" })]);
  for (const ac of ["shipping cc-number", "shipping cc-exp", "shipping cc-csc"]) {
    assert.deepEqual(findCardFields([shopPage([f(5, { autocomplete: ac, label: "card number" })]), provider]), { stop: PAY_TEXT.fields }, `C11's stop for ${ac} on the shop's page`);
  }
});

test("roleOf and findCardFields: a name or a postal code whose labels or names say shipping or delivery is the delivery address's (review-231 N2), so a billing ZIP after a shipping ZIP gets the card's postal code", () => {
  const shipping = [f(3, { label: "shipping zip" }), f(3, { name: "shipping_postal_code" }), f(3, { autocomplete: "postal-code", label: "shipping zip" }), f(3, { id: "delivery-postcode" }), f(3, { label: "delivery zip code" })];
  for (const s of shipping) assert.equal(roleOf(s, true), null, JSON.stringify(s));
  assert.equal(roleOf(f(0, { name: "shipping_cc_name" }), true), null, "a name by its name");
  assert.equal(roleOf(f(0, { autocomplete: "cc-name", label: "delivery name" }), true), null, "a name by autocomplete with a delivery label");
  // The other fields keep their roles: a billing or plain ZIP, a card field with such a word.
  assert.equal(roleOf(f(0, { label: "billing zip" }), true), "postal");
  assert.equal(roleOf(f(0, { label: "zip" }), true), "postal");
  assert.equal(roleOf(f(0, { label: "name on card" }), true), "name");
  assert.equal(roleOf(f(0, { name: "delivery_card_number" }), true), "number", "a card role is no address's");
  for (const s of shipping) {
    const card = frame("https://js.stripe.com", [f(0, { autocomplete: "cc-number" }), f(1, { autocomplete: "cc-exp" }), f(2, { autocomplete: "cc-csc" }), s, f(4, { label: "billing zip" })]);
    assert.deepEqual(findCardFields([shopPage(), card]), { number: { frame: 1, field: 0 }, expiry: { frame: 1, field: 1 }, csc: { frame: 1, field: 2 }, postal: { frame: 1, field: 4 } }, JSON.stringify(s));
  }
});

test("findCardFields: a field whose autocomplete gives the role wins over a field that only its label or name matches (review-231 N3: a merchant's custom fields on a provider's hosted page)", () => {
  // A Payment Link's hosted page with the merchant's custom fields first, then Stripe's own fields.
  const hosted = frame("https://buy.stripe.com", [
    f(0, { autocomplete: "email" }), f(1, { label: "card number" }), f(2, { label: "security code" }), f(3, { label: "expiry date" }), f(4, { label: "name on card" }), f(5, { label: "zip code" }),
    f(6, { autocomplete: "cc-number" }), f(7, { tag: "select", type: "select", autocomplete: "cc-exp-month" }), f(8, { tag: "select", type: "select", autocomplete: "cc-exp-year" }),
    f(9, { autocomplete: "cc-csc" }), f(10, { autocomplete: "cc-name" }), f(11, { autocomplete: "billing postal-code" }),
  ], true);
  assert.deepEqual(findCardFields([hosted]), { number: { frame: 0, field: 6 }, expMonth: { frame: 0, field: 7 }, expYear: { frame: 0, field: 8 }, csc: { frame: 0, field: 9 }, name: { frame: 0, field: 10 }, postal: { frame: 0, field: 11 } });
  // An expiry by autocomplete wins over a month and a year by label; with no autocomplete for a role, its label counts.
  const mixed = frame("https://buy.stripe.com", [f(0, { label: "card number" }), f(1, { name: "exp_month" }), f(2, { name: "exp_year" }), f(3, { autocomplete: "cc-exp" }), f(4, { label: "cvc" })], true);
  assert.deepEqual(findCardFields([mixed]), { number: { frame: 0, field: 0 }, expiry: { frame: 0, field: 3 }, csc: { frame: 0, field: 4 } });
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
