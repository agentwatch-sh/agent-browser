// The stored sign-ins' part of `agent-browser service` (contract C12, "The stored sign-ins"; board ab-v16.97.2, stage 1e
// part 1): the eight ops, the feature `sign_ins` in the hello, the key `sign_ins` of `status`, and the `sign_ins` event
// at each change of the store's state. The store is store.ts; the protections of the service's memory are protect.ts.
// On the Mac the store stays off until stage 4 (C11, the sign-in act): the service has no such part there.
//
// The card payments (C12, "The card payments"; board ab-sta.5): the ops `card_seal` and `pay_approve`, the events
// `pay_request`, `pay_result` and `pay`, and the feature `card_pay` in the hello come only with the option `cardPay`.
// It is off by default: main.ts and the fake never give it (C12: no hello has the feature card_pay yet), so both ops
// answer `unsupported` and no event of the payment goes; the tests turn it on.

import { SIGN_IN_OPS, type Answer, type By, type Req } from "../control.ts";
import type { ServicePart } from "../part.ts";
import { PayRequests, type PayRequestsOptions } from "../pay/request.ts";
import { SignInStore, type SignInStoreOptions, type StoreState } from "./store.ts";

/** The ops of stage 1e part 1 (C12, "The ops of stage 1a": the stored sign-ins come with stage 1e part 1). */
export const STAGE_1E1_OPS = SIGN_IN_OPS;
/** The feature name of the stored sign-ins (C12, the hello). */
export const SIGN_INS_FEATURE = "sign_ins";
/** The feature name of the card payments (C12, the card payments): only a part with the option `cardPay` gives it. */
export const CARD_PAY_FEATURE = "card_pay";
/** The ops of the card payments (C12): only with the feature `card_pay`. */
export const CARD_PAY_OPS = ["card_seal", "pay_approve"] as const;
/** The card payments' option (tests only, off by default): PayRequests' facts and the preparation and the act. */
export type CardPayOptions = Omit<PayRequestsOptions, "store" | "stateFolder" | "log" | "emit">;

export class SignInsPart implements ServicePart {
  readonly store: SignInStore;
  /** The card payments' requests, only with the option `cardPay` (the feature `card_pay`). */
  readonly pay: PayRequests | null;
  readonly ops: Readonly<Record<string, (req: Req) => Answer | Promise<Answer>>>;
  private emit: (ev: Record<string, unknown>) => void = () => {};
  /** The state of the last `sign_ins` event: the store starts in `none` (C12: an event at each change). */
  private told: StoreState = "none";

  constructor(o: SignInStoreOptions & { cardPay?: CardPayOptions }) {
    const { cardPay, ...storeOptions } = o;
    this.store = new SignInStore(storeOptions);
    const op = (req: Req): Answer | Promise<Answer> => {
      const a = this.store.handle(req);
      if (!(a instanceof Promise)) { this.tell(); return a; }
      // An op that answers later: its event goes out after its answer, as the door sends the events of an op that answers at once.
      return a.finally(() => setImmediate(() => this.tell()));
    };
    const ops: Record<string, (req: Req) => Answer | Promise<Answer>> = Object.fromEntries(STAGE_1E1_OPS.map((name) => [name, op]));
    this.pay = cardPay ? new PayRequests({ ...cardPay, store: this.store, stateFolder: o.stateFolder, log: o.log, emit: (ev) => this.emit(ev) }) : null;
    if (this.pay) {
      const pay = this.pay;
      ops.card_seal = op;
      ops.pay_approve = (req) => pay.approve(req.request as string, req.sealed as { text: string; sender: string; rid: string; at: string }, (req.by as By).kind);
    }
    this.ops = ops;
  }

  private tell(): void {
    const state = this.store.state();
    if (state === this.told) return;
    this.told = state;
    this.emit({ t: "ev", ev: "sign_ins", state, pane_key: this.store.paneKey() });
  }

  attach(emit: (ev: Record<string, unknown>) => void): void { this.emit = emit; }
  /** The sign-in act's `sign_in` events (C12), on the control door's stream. */
  emitEvent(ev: Record<string, unknown>): void { this.emit(ev); }
  features(): readonly string[] { return this.pay ? [SIGN_INS_FEATURE, CARD_PAY_FEATURE] : [SIGN_INS_FEATURE]; }
  status(): Record<string, unknown> { return { sign_ins: this.store.status() }; }
  /** C12: each `pay_request` that still waits goes again after each new hello of the daemon. */
  onHello(): void { this.pay?.resend(); }
  stop(): void { this.pay?.stop(); this.store.stop(); }
}
