// The stored sign-ins' part of `agent-browser service` (contract C12, "The stored sign-ins"; board ab-v16.97.2, stage 1e
// part 1): the eight ops, the feature `sign_ins` in the hello, the key `sign_ins` of `status`, and the `sign_ins` event
// at each change of the store's state. The store is store.ts; the protections of the service's memory are protect.ts.
// On the Mac the store stays off until stage 4 (C11, the sign-in act): the service has no such part there.

import { SIGN_IN_OPS, type Answer, type Req } from "../control.ts";
import type { ServicePart } from "../part.ts";
import { SignInStore, type SignInStoreOptions, type StoreState } from "./store.ts";

/** The ops of stage 1e part 1 (C12, "The ops of stage 1a": the stored sign-ins come with stage 1e part 1). */
export const STAGE_1E1_OPS = SIGN_IN_OPS;
/** The feature name of the stored sign-ins (C12, the hello). */
export const SIGN_INS_FEATURE = "sign_ins";

export class SignInsPart implements ServicePart {
  readonly store: SignInStore;
  readonly ops: Readonly<Record<string, (req: Req) => Answer | Promise<Answer>>>;
  private emit: (ev: Record<string, unknown>) => void = () => {};
  /** The state of the last `sign_ins` event: the store starts in `none` (C12: an event at each change). */
  private told: StoreState = "none";

  constructor(o: SignInStoreOptions) {
    this.store = new SignInStore(o);
    const op = (req: Req): Answer | Promise<Answer> => {
      const a = this.store.handle(req);
      if (!(a instanceof Promise)) { this.tell(); return a; }
      // An op that answers later: its event goes out after its answer, as the door sends the events of an op that answers at once.
      return a.finally(() => setImmediate(() => this.tell()));
    };
    this.ops = Object.fromEntries(STAGE_1E1_OPS.map((name) => [name, op]));
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
  features(): readonly string[] { return [SIGN_INS_FEATURE]; }
  status(): Record<string, unknown> { return { sign_ins: this.store.status() }; }
  stop(): void { this.store.stop(); }
}
