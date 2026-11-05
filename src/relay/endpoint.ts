// `agent-browser relay --socket <path>`: agent mode's CDP endpoint (contract C11 in chrome-extension's
// docs/protocol.md, the master). The agentwatch daemon starts it with the agent Chrome's unit. Its standard input
// and output carry the bridge (C10), one JSON object per line; its standard error is the log. Clients connect to
// ws+unix://<socket>:/devtools/browser/<scope>. When standard input ends, the relay closes every connection, removes
// its socket and ends. The CDP proxy (proxy.ts) stays the path of vedlo and marketdata-update.

import { createServer, STATUS_CODES, type IncomingMessage } from "node:http";
import { chmodSync, rmSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { WebSocketServer } from "ws";
import { socketAlive } from "../proxy.ts";
import { Bridge, MAX_REQUEST } from "./bridge.ts";
import { Model } from "./model.ts";
import { SCOPE } from "./scopes.ts";

export { SCOPE };
export const NOT_FOUND = "Not found. Connect a CDP client to /devtools/browser/<scope>.";
export const FROM_PAGE = "A web page cannot connect to the agent browser.";

/** `windowPerPage`: one window per page (the model's default: Linux only). */
export type RelayOptions = { socket: string; input: Readable; output: Writable; log: (line: string) => void; maxRequest?: number; downloadWaitMs?: number; windowPerPage?: boolean };
export type Relay = { model: Model; closed: Promise<void>; stop: () => Promise<void> };

/**
 * The answer to a request that gets no connection, or the request's scope, in C11's order of the checks (without the
 * peer check): the Origin's 403, the 404, the "not ready" 503s, then the 503 of a scope that the last allowlist line
 * gives no list. A browser's WebSocket always carries an Origin header.
 */
function admit(req: IncomingMessage, model: Model): { scope: string } | [number, string] {
  if (req.headers.origin !== undefined) return [403, FROM_PAGE];
  const m = /^\/devtools\/browser\/([^/]*)$/.exec(new URL(req.url ?? "/", "http://relay").pathname);
  if (req.method !== "GET" || !m || !SCOPE.test(m[1])) return [404, NOT_FOUND];
  const why = model.refuse(m[1]);
  return why ? [503, why] : { scope: m[1] };
}

export async function startRelay(o: RelayOptions): Promise<Relay> {
  if (Buffer.byteLength(o.socket) > 103) throw new Error(`the socket path is longer than 103 bytes: ${o.socket}`);
  if (await socketAlive(o.socket)) throw new Error(`a relay already serves ${o.socket}`);
  rmSync(o.socket, { force: true });
  const bridge = new Bridge((line) => { o.output.write(`${line}\n`); }, { maxRequest: o.maxRequest });
  const model = new Model(bridge, o.log, { downloadWaitMs: o.downloadWaitMs, windowPerPage: o.windowPerPage });
  const maxPayload = o.maxRequest ?? MAX_REQUEST;

  const http = createServer((req, res) => {
    // Only the WebSocket upgrade gets a connection.
    const a = admit(req, model);
    const [status, body] = Array.isArray(a) ? a : [404, NOT_FOUND];
    res.writeHead(status, { "Content-Type": "text/plain" }).end(body);
  });
  // A longer client message closes its connection with 1009.
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload });
  http.on("upgrade", (req, socket, head) => {
    const a = admit(req, model);
    if (Array.isArray(a)) {
      const [status, body] = a;
      socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const conn = model.open(a.scope, { send: (text) => { if (ws.readyState === ws.OPEN) ws.send(text); }, close: (code, reason) => ws.close(code, reason) });
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
  return { model, closed, stop };
}
