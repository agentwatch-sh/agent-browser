// The vector of the Browser pane's seal of a payment's approval (contract C12, "The card payments": the pane's seal of an
// approval, and the part's vectors; board ab-sta.18): test/vectors/pay-seal.json. Its two seals are the bytes that
// agentwatch's Browser pane made (agentwatch's agentwatch/tests/fixtures/card_pay_answer_seal.json at agentwatch commit
// 3c97e860f), so this test and agentwatch's test open the same seals, and a change of the seal's format on either side
// fails a test. Here the service's own code must give each seal's binding bytes (seal.ts bindingInfo), open each seal
// with them to its payload (seal.ts openPaneSeal; the store's paySeal; PayRequests' pay_approve, the path of the service),
// and refuse each case of `refused`. A mutation in memory of the binding (another label, another field order) makes the
// same checks fail.
//
// TEST keys and values only: the vectors' test pane key, the fixture's fixed test keys, and no value of a card.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { orderHash } from "../src/service/pay/order.ts";
import { APPROVE_TEXT } from "../src/service/pay/request.ts";
import { PAY_TEXT } from "../src/service/pay/texts.ts";
import { bindingInfo, openPaneSeal, PAY_PURPOSE, privateKeyOf, publicRaw, SIGN_IN_PURPOSE } from "../src/service/signins/seal.ts";
import { cardForm, control, evs, PAY, payWorld, SCOPE_A, until, withCard, type PayWorld } from "./pay-fakes.ts";
import { publicB64, testBytes } from "./sign-in-seal.ts";

const V = JSON.parse(readFileSync(new URL("./vectors/pay-seal.json", import.meta.url), "utf8"));
/**
 * The copy of agentwatch's fixture (board ab-sta.16) with no info_hex: test/pay-approve-pane-seal.test.ts gives the
 * info_hex lines back with bindingInfo and checks the SHA-256 of agentwatch's file, so the copy is agentwatch's bytes.
 */
const COPY = JSON.parse(readFileSync(new URL("./fixtures/agentwatch-card-pay-answer-seal.json", import.meta.url), "utf8"));
const PANE_SECRET = Buffer.from(V.pane_secret_hex, "hex");
const PANE = (() => { const key = privateKeyOf(PANE_SECRET); return { key, pub: publicRaw(key) }; })();
const [APPROVE, REFUSE] = V.seals;
const REFUSED: Record<string, any> = Object.fromEntries(V.refused.map((r: any) => [r.name, r]));
/** The vectors' first pay_request (test/vectors/control.json, cardPay.events). */
const FIRST = control.cardPay.events.map((x: any) => x.ev).find((e: any) => e.ev === "pay_request");
const bytes = (text: string) => Buffer.from(text, "utf8");
const opens = (s: { sealed: string; sender_public_b64: string }, info: Buffer) => openPaneSeal(s.sealed, s.sender_public_b64, info, PANE);

test("the vector: TEST keys only, the vectors' first pay_request and its page-order hash, and the two seals of agentwatch's fixture byte for byte", () => {
  assert.ok(V.note.startsWith("TEST keys and values only, never a real key or secret, and no value of a card."), "named a test value");
  // The vectors' TEST pane key, named so: its private half is SHA-256 of "test, not a key: ...".
  assert.equal(V.pane_secret_hex, testBytes("the pane key of the stored sign-ins' vectors").toString("hex"));
  assert.equal(V.pane_secret_hex, control.paneSeal.pane_secret_hex);
  assert.equal(publicB64(PANE_SECRET), V.pane_key);
  assert.equal(V.pane_key, control.paneSeal.pane_key);
  // The request is the vectors' first pay_request, and its order_hash is the vectors' orderHash and the service's hash.
  const r = V.request;
  assert.deepEqual({ id: r.id, origin: r.origin, order: r.order, card: r.card }, { id: FIRST.id, origin: FIRST.origin, order: FIRST.order, card: FIRST.card });
  assert.equal(r.order_hash, control.cardPay.orderHash.hash);
  assert.equal(orderHash(r.order), r.order_hash, "the service's page-order hash of the request's order");
  // The seals are agentwatch's: each key of the fixture's seal, in its order, then binding in place of info_hex.
  assert.equal(V.pane_key, COPY.pane_key);
  assert.deepEqual(V.request, COPY.request);
  assert.equal(V.seals.length, COPY.vectors.length);
  V.seals.forEach((s: any, i: number) => {
    const { binding, ...rest } = s;
    assert.equal(typeof binding, "string");
    assert.deepEqual(rest, COPY.vectors[i], `seal ${i}: the fixture's values`);
    assert.deepEqual(Object.keys(s), ["purpose", "fields", "binding", ...Object.keys(COPY.vectors[i]).slice(2)]);
    // Each key of the seal is a fixed TEST key, named so; rid is base64url of rid_bytes.
    const answer = s.payload.answer;
    assert.equal(s.ephemeral_secret_hex, testBytes(`ephemeral answer-${answer}`).toString("hex"), `${answer}: a test ephemeral key`);
    assert.equal(s.sender_secret_hex, testBytes(`sender answer-${answer}`).toString("hex"), `${answer}: a test sender key`);
    assert.equal(s.sender_public_b64, publicB64(Buffer.from(s.sender_secret_hex, "hex")));
    assert.equal(s.fields.rid, Buffer.from(s.rid_bytes).toString("base64url"));
    assert.equal(s.purpose, PAY_PURPOSE);
    // The fields of the service's own request (PayRequests.approve), with the seal's rid and at.
    assert.deepEqual(s.fields, { op: "pay_approve", rid: s.fields.rid, at: s.fields.at, request: r.id, origin: r.origin, amount: r.order.total, currency: r.order.currency, card: r.card, order: r.order_hash });
  });
  assert.deepEqual(V.seals.map((s: any) => s.payload), [{ answer: "approve" }, { answer: "refuse" }]);
  assert.deepEqual(Object.keys(REFUSED), ["another purpose", "another amount", "another order", "another label", "another field order"]);
});

/** C12's checks of the vector's seals with a builder of the binding's bytes: the first failure of each seal, or none. */
function sealFailures(build: (purpose: string, fields: Record<string, string>) => Buffer): string[] {
  const out: string[] = [];
  for (const s of V.seals) {
    const info = build(s.purpose, s.fields);
    if (!info.equals(bytes(s.binding))) { out.push(`${s.payload.answer}: other binding bytes`); continue; }
    try { assert.deepEqual(opens(s, info), s.payload); } catch { out.push(`${s.payload.answer}: does not open to its payload`); }
  }
  return out;
}

test("each seal: the service's bindingInfo gives the vector's binding bytes, and openPaneSeal opens the seal with them to its payload", () => {
  for (const s of V.seals) assert.ok(s.binding.startsWith("agentwatch-browser-pay-v1\u0000{\"amount\":"), `${s.payload.answer}: C12's binding`);
  assert.deepEqual(sealFailures(bindingInfo), []);
});

test("a change of the seal's format fails the checks (a mutation in memory of the binding): another label or another field order gives other bytes, and no seal opens with them", () => {
  const relabel = (purpose: string, fields: Record<string, string>) => bytes(bindingInfo(purpose, fields).toString("utf8").replace(`agentwatch-${purpose}-v1\u0000`, `agentwatch-${purpose}-v2\u0000`));
  const unsorted = (purpose: string, fields: Record<string, string>) => bytes(`agentwatch-${purpose}-v1\u0000{${Object.keys(fields).map((n) => `${JSON.stringify(n)}:${JSON.stringify(fields[n])}`).join(",")}}`);
  // The same checks as the test above, with the mutated builder in place of the service's bindingInfo: each seal fails.
  for (const build of [relabel, unsorted]) assert.deepEqual(sealFailures(build), ["approve: other binding bytes", "refuse: other binding bytes"], build.name);
  for (const s of V.seals) for (const build of [relabel, unsorted]) assert.throws(() => opens(s, build(s.purpose, s.fields)), `${s.payload.answer}, ${build.name}: does not open`);
  // The vector's refused cases hold these mutated bytes of the approve seal, so agentwatch's side checks them too.
  assert.equal(REFUSED["another label"].binding, relabel(APPROVE.purpose, APPROVE.fields).toString("utf8"));
  assert.equal(REFUSED["another field order"].binding, unsorted(APPROVE.purpose, APPROVE.fields).toString("utf8"));
});

test("each refused case does not open with its binding; the seal of another purpose opens with its own binding only", () => {
  for (const r of V.refused) {
    // A case with a purpose and fields: its binding is the service's binding of them.
    if (r.fields) assert.ok(bindingInfo(r.purpose, r.fields).equals(bytes(r.binding)), `${r.name}: the service's binding`);
    assert.throws(() => opens(r, bytes(r.binding)), `${r.name}: does not open`);
  }
  // Another purpose: the approve seal's payload, fields and keys, sealed with the purpose browser-sign-in.
  const p = REFUSED["another purpose"];
  assert.deepEqual([p.purpose, p.fields, p.binding], [PAY_PURPOSE, APPROVE.fields, APPROVE.binding]);
  assert.equal(p.made_for.purpose, SIGN_IN_PURPOSE);
  assert.deepEqual(p.made_for.fields, APPROVE.fields);
  assert.notEqual(p.sealed, APPROVE.sealed);
  assert.equal(p.sender_public_b64, APPROVE.sender_public_b64);
  assert.deepEqual(opens(p, bindingInfo(p.made_for.purpose, p.made_for.fields)), APPROVE.payload, "it opens with the binding it was made for");
  // Another amount and another order: the approve seal, with the binding of a request that differs in that field only.
  for (const [name, field, value] of [["another amount", "amount", "52.00"], ["another order", "order", control.cardPay.orderHash.otherLine.hash]] as const) {
    const r = REFUSED[name];
    assert.deepEqual([r.sealed, r.sender_public_b64], [APPROVE.sealed, APPROVE.sender_public_b64], name);
    assert.deepEqual(r.fields, { ...APPROVE.fields, [field]: value }, name);
  }
  for (const name of ["another label", "another field order"]) assert.deepEqual([REFUSED[name].sealed, REFUSED[name].sender_public_b64], [APPROVE.sealed, APPROVE.sender_public_b64], name);
});

test("the store's paySeal (the service's check of an approval's seal) at each seal's at: each seal opens to its payload, and each refused case with fields is `open`", () => {
  const cases: { sealed: any; fields: Record<string, string>; want: unknown }[] = [
    ...V.seals.map((s: any) => ({ sealed: s, fields: s.fields, want: s.payload })),
    ...V.refused.filter((r: any) => r.fields).map((r: any) => ({ sealed: r, fields: r.fields, want: "open" })),
  ];
  assert.equal(cases.length, 5);
  for (const c of cases) {
    // A new store for each case: the store keeps the rid of each seal that it checked.
    const w = payWorld();
    try {
      w.clock.t = Date.parse(c.fields.at);
      const { rid, at, ...bound } = c.fields;
      const got = w.part.store.paySeal({ text: c.sealed.sealed, sender: c.sealed.sender_public_b64, rid, at }, PAY_PURPOSE, bound);
      assert.deepEqual(got, c.want, JSON.stringify(bound));
    } finally { w.close(); }
  }
});

/** The checkout page that the fake preparation reads: the real reader gives the vector's order. */
const ORDER = V.request.order;
const PAGE = [...ORDER.lines, `Total: ${ORDER.total} ${ORDER.currency}`, `Deliver to: ${ORDER.delivery.name}`, `Email: ${ORDER.delivery.email}`];

/** A world with the vector's card, whose request gets the vector's id and reads its page; then the request's pay_request. */
async function waitingRequest(): Promise<{ w: PayWorld; call: Promise<any>; ev: any }> {
  const w = payWorld({ newId: () => V.request.id });
  w.page.lines = PAGE;
  await withCard(w, cardForm(V.request.card));
  let ended = false;
  const call = w.part.pay!.open(PAY, { scope: SCOPE_A, admission: "local" }).finally(() => { ended = true; });
  await until(() => ended || evs(w, "pay_request").length > 0, "a pay_request or the end");
  const ev = evs(w, "pay_request")[0];
  assert.ok(ev, "the request sent its pay_request");
  return { w, call, ev };
}

const SERVICE_CASES = [
  { name: "the approve seal", seal: APPROVE, answer: { data: {} }, result: ["paid", `Paid: 51.00 USD to ${V.request.origin}, order SHOP-1001`], acts: 1 },
  { name: "the refuse seal", seal: REFUSE, answer: { data: {} }, result: ["stopped", PAY_TEXT.refused], acts: 0 },
  { name: "the seal of another purpose", seal: REFUSED["another purpose"], answer: { error: APPROVE_TEXT.mismatch }, result: ["stopped", PAY_TEXT.mismatch], acts: 0 },
];
for (const c of SERVICE_CASES) {
  test(`${c.name} through the service's pay_approve (PayRequests binds its own request, the vector's request): ${JSON.stringify(c.answer)}, then ${c.result[0]}`, async () => {
    const { w, call, ev } = await waitingRequest();
    try {
      assert.deepEqual([ev.id, ev.origin, ev.card, ev.order], [V.request.id, V.request.origin, V.request.card, V.request.order]);
      assert.equal(orderHash(ev.order), V.request.order_hash);
      const f = c.seal.fields;
      w.clock.t = Date.parse(f.at);
      assert.deepEqual(await w.ask("pay_approve", { request: ev.id, sealed: { text: c.seal.sealed, sender: c.seal.sender_public_b64, rid: f.rid, at: f.at } }), c.answer);
      const r = await call;
      assert.deepEqual([r.state, r.text], c.result);
      assert.equal(w.acts.length, c.acts);
      if (c.acts) assert.equal(w.acts[0].order, V.request.order_hash, "the act gets the approved page-order hash");
    } finally { w.close(); }
  });
}
