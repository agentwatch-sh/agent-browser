// `agent-browser relay --socket <path>`: agent mode's CDP endpoint (contract C11 in chrome-extension's
// docs/protocol.md, the master). The agentwatch daemon starts it with the agent Chrome's unit. Its standard input
// and output carry the bridge (C10), one JSON object per line; its standard error is the log. Clients connect to
// ws+unix://<socket>:/devtools/browser/<scope>. When standard input ends, the relay closes every connection, removes
// its socket and ends. The CDP proxy (proxy.ts) stays the path of vedlo and marketdata-update. With --peer-check
// (peer.ts; board ab-v16.51) the relay admits a connection only from a process of its scope's agentwatch session.

import { createServer, STATUS_CODES, type IncomingMessage } from "node:http";
import { chmodSync, rmSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { WebSocketServer } from "ws";
import { socketAlive } from "../proxy.ts";
import { Bridge, MAX_REQUEST, type BridgeRequest } from "./bridge.ts";
import { Model, NOT_READY } from "./model.ts";
import { PEER_UNREAD, PeerGate, sessionRefusal, startPeerCheck } from "./peer.ts";
import { SCOPE, type Root } from "./scopes.ts";
import { ticketOf } from "../service/mcp/ticket.ts";

export { SCOPE };
export const NOT_FOUND = "Not found. Connect a CDP client to /devtools/browser/<scope>.";
export const FROM_PAGE = "A web page cannot connect to the agent browser.";

/**
 * `windowPerPage`: one window per page (the model's default: Linux only). `peerCheck`: true runs the peer check with
 * its self-test (--peer-check); the tests give a gate of their own, with a fake reader.
 */
export type RelayOptions = { socket: string; input: Readable; output: Writable; log: (line: string) => void; maxRequest?: number; downloadWaitMs?: number; windowPerPage?: boolean; peerCheck?: boolean | PeerGate;
  /** The input stage's build switch (stage.ts): the tests' option; with none, the switch (off) or the live rows' variable. */
  stage?: boolean;
  /**
   * The service's in-process bridge (stage 1b part 2 of the self-contained agent browser, board ab-v16.94.9): with it the
   * relay's model sends its requests to `transport.send` and takes the answers and the daemon's lines from the handlers
   * that `transport.bind` gets, in place of the standard output and input lines; `input` and `output` are then unused.
   */
  transport?: RelayTransport;
  /**
   * The service's MCP tickets (stage 1d part 2b of the self-contained agent browser, board ab-v16.94.5): a connection
   * from the service's own pid (`pid`) is admitted only with a live one-time ticket of its scope in the query, in place
   * of the walk (C11, the MCP inside the service); a ticket from any other pid admits nothing.
   */
  tickets?: RelayTickets };
/** The ticket check of the service's MCP connections (src/service/mcp/ticket.ts). */
export type RelayTickets = { readonly pid: number; take(ticket: string, scope: string, peerPid: number): boolean };
/** The calls between the model and the service's carrier: the same messages as the stdio lines of C10, as objects. */
export type RelayTransport = {
  send(line: string, msg: BridgeRequest): void;
  bind(to: { answer(msg: { id?: unknown; ok?: unknown; data?: unknown; error?: unknown }): void; daemon(msg: unknown): void }): void;
};
export type Relay = { model: Model; closed: Promise<void>; stop: () => Promise<void>; peer: PeerGate | null };

/**
 * The answer to a request that gets no connection, or the request's scope (and with the peer check the root that
 * admits it), in C11's order of the checks: (1) the Origin's 403; (2) the 404; (3) with the peer check, the 503 of a
 * failed self-test, else the peer's 403 of a peer that the relay could not read at the accept; (4) the "not ready"
 * 503s; with the peer check (5) the no-list 503 of a scope that the last line does not name, (6) the session check's
 * 403, (7) the no-list 503 of a named scope with no list; without it, the no-list 503 of a scope that the last line
 * gives no list. A browser's WebSocket always carries an Origin header. With `tickets` (the service), a connection from
 * the service's own pid passes step 6 only with a live ticket of its scope (C11, the MCP inside the service), and no
 * root admits it; each ticket in a request is gone after this check.
 */
function admit(req: IncomingMessage, model: Model, gate: PeerGate | null, tickets?: RelayTickets): { scope: string; root: Root | null } | [number, string] {
  if (req.headers.origin !== undefined) return [403, FROM_PAGE];
  const m = /^\/devtools\/browser\/([^/]*)$/.exec(new URL(req.url ?? "/", "http://relay").pathname);
  if (req.method !== "GET" || !m || !SCOPE.test(m[1])) return [404, NOT_FOUND];
  const scope = m[1];
  if (!gate) {
    const why = model.refuse(scope);
    return why ? [503, why] : { scope, root: null };
  }
  if (gate.failed !== null) return [503, NOT_READY.cannotRead];
  const peer = gate.peerOf(req.socket);
  if (!peer) return [403, PEER_UNREAD];
  const why = model.notReady();
  if (why) return [503, why];
  if (!model.named(scope)) return [503, NOT_READY.noList];
  if (tickets) {
    const ticket = ticketOf(req.url ?? "");
    const ticketOk = ticket !== null && tickets.take(ticket, scope, peer.pid);
    if (peer.pid === tickets.pid) {
      if (!ticketOk) return [403, sessionRefusal(peer.pid)];
      return model.noList(scope) ? [503, NOT_READY.noList] : { scope, root: null };
    }
  }
  const root = gate.check(scope, peer);
  if (!root) return [403, sessionRefusal(peer.pid)];
  return model.noList(scope) ? [503, NOT_READY.noList] : { scope, root };
}

export async function startRelay(o: RelayOptions): Promise<Relay> {
  if (Buffer.byteLength(o.socket) > 103) throw new Error(`the socket path is longer than 103 bytes: ${o.socket}`);
  if (await socketAlive(o.socket)) throw new Error(`a relay already serves ${o.socket}`);
  rmSync(o.socket, { force: true });
  // The peer check's self-test runs before the endpoint socket listens (C11). A failed one fails closed: the relay
  // still serves, and each upgrade gets the 503 of step 3.
  const gate = o.peerCheck instanceof PeerGate ? o.peerCheck : o.peerCheck ? await startPeerCheck(o.socket, o.log) : null;
  const bridge = new Bridge(o.transport ? (line, msg) => o.transport!.send(line, msg) : (line) => { o.output.write(`${line}\n`); }, { maxRequest: o.maxRequest });
  const model = new Model(bridge, o.log, { downloadWaitMs: o.downloadWaitMs, windowPerPage: o.windowPerPage, peerCheck: gate !== null,
    onRoots: (roots) => gate?.setRoots(roots), ...(o.stage !== undefined ? { stage: o.stage } : {}) });
  const maxPayload = o.maxRequest ?? MAX_REQUEST;

  const http = createServer((req, res) => {
    // Only the WebSocket upgrade gets a connection.
    const a = admit(req, model, gate, o.tickets);
    const [status, body] = Array.isArray(a) ? a : [404, NOT_FOUND];
    res.writeHead(status, { "Content-Type": "text/plain" }).end(body);
  });
  // A longer client message closes its connection with 1009.
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload });
  // The peer read, at each accept, before the relay reads the request (C11, step 3).
  if (gate) http.on("connection", (socket) => gate.accept(socket));
  http.on("upgrade", (req, socket, head) => {
    const a = admit(req, model, gate, o.tickets);
    // The check runs once, at the upgrade: the peer's pidfd closes now, in every path.
    gate?.release(socket);
    if (Array.isArray(a)) {
      const [status, body] = a;
      socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const conn = model.open(a.scope, { send: (text) => { if (ws.readyState === ws.OPEN) ws.send(text); }, close: (code, reason) => ws.close(code, reason) }, a.root);
      ws.on("message", (data) => {
        let msg: unknown;
        try { msg = JSON.parse(String(data)); } catch { o.log(`relay: a message of ${String(data).length} bytes is not JSON`); return; }
        void model.onMessage(conn, msg);
      });
      // A message above MAX_REQUEST: ws closes the connection with 1009 and reports it here.
      ws.on("error", (e) => o.log(`relay: connection ${conn.id}: ${e.message}`));
      ws.on("close", () => { void model.close(conn); });
    });
  });

  // The socket is created private: no moment exists in which another user could connect to it.
  const umask = process.umask(0o077);
  try { await new Promise<void>((resolve, reject) => { http.once("error", reject); http.listen(o.socket, resolve); }); }
  finally { process.umask(umask); }
  chmodSync(o.socket, 0o600);
  const inode = statSync(o.socket).ino;

  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= (async () => {
    model.stop();
    await new Promise<void>((r) => { wss.close(() => r()); });
    http.closeAllConnections();
    await new Promise<void>((r) => http.close(() => r()));
    // Remove the socket only while it is still this relay's.
    if (statSync(o.socket, { throwIfNoEntry: false })?.ino === inode) rmSync(o.socket, { force: true });
    o.log("relay: stopped");
  })();

  if (o.transport) {
    // In the service: the carrier calls the model directly; the relay ends at its stop.
    o.transport.bind({ answer: (msg) => bridge.answer(msg), daemon: (msg) => { if (msg && typeof msg === "object") model.onDaemon(msg); } });
    o.log(`relay: ready on ${o.socket} (pid ${process.pid}; ${model.windowPerPage ? "one window per page" : "pages in tabs"}; the bridge in this process)`);
    let ended!: () => void;
    const closed = new Promise<void>((resolve) => { ended = resolve; });
    return { model, closed, stop: () => stop().then(() => ended()), peer: gate };
  }
  const lines = createInterface({ input: o.input, crlfDelay: Infinity });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    let msg: any;
    try { msg = JSON.parse(line); } catch { o.log(`relay: a line of ${line.length} bytes from the daemon is not JSON`); return; }
    if (msg?.t === "res") bridge.answer(msg);
    else if (msg && typeof msg === "object") model.onDaemon(msg);
  });
  const closed = new Promise<void>((resolve) => { lines.once("close", () => { void stop().then(resolve); }); });
  o.log(`relay: ready on ${o.socket} (pid ${process.pid}; ${model.windowPerPage ? "one window per page" : "pages in tabs"})`);
  return { model, closed, stop, peer: gate };
}
