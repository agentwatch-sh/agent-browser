// The service opens the Browser pane's real seal of a payment's approval (contract C12, "The card payments": the pane's
// seal of an approval and `pay_approve`; board ab-sta.16, goal ab-sta). The other tests of `pay_approve` seal each
// approval with this repository's own code (pay-fakes.ts approvalSeal), and agentwatch tests the pane's seals only against
// its own Python opener. This test crosses the two codes: it feeds two seals that agentwatch's Browser pane made through
// the service's real `pay_approve` path, so a difference in the binding's fields or their forms (request, origin, amount,
// currency, card, order; op, rid, at) fails here, not at the operator's first approval.
//
// The fixture test/fixtures/agentwatch-card-pay-answer-seal.json comes from agentwatch's
// agentwatch/tests/fixtures/card_pay_answer_seal.json at agentwatch commit 3c97e860f (branch feat/card-pay; board
// ab-sta.12, part C). The pane's module (agentwatch/server/static/modules/browser-card-pay-seal.js, sealAnswer) sealed
// `{"answer":"approve"}` and `{"answer":"refuse"}` with the purpose `browser-pay` to the vectors' TEST pane key, bound to
// the vectors' first `pay_request` and its page-order hash, with fixed TEST keys (SHA-256 of "test, not a key: ...").
// TEST keys and values only: no real key and no value of a card.
// The copy is agentwatch's file without its two `info_hex` lines, and else byte for byte: the hex of `"card":` in each
// `info_hex` is a run of 13 digits with a valid check digit, which the repository check of card numbers
// (test/card-numbers.test.ts) refuses. The first test gives the two lines back with the service's bindingInfo and checks
// that the result has the SHA-256 of agentwatch's file (SOURCE_SHA256), so the copy is still tied to its source.
//
// The path: the real stored sign-ins' part with the option cardPay (pay-fakes.ts: the real store, set up and open with
// the vectors' test pane key, a card sealed by the real `card_seal`), the real PayRequests with the fixture's request id,
// a page whose order the real reader gives as the fixture's order, and the service's clock at each seal's `at`. The
// binding is the one that PayRequests builds from its own request; the test never builds it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { checkRequest } from "../src/service/control.ts";
import { orderHash } from "../src/service/pay/order.ts";
import { APPROVE_TEXT } from "../src/service/pay/request.ts";
import { PAY_TEXT } from "../src/service/pay/texts.ts";
import { bindingInfo } from "../src/service/signins/seal.ts";
import { SEAL_MS, TEXT as STORE_TEXT } from "../src/service/signins/store.ts";
import { cardForm, control, evs, OP, PAY, PANE_SECRET, payWorld, SCOPE_A, until, withCard, type PayWorld } from "./pay-fakes.ts";
import { publicB64, sealPayload, testBytes } from "./sign-in-seal.ts";

const COPY = readFileSync(new URL("./fixtures/agentwatch-card-pay-answer-seal.json", import.meta.url), "utf8");
const FIXTURE = JSON.parse(COPY);
/** The SHA-256 of agentwatch's agentwatch/tests/fixtures/card_pay_answer_seal.json at agentwatch commit 3c97e860f (feat/card-pay). */
const SOURCE_SHA256 = "b3380ffd4be2abf4a68cf9c7e3fee52b186ae28415678257b68d6e61bf88b209";
const [APPROVE, REFUSE] = FIXTURE.vectors;
const REQUEST = FIXTURE.request;
/** The vectors' first pay_request (test/vectors/control.json, cardPay.events). */
const FIRST = control.cardPay.events.map((x: any) => x.ev).find((e: any) => e.ev === "pay_request");
/** The checkout page that the fake preparation reads: the real reader gives the fixture's order (no mark on the lines). */
const PAGE = ["Zoo entry – adult × 2: 48.00", "Service fee: 3.00", "Total: 51.00 USD", "Deliver to: Ann Example", "Email: ann@example.com"];
/** A fixture's seal as the `sealed` of `pay_approve`. */
const sealedOf = (v: any) => ({ text: v.sealed, sender: v.sender_public_b64, rid: v.fields.rid, at: v.fields.at });
const local = { scope: SCOPE_A, admission: "local" as const };

/** A world with a card, whose next request gets `id` and reads `page`. */
async function world(o: { id?: string; page?: string[]; card?: string } = {}): Promise<PayWorld> {
  const w = payWorld({ newId: () => o.id ?? REQUEST.id });
  w.page.lines = o.page ?? PAGE;
  await withCard(w, cardForm(o.card ?? REQUEST.card));
  return w;
}
/** Start browser_pay; wait for its pay_request. */
async function request(w: PayWorld, input: Record<string, unknown> = PAY) {
  const before = evs(w, "pay_request").length;
  let ended = false;
  const call = w.part.pay!.open(input, local).finally(() => { ended = true; });
  await until(() => ended || evs(w, "pay_request").length > before, "a pay_request or the end");
  assert.equal(evs(w, "pay_request").length, before + 1, "the request sent its pay_request");
  return { call, ev: evs(w, "pay_request").at(-1) };
}
/** The operator's pay_approve through the part's op (the door's shape check first), with the service's clock at the seal's at. */
async function approve(w: PayWorld, id: string, v: any): Promise<any> {
  w.clock.t = Date.parse(v.fields.at);
  const sealed = sealedOf(v);
  assert.equal(checkRequest({ t: "req", id: "x", op: "pay_approve", by: OP, request: id, sealed }, () => true), null, "the door takes the pane's seal");
  return w.ask("pay_approve", { request: id, sealed });
}

test("the copy is agentwatch's file without its two info_hex lines: the service's bindingInfo gives them back, and the result has the SHA-256 of agentwatch's file", () => {
  // The copy is the form of agentwatch's file (JSON with an indent of one space, and a newline at its end), with no info_hex.
  assert.equal(COPY, `${JSON.stringify(FIXTURE, null, 1)}\n`);
  assert.ok(FIXTURE.vectors.every((v: any) => !Object.hasOwn(v, "info_hex")));
  // Each info_hex goes back right after its fields, as the bytes of the service's own binding of the seal.
  const rebuilt = { ...FIXTURE, vectors: FIXTURE.vectors.map((v: any) => Object.fromEntries(Object.entries(v).flatMap(([k, x]) =>
    k === "fields" ? [[k, x], ["info_hex", bindingInfo(v.purpose, v.fields).toString("hex")]] : [[k, x]]))) };
  assert.equal(createHash("sha256").update(`${JSON.stringify(rebuilt, null, 1)}\n`, "utf8").digest("hex"), SOURCE_SHA256);
});

test("the fixture: TEST keys only, sealed to the vectors' test pane key, bound to the vectors' first pay_request and its page-order hash", () => {
  assert.ok(FIXTURE.note.startsWith("TEST keys and values only, never a real key or secret."), "named a test value");
  // The pane key is the vectors' TEST pane key, named so: its private half is SHA-256 of "test, not a key: ...".
  assert.equal(FIXTURE.pane_key, control.paneSeal.pane_key, "the vectors' TEST pane key");
  assert.equal(control.paneSeal.pane_secret_hex, testBytes("the pane key of the stored sign-ins' vectors").toString("hex"));
  assert.equal(publicB64(PANE_SECRET), FIXTURE.pane_key, "the store's pane key in the tests (pay-fakes.ts PANE_SECRET)");
  for (const v of FIXTURE.vectors) {
    // Each key of the seal is a fixed TEST key, named so: SHA-256 of "test, not a key: <label>".
    const answer = v.payload.answer;
    assert.equal(v.ephemeral_secret_hex, testBytes(`ephemeral answer-${answer}`).toString("hex"), `${answer}: a test ephemeral key`);
    assert.equal(v.sender_secret_hex, testBytes(`sender answer-${answer}`).toString("hex"), `${answer}: a test sender key`);
    assert.equal(v.sender_public_b64, publicB64(Buffer.from(v.sender_secret_hex, "hex")));
    assert.equal(v.fields.rid, Buffer.from(v.rid_bytes).toString("base64url"));
    assert.equal(v.purpose, "browser-pay");
    assert.deepEqual(Object.keys(v.fields).sort(), ["amount", "at", "card", "currency", "op", "order", "origin", "request", "rid"]);
  }
  assert.deepEqual(FIXTURE.vectors.map((v: any) => v.payload), [{ answer: "approve" }, { answer: "refuse" }]);
  // The fixture's request is the vectors' first pay_request, and its order_hash is the vectors' orderHash.
  assert.deepEqual({ id: REQUEST.id, origin: REQUEST.origin, order: REQUEST.order, card: REQUEST.card }, { id: FIRST.id, origin: FIRST.origin, order: FIRST.order, card: FIRST.card });
  assert.equal(REQUEST.order_hash, control.cardPay.orderHash.hash);
  assert.equal(orderHash(REQUEST.order), REQUEST.order_hash, "the service's page-order hash of the fixture's order");
});

test("the pane's approve seal opens through the service's pay_approve: the service's own pay_request is the fixture's request, and the act runs once with its order hash", async () => {
  const w = await world();
  try {
    assert.equal(w.part.store.paneKey(), FIXTURE.pane_key);
    const { call, ev } = await request(w);
    // The service's own record of the request: the vectors' first pay_request (`earlier` is the keep's, empty here).
    const { earlier, ...own } = ev;
    const { earlier: _vectorsEarlier, ...first } = FIRST;
    assert.deepEqual(earlier, []);
    assert.deepEqual(own, first);
    assert.equal(orderHash(ev.order), REQUEST.order_hash);
    assert.deepEqual(await approve(w, ev.id, APPROVE), { data: {} });
    const r = await call;
    assert.deepEqual([r.state, r.text], ["paid", `Paid: 51.00 USD to ${REQUEST.origin}, order SHOP-1001`]);
    assert.equal(w.acts.length, 1);
    assert.equal(w.acts[0].request.id, REQUEST.id);
    assert.equal(w.acts[0].order, REQUEST.order_hash, "the act gets the approved page-order hash");
    assert.ok(w.logs.includes(`pay: request ${REQUEST.id}: the operator approved it`), w.logs.join("\n"));
    // The seal's rid is kept: the same seal for a new request of the same id breaks the rid rule, and that request waits.
    const again = await request(w);
    assert.equal(again.ev.id, REQUEST.id);
    // The clock is still within the at rule's window, so only the rid rule can refuse it (review-233 N2).
    assert.ok(Math.abs(w.clock.t - Date.parse(APPROVE.fields.at)) <= SEAL_MS, "the clock within the at rule's window");
    assert.deepEqual(await w.ask("pay_approve", { request: again.ev.id, sealed: sealedOf(APPROVE) }), { error: STORE_TEXT.sealed });
    assert.equal(w.part.pay!.waiting(), 1);
    assert.equal(w.acts.length, 1);
    w.part.pay!.stop();
    assert.equal((await again.call).text, PAY_TEXT.lostBefore);
  } finally { w.close(); }
});

test("the pane's refuse seal opens through the service's pay_approve as refuse: the request ends with the operator's refusal, and no act runs", async () => {
  const w = await world();
  try {
    const { call, ev } = await request(w);
    assert.deepEqual(await approve(w, ev.id, REFUSE), { data: {} });
    const r = await call;
    assert.deepEqual([r.state, r.text], ["stopped", PAY_TEXT.refused]);
    assert.equal(w.acts.length, 0);
    assert.deepEqual(evs(w, "pay_result").map((e) => [e.id, e.state, e.text]), [[REQUEST.id, "stopped", PAY_TEXT.refused]]);
    assert.ok(w.logs.includes(`pay: request ${REQUEST.id}: the operator refused it`), w.logs.join("\n"));
  } finally { w.close(); }
});

/**
 * A request of the service that differs from the fixture's request in one binding field. The order holds the total and
 * the currency (C12, the pay_request), so another amount or currency also gives another page-order hash.
 */
const CHANGES: { name: string; world: { id?: string; page?: string[]; card?: string }; input?: Record<string, unknown>; tab?: string; changed: Record<string, unknown> }[] = [
  { name: "the request id", world: { id: "0b9e4c2a7f13d856" }, changed: { id: "0b9e4c2a7f13d856" } },
  { name: "the origin", world: {}, input: { origin: "https://shop.example.org" }, tab: "https://shop.example.org/checkout", changed: { origin: "https://shop.example.org" } },
  { name: "the amount", world: {}, input: { amount: "51" }, changed: { total: "51" } },
  { name: "the currency", world: { page: [...PAGE.slice(0, 2), "Total: 51.00 EUR", ...PAGE.slice(3)] }, input: { currency: "EUR" }, changed: { currency: "EUR" } },
  { name: "the card's name", world: { card: "other" }, input: { card: "other" }, changed: { card: "other" } },
  { name: "the order hash (an order line)", world: { page: ["Zoo entry – child × 2: 48.00", ...PAGE.slice(1)] }, changed: { lines: ["Zoo entry – child × 2: 48.00", "Service fee: 3.00"] } },
  { name: "the order hash (no delivery)", world: { page: PAGE.slice(0, 3) }, changed: { delivery: undefined } },
];

for (const c of CHANGES) {
  test(`the pane's approve seal does not open for a request of another ${c.name.replace(/^the /, "")}: "this approval does not match the payment request", the request ends, no act`, async () => {
    const w = await world(c.world);
    try {
      if (c.tab) w.facts.tabs[SCOPE_A] = [{ id: 7, url: c.tab }];
      const { call, ev } = await request(w, { ...PAY, ...c.input });
      // The service's own request differs from the fixture's in this field only (and in the hash when the order changed).
      const view = { id: ev.id, origin: ev.origin, card: ev.card, ...ev.order };
      const want = { id: REQUEST.id, origin: REQUEST.origin, card: REQUEST.card, ...REQUEST.order, ...c.changed };
      for (const k of Object.keys(want)) if (want[k] === undefined) delete want[k];
      assert.deepEqual(view, want);
      const changesOrder = ["lines", "total", "currency", "delivery"].some((k) => Object.hasOwn(c.changed, k));
      assert.equal(orderHash(ev.order) === REQUEST.order_hash, !changesOrder);
      if (c.name === "the order hash (an order line)") assert.equal(orderHash(ev.order), control.cardPay.orderHash.otherLine.hash);
      assert.deepEqual(await approve(w, ev.id, APPROVE), { error: APPROVE_TEXT.mismatch });
      const r = await call;
      assert.deepEqual([r.state, r.text], ["stopped", PAY_TEXT.mismatch]);
      assert.equal(w.acts.length, 0);
      assert.deepEqual(evs(w, "pay_result").map((e) => [e.id, e.text]), [[ev.id, PAY_TEXT.mismatch]]);
      assert.ok(w.logs.includes(`pay: request ${ev.id}: an approval that does not match it; the request ends`), w.logs.join("\n"));
    } finally { w.close(); }
  });
}

test("a seal of another purpose (browser-sign-in) with the approve seal's keys, payload and fields does not open: \"this approval does not match the payment request\"", async () => {
  const keys = { ephemeral: Buffer.from(APPROVE.ephemeral_secret_hex, "hex"), sender: Buffer.from(APPROVE.sender_secret_hex, "hex") };
  // The control: with the purpose browser-pay, this repository's seal gives the pane's text byte for byte, so the purpose
  // is the one difference of the seal below.
  assert.equal(sealPayload(APPROVE.payload, { purpose: "browser-pay", fields: APPROVE.fields }, FIXTURE.pane_key, keys).sealed, APPROVE.sealed);
  const other = sealPayload(APPROVE.payload, { purpose: "browser-sign-in", fields: APPROVE.fields }, FIXTURE.pane_key, keys);
  assert.notEqual(other.sealed, APPROVE.sealed);
  const w = await world();
  try {
    const { call, ev } = await request(w);
    assert.deepEqual(await approve(w, ev.id, { ...APPROVE, sealed: other.sealed, sender_public_b64: other.senderPublicB64 }), { error: APPROVE_TEXT.mismatch });
    assert.deepEqual([(await call).text, w.acts.length], [PAY_TEXT.mismatch, 0]);
  } finally { w.close(); }
});
