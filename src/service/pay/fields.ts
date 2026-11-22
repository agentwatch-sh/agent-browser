// The card fields of the act page (contract C11, the card payment; the secure card checkout design, section 8.4; board
// ab-sta.6, the plan's Task 5a). The act fills card fields only inside a provider frame: a frame of the act page whose
// origin is on the list of payment providers' origins (providers.ts). The finder goes by the origin alone; in the act the
// main frame is always the merchant's page of the request's origin (a provider's hosted payment page stops: board
// ab-sta.14, review-232 B1 and N1), so the act's provider frames are frames inside the merchant's page. READ_FIELDS reads
// one frame's fields in the act's own isolated world of that frame (no key, no value: only the attributes and the
// labels); findCardFields is pure, so the unit tests drive it with frame reads. Task 5b uses the same finder after the
// approval.
//
// - The roles: by `autocomplete` first (`cc-number`, `cc-exp`, `cc-exp-month`, `cc-exp-year`, `cc-csc`, `cc-name`,
//   `postal-code`), then by the field's labels and names (its label text, `aria-label`, `placeholder`, `name`, `id`). For
//   each role a field by `autocomplete` wins over a field by labels and names. A field of the delivery address (the
//   `shipping` token, or a name or a postal code whose words say shipping or delivery) has no role that is no card
//   field's (review-231 N1 and N2).
// - A card field (the number, the expiry, its month or year, the security code) on the merchant's own page or in a frame
//   whose origin is not a provider origin stops with C11's text "This checkout's card fields are not in a known payment
//   provider's frame". A name or a postal code outside a provider frame is the merchant's own form (a delivery address),
//   and it is no card field.
// - The fields: the number, an expiry (one field, or a month and a year) and the security code, each in a provider frame.
//   A page with no such set is no payment step.

import { isProviderOrigin } from "./providers.ts";
import { PAY_TEXT } from "./texts.ts";

/** The tag at the start of each read of the pay act, so that a test's fake page can tell them apart. */
export const PAY_TAG = (name: string) => `/*aw-pay:${name}*/`;

/** One field of a frame as READ_FIELDS gives it: never its value. */
export type FieldRead = {
  /** Its index among the frame's `input` and `select` elements, in document order (Task 5b finds it again by it). */
  i: number;
  tag: "input" | "select";
  type: string;
  visible: boolean;
  enabled: boolean;
  autocomplete: string;
  name: string;
  id: string;
  /** Its labels' text, its `aria-label` and its `placeholder`, in lower case, at most 200 characters. */
  label: string;
};
/** One frame of the act page: its origin, the main frame or not, and its fields (`session` and `frameId` are the act's handles). */
export type ActFrame = { origin: string; main: boolean; fields: FieldRead[]; session?: string; frameId?: string };
/** A field of the card: its frame (an index of the finder's list) and its index in that frame. */
export type FieldAt = { frame: number; field: number };
export type CardRole = "number" | "expiry" | "expMonth" | "expYear" | "csc" | "name" | "postal";
/** The card fields that the act fills: the number, an expiry (one field, or a month and a year), the security code; the name and the postal code when a provider frame has them. */
export type CardFields = { number: FieldAt; csc: FieldAt; expiry?: FieldAt; expMonth?: FieldAt; expYear?: FieldAt; name?: FieldAt; postal?: FieldAt };

/** The roles that make a card field: one of them outside a provider frame stops the request (and frames of two providers with one: act.ts). */
export const CARD_ROLES: readonly CardRole[] = ["number", "expiry", "expMonth", "expYear", "csc"];

/** The read of one frame's fields, in the act's own isolated world of the frame: attributes and labels, no value. */
export const READ_FIELDS = `${PAY_TAG("fields")} () => {
  const vis = (el) => { const r = el.getBoundingClientRect(); if (r.width <= 0 || r.height <= 0) return false; const cs = getComputedStyle(el); return cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0; };
  const text = (s) => String(s || "").replace(/\\s+/g, " ").trim().toLowerCase();
  const labelOf = (el) => {
    const parts = [];
    try { for (const l of el.labels || []) parts.push(l.textContent); } catch (e) {}
    const by = el.getAttribute("aria-labelledby");
    if (by) for (const id of by.split(/\\s+/)) { const n = document.getElementById(id); if (n) parts.push(n.textContent); }
    parts.push(el.getAttribute("aria-label"), el.getAttribute("placeholder"));
    return text(parts.filter(Boolean).join(" ")).slice(0, 200);
  };
  return [...document.querySelectorAll("input, select")].slice(0, 300).map((el, i) => ({
    i, tag: el.tagName === "SELECT" ? "select" : "input", type: text(el.tagName === "SELECT" ? "select" : (el.getAttribute("type") || "text")),
    visible: vis(el), enabled: !el.disabled && !el.readOnly, autocomplete: text(el.getAttribute("autocomplete")),
    name: text(el.getAttribute("name")).slice(0, 100), id: text(el.getAttribute("id")).slice(0, 100), label: labelOf(el),
  }));
}`;

/** The roles by `autocomplete` (its last token: `billing cc-number` gives `cc-number`). */
const AUTOCOMPLETE: Readonly<Record<string, CardRole>> = {
  "cc-number": "number", "cc-exp": "expiry", "cc-exp-month": "expMonth", "cc-exp-year": "expYear", "cc-csc": "csc", "cc-name": "name", "postal-code": "postal",
};
/** A field of another card than the payment's (a gift card, a membership card) or of a code that is no card's: no role by its labels. */
const NOT_CARD = /\b(?:gift|loyalty|member(?:ship)?|reward|promo|coupon|voucher|discount|phone|mobile|zip\s*\+\s*4)\b/;
/** The roles by the labels and names, in this order (the first that fits). */
const BY_LABEL: readonly [CardRole, RegExp][] = [
  ["csc", /\b(?:cvc2?|cvv2?|cvn|csc)\b|security\s*code|card\s*code|verification\s*(?:code|number)/],
  ["expMonth", /\bexp(?:iry|iration)?[\s_.-]*(?:date[\s_.-]*)?(?:month|mm)\b|\bcc[\s_.-]*(?:exp[\s_.-]*)?month\b|\bcard[\s_.-]*month\b/],
  ["expYear", /\bexp(?:iry|iration)?[\s_.-]*(?:date[\s_.-]*)?(?:year|yy(?:yy)?)\b|\bcc[\s_.-]*(?:exp[\s_.-]*)?year\b|\bcard[\s_.-]*year\b/],
  ["expiry", /\bexp(?:iry|iration)?(?:[\s_.-]*date)?\b|\bexpires?\b|\bmm\s*\/\s*yy(?:yy)?\b|\bvalid\s*(?:thru|through|until)\b|\bcc[\s_.-]*exp\b/],
  ["number", /\bcard[\s_.-]*(?:number|num|no)\b|cardnumber\b|\bcc[\s_.-]*(?:number|num|no)\b|\bccnumber\b/],
  ["name", /\bname[\s_.-]*on[\s_.-]*(?:the[\s_.-]*)?card\b|\bcard[\s_.-]*holder\b|\bcardholder\b|\bcc[\s_.-]*name\b/],
  ["postal", /\b(?:zip|postal|postcode)\b/],
];

/** In a provider frame only: a month or a year field with no other word is the expiry's (a merchant's date of birth is not). */
const LOOSE: readonly [CardRole, RegExp][] = [["expMonth", /\bmonth\b|\bmm\b/], ["expYear", /\byear\b|\byy(?:yy)?\b/]];
/** The words of a delivery address: a name or a postal code with one of them is no card's (review-231 N2). */
const SHIPPING = /\b(?:shipping|delivery)/;

/**
 * The role of one field, or null: by `autocomplete`, then by its labels and names (in a provider frame also a bare month
 * or year); a hidden or disabled field has none.
 */
export function roleOf(f: FieldRead, provider = false): CardRole | null {
  return roleAt(f, provider)?.role ?? null;
}

/** The role of one field and whether its `autocomplete` gives it (true) or only its labels and names (false); null for none. */
function roleAt(f: FieldRead, provider: boolean): { role: CardRole; auto: boolean } | null {
  if (!f.visible || !f.enabled || f.type === "hidden" || f.type === "checkbox" || f.type === "radio" || f.type === "submit" || f.type === "button") return null;
  const tokens = f.autocomplete.split(/\s+/).filter(Boolean);
  const token = tokens.at(-1) ?? "";
  const auto = Object.hasOwn(AUTOCOMPLETE, token) ? AUTOCOMPLETE[token] : null;
  // A field of the shipping section (`shipping postal-code`) is the delivery address, never the card's (board ab-sta.13:
  // Stripe's real pages show a shipping address beside the card fields, and its ZIP came first). A card field's token
  // keeps its role (`shipping cc-number`: review-231 N1), so C11's stop for a card field outside a provider frame holds.
  if (tokens.includes("shipping") && !(auto !== null && CARD_ROLES.includes(auto))) return null;
  const words = [f.label, f.name.replace(/[_.-]+/g, " "), f.id.replace(/[_.-]+/g, " ")].join(" | ");
  // A name or a postal code whose labels or names say shipping or delivery (the label "shipping zip", the name
  // `shipping_postal_code`, also with `autocomplete="postal-code"`) is the delivery address's (review-231 N2).
  const address = (role: CardRole) => (role === "name" || role === "postal") && SHIPPING.test(words);
  if (auto !== null) return address(auto) ? null : { role: auto, auto: true };
  // An autocomplete that names another value (an email, a one-time code) is no card field.
  if (token && token !== "on" && token !== "off") return null;
  if (NOT_CARD.test(words)) return null;
  for (const [role, re] of BY_LABEL) if (re.test(words)) return address(role) ? null : { role, auto: false };
  if (provider) for (const [role, re] of LOOSE) if (re.test(words)) return { role, auto: false };
  return null;
}

/** True when a frame is a provider frame: its origin is a payment provider's (by the origin alone; in the act the main frame is never one). */
export const isProviderFrame = (f: ActFrame, extra: readonly string[] = []) => isProviderOrigin(f.origin, extra);

/**
 * The card fields of the act page's frames: by `autocomplete`, then labels and names. A card field outside a provider
 * frame stops with C11's text; a page with no number, expiry and security code in provider frames is no payment step.
 * For each role the first field whose `autocomplete` gives it wins over the first field that only its labels or names
 * match, and an expiry, or a month and a year, by `autocomplete` wins over one by labels (review-231 N3: a merchant's
 * custom field with a card's label on a provider's page cannot take the place of the provider's own field).
 */
export function findCardFields(frames: readonly ActFrame[], extra: readonly string[] = []): CardFields | { stop: string } {
  const byAuto: Partial<Record<CardRole, FieldAt>> = {}, byLabel: Partial<Record<CardRole, FieldAt>> = {};
  for (const [fi, frame] of frames.entries()) {
    const provider = isProviderFrame(frame, extra);
    for (const f of frame.fields) {
      const at = roleAt(f, provider);
      if (at === null) continue;
      if (!provider) {
        if (CARD_ROLES.includes(at.role)) return { stop: PAY_TEXT.fields };
        continue;
      }
      (at.auto ? byAuto : byLabel)[at.role] ??= { frame: fi, field: f.i };
    }
  }
  const { number, csc, expiry, expMonth, expYear, name, postal } = { ...byLabel, ...byAuto };
  const exp = byAuto.expiry ? { expiry: byAuto.expiry } : byAuto.expMonth && byAuto.expYear ? { expMonth: byAuto.expMonth, expYear: byAuto.expYear }
    : expiry ? { expiry } : expMonth && expYear ? { expMonth, expYear } : null;
  if (!number || !csc || !exp) return { stop: PAY_TEXT.noPaymentStep };
  return { number, csc, ...exp, ...(name ? { name } : {}), ...(postal ? { postal } : {}) };
}

/** A field of the main frame that asks for a sign-in or a phone code at the payment step (C11: a check that the act cannot pass). */
export function asksCheck(main: readonly FieldRead[]): boolean {
  return main.some((f) => f.visible && f.enabled && ((f.type === "password" && roleOf(f) === null) || f.autocomplete.split(/\s+/).includes("one-time-code")));
}
