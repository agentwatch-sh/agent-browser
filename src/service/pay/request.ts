// The card payment's requests in the service (contract C11, the card payment; C12, the card payments; the secure card
// checkout design, sections 7 and 8; the plan's Task 4, board ab-sta.5). No fill yet: the page's preparation (the
// session copy and the act page, with C11's check 8, the one private window) and the act (the fill, the press and the
// result) are the plan's Task 5, injected here (`prepare`, `act`); the tests give fakes.
//
// - open: C11's checks 1 to 7 in their order, with their texts (check 1's admission and readiness come as facts of the
//   caller and the world). A request that passes them gets its id (16 lowercase hex digits at random) and the agent's
//   tab, and it holds its scope (check 7) from then to its end. Its page is prepared; the page's total must be the
//   request's `amount` in its `currency`; then the service sends C12's `pay_request` and waits 10 minutes for the
//   operator's answer.
// - approve (C12's `pay_approve`): `kind: operator` only; the snapshot and the state; the request (unknown, ended,
//   expired or answered: gone); the pane's seal with the purpose `browser-pay` and the binding of the service's own
//   request (its id, origin, amount, currency, card and page-order hash). A seal that does not open with it ends the
//   request, and no act starts. The operator's refusal ends it. An approval starts the act once, and is good for one act
//   within 10 minutes.
// - Each end of a request that sent a `pay_request` sends C12's `pay_result` once; each request's result goes to the
//   keep (keep.ts); `status` reads the keep for `browser_pay_status`.
//
// R1: no answer, event, status or log line holds a value of the card. The card's values are opened at check 4 only for
// C11's digit filter of the page's order (the number and the expiry, in buffers that go to zeros after the read), and the
// act opens them again (ctx.openCard). No log line holds the page's order, the agent's description, a URL path or a query.

import { randomBytes } from "node:crypto";
import { userInfo } from "node:os";
import { SCOPE } from "../../relay/scopes.ts";
import { ERR, type By } from "../control.ts";
import { PAY_PURPOSE, zero } from "../signins/seal.ts";
import { originFits, TEXT as STORE_TEXT, type StoreState } from "../signins/store.ts";
import type { CardView } from "./digits.ts";
import { isoTime, PayKeep, type KeptResult } from "./keep.ts";
import { orderForRequest, orderHash, type EventOrder, type PageOrder } from "./order.ts";
import { isProviderOrigin } from "./providers.ts";
import { agentAnswer, alertOf, PAY_TEXT, type PayState } from "./texts.ts";

/** C12's texts of `pay_approve`. */
export const APPROVE_TEXT = { gone: "this payment request is gone", mismatch: "this approval does not match the payment request" } as const;
/** The first values (C11; the plan's Global Constraints). */
export const PAY_LIMITS = { waitMs: 10 * 60_000, approvalMs: 10 * 60_000 } as const;
/** The key `amount` (C11): a decimal string above 0 with at most two decimals (the allow list's pattern). */
export const AMOUNT = /^(?!0+(?:\.0{1,2})?$)(?:0|[1-9][0-9]*)(?:\.[0-9]{1,2})?$/;
export const CURRENCY = /^[A-Z]{3}$/;
const DESCRIPTION_CHARS = 500, BUTTON_CHARS = 100;

/** A payment's result (C11): its state and text of C11's table, its time (ms) and the request's origin. */
export type PayResult = { state: PayState; text: string; at: number; origin: string };
/** The answer of `open`: the result, and the tool's text for the agent (C11, what the agent sees). */
export type PayOutcome = PayResult & { answer: string; isError: boolean };
/** The caller (C11, check 1): the MCP session's scope, its admission, and its cancel. */
export type PayCaller = { scope: string; admission: "local" | "remote"; signal?: AbortSignal };
/** A request after its checks: what the preparation and the act get (no value of the card). */
export type PayRequestView = {
  readonly id: string; readonly scope: string; readonly origin: string; readonly amount: string; readonly currency: string;
  readonly card: string; readonly description: string; readonly button: string | null; readonly tab: { readonly id: number; readonly url: string };
};
/**
 * The preparation's answer (the plan's Task 5): the act page's order, and the provider's origin when the page pays
 * through a provider's hosted page; or a stop with C11's text (`noRequest`: check 8's refusal, before the request, so no
 * keep). `domain`: the merchant's registrable domain when the session copy ran (the agent's text gets the block's line).
 */
export type Prepared = ({ order: PageOrder; providerOrigin?: string } | { stop: string; noRequest?: boolean }) & { domain?: string; blocked?: number; guarded?: number };
/** What the act gets after the approval (the plan's Task 5). */
export type PayActContext = {
  readonly request: PayRequestView;
  /** The approved page-order hash: the act reads the order again, and another hash stops it. */
  readonly order: string;
  /** The approval's time and the end of its 10 minutes (ms). */
  readonly approval: { readonly at: number; readonly until: number };
  /** The card's values again, from the last snapshot (C11): the act fills the buffers with zeros after its use. */
  openCard(): { values: CardBuffers } | { stop: string };
  /** C11's keep right before the press: `unknown` with the Unknown text; false when the write failed (the act then does not press). */
  keepUnknown(): boolean;
  /** C12's `pay` event: `start` right before the act's first key, `end` at the act's end. */
  pay(state: "start" | "end"): void;
};
export type PayActEnd = { state: PayState; text: string; blocked?: number; guarded?: number };
export type CardBuffers = { holder: Buffer; number: Buffer; expiry: Buffer; csc: Buffer; postal: Buffer };

/** The store's part of the payment (store.ts). */
export interface PayStore {
  state(): StoreState;
  /** The snapshot and the state of `pay_approve`'s check, or null when the store is open. */
  payState(): string | null;
  namedCard(name: string): { fields: { id: string; name: string }; file: Record<string, unknown> } | null;
  openCard(file: Record<string, unknown>): { values: CardBuffers } | { refused: "locked" | "cannot_open" };
  paySeal(sealed: { text: string; sender: string; rid: string; at: string }, purpose: string, fields: Record<string, string>): Record<string, unknown> | "rules" | "open";
}
/** The facts of the model for checks 1, 5 and 6 (the plan's Task 5 gives the real ones). */
export interface PayWorld {
  /** C11's readiness text, or null when ready (check 1). */
  notReady(): string | null;
  /** The scope's list covers the host (check 5). */
  covers(scope: string, host: string): boolean;
  /** The scope's tabs: their ids and URLs (check 6). */
  tabs(scope: string): { id: number; url: string }[];
}
export type PayRequestsOptions = {
  store: PayStore;
  /** The service's state folder: pay-results.json is in it. */
  stateFolder: string;
  log: (line: string) => void;
  /** C12's events `pay_request`, `pay_result` and `pay` (only with the feature card_pay: signins/part.ts). */
  emit: (ev: Record<string, unknown>) => void;
  world: PayWorld;
  /** The session copy and the act page (the plan's Task 5): the page's order, or a stop. It ends at the signal. */
  prepare(req: PayRequestView, card: CardView, signal: AbortSignal): Promise<Prepared>;
  /** The act after the approval (the plan's Task 5): the fill, the press and the result. */
  act(ctx: PayActContext): Promise<PayActEnd>;
  /** The repo of the scope's session in the last set_sessions (the log line). */
  repoOf?: (scope: string) => string | null;
  /** Tests only: the test merchant's provider origins (`https://pay.localhost`), never in the shipped list. */
  providerOrigins?: readonly string[];
  /** Tests only: the clock (ms), a request id, shorter waits. */
  now?: () => number;
  newId?: () => string;
  limits?: Partial<{ waitMs: number; approvalMs: number; keepMs: number }>;
};

type Live = {
  view: PayRequestView;
  phase: "preparing" | "waiting" | "approved" | "ended";
  order: EventOrder | null;
  hash: string | null;
  providerOrigin: string | null;
  expires: number;
  domain: string | null;
  sent: boolean;
  t0: number;
  blocked: number;
  guarded: number;
  timer: NodeJS.Timeout | null;
  cancelled: boolean;
  abort: AbortController;
  unknownKept: boolean;
  payOpen: boolean;
  done: (r: PayOutcome) => void;
};

export class PayRequests {
  private readonly o: PayRequestsOptions;
  private readonly now: () => number;
  private readonly keep: PayKeep;
  private readonly live = new Map<string, Live>();
  private readonly user: string;
  private readonly waitMs: number;
  private readonly approvalMs: number;

  constructor(o: PayRequestsOptions) {
    this.o = o;
    this.now = o.now ?? Date.now;
    this.waitMs = o.limits?.waitMs ?? PAY_LIMITS.waitMs;
    this.approvalMs = o.limits?.approvalMs ?? PAY_LIMITS.approvalMs;
    this.keep = new PayKeep({ stateFolder: o.stateFolder, log: o.log, now: this.now, keepMs: o.limits?.keepMs });
    let user = "unknown";
    try { user = userInfo().username; } catch { /* no passwd entry */ }
    this.user = user;
  }

  // ---------------------------------------------------------------- browser_pay

  /** C11's `browser_pay` for one call: the result at the request's end, or at once for a refusal by checks 1 to 7. */
  async open(input: Record<string, unknown>, caller: PayCaller): Promise<PayOutcome> {
    const t0 = this.now();
    const checked = this.checks(input, caller);
    if ("stop" in checked) {
      this.logLine({ id: null, scope: caller.scope, input, state: "stopped", ms: this.now() - t0, blocked: 0, guarded: 0 });
      return this.outcome({ state: "stopped", text: checked.stop, at: this.now(), origin: originFits(input.origin) ? input.origin as string : "" }, null);
    }
    const { view, card } = checked;
    let done!: (r: PayOutcome) => void;
    const result = new Promise<PayOutcome>((r) => { done = r; });
    const live: Live = { view, phase: "preparing", order: null, hash: null, providerOrigin: null, expires: 0, domain: null, sent: false, t0, blocked: 0, guarded: 0,
      timer: null, cancelled: false, abort: new AbortController(), unknownKept: false, payOpen: false, done };
    // The request holds its scope from here (check 7): no await came between the checks and this line.
    this.live.set(view.id, live);
    const onCancel = () => this.cancel(live);
    caller.signal?.addEventListener("abort", onCancel, { once: true });
    if (caller.signal?.aborted) onCancel();
    void this.prepare(live, card).catch(() => this.end(live, "stopped", PAY_TEXT.noWindow)).finally(() => { zero(card.number, card.expiry); });
    const r = await result;
    caller.signal?.removeEventListener("abort", onCancel);
    return r;
  }

  /** C11's checks 1 to 7, in order; the first that fails gives its text. On success the request's view and the card's view. */
  private checks(input: Record<string, unknown>, caller: PayCaller): { stop: string } | { view: PayRequestView; card: CardView } {
    // Check 1: a local admission, and the agent browser is ready.
    if (caller.admission !== "local") return { stop: PAY_TEXT.remote };
    const notReady = this.o.world.notReady();
    if (notReady !== null) return { stop: notReady };
    // Check 2: each key has its form.
    const { card, origin, amount, currency, description, button } = input;
    if (typeof card !== "string" || !SCOPE.test(card)) return { stop: PAY_TEXT.key("card") };
    if (!originFits(origin)) return { stop: PAY_TEXT.key("origin") };
    if (typeof amount !== "string" || !AMOUNT.test(amount)) return { stop: PAY_TEXT.amount };
    if (typeof currency !== "string" || !CURRENCY.test(currency)) return { stop: PAY_TEXT.currency };
    if (typeof description !== "string" || [...description].length > DESCRIPTION_CHARS) return { stop: PAY_TEXT.description };
    if (button !== undefined && (typeof button !== "string" || [...button].length > BUTTON_CHARS)) return { stop: PAY_TEXT.key("button") };
    // Check 3: the store is open.
    if (this.o.store.state() !== "open") return { stop: PAY_TEXT.locked };
    // Check 4: a card of the name (a record of the kind card), and it opens. Only the number and the expiry stay, for the filter.
    const found = this.o.store.namedCard(card);
    if (!found) return { stop: PAY_TEXT.noCard(card) };
    const opened = this.o.store.openCard(found.file);
    if ("refused" in opened) return { stop: opened.refused === "locked" ? PAY_TEXT.locked : PAY_TEXT.cardCannotOpen };
    const v = opened.values;
    const view: CardView = { number: Buffer.from(v.number), expiry: Buffer.from(v.expiry) };
    zero(v.holder, v.number, v.expiry, v.csc, v.postal);
    const fail = (stop: string) => { zero(view.number, view.expiry); return { stop }; };
    // Check 5: the scope's list covers the origin's host.
    const host = new URL(origin as string).hostname;
    if (!this.o.world.covers(caller.scope, host)) return fail(PAY_TEXT.notAllowed(host));
    // Check 6: exactly one tab of the scope shows a page of the origin, or a known provider's hosted payment page.
    const tabs = this.o.world.tabs(caller.scope).filter((t) => {
      const o = URL.canParse(t.url) ? new URL(t.url).origin : null;
      return o !== null && (o === origin || isProviderOrigin(o, this.o.providerOrigins));
    });
    if (tabs.length !== 1) return fail(PAY_TEXT.oneTab(origin as string));
    // Check 7: no other payment request of the scope waits.
    if ([...this.live.values()].some((x) => x.view.scope === caller.scope)) return fail(PAY_TEXT.scopeWaits);
    const id = this.o.newId?.() ?? randomBytes(8).toString("hex");
    return {
      view: { id, scope: caller.scope, origin: origin as string, amount, currency, card, description, button: typeof button === "string" ? button : null, tab: { id: tabs[0].id, url: tabs[0].url } },
      card: view,
    };
  }

  /** The page's preparation, the total's check and the `pay_request`; then the request waits for the operator. */
  private async prepare(live: Live, card: CardView): Promise<void> {
    let p: Prepared;
    try { p = await this.o.prepare(live.view, card, live.abort.signal); }
    catch { p = { stop: PAY_TEXT.noWindow }; }
    live.domain = p.domain ?? null;
    live.blocked += p.blocked ?? 0;
    live.guarded += p.guarded ?? 0;
    if (live.cancelled) { this.end(live, "stopped", PAY_TEXT.cancelled); return; }
    if ("stop" in p) { this.end(live, "stopped", p.stop, { kept: !p.noRequest }); return; }
    const order = orderForRequest(p.order, live.view, card);
    if ("stop" in order) { this.end(live, "stopped", order.stop); return; }
    live.order = order;
    live.hash = orderHash(order);
    live.providerOrigin = p.providerOrigin ?? null;
    live.phase = "waiting";
    live.expires = this.now() + this.waitMs;
    live.timer = setTimeout(() => this.end(live, "stopped", PAY_TEXT.expired), this.waitMs);
    live.timer.unref?.();
    live.sent = true;
    this.o.emit(this.requestEvent(live));
  }

  /** C12's `pay_request` of a waiting request; `earlier` from the keep, read again at each send. */
  private requestEvent(live: Live): Record<string, unknown> {
    const v = live.view;
    const earlier = this.keep.of((e) => e.origin === v.origin && e.id !== v.id).map((e) => ({ state: e.state, text: e.text, at: e.at }));
    return { t: "ev", ev: "pay_request", id: v.id, scope: v.scope, origin: v.origin, ...(live.providerOrigin ? { provider_origin: live.providerOrigin } : {}),
      order: live.order, description: v.description, card: v.card, expires: isoTime(live.expires), earlier };
  }

  /** C12: each `pay_request` that still waits goes again after each new hello of the daemon, with the same id. */
  resend(): void {
    for (const live of this.live.values()) if (live.phase === "waiting") this.o.emit(this.requestEvent(live));
  }

  /** The agent's cancel: before the approval it ends the request (a preparation ends first); after it, the act goes on. */
  private cancel(live: Live): void {
    if (live.phase === "preparing") { live.cancelled = true; live.abort.abort(); return; }
    if (live.phase === "waiting") this.end(live, "stopped", PAY_TEXT.cancelled);
  }

  // ---------------------------------------------------------------- pay_approve (C12)

  /** C12's `pay_approve` after the door's checks: the snapshot and the state, the request, then the seal. */
  approve(requestId: string, sealed: { text: string; sender: string; rid: string; at: string }, kind: By["kind"]): { data: Record<string, unknown> } | { error: string } {
    if (kind !== "operator") return { error: ERR.notOperator };
    const state = this.o.store.payState();
    if (state !== null) return { error: state };
    const live = this.live.get(requestId);
    if (!live || live.phase !== "waiting") return { error: APPROVE_TEXT.gone };
    if (this.now() >= live.expires) { this.end(live, "stopped", PAY_TEXT.expired); return { error: APPROVE_TEXT.gone }; }
    const v = live.view;
    const r = this.o.store.paySeal(sealed, PAY_PURPOSE, { op: "pay_approve", request: v.id, origin: v.origin, amount: v.amount, currency: v.currency, card: v.card, order: live.hash! });
    if (r === "rules") return { error: STORE_TEXT.sealed };
    if (r === "open") {
      this.o.log(`pay: request ${v.id}: an approval that does not match it; the request ends`);
      this.end(live, "stopped", PAY_TEXT.mismatch);
      return { error: APPROVE_TEXT.mismatch };
    }
    if (r.answer === "refuse") {
      this.o.log(`pay: request ${v.id}: the operator refused it`);
      this.end(live, "stopped", PAY_TEXT.refused);
      return { data: {} };
    }
    if (r.answer !== "approve") return { error: STORE_TEXT.sealed };
    // The approval: the request id is used from here, and the act runs once.
    live.phase = "approved";
    if (live.timer) clearTimeout(live.timer);
    live.timer = null;
    this.o.log(`pay: request ${v.id}: the operator approved it`);
    void this.runAct(live);
    return { data: {} };
  }

  private async runAct(live: Live): Promise<void> {
    const at = this.now();
    const ctx: PayActContext = {
      request: live.view,
      order: live.hash!,
      approval: { at, until: at + this.approvalMs },
      openCard: () => {
        const found = this.o.store.namedCard(live.view.card);
        if (this.o.store.state() !== "open") return { stop: PAY_TEXT.lockedBefore };
        if (!found) return { stop: PAY_TEXT.cardCannotOpen };
        const o = this.o.store.openCard(found.file);
        return "refused" in o ? { stop: o.refused === "locked" ? PAY_TEXT.lockedBefore : PAY_TEXT.cardCannotOpen } : { values: o.values };
      },
      keepUnknown: () => {
        if (live.phase !== "approved") return false;
        const ok = this.keep.put(this.kept(live, "unknown", PAY_TEXT.unknown, this.now()));
        if (ok) live.unknownKept = true;
        return ok;
      },
      pay: (state) => {
        if (live.phase !== "approved" || (state === "start") === live.payOpen) return;
        live.payOpen = state === "start";
        this.o.emit({ t: "ev", ev: "pay", state });
      },
    };
    let end: PayActEnd;
    try { end = await this.o.act(ctx); }
    catch { end = { state: "stopped", text: PAY_TEXT.lostBefore }; }
    live.blocked += end.blocked ?? 0;
    live.guarded += end.guarded ?? 0;
    // C11: every end after the press that is not Paid or Declined is Unknown.
    if (live.unknownKept && end.state === "stopped") end = { state: "unknown", text: PAY_TEXT.unknown };
    this.end(live, end.state, end.text);
  }

  // ---------------------------------------------------------------- the end, the keep, the status

  private kept(live: Live, state: PayState, text: string, at: number): KeptResult {
    return { id: live.view.id, scope: live.view.scope, origin: live.view.origin, state, text, at: isoTime(at), alert: alertOf(state, text) };
  }

  /** A request's end: the keep, C12's `pay_result` (only after a `pay_request`), a `pay` end that is owed, the log line. */
  private end(live: Live, state: PayState, text: string, o: { kept?: boolean } = {}): void {
    if (live.phase === "ended") return;
    live.phase = "ended";
    if (live.timer) clearTimeout(live.timer);
    live.timer = null;
    this.live.delete(live.view.id);
    const at = this.now();
    if (o.kept !== false) this.keep.put(this.kept(live, state, text, at));
    if (live.payOpen) { live.payOpen = false; this.o.emit({ t: "ev", ev: "pay", state: "end" }); }
    if (live.sent) {
      const v = live.view;
      this.o.emit({ t: "ev", ev: "pay_result", id: v.id, scope: v.scope, origin: v.origin, state, text, at: isoTime(at), alert: alertOf(state, text) });
    }
    // Check 8's refusal (`kept` false) started no request: its log line names none.
    this.logLine({ id: o.kept === false ? null : live.view.id, scope: live.view.scope, input: live.view, state, ms: at - live.t0, blocked: live.blocked, guarded: live.guarded });
    live.done(this.outcome({ state, text, at, origin: live.view.origin }, live.domain));
  }

  private outcome(r: PayResult, domain: string | null): PayOutcome {
    const a = agentAnswer(r.state, r.text, domain);
    return { ...r, answer: a.text, isError: a.isError };
  }

  /**
   * C11's log line of each call: the user, the scope, the session's repo, the request id, the card's name, the origin,
   * the amount and the currency, the state, the time, and the requests that the block and the guard stopped. A value of
   * a key that breaks its form is not logged; no line holds a value of the card, the order, the description or a path.
   */
  private logLine(e: { id: string | null; scope: string; input: Record<string, unknown> | PayRequestView; state: PayState; ms: number; blocked: number; guarded: number }): void {
    const i = e.input as Record<string, unknown>;
    const card = typeof i.card === "string" && SCOPE.test(i.card) ? i.card : "none";
    const origin = originFits(i.origin) ? i.origin as string : "none";
    const amount = typeof i.amount === "string" && AMOUNT.test(i.amount) ? i.amount : "none";
    const currency = typeof i.currency === "string" && CURRENCY.test(i.currency) ? i.currency : "none";
    const scope = SCOPE.test(e.scope) ? e.scope : "none";
    this.o.log(`pay: request ${e.id ?? "none"}: user ${this.user}, scope ${scope}, repo ${this.o.repoOf?.(e.scope) ?? "none"}, card ${card}, origin ${origin}, amount ${amount} ${currency}, state ${e.state}, ${Math.round(e.ms)} ms, ${e.blocked} blocked, ${e.guarded} guarded`);
  }

  /** The scope's results of the last 24 hours from the keep, the newest first. */
  results(scope: string): PayResult[] {
    return this.keep.of((e) => e.scope === scope).map((e) => ({ state: e.state, text: e.text, at: Date.parse(e.at), origin: e.origin }));
  }

  /** `browser_pay_status`'s compact JSON (C11): `{"results":[{"state","text","at","origin"}]}`, the newest first. */
  status(scope: string): string {
    return JSON.stringify({ results: this.keep.of((e) => e.scope === scope).map((e) => ({ state: e.state, text: e.text, at: e.at, origin: e.origin })) });
  }

  /** The requests that have not ended (tests; the status of a later task). */
  waiting(): number { return this.live.size; }

  /**
   * The service stops: each request ends, and its window goes. A request after the press is `unknown` (C11: a stop of the
   * service after the press); each other one lost its payment window before the payment. No text names the stop (I2).
   */
  stop(): void {
    for (const live of [...this.live.values()]) {
      live.abort.abort();
      if (live.unknownKept) this.end(live, "unknown", PAY_TEXT.unknown);
      else this.end(live, "stopped", PAY_TEXT.lostBefore);
    }
  }
}
