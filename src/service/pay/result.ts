// The result reader of the payment act (contract C11, the card payment, the act and the table of what the agent sees;
// the secure card checkout design, section 8.7; board ab-sta.7, the plan's Task 5b). After the press the act reads the
// act page and its frames each turn for up to 60 s (READ_VIEW in the act's own isolated world of each frame), and
// readResult decides from those reads. It is pure, so the unit tests drive it with page texts, the test merchant's among
// them.
//
// In this order, each turn:
// - A bank's second step (Q3: any bank step stops): a frame that is new since the press (or the main frame's new page)
//   whose URL names a 3-D Secure check, which shows a field for a one-time code, or whose title or text names a bank's
//   check. It ends at once as Unknown with the bank text: the provider can still complete the charge on its server.
// - Declined: the page stays (its main frame committed no new page since the press), and a new line of the main frame
//   or of a provider frame (an error near the card fields) names a decline.
// - Paid: the page's new lines (the whole new page after a navigation) name a confirmation. The reader takes an order
//   number near words such as order, confirmation or booking, and the confirmation's amount near words such as total,
//   amount or charged. A confirmation amount other than the approved one gives "Paid, but the merchant's confirmation
//   shows <amount>".
// - Else no end yet. The act ends every other end after the press as Unknown (no confirmation within 60 s, a lost tab,
//   a link change, a stop of the service).
//
// R1: the reader takes a value (the order number, the confirmation's amount) only when C11's digit filter passes it
// (digits.ts, refusesDigits: no last four digits of the card, no run of four or more of its digits, no expiry). No other
// value of the page goes into a text.

import { refusesDigits, type CardView } from "./digits.ts";
import { PAY_TAG } from "./fields.ts";
import { amountsOf, cents, centsText, currencyFits, SYMBOLS, type Amount } from "./order.ts";
import { PAY_TEXT } from "./texts.ts";

/** The first values (C11). */
export const RESULT_LIMITS = {
  /** The result window: the act reads the result for up to 60 s after the press. */
  resultMs: 60_000,
} as const;

/** The read of one frame after the press: its URL and title, its visible text lines, and whether it shows a one-time code's field. */
export const READ_VIEW = `${PAY_TAG("view")} () => {
  const vis = (el) => { const r = el.getBoundingClientRect(); if (r.width <= 0 || r.height <= 0) return false; const cs = getComputedStyle(el); return cs.visibility !== "hidden" && cs.display !== "none"; };
  const text = document.body ? String(document.body.innerText || "") : "";
  const lines = text.split(/\\n+/).map((s) => s.replace(/\\s+/g, " ").trim()).filter((s) => s.length > 0).slice(0, 500).map((s) => s.slice(0, 500));
  const code = [...document.querySelectorAll("input")].some((el) => String(el.getAttribute("autocomplete") || "").toLowerCase().split(/\\s+/).includes("one-time-code") && vis(el));
  return { url: location.href, title: String(document.title || "").slice(0, 200), lines, code };
}`;

/** One frame as READ_VIEW gave it: `key` names the frame (its session and frame id), `provider` a provider frame. */
export type FrameView = { key: string; main: boolean; provider: boolean; url: string; title: string; lines: string[]; code: boolean };
/** The frames before the press: each frame's URL and lines, by its key. */
export type Baseline = ReadonlyMap<string, { url: string; lines: ReadonlySet<string> }>;
export type ResultInput = {
  request: { amount: string; currency: string; origin: string };
  card: CardView;
  /** The main frame committed a new page since the press. */
  moved: boolean;
  frames: readonly FrameView[];
  before: Baseline;
};
export type ResultEnd = { state: "paid" | "declined" | "unknown"; text: string };

/** The baseline of a read: each frame's URL and lines. */
export const baselineOf = (frames: readonly FrameView[]): Baseline => new Map(frames.map((f) => [f.key, { url: f.url, lines: new Set(f.lines) }]));

/** A URL of a bank's check (3-D Secure, an ACS, a challenge). */
const BANK_URL = /(?:^|[/.\-_=?&])(?:3ds\d?|3d[-_]?secure\d?|three[-_]?d[-_]?secure|threeds\d?|acs|challenge|authenticat\w*)(?:[/.\-_?#&=]|$)/i;
/** A title or text of a bank's check. */
const BANK_TEXT = /\b3-?d(?:s| secure)\b|\bthree[- ]?d(?:omain)? secure\b|\bverify (?:this|your) (?:payment|purchase|card|transaction)\b|\bauthenticate (?:this|your) (?:payment|purchase|card|transaction)\b|\byour bank (?:sent|needs|wants|asks|is asking|requires)\b/i;
/** A text that names a decline. */
const DECLINE = /\bdeclined?\b|\bcard (?:was |has been )?(?:refused|rejected|not accepted)\b|\binsufficient funds\b|\bdo not honou?r\b|\bpayment (?:failed|was not successful|was unsuccessful|could not be (?:processed|completed))\b|\btransaction (?:failed|was declined|was not approved)\b/i;
/** A text that names a confirmation. */
const CONFIRM = /\bthank(?:s| you)\b|\border (?:is |has been |was )?(?:confirmed|complete|completed|placed|received|successful)\b|\b(?:order|booking|purchase|payment) confirm(?:ed|ation)\b|\bconfirmation (?:number|code|no)\b|\bpayment (?:successful|received|complete|completed|approved)\b|\breceipt\b/i;
/** An order number near its words: a token of letters, digits and dashes, with a digit in it. */
const ORDER_NO = /\b(?:order|confirmation|booking|reference|receipt|transaction|invoice)\s*(?:number|no\.?|num|#|id|code|ref(?:erence)?)?\s*(?:is\s*)?[:#]?\s*#?\s*([A-Za-z0-9][A-Za-z0-9-]{2,39})\b/gi;
/** A line of the confirmation's amount, and one of another amount (a tax, a fee). */
const AMOUNT_WORDS = /\b(?:total|amount|charged|paid|price)\b/i;
const NOT_AMOUNT = /\bsub[\s-]?total\b|\btax(?:es)?\b|\bfees?\b|\bshipping\b|\bdiscounts?\b|\bsavings?\b/i;
const CODE = /^[A-Z]{3}$/;

/** The lines of a frame that are new since the press: all of a new frame (or a new page), else the ones it did not show. */
function newLines(f: FrameView, before: Baseline, moved: boolean): string[] {
  const b = before.get(f.key);
  if (!b || b.url !== f.url || (f.main && moved)) return f.lines;
  return f.lines.filter((l) => !b.lines.has(l));
}
const isNew = (f: FrameView, before: Baseline, moved: boolean) => { const b = before.get(f.key); return !b || b.url !== f.url || (f.main && moved); };

/** The order number of the lines, or null: the first token near its words that has a digit and that the digit filter passes. */
export function orderNumberOf(lines: readonly string[], card: CardView): string | null {
  for (const l of lines) {
    for (const m of l.matchAll(ORDER_NO)) {
      const t = m[1];
      if (!/\d/.test(t) || /^\d{1,2}$/.test(t) || refusesDigits(t, card)) continue;
      return t;
    }
  }
  return null;
}

/**
 * The confirmation's amount when it differs from the approved one (its text: `<amount> <code>`), or null when it is the
 * approved one or the page shows none. An amount whose text the digit filter refuses is not taken.
 */
export function otherAmountOf(lines: readonly string[], req: { amount: string; currency: string }, card: CardView): string | null {
  const want = cents(req.amount);
  for (const l of lines) {
    const amounts: Amount[] = amountsOf(l);
    if (amounts.length === 0) continue;
    let label = l;
    for (const a of [...amounts].reverse()) label = label.slice(0, a.start) + " " + label.slice(a.end);
    if (!AMOUNT_WORDS.test(label) || NOT_AMOUNT.test(label)) continue;
    for (const a of amounts) {
      const mark = a.mark;
      const fits = mark === null || currencyFits(mark, req.currency);
      if (fits && a.cents === want) continue;
      // The confirmation's currency as a code: its own code, the request's for a mark that fits it, or the one code of a symbol.
      const code = mark === null ? req.currency : CODE.test(mark) ? mark : fits ? req.currency : SYMBOLS[mark]?.length === 1 ? SYMBOLS[mark][0] : mark;
      const text = `${centsText(a.cents)} ${code}`;
      if (refusesDigits(text, card)) continue;
      return text;
    }
  }
  return null;
}

/** C11's result after the press from one turn's reads, or null when the page shows no end yet. */
export function readResult(i: ResultInput): ResultEnd | null {
  // A bank's second step: a new frame or a new page of a bank's check.
  for (const f of i.frames) {
    if (!isNew(f, i.before, i.moved)) continue;
    if (f.code || BANK_URL.test(f.url) || BANK_TEXT.test(f.title) || f.lines.some((l) => BANK_TEXT.test(l))) return { state: "unknown", text: PAY_TEXT.bankStep };
  }
  // Declined: the page stays, and a new line of the page or of a provider frame names a decline.
  if (!i.moved) {
    for (const f of i.frames) {
      if (!f.main && !f.provider) continue;
      if (newLines(f, i.before, false).some((l) => DECLINE.test(l))) return { state: "declined", text: PAY_TEXT.declined };
    }
  }
  // Paid: the page's new lines name a confirmation.
  const main = i.frames.find((f) => f.main);
  if (!main) return null;
  const lines = newLines(main, i.before, i.moved);
  if (!lines.some((l) => CONFIRM.test(l))) return null;
  const { amount, currency, origin } = i.request;
  const other = otherAmountOf(lines, i.request, i.card);
  if (other !== null) return { state: "paid", text: PAY_TEXT.paidOther(other) };
  const number = orderNumberOf(lines, i.card);
  return { state: "paid", text: number !== null ? PAY_TEXT.paid(amount, currency, origin, number) : PAY_TEXT.paidNoNumber(amount, currency, origin) };
}
