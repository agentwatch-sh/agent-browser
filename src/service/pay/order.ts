// The page's order (contract C11, the card payment; C12, the card payments, `pay_request` and the page-order hash; the
// secure card checkout design, sections 3 and 8.3; board ab-sta.5). The act reads the act page's order in its own
// isolated world: READ_ORDER gives the page's visible text lines and the values of its name and email inputs, and
// nothing else (no card field: a provider frame is another document). The rest is pure, so the unit tests drive it with
// page texts:
//
// - parseOrder: the order lines (each line that holds an amount, apart from the total), the total (one line whose
//   label says total: a subtotal, a tax or a fee is no total; two candidate totals stop), the total's currency (a code,
//   or a symbol that the request's currency maps), and the delivery name and email when the page shows them. A
//   countdown, a hold timer or a banner holds no amount, so it is no part of the order.
// - C11's digit filter (digits.ts): the reader drops each line, name or email that holds the card's last four digits, a
//   run of four or more of the number's digits or its expiry, so no `pay_request` holds one.
// - orderForRequest: the order of the `pay_request` event (its total and currency are the request's), or the stop
//   `The checkout's total is not <amount> <currency>.`
// - orderHash: C12's page-order hash, which the approval's seal binds.

import { createHash } from "node:crypto";
import { refusesDigits, type CardView } from "./digits.ts";
import { PAY_TEXT } from "./texts.ts";

/** The act page's session (the plan's Task 5 makes it): one evaluation in the act's own isolated world of the act page. */
export interface ActSession { evaluate<T>(expression: string): Promise<T> }

/** What READ_ORDER gives: the page's text lines, and its name and email inputs. */
export type PageText = { lines: string[]; inputs: { autocomplete: string; type: string; value: string }[] };
export type Delivery = { name?: string; email?: string };
/** The page's order as the act read it: `total` is the page's total (`51.00`), and `currency` its code or symbol on the page. */
export type PageOrder = { lines: string[]; total: string; currency: string; delivery?: Delivery };
/** The order of C12's `pay_request` (and of the hash): `total` and `currency` are the request's `amount` and `currency`. */
export type EventOrder = { lines: string[]; total: string; currency: string; delivery?: Delivery };

/** C12's bounds of `order.lines`. */
export const ORDER_LINES = 50;
export const LINE_CHARS = 200;
const NAME_CHARS = 100, EMAIL_CHARS = 200;
/** The read's own bounds: the page's text lines that READ_ORDER gives at most, each of at most this many characters. */
const READ_LINES = 2000, READ_CHARS = 1000;

/**
 * The read of the act page (in the act's isolated world: the page's scripts cannot change what it reads). Its text
 * starts with its tag. It gives the visible text of the main document, line by line, and the value of each input whose
 * autocomplete names a name or an email, or whose type is email: never a card field (`cc-`).
 */
export const READ_ORDER = `/*aw-pay:order*/ () => {
  const text = document.body ? String(document.body.innerText || "") : "";
  const lines = text.split(/\\n+/).map((s) => s.replace(/\\s+/g, " ").trim()).filter((s) => s.length > 0).slice(0, ${READ_LINES}).map((s) => s.slice(0, ${READ_CHARS}));
  const inputs = [];
  for (const el of document.querySelectorAll("input")) {
    const autocomplete = String(el.getAttribute("autocomplete") || "").toLowerCase(), type = String(el.type || "").toLowerCase();
    if (/cc-/.test(autocomplete) || !(type === "email" || /(^|\\s)(name|email)$/.test(autocomplete))) continue;
    inputs.push({ autocomplete, type, value: String(el.value || "").slice(0, 200) });
    if (inputs.length >= 20) break;
  }
  return { lines, inputs };
}`;

// ---- amounts ----

/** The currency codes that the reader takes on a page. */
const CODES = ["USD", "EUR", "GBP", "CAD", "AUD", "NZD", "CHF", "JPY", "CNY", "INR", "MXN", "BRL", "SEK", "NOK", "DKK", "PLN", "CZK", "HUF", "ZAR", "SGD", "HKD", "KRW", "TRY", "ILS"];
/** The symbols that the reader takes, each with the codes that it fits (the design: `$` fits USD). */
export const SYMBOLS: Readonly<Record<string, readonly string[]>> = {
  "US$": ["USD"], "CA$": ["CAD"], "C$": ["CAD"], "AU$": ["AUD"], "A$": ["AUD"], "NZ$": ["NZD"], "HK$": ["HKD"], "S$": ["SGD"], "R$": ["BRL"],
  "$": ["USD", "CAD", "AUD", "NZD", "MXN", "SGD", "HKD"], "\u20ac": ["EUR"], "\u00a3": ["GBP"], "\u00a5": ["JPY", "CNY"], "\u20b9": ["INR"],
  "\u20a9": ["KRW"], "\u20ba": ["TRY"], "\u20aa": ["ILS"], "z\u0142": ["PLN"], "kr": ["SEK", "NOK", "DKK"], "Fr.": ["CHF"],
};
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const MARKS = [...CODES, ...Object.keys(SYMBOLS)].sort((a, b) => b.length - a.length).map(esc).join("|");
/** A mark right before a number (a space or an NBSP between them, and a minus sign of a discount after it). */
const MARK_BEFORE = new RegExp(`(?:^|[^A-Za-z])(${MARKS})[\\s\\u00a0\\u202f]?[-\\u2212]?$`);
/** A mark right after a number. */
const MARK_AFTER = new RegExp(`^[\\s\\u00a0\\u202f]?(${MARKS})(?![A-Za-z])`);
/** A number on a page: digits, with thousands separators and a decimal part. */
const NUMBER = /\d+(?:[.,\u00a0\u202f]\d+)*/g;

/** The cents of a decimal string of the request (`12.50`, `12`), or null. */
export function cents(amount: string): number | null {
  const m = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(amount);
  return m ? Number(m[1]) * 100 + Number((m[2] ?? "0").padEnd(2, "0")) : null;
}
/** The cents of a number on a page (`1,234.56`, `1.234,56`, `48.00`, `48`), or null when it has no form of an amount. */
function pageCents(token: string): { cents: number; decimals: boolean } | null {
  const parts = token.split(/[.,\u00a0\u202f]/), seps = token.match(/[.,\u00a0\u202f]/g) ?? [];
  let int = parts, frac = "";
  if (seps.length > 0 && /[.,]/.test(seps.at(-1)!) && parts.at(-1)!.length === 2) { int = parts.slice(0, -1); frac = parts.at(-1)!; }
  else if (seps.length > 0 && parts.at(-1)!.length !== 3) return null;
  if (int.slice(1).some((p) => p.length !== 3) || int[0].length > 12 || int.join("").length > 12) return null;
  // One kind of thousands separator, and the decimal separator is another one.
  const thousands = new Set(seps.slice(0, frac ? -1 : undefined));
  if (thousands.size > 1 || (frac && thousands.has(seps.at(-1)!))) return null;
  return { cents: Number(int.join("")) * 100 + Number(frac || "0"), decimals: frac.length === 2 };
}
/** The text of cents: `51.00`. */
export const centsText = (c: number) => `${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`;

type Amount = { cents: number; mark: string | null; start: number; end: number };
/** The amounts of a line: each number with a currency mark next to it, or with two decimals; a percent is none. */
function amountsOf(line: string): Amount[] {
  const out: Amount[] = [];
  for (const m of line.matchAll(NUMBER)) {
    const start = m.index!, end = start + m[0].length;
    const before = line.slice(Math.max(0, start - 6), start), after = line.slice(end, end + 5);
    if (/^[\s\u00a0]?%/.test(after)) continue;
    const v = pageCents(m[0]);
    if (!v) continue;
    const mark = MARK_BEFORE.exec(before)?.[1] ?? MARK_AFTER.exec(after)?.[1] ?? null;
    if (mark === null && !v.decimals) continue;
    out.push({ cents: v.cents, mark, start, end });
  }
  return out;
}

/** A label that says total: a subtotal, a tax, a fee, a saving or a discount is none. */
const TOTAL = /\b(?:grand\s+total|order\s+total|total\s+due|total\s+to\s+pay|amount\s+due|amount\s+to\s+pay|balance\s+due|due\s+today|total)\b/i;
const NOT_TOTAL = /\bsub[\s-]?total\b|\btotal\s+(?:tax(?:es)?|fees?|savings?|discounts?|shipping|items?|tickets?|quantity)\b|\b(?:tax(?:es)?|fees?|savings?|discounts?|shipping)\s+total\b/i;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/;
const EMAIL_LABEL = /e-?mail|deliver|send\s+to|sent\s+to|recipient|contact/i;
const NAME_LINE = /^(?:name|full\s+name|deliver(?:y)?\s+to|ship(?:ping)?\s+to|recipient|attendee|ticket\s+holder)\s*:\s*(.+)$/i;

/** A text cut to `n` UTF-16 units, never in a surrogate pair. */
function cut(s: string, n: number): string {
  if (s.length <= n) return s;
  const t = s.slice(0, n);
  return /[\ud800-\udbff]$/.test(t) ? t.slice(0, -1) : t;
}
/**
 * A URL in a line (C12: no `pay_request` holds a URL path or a query): a scheme and `//`; a path with a query; a host
 * and a path with no scheme (`shop.example.com/orders/7f3a`; review-226 N1); or a bare path of two segments or more
 * (`/orders/7f3a`). A slash between words (`Adult/Child`, `per person / per day`) is none.
 */
const URL_IN_LINE = /\b[a-z][a-z0-9+.-]*:\/\/\S|\/\S*\?\S*=|\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?\/\S|(?:^|[\s(])\/[\w.~%-]+\/[\w.~%/-]/i;
/**
 * C12's bounds of the lines and C11's digit filter: at most 50 lines of at most 200 characters, none that the filter
 * refuses, and none that holds a URL.
 */
export function boundLines(lines: readonly string[], card: CardView): string[] {
  return lines.filter((l) => !refusesDigits(l, card) && !URL_IN_LINE.test(l)).map((l) => cut(l, LINE_CHARS)).slice(0, ORDER_LINES);
}
function boundDelivery(d: Delivery | undefined, card: CardView): Delivery | undefined {
  if (!d) return undefined;
  const out: Delivery = {};
  if (typeof d.name === "string" && d.name && !refusesDigits(d.name, card)) out.name = cut(d.name, NAME_CHARS);
  if (typeof d.email === "string" && d.email && !refusesDigits(d.email, card)) out.email = cut(d.email, EMAIL_CHARS);
  return out.name !== undefined || out.email !== undefined ? out : undefined;
}

/**
 * The page's order from its text (the pure part of readOrder): the order lines, the total and its currency, and the
 * delivery name and email. No total, or two candidate totals (two total lines of other amounts, or a total line with two
 * amounts), stops with C11's text.
 */
export function parseOrder(page: PageText, card: CardView): PageOrder | { stop: string } {
  // A label on its own line, with its amount alone on the next one (a layout of two columns), is one line.
  const raw = page.lines.map((l) => l.replace(/\s+/g, " ").trim()).filter((l) => l.length > 0);
  const lines: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const next = raw[i + 1];
    if (next !== undefined && amountsOf(raw[i]).length === 0 && amountsOf(next).length > 0 && next.replace(new RegExp(MARKS, "g"), "").replace(/[\d.,\s\u00a0\u202f:\-\u2212]/g, "") === "") {
      lines.push(`${raw[i]} ${next}`);
      i++;
    } else lines.push(raw[i]);
  }
  const totals: Amount[] = [], orderLines: string[] = [], marks = new Set<string>();
  for (const l of lines) {
    const amounts = amountsOf(l);
    if (amounts.length === 0) continue;
    for (const a of amounts) if (a.mark) marks.add(a.mark);
    let label = l;
    for (const a of [...amounts].reverse()) label = label.slice(0, a.start) + " " + label.slice(a.end);
    if (TOTAL.test(label) && !NOT_TOTAL.test(label)) totals.push(...amounts);
    else orderLines.push(l);
  }
  // One total: the same amount twice (a summary and its copy) is one candidate; two amounts, or two marks, are two.
  const amounts = new Set(totals.map((a) => a.cents)), totalMarks = new Set(totals.map((a) => a.mark).filter((m) => m !== null));
  if (amounts.size !== 1 || totalMarks.size > 1) return { stop: PAY_TEXT.noTotal };
  const currency = totalMarks.size === 1 ? [...totalMarks][0] : marks.size === 1 ? [...marks][0] : null;
  if (currency === null) return { stop: PAY_TEXT.noTotal };
  // The delivery: an email input (or a labelled line), a name input (or a labelled line).
  const inputEmail = page.inputs.find((x) => (/(^|\s)email$/.test(x.autocomplete) || x.type === "email") && EMAIL.test(x.value.trim()))?.value.trim();
  const inputName = page.inputs.find((x) => /(^|\s)name$/.test(x.autocomplete) && x.value.trim() !== "")?.value.trim();
  const email = inputEmail ?? lines.filter((l) => EMAIL_LABEL.test(l)).map((l) => EMAIL.exec(l)?.[0]).find((x) => x !== undefined);
  const name = inputName ?? lines.map((l) => NAME_LINE.exec(l)?.[1]?.trim()).find((x) => x !== undefined && !EMAIL.test(x));
  const delivery = boundDelivery({ ...(name ? { name } : {}), ...(email ? { email } : {}) }, card);
  return { lines: boundLines(orderLines, card), total: centsText([...amounts][0]), currency, ...(delivery ? { delivery } : {}) };
}

/** C11's read of the act page's order: READ_ORDER in the act's own world, then parseOrder. A read of another shape cannot give the total. */
export async function readOrder(session: ActSession, card: CardView): Promise<PageOrder | { stop: string }> {
  const t = await session.evaluate<unknown>(`(${READ_ORDER})()`);
  const ok = t !== null && typeof t === "object" && Array.isArray((t as PageText).lines) && (t as PageText).lines.every((l) => typeof l === "string")
    && Array.isArray((t as PageText).inputs) && (t as PageText).inputs.every((x) => x !== null && typeof x === "object" && typeof x.autocomplete === "string" && typeof x.type === "string" && typeof x.value === "string");
  if (!ok) return { stop: PAY_TEXT.noTotal };
  const page = t as PageText;
  return parseOrder({ lines: page.lines.slice(0, READ_LINES).map((l) => l.slice(0, READ_CHARS)), inputs: page.inputs.slice(0, 20) }, card);
}

/** True when the page's currency (a code, or a symbol) fits the request's code (the design, section 8.3). */
export function currencyFits(page: string, code: string): boolean {
  return page === code || (SYMBOLS[page]?.includes(code) ?? false);
}

/**
 * The order of the `pay_request` event from the page's order (C12): its total equals the request's amount, and its
 * currency fits the request's, else C11's stop; `total` and `currency` are then the request's, and the lines and the
 * delivery pass the bounds and the digit filter again. No `delivery` when the page shows none.
 */
export function orderForRequest(page: PageOrder, req: { amount: string; currency: string }, card: CardView): EventOrder | { stop: string } {
  const want = cents(req.amount), have = cents(page.total);
  if (want === null || have === null || want !== have || !currencyFits(page.currency, req.currency)) return { stop: PAY_TEXT.otherTotal(req.amount, req.currency) };
  const delivery = boundDelivery(page.delivery, card);
  return { lines: boundLines(page.lines, card), total: req.amount, currency: req.currency, ...(delivery ? { delivery } : {}) };
}

/** Compact JSON with sorted keys at each level and no ASCII escapes (C12, as the lines of the door). */
export function canonicalJson(x: unknown): string {
  if (Array.isArray(x)) return `[${x.map(canonicalJson).join(",")}]`;
  if (x !== null && typeof x === "object") {
    const o = x as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(x);
}

/**
 * C12's page-order hash: the lowercase hex SHA-256 of the UTF-8 bytes of the order as compact JSON with sorted keys at
 * each level and no ASCII escapes, of exactly the keys `lines`, `total`, `currency` and `delivery` (none when the page
 * shows no delivery name or email).
 */
export function orderHash(o: EventOrder): string {
  const d = o.delivery && (o.delivery.name !== undefined || o.delivery.email !== undefined)
    ? { ...(o.delivery.name !== undefined ? { name: o.delivery.name } : {}), ...(o.delivery.email !== undefined ? { email: o.delivery.email } : {}) } : undefined;
  const order = { lines: o.lines, total: o.total, currency: o.currency, ...(d ? { delivery: d } : {}) };
  return createHash("sha256").update(canonicalJson(order), "utf8").digest("hex");
}
