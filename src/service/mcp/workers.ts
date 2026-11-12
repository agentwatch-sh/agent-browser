// The service's side of the MCP workers (contract C11, "The MCP inside the service"; stage 1d of the self-contained agent
// browser, board ab-v16.94.5, part 2b): one worker thread for each scope with MCP sessions, with a heap limit
// (resourceLimits, first value 512 MiB). A worker that passes its limit, or that fails, ends with its MCP sessions: each
// request that waits for it gets an error answer, and its sessions are gone (their next request gets the 404 of an
// unknown MCP session, so the client starts a new session). The model, Chrome, the doors and the other scopes' workers go
// on: they are not in the worker's heap. The worker's standard output and error are read and dropped, so nothing of a
// page or a tool argument reaches the service's log.

import { Worker } from "node:worker_threads";
import type { AllowList } from "./allow-list.ts";
import type { Message } from "./session.ts";
import type { FromWorker, ToWorker } from "./worker.ts";

/** The heap limit of each scope's worker, in MiB (C11: first value 512). */
export const MCP_HEAP_MB = 512;
/** How long the service waits for a worker to make a server object (the package loads at a worker's first session). */
export const OPEN_WAIT_MS = 30_000;

export type WorkerEnd = "memory" | "error";

export type ScopeWorkerOptions = {
  list: AllowList;
  /** The scope's folder, `<state>/mcp/<scope>/`. */
  folder: string;
  /** A one-time ticket's URL for the scope's CDP path, or null. */
  ticketUrl: () => string | null;
  /** The worker ended by itself (its heap limit, or a failure): the transport drops its sessions. */
  ended: (why: WorkerEnd) => void;
  log: (line: string) => void;
  /** Tests only: the heap limit (MiB), the worker's file and the open's wait. */
  heapMb?: number;
  entry?: URL;
  openWaitMs?: number;
};

type Wait = { resolve: (m: Message | null) => void };

export class ScopeWorker {
  readonly scope: string;
  readonly worker: Worker;
  private readonly o: ScopeWorkerOptions;
  private readonly waits = new Map<string, Wait>();
  private readonly opens = new Map<string, (error: string | null) => void>();
  private heapWaits: ((h: { used: number; total: number; limit: number } | null) => void)[] = [];
  private gone = false;
  private stopping = false;

  constructor(scope: string, o: ScopeWorkerOptions) {
    this.scope = scope; this.o = o;
    this.worker = new Worker(o.entry ?? new URL("./worker.ts", import.meta.url), {
      workerData: { list: o.list, folder: o.folder },
      resourceLimits: { maxOldGenerationSizeMb: o.heapMb ?? MCP_HEAP_MB },
      // An environment of its own: no DEBUG, NODE_OPTIONS or PLAYWRIGHT_* variable of the service's reaches Playwright,
      // and no Node flag of the service's command line (an inspector flag, a test flag).
      env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
      execArgv: [],
      stdout: true, stderr: true,
    });
    // Nothing of the worker's output reaches the service's log (C11's log rule): it is read and dropped.
    this.worker.stdout.resume();
    this.worker.stderr.resume();
    this.worker.on("message", (m: FromWorker) => this.take(m));
    this.worker.on("error", (e: NodeJS.ErrnoException) => this.end(e?.code === "ERR_WORKER_OUT_OF_MEMORY" ? "memory" : "error"));
    this.worker.on("exit", () => this.end("error"));
  }

  /** The worker has ended (its limit, a failure, or terminate). */
  get ended(): boolean { return this.gone; }

  private take(m: FromWorker): void {
    switch (m.t) {
      case "opened": { const r = this.opens.get(m.sid); this.opens.delete(m.sid); r?.(m.error ?? null); return; }
      case "answer": {
        const key = `${m.sid} ${JSON.stringify(m.msg.id ?? null)}`;
        const w = this.waits.get(key);
        if (w) { this.waits.delete(key); w.resolve(m.msg); }
        return;
      }
      case "ticket": this.post({ t: "ticket", n: m.n, url: this.gone || this.stopping ? null : this.o.ticketUrl() }); return;
      case "heap": { const ws = this.heapWaits; this.heapWaits = []; for (const w of ws) w(m); return; }
      case "closed": return;
    }
  }

  private post(m: ToWorker): void { if (!this.gone) this.worker.postMessage(m); }

  /** A new MCP session's server object: null when it is made, else why not. */
  open(sid: string): Promise<string | null> {
    if (this.gone) return Promise.resolve("the scope's MCP worker has ended");
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.opens.delete(sid); resolve("the scope's MCP worker did not answer in time"); }, this.o.openWaitMs ?? OPEN_WAIT_MS);
      t.unref();
      this.opens.set(sid, (e) => { clearTimeout(t); resolve(e); });
      this.post({ t: "open", sid });
    });
  }

  /** A client request of a session: the server's answer, or null when the worker ended before it answered. */
  request(sid: string, msg: Message): Promise<Message | null> {
    if (this.gone) return Promise.resolve(null);
    const key = `${sid} ${JSON.stringify(msg.id ?? null)}`;
    return new Promise((resolve) => {
      this.waits.get(key)?.resolve(null);
      this.waits.set(key, { resolve });
      this.post({ t: "msg", sid, msg });
    });
  }

  /** A client notification of a session (no answer). */
  notify(sid: string, msg: Message): void { this.post({ t: "msg", sid, msg }); }

  /**
   * Drop the wait of a request that was cancelled (review-115b P2): the MCP never answers a cancelled request, so its
   * promise gets null now, and an answer that still came would find no wait.
   */
  drop(sid: string, id: unknown): void {
    const key = `${sid} ${JSON.stringify(id ?? null)}`;
    const w = this.waits.get(key);
    if (w) { this.waits.delete(key); w.resolve(null); }
  }

  /** End one session's server object; the requests that wait for it get null. */
  close(sid: string): void {
    for (const [key, w] of [...this.waits]) if (key.startsWith(`${sid} `)) { this.waits.delete(key); w.resolve(null); }
    this.post({ t: "close", sid });
  }

  /** The worker's heap now (the memory measures), or null when it has ended. */
  heap(): Promise<{ used: number; total: number; limit: number } | null> {
    if (this.gone) return Promise.resolve(null);
    return new Promise((resolve) => { this.heapWaits.push(resolve); this.post({ t: "heap" }); });
  }

  private end(why: WorkerEnd): void {
    if (this.gone) return;
    this.gone = true;
    for (const w of this.waits.values()) w.resolve(null);
    this.waits.clear();
    for (const r of this.opens.values()) r("the scope's MCP worker has ended");
    this.opens.clear();
    for (const w of this.heapWaits) w(null);
    this.heapWaits = [];
    if (!this.stopping) {
      this.o.log(`mcp: the MCP worker of scope ${this.scope} ended (${why === "memory" ? "it passed its heap limit" : "it failed"}); its MCP sessions end`);
      this.o.ended(why);
    }
  }

  /** Stop the worker (its last session ended, or the service stops); each call gets the same stop. */
  private stopped: Promise<void> | undefined;
  stop(): Promise<void> {
    return this.stopped ??= (async () => {
      this.stopping = true;
      if (!this.gone) await this.worker.terminate();
      this.end("error");
    })();
  }
}
