// The remote MCP path on the agent door (stage 5 T4, board ab-v16.94.7.5; contract C11, "The remote MCP path (stage 5)";
// the plan docs/superpowers/plans/2026-11-16-stage-5-remote-scopes.md, A1, A2, Q1, Q2 and task T4). The carrier (the
// Mac's gateway, which the agent door identifies by its peer at each accept: the carrier rule of ../admission.ts) sends
// the requests of the sessions of other boxes on the agent door's Unix socket. One carrier connection carries the
// requests of many sessions, so the checks run at each request, in this order:
//
//   1. the method and the path: POST or DELETE to `/mcp/<box>/<session>` with a remote scope of the pattern goes on; a
//      request with another method (a GET, for example) of a remote scope of the last set_sessions gets the local
//      transport's 405 (the daemon lead's change: a 404 on a request with Mcp-Session-Id reads to a client as an expired
//      session); each other request gets the 404 of the MCP path;
//   2. no Origin header (the endpoint's 403), and exactly one Host header, `localhost` (this path's own Host 403: only
//      `localhost` passes here, and the MCP port's text names 127.0.0.1:<port> and localhost:<port>);
//   3. the scope is a remote item of the last set_sessions, and the SHA-256 of the bearer equals its mcp_token in
//      constant time: no bearer gets the first 401 of this path; an unknown scope or token gets the third 401;
//   4. the readiness: the 503s of step 8 (control off, not ready), with the start at a use of the MCP port.
//
// A request that passes goes to the transport with the admission word `remote`. A refusal closes the connection after
// its answer (`Connection: close`). This path keeps no flag for each connection (the MCP port has one): it checks each
// request on its own, so a request that the carrier pipelined on the same connection after a refused one still runs
// checks 1 to 4 and, when it passes, the transport, and its answer can be lost with the connection. It gets no right by
// that: each request needs its own token. A set_sessions that drops a remote item or changes its mcp_token ends that
// scope's MCP sessions, and the next request of the old token gets the third 401. The log rule of the MCP path holds: a
// line names a scope only when the path's scope is a remote item, and never a token, a fingerprint, a URL path or a
// header.

import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Req } from "../control.ts";
import { FROM_PAGE } from "../../relay/endpoint.ts";
import { NOT_READY } from "../../relay/model.ts";
import { REMOTE_SCOPE } from "../../relay/scopes.ts";
import { bearerOf, MCP_TEXT, rawPath, rawValues, tokenDigest, WWW_AUTHENTICATE, type McpReadiness, type McpRequest, type Refusal } from "./admission.ts";
import { MCP_FAILED, type McpHandler, type McpPortOptions } from "./port.ts";

/** The remote MCP path's own texts (C11): check 2's Host 403, and the first 401 (a request of the carrier with no bearer). */
export const REMOTE_TEXT = {
  /** Check 2's 403: a request with no Host, two Host lines or more, or a Host that is not `localhost`. */
  badHost: "The agent browser's remote MCP path admits only the Host localhost.",
  needsToken: "The agent browser of this box needs the session's remote connection token. agentwatch adds it to each session that it launches while its box has the browser grant.",
} as const;

/** The texts of step 8 for which a request waits for the service's start at a use (port.ts). */
const WAKES: ReadonlySet<string> = new Set([NOT_READY.link, NOT_READY.allowlist]);

/** The remote items of the last set_sessions as this path keeps them: each scope with its fingerprint (in memory only). */
export type RemoteItems = ReadonlyMap<string, string | null>;

/** Check 1's answer of a request with another method for a listed remote scope: the transport's own 405. */
export type NoStream = { readonly scope: string; readonly noStream: true };

/**
 * Checks 1 to 4 for one request of the carrier (C11, the remote MCP path), or the scope when it passes. A refusal has
 * its check's number as its `step`.
 */
export function admitRemote(o: { req: McpRequest; items: RemoteItems; readiness: (scope: string) => McpReadiness; compare?: (a: Buffer, b: Buffer) => boolean }): { scope: string } | NoStream | Refusal {
  const scope = remoteScopeOf(o.req.url);
  if (scope === null) return { step: 1, status: 404, body: MCP_TEXT.notFound };
  if (o.req.method !== "POST" && o.req.method !== "DELETE") return o.items.has(scope) ? { scope, noStream: true } : { step: 1, status: 404, body: MCP_TEXT.notFound };
  const raw = o.req.rawHeaders;
  if (rawValues(raw, "origin").length) return { step: 2, status: 403, body: FROM_PAGE };
  const host = rawValues(raw, "host");
  if (host.length !== 1 || host[0] !== "localhost") return { step: 2, status: 403, body: REMOTE_TEXT.badHost };
  const bearer = bearerOf(raw);
  if (bearer === null) return { step: 3, status: 401, body: REMOTE_TEXT.needsToken };
  const token = o.items.get(scope);
  // The shape step takes no remote item with a null token; an unknown scope gets the third 401, as an unknown token.
  if (typeof token !== "string" || !(o.compare ?? timingSafeEqual)(tokenDigest(bearer), Buffer.from(token, "hex"))) return { step: 3, status: 401, body: MCP_TEXT.unknownToken };
  const r = o.readiness(scope);
  if (r.controlOff) return { step: 4, status: 503, body: MCP_TEXT.controlOff };
  if (r.notReady !== null) return { step: 4, status: 503, body: r.notReady };
  return { scope };
}

export type RemoteMcpOptions = {
  /** The MCP path's transport (the MCP sessions, the allow list, the workers). */
  handler: McpHandler;
  /** What step 8 reads of the service, for the request's scope. */
  readiness: (scope: string) => McpReadiness;
  /** The service's start at a use (the MCP port's: port.ts, McpPortOptions.use). */
  use?: McpPortOptions["use"];
  log: (line: string) => void;
  /** Tests only: the compare of check 3. */
  compare?: (a: Buffer, b: Buffer) => boolean;
};

export class RemoteMcp {
  private readonly o: RemoteMcpOptions;
  private items = new Map<string, string | null>();
  private count = 0;

  constructor(o: RemoteMcpOptions) { this.o = o; }

  /** The remote scopes of the last set_sessions (the tests). */
  scopes(): string[] { return [...this.items.keys()]; }

  /**
   * C12's set_sessions (the snapshot that the service keeps, after its Mac rules): the remote items, then the end of the
   * MCP sessions of each remote scope that the snapshot drops or whose mcp_token changed.
   */
  setSessions(req: Req): void {
    const prev = this.items;
    this.items = new Map(((req.remote ?? []) as { scope: string; mcp_token?: string | null }[]).map((x) => [x.scope, x.mcp_token ?? null]));
    for (const [scope, token] of prev) {
      if (this.items.get(scope) === token && this.items.has(scope)) continue;
      this.o.log(`mcp: remote scope ${scope}: its MCP sessions end (${this.items.has(scope) ? "its token changed" : "the snapshot drops it"})`);
      this.o.handler.endSessions(scope);
    }
  }

  /**
   * One request of the carrier: checks 1 to 4, then the transport with the word `remote`. Each request is checked on
   * its own: no flag of its connection drops a request that follows a refusal on it (see the head of this file).
   */
  request(req: IncomingMessage, res: ServerResponse): void {
    const n = ++this.count;
    // The path's scope when it is a remote item of the last set_sessions (a log line names no other).
    const named = remoteScopeOf(req.url ?? "");
    const listed = named !== null && this.items.has(named) ? named : null;
    const fail = () => {
      if (!res.headersSent && !res.destroyed) res.writeHead(500, { "Content-Type": "text/plain", "Content-Length": Buffer.byteLength(MCP_FAILED), Connection: "close" }).end(MCP_FAILED);
      else req.socket.destroy();
      this.o.log(`mcp: carrier request ${n}${listed !== null ? ` (scope ${listed})` : ""}: a ${req.method} request failed (500)`);
    };
    const admit = () => admitRemote({ req, items: this.items, readiness: this.o.readiness, compare: this.o.compare });
    let r: ReturnType<typeof admit>;
    try { r = admit(); } catch { fail(); return; }
    if ("noStream" in r) { this.pass(req, res, r.scope, undefined, fail); return; }
    // The service's start at a use (as on the MCP port): while Chrome is down or its lists are not confirmed, a request
    // that the service's own snapshot does not refuse passes with no start; a tool call starts Chrome through its gate,
    // then checks 1 to 4 run again.
    const use = this.o.use;
    let browser: ((tool: string) => Promise<boolean>) | undefined;
    if ("status" in r && r.step === 4 && r.status === 503 && WAKES.has(r.body) && use && listed !== null) {
      const scope = listed;
      let why: string | null;
      try { why = use.refusal(scope); } catch { fail(); return; }
      if (why !== null) r = { step: 4, status: 503, body: why };
      else {
        r = { scope };
        browser = async (tool) => {
          let w: string | null;
          try { w = await use.wake(scope, tool); } catch { w = null; }
          if (req.socket.destroyed) return false;
          const again = w === null ? admit() : { step: 4, status: 503, body: w };
          if (!("status" in again)) return true;
          this.refuse(again, req, res, n, scope);
          return false;
        };
      }
    }
    if ("status" in r) { this.refuse(r, req, res, n, listed); return; }
    this.pass(req, res, r.scope, browser, fail);
  }

  private pass(req: IncomingMessage, res: ServerResponse, scope: string, browser: ((tool: string) => Promise<boolean>) | undefined, fail: () => void): void {
    try {
      const p = this.o.handler.request(req, res, scope, browser, "remote");
      if (p && typeof (p as Promise<void>).then === "function") (p as Promise<void>).catch(fail);
    } catch { fail(); }
  }

  /** A refusal of checks 1 to 4: its fixed text; the connection closes after it. `scope`: a remote item's scope, or null. */
  private refuse(r: Refusal, req: IncomingMessage, res: ServerResponse, n: number, scope: string | null): void {
    req.resume();
    if (!res.headersSent && !res.destroyed) {
      res.writeHead(r.status, { "Content-Type": "text/plain", "Content-Length": Buffer.byteLength(r.body), ...(r.status === 401 ? { "WWW-Authenticate": WWW_AUTHENTICATE } : {}), Connection: "close" }).end(r.body);
    }
    this.o.log(`mcp: carrier request ${n}${scope !== null ? ` (scope ${scope})` : ""}: a ${req.method} request refused at check ${r.step} (${r.status})`);
  }
}

/** The remote scope of a request target's raw path (`/mcp/<box>/<session>`), or null. */
function remoteScopeOf(target: string): string | null {
  const m = /^\/mcp\/([^/]*\/[^/]*)$/.exec(rawPath(target));
  return m && REMOTE_SCOPE.test(m[1]) ? m[1] : null;
}
