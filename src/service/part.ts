// A part of `agent-browser service` that adds ops to the control door (contract C12, "The ops of stage 1a"): each stage
// adds its part to the service's table (stage 1c: the lists, the scopes, the prompts and the sign-ins, stage1c.ts),
// and stage 1a's handler (service.ts) gives each part its ops and the daemon's own requests.

import type { Answer, Req } from "./control.ts";

export interface ServicePart {
  /** The ops that this part adds, each with its work; an op can answer later (a promise). */
  readonly ops: Readonly<Record<string, (req: Req) => Answer | Promise<Answer>>>;
  /** The control door's event stream, at the open. */
  attach?(emit: (ev: Record<string, unknown>) => void): void;
  /** After stage 1a applied `config`, with agentwatch's browser.* keys (stage 1b part 1's Chrome unit). */
  onConfig?(keys: Record<string, unknown>): void;
  /** After stage 1a applied `set_sessions` (a complete snapshot). */
  setSessions?(req: Req): void;
  /** After stage 1a applied `session_ended`. */
  sessionEnded?(scope: string): void;
  /** The part's keys of `status`'s data (they replace stage 1a's keys of the same name). */
  status?(): Record<string, unknown>;
  /** Sentences that the part adds to the state's texts: `agent` to the agent's text (I2: none names a stop or a start), `operator` to the operator's. */
  notes?(): { agent: string[]; operator: string[] };
  /** The service stops. */
  stop?(): void;
}
