// The one-time tickets of the MCP's own CDP connections (contract C11, "The MCP inside the service"; stage 1d of the
// self-contained agent browser, board ab-v16.94.5, part 2b). The MCP's Playwright runs in the scope's worker thread, in
// the service's own process, so the agent door's walk cannot place it in a session: it connects back to the endpoint's
// CDP path with its MCP session's scope and a ticket in the query, `?ticket=<ticket>`. The agent door takes a ticket only
// from a connection whose peer is the service's own pid, once, for the scope that it was made for, and only within its
// life. The ticket never leaves the process (the worker gets it as a message, and Playwright's own log leaves the query
// out), so it is no bearer secret in C3's sense: no other process can use it. No log line holds a ticket.

import { randomBytes } from "node:crypto";

/** A ticket's life: the worker connects at once, so a ticket that waits longer is gone (first value). */
export const TICKET_MS = 30_000;
/** The query key of the ticket on the endpoint's CDP path. */
export const TICKET_KEY = "ticket";

export class Tickets {
  private readonly live = new Map<string, { scope: string; until: number }>();
  private readonly now: () => number;
  private readonly pid: number;
  constructor(o: { now?: () => number; pid?: number } = {}) { this.now = o.now ?? Date.now; this.pid = o.pid ?? process.pid; }

  /** A new ticket for `scope`: 32 random bytes, base64url (no `:`, so a `ws+unix://` URL keeps its path). */
  mint(scope: string): string {
    const t = randomBytes(32).toString("base64url");
    this.live.set(t, { scope, until: this.now() + TICKET_MS });
    for (const [k, v] of this.live) if (v.until <= this.now()) this.live.delete(k);
    return t;
  }

  /**
   * The agent door's check of a connection that carries a ticket: true when the peer is the service's own pid and the
   * ticket is live and of `scope`. Each ticket is gone after its first check, whatever its result.
   */
  take(ticket: string, scope: string, peerPid: number): boolean {
    const t = this.live.get(ticket);
    if (t === undefined) return false;
    this.live.delete(ticket);
    return peerPid === this.pid && t.scope === scope && this.now() < t.until;
  }

  /** The tickets that are still live (for the tests). */
  get size(): number { return this.live.size; }
}

/** The ticket of a request target (`/devtools/browser/<scope>?ticket=<ticket>`), or null. */
export function ticketOf(target: string): string | null {
  const q = target.indexOf("?");
  if (q < 0) return null;
  const v = new URLSearchParams(target.slice(q + 1)).getAll(TICKET_KEY);
  return v.length === 1 && v[0] !== "" ? v[0] : null;
}
