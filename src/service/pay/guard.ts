// The guard of the payment act (contract C11, the card payment, the act; the secure card checkout design, section 8.6;
// board ab-sta.7, the plan's Task 5b). The act sets it as the `guard` hook of its act window (act.ts, PayActWindow), which
// pauses each request of the act tab and of its frames and workers with `Fetch` at the request stage. Pure: the unit
// tests drive it with paused requests.
//
// - A request whose URL holds the card's number fails, on every origin.
// - A request whose body holds the number fails unless it goes to a provider: an origin on the list of payment providers'
//   origins (providers.ts), or a provider host, a host of a listed origin's own domain (the listed host without its first
//   label, when that still has a dot: `api.stripe.com` for `js.stripe.com`). The provider's own API gets the number: that
//   is the payment. A body that Chrome does not give fails too, outside the providers (the sign-in act's rule).
// - The number's forms: its digits, and groups of its digits with spaces, dashes, `+` or `%20` between them (as typed,
//   as a form encodes them, as a URL encodes them), also after one percent-decoding of the text. The guard never matches
//   the security code or the expiry alone: they are too short to tell from ordinary text (the design, section 14).
//
// The number stays in a Buffer: the compare is of bytes, and no string of the number is made here.

import { bodyOf, originOf, type PausedRequest } from "../signins/act-rules.ts";
import { PROVIDER_ORIGINS } from "./providers.ts";

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

/** True when `text` holds the card's number (`number`: its ASCII digits) in one of its forms. */
export function holdsNumber(text: string, number: Buffer): boolean {
  if (typeof text !== "string" || text.length === 0 || number.length < 12) return false;
  if (inRuns(text, number)) return true;
  let decoded: string;
  try { decoded = decodeURIComponent(text.replace(/\+/g, " ")); } catch { return false; }
  return decoded !== text && inRuns(decoded, number);
}

/**
 * A provider's origin or host: the origin is on the list (or on `extra`, the tests' option), or its host is a listed
 * host's own domain or a subdomain of it (the listed host without its first label, when that still has a dot), with the
 * same scheme.
 */
export function isProviderHost(origin: string, extra: readonly string[] = []): boolean {
  if (typeof origin !== "string" || !URL.canParse(origin)) return false;
  const u = new URL(origin);
  if (u.origin !== origin) return false;
  for (const p of [...PROVIDER_ORIGINS, ...extra]) {
    if (p === origin) return true;
    const l = new URL(p);
    if (l.protocol !== u.protocol) continue;
    const parent = l.hostname.split(".").slice(1).join(".");
    if (parent.includes(".") && (u.hostname === parent || u.hostname.endsWith(`.${parent}`))) return true;
  }
  return false;
}

/** The guard's decision for one paused request, and whether it found the number (the act then stops before the press). */
export type GuardDecision = { decision: "continue" | "fail"; number: boolean };

/** The guard's decision for one paused request of the act tab, its frames or its workers. */
export function payGuard(r: PausedRequest, number: Buffer, extra: readonly string[] = []): GuardDecision {
  const url = typeof r?.url === "string" ? r.url : "";
  if (holdsNumber(url, number)) return { decision: "fail", number: true };
  const to = originOf(url);
  if (to !== null && isProviderHost(to, extra)) return { decision: "continue", number: false };
  const body = bodyOf(r ?? { url });
  if (body === null) return { decision: "fail", number: false };
  if (holdsNumber(body, number)) return { decision: "fail", number: true };
  return { decision: "continue", number: false };
}
