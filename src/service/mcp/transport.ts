// The service's own small Streamable HTTP transport of the MCP path (contract C11, "The MCP path" and "The MCP inside
// the service"; the self-contained design, section 8.2; stage 1d of the self-contained agent browser, board
// ab-v16.94.5, part 2b). It is the handler behind the MCP port's admission (port.ts, McpHandler): a request reaches it
// only after steps 1 to 8, with the scope of the connection's walk. No MCP SDK package: the MCP server object needs only
// start, send and close from a transport (session.ts), and this file speaks HTTP to the client.
//
// - POST `/mcp` or `/mcp/<scope>` carries one JSON-RPC message, and a request gets one JSON answer
//   (`Content-Type: application/json`); a notification or a client's answer gets 202 with no body. The service sends no
//   stream: a GET gets 405.
// - `initialize` makes a new MCP session: its id goes out in the `Mcp-Session-Id` header. Every other message carries
//   it; with no id a request gets 400, and an id that the service does not know, or an id of another scope, gets the
//   404 of an unknown MCP session (C11), so the client starts a new session.
// - DELETE with the session's id ends that MCP session (200).
// - At most 4 MCP sessions for each scope and 32 for each service (first values); one more `initialize` gets 503 with
//   the JSON-RPC error of C11.
// - The allow list (allow-list.ts) acts here, before a message reaches the MCP's code: `tools/list` loses each other
//   tool, and a `tools/call` of another tool, with another key or with a path outside the scope's folder gets the
//   format's JSON-RPC error; only `initialize`, `ping`, `tools/list` and `tools/call` reach the MCP, and of the
//   notifications only `notifications/initialized` and `notifications/cancelled`.
// - endSessions (C11's close at a change, C12's session_ended, the lead's OP4) ends the scope's MCP sessions.
// - The use of the browser (board ab-v16.94.11): an MCP session counts by its tool calls only, never by being open:
//   `activity()` gives the tool calls that run and the time since the last one came or ended. A request that needs no
//   browser (initialize, ping, tools/list, a notification, GET, DELETE) passes the port's step 8 while Chrome is down, and
//   only a tool call goes through the port's `browser` gate, which starts Chrome (the start at a use).
//
// The log rule (C11, C12): a line names a session's number, a scope, a method and a result; never an argument, a
// payload, a page's content, a session id, a header, a token or a fingerprint.

import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { checkCall, filterTools, type AllowList } from "./allow-list.ts";
import { rawValues } from "./admission.ts";
import type { McpHandler } from "./port.ts";
import type { Message } from "./session.ts";
import { ScopeWorker, type ScopeWorkerOptions, type WorkerEnd } from "./workers.ts";

/** The limits of the MCP sessions (C11: first values). */
export const MCP_SESSIONS_PER_SCOPE = 4;
export const MCP_SESSIONS_PER_SERVICE = 32;
/** The largest body of one POST (first value); a larger one gets 413 and the connection closes. */
export const MCP_MAX_BODY = 1024 * 1024;

/** An answer of the transport: its HTTP status, its JSON-RPC code and its text (C11, the transport's table). */
export type McpAnswer = { readonly status: number; readonly code: number; readonly text: string };
/** The transport's answers (C11's table, row for row). No text names a stop or a start of the agent browser (I2). */
export const MCP_ANSWERS = {
  batch: { status: 400, code: -32600, text: "Invalid Request: the agent browser takes one JSON-RPC message in each POST." },
  parse: { status: 400, code: -32700, text: "Parse error" },
  invalid: { status: 400, code: -32600, text: "Invalid Request" },
  duplicateId: { status: 400, code: -32600, text: "Invalid Request: a request with this id still waits in this MCP session." },
  tooLarge: { status: 413, code: -32600, text: `Request too large: the agent browser takes at most ${MCP_MAX_BODY} bytes in one POST.` },
  initializeWithId: { status: 400, code: -32600, text: "Bad Request: initialize makes a new MCP session, so it carries no Mcp-Session-Id." },
  noSessionId: { status: 400, code: -32000, text: "Bad Request: this request needs the Mcp-Session-Id of its MCP session; initialize first." },
  unknownSession: { status: 404, code: -32001, text: "Session not found" },
  noStream: { status: 405, code: -32000, text: "Method not allowed: the agent browser's MCP sends no stream; POST each message, and DELETE ends the MCP session." },
  perScope: { status: 503, code: -32000, text: `The agent browser serves at most ${MCP_SESSIONS_PER_SCOPE} MCP sessions for each agentwatch session. End one of this session's MCP sessions (DELETE), then initialize again.` },
  perService: { status: 503, code: -32000, text: `The agent browser serves at most ${MCP_SESSIONS_PER_SERVICE} MCP sessions, and each is in use. Initialize again later.` },
  notOpened: { status: 503, code: -32000, text: "The agent browser could not make an MCP session now. Initialize again." },
  methodNotFound: { status: 200, code: -32601, text: "Method not found" },
  ended: { status: 200, code: -32603, text: "This MCP session has ended: its agentwatch session ended or changed. Initialize a new MCP session." },
  memory: { status: 200, code: -32603, text: "This MCP session has ended: the MCP of its agentwatch session passed its memory limit. Initialize a new MCP session." },
  failed: { status: 200, code: -32603, text: "This MCP session has ended: the MCP of its agentwatch session failed. Initialize a new MCP session." },
} as const satisfies Record<string, McpAnswer>;
/** The texts of the answers, by name. */
export const MCP_ANSWER = Object.fromEntries(Object.entries(MCP_ANSWERS).map(([k, v]) => [k, v.text])) as { readonly [K in keyof typeof MCP_ANSWERS]: string };

/** The JSON-RPC methods of a client that reach the MCP (each other request gets "Method not found"). */
export const MCP_REQUESTS: readonly string[] = Object.freeze(["initialize", "ping", "tools/list", "tools/call"]);
export const MCP_NOTIFICATIONS: readonly string[] = Object.freeze(["notifications/initialized", "notifications/cancelled"]);

type Session = { readonly id: string; readonly n: number; readonly scope: string; readonly worker: ScopeWorker; open: boolean; readonly waiting: Set<string> };

export type McpTransportOptions = {
  list: AllowList;
  /** The state folder: each scope's folder is `<state>/mcp/<scope>/` (C11). */
  stateFolder: string;
  /** A one-time ticket's URL for `scope`'s CDP path, or null. */
  ticketUrl: (scope: string) => string | null;
  log: (line: string) => void;
  /** Tests only: the workers' heap limit, file and open's wait, and other limits. */
  worker?: Pick<ScopeWorkerOptions, "heapMb" | "entry" | "openWaitMs">;
  perScope?: number;
  perService?: number;
};

const rpcError = (id: unknown, code: number, message: string): Message => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

function answer(res: ServerResponse, status: number, body: Message | null, headers: Record<string, string> = {}): void {
  if (res.headersSent || res.destroyed) return;
  const text = body === null ? "" : JSON.stringify(body);
  res.writeHead(status, { ...(body === null ? {} : { "Content-Type": "application/json" }), "Content-Length": Buffer.byteLength(text), ...headers }).end(text);
}

const isObj = (x: unknown): x is Message => x !== null && typeof x === "object" && !Array.isArray(x);

/** One answer of C11's table, with the request's id (or null). */
function send(res: ServerResponse, name: keyof typeof MCP_ANSWERS, id: unknown, headers: Record<string, string> = {}): void {
  const a = MCP_ANSWERS[name];
  answer(res, a.status, rpcError(id, a.code, a.text), headers);
}

/** The folder of a scope, `<state>/mcp/<scope>/` (C11), with one trailing slash. */
export const scopeFolder = (state: string, scope: string) => `${join(state, "mcp", scope)}/`;

export class McpTransport implements McpHandler {
  private readonly o: McpTransportOptions;
  private readonly sessions = new Map<string, Session>();
  private readonly workers = new Map<string, ScopeWorker>();
  private count = 0;
  private stopped = false;
  /** The tool calls that run now, and the time (performance.now) of the last one's start or end (board ab-v16.94.11). */
  private calls = 0;
  private lastCall: number | null = null;

  constructor(o: McpTransportOptions) { this.o = o; }

  /** The MCP's use of the browser: the tool calls that run, and the ms since the last one came or ended (Infinity before one). */
  activity(): { calls: number; quietFor: number } {
    return { calls: this.calls, quietFor: this.lastCall === null ? Infinity : performance.now() - this.lastCall };
  }

  /** The MCP sessions (of `scope`, or of every scope). */
  size(scope?: string): number { return scope === undefined ? this.sessions.size : [...this.sessions.values()].filter((s) => s.scope === scope).length; }

  /** The worker of `scope` while it runs (the tests and the memory measures). */
  workerOf(scope: string): ScopeWorker | undefined { return this.workers.get(scope); }

  async request(req: IncomingMessage, res: ServerResponse, scope: string, browser?: () => Promise<boolean>): Promise<void> {
    if (req.method === "POST") return this.post(req, res, scope, browser);
    if (req.method === "DELETE") { req.resume(); return this.delete(req, res, scope); }
    req.resume();
    send(res, "noStream", null, { Allow: "POST, DELETE" });
  }

  /** The session of a request: its one Mcp-Session-Id of this scope; else the answer of no id or of an unknown one. */
  private sessionOf(req: IncomingMessage, res: ServerResponse, scope: string, id: unknown): Session | null {
    const ids = rawValues(req.rawHeaders, "mcp-session-id");
    if (ids.length === 0) { send(res, "noSessionId", id); return null; }
    const s = ids.length === 1 ? this.sessions.get(ids[0]) : undefined;
    if (s === undefined || s.scope !== scope) { send(res, "unknownSession", id); return null; }
    return s;
  }

  private delete(req: IncomingMessage, res: ServerResponse, scope: string): void {
    const s = this.sessionOf(req, res, scope, null);
    if (s === null) return;
    this.end(s, "its client ended it");
    answer(res, 200, null);
  }

  private readBody(req: IncomingMessage): Promise<Buffer | null> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let size = 0, done = false;
      req.on("data", (d: Buffer) => {
        if (done) return;
        size += d.length;
        if (size > MCP_MAX_BODY) { done = true; resolve(null); return; }
        chunks.push(d);
      });
      req.on("end", () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
      req.on("error", () => { if (!done) { done = true; resolve(Buffer.alloc(0)); } });
    });
  }

  private async post(req: IncomingMessage, res: ServerResponse, scope: string, browser?: () => Promise<boolean>): Promise<void> {
    const body = await this.readBody(req);
    if (body === null) { send(res, "tooLarge", null, { Connection: "close" }); return; }
    let msg: unknown;
    try { msg = JSON.parse(body.toString("utf8")); } catch { send(res, "parse", null); return; }
    if (Array.isArray(msg)) { send(res, "batch", null); return; }
    if (!isObj(msg) || msg.jsonrpc !== "2.0") { send(res, "invalid", null); return; }
    const isRequest = typeof msg.method === "string" && Object.hasOwn(msg, "id");
    // A request's id is a string or an integer (MCP); another id never reaches the MCP (review-115 note 7).
    if (isRequest && typeof msg.id !== "string" && !Number.isSafeInteger(msg.id)) { send(res, "invalid", null); return; }
    if (isRequest && msg.method === "initialize") return this.initialize(req, res, scope, msg);
    const s = this.sessionOf(req, res, scope, isRequest ? msg.id : null);
    if (s === null) return;
    if (!isRequest) {
      // A notification, or a client's answer: the service has no request of its own to the client.
      if (typeof msg.method === "string" && MCP_NOTIFICATIONS.includes(msg.method)) s.worker.notify(s.id, msg);
      answer(res, 202, null);
      return;
    }
    if (!MCP_REQUESTS.includes(msg.method as string)) { send(res, "methodNotFound", msg.id); return; }
    if (msg.method === "tools/call") {
      const params = isObj(msg.params) ? msg.params : {};
      const refused = checkCall(this.o.list, params, scopeFolder(this.o.stateFolder, scope), undefined, [join(this.o.stateFolder, "mcp"), scopeFolder(this.o.stateFolder, scope)]);
      if (refused !== null) {
        answer(res, 200, rpcError(msg.id, refused.code, refused.message));
        this.o.log(`mcp: MCP session ${s.n} (scope ${scope}): a tools/call refused (${refused.code})`);
        return;
      }
    }
    // A tool call needs the browser (board ab-v16.94.11): while Chrome is down or its lists are not confirmed, it starts
    // Chrome and waits (the port's gate, which answers a refusal itself); a request whose client left meanwhile gets
    // false from the gate and never reaches the MCP.
    if (msg.method === "tools/call" && browser && !(await browser())) return;
    const forward = msg;
    // An id of a request of this MCP session that still waits: refused, and the waiting request keeps its own answer.
    const key = JSON.stringify(forward.id);
    if (s.waiting.has(key)) { send(res, "duplicateId", forward.id); return; }
    s.waiting.add(key);
    // A client that goes away before the answer cancels its call (the MCP's own notifications/cancelled).
    const gone = () => { if (!res.writableEnded) s.worker.notify(s.id, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: forward.id, reason: "the client closed its connection" } }); };
    res.once("close", gone);
    let got: Message | null;
    const call = forward.method === "tools/call";
    if (call) { this.calls++; this.lastCall = performance.now(); }
    try { got = await s.worker.request(s.id, forward); }
    finally {
      s.waiting.delete(key); res.off("close", gone);
      if (call) { this.calls--; this.lastCall = performance.now(); }
    }
    if (got === null) { send(res, this.endOf(s), forward.id); return; }
    answer(res, 200, forward.method === "tools/list" ? this.filtered(got) : got);
  }

  /** `tools/list`'s answer without each tool that the allow list does not name. */
  private filtered(m: Message): Message {
    const r = m.result;
    if (!isObj(r) || !Array.isArray(r.tools)) return m;
    return { ...m, result: { ...r, tools: filterTools(this.o.list, r.tools as { name?: unknown }[]) } };
  }

  /** The answer of a request whose MCP session ended while it waited: its worker's memory end, its failure, or another end. */
  private endOf(s: Session): "ended" | "memory" | "failed" {
    const w = s.worker;
    return !w.ended ? "ended" : this.endings.get(w) === "memory" ? "memory" : this.endings.get(w) === "error" ? "failed" : "ended";
  }
  private readonly endings = new WeakMap<ScopeWorker, WorkerEnd>();

  private async initialize(req: IncomingMessage, res: ServerResponse, scope: string, msg: Message): Promise<void> {
    if (rawValues(req.rawHeaders, "mcp-session-id").length) { send(res, "initializeWithId", msg.id); return; }
    if (this.stopped) { send(res, "notOpened", msg.id); return; }
    if (this.size(scope) >= (this.o.perScope ?? MCP_SESSIONS_PER_SCOPE)) { send(res, "perScope", msg.id); this.o.log(`mcp: scope ${scope}: an initialize refused (its MCP sessions are at their limit)`); return; }
    if (this.size() >= (this.o.perService ?? MCP_SESSIONS_PER_SERVICE)) { send(res, "perService", msg.id); this.o.log(`mcp: scope ${scope}: an initialize refused (the service's MCP sessions are at their limit)`); return; }
    const worker = this.workerFor(scope);
    const s: Session = { id: randomBytes(16).toString("hex"), n: ++this.count, scope, worker, open: true, waiting: new Set() };
    this.sessions.set(s.id, s);
    const why = await worker.open(s.id);
    if (why !== null || !s.open) {
      this.end(s, "it could not be made");
      send(res, "notOpened", msg.id);
      return;
    }
    const got = await worker.request(s.id, msg);
    if (got === null || !s.open) { send(res, this.endOf(s), msg.id); this.end(s, "its worker ended"); return; }
    if (isObj(got.error)) { answer(res, 200, got); this.end(s, "its initialize failed"); return; }
    this.o.log(`mcp: MCP session ${s.n} of scope ${scope} begins`);
    answer(res, 200, got, { "Mcp-Session-Id": s.id });
  }

  /** The scope's worker, made at its first session (its folder too, mode 0700). */
  private workerFor(scope: string): ScopeWorker {
    const old = this.workers.get(scope);
    if (old && !old.ended) return old;
    const folder = scopeFolder(this.o.stateFolder, scope);
    // `<state>/mcp` and the scope's folder, each with mode 0700 (the path rule refuses each path argument when one is a link).
    mkdirSync(this.o.stateFolder, { recursive: true, mode: 0o700 });
    for (const f of [join(this.o.stateFolder, "mcp"), folder]) { try { mkdirSync(f, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; } }
    const w: ScopeWorker = new ScopeWorker(scope, {
      list: this.o.list, folder, ticketUrl: () => this.o.ticketUrl(scope), log: this.o.log, ...this.o.worker,
      ended: (why) => {
        this.endings.set(w, why);
        if (this.workers.get(scope) === w) this.workers.delete(scope);
        for (const s of [...this.sessions.values()]) if (s.worker === w) this.forget(s);
      },
    });
    this.workers.set(scope, w);
    return w;
  }

  private forget(s: Session): void {
    s.open = false;
    this.sessions.delete(s.id);
  }

  /** End one MCP session; the worker of its scope stops with its last session. */
  private end(s: Session, why: string): void {
    if (!this.sessions.has(s.id)) return;
    this.forget(s);
    s.worker.close(s.id);
    this.o.log(`mcp: MCP session ${s.n} of scope ${s.scope} ended: ${why}`);
    if (![...this.sessions.values()].some((x) => x.worker === s.worker) && this.workers.get(s.scope) === s.worker) {
      this.workers.delete(s.scope);
      void s.worker.stop();
    }
  }

  /** C11's close at a change and C12's session_ended (the lead's OP4): every MCP session of `scope` ends. */
  endSessions(scope: string): void {
    for (const s of [...this.sessions.values()]) if (s.scope === scope) this.end(s, "its agentwatch session ended or changed");
  }

  /** The service stops: every session and every worker. */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const s of [...this.sessions.values()]) this.forget(s);
    const ws = [...this.workers.values()];
    this.workers.clear();
    await Promise.all(ws.map((w) => w.stop()));
  }
}
