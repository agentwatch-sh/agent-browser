// A long call of the MCP path keeps its client (contract C11, the transport of the MCP path; board ab-sta.9). browser_pay
// waits up to 10 minutes for the operator's approval, PageFetch and the sign-in act can wait for the one private window,
// but a Node MCP client (the MCP SDK's Streamable HTTP client over fetch, that is undici) drops a request whose answer's
// header does not come within 300 s, or whose body pauses for 300 s. So a request that still waits after a short time
// gets its answer as an event stream, when its client accepts one: the header at once, a beat (an SSE comment, or
// `notifications/progress` for a request with a progressToken), and the JSON-RPC answer as the last event. A short call,
// and a client whose Accept has no `text/event-stream`, keep the one JSON answer.
//
// The client here is real: the MCP SDK's Client and StreamableHTTPClientTransport of the pinned playwright-core's bundle,
// over Node's own fetch with an undici Agent whose header and body limits are 2 s. The service's own tools are fakes that
// wait; the MCP is the pinned @playwright/mcp in its worker (initialize needs no browser), so no test starts Chrome. Every
// value here is a made-up TEST value; every folder is a temp folder.

import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readAllowList } from "../src/service/mcp/allow-list.ts";
import { MCP_FAILED } from "../src/service/mcp/port.ts";
import { McpTransport, type PageFetchHost, type PayHost } from "../src/service/mcp/transport.ts";
import { PAY_TEXT } from "../src/service/pay/texts.ts";
import { signedInText } from "../src/service/signins/act-rules.ts";
import type { SignInHost } from "../src/relay/model.ts";
import { until } from "./fake-bridge.ts";
import { tempDir } from "./temp-dirs.ts";

const sdk = createRequire(import.meta.url)(fileURLToPath(new URL("../node_modules/playwright-core/lib/utilsBundle.js", import.meta.url)));
const LIST = readAllowList();
const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test-client", version: "0" } } };
const ARGS = { card: "travel", origin: "https://shop.example.com", amount: "51.00", currency: "USD", description: "Two test tickets" };
const PAID = { state: "paid", answer: "Paid: 51.00 USD to https://shop.example.com, order SHOP-1001", isError: false };
const ORIGIN = "http://staging.test.localhost:8080";
const PAGE = "# A test page\n\nIts text.";
/** The test's limits of the stream (the first values are 30 s and 30 s): the switch after 200 ms, a beat each 300 ms. */
const STREAM = { streamAfterMs: 200, beatMs: 300 };
/** The beat's comment line (C11), and the Accept of the MCP SDK's client. */
const BEAT = "the request still waits";
const BOTH = "application/json, text/event-stream";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A fake of the service's own tools: each waits for its `gate` (the test's), and each call is recorded. */
function fakes() {
  const waits: { tool: string; signal?: AbortSignal; go: (v: unknown) => void; fail: (e: unknown) => void }[] = [];
  const wait = <T>(tool: string, signal?: AbortSignal) => new Promise<T>((go, fail) => { waits.push({ tool, signal, go: go as (v: unknown) => void, fail }); });
  const pay: PayHost = {
    open: (_input, caller) => wait<{ state: string; answer: string; isError: boolean }>("browser_pay", caller.signal).then((v) => v ?? PAID),
    status: () => JSON.stringify({ results: [] }),
  };
  const act: SignInHost = {
    signIn: () => wait<object>("browser_sign_in").then((v) => v ?? { signedIn: true, name: "staging", origin: ORIGIN }),
    signIns: () => ({ state: "open", signIns: [] }),
  };
  const page: PageFetchHost = { fetch: () => wait<string>("PageFetch").then((v) => v ?? PAGE) };
  return { waits, pay, act, page };
}

type Front = { url: (scope: string) => string; server: Server; close: () => Promise<void>; rejected: boolean[] };
/**
 * A plain HTTP server in front of the transport, as the port is: a local admission; the browser gate passes after
 * `gateMs`; a rejection of the request path gets the port's fixed 500, and `rejected` records for each rejection whether
 * the transport had ended its answer first (the last event of a stream: the port then closes the connection after it,
 * test/service-mcp-port.test.ts).
 */
async function front(t: McpTransport, gateMs = 0): Promise<Front> {
  const rejected: boolean[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const scope = /^\/mcp\/([^/?]+)/.exec(req.url ?? "")?.[1] ?? "none";
    const gate = async () => { if (gateMs > 0) await sleep(gateMs); return true; };
    void Promise.resolve(t.request(req, res, scope, gate, "local")).catch(() => {
      rejected.push(res.writableEnded);
      if (res.writableEnded) return;
      if (!res.headersSent) res.writeHead(500, { "Content-Length": Buffer.byteLength(MCP_FAILED) }).end(MCP_FAILED);
      else res.destroy();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { server, rejected, url: (scope) => `http://127.0.0.1:${port}/mcp/${scope}`, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

type World = { t: McpTransport; url: string; log: string[]; f: ReturnType<typeof fakes>; h: Front };
async function withWorld(f: (w: World) => Promise<void>, stream: Record<string, number> | null = STREAM, gateMs = 0): Promise<void> {
  const dir = tempDir("ab-mcp-long-");
  const log: string[] = [];
  const fk = fakes();
  const t = new McpTransport({ list: LIST, stateFolder: join(dir, "state"), ticketUrl: () => null, log: (l) => log.push(l), pay: () => fk.pay, act: () => fk.act, fetch: () => fk.page, ...(stream ?? {}) } as ConstructorParameters<typeof McpTransport>[0]);
  const h = await front(t, gateMs);
  try { await f({ t, url: h.url("web-1"), log, f: fk, h }); } finally { await h.close(); await t.stop(); rmSync(dir, { recursive: true, force: true }); }
}

const post = (url: string, body: unknown, o: { sid?: string; accept?: string | null; signal?: AbortSignal } = {}) =>
  fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...(o.accept === null ? {} : { Accept: o.accept ?? BOTH }), ...(o.sid ? { "Mcp-Session-Id": o.sid } : {}) }, body: JSON.stringify(body), signal: o.signal ?? AbortSignal.timeout(30_000) });
async function init(url: string): Promise<string> {
  const r = await post(url, INIT);
  assert.equal(r.status, 200, await r.clone().text());
  const sid = r.headers.get("mcp-session-id")!;
  await r.text();
  await (await post(url, { jsonrpc: "2.0", method: "notifications/initialized" }, { sid })).text();
  return sid;
}
const call = (id: number, name: string, args: unknown, meta?: Record<string, unknown>) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args, ...(meta ? { _meta: meta } : {}) } });
const toolResult = (id: number, text: string, isError = false) => ({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) } });
// A POST through node:http with no Accept header at all (fetch adds `Accept: */*`): its status, the Accept that went,
// its type and its body.
function noAccept(url: string, body: unknown, sid: string): Promise<{ status: number; accept: string | undefined; type: string | undefined; body: string }> {
  const text = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const r = httpRequest(url, { method: "POST", agent: false, headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text), "Mcp-Session-Id": sid } }, (res) => {
      let got = "";
      res.setEncoding("utf8");
      res.on("data", (d: string) => { got += d; });
      res.on("end", () => resolve({ status: res.statusCode!, accept: r.getHeader("accept") as string | undefined, type: res.headers["content-type"], body: got }));
    });
    r.on("error", reject);
    r.end(text);
  });
}
/** A promise within `ms`, else an error that names what did not come. */
const within = <T>(p: Promise<T>, ms: number, what: string): Promise<T> => Promise.race([p, sleep(ms).then((): never => { throw new Error(`${what} did not come within ${ms} ms`); })]);

/** The frames of an event stream, each ended by a blank line: a comment's text, or an event's fields (SSE). */
function frames(text: string): Record<string, string>[] {
  assert.ok(text.endsWith("\n\n"), `the stream ends after a whole frame: ${JSON.stringify(text.slice(-40))}`);
  return text.slice(0, -2).split("\n\n").map((f) => {
    const out: Record<string, string> = {};
    for (const line of f.split("\n")) {
      if (line.startsWith(":")) { out.comment = line.slice(1).replace(/^ /, ""); continue; }
      const i = line.indexOf(":");
      const k = i < 0 ? line : line.slice(0, i), v = i < 0 ? "" : line.slice(i + 1).replace(/^ /, "");
      out[k] = out[k] === undefined ? v : `${out[k]}\n${v}`;
    }
    return out;
  });
}

/** Node's own undici Agent (the dispatcher of its fetch), with these header and body limits (undici's defaults: 300 s). */
async function shortAgent(url: string, ms: number): Promise<{ fetch: typeof fetch; close: () => Promise<void> }> {
  await (await fetch(url, { method: "GET" })).text(); // the first fetch makes Node's global dispatcher
  const g = globalThis as Record<symbol, { constructor: new (o: object) => { close(): Promise<void> } } | undefined>;
  const Agent = (g[Symbol.for("undici.globalDispatcher.2")] ?? g[Symbol.for("undici.globalDispatcher.1")])?.constructor;
  // Node exports no undici Agent of its own fetch (no public module): the class of its global dispatcher is that Agent.
  assert.ok(Agent, "the class of Node's global fetch dispatcher (undici's Agent, under Symbol.for('undici.globalDispatcher.2') or '.1') is there");
  const agent = new Agent({ headersTimeout: ms, bodyTimeout: ms });
  return { fetch: ((u: string | URL | Request, i?: RequestInit) => fetch(u, { ...i, dispatcher: agent } as RequestInit)) as typeof fetch, close: () => agent.close() };
}

test("board ab-sta.9: a real MCP client whose undici header and body limits are 2 s gets the result of browser_pay, browser_sign_in and PageFetch calls that wait 4 s (the answer comes as an event stream: its header at once, a beat each 300 ms); with a progressToken and the SDK's resetTimeoutOnProgress, its own 1.5 s limit holds too", { timeout: 60_000 }, async () => {
  await withWorld(async ({ url, f, t }) => {
    const short = await shortAgent(url, 2_000);
    const client = new sdk.Client({ name: "test-client", version: "0" });
    const errors: string[] = [];
    client.onerror = (e: Error) => errors.push(String(e));
    await client.connect(new sdk.StreamableHTTPClientTransport(new URL(url), { fetch: short.fetch }));
    try {
      const calls = Promise.all([
        client.callTool({ name: "browser_pay", arguments: ARGS }, undefined, { timeout: 30_000 }),
        client.callTool({ name: "browser_sign_in", arguments: { name: "staging" } }, undefined, { timeout: 30_000 }),
        client.callTool({ name: "PageFetch", arguments: { url: "https://docs.example.com/a" } }, undefined, { timeout: 30_000 }),
      ]);
      await until(() => f.waits.length === 3, "the three calls", 10_000);
      assert.equal(t.activity().calls, 3, "three calls that wait");
      await sleep(4_000);
      for (const w of f.waits) w.go(undefined);
      const [pay, signIn, page] = await calls;
      assert.deepEqual(pay, { content: [{ type: "text", text: PAID.answer }] }, "browser_pay's result");
      assert.deepEqual(signIn, { content: [{ type: "text", text: signedInText(ORIGIN) }] }, "browser_sign_in's result");
      assert.deepEqual(page, { content: [{ type: "text", text: PAGE }] }, "PageFetch's result");
      // The SDK's own request limit (1.5 s here, 60 s by default) with resetTimeoutOnProgress: each beat of a request with a
      // progressToken is a notifications/progress, which resets it.
      const progress: { progress: number }[] = [];
      const late = client.callTool({ name: "browser_pay", arguments: ARGS }, undefined, { timeout: 1_500, resetTimeoutOnProgress: true, onprogress: (p: { progress: number }) => progress.push(p) });
      await until(() => f.waits.length === 4, "the fourth call", 10_000);
      await sleep(3_000);
      f.waits[3].go(undefined);
      assert.deepEqual(await late, { content: [{ type: "text", text: PAID.answer }] });
      assert.ok(progress.length >= 5, `a progress at the switch and at each beat: ${progress.length}`);
      assert.deepEqual(progress.map((p) => p.progress), progress.map((_, i) => i + 1), "the progress counts 1, 2, 3 and on");
      assert.deepEqual(errors, [], "the client saw no error");
    } finally { await client.close(); await short.close(); }
  });
});

test("board ab-sta.9: the stream on the wire: HTTP 200 text/event-stream at the switch, before the answer; a comment beat, or for a request with a progressToken the event of notifications/progress with that token; the JSON-RPC answer is the last event (event: message, one data line); no event has an id; then the stream ends", { timeout: 60_000 }, async () => {
  await withWorld(async ({ url, f }) => {
    const sid = await init(url);
    for (const [id, meta] of [[10, undefined], [11, { progressToken: "pt-7" }], [12, { progressToken: 0 }]] as const) {
      const n = f.waits.length;
      const started = performance.now();
      const r = await within(post(url, call(id, "browser_pay", ARGS, meta), { sid }), 3_000, `${id}: the answer's header before the answer`);
      assert.ok(performance.now() - started >= STREAM.streamAfterMs - 20, `${id}: no stream before the switch`);
      assert.equal(f.waits.length, n + 1, `${id}: the call still waits`);
      assert.deepEqual([r.status, r.headers.get("content-type"), r.headers.get("content-length"), r.headers.get("cache-control")], [200, "text/event-stream", null, "no-cache"], `${id}: the stream's header`);
      await sleep(1_000);
      f.waits[n].go(undefined);
      const fs = frames(await within(r.text(), 3_000, `${id}: the end of the stream`));
      const last = fs.at(-1)!, beats = fs.slice(0, -1);
      assert.deepEqual([last.event, JSON.parse(last.data)], ["message", toolResult(id, PAID.answer)], `${id}: the answer is the last event`);
      assert.ok(!last.data.includes("\n"), `${id}: one data line`);
      assert.ok(beats.length >= 3, `${id}: a beat at the switch and each 300 ms: ${beats.length}`);
      if (meta === undefined) for (const b of beats) assert.deepEqual(b, { comment: BEAT }, `${id}: the comment beat`);
      else beats.forEach((b, i) => assert.deepEqual([b.event, JSON.parse(b.data)], ["message", { jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: meta.progressToken, progress: i + 1 } }], `${id}: the progress beat ${i + 1}`));
      assert.ok(fs.every((x) => !("id" in x) && !("retry" in x)), `${id}: no event id, no retry (the client does not resume a stream)`);
    }
    // The connection stays good: the next request on it gets its answer.
    const ping = await post(url, { jsonrpc: "2.0", id: 13, method: "ping" }, { sid });
    assert.deepEqual([ping.headers.get("content-type"), await ping.json()], ["application/json", { jsonrpc: "2.0", id: 13, result: {} }]);
  });
});

test("board ab-sta.9: the old answer stays: a short call gets one application/json answer with its length; a long call whose Accept has no text/event-stream (*/*, application/json alone, text/event-stream with q=0, or no Accept header at all) waits for its one JSON answer; with the first values (30 s), a call of 1 s is short", { timeout: 60_000 }, async () => {
  await withWorld(async ({ url, f }) => {
    const sid = await init(url);
    const short = post(url, call(20, "browser_pay", ARGS), { sid });
    await until(() => f.waits.length === 1, "the short call");
    f.waits[0].go(undefined);
    const r = await short;
    const text = await r.text();
    assert.deepEqual([r.status, r.headers.get("content-type"), r.headers.get("content-length"), JSON.parse(text)], [200, "application/json", String(Buffer.byteLength(text)), toolResult(20, PAID.answer)]);
    for (const [id, accept] of [[21, "*/*"], [22, "application/json"], [23, "application/json, text/event-stream;q=0"], [24, "application/json, text/event-stream ; q=0.000"]] as const) {
      const n = f.waits.length;
      const p = post(url, call(id, "PageFetch", { url: "https://docs.example.com/a" }), { sid, accept });
      await until(() => f.waits.length === n + 1, `${id}: the call`);
      const early = await Promise.race([p.then(() => "an answer"), sleep(800).then(() => "no answer yet")]);
      assert.equal(early, "no answer yet", `${id}: no stream for ${String(accept)}`);
      f.waits[n].go(undefined);
      const a = await p;
      assert.deepEqual([a.status, a.headers.get("content-type"), await a.json()], [200, "application/json", toolResult(id, PAGE)], `${id}: one JSON answer`);
    }
    // No Accept header at all (fetch would add `*/*`, so node:http sends this one): the one JSON answer too.
    const n = f.waits.length;
    const bare = noAccept(url, call(25, "PageFetch", { url: "https://docs.example.com/a" }), sid);
    await until(() => f.waits.length === n + 1, "25: the call");
    const early = await Promise.race([bare.then(() => "an answer"), sleep(800).then(() => "no answer yet")]);
    assert.equal(early, "no answer yet", "25: no stream with no Accept");
    f.waits[n].go(undefined);
    const b = await bare;
    assert.deepEqual([b.status, b.accept, b.type, JSON.parse(b.body)], [200, undefined, "application/json", toolResult(25, PAGE)], "25: one JSON answer");
  });
  // The first values: a call that answers within 1 s gets the JSON answer.
  await withWorld(async ({ url, f }) => {
    const sid = await init(url);
    const p = post(url, call(30, "browser_sign_in", { name: "staging" }), { sid });
    await until(() => f.waits.length === 1, "the call");
    await sleep(1_000);
    f.waits[0].go(undefined);
    const a = await p;
    assert.deepEqual([a.headers.get("content-type"), await a.json()], ["application/json", toolResult(30, signedInText(ORIGIN))]);
  }, null);
});

test("board ab-sta.9: in a stream the cancels and the ends stay: the client's notifications/cancelled of browser_pay before the approval ends its request, and the cancelled answer is the last event; a client that closes its stream ends the request too; an exception after the switch gives the JSON-RPC error -32603 with the 500's text as the last event", { timeout: 60_000 }, async () => {
  await withWorld(async ({ url, f, t, log, h }) => {
    const sid = await init(url);
    // The client's cancel: the request gets the abort, and the stream ends with the cancelled answer.
    const r1 = await within(post(url, call(40, "browser_pay", ARGS), { sid }), 3_000, "the stream's header");
    assert.equal(r1.headers.get("content-type"), "text/event-stream");
    const w1 = f.waits[0];
    w1.signal!.addEventListener("abort", () => w1.go({ state: "stopped", answer: `Not paid: ${PAY_TEXT.cancelled}`, isError: true }), { once: true });
    assert.equal((await post(url, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 40, reason: "the test cancels it" } }, { sid })).status, 202);
    const fs1 = frames(await within(r1.text(), 3_000, "the end of the cancelled stream"));
    assert.deepEqual(JSON.parse(fs1.at(-1)!.data), { jsonrpc: "2.0", id: 40, error: { code: -32800, message: "Request cancelled: the client sent notifications/cancelled for this request." } });
    assert.equal(w1.signal!.aborted, true, "the request got the abort");
    // A client that closes its stream: the request gets the abort, and the use ends.
    const ac = new AbortController();
    const r2 = await within(post(url, call(41, "browser_pay", ARGS), { sid, signal: ac.signal }), 3_000, "the second stream's header");
    assert.equal(r2.headers.get("content-type"), "text/event-stream");
    const w2 = f.waits[1];
    w2.signal!.addEventListener("abort", () => w2.go({ state: "stopped", answer: `Not paid: ${PAY_TEXT.cancelled}`, isError: true }), { once: true });
    ac.abort();
    await until(() => w2.signal!.aborted, "the abort of the closed stream's request");
    await until(() => t.activity().calls === 0, "the use ends with the request");
    // An exception of the service after the switch.
    const r3 = await within(post(url, call(42, "browser_pay", ARGS), { sid }), 3_000, "the third stream's header");
    assert.deepEqual([r3.status, r3.headers.get("content-type")], [200, "text/event-stream"]);
    await sleep(400);
    f.waits[2].fail(new Error("a test failure"));
    const fs3 = frames(await within(r3.text(), 3_000, "the end of the failed stream"));
    assert.deepEqual(JSON.parse(fs3.at(-1)!.data), { jsonrpc: "2.0", id: 42, error: { code: -32603, message: MCP_FAILED } });
    assert.ok(log.includes("mcp: MCP session 1 (scope web-1): a tools/call failed (in its stream)"), log.join("\n"));
    // Review-230 N2: after its last event the request path rejects, as before the switch, so the port marks the connection
    // and closes it after that event (as after the 500); the rejection comes only after the answer has ended.
    await until(() => h.rejected.length === 1, "the request path's rejection");
    assert.deepEqual(h.rejected, [true], "one rejection, after the last event");
    assert.ok(!log.join("\n").includes("a test failure"), "no error's message in the log");
  });
});

test("board ab-sta.9 (review-230 N3): the switch counts from the request's arrival: a tool call that spent part of the time in its browser gate switches when that time from its arrival ends; one that spent all of it there switches at once after the gate (switch: 1 s here)", { timeout: 60_000 }, async () => {
  for (const [gateMs, expected, below] of [[500, 1_000, 1_350], [1_500, 1_500, 1_900]] as const) {
    await withWorld(async ({ url, f }) => {
      const sid = await init(url);
      const started = performance.now();
      const r = await within(post(url, call(60, "browser_pay", ARGS), { sid }), 5_000, `gate ${gateMs} ms: the stream's header`);
      const took = performance.now() - started;
      assert.equal(r.headers.get("content-type"), "text/event-stream", `gate ${gateMs} ms`);
      assert.ok(took >= expected - 50 && took < below, `gate ${gateMs} ms: the header after ${Math.round(took)} ms, not about ${expected} ms from the arrival`);
      assert.equal(f.waits.length, 1, `gate ${gateMs} ms: the call waits`);
      f.waits[0].go(undefined);
      const fs = frames(await within(r.text(), 3_000, `gate ${gateMs} ms: the end of the stream`));
      assert.deepEqual(fs[0], { comment: BEAT }, `gate ${gateMs} ms: a beat at the switch`);
      assert.deepEqual(JSON.parse(fs.at(-1)!.data), toolResult(60, PAID.answer), `gate ${gateMs} ms: the answer is the last event`);
    }, { streamAfterMs: 1_000, beatMs: 10_000 }, gateMs);
  }
});
