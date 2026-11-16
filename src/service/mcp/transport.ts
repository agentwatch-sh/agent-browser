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
//   the JSON-RPC error of C11. At the scope's limit (board ab-v16.94.16, F4), an `initialize` first ends the scope's MCP
//   session whose client sent its last message, or got its last answer, first, of those with no request that waits: the
//   MCP SDK's client sends no DELETE at its close(), so a client that reconnects leaves its old MCP session open. Only
//   when each MCP session of the scope has a request that waits (or its initialize runs) does it get the 503.
// - The allow list (allow-list.ts) acts here, before a message reaches the MCP's code: `tools/list` loses each other
//   tool, and a `tools/call` of another tool, with another key or with a path outside the scope's folder gets the
//   format's JSON-RPC error; only `initialize`, `ping`, `tools/list` and `tools/call` reach the MCP, and of the
//   notifications only `notifications/initialized` and `notifications/cancelled`.
// - endSessions (C11's close at a change, C12's session_ended, the lead's OP4) ends the scope's MCP sessions.
// - The service's own tools (the allow list's `service_tools`: browser_sign_in and browser_sign_ins; C11, the sign-in act;
//   board ab-v16.97.5): the transport answers them itself, and a call never reaches the MCP's code. The port gives each
//   request the admission of its connection (`local`: steps 1 and 2, the uid check and the walk); a request with no word
//   is remote. Only a local request, while the service has the act, gets them in `tools/list` and runs the act's method
//   for the MCP session's scope. A remote request's call goes at once to the act's method with the admission remote, and
//   the act's own check 1 refuses it, whatever its arguments (browser_sign_in: its one refusal end, result remote); it
//   passes no browser gate and is no use. A local call is a tool call: it passes the browser gate, it counts as a use
//   until the act ends (also after its client left), and no cancel stops a running act (a cancel at the gate ends it).
//   PageFetch (C11, PageFetch; board ab-v16.102) is one more own tool, served while the service has PageFetch: the same
//   local rule, the same gate and use; a remote request's call gets PageFetch's own refusal (`unavailable`).
// - The use of the browser (board ab-v16.94.11): an MCP session counts by its tool calls only, never by being open:
//   `activity()` gives the tool calls that run and the time since the last one came or ended. A request that needs no
//   browser (initialize, ping, tools/list, a notification, GET, DELETE) passes the port's step 8 while Chrome is down, and
//   only a tool call goes through the port's `browser` gate, which starts Chrome (the start at a use). A tool call of the
//   MCP whose client closes its connection is no use from that close on, also one that the MCP runs on to its answer
//   (the id 0 or "": board ab-v16.94.14, O1).
//
// The log rule (C11, C12): a line names a session's number, a scope, a method and a result; never an argument, a
// payload, a page's content, a session id, a header, a token or a fingerprint.

import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { checkCall, filterTools, realFolder, serviceCall, serviceTools, type Admission, type AllowList, type Refused } from "./allow-list.ts";
import type { SignInHost } from "../../relay/model.ts";
import { SCOPE } from "../../relay/scopes.ts";
import { ActRefusal } from "../signins/act.ts";
import { FetchRefusal, PAGE_FETCH, type FetchCaller } from "../fetch/page-fetch.ts";
import { ACT_TEXT, signedInText } from "../signins/act-rules.ts";
import { rawValues } from "./admission.ts";
import type { McpHandler } from "./port.ts";
// mcpTakesCancel: a cancel's params that the pinned SDK acts on (review-121 note 2; session.ts, which also acts on it at
// a cancel of browser_close). Any other cancel frees nothing once the MCP has the request: the id stays busy until the
// MCP's answer or the end of its MCP session. A client's own such cancel leaves the call a use until then; its client's
// close ends the call's use at once (board ab-v16.94.14, O1).
import { mcpTakesCancel, type Message } from "./session.ts";
import { ScopeWorker, type ScopeWorkerOptions, type WorkerEnd } from "./workers.ts";

/** The limits of the MCP sessions (C11: first values). */
export const MCP_SESSIONS_PER_SCOPE = 4;
export const MCP_SESSIONS_PER_SERVICE = 32;
/** The largest body of one POST (first value); a larger one gets 413 and the connection closes. */
export const MCP_MAX_BODY = 1024 * 1024;
/**
 * On the Mac, the longest wait of a new MCP session for the drops of a case twin's folder (first value; board
 * ab-v16.94.28, review-162 N4): a drop waits for its workers' stops (worker.terminate()), and a stop that hangs must not
 * hold the twin's initialize with no end. After it the initialize gets C11's 503 of an MCP session that the service cannot
 * make, and a log line.
 */
export const MCP_TWIN_WAIT_MS = 10_000;

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
/**
 * An MCP session; `waiting` maps the id (JSON) of each request that waits to the cancel of that request; `last` is the
 * time (performance.now) of its client's last message or of its last answer, null while its initialize runs.
 */
type Session = { readonly id: string; readonly n: number; readonly scope: string; readonly worker: ScopeWorker; open: boolean; readonly waiting: Map<string, (why: Cancel, mcpTakes?: boolean) => void>; last: number | null };

/** A JSON-RPC id that the transport takes: a string or a safe integer (C11). */
const isId = (x: unknown): x is string | number => typeof x === "string" || Number.isSafeInteger(x);

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
  /**
   * The Mac (APFS ignores case, so `S1`'s folder is `s1`'s; board ab-v16.94.26, review-159b N2): a scope's new MCP
   * session waits (at most MCP_TWIN_WAIT_MS) for each removal of a case twin's folder that still runs, and a removal
   * spares a folder that a case twin's worker opened since its own drop.
   */
  foldCase?: boolean;
  /** A one-time ticket's URL for `scope`'s CDP path, or null. */
  ticketUrl: (scope: string) => string | null;
  log: (line: string) => void;
  /** The service's sign-in act while it has one (C11): the transport runs the service's own tools through it; null: none. */
  act?: () => SignInHost | null;
  /** The service's PageFetch while it has one (C11, PageFetch): the transport runs the tool PageFetch through it; null: none. */
  fetch?: () => PageFetchHost | null;
  /** Tests only: the workers' heap limit, file and open's wait, and other limits. */
  worker?: Pick<ScopeWorkerOptions, "heapMb" | "entry" | "openWaitMs">;
  perScope?: number;
  perService?: number;
  /** Tests only: the wait's limit of MCP_TWIN_WAIT_MS. */
  twinWaitMs?: number;
};

const rpcError = (id: unknown, code: number, message: string): Message => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
/** A tool's result with one text item; a tool error has `isError: true` (MCP's tool result; C11, what the agent sees). */
/** PageFetch as the transport runs it (page-fetch.ts): the answer's text, or a FetchRefusal. */
export type PageFetchHost = { fetch(c: FetchCaller, args: Record<string, unknown>): Promise<string> };
/** The text of a remote call of PageFetch while the service has no PageFetch (PageFetch's own refusal otherwise). */
const FETCH_REMOTE_TEXT = "Not fetched (unavailable): PageFetch works only for sessions of this box.";

const toolResult = (id: unknown, text: string, isError = false): Message => ({ jsonrpc: "2.0", id: id ?? null, result: { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) } });

function answer(res: ServerResponse, status: number, body: Message | null, headers: Record<string, string> = {}): void {
  if (res.headersSent || res.destroyed) return;
  const text = body === null ? "" : JSON.stringify(body);
  res.writeHead(status, { ...(body === null ? {} : { "Content-Type": "application/json" }), "Content-Length": Buffer.byteLength(text), ...headers }).end(text);
}

const isObj = (x: unknown): x is Message => x !== null && typeof x === "object" && !Array.isArray(x);

/** Whether `p` settles within `ms` ms (none: false at once); the timer goes when it does. */
async function settles(p: Promise<unknown>, ms: number): Promise<boolean> {
  if (ms <= 0) return false;
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<boolean>((r) => { timer = setTimeout(() => r(false), ms); });
  try { return await Promise.race([p.then(() => true, () => true), late]); } finally { clearTimeout(timer); }
}

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
  /** The Mac (foldCase): the scopes whose worker opened their folder since their drop, and the drops that still run. */
  private readonly opened = new Set<string>();
  private readonly drops = new Set<{ scope: string; done: Promise<void> }>();
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

  /**
   * C12's `status.mcp.sessions` (board ab-v16.94.24): the open MCP sessions of each scope, only the scopes with one or
   * more. An MCP session is open from the answer to its `initialize` (its `Mcp-Session-Id`) until it ends: one whose
   * `initialize` still runs does not count. A Map first: a scope can be named `constructor` or `toString`.
   */
  openSessions(): Record<string, number> {
    const n = new Map<string, number>();
    for (const s of this.sessions.values()) if (s.last !== null) n.set(s.scope, (n.get(s.scope) ?? 0) + 1);
    return Object.fromEntries(n);
  }

  /** The worker of `scope` while it runs (the tests and the memory measures). */
  workerOf(scope: string): ScopeWorker | undefined { return this.workers.get(scope); }

  async request(req: IncomingMessage, res: ServerResponse, scope: string, browser?: (tool: string) => Promise<boolean>, admission?: Admission): Promise<void> {
    // Only the exact word local is a local admission (C11, the sign-in act's check 1): no word is remote (fail closed).
    if (req.method === "POST") return this.post(req, res, scope, browser, admission === "local" ? "local" : "remote");
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

  private async post(req: IncomingMessage, res: ServerResponse, scope: string, browser: ((tool: string) => Promise<boolean>) | undefined, admission: Admission): Promise<void> {
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
    s.last = performance.now();
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
    // A call of one of the service's own tools (C11, the sign-in act): the transport answers it, never the MCP.
    let own: { tool: string; args: Record<string, unknown>; act: SignInHost | null; fetch: PageFetchHost | null } | null = null;
    if (msg.method === "tools/call") {
      const params = isObj(msg.params) ? msg.params : {};
      const act = this.o.act?.() ?? null, fetch = this.o.fetch?.() ?? null;
      // Each own tool is served while the service has its part: PageFetch with PageFetch, the sign-in tools with the act.
      const isFetch = params.name === PAGE_FETCH;
      const mine = serviceCall(this.o.list, params, admission, isFetch ? fetch !== null : act !== null);
      if (mine === "remote") {
        // A request that a remote token admitted (C11, check 1): the act's own check 1 refuses it at once, with its text
        // and, for browser_sign_in, its one refusal end (result remote); PageFetch's own refusal for PageFetch. It passes
        // no browser gate, is no use, and never reaches the MCP.
        const refusal = isFetch ? await this.refuseRemoteFetch(scope, fetch, msg.id) : await this.refuseRemote(params.name as string, scope, act, msg.id);
        answer(res, 200, refusal);
        this.o.log(`mcp: MCP session ${s.n} (scope ${scope}): a tools/call of ${params.name as string} refused (a remote admission)`);
        return;
      }
      if (mine !== null && "tool" in mine) own = { ...mine, act, fetch };
      const refused = own !== null ? null : mine !== null ? (mine as Refused) : checkCall(this.o.list, params, scopeFolder(this.o.stateFolder, scope), undefined, [join(this.o.stateFolder, "mcp"), scopeFolder(this.o.stateFolder, scope)]);
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
    // A running act of the service's own tools takes no cancel: the act runs to its end, and its POST gets its answer.
    const cancel = (why: Cancel, mcpTakes = true) => {
      if (at.cancelled !== null || (at.sent && (own !== null || !mcpTakes))) return;
      at.cancelled = why;
      if (s.waiting.get(key) === cancel) s.waiting.delete(key);
      if (at.sent) s.worker.drop(s.id, forward.id);
      stopWait();
    };
    s.waiting.set(key, cancel);
    // A tool call counts as a use from the moment that it goes to the MCP (or to the act) until its end; `unuse` ends
    // that count once.
    let using = false;
    const unuse = () => { if (using) { using = false; this.calls--; this.lastCall = performance.now(); } };
    // A client that goes away before the answer cancels its call: the MCP's own notifications/cancelled, once the MCP
    // has the request. For an id that the MCP would not cancel (0 or ""), the call runs on in the MCP to its answer: its
    // id stays busy until the MCP's answer or the end of its MCP session (review-121 note 2), but the call is no use
    // from that close on (board ab-v16.94.14, O1): the pinned browser_evaluate has no time limit, so a script that never
    // settles would keep Chrome from its stop by use until the MCP session ends. A running act of the service's own
    // tools stays a use until it ends (C11).
    const gone = () => {
      if (res.writableEnded || at.cancelled !== null) return;
      const params = { requestId: forward.id, reason: "the client closed its connection" };
      if (at.sent && own !== null) return;
      if (at.sent && !mcpTakesCancel(params)) { unuse(); return; }
      if (at.sent) s.worker.notify(s.id, { jsonrpc: "2.0", method: "notifications/cancelled", params });
      cancel("closed");
    };
    res.once("close", gone);
    try {
      // A tool call needs the browser (board ab-v16.94.11): while Chrome is down or its lists are not confirmed, it
      // starts Chrome and waits (the port's gate, which answers a refusal itself); a request whose client left meanwhile
      // gets false from the gate and never reaches the MCP. The gate takes the call's tool. A scope with no list, or with
      // a list that has no site, is no exception: each tool goes on, and its browser tools keep the scope's list at the
      // agent door (board ab-v16.104).
      if (forward.method === "tools/call" && browser && !(await browser(String(isObj(forward.params) ? forward.params.name : "")))) return;
      if (at.cancelled === "client") { send(res, "cancelled", forward.id); return; }
      if (at.cancelled !== null) return;
      // The MCP session ended while the call waited for the browser (a DELETE, session_ended, the close at a change,
      // the worker's end): the answer of its end, and the call never reaches the MCP (review-121 B1).
      if (!s.open) { send(res, this.endOf(s), forward.id); return; }
      let got: Message | null;
      const call = forward.method === "tools/call";
      if (call) { using = true; this.calls++; this.lastCall = performance.now(); }
      at.sent = true;
      // The service's own tool: the act's method; its call counts as a use until the act ends (C11: Chrome does not stop
      // while an act runs), also when its client has gone.
      try { got = await Promise.race([own !== null ? this.runOwn(own, scope, forward.id) : s.worker.request(s.id, forward), stopped]); }
      finally { unuse(); }
      if (at.cancelled === "client") { send(res, "cancelled", forward.id); return; }
      if (at.cancelled !== null) return;
      if (got === null) { send(res, this.endOf(s), forward.id); return; }
      answer(res, 200, forward.method === "tools/list" ? this.filtered(got, admission) : got);
    } finally {
      if (s.waiting.get(key) === cancel) s.waiting.delete(key);
      res.off("close", gone);
      s.last = performance.now();
    }
  }

  /**
   * `tools/list`'s answer without each tool that the allow list does not name, and with the service's own tools after
   * them only for a request with a local admission while the service has the sign-in act (C11).
   */
  private filtered(m: Message, admission: Admission): Message {
    const r = m.result;
    if (!isObj(r) || !Array.isArray(r.tools)) return m;
    const act = (this.o.act?.() ?? null) !== null, fetch = (this.o.fetch?.() ?? null) !== null;
    const mine = admission === "local" ? serviceTools(this.o.list).filter((t) => (t.name === PAGE_FETCH ? fetch : act)) : [];
    return { ...m, result: { ...r, tools: [...filterTools(this.o.list, r.tools as { name?: unknown }[]), ...mine] } };
  }

  /**
   * A call of one of the service's own tools that a remote token admitted (C11, the sign-in act's check 1; the design,
   * sections 5.7 and 7.1): the act's method with the admission `remote` and no argument of the client, so the act's own
   * check 1 refuses it before it reads a name, the store or the model: browser_sign_in sends the act's one refusal end
   * (result remote) and its log line, browser_sign_ins sends no event (as AgentBrowser.signIns). With no act there is no
   * store and no event: the transport gives check 1's text itself. Any other outcome of the act gives check 1's text too.
   */
  private async refuseRemote(tool: string, scope: string, act: SignInHost | null, id: unknown): Promise<Message> {
    const text = `Not signed in: ${ACT_TEXT.remote}`;
    if (act === null) return toolResult(id, text, true);
    const caller = { scope, admission: "remote" as const };
    try {
      if (tool === "browser_sign_ins") act.signIns(caller);
      else await act.signIn(caller, {});
    } catch (e) {
      if (e instanceof ActRefusal) return toolResult(id, e.message, true);
    }
    return toolResult(id, text, true);
  }

  /** A call of PageFetch that a remote token admitted (C11, PageFetch): PageFetch's own refusal and its log line, at once. */
  private async refuseRemoteFetch(scope: string, fetch: PageFetchHost | null, id: unknown): Promise<Message> {
    if (fetch === null) return toolResult(id, FETCH_REMOTE_TEXT, true);
    try { await fetch.fetch({ scope, admission: "remote" }, {}); } catch (e) {
      if (e instanceof FetchRefusal) return toolResult(id, e.message, true);
    }
    return toolResult(id, FETCH_REMOTE_TEXT, true);
  }

  /**
   * One of the service's own tools for a local admission (C11, the sign-in act; what the agent sees): the act's method
   * for the MCP session's scope. The answer holds only what C11 names: for browser_sign_in the success text, made from the
   * origin alone; for browser_sign_ins the state and each name and origin, as compact JSON; for a refusal the tool error
   * `Not signed in: <text>`. Another exception rejects the request path (the port's fixed 500, which echoes nothing).
   */
  private async runOwn(own: { tool: string; args: Record<string, unknown>; act: SignInHost | null; fetch: PageFetchHost | null }, scope: string, id: unknown): Promise<Message> {
    const caller = { scope, admission: "local" as const };
    // PageFetch (C11, PageFetch): its answer's text, or its tool error `Not fetched (<code>): <sentence>`.
    if (own.tool === PAGE_FETCH) {
      try { return toolResult(id, await own.fetch!.fetch(caller, own.args)); }
      catch (e) { if (e instanceof FetchRefusal) return toolResult(id, e.message, true); throw e; }
    }
    try {
      if (own.tool === "browser_sign_ins") {
        const r = own.act!.signIns(caller) as { state?: unknown; signIns?: unknown };
        const state = r?.state === "open" || r?.state === "locked" ? r.state : "none";
        const list = Array.isArray(r?.signIns) ? (r.signIns as Record<string, unknown>[]).filter((x) => isObj(x) && typeof x.name === "string" && typeof x.origin === "string").map((x) => ({ name: x.name as string, origin: x.origin as string })) : [];
        return toolResult(id, JSON.stringify({ state, signIns: list }));
      }
      const r = await own.act!.signIn(caller, own.args) as { signedIn?: unknown; origin?: unknown };
      if (r?.signedIn !== true || typeof r.origin !== "string") throw new Error("the act gave no answer of a sign-in");
      return toolResult(id, signedInText(r.origin));
    } catch (e) {
      if (e instanceof ActRefusal) return toolResult(id, e.message, true);
      throw e;
    }
  }

  /** The answer of a request whose MCP session ended while it waited: its worker's memory end, its failure, or another end. */
  private endOf(s: Session): "ended" | "memory" | "failed" {
    const w = s.worker;
    return !w.ended ? "ended" : this.endings.get(w) === "memory" ? "memory" : this.endings.get(w) === "error" ? "failed" : "ended";
  }
  private readonly endings = new WeakMap<ScopeWorker, WorkerEnd>();

  private async initialize(req: IncomingMessage, res: ServerResponse, scope: string, msg: Message): Promise<void> {
    if (rawValues(req.rawHeaders, "mcp-session-id").length) { send(res, "initializeWithId", msg.id); return; }
    // On the Mac a case twin's drop that still runs ends first: its folder is this scope's, so a worker would open it
    // with the twin's files, and the drop would then remove it under the worker (review-159b N2). The wait has a limit
    // (MCP_TWIN_WAIT_MS, review-162 N4). After the wait, a request whose connection closed meanwhile makes no worker, no
    // MCP session and no folder (review-162 N3): the port closes it when its scope ends or its session's token changes
    // (C11's close at a change), and then endSessions and the drop found nothing of it to end.
    if (this.twinDrops(scope).length) {
      const ms = this.o.twinWaitMs ?? MCP_TWIN_WAIT_MS, until = performance.now() + ms;
      let late = false;
      for (let twins = this.twinDrops(scope); twins.length && !late; twins = this.twinDrops(scope)) late = !(await settles(Promise.allSettled(twins), until - performance.now()));
      if (req.socket.destroyed) { this.o.log(`mcp: scope ${scope}: an initialize ended: its connection closed while it waited for the drop of a case twin's folder`); return; }
      if (late) { send(res, "notOpened", msg.id); this.o.log(`mcp: scope ${scope}: an initialize refused (the drop of a case twin's folder still runs after ${ms} ms)`); return; }
    }
    if (this.stopped) { send(res, "notOpened", msg.id); return; }
    if (this.size(scope) >= (this.o.perScope ?? MCP_SESSIONS_PER_SCOPE)) {
      // At the scope's limit (C11; board ab-v16.94.16, F4): the MCP session with no request that waits whose last message
      // or answer is the oldest gives its place (a client that reconnected with no DELETE left it); else the 503. It ends
      // before the new MCP session is made: when that one then cannot be made, the ended one stays ended (C11; board
      // ab-v16.94.18, review-143 note 7).
      let quiet: Session | undefined;
      for (const x of this.sessions.values()) if (x.scope === scope && x.last !== null && x.waiting.size === 0 && (quiet === undefined || x.last < quiet.last!)) quiet = x;
      if (quiet === undefined) { send(res, "perScope", msg.id); this.o.log(`mcp: scope ${scope}: an initialize refused (its MCP sessions are at their limit)`); return; }
      this.end(quiet, "a new MCP session took its place");
    }
    if (this.size() >= (this.o.perService ?? MCP_SESSIONS_PER_SERVICE)) { send(res, "perService", msg.id); this.o.log(`mcp: scope ${scope}: an initialize refused (the service's MCP sessions are at their limit)`); return; }
    const worker = this.workerFor(scope);
    const s: Session = { id: randomBytes(16).toString("hex"), n: ++this.count, scope, worker, open: true, waiting: new Map(), last: null };
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
    s.last = performance.now();
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
    if (this.o.foldCase) this.opened.add(scope);
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
  dropScope(scope: string, why: string): Promise<void> {
    const done = this.drop(scope, why);
    if (!this.o.foldCase) return done;
    // On the Mac a case twin's new MCP session waits for this drop (review-159b N2).
    const d = { scope, done };
    this.drops.add(d);
    const gone = () => { this.drops.delete(d); };
    void done.then(gone, gone);
    return done;
  }

  private async drop(scope: string, why: string): Promise<void> {
    this.endSessions(scope);
    // Every worker of the scope that still stops, also one that stops meanwhile (review-121 note 4). The first await
    // also puts the removal after the control door's answer (C12).
    do { await Promise.all([...(this.halts.get(scope) ?? [])]); } while (this.halts.get(scope)?.size);
    if (this.stopped || this.workers.has(scope) || this.size(scope) > 0) return;
    // On the Mac a folder that a case twin's worker opened since the twin's own drop is the twin's (review-159b N2).
    this.opened.delete(scope);
    const twin = [...this.opened].find((n) => n.toLowerCase() === scope.toLowerCase());
    if (twin !== undefined) { this.o.log(`mcp: the folder of scope ${scope} is not emptied (on the Mac its name and ${twin} differ only in case, and ${twin} uses the folder)`); return; }
    const r = removeScopeFolder(this.o.stateFolder, scope);
    // A failed removal gets its line too, with the scope and the error's code only (review-121 B2).
    if (r.removed) this.o.log(`mcp: the folder of scope ${scope} is emptied (${why})`);
    else if (r.why !== null) this.o.log(`mcp: the folder of scope ${scope} is not emptied (${r.why})`);
  }

  /** The drops that still run of the other names with the lower case of `scope` (none on Linux). */
  private twinDrops(scope: string): Promise<void>[] {
    return [...this.drops].filter((d) => d.scope !== scope && d.scope.toLowerCase() === scope.toLowerCase()).map((d) => d.done);
  }

  /**
   * C12's set_sessions (review-115 note 3): the folder of each scope that the snapshot does not name goes (also of a
   * session that ended while the service was down, which got no session_ended). Only a folder whose name is a scope
   * (removeScopeFolder).
   */
  async keepScopes(named: ReadonlySet<string>): Promise<void> {
    const mcp = join(this.o.stateFolder, "mcp");
    // No <state>/mcp: no MCP session made it yet. Another error gets its line, with the error's code only, as in
    // removeScopeFolder (board ab-v16.94.14, N2).
    try { lstatSync(mcp); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") this.o.log(`mcp: no scope's folder is emptied (${codeOf(e)})`); return; }
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
