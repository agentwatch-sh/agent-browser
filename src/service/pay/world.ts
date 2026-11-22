// The facts of the model for C11's checks 1, 5 and 6 of the card payment (contract C11, the card payment; board ab-sta.6,
// the plan's Task 5a): PayRequests' `world` (request.ts) over the model's act port (model.ts, actPort).
//
// - Check 1: the readiness text, as the sign-in act's check 1 (the model's notReady).
// - Check 5: the scope's list covers the origin's host (lists/hosts.ts, coveredBy), with the entries of the scope's list
//   in the last allowlist line; a scope with no list covers no host.
// - Check 6: the scope's tabs with their URLs as Chrome gives them (tabs.get for each tab of the scope that a client
//   sees); PayRequests keeps the tabs of the request's origin, and a known provider's hosted payment page stops the
//   request, as the origin or when no tab shows the origin (board ab-sta.14). A tab whose read fails has no URL, so it
//   counts for no origin.

import { coveredBy } from "../lists/hosts.ts";
import type { PayWorld } from "./request.ts";

/** What the model gives the payment's checks (model.ts, actPort). */
export interface PayWorldPort {
  /** C11's readiness text, or null when ready. */
  notReady(): string | null;
  /** The entries of the scope's list in the last allowlist line, or null for a scope with no list. */
  entries(scope: string): readonly string[] | null;
  /** The scope's tabs that a client of the scope sees, each with its URL (empty when its read failed). */
  tabs(scope: string): Promise<{ id: number; url: string }[]>;
}

/** The real PayWorld of the service. */
export function payWorld(port: PayWorldPort): PayWorld {
  return {
    notReady: () => port.notReady(),
    covers: (scope, host) => coveredBy(port.entries(scope) ?? [], host),
    tabs: async (scope) => {
      const all = await port.tabs(scope).catch(() => []);
      return (Array.isArray(all) ? all : []).filter((t) => t !== null && typeof t === "object" && Number.isInteger(t.id) && typeof t.url === "string");
    },
  };
}
