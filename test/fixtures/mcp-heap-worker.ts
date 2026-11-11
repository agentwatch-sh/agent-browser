// A test worker for the MCP's memory bound (test/service-mcp-server.test.ts): it speaks the protocol of
// src/service/mcp/worker.ts with no Playwright, answers initialize and ping, and fills its heap at a tools/call, so that
// its heap limit (resourceLimits) ends it. Only the tests start it.

import { parentPort } from "node:worker_threads";

const port = parentPort!;
const hold: unknown[] = [];
port.on("message", (m: any) => {
  if (m.t === "open") { port.postMessage({ t: "opened", sid: m.sid }); return; }
  if (m.t === "close") { port.postMessage({ t: "closed", sid: m.sid }); return; }
  if (m.t !== "msg" || m.msg.id === undefined) return;
  const answer = (result: unknown) => port.postMessage({ t: "answer", sid: m.sid, msg: { jsonrpc: "2.0", id: m.msg.id, result } });
  if (m.msg.method === "initialize") answer({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "test heap worker", version: "0" } });
  else if (m.msg.method === "ping") answer({});
  else if (m.msg.method === "tools/call") for (;;) hold.push(new Array(1 << 16).fill(hold.length));
});
