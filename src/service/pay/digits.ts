// The card's digits in the service (contract C11, the card payment; C12, the card payments; the secure card checkout
// design, sections 6 and 8.7; board ab-sta.5): the check digit (Luhn), the brand from the first digits, and the digit
// filter of C11. No text that the service makes or passes on holds the card's last four digits, a run of four or more
// of the number's digits in their order, or its expiry: the order reader drops each line that the filter refuses
// (order.ts), and the result reader (the plan's Task 5) refuses each value that it refuses.
//
// The card's values stay in buffers (the caller fills them with zeros after its use): the filter compares bytes, and it
// makes no string of the number.

/** The card's values that the filter needs: the number's digits and the expiry `MM/YY`, as ASCII bytes. */
export type CardView = { readonly number: Buffer; readonly expiry: Buffer };

/** The brands of C12's rules of a card. */
export const BRANDS = ["visa", "mastercard", "amex", "discover", "other"] as const;
export type CardBrand = (typeof BRANDS)[number];

/** True when the digits (ASCII, at least one) pass the check digit of ISO/IEC 7812 (Luhn). */
export function luhn(digits: string | Uint8Array): boolean {
  const n = digits.length;
  if (n === 0) return false;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const c = typeof digits === "string" ? digits.charCodeAt(n - 1 - i) : digits[n - 1 - i];
    let x = c - 48;
    if (x < 0 || x > 9) return false;
    if (i % 2 === 1) { x *= 2; if (x > 9) x -= 9; }
    sum += x;
  }
  return sum % 10 === 0;
}

/**
 * The brand from the number's first digits (C12: for the Browser pane's list): Visa 4; Mastercard 51-55 and
 * 2221-2720; American Express 34 and 37; Discover 6011, 644-649, 65 and 622126-622925; every other number `other`.
 */
export function brandOf(number: string): CardBrand {
  const p = (n: number) => Number(number.slice(0, n));
  if (number.startsWith("4")) return "visa";
  if ((p(2) >= 51 && p(2) <= 55) || (p(4) >= 2221 && p(4) <= 2720)) return "mastercard";
  if (p(2) === 34 || p(2) === 37) return "amex";
  if (p(4) === 6011 || (p(3) >= 644 && p(3) <= 649) || p(2) === 65 || (p(6) >= 622126 && p(6) <= 622925)) return "discover";
  return "other";
}

/** Digits that a person reads as one number: a digit, then digits each after at most one space, NBSP or dash. */
const DIGIT_RUN = /\d(?:[\s\u00a0\-\u2010-\u2015]?\d)*/g;
/**
 * An expiry on a page: `MM/YY`, `MM / YY`, `MM-YY`, or the same with a four-digit year. A dot is no separator here: a
 * price such as `12.30` is no expiry.
 */
const EXPIRY = /(?<!\d)(\d\d)\s*[/\-\u2010-\u2015]\s*(?:20)?(\d\d)(?!\d)/g;

/**
 * C11's digit filter: true when `text` holds the card's last four digits, a run of four or more of the number's digits
 * in their order, or its expiry. A run on the page may have a space, an NBSP or a dash between its digits (`4242 4242`).
 * Each run of four digits of the number is also a run of four or more, so the last four digits are one case of it.
 */
export function refusesDigits(text: string, card: CardView): boolean {
  if (typeof text !== "string" || text.length === 0) return false;
  for (const m of text.matchAll(DIGIT_RUN)) {
    const run = m[0].replace(/\D/g, "");
    for (let i = 0; i + 4 <= run.length; i++) if (card.number.indexOf(run.slice(i, i + 4), 0, "latin1") >= 0) return true;
  }
  const month = card.expiry.subarray(0, 2), year = card.expiry.subarray(3, 5);
  if (month.length !== 2 || year.length !== 2) return false;
  for (const m of text.matchAll(EXPIRY)) {
    if (month.equals(Buffer.from(m[1], "latin1")) && year.equals(Buffer.from(m[2], "latin1"))) return true;
  }
  return false;
}
