// The card fields of the act page (contract C11, the card payment; the secure card checkout design, section 8.4; board
// ab-sta.6, the plan's Task 5a). The act fills card fields only inside a provider frame: a frame of the act page whose
// origin is on the list of payment providers' origins (providers.ts), also the main frame of a provider's hosted payment
// page. READ_FIELDS reads one frame's fields in the act's own isolated world of that frame (no key, no value: only the
// attributes and the labels); findCardFields is pure, so the unit tests drive it with frame reads. Task 5b uses the same
// finder after the approval.
//
// - The roles: by `autocomplete` first (`cc-number`, `cc-exp`, `cc-exp-month`, `cc-exp-year`, `cc-csc`, `cc-name`,
//   `postal-code`), then by the field's labels and names (its label text, `aria-label`, `placeholder`, `name`, `id`).
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

/**
 * The role of one field, or null: by `autocomplete`, then by its labels and names (in a provider frame also a bare month
 * or year); a hidden or disabled field has none.
 */
export function roleOf(f: FieldRead, provider = false): CardRole | null {
  if (!f.visible || !f.enabled || f.type === "hidden" || f.type === "checkbox" || f.type === "radio" || f.type === "submit" || f.type === "button") return null;
  const token = f.autocomplete.split(/\s+/).filter(Boolean).at(-1) ?? "";
  if (Object.hasOwn(AUTOCOMPLETE, token)) return AUTOCOMPLETE[token];
  // An autocomplete that names another value (an email, a one-time code) is no card field.
  if (token && token !== "on" && token !== "off") return null;
  const words = [f.label, f.name.replace(/[_.-]+/g, " "), f.id.replace(/[_.-]+/g, " ")].join(" | ");
  if (NOT_CARD.test(words)) return null;
  for (const [role, re] of BY_LABEL) if (re.test(words)) return role;
  if (provider) for (const [role, re] of LOOSE) if (re.test(words)) return role;
  return null;
}

/** True when a frame is a provider frame: its origin is a payment provider's (the main frame of a hosted page too). */
export const isProviderFrame = (f: ActFrame, extra: readonly string[] = []) => isProviderOrigin(f.origin, extra);

/**
 * The card fields of the act page's frames: by `autocomplete`, then labels and names. A card field outside a provider
 * frame stops with C11's text; a page with no number, expiry and security code in provider frames is no payment step.
 */
export function findCardFields(frames: readonly ActFrame[], extra: readonly string[] = []): CardFields | { stop: string } {
  const found: Partial<Record<CardRole, FieldAt>> = {};
  for (const [fi, frame] of frames.entries()) {
    const provider = isProviderFrame(frame, extra);
    for (const f of frame.fields) {
      const role = roleOf(f, provider);
      if (role === null) continue;
      if (!provider) {
        if (CARD_ROLES.includes(role)) return { stop: PAY_TEXT.fields };
        continue;
      }
      found[role] ??= { frame: fi, field: f.i };
    }
  }
  const { number, csc, expiry, expMonth, expYear, name, postal } = found;
  if (!number || !csc || !(expiry || (expMonth && expYear))) return { stop: PAY_TEXT.noPaymentStep };
  return { number, csc, ...(expiry ? { expiry } : { expMonth, expYear }), ...(name ? { name } : {}), ...(postal ? { postal } : {}) };
}

/** A field of the main frame that asks for a sign-in or a phone code at the payment step (C11: a check that the act cannot pass). */
export function asksCheck(main: readonly FieldRead[]): boolean {
  return main.some((f) => f.visible && f.enabled && ((f.type === "password" && roleOf(f) === null) || f.autocomplete.split(/\s+/).includes("one-time-code")));
}
