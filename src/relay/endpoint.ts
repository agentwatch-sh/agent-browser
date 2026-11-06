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
import { Bridge, MAX_REQUEST } from "./bridge.ts";
import { Model, NOT_READY } from "./model.ts";
import { PEER_UNREAD, PeerGate, sessionRefusal, startPeerCheck } from "./peer.ts";
import { SCOPE, type Root } from "./scopes.ts";

export { SCOPE };
export const NOT_FOUND = "Not found. Connect a CDP client to /devtools/browser/<scope>.";
export const FROM_PAGE = "A web page cannot connect to the agent browser.";

/**
 * `windowPerPage`: one window per page (the model's default: Linux only). `peerCheck`: true runs the peer check with
 * its self-test (--peer-check); the tests give a gate of their own, with a fake reader.
 */
export type RelayOptions = { socket: string; input: Readable; output: Writable; log: (line: string) => void; maxRequest?: number; downloadWaitMs?: number; windowPerPage?: boolean; peerCheck?: boolean | PeerGate };
export type Relay = { model: Model; closed: Promise<void>; stop: () => Promise<void>; peer: PeerGate | null };

/**
 * The answer to a request that gets no connection, or the request's scope (and with the peer check the root that
 * admits it), in C11's order of the checks: (1) the Origin's 403; (2) the 404; (3) with the peer check, the 503 of a
 * failed self-test, else the peer's 403 of a peer that the relay could not read at the accept; (4) the "not ready"
 * 503s; with the peer check (5) the no-list 503 of a scope that the last line does not name, (6) the session check's
 * 403, (7) the no-list 503 of a named scope with no list; without it, the no-list 503 of a scope that the last line
 * gives no list. A browser's WebSocket always carries an Origin header.
 */
function admit(req: IncomingMessage, model: Model, gate: PeerGate | null): { scope: string; root: Root | null } | [number, string] {
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
  const bridge = new Bridge((line) => { o.output.write(`${line}\n`); }, { maxRequest: o.maxRequest });
  const model = new Model(bridge, o.log, { downloadWaitMs: o.downloadWaitMs, windowPerPage: o.windowPerPage, peerCheck: gate !== null,
    onRoots: (roots) => gate?.setRoots(roots) });
  const maxPayload = o.maxRequest ?? MAX_REQUEST;

  const http = createServer((req, res) => {
    // Only the WebSocket upgrade gets a connection.
    const a = admit(req, model, gate);
    const [status, body] = Array.isArray(a) ? a : [404, NOT_FOUND];
    res.writeHead(status, { "Content-Type": "text/plain" }).end(body);
  });
  // A longer client message closes its connection with 1009.
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload });
  // The peer read, at each accept, before the relay reads the request (C11, step 3).
  if (gate) http.on("connection", (socket) => gate.accept(socket));
  http.on("upgrade", (req, socket, head) => {
    const a = admit(req, model, gate);
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
