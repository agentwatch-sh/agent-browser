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
import { lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { checkCall, filterTools, realFolder, type AllowList } from "./allow-list.ts";
import { SCOPE } from "../../relay/scopes.ts";
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
  cancelled: { status: 200, code: -32800, text: "Request cancelled: the client sent notifications/cancelled for this request." },
  ended: { status: 200, code: -32603, text: "This MCP session has ended: its agentwatch session ended or changed. Initialize a new MCP session." },
  memory: { status: 200, code: -32603, text: "This MCP session has ended: the MCP of its agentwatch session passed its memory limit. Initialize a new MCP session." },
  failed: { status: 200, code: -32603, text: "This MCP session has ended: the MCP of its agentwatch session failed. Initialize a new MCP session." },
} as const satisfies Record<string, McpAnswer>;
/** The texts of the answers, by name. */
export const MCP_ANSWER = Object.fromEntries(Object.entries(MCP_ANSWERS).map(([k, v]) => [k, v.text])) as { readonly [K in keyof typeof MCP_ANSWERS]: string };

/** The JSON-RPC methods of a client that reach the MCP (each other request gets "Method not found"). */
export const MCP_REQUESTS: readonly string[] = Object.freeze(["initialize", "ping", "tools/list", "tools/call"]);
export const MCP_NOTIFICATIONS: readonly string[] = Object.freeze(["notifications/initialized", "notifications/cancelled"]);

/** Why a waiting request ends with no answer of the MCP: its client cancelled it, or its client closed its connection. */
type Cancel = "client" | "closed";
/** An MCP session; `waiting` maps the id (JSON) of each request that waits to the cancel of that request. */
type Session = { readonly id: string; readonly n: number; readonly scope: string; readonly worker: ScopeWorker; open: boolean; readonly waiting: Map<string, (why: Cancel) => void> };

/** A JSON-RPC id that the transport takes: a string or a safe integer (C11). */
const isId = (x: unknown): x is string | number => typeof x === "string" || Number.isSafeInteger(x);

/**
 * A cancel's params that the pinned SDK acts on (review-121 note 2): params of its schema (a `requestId` that is an id,
 * a `reason` that is a string when there is one) with a `requestId` that is not falsy. It ignores any other cancel and
 * answers the call, so the transport then frees nothing: the id stays busy and the call a use until the MCP's answer.
 */
export const mcpTakesCancel = (p: unknown): boolean =>
  isObj(p) && isId(p.requestId) && p.requestId !== 0 && p.requestId !== "" && (!Object.hasOwn(p, "reason") || typeof p.reason === "string");

/** The MCP's key of a related task in `_meta` (the SDK's schema of a request's `_meta`). */
const RELATED_TASK = "io.modelcontextprotocol/related-task";
/** A `params`: none, or a JSON object whose `_meta`, when it has one, is the SDK's shape of a request's `_meta`. */
function paramsOk(o: Record<string, unknown>): boolean {
  if (!Object.hasOwn(o, "params")) return true;
  const p = o.params;
  if (!isObj(p)) return false;
  if (!Object.hasOwn(p, "_meta")) return true;
  const m = p._meta;
  if (!isObj(m)) return false;
  if (Object.hasOwn(m, "progressToken") && !isId(m.progressToken)) return false;
  return !Object.hasOwn(m, RELATED_TASK) || (isObj(m[RELATED_TASK]) && typeof (m[RELATED_TASK] as Record<string, unknown>).taskId === "string");
}
/** The members of each shape (the SDK's schemas are strict: a message with another member gets no answer). */
const MEMBERS = {
  request: new Set(["jsonrpc", "id", "method", "params"]),
  notification: new Set(["jsonrpc", "method", "params"]),
  answer: new Set(["jsonrpc", "id", "result", "error"]),
} as const;

/**
 * The shape of a JSON-RPC 2.0 message (C11, the transport; review-115b P4), as the MCP's own SDK takes it: a request
 * (`jsonrpc`, an `id`, a `method` that is a string, a `params` or none), a notification (`jsonrpc`, a `method` that is a
 * string, a `params` or none), or a client's answer (`jsonrpc`, an `id`, and exactly one of `result` and `error`), with
 * no other member. A `params` is a JSON object, and its `_meta` the SDK's shape; an `id` is a string or a safe integer.
 * Null for any other body: the 400 `Invalid Request` (the MCP gives no answer to such a message, so it would wait).
 */
export function messageShape(m: unknown): "request" | "notification" | "answer" | null {
  if (!isObj(m) || m.jsonrpc !== "2.0") return null;
  const shape = Object.hasOwn(m, "method")
    ? (typeof m.method !== "string" ? null : !Object.hasOwn(m, "id") ? "notification" : isId(m.id) ? "request" : null)
    : (isId(m.id) && Object.hasOwn(m, "result") !== Object.hasOwn(m, "error") ? "answer" : null);
  if (shape === null || !Object.keys(m).every((k) => MEMBERS[shape].has(k))) return null;
  return shape === "answer" || paramsOk(m) ? shape : null;
}

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

/** Why no scope's folder can go: `<state>/mcp` is a link or no folder of the service's user (a log text, with no path). */
export const MCP_FOLDER_NOT_OURS = "<state>/mcp is a link or no folder of the service's user";
/** The code of an error, for a log line: never its message, which holds the path (review-121 B2). */
const codeOf = (e: unknown) => String((e as NodeJS.ErrnoException)?.code ?? "an error with no code");

/**
 * Remove a scope's folder with its files (C11; review-115 note 3): only when `<state>/mcp` is a real folder of the
 * service's user, never through a link (a link in the scope's place, or in the folder, goes as a link: `rm` reads it
 * with lstat), and only a folder or a link: another entry of the scope's name stays (review-121 note 6). `removed`, or
 * why not: null when there is nothing to remove, else a text for the log with no path (review-121 B2).
 */
export function removeScopeFolder(state: string, scope: string): { removed: true } | { removed: false; why: string | null } {
  if (!SCOPE.test(scope)) return { removed: false, why: null };
  const mcp = join(state, "mcp");
  try { lstatSync(mcp); } catch (e) { return { removed: false, why: (e as NodeJS.ErrnoException).code === "ENOENT" ? null : codeOf(e) }; }
  if (!realFolder(mcp)) return { removed: false, why: MCP_FOLDER_NOT_OURS };
  let st;
  try { st = lstatSync(join(mcp, scope)); } catch (e) { return { removed: false, why: (e as NodeJS.ErrnoException).code === "ENOENT" ? null : codeOf(e) }; }
  if (!st.isDirectory() && !st.isSymbolicLink()) return { removed: false, why: "it is no folder" };
  try { rmSync(join(mcp, scope), { recursive: true, force: true }); return { removed: true }; } catch (e) { return { removed: false, why: codeOf(e) }; }
}

export class McpTransport implements McpHandler {
  private readonly o: McpTransportOptions;
  private readonly sessions = new Map<string, Session>();
  private readonly workers = new Map<string, ScopeWorker>();
  /** The stops of each scope's workers that still stop (the folder goes only after all of them: note 3, review-121 note 4). */
  private readonly halts = new Map<string, Set<Promise<void>>>();
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
    // The message's shape (C11; review-115b P4): a request, a notification or a client's answer, each id a string or a
    // safe integer (review-115 note 7); another body never reaches the MCP.
    const shape = messageShape(msg);
    if (shape === null || !isObj(msg)) { send(res, "invalid", null); return; }
    if (shape === "request" && msg.method === "initialize") return this.initialize(req, res, scope, msg);
    const s = this.sessionOf(req, res, scope, shape === "request" ? msg.id : null);
    if (s === null) return;
    if (shape !== "request") {
      // A notification, or a client's answer: the service has no request of its own to the client.
      if (shape === "notification" && MCP_NOTIFICATIONS.includes(msg.method as string)) {
        s.worker.notify(s.id, msg);
        // A client's own cancel of a request that still waits frees its id at once, and its open POST gets the cancelled
        // answer (the MCP never answers a cancelled request; review-115b's note).
        // A cancel that the MCP ignores frees nothing once the MCP has the request (review-121 note 2).
        const rid = msg.method === "notifications/cancelled" && isObj(msg.params) ? msg.params.requestId : undefined;
        if (isId(rid)) s.waiting.get(JSON.stringify(rid))?.("client", mcpTakesCancel(msg.params));
      }
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
    const forward = msg;
    // An id of a request of this MCP session that still waits (also a tool call that waits for the browser): refused,
    // and the waiting request keeps its own answer.
    const key = JSON.stringify(forward.id);
    if (s.waiting.has(key)) { send(res, "duplicateId", forward.id); return; }
    // A cancel frees the id at once (review-115b P2): the MCP never answers a cancelled request, so a later request
    // with this id goes on; the request's own wait ends too (no answer of the MCP comes for it).
    const at: { cancelled: Cancel | null; sent: boolean } = { cancelled: null, sent: false };
    let stopWait!: () => void;
    const stopped = new Promise<null>((r) => { stopWait = () => r(null); });
    const cancel = (why: Cancel, mcpTakes = true) => {
      if (at.cancelled !== null || (at.sent && !mcpTakes)) return;
      at.cancelled = why;
      if (s.waiting.get(key) === cancel) s.waiting.delete(key);
      if (at.sent) s.worker.drop(s.id, forward.id);
      stopWait();
    };
    s.waiting.set(key, cancel);
    // A client that goes away before the answer cancels its call: the MCP's own notifications/cancelled, once the MCP
    // has the request. For an id that the MCP would not cancel (0 or ""), the call runs to the MCP's answer: its id stays
    // busy and the call a use until then (review-121 note 2).
    const gone = () => {
      if (res.writableEnded || at.cancelled !== null) return;
      const params = { requestId: forward.id, reason: "the client closed its connection" };
      if (at.sent && !mcpTakesCancel(params)) return;
      if (at.sent) s.worker.notify(s.id, { jsonrpc: "2.0", method: "notifications/cancelled", params });
      cancel("closed");
    };
    res.once("close", gone);
    try {
      // A tool call needs the browser (board ab-v16.94.11): while Chrome is down or its lists are not confirmed, it
      // starts Chrome and waits (the port's gate, which answers a refusal itself); a request whose client left meanwhile
      // gets false from the gate and never reaches the MCP.
      if (forward.method === "tools/call" && browser && !(await browser())) return;
      if (at.cancelled === "client") { send(res, "cancelled", forward.id); return; }
      if (at.cancelled !== null) return;
      // The MCP session ended while the call waited for the browser (a DELETE, session_ended, the close at a change,
      // the worker's end): the answer of its end, and the call never reaches the MCP (review-121 B1).
      if (!s.open) { send(res, this.endOf(s), forward.id); return; }
      let got: Message | null;
      const call = forward.method === "tools/call";
      if (call) { this.calls++; this.lastCall = performance.now(); }
      at.sent = true;
      try { got = await Promise.race([s.worker.request(s.id, forward), stopped]); }
      finally { if (call) { this.calls--; this.lastCall = performance.now(); } }
      if (at.cancelled === "client") { send(res, "cancelled", forward.id); return; }
      if (at.cancelled !== null) return;
      if (got === null) { send(res, this.endOf(s), forward.id); return; }
      answer(res, 200, forward.method === "tools/list" ? this.filtered(got) : got);
    } finally {
      if (s.waiting.get(key) === cancel) s.waiting.delete(key);
      res.off("close", gone);
    }
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
    const s: Session = { id: randomBytes(16).toString("hex"), n: ++this.count, scope, worker, open: true, waiting: new Map() };
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
      const halt = s.worker.stop().catch(() => {});
      let set = this.halts.get(s.scope);
      if (!set) this.halts.set(s.scope, (set = new Set()));
      const halts = set;
      halts.add(halt);
      void halt.then(() => { halts.delete(halt); if (halts.size === 0 && this.halts.get(s.scope) === halts) this.halts.delete(s.scope); });
    }
  }

  /** C11's close at a change and C12's session_ended (the lead's OP4): every MCP session of `scope` ends. */
  endSessions(scope: string): void {
    for (const s of [...this.sessions.values()]) if (s.scope === scope) this.end(s, "its agentwatch session ended or changed");
  }

  /**
   * The scope's agentwatch session ended (C12's session_ended), or the last set_sessions no longer names the scope
   * (review-115 note 3): its MCP sessions end, and once its worker has stopped, its folder goes with its files, so a
   * later session of the same launch name never reads them. A new MCP session of the scope in the meantime keeps it.
   */
  async dropScope(scope: string, why: string): Promise<void> {
    this.endSessions(scope);
    // Every worker of the scope that still stops, also one that stops meanwhile (review-121 note 4). The first await
    // also puts the removal after the control door's answer (C12).
    do { await Promise.all([...(this.halts.get(scope) ?? [])]); } while (this.halts.get(scope)?.size);
    if (this.stopped || this.workers.has(scope) || this.size(scope) > 0) return;
    const r = removeScopeFolder(this.o.stateFolder, scope);
    // A failed removal gets its line too, with the scope and the error's code only (review-121 B2).
    if (r.removed) this.o.log(`mcp: the folder of scope ${scope} is emptied (${why})`);
    else if (r.why !== null) this.o.log(`mcp: the folder of scope ${scope} is not emptied (${r.why})`);
  }

  /**
   * C12's set_sessions (review-115 note 3): the folder of each scope that the snapshot does not name goes (also of a
   * session that ended while the service was down, which got no session_ended). Only a folder whose name is a scope
   * (removeScopeFolder).
   */
  async keepScopes(named: ReadonlySet<string>): Promise<void> {
    const mcp = join(this.o.stateFolder, "mcp");
    try { lstatSync(mcp); } catch { return; } // no MCP session made it yet
    if (!realFolder(mcp)) { this.o.log(`mcp: no scope's folder is emptied (${MCP_FOLDER_NOT_OURS})`); return; }
    let names: string[];
    try { names = readdirSync(mcp); } catch (e) { this.o.log(`mcp: no scope's folder is emptied (${codeOf(e)})`); return; }
    await Promise.all(names.filter((n) => !named.has(n)).map((n) => this.dropScope(n, "the sessions name it no more")));
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
