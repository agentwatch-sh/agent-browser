// The helpers of the card payment's live check (board ab-sta.8, the plan's Task 6; test/live/card-checkout/check.ts): the
// agent's own test page of the shop's origin (its service worker, served by the check through the test merchant's route
// hook), the operator's approval as the Browser pane seals it (C12: the purpose browser-pay and the binding of the
// pay_request), the page-order hash as C12 says it (computed here again, not with the service's code), the secret scan's
// forms of the test values, and the X windows of the run's own display. TEST values only: the providers' published test
// card numbers (test/pay-test-cards.ts) and made-up values named so; every host is a *.localhost host of the check's own
// test merchant.

import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { spawnSync } from "node:child_process";
import { closeSync, openSync, readSync } from "node:fs";
import { sealPayload } from "../../sign-in-seal.ts";
import { CSC_LABEL } from "./scan-split.ts";

// ---------------------------------------------------------------- the agent's own page of the shop's origin

/** The agent's service worker on the shop's origin (scope "/"): it logs each fetch that it sees, and says it on the shop's channel. */
export const AGENT_SW_PATH = "/aw-agent-sw.js";
const AGENT_SW = `// The agent's own service worker on the shop's origin (the card payment's live check): it logs each fetch of a page
// that it controls in Cache Storage (aw-sw-log) and posts its URL on the shop's channel. It answers no fetch itself.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  const at = Date.now(), url = e.request.url;
  e.waitUntil((async () => {
    const c = await caches.open("aw-sw-log");
    await c.put(new Request("/aw-sw-log/" + at + "-" + Math.random().toString(36).slice(2)), new Response(JSON.stringify({ at, url, mode: e.request.mode })));
    try { new BroadcastChannel("shop-sync").postMessage({ sw: url }); } catch (x) {}
  })());
});
`;

/** The test merchant's route hook (server.ts): the agent's service worker on shop.localhost; every other request goes to the merchant. */
export function agentRoute(host: string, url: URL, _req: IncomingMessage, res: ServerResponse): boolean {
  if (host !== "shop.localhost" || url.pathname !== AGENT_SW_PATH) return false;
  res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store", "service-worker-allowed": "/" }).end(AGENT_SW);
  return true;
}

// ---------------------------------------------------------------- C12: the page-order hash and the operator's approval

/** Compact JSON with sorted keys at each level and no ASCII escapes (C12, as the lines of the door). */
export function canonicalJson(x: unknown): string {
  if (Array.isArray(x)) return `[${x.map(canonicalJson).join(",")}]`;
  if (x !== null && typeof x === "object") {
    const o = x as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(x);
}
/** C12's page-order hash of a pay_request's `order`: the lowercase hex SHA-256 of its canonical JSON's UTF-8 bytes. */
export const orderHashOf = (order: unknown) => createHash("sha256").update(canonicalJson(order), "utf8").digest("hex");
/** A time of C12's seal rules: UTC, ISO 8601, no milliseconds. */
export const isoNow = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * The Browser pane's seal of an approval (C12): `{"answer":<answer>}` to the pane key with the purpose browser-pay, the
 * fields op, rid and at, and the binding fields of the pay_request (request, origin, amount, currency, card, order: its
 * hash). `fields` changes a binding field (an approval for another request or another order).
 */
export function approvalSeal(paneKey: string, ev: any, answer: string, fields: Record<string, string> = {}): { text: string; sender: string; rid: string; at: string } {
  const rid = randomBytes(16).toString("base64url"), at = isoNow();
  const binding = { op: "pay_approve", rid, at, request: String(ev.id), origin: String(ev.origin), amount: String(ev.order?.total), currency: String(ev.order?.currency), card: String(ev.card), order: orderHashOf(ev.order), ...fields };
  const s = sealPayload({ answer }, { purpose: "browser-pay", fields: binding }, paneKey);
  return { text: s.sealed, sender: s.senderPublicB64, rid, at };
}

// ---------------------------------------------------------------- the secret scan

/** One form of a test value: its label (never the value) and its test. */
type Form = { label: string; test: (text: string) => boolean; value: string };
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A short value (the security code, the expiry's digits) only as a token of its own: no letter or digit right before or after it. */
const token = (v: string) => { const re = new RegExp(`(?<![A-Za-z0-9])${esc(v)}(?![A-Za-z0-9])`); return (t: string) => re.test(t); };

/**
 * The scan's forms of the card's test values: each card number as its digits and in groups of four with spaces, dashes,
 * `+` or `%20`; the security code and the expiry (`MM/YY`, `MM / YY`, `MM-YY`, `MM%2FYY`, `MM/20YY`, `MMYY`) as tokens of
 * their own; the made-up holder and postal code.
 */
export class Scan {
  readonly forms: Form[] = [];
  constructor(o: { numbers: Record<string, string>; csc: string; expiry: string; holder: string; postal: string }) {
    for (const [name, n] of Object.entries(o.numbers)) {
      const groups = n.match(/.{1,4}/g)!;
      this.forms.push({ label: `the ${name} number (digits)`, value: n, test: (t) => t.includes(n) });
      for (const [sep, what] of [[" ", "spaces"], ["-", "dashes"], ["+", "plus signs"], ["%20", "%20"]] as const) {
        const v = groups.join(sep);
        this.forms.push({ label: `the ${name} number (groups with ${what})`, value: v, test: (t) => t.includes(v) });
      }
    }
    this.forms.push({ label: CSC_LABEL, value: o.csc, test: token(o.csc) });
    const [mm, yy] = o.expiry.split("/");
    for (const [v, what] of [[`${mm}/${yy}`, "MM/YY"], [`${mm} / ${yy}`, "MM / YY"], [`${mm}-${yy}`, "MM-YY"], [`${mm}%2F${yy}`, "MM%2FYY"], [`${mm}%2f${yy}`, "MM%2fYY"], [`${mm}/20${yy}`, "MM/20YY"], [`${mm}${yy}`, "MMYY"]] as const) {
      this.forms.push({ label: `the expiry (${what})`, value: v, test: token(v) });
    }
    this.forms.push({ label: "the holder", value: o.holder, test: (t) => t.includes(o.holder) });
    this.forms.push({ label: "the postal code", value: o.postal, test: token(o.postal) });
  }
  /** The labels of the forms that `text` holds (never a value). */
  hits(text: string): string[] { return typeof text === "string" && text ? this.forms.filter((f) => f.test(text)).map((f) => f.label) : []; }
  holds(text: string): boolean { return this.hits(text).length > 0; }
  /**
   * The forms that a file's bytes hold, in Latin-1 and in UTF-16LE (review-229 N3: a profile's database or a log in
   * UTF-16): a byte search of each value in each encoding, and the form's own test only on a few bytes around each place
   * where its value is (no text of the whole file, no regex over it). A UTF-16LE hit's label ends with "(UTF-16LE)".
   */
  holdsBytes(b: Buffer): string[] {
    const out: string[] = [];
    for (const f of this.forms) {
      for (const [enc, w] of [["latin1", 1], ["utf16le", 2]] as const) {
        const v = Buffer.from(f.value, enc);
        for (let i = b.indexOf(v); i >= 0; i = b.indexOf(v, i + 1)) {
          // The window keeps the match's byte parity, so a UTF-16LE match at an odd byte decodes as itself.
          if (f.test(b.subarray(Math.max(0, i - w * (i >= w ? 1 : 0)), Math.min(b.length, i + v.length + w)).toString(enc))) { out.push(enc === "latin1" ? f.label : `${f.label} (UTF-16LE)`); break; }
        }
      }
    }
    return out;
  }
  /** A text with each form of a test value replaced (the check's own output never prints one). */
  redact(text: string): string {
    let out = String(text);
    for (const f of [...this.forms].sort((a, b) => b.value.length - a.value.length)) if (f.value.length >= 4) out = out.split(f.value).join("<a test value>");
    return out;
  }
}

/** The forms that a file holds (Scan.holdsBytes), read in chunks of 32 MiB that overlap by 1 KiB: each file, at any size. */
const CHUNK = 32 << 20, OVER = 1024;
/** The one buffer of the file scan (each file reuses it). */
let scanBuf: Buffer | null = null;
export function scanFile(scan: Scan, path: string): string[] {
  const out = new Set<string>();
  const fd = openSync(path, "r");
  try {
    const buf = scanBuf ??= Buffer.alloc(CHUNK + OVER);
    let pos = 0, carry = 0;
    for (;;) {
      // `carry` bytes of the last chunk's end stay at the buffer's start: a value across two chunks is found too.
      const n = readSync(fd, buf, carry, CHUNK, pos);
      if (n <= 0) break;
      const len = carry + n;
      for (const h of scan.holdsBytes(buf.subarray(0, len))) out.add(h);
      if (n < CHUNK) break;
      pos += n;
      carry = Math.min(OVER, len);
      buf.copy(buf, 0, len - carry, len);
    }
  } finally { closeSync(fd); }
  return [...out];
}

// ---------------------------------------------------------------- the X windows of the run's own display

export type XWindow = { id: string; name: string; x: number; y: number; w: number; h: number };
/** X windows of the run's own display (its Xvfb, its X authority): their name and place. */
export function xWindows(display: number, xauth: string): XWindow[] {
  const env = { DISPLAY: `:${display}`, XAUTHORITY: xauth };
  const ids = spawnSync("xdotool", ["search", "--onlyvisible", "--name", ".*"], { env, encoding: "utf8", timeout: 3000 }).stdout.split("\n").filter((l) => /^\d+$/.test(l));
  return ids.map((id) => {
    const name = spawnSync("xdotool", ["getwindowname", id], { env, encoding: "utf8", timeout: 3000 }).stdout.trim();
    const g = spawnSync("xdotool", ["getwindowgeometry", id], { env, encoding: "utf8", timeout: 3000 }).stdout;
    const p = /Position:\s*(-?\d+),(-?\d+)/.exec(g), s = /Geometry:\s*(\d+)x(\d+)/.exec(g);
    return { id, name, x: Number(p?.[1] ?? NaN), y: Number(p?.[2] ?? NaN), w: Number(s?.[1] ?? NaN), h: Number(s?.[2] ?? NaN) };
  });
}
