// The fake gateway of the remote MCP path's live check (stage 5 T4, board ab-v16.94.7.5; C11, "The remote MCP path
// (stage 5)"; the plan's A1 and Q1): a small HTTP reverse proxy on 127.0.0.1 that sends each request on to the agent
// door's Unix socket, as the Mac's gateway does. It forwards the method, the path, Authorization, Mcp-Session-Id,
// Content-Type and the body's framing, and it sends Host: localhost; it gives back the status, Content-Type,
// Mcp-Session-Id, WWW-Authenticate and the body, streamed. Every other header stays out. Only the live harness
// (carrier.ts) starts it, as its own child process: no unit and no job. Its one line on standard output is its port.
//
// Usage: node fake-gateway.ts <agent door socket>

import { Agent, createServer, request } from "node:http";

const sock = process.argv[2];
if (!sock) { process.stderr.write("usage: node fake-gateway.ts <agent door socket>\n"); process.exit(2); }
/** One pool of connections to the agent door: one connection carries the requests of many sessions. */
const agent = new Agent({ keepAlive: true, maxSockets: 4 });
const FORWARD = ["authorization", "mcp-session-id", "content-type", "content-length", "transfer-encoding"];
const BACK = ["content-type", "mcp-session-id", "www-authenticate"];

const server = createServer((req, res) => {
  const headers: Record<string, string> = { host: "localhost" };
  for (const k of FORWARD) { const v = req.headers[k]; if (typeof v === "string") headers[k] = v; }
  const up = request({ socketPath: sock, method: req.method, path: req.url, headers, agent }, (r) => {
    const back: Record<string, string> = {};
    for (const k of BACK) { const v = r.headers[k]; if (typeof v === "string") back[k] = v; }
    res.writeHead(r.statusCode ?? 502, back);
    r.pipe(res);
  });
  up.on("error", () => { if (!res.headersSent) res.writeHead(502).end(); else res.destroy(); });
  req.pipe(up);
});
server.listen(0, "127.0.0.1", () => {
  const a = server.address();
  process.stdout.write(`${JSON.stringify({ port: a && typeof a === "object" ? a.port : null })}\n`);
});
process.on("SIGTERM", () => { server.close(); agent.destroy(); process.exit(0); });
