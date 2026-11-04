// The relay's side of the bridge (contract C10 in chrome-extension's docs/protocol.md, the master). Each request
// is one JSON line on the relay's standard output; the agentwatch daemon carries it to the agent-mode extension and
// writes each answer and event as one line on the relay's standard input. No log line carries the args, the results
// or the event params: they can hold page content and sign-in values.

import { randomBytes } from "node:crypto";

export const WAIT_DEFAULT_MS = 30_000;
export const WAIT_MAX_MS = 600_000;
export const MAX_IN_FLIGHT_PER_TAB = 64;
/** The longest request line (C10) and the longest client message (C11), in bytes. */
export const MAX_REQUEST = 134_217_728;
/** The text of a request that the relay does not send because its line would be longer than MAX_REQUEST. */
export const REQUEST_TOO_LARGE = "request too large";

/** An error answer of the bridge: the receiver's or the daemon's text (C10), or Chrome's. `wait` is the request's deadline. */
export class BridgeError extends Error {
  readonly wait: number;
  constructor(message: string, wait: number) { super(message); this.wait = wait; }
}

/** The ops whose in-flight key is a tab: the first arg, or the target of debugger.sendCommand. Every other op shares one key. */
const TAB_OPS = new Set(["debugger.attach", "debugger.detach", "debugger.sendCommand", "tabs.get", "tabs.update", "tabs.remove", "bridge.release"]);

type Request = { id: string; line: string; key: string; wait: number; resolve: (v: any) => void; reject: (e: Error) => void };

export class Bridge {
  // A random prefix per relay: a late answer to a request of an earlier relay never matches a new request.
  private readonly prefix = randomBytes(4).toString("hex");
  private next = 1;
  private readonly pending = new Map<string, Request>();
  private readonly inFlight = new Map<string, number>();
  private readonly queued = new Map<string, Request[]>();
  private readonly write: (line: string) => void;
  private readonly maxRequest: number;

  constructor(write: (line: string) => void, opts: { maxRequest?: number } = {}) {
    this.write = write;
    this.maxRequest = opts.maxRequest ?? MAX_REQUEST;
  }

  /** Send one op. The relay always sends the op's default wait; the daemon always answers, so no timer runs here. */
  call<T = any>(op: string, args: unknown[] = []): Promise<T> {
    const wait = op === "debugger.sendCommand" ? WAIT_MAX_MS : WAIT_DEFAULT_MS;
    const id = `${this.prefix}-${this.next++}`;
    const line = JSON.stringify({ t: "req", id, op, args, wait });
    if (Buffer.byteLength(line) > this.maxRequest) return Promise.reject(new BridgeError(REQUEST_TOO_LARGE, wait));
    const tab = op === "debugger.sendCommand" ? (args[0] as { tabId?: number } | undefined)?.tabId : args[0];
    const key = TAB_OPS.has(op) ? `tab ${tab}` : "shared";
    return new Promise<T>((resolve, reject) => {
      const req = { id, line, key, wait, resolve, reject };
      // At most MAX_IN_FLIGHT_PER_TAB requests per key; the next ones wait here, in order, so a long wait on one tab never keeps another back.
      if ((this.inFlight.get(key) ?? 0) < MAX_IN_FLIGHT_PER_TAB) this.send(req);
      else {
        let q = this.queued.get(key);
        if (!q) this.queued.set(key, (q = []));
        q.push(req);
      }
    });
  }

  private send(req: Request): void {
    this.inFlight.set(req.key, (this.inFlight.get(req.key) ?? 0) + 1);
    this.pending.set(req.id, req);
    this.write(req.line);
  }

  private settle(req: Request): void {
    this.pending.delete(req.id);
    const q = this.queued.get(req.key);
    const nextReq = q?.shift();
    if (q && !q.length) this.queued.delete(req.key);
    if (nextReq) { this.inFlight.set(req.key, this.inFlight.get(req.key)! - 1); this.send(nextReq); return; }
    const n = this.inFlight.get(req.key)! - 1;
    if (n) this.inFlight.set(req.key, n); else this.inFlight.delete(req.key);
  }

  /** A res line. A res that no request waits for (a late answer, or one from before a link drop) is ignored. */
  answer(msg: { id?: unknown; ok?: unknown; data?: unknown; error?: unknown }): void {
    const req = typeof msg.id === "string" ? this.pending.get(msg.id) : undefined;
    if (!req) return;
    this.settle(req);
    if (msg.ok === true) req.resolve(msg.data ?? null);
    else req.reject(new BridgeError(String(msg.error), req.wait));
  }

  /** Fail every request that still waits (after a link drop, the daemon's `disconnected` answers come first; this ends the rest). */
  dropAll(text = "disconnected"): void {
    const all = [...this.pending.values(), ...[...this.queued.values()].flat()];
    this.pending.clear(); this.queued.clear(); this.inFlight.clear();
    for (const req of all) req.reject(new BridgeError(text, req.wait));
  }
}
