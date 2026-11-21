// The record kind `card` of the stored sign-ins' store and the feature `card_pay` (contract C12, "The card payments":
// the record kind card, the rules of a card, `card_seal`, the pane's seal of the card form and its op, the feature; C11,
// the sign-in act's check 2 and the card payment's check 4; board ab-sta.5, the plan's Task 4). The real store with the
// vectors' test pane key, the vectors' `cardPay.opBinding` and `withoutFeature`, and the control door. TEST values only:
// the providers' published test card numbers (pay-test-cards.ts) and the vectors' canaries.

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { checkRequest, ControlDoor, PAY_OPS } from "../src/service/control.ts";
import { FakeService, FAKE_FEATURES } from "../src/service/fake.ts";
import { serviceFeatures } from "../src/service/main.ts";
import { Stage1a } from "../src/service/service.ts";
import { bindingInfo, openPaneSeal, privateKeyOf, publicRaw } from "../src/service/signins/seal.ts";
import { CARD_PAY_FEATURE, CARD_PAY_OPS, SignInsPart } from "../src/service/signins/part.ts";
import { CARD_ID, TEXT } from "../src/service/signins/store.ts";
import { DAEMON_HELLO, daemonClient } from "./fake-daemon.ts";
import { approvalSeal, cardFile, cardForm, control, DAEMON, formSeal, OP, ORIGIN, PANE_SECRET, PAY, payWorld, SCOPE_A, setUp, T0, TOKEN, withCard, type PayWorld } from "./pay-fakes.ts";
import { TEST_CARD_VALUES, TEST_CARDS } from "./pay-test-cards.ts";
import { paneSeal } from "./sign-in-seal.ts";
import { tempDir } from "./temp-dirs.ts";

const SIGN_IN = { id: "c-0000000a", name: "staging", origin: "https://staging.example.com", path: "/login", send_to: ["https://staging.example.com"] };
const [USER, PASS] = control.signInScan.canaries as string[];
const signInReq = (w: PayWorld, record = SIGN_IN) => ({ record, offer: false, sealed: paneSeal(w.part.store.paneKey(), { username: USER, password: PASS }, { op: "sign_in_seal", record, offer: false }, { at: new Date(w.clock.t).toISOString() }) });
const signInFile = (a: any) => ({ ...a.data.record, state: "usable", added: null, changed: null, sealed: a.data.sealed });

// ---------------------------------------------------------------- card_seal (C12)

test("card_seal: C12's order (the snapshot, the state, the seal, the rules of a card), each text; the record's six plain fields, a random card id, gen 1, the brand; no value of the card in the answer or the log", async () => {
  const w = payWorld();
  try {
    const seal = (form: object = cardForm()) => w.ask("card_seal", { sealed: formSeal(w, "card_seal", form) });
    assert.deepEqual(await seal(), { error: "the stored sign-ins have no snapshot yet" });
    assert.deepEqual(await w.ask("sign_ins", { key: null, records: [] }), { data: { records: 0 } });
    assert.deepEqual(await seal(), { error: "the store is not set up" });
    const key = await setUp(w);
    await w.ask("sign_ins_lock", {}, DAEMON);
    assert.deepEqual(await seal(), { error: "the store is locked" });
    const { PASSPHRASE } = await import("./pay-fakes.ts");
    assert.deepEqual(await w.ask("sign_ins_unlock", { sealed: formSeal(w, "sign_ins_unlock", { passphrase: PASSPHRASE }) }), { data: {} });
    // The seal: a stale one, and one of another op (the binding's op).
    assert.deepEqual(await w.ask("card_seal", { sealed: formSeal(w, "card_seal", cardForm(), { at: new Date(T0 - 121_000).toISOString() }) }), { error: "the sealed value cannot be opened" });
    assert.deepEqual(await w.ask("card_seal", { sealed: formSeal(w, "sign_ins_unlock", cardForm()) }), { error: "the sealed value cannot be opened" });
    // The rules of a card, in their order; the text names the field, never a value.
    const n = TEST_CARDS.visa;
    const bad: [object, string][] = [
      [{ ...cardForm(), name: "Bad Name" }, "name"], [{ ...cardForm(), name: undefined }, "name"],
      [{ ...cardForm(), number: `${n.slice(0, -1)}${(Number(n.at(-1)) + 1) % 10}` }, "number"], [{ ...cardForm(), number: "42424242424" }, "number"],
      [{ ...cardForm(), number: `${n.slice(0, 4)} ${n.slice(4)}` }, "number"], [{ ...cardForm(), number: 4242 }, "number"],
      [{ ...cardForm(), expiry: "13/30" }, "expiry"], [{ ...cardForm(), expiry: "12/2030" }, "expiry"],
      [{ ...cardForm(), csc: "12" }, "csc"], [{ ...cardForm(), csc: "12345" }, "csc"],
      [{ ...cardForm(), holder: "x".repeat(101) }, "holder"], [{ ...cardForm(), holder: "Ann\nExample" }, "holder"],
      [{ ...cardForm(), postal: "x".repeat(17) }, "postal"], [{ ...cardForm(), name: "Bad Name", number: "1" }, "name"],
    ];
    for (const [form, field] of bad) assert.deepEqual(await seal(form), { error: `the card is not valid (field ${field})` }, field);
    assert.equal(TEXT.card("number"), "the card is not valid (field number)");
    // A card: the six plain fields as the service sealed them, and the sealed part.
    const a = await seal(cardForm("travel", TEST_CARDS.amex));
    assert.deepEqual(Object.keys(a.data).sort(), ["record", "sealed"]);
    assert.deepEqual(Object.keys(a.data.record), ["v", "kind", "id", "gen", "name", "brand"]);
    assert.match(a.data.record.id, CARD_ID);
    assert.deepEqual({ ...a.data.record, id: "x" }, { v: 1, kind: "card", id: "x", gen: 1, name: "travel", brand: "amex" });
    assert.deepEqual(Object.keys(a.data.sealed).sort(), ["ct", "epk", "iv", "tag"]);
    const b = await seal(cardForm("travel", TEST_CARDS.mastercard));
    assert.notEqual(b.data.record.id, a.data.record.id, "a new id at random for each card");
    assert.equal(b.data.record.brand, "mastercard");
    const said = JSON.stringify([a, b, w.logs]);
    for (const v of [TEST_CARDS.amex, TEST_CARDS.mastercard, TEST_CARD_VALUES.holder, TEST_CARD_VALUES.expiry, TEST_CARDS.amex.slice(-4)]) assert.ok(!said.includes(v), "no value of the card");
    assert.ok(w.logs.includes(`sign-ins: sealed card ${a.data.record.id} travel`));
    void key;
  } finally { w.close(); }
});

// ---------------------------------------------------------------- kind in the seal's additional data (C12)

test("kind in the seal's additional data: a card's seal never opens as a sign-in's, and the reverse; a changed plain field of a card does not open", async () => {
  const w = payWorld();
  try {
    const { key, file } = await withCard(w);
    const s = await w.ask("sign_in_seal", signInReq(w));
    const si = signInFile(s);
    await w.ask("sign_ins", { key, records: [file, si] }, DAEMON);
    assert.ok("values" in w.part.store.openCard(file), "the card opens as a card");
    assert.ok("username" in w.part.store.openForUse(si), "the sign-in opens as a sign-in");
    // The card's sealed part in a sign-in's record (no kind): it does not open; the sign-in's in a card's record neither.
    assert.deepEqual(w.part.store.openForUse({ ...si, sealed: file.sealed }), { refused: "cannot_open" });
    assert.deepEqual(w.part.store.openCard({ ...file, sealed: si.sealed }), { refused: "cannot_open" });
    // Each plain field of the card is bound.
    for (const change of [{ name: "other" }, { brand: "visa" === file.brand ? "amex" : "visa" }, { gen: 2 }, { id: "card-00000000" }]) {
      assert.deepEqual(w.part.store.openCard({ ...file, ...change }), { refused: "cannot_open" }, JSON.stringify(change));
    }
    assert.deepEqual(w.part.store.openCard({ ...file, kind: "sign_in" }), { refused: "cannot_open" });
  } finally { w.close(); }
});

test("C11's check 2 of the sign-in act refuses a record with a kind; the payment's check 4 takes only a record of the kind card; two cards of one name give none", async () => {
  const w = payWorld();
  try {
    const { key, file } = await withCard(w);
    const s = await w.ask("sign_in_seal", signInReq(w));
    const si = signInFile(s);
    // A record with every field of a sign-in and a kind is no stored sign-in for check 2 (nor for the list of AgentBrowser.signIns).
    const kinded = { ...si, id: "c-0000000b", name: "kinded", kind: "card" };
    await w.ask("sign_ins", { key, records: [file, si, kinded] }, DAEMON);
    assert.equal(w.part.store.named("staging")?.fields.id, "c-0000000a");
    assert.equal(w.part.store.named("kinded"), null);
    assert.equal(w.part.store.named("travel"), null, "a card is no sign-in");
    assert.deepEqual(w.part.store.usable().map((r) => r.name), ["staging"]);
    // The payment's lookup: a card only.
    assert.equal(w.part.store.namedCard("travel")?.fields.id, file.id);
    assert.equal(w.part.store.namedCard("staging"), null, "a sign-in is no card");
    // Two cards of one name: neither.
    const second = await w.ask("card_seal", { sealed: formSeal(w, "card_seal", cardForm("travel", TEST_CARDS.mastercard)) });
    await w.ask("sign_ins", { key, records: [file, cardFile(second)] }, DAEMON);
    assert.equal(w.part.store.namedCard("travel"), null);
    // The daemon removes the card before the new one: the old id is a removed id from then on, also after a restart.
    await w.ask("sign_ins", { key, records: [cardFile(second)] }, DAEMON);
    assert.equal(w.part.store.namedCard("travel")?.fields.id, second.data.record.id);
    await w.ask("sign_ins", { key, records: [file, cardFile(second)] }, DAEMON);
    assert.equal(w.part.store.namedCard("travel")?.fields.id, second.data.record.id, "the removed card's file counts no more");
    w.part.stop();
    const again = payWorld({ dir: w.dir });
    try {
      await again.ask("sign_ins", { key, records: [file] }, DAEMON);
      assert.equal(again.part.store.namedCard("travel"), null, "a removed card id stays removed after a restart (sign-ins-state.json)");
    } finally { again.part.stop(); }
  } finally { w.close(); }
});

// ---------------------------------------------------------------- the binding's op (the daemon lead's point a; C12, the vectors' opBinding)

test("the daemon lead's point a: the binding's op keeps a pane's seal of a sign-in from opening as card_seal, and the reverse (the vectors' cardPay.opBinding, real seals)", async () => {
  const v = control.cardPay.opBinding;
  assert.equal(v.cases.length, 2);
  const key = privateKeyOf(PANE_SECRET), pub = publicRaw(key);
  for (const c of v.cases) {
    // The seal is real: it opens with the binding that it was made for, and not with the binding of the request's own op.
    const made = openPaneSeal(c.req.sealed.text, c.req.sealed.sender, bindingInfo(c.madeFor.purpose, c.madeFor.fields), { key, pub });
    if (c.madeFor.fields.op === "card_seal") assert.deepEqual(made, c.payload);
    else assert.deepEqual(made, { username: USER, password: PASS });
    const own: Record<string, string> = { op: c.req.op, rid: c.req.sealed.rid, at: c.req.sealed.at };
    if (c.req.op === "sign_in_seal") Object.assign(own, { id: c.req.record.id, name: c.req.record.name, origin: c.req.record.origin, path: c.req.record.path, send_to: c.req.record.send_to.join(" "), offer: String(c.req.offer) });
    assert.throws(() => openPaneSeal(c.req.sealed.text, c.req.sealed.sender, bindingInfo("browser-sign-in", own), { key, pub }), `${c.req.id}: not with its own op's binding`);
    assert.equal(checkRequest(c.req, () => true), null, `${c.req.id}: the door's rules take the line`);
    // The real store at the seal's time answers the vector's res; a store of its own takes the seal as the op it was made for.
    const w = payWorld();
    try {
      w.clock.t = Date.parse(c.req.sealed.at);
      await setUp(w);
      const { t: _t, id: _id, op, by: _by, ...fields } = c.req;
      assert.deepEqual(await w.ask(op, fields), { error: c.res.error }, c.note);
    } finally { w.close(); }
    const w2 = payWorld();
    try {
      w2.clock.t = Date.parse(c.req.sealed.at);
      await setUp(w2);
      if (c.madeFor.fields.op === "card_seal") {
        assert.deepEqual(await w2.ask("card_seal", { sealed: c.req.sealed }), { error: "the card is not valid (field number)" }, "it opens as card_seal: its stand-in number breaks a rule");
      } else {
        const f = c.madeFor.fields;
        const record = { id: f.id, name: f.name, origin: f.origin, path: f.path, send_to: f.send_to.split(" ") };
        const a = await w2.ask("sign_in_seal", { record, offer: f.offer === "true", sealed: c.req.sealed });
        assert.equal(a.data?.record?.id, f.id, "it opens as sign_in_seal");
      }
    } finally { w2.close(); }
  }
  // The same for a seal of a key op (op, rid and at only, as the card form's): sign_ins_unlock's seal is no card_seal's.
  const w = payWorld();
  try {
    await setUp(w);
    assert.deepEqual(await w.ask("card_seal", { sealed: formSeal(w, "sign_ins_unlock", cardForm()) }), { error: "the sealed value cannot be opened" });
    assert.deepEqual(await w.ask("sign_in_seal", { record: SIGN_IN, offer: false, sealed: formSeal(w, "card_seal", { username: USER, password: PASS }) }), { error: "the sealed value cannot be opened" });
  } finally { w.close(); }
});

// ---------------------------------------------------------------- the feature card_pay (C12)

test("the feature card_pay: off by default (main.ts's features, the fake, a part without the option): card_seal and pay_approve get unsupported (the vectors' withoutFeature) and no payment event goes; the tests' option turns them on", async () => {
  assert.ok(!serviceFeatures("linux").includes(CARD_PAY_FEATURE) && !serviceFeatures("darwin").includes(CARD_PAY_FEATURE));
  assert.ok(!(FAKE_FEATURES as readonly string[]).includes(CARD_PAY_FEATURE));
  assert.deepEqual(Object.keys(PAY_OPS).sort(), [...CARD_PAY_OPS].sort());
  const fake = new FakeService({});
  const off = payWorld({ cardPay: false }), on = payWorld();
  try {
    const stageOff = new Stage1a({ agentDoor: { url: (s) => s, state: () => ({ form: "pidfd" }) as any }, parts: [off.part] });
    const stageOn = new Stage1a({ agentDoor: { url: (s) => s, state: () => ({ form: "pidfd" }) as any }, parts: [on.part] });
    for (const { note, req, res } of control.cardPay.withoutFeature) {
      assert.equal(checkRequest(req, (op) => fake.has(op)), res.error, `the fake: ${note}`);
      assert.equal(checkRequest(req, (op) => stageOff.has(op)), res.error, `a service without the option: ${note}`);
      assert.equal(checkRequest(req, (op) => stageOn.has(op)), null, `a service with it: ${note}`);
    }
    assert.deepEqual((stageOff.hello as any).features, ["sign_ins"]);
    assert.deepEqual((stageOn.hello as any).features, ["sign_ins", "card_pay"]);
    assert.equal(off.part.pay, null);
    assert.ok(!Object.hasOwn(off.part.ops, "card_seal") && !Object.hasOwn(off.part.ops, "pay_approve"));
    // The vectors' requests with the feature: the kind and the shape before the op's work.
    for (const { note, req, res } of control.cardPay.requests) {
      const e = checkRequest(req, (op) => stageOn.has(op));
      if (!res.ok && (res.error === "not the operator" || res.error === "bad request")) assert.equal(e, res.error, note);
      else assert.equal(e, null, note);
    }
    // Without the option no event of the payment goes, also at a hello.
    off.part.onHello();
    assert.ok(!off.events.some((ev) => ["pay_request", "pay_result", "pay"].includes(ev.ev)));
  } finally { off.close(); on.close(); }
});

test("the control door: a daemon's new hello gets each waiting pay_request again, with the same id; the ops of the feature answer through the door with the kind's rule", async () => {
  const dir = tempDir("ab-cards-door-");
  const logs: string[] = [];
  const w = payWorld({ dir });
  const state = new Stage1a({ agentDoor: { url: (s) => s, state: () => ({ form: "pidfd" }) as any }, parts: [w.part] });
  const door = await ControlDoor.open({ path: join(dir, "control.sock"), admit: async () => ({ ok: true }), handler: state, log: (l) => logs.push(l) });
  try {
    await withCard(w);
    const c1 = await daemonClient(join(dir, "control.sock"));
    assert.deepEqual((await c1.next()).features, ["sign_ins", "card_pay"]);
    c1.send(DAEMON_HELLO);
    // The door reads the hello before the next request: an answer means that the connection takes events.
    c1.send({ t: "req", id: "s1", op: "status", by: DAEMON });
    assert.equal((await c1.answer("s1")).ok, true);
    const call = w.part.pay!.open(PAY, { scope: SCOPE_A, admission: "local" });
    const first = await c1.next((l) => l.t === "ev" && l.ev === "pay_request");
    assert.equal(first.origin, ORIGIN);
    // A daemon restart: a new connection's hello gets the request again.
    c1.end();
    const c2 = await daemonClient(join(dir, "control.sock"));
    await c2.next();
    c2.send(DAEMON_HELLO);
    const again = await c2.next((l) => l.t === "ev" && l.ev === "pay_request");
    assert.deepEqual(again, first);
    // pay_approve through the door: the token's kind first, then the operator's refusal; the pay_result after the answer.
    c2.send({ t: "req", id: "a1", op: "pay_approve", by: TOKEN, request: first.id, sealed: approvalSeal(w, first, "approve") });
    assert.deepEqual(await c2.answer("a1"), { t: "res", id: "a1", ok: false, error: "not the operator" });
    c2.send({ t: "req", id: "a2", op: "pay_approve", by: OP, request: first.id, sealed: approvalSeal(w, first, "refuse") });
    assert.deepEqual(await c2.answer("a2"), { t: "res", id: "a2", ok: true, data: {} });
    const result = await c2.next((l) => l.t === "ev" && l.ev === "pay_result");
    assert.ok(c2.lines.indexOf(result) > c2.lines.findIndex((l) => l.t === "res" && l.id === "a2"), "the event after the answer");
    assert.equal(result.text, "The operator refused this payment.");
    assert.equal((await call).text, "The operator refused this payment.");
    assert.ok(logs.includes("control: pay_approve by operator ann via web: ok"), logs.join("\n"));
    c2.end();
  } finally { state.stopParts(); await door.stop(); w.close(); }
});
