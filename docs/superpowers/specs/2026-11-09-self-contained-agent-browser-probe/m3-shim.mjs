// Probe only (board ab-v16.93, M3): the stdio shim of a local MCP client. An MCP client (Claude Code, Codex) starts it
// as a stdio MCP server, so it is a child of the session and the service's peer check (SO_PEERCRED on its Unix socket)
// reads it. It holds no MCP logic: each JSON-RPC line on stdin goes as one HTTP POST to the service's Unix socket
// (Streamable HTTP, path /mcp/<scope>), and each JSON-RPC message of the answer (JSON or an SSE stream) goes out as one
// line on stdout. It keeps the Mcp-Session-Id of the service. It posts one line at a time (a build would allow several).
import { request } from "node:http";
import { createInterface } from "node:readline";

const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
const socketPath = arg("--socket"), path = arg("--path");
let session = null;
let chain = Promise.resolve();
const out = (m) => process.stdout.write(JSON.stringify(m) + "\n");

function post(line) {
  return new Promise((resolve) => {
    let id = null;
    try { id = JSON.parse(line).id ?? null; } catch { /* the service answers the parse error */ }
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    if (session) headers["mcp-session-id"] = session;
    const req = request({ socketPath, path, method: "POST", headers }, (res) => {
      if (res.headers["mcp-session-id"]) session = res.headers["mcp-session-id"];
      let body = "";
      res.setEncoding("utf8").on("data", (d) => (body += d));
      res.on("end", () => {
        if (res.statusCode === 202 || !body.trim()) return resolve();
        if (String(res.headers["content-type"]).startsWith("text/event-stream")) {
          for (const l of body.split("\n")) if (l.startsWith("data: ")) out(JSON.parse(l.slice(6)));
        } else if (res.statusCode >= 400 && id !== null && !body.trim().startsWith("{")) {
          out({ jsonrpc: "2.0", id, error: { code: -32000, message: `${res.statusCode}: ${body.trim()}` } });
        } else {
          const m = JSON.parse(body);
          for (const x of Array.isArray(m) ? m : [m]) out(x);
        }
        resolve();
      });
    });
    req.on("error", (e) => { if (id !== null) out({ jsonrpc: "2.0", id, error: { code: -32000, message: `the agent browser is not reachable: ${e.message}` } }); resolve(); });
    req.end(line);
  });
}

createInterface({ input: process.stdin }).on("line", (line) => { if (line.trim()) chain = chain.then(() => post(line)); });
process.stdin.on("end", () => chain.then(() => process.exit(0)));
