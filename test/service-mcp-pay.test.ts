// The payment tools browser_pay and browser_pay_status in stage 1d's transport, served only while the service has the
// payment act (contract C11, the card payment: the entry, the admission, the cancel; docs/contracts/mcp-allow-list.md;
// board ab-sta.7, the plan's Task 5b): the service starts it only with `--card-pay`, off by default. The payment here is
// a fake of PayRequests' two methods that records each call; the payment's own rules are test/pay-fill.test.ts's and
// test/pay-request.test.ts's. The MCP is the pinned @playwright/mcp in its worker (initialize and tools/list need no
// browser), so these tests start no Chrome. Every value here is a made-up TEST value; every folder is a temp folder.

import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { PAY_REMOTE_TEXT, readAllowList, SERVICE_TOOLS } from "../src/service/mcp/allow-list.ts";
import { MCP_FAILED } from "../src/service/mcp/port.ts";
import { McpTransport, type PayHost } from "../src/service/mcp/transport.ts";
import { PAY_TEXT } from "../src/service/pay/texts.ts";
import { until } from "./fake-bridge.ts";
import { tempDir } from "./temp-dirs.ts";

const LIST = readAllowList();
const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test-client", version: "0" } } };
const ARGS = { card: "travel", origin: "https://shop.example.com", amount: "51.00", currency: "USD", description: "Two test tickets" };
type Admission = "local" | "remote" | undefined;

/** A fake of the payment requests: each call (its arguments, caller and signal); `open` answers by the test's `answer`. */
function fakePay(answer: (caller: { signal?: AbortSignal }) => Promise<{ state: string; answer: string; isError: boolean }>) {
  const calls: { method: string; scope: string; admission?: string; args?: Record<string, unknown>; signal?: AbortSignal }[] = [];
  const host: PayHost = {
    open: async (input, caller) => { calls.push({ method: "open", scope: caller.scope, admission: caller.admission, args: input, signal: caller.signal }); return answer(caller); },
    status: (scope) => { calls.push({ method: "status", scope }); return JSON.stringify({ results: [{ state: "paid", text: "Paid: 51.00 USD to https://shop.example.com, order SHOP-1001", at: "2026-11-21T14:00:00Z", origin: "https://shop.example.com" }] }); },
  };
  return { calls, host };
}

type Front = { url: (scope: string) => string; server: Server; close: () => Promise<void> };
async function front(t: McpTransport, admission: () => Admission, gate?: () => Promise<boolean>): Promise<Front> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const scope = /^\/mcp\/([^/?]+)/.exec(req.url ?? "")?.[1] ?? "none";
    const a = admission();
    const p = a === undefined ? t.request(req, res, scope, gate) : (t.request as any)(req, res, scope, gate, a);
    void Promise.resolve(p).catch(() => { if (!res.headersSent) res.writeHead(500, { "Content-Length": Buffer.byteLength(MCP_FAILED) }).end(MCP_FAILED); });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { server, url: (scope) => `http://127.0.0.1:${port}/mcp/${scope}`, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}
type Reply = { status: number; sid: string | null; body: any; text: string };
async function post(url: string, body: unknown, sid?: string, signal?: AbortSignal): Promise<Reply> {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(sid ? { "Mcp-Session-Id": sid } : {}) }, body: JSON.stringify(body), signal: signal ?? AbortSignal.timeout(30_000) });
  const text = await r.text();
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : null; } catch {}
  return { status: r.status, sid: r.headers.get("mcp-session-id"), body: parsed, text };
}
async function init(url: string): Promise<string> {
  const r = await post(url, INIT);
  assert.equal(r.status, 200, r.text);
  await post(url, { jsonrpc: "2.0", method: "notifications/initialized" }, r.sid!);
  return r.sid!;
}
const call = (id: number, name: string, args?: unknown) => ({ jsonrpc: "2.0", id, method: "tools/call", params: args === undefined ? { name } : { name, arguments: args } });
const toolResult = (id: number, text: string, isError = false) => ({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) } });
const namesOf = (r: Reply) => (r.body?.result?.tools ?? []).map((x: any) => x.name);

type World = { t: McpTransport; h: Front; log: string[]; admission: { now: Admission }; gates: string[] };
async function withPay(pay: PayHost | null, f: (w: World) => Promise<void>): Promise<void> {
  const dir = tempDir("ab-mcp-pay-");
  const log: string[] = [];
  const t = new McpTransport({ list: LIST, stateFolder: join(dir, "state"), ticketUrl: () => null, log: (l) => log.push(l), pay: () => pay });
  const admission: { now: Admission } = { now: "local" };
  const gates: string[] = [];
  const h = await front(t, () => admission.now, async () => { gates.push("gate"); return true; });
  try { await f({ t, h, log, admission, gates }); } finally { await h.close(); await t.stop(); rmSync(dir, { recursive: true, force: true }); }
}

const PAID = { state: "paid", answer: "Paid: 51.00 USD to https://shop.example.com, order SHOP-1001\nYour tabs could not reach example.com from the copy of the checkout to the end of the payment.", isError: false };

test("with the payment act (--card-pay): a local admission gets browser_pay and browser_pay_status in tools/list, with the format's description and schema; a call passes the browser gate, counts as a use, and gets C11's text (a tool error for each state but paid); the status is the scope's compact JSON; a remote admission gets the payment's own refusal at once, which reaches no payment", { timeout: 60_000 }, async () => {
  const declined = { state: "declined", answer: `${PAY_TEXT.declined}\nYour tabs could not reach example.com from the copy of the checkout to the end of the payment.`, isError: true };
  const outcomes = [PAID, declined];
  const pay = fakePay(async () => outcomes.shift()!);
  await withPay(pay.host, async ({ t, h, log, admission, gates }) => {
    const sid = await init(h.url("web-1"));
    const list = await post(h.url("web-1"), { jsonrpc: "2.0", id: 2, method: "tools/list" }, sid);
    assert.deepEqual(namesOf(list).slice(-2), ["browser_pay", "browser_pay_status"], "the payment tools, after the list's tools");
    for (const n of ["browser_pay", "browser_pay_status"]) assert.deepEqual(list.body.result.tools.find((x: any) => x.name === n), { name: n, description: SERVICE_TOOLS[n].description, inputSchema: SERVICE_TOOLS[n].schema });
    assert.ok(!namesOf(list).includes("browser_sign_in"), "no sign-in tool without the sign-in act");
    const r1 = await post(h.url("web-1"), call(10, "browser_pay", ARGS), sid);
    assert.deepEqual(r1.body, toolResult(10, PAID.answer));
    const r2 = await post(h.url("web-1"), call(11, "browser_pay", { ...ARGS, button: "Pay $51.00" }), sid);
    assert.deepEqual(r2.body, toolResult(11, declined.answer, true));
    const r3 = await post(h.url("web-1"), call(12, "browser_pay_status", {}), sid);
    assert.deepEqual(JSON.parse(r3.body.result.content[0].text).results.map((x: any) => x.state), ["paid"]);
    assert.equal(r3.body.result.isError, undefined);
    assert.deepEqual(pay.calls.map((c) => [c.method, c.scope, c.admission ?? null]), [["open", "web-1", "local"], ["open", "web-1", "local"], ["status", "web-1", null]]);
    assert.deepEqual(pay.calls[0].args, ARGS, "the agent's keys, as they came");
    assert.ok(pay.calls[0].signal instanceof AbortSignal, "the call's cancel goes to the request");
    assert.equal(gates.length, 3, "each call passed the browser gate");
    assert.equal(t.activity().calls, 0);
    // A key that the tool does not name: the format's -32602, and no payment.
    const bad = await post(h.url("web-1"), call(13, "browser_pay", { ...ARGS, number: "not a card value" }), sid);
    assert.equal(bad.body.error.code, -32602);
    // A remote admission: the refusal at once, whatever the keys; no gate, no use, no call of the payment.
    const before = pay.calls.length, gatesBefore = gates.length;
    for (const a of ["remote", undefined] as Admission[]) {
      admission.now = a;
      const names = namesOf(await post(h.url("web-1"), { jsonrpc: "2.0", id: 20, method: "tools/list" }, sid));
      assert.ok(!names.includes("browser_pay") && !names.includes("browser_pay_status"), `${String(a)}: no payment tool listed`);
      for (const n of ["browser_pay", "browser_pay_status"]) {
        const r = await post(h.url("web-1"), call(21, n, { card: "travel", number: "not a card value" }), sid);
        assert.deepEqual(r.body, toolResult(21, PAY_REMOTE_TEXT, true), `${String(a)}: ${n}`);
      }
    }
    assert.equal(pay.calls.length, before, "no call reached the payment");
    assert.equal(gates.length, gatesBefore, "no browser gate");
    assert.ok(log.includes("mcp: MCP session 1 (scope web-1): a tools/call of browser_pay refused (a remote admission)"), log.join("\n"));
    assert.ok(!log.join("\n").includes("not a card value") && !log.join("\n").includes("Two test tickets"), "no argument in the log");
  });
});

test("a cancel of browser_pay before the operator's approval ends its request (the request gets the abort) and the call gets the cancelled answer; after the approval no cancel stops the act: the call gets the act's result; a client that closes ends a waiting request too; the call is a use until the payment's method ends", { timeout: 60_000 }, async () => {
  let phase: "waiting" | "approved" = "waiting";
  let finish!: () => void;
  const cancelled = { state: "stopped", answer: `Not paid: ${PAY_TEXT.cancelled}\nYour tabs could not reach example.com from the copy of the checkout to the end of the payment.`, isError: true };
  const pay = fakePay((caller) => new Promise((resolve) => {
    // As PayRequests does: before the approval the abort ends the request; after it the act runs to its end.
    caller.signal?.addEventListener("abort", () => { if (phase === "waiting") resolve(cancelled); }, { once: true });
    finish = () => resolve(PAID);
  }));
  await withPay(pay.host, async ({ t, h }) => {
    const sid = await init(h.url("web-1"));
    // Before the approval: the client's cancel.
    const first = post(h.url("web-1"), call(30, "browser_pay", ARGS), sid);
    await until(() => pay.calls.length === 1, "the request");
    assert.equal(t.activity().calls, 1, "a use while the request waits");
    assert.equal((await post(h.url("web-1"), { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 30, reason: "the test cancels it" } }, sid)).status, 202);
    const r1 = await first;
    assert.deepEqual(r1.body, { jsonrpc: "2.0", id: 30, error: { code: -32800, message: "Request cancelled: the client sent notifications/cancelled for this request." } });
    assert.equal(pay.calls[0].signal!.aborted, true, "the request got the abort");
    assert.equal(t.activity().calls, 0);
    // After the approval: the cancel does not stop the act, and the call gets its result.
    const second = post(h.url("web-1"), call(31, "browser_pay", ARGS), sid);
    await until(() => pay.calls.length === 2, "the second request");
    phase = "approved";
    assert.equal((await post(h.url("web-1"), { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 31, reason: "the test cancels it" } }, sid)).status, 202);
    assert.equal(t.activity().calls, 1, "the act runs on as a use");
    finish();
    assert.deepEqual((await second).body, toolResult(31, PAID.answer), "the act's result");
    // A client that closes while the request waits: the request ends (its abort), and the use ends with it.
    phase = "waiting";
    const ac = new AbortController();
    const third = post(h.url("web-1"), call(32, "browser_pay", ARGS), sid, ac.signal).then(() => "answered", () => "closed");
    await until(() => pay.calls.length === 3, "the third request");
    ac.abort();
    assert.equal(await third, "closed");
    await until(() => pay.calls[2].signal!.aborted, "the abort of the closed call's request");
    await until(() => t.activity().calls === 0, "the use ends with the request");
  });
});

test("without the payment act (no --card-pay): neither tool in tools/list, a local call gets -32601, a remote one the payment's refusal", { timeout: 60_000 }, async () => {
  await withPay(null, async ({ h, admission }) => {
    const sid = await init(h.url("web-1"));
    const names = namesOf(await post(h.url("web-1"), { jsonrpc: "2.0", id: 2, method: "tools/list" }, sid));
    assert.ok(!names.includes("browser_pay") && !names.includes("browser_pay_status"));
    const r = await post(h.url("web-1"), call(3, "browser_pay", ARGS), sid);
    assert.deepEqual(r.body, { jsonrpc: "2.0", id: 3, error: { code: -32601, message: "Not available in the agent browser: browser_pay" } });
    admission.now = "remote";
    assert.deepEqual((await post(h.url("web-1"), call(4, "browser_pay_status", {}), sid)).body, toolResult(4, PAY_REMOTE_TEXT, true));
  });
});
