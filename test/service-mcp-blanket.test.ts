// The MCP path of a blanket scope (board ab-4wh.3; C11, the blanket profile; docs/contracts/mcp-allow-list.md): its
// tools/list holds no tool of the allow list's service_tools, also with a local admission and a service that has each
// part, and a call of one gets its tool error at once, whatever its arguments: no use, no browser gate, no call of the
// act, of PageFetch or of the payments. Another scope keeps its own tools. The MCP is the pinned @playwright/mcp in its
// worker (initialize and tools/list need no browser), so these tests start no Chrome.

import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { readAllowList, SERVICE_TOOLS } from "../src/service/mcp/allow-list.ts";
import { MCP_FAILED } from "../src/service/mcp/port.ts";
import { BLANKET_TOOL_TEXT, McpTransport } from "../src/service/mcp/transport.ts";
import { tempDir } from "./temp-dirs.ts";

const LIST = readAllowList();
const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test-client", version: "0" } } };

async function post(url: string, body: unknown, sid?: string) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(sid ? { "Mcp-Session-Id": sid } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  const text = await r.text();
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : null; } catch {}
  return { status: r.status, sid: r.headers.get("mcp-session-id"), body: parsed, text };
}
const namesOf = (r: any) => (r.body?.result?.tools ?? []).map((x: any) => x.name);

test("a blanket scope's MCP: no service tool in tools/list; each service tool's call gets its blanket tool error with no use and no call of its part; another scope keeps its tools", { timeout: 90_000 }, async () => {
  const dir = tempDir("ab-mcp-blanket-");
  const calls: string[] = [];
  const act = { signIn: async () => { calls.push("signIn"); return { signedIn: true, name: "x", origin: "https://x.example" }; }, signIns: () => { calls.push("signIns"); return { state: "open", signIns: [] }; } };
  const pf = { fetch: async () => { calls.push("fetch"); return "URL: https://x.example/"; } };
  const pay = { open: async () => { calls.push("pay"); return { state: "paid", answer: "Paid", isError: false }; }, status: () => { calls.push("payStatus"); return "{}"; } };
  const t = new McpTransport({ list: LIST, stateFolder: join(dir, "state"), ticketUrl: () => null, log: () => {}, act: () => act as any, fetch: () => pf as any, pay: () => pay as any, blanket: (scope) => scope === "bl" });
  const gates: string[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const scope = /^\/mcp\/([^/?]+)/.exec(req.url ?? "")?.[1] ?? "none";
    const gate = async () => { gates.push(scope); return true; };
    void Promise.resolve((t.request as any)(req, res, scope, gate, "local")).catch(() => { if (!res.headersSent) res.writeHead(500, { "Content-Length": Buffer.byteLength(MCP_FAILED) }).end(MCP_FAILED); });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp/`;
  try {
    const open = async (scope: string) => {
      const r = await post(base + scope, INIT);
      assert.equal(r.status, 200, r.text);
      await post(base + scope, { jsonrpc: "2.0", method: "notifications/initialized" }, r.sid!);
      return r.sid!;
    };
    const bl = await open("bl"), web = await open("web-1");
    // The press and hold (board ab-t30.34) is input, which a blanket scope gets: test/service-mcp-press-hold.test.ts.
    const own = Object.keys(SERVICE_TOOLS).filter((n) => n !== "browser_press_hold");
    assert.deepEqual(own.sort(), ["PageFetch", "browser_pay", "browser_pay_status", "browser_sign_in", "browser_sign_ins"].sort());
    const blNames = namesOf(await post(base + "bl", { jsonrpc: "2.0", id: 2, method: "tools/list" }, bl));
    assert.deepEqual(blNames.sort(), Object.keys(LIST.tools).sort(), "the list's tools only");
    const webNames = namesOf(await post(base + "web-1", { jsonrpc: "2.0", id: 2, method: "tools/list" }, web));
    for (const n of own) assert.ok(webNames.includes(n), `web-1 keeps ${n}`);
    const want: Record<string, string> = { PageFetch: BLANKET_TOOL_TEXT.fetch, browser_sign_in: BLANKET_TOOL_TEXT.signIn, browser_sign_ins: BLANKET_TOOL_TEXT.signIn, browser_pay: BLANKET_TOOL_TEXT.pay, browser_pay_status: BLANKET_TOOL_TEXT.pay };
    let id = 10;
    for (const [name, text] of Object.entries(want)) {
      for (const args of [undefined, { url: "https://example.com/" }, { bad: 1 }]) {
        const r = await post(base + "bl", { jsonrpc: "2.0", id: ++id, method: "tools/call", params: args === undefined ? { name } : { name, arguments: args } }, bl);
        assert.deepEqual(r.body, { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: true } }, `${name} ${JSON.stringify(args)}`);
      }
    }
    assert.deepEqual(calls, [], "no part ran");
    assert.deepEqual(gates.filter((s) => s === "bl"), [], "no browser gate");
    assert.equal(t.activity().calls, 0);
    // The texts are C11's.
    assert.equal(BLANKET_TOOL_TEXT.fetch, "Not fetched (unavailable): PageFetch does not work for a session with a blanket approval; open the page in this session's browser instead.");
    assert.equal(BLANKET_TOOL_TEXT.signIn, "Not signed in: Stored sign-ins do not work for a session with a blanket approval.");
    assert.equal(BLANKET_TOOL_TEXT.pay, "Not paid: Payments do not work for a session with a blanket approval.");
  } finally {
    await new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); });
    await t.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ab-4wh.24: a tool call of the blanket scope is no use of the main Chrome: activity() counts the tool calls of every other scope, activity(\"blanket\") the blanket scope's", { timeout: 60_000 }, async () => {
  const dir = tempDir("ab-mcp-blanket-use-");
  // The test worker (no Playwright, no browser): its browser_wait_for gets no answer, so the call runs until its cancel.
  const t = new McpTransport({ list: LIST, stateFolder: join(dir, "state"), ticketUrl: () => null, log: () => {}, blanket: (scope) => scope === "bl", worker: { heapMb: 64, entry: new URL("./fixtures/mcp-answer-worker.ts", import.meta.url) } });
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const scope = /^\/mcp\/([^/?]+)/.exec(req.url ?? "")?.[1] ?? "none";
    void Promise.resolve((t.request as any)(req, res, scope, async () => true, "local")).catch(() => { if (!res.headersSent) res.writeHead(500, { "Content-Length": Buffer.byteLength(MCP_FAILED) }).end(MCP_FAILED); });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp/`;
  const until = async (ok: () => boolean, what: string) => { for (let i = 0; i < 500 && !ok(); i++) await new Promise((r) => setTimeout(r, 10)); assert.ok(ok(), what); };
  try {
    const open = async (scope: string) => {
      const r = await post(base + scope, INIT);
      assert.equal(r.status, 200, r.text);
      await post(base + scope, { jsonrpc: "2.0", method: "notifications/initialized" }, r.sid!);
      return r.sid!;
    };
    const bl = await open("bl"), web = await open("web-1");
    const wait = (scope: string, sid: string, id: number) => post(base + scope, { jsonrpc: "2.0", id, method: "tools/call", params: { name: "browser_wait_for", arguments: { time: 30 } } }, sid);
    const cancel = (scope: string, sid: string, id: number) => post(base + scope, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id } }, sid);
    // The blanket scope's call that runs: the blanket Chrome's use only.
    const a = wait("bl", bl, 5);
    await until(() => t.activity("blanket").calls === 1, "the blanket scope's call runs");
    assert.deepEqual(t.activity(), { calls: 0, quietFor: Infinity }, "no use of the main Chrome");
    // Another scope's call that runs: the main Chrome's use only.
    const b = wait("web-1", web, 6);
    await until(() => t.activity().calls === 1, "web-1's call runs");
    assert.ok(t.activity().quietFor < 5_000);
    assert.equal(t.activity("blanket").calls, 1);
    // Each call's end ends its use, and its quiet time starts.
    await cancel("bl", bl, 5);
    await until(() => t.activity("blanket").calls === 0, "the blanket scope's call ends");
    assert.ok(t.activity("blanket").quietFor < 5_000);
    assert.equal(t.activity().calls, 1, "web-1's call runs on");
    await cancel("web-1", web, 6);
    await until(() => t.activity().calls === 0, "web-1's call ends");
    assert.deepEqual([(await a).body?.error?.code, (await b).body?.error?.code], [-32800, -32800], "each call gets the cancelled answer");
  } finally {
    await new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); });
    await t.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
