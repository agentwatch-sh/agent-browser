// The receiver port of the service (stage 1c of the self-contained agent browser, board ab-v16.94.4). Stage 1c's
// lists, scopes, prompts and sign-ins talk to the agent extension (the receiver, C4) and to the browser model (C10)
// through this one small interface. Stage 1c has no native link and no model in the service: until stage 1b part 2
// (board ab-v16.94.9) puts the port on the real native link, the service runs with NO_RECEIVER, so no scope object
// and no import goes out, and the model gets no allowlist line (it fails closed). Its tests use a fake of the port.
//
// What part 2 wires, with no change to stage 1c's logic:
// - attach(events): the service gives its handlers once, at its start.
//   - events.up(): a receiver said its hello on a new link, and the hello lists the feature `scopes` (the pinned agent
//     package has it). Each up is a new link: an answer to a request of an earlier link does not count.
//   - events.down(): the link went down.
//   - events.blocked(b): a blocked navigation, C4's `blocked` from the receiver ({host, scope, from}) or C10's
//     `daemon.blocked` from the model (with `from` null). Part 2's carrier answers `daemon.blocked` itself (C10).
// - isUp(): true between an up and the next down.
// - request(op, body, waitMs): one request of C4's channel `main`: `set_scopes` (body: the object's fields, wait 10 s)
//   or `import` (body {state}, wait 120 s). The port adds `t`, `id` and `op`, sends one main request at a time and cuts
//   it into parts (C4); the wait counts from the send. It resolves with the res's `data`; it rejects with a
//   ReceiverError: `refused` (ok:false, with the receiver's error text), `timeout` (no answer in the wait; a late
//   answer is dropped), `dropped` (the link went down while the request ran) or `down` (no link: nothing went).
// - allowlist(line): C10's allowlist line to the model, after an ok in time of the object on the same link.
// - endScope(scope): C10's end_scope to the model, at a session's end.
//
// No method of the port logs a payload, a cookie or a page; a request's body is never logged.

import type { Blocked } from "./prompts/prompts.ts";
import type { AllowlistLine } from "./lists/scopes.ts";

export type { Blocked };

export type ReceiverEvents = {
  up(): void;
  down(): void;
  blocked(b: Blocked): void;
};

export type ReceiverErrorKind = "refused" | "timeout" | "dropped" | "down";

/** A request of channel main that got no ok: the receiver's ok:false text, no answer in time, a drop, or no link. */
export class ReceiverError extends Error {
  readonly kind: ReceiverErrorKind;
  constructor(kind: ReceiverErrorKind, message: string = kind) { super(message); this.name = "ReceiverError"; this.kind = kind; }
}

export interface ReceiverPort {
  attach(events: ReceiverEvents): void;
  isUp(): boolean;
  request(op: "set_scopes" | "import", body: Record<string, unknown>, waitMs: number): Promise<Record<string, unknown>>;
  allowlist(line: AllowlistLine): void;
  endScope(scope: string): void;
}

/** The port of a service with no native link (stage 1c alone): never up; a request goes nowhere. */
export const NO_RECEIVER: ReceiverPort = {
  attach() {},
  isUp: () => false,
  request: async () => { throw new ReceiverError("down", "the agent extension is not connected"); },
  allowlist() {},
  endScope() {},
};
