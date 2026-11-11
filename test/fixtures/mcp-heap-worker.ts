// A test worker for the MCP's memory bound and its log (test/service-mcp-server.test.ts): it speaks the protocol of
// src/service/mcp/worker.ts with no Playwright, answers initialize and ping, fills its heap at a tools/call, so that its
// heap limit (resourceLimits) ends it, and writes a canary to its output at each open. Only the tests start it.

import { parentPort, workerData } from "node:worker_threads";

const port = parentPort!;
const hold: unknown[] = [];
// The scope's name sets the open's behaviour: slow-open never answers it, oom-open fills the heap at it.
const folder = String((workerData as { folder?: string })?.folder ?? "");
port.on("message", (m: any) => {
  if (m.t === "open" && folder.includes("/slow-open/")) return;
  if (m.t === "open" && folder.includes("/oom-open/")) { for (;;) hold.push(new Array(1 << 16).fill(hold.length)); }
  if (m.t === "open") { port.postMessage({ t: "opened", sid: m.sid }); return; }
  if (m.t === "close") { port.postMessage({ t: "closed", sid: m.sid }); return; }
  if (m.t !== "msg" || m.msg.id === undefined) return;
  const answer = (result: unknown) => port.postMessage({ t: "answer", sid: m.sid, msg: { jsonrpc: "2.0", id: m.msg.id, result } });
  if (m.msg.method === "initialize") answer({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "test heap worker", version: "0" } });
  else if (m.msg.method === "ping") answer({});
  else if (m.msg.method === "tools/call") for (;;) hold.push(new Array(1 << 16).fill(hold.length));
});
// The log test: at each open the worker writes the canary of the token design's section 12 (a made-up test token) to its
// standard output and error, which the service reads and drops.
port.on("message", (m: any) => {
  // The environment test: the names of the worker's own environment.
  if (m.t === "env") { port.postMessage({ t: "env", keys: Object.keys(process.env) }); return; }
  if (m.t !== "open") return;
  console.log(`worker stdout: abt1_${"C".repeat(43)}`);
  console.error(`worker stderr: abt1_${"C".repeat(43)}`);
});
