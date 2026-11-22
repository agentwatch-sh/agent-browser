// The guard of the payment act (contract C11, the card payment, the act; the secure card checkout design, section 8.6;
// board ab-sta.7, the plan's Task 5b). The act sets it as the `guard` hook of its act window (act.ts, PayActWindow), which
// pauses each request of the act tab and of its frames and workers with `Fetch` at the request stage. Pure: the unit
// tests drive it with paused requests.
//
// - A request whose URL holds the card's number fails, on every origin.
// - A request whose body holds the number fails unless it goes to the act's provider (board ab-sta.8): an origin of its
//   card-field frames or of its API (providers.ts, the provider whose frames hold the act's card fields), or a host of
//   one of those origins' own domain (the listed host without its first label, when that still has a dot:
//   `api.stripe.com` for `js.stripe.com`). The provider's own API gets the number: that is the payment. Another
//   provider's origin is no place for it. A body that Chrome does not give fails too, outside the act's provider (the
//   sign-in act's rule).
// - The number's forms: its digits, and groups of its digits with spaces, dashes, `+` or `%20` between them (as typed,
//   as a form encodes them, as a URL encodes them), also after a percent-decoding of the text, twice: each `%XX` on its
//   own, so a text that no decoder takes whole (`100%`) still shows the number (review-228 N2). The guard never matches
//   the security code or the expiry alone: they are too short to tell from ordinary text (the design, section 14).
// - `sent` (review-228 N8, the lead's call): a request that goes to a provider with the number in its body (or, once the
//   act typed the number, with a body that Chrome does not give). Before the press the act then keeps Unknown at once.
//
// The number stays in a Buffer: the compare is of bytes, and no string of the number is made here.

import { bodyOf, originOf, type PausedRequest } from "../signins/act-rules.ts";

/** Digits, each after at most three separators: a space, a dash, a `+`, or `%20`. */
const RUN = /\d(?:(?:[ \-+]|%20){0,3}\d)*/g;

/** True when `text` holds the number's digits in one run of digits and separators. */
function inRuns(text: string, number: Buffer): boolean {
  for (const m of text.matchAll(RUN)) {
    const digits = m[0].replace(/%20/g, "").replace(/[ \-+]/g, "");
    if (digits.length >= number.length && Buffer.from(digits, "latin1").indexOf(number) >= 0) return true;
  }
  return false;
}

/** One percent-decoding: each `%XX` on its own (as a byte's character), and `+` as a space; never a failure. */
const decodeEach = (t: string) => t.replace(/\+/g, " ").replace(/%([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));

/** True when `text` holds the card's number (`number`: its ASCII digits) in one of its forms. */
export function holdsNumber(text: string, number: Buffer): boolean {
  if (typeof text !== "string" || text.length === 0 || number.length < 12) return false;
  let t = text;
  for (let i = 0; i < 3; i++) {
    if (inRuns(t, number)) return true;
    const next = decodeEach(t);
    if (next === t) return false;
    t = next;
  }
  return false;
}

/**
 * An origin of the act's provider: on `provider` (the act's provider's frame and API origins, providers.ts providerHosts),
 * or its host is a listed host's own domain or a subdomain of it (the listed host without its first label, when that
 * still has a dot), with the same scheme. No other provider's origin is one.
 */
export function isProviderHost(origin: string, provider: readonly string[]): boolean {
  if (typeof origin !== "string" || !URL.canParse(origin)) return false;
  const u = new URL(origin);
  if (u.origin !== origin) return false;
  for (const p of provider) {
    if (!URL.canParse(p)) continue;
    if (p === origin) return true;
    const l = new URL(p);
    if (l.protocol !== u.protocol) continue;
    const parent = l.hostname.split(".").slice(1).join(".");
    if (parent.includes(".") && (u.hostname === parent || u.hostname.endsWith(`.${parent}`))) return true;
  }
  return false;
}

/**
 * The guard's decision for one paused request, whether it found the number where it does not belong (the act then
 * stops before the press), and whether the request takes the number to a provider (`sent`).
 */
export type GuardDecision = { decision: "continue" | "fail"; number: boolean; sent: boolean };

/**
 * The guard's decision for one paused request of the act tab, its frames or its workers. `provider`: the act's provider's
 * frame and API origins. `typed`: the act typed the number, so a body that Chrome does not give to the provider may hold
 * it (`sent`).
 */
export function payGuard(r: PausedRequest, number: Buffer, provider: readonly string[], o: { typed?: boolean } = {}): GuardDecision {
  const url = typeof r?.url === "string" ? r.url : "";
  if (holdsNumber(url, number)) return { decision: "fail", number: true, sent: false };
  const to = originOf(url);
  const body = bodyOf(r ?? { url });
  if (to !== null && isProviderHost(to, provider)) return { decision: "continue", number: false, sent: body === null ? o.typed === true : holdsNumber(body, number) };
  if (body === null) return { decision: "fail", number: false, sent: false };
  if (holdsNumber(body, number)) return { decision: "fail", number: true, sent: false };
  return { decision: "continue", number: false, sent: false };
}
