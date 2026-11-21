// The card payments' test world (board ab-sta.5, the plan's Task 4): the real stored sign-ins' part with the option
// `cardPay` on (the feature card_pay), its store set up and open with the vectors' test pane key, a card sealed by the
// real `card_seal` from a pane's seal of the card form, and fakes of the plan's Task 5 (the world's facts, the page's
// preparation, the act). Every key and value here is a TEST value: the vectors' test keys and canaries, and the
// providers' published test card numbers (pay-test-cards.ts).

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Req } from "../src/service/control.ts";
import { parseOrder, type PageOrder } from "../src/service/pay/order.ts";
import type { PayActContext, PayActEnd, Prepared, PayRequestView } from "../src/service/pay/request.ts";
import type { CardView } from "../src/service/pay/digits.ts";
import { KDF } from "../src/service/signins/seal.ts";
import { SignInsPart, type CardPayOptions } from "../src/service/signins/part.ts";
import { sealPayload } from "./sign-in-seal.ts";
import { TEST_CARD_VALUES, TEST_CARDS } from "./pay-test-cards.ts";
import { tempDir } from "./temp-dirs.ts";

export const control = JSON.parse(readFileSync(new URL("./vectors/control.json", import.meta.url), "utf8"));
export const PANE_SECRET = Buffer.from(control.paneSeal.pane_secret_hex, "hex");
export const PASSPHRASE: string = control.signInScan.canaries[2];
export const T0 = Date.parse("2026-11-21T14:00:00Z");
export const OP = { kind: "operator", user: "ann", via: "web" } as const;
export const DAEMON = { kind: "daemon", user: "ann", via: "daemon" } as const;
export const TOKEN = { kind: "token", user: "ann", via: "cli" } as const;
export const ORIGIN = "https://shop.example.com";
export const SCOPE_A = "web-1", SCOPE_B = "web-2";

/** The page that the fake preparation reads (its text lines), by origin. */
export const CHECKOUT = ["Zoo entry – adult × 2: $48.00", "Service fee: $3.00", "Total: $51.00", "Deliver to: Ann Example", "Email: ann@example.com", "Tickets held for 09:59"];

export type Facts = { notReady: string | null; covers: boolean; tabs: Record<string, { id: number; url: string }[]> };
export type PayWorld = {
  dir: string; logs: string[]; events: any[]; clock: { t: number }; part: SignInsPart; facts: Facts;
  /** The page lines that the fake preparation reads, or a stop; and each call it got. */
  page: { lines: string[] | null; stop: Prepared | null; providerOrigin?: string; domain?: string; gate: Promise<void> | null };
  prepared: { req: PayRequestView; card: CardView; signal: AbortSignal }[];
  /** The fake act: each context it got, and what it gives (a function of the context). */
  acts: PayActContext[];
  actDoes: (ctx: PayActContext) => Promise<PayActEnd>;
  ask: (op: string, fields?: Record<string, unknown>, by?: Req["by"]) => Promise<any>;
  close: () => void;
};

let ids = 0;
/** The part with the option cardPay on (or off with `cardPay: false`), in a temp folder of its own. */
export function payWorld(o: { cardPay?: false | Partial<CardPayOptions>; dir?: string; waitMs?: number; newId?: () => string } = {}): PayWorld {
  const dir = o.dir ?? tempDir("ab-pay-");
  const logs: string[] = [], events: any[] = [];
  const clock = { t: T0 };
  const facts: Facts = { notReady: null, covers: true, tabs: { [SCOPE_A]: [{ id: 7, url: `${ORIGIN}/checkout?cart=1` }], [SCOPE_B]: [{ id: 8, url: `${ORIGIN}/checkout?cart=2` }] } };
  const w = { dir, logs, events, clock, facts, page: { lines: CHECKOUT, stop: null, gate: null }, prepared: [], acts: [] } as unknown as PayWorld;
  w.actDoes = async () => ({ state: "paid", text: `Paid: 51.00 USD to ${ORIGIN}, order SHOP-1001` });
  const cardPay: CardPayOptions | undefined = o.cardPay === false ? undefined : {
    world: { notReady: () => facts.notReady, covers: () => facts.covers, tabs: (scope) => facts.tabs[scope] ?? [] },
    prepare: async (req, card, signal) => {
      w.prepared.push({ req, card, signal });
      if (w.page.gate) await w.page.gate;
      if (w.page.stop) return w.page.stop;
      const order = parseOrder({ lines: w.page.lines ?? [], inputs: [] }, card);
      if ("stop" in order) return order;
      return { order: order as PageOrder, ...(w.page.providerOrigin ? { providerOrigin: w.page.providerOrigin } : {}), ...(w.page.domain ? { domain: w.page.domain } : {}) };
    },
    act: async (ctx) => { w.acts.push(ctx); return w.actDoes(ctx); },
    now: () => clock.t,
    repoOf: (scope) => (scope === SCOPE_A ? "agent-browser" : null),
    limits: { waitMs: o.waitMs ?? 10 * 60_000 },
    ...(o.newId ? { newId: o.newId } : {}),
    ...(o.cardPay ?? {}),
  };
  const part = new SignInsPart({ stateFolder: join(dir, "state"), log: (l) => logs.push(l), protections: () => null, now: () => new Date(clock.t), paneSecret: PANE_SECRET, kdfN: KDF.minN, ...(cardPay ? { cardPay } : {}) });
  part.attach((ev) => events.push(ev));
  w.part = part;
  w.ask = async (op, fields = {}, by = op === "sign_ins" ? DAEMON : OP) => {
    const r = await part.ops[op]({ t: "req", id: `p${++ids}`, op, by, ...fields } as Req);
    await new Promise((res) => setImmediate(res));
    return r;
  };
  w.close = () => { part.stop(); if (!o.dir) rmSync(dir, { recursive: true, force: true }); };
  return w;
}

export const iso = (t: number) => new Date(t).toISOString();
const paneKey = (w: PayWorld) => w.part.store.paneKey();
/** A pane's seal of the stored sign-ins' purpose with only op, rid and at (a set-up, an unlock, the card form). */
export function formSeal(w: PayWorld, op: string, payload: object, o: { at?: string; rid?: string } = {}) {
  const rid = o.rid ?? randomBytes(16).toString("base64url"), at = o.at ?? iso(w.clock.t);
  const s = sealPayload(payload, { purpose: "browser-sign-in", fields: { op, rid, at } }, paneKey(w));
  return { text: s.sealed, sender: s.senderPublicB64, rid, at };
}
/** The card form's values of a published test number. */
export const cardForm = (name = "travel", number: string = TEST_CARDS.visa) => ({ name, holder: TEST_CARD_VALUES.holder, number, expiry: TEST_CARD_VALUES.expiry, csc: TEST_CARD_VALUES.csc, postal: TEST_CARD_VALUES.postal });

/** The set-up of a new store: the first snapshot, the set-up, and the snapshot with its key.json and `records`. */
export async function setUp(w: PayWorld, records: object[] = []): Promise<any> {
  assert.deepEqual(await w.ask("sign_ins", { key: null, records: [] }), { data: { records: 0 } });
  const a = await w.ask("sign_ins_setup", { sealed: formSeal(w, "sign_ins_setup", { passphrase: PASSPHRASE }) });
  assert.ok(a.data?.key, JSON.stringify(a));
  assert.deepEqual(await w.ask("sign_ins", { key: a.data.key, records }), { data: { records: records.length } });
  return a.data.key;
}
/** A card's record file as the daemon writes it from an answer of card_seal. */
export const cardFile = (a: any) => ({ ...a.data.record, state: "usable", added: { at: "2026-11-21T14:00:00Z", by: "ann", via: "web" }, changed: null, sealed: a.data.sealed });
/** A store set up and open, with one card (card_seal, then the daemon's snapshot with its file). */
export async function withCard(w: PayWorld, form = cardForm(), others: object[] = []): Promise<{ key: any; file: any }> {
  const key = await setUp(w, others);
  const a = await w.ask("card_seal", { sealed: formSeal(w, "card_seal", form) });
  assert.ok(a.data?.record, JSON.stringify(a));
  const file = cardFile(a);
  assert.deepEqual(await w.ask("sign_ins", { key, records: [...others, file] }), { data: { records: others.length + 1 } });
  return { key, file };
}

/** The operator's pane's seal of an approval (C12): the purpose browser-pay and the binding of a pay_request event. */
export function approvalSeal(w: PayWorld, ev: any, answer: "approve" | "refuse" | string, o: { at?: string; rid?: string; fields?: Record<string, string>; purpose?: string } = {}) {
  const rid = o.rid ?? randomBytes(16).toString("base64url"), at = o.at ?? iso(w.clock.t);
  const fields = { op: "pay_approve", rid, at, request: ev.id, origin: ev.origin, amount: ev.order.total, currency: ev.order.currency, card: ev.card, order: hashOf(ev), ...o.fields };
  const s = sealPayload({ answer }, { purpose: o.purpose ?? "browser-pay", fields }, paneKey(w));
  return { text: s.sealed, sender: s.senderPublicB64, rid, at };
}
/** The page-order hash of an event's order (C12), computed here as the contract says (sorted keys, compact JSON). */
const canon = (x: unknown): string => Array.isArray(x) ? `[${x.map(canon).join(",")}]` : x !== null && typeof x === "object" ? `{${Object.keys(x).sort().map((k) => `${JSON.stringify(k)}:${canon((x as any)[k])}`).join(",")}}` : JSON.stringify(x);
export const hashOf = (ev: any) => createHash("sha256").update(canon(ev.order), "utf8").digest("hex");

/** The agent's call of browser_pay with the request's keys. */
export const PAY = { card: "travel", origin: ORIGIN, amount: "51.00", currency: "USD", description: "Two adult zoo tickets for Saturday" };
/** Wait until `test` holds (each turn of the loop, at most 2 s). */
export async function until(test: () => boolean, what: string): Promise<void> {
  const end = Date.now() + 2000;
  while (!test()) {
    if (Date.now() > end) throw new Error(`timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}
export const evs = (w: PayWorld, ev: string) => w.events.filter((e) => e.ev === ev);
