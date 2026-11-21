// The local test merchant (test/fixtures/pay-merchant/; the secure card checkout design, section 11; board ab-sta.5, the
// plan's Task 4, for the live check of its Task 6): its loopback server serves each host's pages and its provider's API,
// and its pages are what the order reader takes. No browser: the pages' text is read here from their HTML.

import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { readdirSync, readFileSync } from "node:fs";
import { parseOrder, type PageOrder } from "../src/service/pay/order.ts";
import { PAY_TEXT } from "../src/service/pay/texts.ts";
import { MERCHANT_HOSTS, startMerchant } from "./fixtures/pay-merchant/server.ts";
import { TEST_CARDS } from "./pay-test-cards.ts";

const DIR = new URL("./fixtures/pay-merchant/", import.meta.url);
const card = { number: Buffer.from(TEST_CARDS.visa), expiry: Buffer.from("12/34") };

function get(port: number, host: string, path: string, o: { method?: string; body?: string } = {}): Promise<{ status: number; type: string; body: string }> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, path, method: o.method ?? "GET", headers: { host: `${host}:${port}` } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, type: String(res.headers["content-type"] ?? ""), body: Buffer.concat(chunks).toString("utf8") }));
    });
    r.on("error", reject);
    r.end(o.body);
  });
}
/** The text lines of a page as a browser shows its paragraphs and list items (enough for the order reader). */
const linesOf = (html: string) => [...html.matchAll(/<(li|p|h1)[^>]*>([\s\S]*?)<\/\1>/g)].map((m) => m[2].replace(/<[^>]+>/g, "").replace(/&times;/g, "×").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim()).filter(Boolean);

test("the test merchant's server: each host's pages by the request's host, its provider's API, and nothing else", async () => {
  const m = await startMerchant();
  try {
    const shop = await get(m.port, "shop.localhost", "/");
    assert.equal(shop.status, 200);
    assert.match(shop.type, /^text\/html/);
    assert.match(shop.body, /<h1>Your cart<\/h1>/);
    assert.equal((await get(m.port, "shop.localhost", "/checkout.js")).status, 200);
    assert.match((await get(m.port, "pay.localhost", "/fields.html")).body, /autocomplete="cc-number"/);
    assert.equal((await get(m.port, "bank.localhost", "/3ds.html")).status, 200);
    assert.equal((await get(m.port, "other.localhost", "/fields.html")).status, 200);
    for (const [host, path] of [["evil.localhost", "/"], ["shop.localhost", "/../server.ts"], ["shop.localhost", "/%2e%2e/server.ts"], ["shop.localhost", "/server.ts"], ["pay.localhost", "/checkout.html"], ["shop.localhost", "/x/checkout.html"]]) {
      assert.equal((await get(m.port, host, path)).status, 404, `${host}${path}`);
    }
    assert.equal((await get(m.port, "shop.localhost", "/checkout.html", { method: "POST", body: "x" })).status, 405);
    // The provider's API: it drops the body and answers no value of it.
    const body = `number=${TEST_CARDS.visa}&csc=123`;
    const ok = await get(m.port, "pay.localhost", "/charge", { method: "POST", body });
    assert.deepEqual(JSON.parse(ok.body), { ok: true });
    assert.deepEqual(JSON.parse((await get(m.port, "pay.localhost", "/charge?variant=decline", { method: "POST", body })).body), { ok: false, error: "Your card was declined." });
    assert.deepEqual(JSON.parse((await get(m.port, "pay.localhost", "/charge?variant=bank", { method: "POST", body })).body), { ok: true, bank: true });
    assert.equal((await get(m.port, "shop.localhost", "/charge", { method: "POST", body })).status, 405, "only the provider has the API");
  } finally { await m.close(); }
});

test("the test merchant's pages: the checkout's order is what the reader takes; the variants of the design's section 11 are pages of their own; no card number in any page", () => {
  const shop = (name: string) => readFileSync(new URL(`shop/${name}`, DIR), "utf8");
  const o = parseOrder({ lines: linesOf(shop("checkout.html")), inputs: [] }, card) as PageOrder;
  assert.deepEqual(o, { lines: ["Adult ticket × 2: $40.00", "Child ticket × 1: $8.00", "Subtotal: $48.00", "Tax (6.25%): $3.00"], total: "51.00", currency: "$", delivery: { name: "Ann Example", email: "ann@example.com" } });
  assert.deepEqual(parseOrder({ lines: linesOf(shop("checkout-two-totals.html")), inputs: [] }, card), { stop: PAY_TEXT.noTotal });
  for (const v of ["two-totals", "own-fields", "other-frame", "fee", "decline", "bank", "last4", "total-change", "keep", "session"]) assert.match(shop(`checkout-${v}.html`), new RegExp(`data-variant="${v}"`), v);
  assert.match(shop("checkout-own-fields.html"), /autocomplete="cc-number"/, "card fields on the shop's own page");
  assert.doesNotMatch(shop("checkout.html"), /cc-number/, "the base checkout has no card field of its own");
  assert.match(shop("checkout-other-frame.html"), /data-host="other.localhost"/);
  const fields = readFileSync(new URL("pay/fields.html", DIR), "utf8");
  for (const a of ["cc-number", "cc-exp", "cc-csc", "cc-name", "postal-code"]) assert.match(fields, new RegExp(`autocomplete="${a}"`), a);
  assert.match(fields, /type="checkbox" id="save" name="save" checked> Save this card/);
  assert.match(shop("confirmation.html"), /Order number: SHOP-1001/);
  assert.deepEqual(Object.values(MERCHANT_HOSTS).sort(), ["bank", "other", "pay", "shop"]);
  for (const folder of Object.values(MERCHANT_HOSTS)) for (const f of readdirSync(new URL(`${folder}/`, DIR))) {
    assert.ok(!/\d(?:[ -]?\d){11,}/.test(readFileSync(new URL(`${folder}/${f}`, DIR), "utf8")), `${folder}/${f}: no card number`);
  }
});
