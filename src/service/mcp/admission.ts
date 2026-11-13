// The admission of the MCP path (contract C11, "The admission of the MCP path", steps 1 to 8, with the token step of
// the token design, docs/superpowers/specs/2026-11-10-mcp-connection-tokens-design.md; stage 1d of the self-contained
// agent browser, board ab-v16.94.5). Steps 1 and 2 run once for each TCP connection, before the service reads any byte
// (port.ts calls admitConnection at the accept, on a paused socket); steps 3 to 8 run for each request on an admitted
// connection (admitRequest). The first check that fails gives its answer, and the connection then closes.
//
// The walk of step 2 is the endpoint's own session check (src/relay/peer.ts: RootState, with the roots of the last
// set_sessions); the texts of the peer's 403, the session's 403, the Origin's 403 and the 503s are the endpoint's (C11,
// before the upgrade). No answer echoes a header, a token, a fingerprint, a scope from the request or a lifetime id.

import { createHash, timingSafeEqual } from "node:crypto";
import { FROM_PAGE } from "../../relay/endpoint.ts";
import { NOT_READY } from "../../relay/model.ts";
import { Peer, PEER_UNREAD, RootState, sessionRefusal, type PeerReader } from "../../relay/peer.ts";
import { SCOPE, type Root } from "../../relay/scopes.ts";
import { walkReader, type McpReader, type TcpLine } from "./proc.ts";

/** The MCP path's own texts (C11): the Host's 403, the path's 404, the three 401s of the token step, and control off. */
export const MCP_TEXT = {
  badHost: "The agent browser admits only the Host 127.0.0.1:<port> or localhost:<port>.",
  notFound: "Not found. Connect an MCP client to /mcp/<scope>.",
  needsToken: "The agent browser needs this session's connection token. agentwatch adds it to the sessions that it starts while the repo's list has a site.",
  noToken: "This session has no connection token. agentwatch adds one when it starts a session while the repo's list has a site: restart the session.",
  unknownToken: "The agent browser does not know this connection token for this session.",
  controlOff: "The agent browser is off: the operator turned agent control off.",
} as const;
/** Each 401 carries this header, with no resource_metadata, so no client starts an OAuth login (C11, step 7). */
export const WWW_AUTHENTICATE = 'Bearer realm="agent-browser"';

/** A refusal: its step, its status and its text (a 401 also gets WWW_AUTHENTICATE). */
export type Refusal = { readonly step: number; readonly status: number; readonly body: string };
/**
 * An admitted connection: its scope (the walk's), the roots that admitted its holders, those of them that admitted a
 * holder by their cgroup only (the walk met no root), the pid of a later session's 403, and its admission: `local`, as
 * steps 1 and 2 admit only by the uid check and the walk (C11, the sign-in act's check 1; a remote token is stage 5's).
 */
export type Admitted = { readonly scope: string; readonly roots: readonly Root[]; readonly byCgroup: readonly Root[]; readonly pid: number; readonly admission: "local" };

/** One item of set_sessions as the MCP path keeps it: the session's scope, its roots and its fingerprint (C12; in memory only). */
export type McpItem = { readonly scope: string; readonly roots: readonly Root[]; readonly mcp_token: string | null };

/**
 * The last set_sessions as the MCP path reads it: the item of each scope (C12's rule of one scope once) and the root
 * state of their roots (the defensive root rules, read at the snapshot). Before the first set_sessions no root counts,
 * so the walk refuses each holder (the session's 403: C11, the lead's decision OP1).
 */
export class McpSnapshot {
  readonly items: ReadonlyMap<string, McpItem>;
  readonly roots: RootState;
  private constructor(items: Map<string, McpItem>, roots: RootState) { this.items = items; this.roots = roots; }

  static none(): McpSnapshot { return new McpSnapshot(new Map(), RootState.empty()); }

  static read(reader: PeerReader, sessions: readonly McpItem[]): McpSnapshot {
    const items = new Map<string, McpItem>();
    for (const s of sessions) items.set(s.scope, { scope: s.scope, roots: s.roots.map((r) => ({ pid: r.pid, start: r.start })), mcp_token: s.mcp_token });
    return new McpSnapshot(items, RootState.read(reader, new Map([...items].map(([scope, s]) => [scope, s.roots]))));
  }

  /** This snapshot without `scope` (C12's session_ended: the service drops the session's fingerprint with the session). */
  without(reader: PeerReader, scope: string): McpSnapshot {
    return McpSnapshot.read(reader, [...this.items.values()].filter((s) => s.scope !== scope));
  }
}

/** Step 1: the one line whose local address is the client's and whose remote address is the service's (the full tuple), or null. */
export function clientLine(lines: readonly TcpLine[] | null, client: string, service: string): TcpLine | null {
  if (lines === null) return null;
  const m = lines.filter((l) => l.local === client && l.remote === service);
  return m.length === 1 ? m[0] : null;
}

const sameLine = (a: TcpLine, b: TcpLine) => a.local === b.local && a.remote === b.remote && a.uid === b.uid && a.inode === b.inode;
const peer403 = (step: number): Refusal => ({ step, status: 403, body: PEER_UNREAD });
const session403 = (step: number, pid: number): Refusal => ({ step, status: 403, body: sessionRefusal(pid) });

/**
 * Steps 1 and 2 for one TCP connection (C11), before the service reads any byte of it. `client` is the client's address
 * and port, `service` is `127.0.0.1:<port>`, `uid` the service's uid.
 *
 * 1. The client's line of /proc/net/tcp by the full tuple: exactly one line, with the service's uid; else the peer's 403
 *    (also when the table cannot be read).
 * 2. The holders of the line's inode, each walked by the rules of the scope's session: no holder gets the peer's 403
 *    (it names no pid: the lead's decision OP3); a holder that reaches no root that counts, or holders of two scopes,
 *    get the session's 403; then the line again, and a line that changed gets the session's 403.
 */
export function admitConnection(o: { reader: McpReader; snapshot: McpSnapshot; client: string; service: string; uid: number }): Admitted | Refusal {
  const line = clientLine(o.reader.tcp(), o.client, o.service);
  if (line === null || line.uid !== o.uid) return peer403(1);
  const holders = o.reader.holders(line.inode);
  if (holders.length === 0) return peer403(2);
  const walker = walkReader(o.reader);
  const refused: number[] = [], scopes = new Set<string>(), roots: Root[] = [], byCgroup: Root[] = [];
  for (const pid of holders) {
    // A holder is read at the scan: its start time then bounds the window of a reused pid (the stat form).
    const p = o.reader.proc(pid);
    const got = p === null ? null : o.snapshot.roots.scopeOf(walker, new Peer({ pid, uid: o.uid, pidfd: null, start: p.start }));
    if (got === null) { refused.push(pid); continue; }
    scopes.add(got.scope);
    if (!roots.some((r) => r.pid === got.root.pid && r.start === got.root.start)) roots.push(got.root);
    if (got.byCgroup && !byCgroup.some((r) => r.pid === got.root.pid && r.start === got.root.start)) byCgroup.push(got.root);
  }
  const lowest = Math.min(...holders);
  if (refused.length) return session403(2, Math.min(...refused));
  if (scopes.size !== 1) return session403(2, lowest);
  const again = clientLine(o.reader.tcp(), o.client, o.service);
  if (again === null || !sameLine(again, line)) return session403(2, lowest);
  return { scope: [...scopes][0], roots, byCgroup, pid: lowest, admission: "local" };
}

/** A request as the admission reads it: the method, the raw request target, and the raw header lines (name, value, ...). */
export type McpRequest = { readonly method?: string; readonly url: string; readonly rawHeaders: readonly string[] };

/**
 * What step 8 reads of the service: `controlOff` (C12's config `control` is false), `notReady` (the endpoint's 503 text
 * of step 4 before the upgrade, or null), and `sites`: the number of sites of the scope's list, or null when the scope
 * has no list (step 5 or 7 before the upgrade).
 */
export type McpReadiness = { readonly controlOff: boolean; readonly notReady: string | null; readonly sites: number | null };

/** The values of the raw header lines named `name` (any case), as the client sent them, without their leading and trailing whitespace (the parser's). */
export function rawValues(rawHeaders: readonly string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) if (rawHeaders[i].toLowerCase() === name) out.push(rawHeaders[i + 1]);
  return out;
}

/** The raw path of a request target: every character before its first `?`, with no normalization (the lead's decision OP5). */
export const rawPath = (target: string) => { const q = target.indexOf("?"); return q < 0 ? target : target.slice(0, q); };

/**
 * The token of a request (C11, step 7): exactly one Authorization header line, whose value is `Bearer` (any case), one
 * space and one character or more; the token is every character after that one space. Else null.
 */
export function bearerOf(rawHeaders: readonly string[]): string | null {
  const auth = rawValues(rawHeaders, "authorization");
  if (auth.length !== 1 || auth[0].length < 8 || auth[0].slice(0, 7).toLowerCase() !== "bearer ") return null;
  return auth[0].slice(7);
}

/** The SHA-256 of a token's bytes: Node's parser gives a header value as latin1, so these are the bytes that the client sent. */
export const tokenDigest = (token: string) => createHash("sha256").update(Buffer.from(token, "latin1")).digest();

/**
 * Steps 3 to 8 for one request of an admitted connection (C11), or null when it passes:
 * 3. an Origin header: its 403; 4. not exactly one Host header of `127.0.0.1:<port>` or `localhost:<port>`: the Host's
 * 403; 5. a raw path other than `/mcp` or `/mcp/<scope>` with a scope of the pattern: the 404; 6. a path's scope other
 * than the connection's: the session's 403; 7. the token: no `Authorization: Bearer <token>` header, a session whose
 * mcp_token is null, a token whose digest is not the session's (constant time, two 32-byte digests): the 401s;
 * 8. control off, not ready, a scope with no list or with a list that has no site (the lead's decision OP2): the 503s.
 */
export function admitRequest(o: { req: McpRequest; conn: Admitted; snapshot: McpSnapshot; port: number; readiness: (scope: string) => McpReadiness; compare?: (a: Buffer, b: Buffer) => boolean }): Refusal | null {
  const raw = o.req.rawHeaders;
  if (rawValues(raw, "origin").length) return { step: 3, status: 403, body: FROM_PAGE };
  const host = rawValues(raw, "host");
  if (host.length !== 1 || (host[0] !== `127.0.0.1:${o.port}` && host[0] !== `localhost:${o.port}`)) return { step: 4, status: 403, body: MCP_TEXT.badHost };
  const m = /^\/mcp(?:\/([^/]*))?$/.exec(rawPath(o.req.url));
  if (!m || (m[1] !== undefined && !SCOPE.test(m[1]))) return { step: 5, status: 404, body: MCP_TEXT.notFound };
  if (m[1] !== undefined && m[1] !== o.conn.scope) return session403(6, o.conn.pid);
  const bearer = bearerOf(raw);
  if (bearer === null) return { step: 7, status: 401, body: MCP_TEXT.needsToken };
  const item = o.snapshot.items.get(o.conn.scope);
  // The close at a change ends each connection of a session that a snapshot drops, so an admitted one has its item.
  if (item === undefined) return session403(7, o.conn.pid);
  if (item.mcp_token === null) return { step: 7, status: 401, body: MCP_TEXT.noToken };
  if (!(o.compare ?? timingSafeEqual)(tokenDigest(bearer), Buffer.from(item.mcp_token, "hex"))) return { step: 7, status: 401, body: MCP_TEXT.unknownToken };
  const r = o.readiness(o.conn.scope);
  if (r.controlOff) return { step: 8, status: 503, body: MCP_TEXT.controlOff };
  if (r.notReady !== null) return { step: 8, status: 503, body: r.notReady };
  if (r.sites === null || r.sites === 0) return { step: 8, status: 503, body: NOT_READY.noList };
  return null;
}
