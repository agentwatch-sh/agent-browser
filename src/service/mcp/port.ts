// The MCP port of `agent-browser service` (contract C11, "The MCP path" and "The admission of the MCP path"; stage 1d
// of the self-contained agent browser, board ab-v16.94.5, part 2a; the token design, board ab-v16.94.10). A TCP listener
// on 127.0.0.1 only, or the socket of agent-browser-mcp.socket that systemd passes (listen-fds.ts). At each accept the
// socket stays paused, and steps 1 and 2 of the admission run before the service reads any byte (admission.ts); a
// refusal writes its 403 and closes, with no read. Only an admitted connection goes to the HTTP server, where steps 3 to
// 8 run for each request. A request that passes goes to the MCP handler (part 2b: the transport, transport.ts). On the Mac
// the port accepts and closes each connection (fail closed) until the Mac's TCP peer reader exists (stage 4).
//
// The rules of part 2b for an admitted connection (the review of part 2a, notes 2, 8 and 10): after the first refusal of
// steps 3 to 8 the connection is marked, and each later request on it (a pipelined one) is dropped with no handler call;
// a request with `Expect` runs steps 3 to 8 before any 100 or 417 answer; CONNECT stays refused (Node closes it); an
// exception of the request path gives a 500 with a fixed text and never stops the service; and the connection has
// timeouts of its own (Node's server never listens here, so its headersTimeout and requestTimeout do not run): a request
// header must come whole within MCP_HEADERS_MS of the admission or of the last answer, and a body that pauses for
// MCP_IDLE_MS closes the connection, each with no answer.
//
// The close at a change (C11, C12): at session_ended the port closes the scope's connections; at each set_sessions it
// closes each connection whose admitting root no longer counts, and each connection of a session that the snapshot
// drops or whose mcp_token changed; and the handler ends the MCP sessions of each such session. The connections are kept
// by scope.
//
// The log rule (C11, C12): a log line names a connection's number, a scope, a method, a step and a status. It never holds
// a tool argument, page content, a cookie, a URL path, a payload, an Authorization header, a token, a fingerprint or a
// lifetime id, and a request that the HTTP parser refuses for its size or its shape is never logged (Node answers it).

import { createServer as createHttp, STATUS_CODES, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { createServer, type Server, type Socket } from "node:net";
import type { Req } from "../control.ts";
import type { ServicePart } from "../part.ts";
import { PEER_UNREAD } from "../../relay/peer.ts";
import type { Root } from "../../relay/scopes.ts";
import { admitConnection, admitRequest, McpSnapshot, WWW_AUTHENTICATE, type Admitted, type McpItem, type McpReadiness, type Refusal } from "./admission.ts";
import { procReader, walkReader, type McpReader } from "./proc.ts";

/** The MCP handler behind the admission (part 2b: the Streamable HTTP transport and the Playwright MCP). */
export interface McpHandler {
  /** A request that passed steps 1 to 8, of the connection's scope: the handler answers it (a rejection gets the 500). */
  request(req: IncomingMessage, res: ServerResponse, scope: string): void | Promise<void>;
  /** End the MCP sessions of `scope` (C11: at session_ended, and at the close at a change). */
  endSessions(scope: string): void;
}

/** A refused connection's socket closes this long after its answer at the latest (the client reads the answer first). */
const REFUSED_CLOSE_MS = 1000;
/** An admitted connection's request header comes whole within this time of the admission or of the last answer (C11: first value). */
export const MCP_HEADERS_MS = 10_000;
/** A request body that pauses this long closes its connection (C11: first value). */
export const MCP_IDLE_MS = 30_000;
/** The 500 of an exception in the request path (C11): a fixed text, which echoes nothing. */
export const MCP_FAILED = "The agent browser could not answer this request.";

export type McpPortOptions = {
  /** A TCP port on 127.0.0.1 (0: a free one), or the fd of agent-browser-mcp.socket (listen-fds.ts). */
  listen: { port: number } | { fd: number };
  handler: McpHandler;
  /** What step 8 reads of the service, for the connection's scope. */
  readiness: (scope: string) => McpReadiness;
  log: (line: string) => void;
  /** Tests only: the fake reader of the vectors (default: /proc), the platform, the service's uid, the compare of step 7. */
  reader?: McpReader;
  platform?: NodeJS.Platform;
  uid?: number;
  compare?: (a: Buffer, b: Buffer) => boolean;
  /** Tests only: the timeouts of an admitted connection. */
  headersMs?: number;
  idleMs?: number;
};

/** An admitted connection: its number, its socket, its scope, the roots that admitted it, and its session's fingerprint at the admission. */
type Conn = Admitted & { readonly n: number; readonly socket: Socket; readonly token: string | null; refused: boolean; timer: NodeJS.Timeout | null; reading: boolean };

export class McpPort {
  /** The TCP listener (paused sockets), and the port that it listens on. */
  readonly listener: Server;
  readonly port: number;
  private readonly http: HttpServer;
  private readonly o: McpPortOptions;
  private readonly reader: McpReader;
  private readonly uid: number;
  private snapshot = McpSnapshot.none();
  /** The admitted connections, by scope, and by socket. */
  private readonly byScope = new Map<string, Set<Conn>>();
  private readonly bySocket = new Map<Socket, Conn>();
  /** Every socket that is still open, also a refused one that waits for its close. */
  private readonly sockets = new Set<Socket>();
  private count = 0;
  private stopping: Promise<void> | undefined;

  private constructor(o: McpPortOptions, listener: Server, port: number) {
    this.o = o; this.listener = listener; this.port = port;
    this.reader = o.reader ?? procReader();
    this.uid = o.uid ?? process.getuid!();
    // No Host header is the Host's 403 of step 4, not Node's own 400.
    this.http = createHttp({ requireHostHeader: false }, (req, res) => this.request(req, res));
    // The connection's own header timeout governs an idle keep-alive connection too (C11: 10 s), not Node's 5 s.
    this.http.keepAliveTimeout = 0;
    // Expect: steps 3 to 8 come before any 100 or 417 answer (Node would answer them first).
    this.http.on("checkContinue", (req: IncomingMessage, res: ServerResponse) => this.request(req, res, "continue"));
    this.http.on("checkExpectation", (req: IncomingMessage, res: ServerResponse) => this.request(req, res, "expectation"));
  }

  /** Listen on 127.0.0.1 only (a port, or systemd's socket), or fail: a socket on another address is refused. */
  static async open(o: McpPortOptions): Promise<McpPort> {
    const listener = createServer({ pauseOnConnect: true });
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      if ("fd" in o.listen) listener.listen({ fd: o.listen.fd }, resolve);
      else listener.listen({ host: "127.0.0.1", port: o.listen.port, exclusive: true }, resolve);
    });
    const a = listener.address();
    if (a === null || typeof a === "string" || a.family !== "IPv4" || a.address !== "127.0.0.1") {
      await new Promise<void>((r) => listener.close(() => r()));
      throw new Error(`the MCP port listens on 127.0.0.1 only, not on ${a !== null && typeof a !== "string" ? `${a.address}:${a.port}` : "a socket that is not TCP"}`);
    }
    const port = new McpPort(o, listener, a.port);
    listener.on("connection", (socket: Socket) => port.accept(socket));
    o.log(`mcp: listening on 127.0.0.1:${a.port}${"fd" in o.listen ? " (the socket unit's)" : ""}${(o.platform ?? process.platform) === "darwin" ? "; the Mac has no TCP peer reader yet, so it closes each connection" : ""}`);
    return port;
  }

  /** The open admitted connections (of `scope`, or of every scope). */
  connections(scope?: string): number {
    if (scope !== undefined) return this.byScope.get(scope)?.size ?? 0;
    return this.bySocket.size;
  }

  /** The control door's part (C12): set_sessions and session_ended reach the port. No op of its own. */
  part(): ServicePart {
    return { ops: {}, setSessions: (req) => this.setSessions(req), sessionEnded: (scope) => this.sessionEnded(scope) };
  }

  // ------------------------------------------------------------------ the accept: steps 1 and 2, before any byte

  private accept(socket: Socket): void {
    const n = ++this.count;
    this.sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => this.sockets.delete(socket));
    // The Mac: no TCP peer reader yet (stage 4), so the port fails closed.
    if ((this.o.platform ?? process.platform) === "darwin") { socket.destroy(); return; }
    this.admit(socket, n);
  }

  /** Steps 1 and 2 on the paused socket: no byte of it is read before they pass. */
  private admit(socket: Socket, n: number): void {
    let a: Admitted | Refusal;
    try {
      a = admitConnection({ reader: this.reader, snapshot: this.snapshot, client: `${socket.remoteAddress}:${socket.remotePort}`, service: `127.0.0.1:${this.port}`, uid: this.uid });
    } catch { a = { step: 1, status: 403, body: PEER_UNREAD }; } // a read that throws fails closed
    if ("status" in a) {
      // The answer goes out, and the socket closes, with no read of the request.
      socket.end(`HTTP/1.1 ${a.status} ${STATUS_CODES[a.status]}\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(a.body)}\r\nConnection: close\r\n\r\n${a.body}`);
      setTimeout(() => socket.destroy(), REFUSED_CLOSE_MS).unref();
      this.o.log(`mcp: connection ${n} refused at step ${a.step} (${a.status})`);
      return;
    }
    const conn: Conn = { ...a, n, socket, token: this.snapshot.items.get(a.scope)?.mcp_token ?? null, refused: false, timer: null, reading: false };
    let set = this.byScope.get(a.scope);
    if (!set) this.byScope.set(a.scope, (set = new Set()));
    set.add(conn);
    this.bySocket.set(socket, conn);
    socket.once("close", () => { this.forget(conn); this.untime(conn); });
    // The idle time of a request body: a pause this long while the body is read closes the connection, with no answer.
    socket.on("timeout", () => { if (conn.reading && !socket.destroyed) this.close(conn, "the request body paused too long"); });
    this.o.log(`mcp: connection ${n} admitted for scope ${a.scope}`);
    this.http.emit("connection", socket);
    this.timeHeader(conn);
    socket.resume();
  }

  /** The header timeout: a request header comes whole in time, or the connection closes with no answer. */
  private timeHeader(c: Conn): void {
    this.untime(c);
    if (c.socket.destroyed) return;
    c.timer = setTimeout(() => { c.timer = null; if (!c.socket.destroyed) this.close(c, "no request header in time"); }, this.o.headersMs ?? MCP_HEADERS_MS);
    c.timer.unref();
  }
  private untime(c: Conn): void { if (c.timer) { clearTimeout(c.timer); c.timer = null; } }

  private forget(c: Conn): void {
    this.bySocket.delete(c.socket);
    const set = this.byScope.get(c.scope);
    set?.delete(c);
    if (set && set.size === 0) this.byScope.delete(c.scope);
  }

  // ------------------------------------------------------------------ each request: steps 3 to 8

  private request(req: IncomingMessage, res: ServerResponse, expect: "continue" | "expectation" | null = null): void {
    const conn = this.bySocket.get(req.socket as Socket);
    if (!conn) { req.socket.destroy(); return; }
    // After a refusal, a later request on the connection (a pipelined one) is dropped: no step, no handler, no answer.
    if (conn.refused) { req.socket.destroy(); return; }
    this.untime(conn);
    // A body that pauses for the idle time closes the connection; while the service works on the request, no timeout
    // runs; after the answer the next request's header has its time.
    conn.reading = !req.complete;
    if (conn.reading) {
      conn.socket.setTimeout(this.o.idleMs ?? MCP_IDLE_MS);
      req.once("end", () => { conn.reading = false; conn.socket.setTimeout(0); });
    }
    res.once("finish", () => this.timeHeader(conn));
    const fail = () => {
      // An exception of the request path: the fixed 500, which echoes nothing, and the connection closes.
      conn.refused = true;
      if (!res.headersSent && !res.destroyed) res.writeHead(500, { "Content-Type": "text/plain", "Content-Length": Buffer.byteLength(MCP_FAILED), Connection: "close" }).end(MCP_FAILED);
      else conn.socket.destroy();
      this.o.log(`mcp: connection ${conn.n} (scope ${conn.scope}): a ${req.method} request failed (500)`);
    };
    let r;
    try {
      r = admitRequest({ req, conn, snapshot: this.snapshot, port: this.port, readiness: this.o.readiness, compare: this.o.compare });
    } catch { fail(); return; }
    if (r === null) {
      if (expect === "expectation") {
        // Steps 3 to 8 passed; an expectation that the service does not know gets the 417, and the connection closes.
        conn.refused = true;
        res.writeHead(417, { "Content-Type": "text/plain", "Content-Length": 18, Connection: "close" }).end("Expectation Failed");
        this.o.log(`mcp: connection ${conn.n} (scope ${conn.scope}): a ${req.method} request with an expectation refused (417)`);
        return;
      }
      if (expect === "continue") res.writeContinue();
      try {
        const p = this.o.handler.request(req, res, conn.scope);
        if (p && typeof (p as Promise<void>).then === "function") (p as Promise<void>).catch(fail);
      } catch { fail(); }
      return;
    }
    // The first refusal closes the connection.
    conn.refused = true;
    res.writeHead(r.status, { "Content-Type": "text/plain", "Content-Length": Buffer.byteLength(r.body), ...(r.status === 401 ? { "WWW-Authenticate": WWW_AUTHENTICATE } : {}), Connection: "close" }).end(r.body);
    this.o.log(`mcp: connection ${conn.n} (scope ${conn.scope}): a ${req.method} request refused at step ${r.step} (${r.status})`);
  }

  // ------------------------------------------------------------------ the close at a change

  private close(c: Conn, why: string): void {
    this.forget(c);
    this.untime(c);
    c.socket.destroy();
    this.o.log(`mcp: connection ${c.n} (scope ${c.scope}) closed: ${why}`);
  }

  /**
   * C12's set_sessions (after the door's shape step): the new snapshot, then the close at a change (C11). A connection
   * closes when the snapshot drops its session, when its session's mcp_token changed, or when a root that admitted it
   * no longer counts for its scope: also when only that root's cgroup stops counting, for a connection that the
   * root's cgroup admitted (the review of part 2a, note 5). The handler ends the MCP sessions of each such session, and of each
   * session that the snapshot drops or whose mcp_token changed, also with no open connection.
   */
  setSessions(req: Req): void {
    const prev = this.snapshot;
    const next = McpSnapshot.read(walkReader(this.reader), (req.sessions as McpItem[]).map((s) => ({ scope: s.scope, roots: s.roots, mcp_token: s.mcp_token ?? null })));
    this.snapshot = next;
    const ended = new Set<string>();
    for (const [scope, item] of prev.items) {
      const now = next.items.get(scope);
      if (now === undefined || now.mcp_token !== item.mcp_token) ended.add(scope);
    }
    for (const c of [...this.bySocket.values()]) {
      const now = next.items.get(c.scope);
      const why = now === undefined ? "the snapshot drops its session"
        : now.mcp_token !== c.token ? "its session's connection token changed"
        : c.roots.every((r: Root) => next.roots.counts(c.scope, r) && (!c.byCgroup.some((b) => b.pid === r.pid && b.start === r.start) || next.roots.cgroupCounts(c.scope, r))) ? null : "a root that admitted it no longer counts";
      if (why === null) continue;
      this.close(c, why);
      ended.add(c.scope);
    }
    for (const scope of ended) this.o.handler.endSessions(scope);
  }

  /** C12's session_ended: the scope's connections close, the session's fingerprint goes, and its MCP sessions end. */
  sessionEnded(scope: string): void {
    for (const c of [...(this.byScope.get(scope) ?? [])]) this.close(c, "its session ended");
    this.snapshot = this.snapshot.without(walkReader(this.reader), scope);
    this.o.handler.endSessions(scope);
  }

  /** Close every connection and the listener. */
  stop(): Promise<void> {
    return this.stopping ??= (async () => {
      for (const s of [...this.sockets]) s.destroy();
      this.byScope.clear(); this.bySocket.clear();
      await new Promise<void>((r) => this.listener.close(() => r()));
      this.http.close();
      this.o.log("mcp: stopped");
    })();
  }
}
