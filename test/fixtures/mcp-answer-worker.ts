// A test worker for the limits of a remote admission (test/service-mcp-remote.test.ts; stage 5 T3, board
// ab-v16.94.7.4): it speaks the protocol of src/service/mcp/worker.ts with no Playwright and no browser. It answers
// initialize, ping and tools/list; a tools/call of browser_take_screenshot gets an image item of SHOT_BYTES bytes (an
// answer larger than the test's small limit), browser_snapshot gets the worker's folder (the MCP's outputDir: the folder
// that the transport gives the scope's worker), browser_wait_for gets no answer (a request that waits), and each other
// tool gets "ok". Only the tests start it.

import { parentPort, workerData } from "node:worker_threads";

export const SHOT_BYTES = 4096;
const port = parentPort!;
const folder = String((workerData as { folder?: string })?.folder ?? "");
port.on("message", (m: any) => {
  if (m.t === "open") { port.postMessage({ t: "opened", sid: m.sid }); return; }
  if (m.t === "close") { port.postMessage({ t: "closed", sid: m.sid }); return; }
  if (m.t !== "msg" || m.msg.id === undefined) return;
  // Each answer carries the service's number of its request back, as src/service/mcp/worker.ts does.
  const answer = (result: unknown) => port.postMessage({ t: "answer", sid: m.sid, msg: { jsonrpc: "2.0", id: m.msg.id, result }, n: m.n });
  const method = m.msg.method, tool = m.msg.params?.name;
  if (method === "initialize") answer({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "test answer worker", version: "0" } });
  else if (method === "ping") answer({});
  else if (method === "tools/list") answer({ tools: [] });
  else if (method === "tools/call" && tool === "browser_wait_for") return;
  else if (method === "tools/call" && tool === "browser_take_screenshot") answer({ content: [{ type: "image", mimeType: "image/png", data: Buffer.alloc(SHOT_BYTES, 7).toString("base64") }] });
  else if (method === "tools/call" && tool === "browser_snapshot") answer({ content: [{ type: "text", text: `folder ${folder}` }] });
  else if (method === "tools/call") answer({ content: [{ type: "text", text: "ok" }] });
});
