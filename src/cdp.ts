// Minimal Chrome DevTools Protocol client.
// One connection to the browser endpoint; per-tab traffic uses flattened sessions.
// Uses the `ws` package rather than Node's built-in WebSocket: the built-in one negotiates
// permessage-deflate and caps decompressed messages at 4 MB, which kills the connection on
// a retina screenshot or a media chunk. `ws` also connects over agent mode's Unix socket (ws+unix://).

import { connect } from "node:net";
import WebSocket from "ws";

/** A Unix socket that takes a connection is live (a relay or a door serves it), even when no other file says so. */
export function socketAlive(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(path);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
  });
}

export class CDPError extends Error {
  readonly method: string;
  readonly code?: number;
  constructor(method: string, message: string, code?: number) {
    super(`${method}: ${message}`);
    this.method = method;
    this.code = code;
  }
}

type Pending = { method: string; sessionId?: string; resolve: (v: any) => void; reject: (e: Error) => void };
type Handler = (params: any, sessionId?: string) => void;

export class CDPConnection {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private handlers = new Map<string, Set<Handler>>();
  /** The sessions whose calls stopSession ended: each later call of one fails at once with its error (unless `through`). */
  private stoppedSessions = new Map<string, () => Error>();
  private closed = false;
  readonly closedPromise: Promise<void>;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    this.closedPromise = new Promise((resolve) => {
      ws.on("close", () => {
        this.closed = true;
        for (const p of this.pending.values()) p.reject(new CDPError(p.method, "connection closed"));
        this.pending.clear();
        resolve();
      });
    });
    ws.on("message", (data) => this.onMessage(String(data)));
  }

  static connect(url: string, timeoutMs = 10_000): Promise<CDPConnection> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error(`timed out connecting to ${url}`));
      }, timeoutMs);
      ws.once("open", () => {
        clearTimeout(timer);
        resolve(new CDPConnection(ws));
      });
      ws.once("error", (err) => {
        clearTimeout(timer);
        reject(new Error(`could not connect to ${url}: ${err.message}`));
      });
      // An HTTP answer in place of the upgrade (agent mode's endpoint: 503 with C11's text): its body is the reason.
      ws.once("unexpected-response", (req, res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (d: string) => { if (body.length < 4096) body += d; });
        res.on("end", () => {
          clearTimeout(timer);
          req.destroy();
          reject(new Error(`could not connect to ${url}: HTTP ${res.statusCode}${body.trim() ? `: ${body.trim()}` : ""}`));
        });
      });
    });
  }

  /** `through`: the call goes also on a session that stopSession stopped (the answer to a JavaScript dialog). */
  send<T = any>(method: string, params: object = {}, sessionId?: string, timeoutMs = 60_000, opts: { through?: boolean } = {}): Promise<T> {
    if (this.closed) return Promise.reject(new CDPError(method, "connection closed"));
    const stopped = sessionId === undefined || opts.through ? undefined : this.stoppedSessions.get(sessionId);
    if (stopped) return Promise.reject(stopped());
    const id = this.nextId++;
    const msg: Record<string, unknown> = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CDPError(method, `no response after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        sessionId,
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify(msg));
    });
  }

  /**
   * End every call of the session that waits for its answer now, and fail each later one at once, with `error()`'s error
   * (a JavaScript dialog ended the command: Chrome answers no page call of the tab while the dialog is open). A call
   * with `through` still goes.
   */
  stopSession(sessionId: string, error: () => Error): void {
    this.stoppedSessions.set(sessionId, error);
    for (const [id, p] of [...this.pending]) if (p.sessionId === sessionId) { this.pending.delete(id); p.reject(error()); }
  }

  on(method: string, handler: Handler): () => void {
    let set = this.handlers.get(method);
    if (!set) this.handlers.set(method, (set = new Set()));
    set.add(handler);
    return () => set!.delete(handler);
  }

  /** Resolves with the first matching event; rejects on the timeout, or when `signal` aborts (then the timer and the handler are gone at once,
   *  so an abandoned wait cannot keep the process alive until its timeout). */
  waitForEvent<T = any>(
    method: string,
    opts: { sessionId?: string; predicate?: (p: T) => boolean; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    const { sessionId, predicate, timeoutMs = 30_000, signal } = opts;
    return new Promise<T>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); off(); signal?.removeEventListener("abort", onAbort); };
      const timer = setTimeout(() => {
        cleanup();
        reject(new CDPError(method, `event not seen within ${timeoutMs} ms`));
      }, timeoutMs);
      const onAbort = () => { cleanup(); reject(new CDPError(method, "wait cancelled")); };
      const off = this.on(method, (params, sid) => {
        if (sessionId && sid !== sessionId) return;
        if (predicate && !predicate(params)) return;
        cleanup();
        resolve(params);
      });
      if (signal?.aborted) onAbort(); else signal?.addEventListener("abort", onAbort);
    });
  }

  close(): Promise<void> {
    if (!this.closed) this.ws.close();
    return this.closedPromise;
  }

  private onMessage(raw: string) {
    const msg = JSON.parse(raw);
    if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new CDPError(p.method, msg.error.message, msg.error.code));
      else p.resolve(msg.result);
      return;
    }
    const set = this.handlers.get(msg.method);
    if (set) for (const h of [...set]) h(msg.params, msg.sessionId);
  }
}
