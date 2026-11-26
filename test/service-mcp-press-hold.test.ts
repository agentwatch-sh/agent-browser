// The service's own tool browser_press_hold in the MCP path's transport (board ab-t30.34; C11, the press and hold;
// docs/contracts/mcp-allow-list.md): it is input, so tools/list holds it for a local and a remote admission and for a
// blanket scope while the scope's model has the input stage (the transport's `hold`); its call checks its arguments
// (a snapshot ref, maxMs), passes the browser gate, is a use while it runs, and runs the model's pressHold with the MCP's
// own browser_hover of the ref as its hover. The model here is a fake of pressHold that records each call; the MCP is the
// pinned @playwright/mcp in its worker with no browser (its hover fails with no ticket), so these tests start no Chrome.

import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import type { HoldResult } from "../src/human/hold.ts";
import { HOLD_TOOL, readAllowList, SERVICE_TOOLS } from "../src/service/mcp/allow-list.ts";
import { MCP_FAILED } from "../src/service/mcp/port.ts";
import { McpTransport, type HoldHost } from "../src/service/mcp/transport.ts";
import { tempDir } from "./temp-dirs.ts";

const LIST = readAllowList();
const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test-client", version: "0" } } };
async function post(url: string, body: unknown, sid?: string) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(sid ? { "Mcp-Session-Id": sid } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
  const text = await r.text();
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : null; } catch {}
  return { status: r.status, sid: r.headers.get("mcp-session-id"), body: parsed, text };
}
const namesOf = (r: any) => (r.body?.result?.tools ?? []).map((x: any) => x.name);
const call = (id: number, args?: unknown) => ({ jsonrpc: "2.0", id, method: "tools/call", params: args === undefined ? { name: HOLD_TOOL } : { name: HOLD_TOOL, arguments: args } });
const toolError = (id: number, text: string) => ({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: true } });
const toolText = (id: number, text: string) => ({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });

type Fake = { calls: { scope: string; maxMs: number; hover?: { ok: boolean; why?: string } }[]; host: HoldHost };
/** A fake of the model's pressHold: `run` gives its result; with `hover` it runs the transport's hover first and keeps its outcome. */
function fakeHold(o: { hover?: boolean; result?: HoldResult; wait?: Promise<void> } = {}): Fake {
  const calls: Fake["calls"] = [];
  return {
    calls,
    host: {
      pressHold: async (scope, x, hover) => {
        const c: Fake["calls"][number] = { scope, maxMs: x.maxMs };
        calls.push(c);
        if (o.hover) { const h = await hover(); c.hover = h; if (!h.ok) return { ok: false, why: h.why }; }
        await o.wait;
        return o.result ?? { ok: true, end: "done", heldMs: 4321, moves: 9, maxMs: x.maxMs, pixels: "changing" };
      },
    },
  };
}

type World = { url: (scope: string) => string; open: (scope: string) => Promise<string>; gates: string[]; t: McpTransport; admission: { now: "local" | "remote" } };
async function world(hold: ((scope: string) => HoldHost | null) | undefined, f: (w: World) => Promise<void>): Promise<void> {
  const dir = tempDir("ab-mcp-hold-");
  const t = new McpTransport({ list: LIST, stateFolder: join(dir, "state"), ticketUrl: () => null, log: () => {}, ...(hold ? { hold } : {}), blanket: (scope) => scope === "bl" });
  const gates: string[] = [];
  const admission: { now: "local" | "remote" } = { now: "local" };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const scope = /^\/mcp\/([^/?]+)/.exec(req.url ?? "")?.[1] ?? "none";
    const gate = async () => { gates.push(scope); return true; };
    void Promise.resolve((t.request as any)(req, res, scope, gate, admission.now)).catch(() => { if (!res.headersSent) res.writeHead(500, { "Content-Length": Buffer.byteLength(MCP_FAILED) }).end(MCP_FAILED); });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp/`;
  const url = (scope: string) => base + scope;
  const open = async (scope: string) => {
    const r = await post(url(scope), INIT);
    assert.equal(r.status, 200, r.text);
    await post(url(scope), { jsonrpc: "2.0", method: "notifications/initialized" }, r.sid!);
    return r.sid!;
  };
  try { await f({ url, open, gates, t, admission }); } finally {
    await new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); });
    await t.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the tool's rule: the format's value in the list file, an input tool for every admission (HOLD_TOOL), and no tool of the pinned MCP", () => {
  assert.equal(HOLD_TOOL, "browser_press_hold");
  assert.deepEqual(LIST.service_tools?.[HOLD_TOOL], SERVICE_TOOLS[HOLD_TOOL]);
  assert.ok(!Object.hasOwn(LIST.tools, HOLD_TOOL) && !Object.hasOwn(LIST.refused, HOLD_TOOL));
  assert.ok(!/\b(stop|start|restart)/i.test(SERVICE_TOOLS[HOLD_TOOL].description), "a description that names no stop or start (I2)");
});

test("tools/list: browser_press_hold for a local and a remote admission and for a blanket scope while the scope's model has the input stage; with no model (or no stage) none", { timeout: 90_000 }, async () => {
  const fake = fakeHold();
  await world((scope) => (scope === "nostage" ? null : fake.host), async ({ url, open, admission }) => {
    const want = SERVICE_TOOLS[HOLD_TOOL];
    for (const [scope, a] of [["web-1", "local"], ["web-1", "remote"], ["bl", "local"]] as const) {
      admission.now = a;
      const sid = await open(scope);
      const r = await post(url(scope), { jsonrpc: "2.0", id: 2, method: "tools/list" }, sid);
      const names = namesOf(r);
      assert.equal(names.at(-1), HOLD_TOOL, `${scope} ${a}: the press and hold, after the others`);
      assert.deepEqual(r.body.result.tools.at(-1), { name: HOLD_TOOL, description: want.description, inputSchema: want.schema });
      // The other own tools stay out of a remote admission's and a blanket scope's list (they have no part here anyway).
      assert.ok(names.filter((n: string) => Object.hasOwn(SERVICE_TOOLS, n)).length === 1, `${scope} ${a}: no other own tool`);
    }
    admission.now = "local";
    const sid = await open("nostage");
    assert.ok(!namesOf(await post(url("nostage"), { jsonrpc: "2.0", id: 2, method: "tools/list" }, sid)).includes(HOLD_TOOL), "no model with the stage: no tool");
  });
  await world(undefined, async ({ url, open }) => {
    const sid = await open("web-1");
    assert.ok(!namesOf(await post(url("web-1"), { jsonrpc: "2.0", id: 2, method: "tools/list" }, sid)).includes(HOLD_TOOL), "a service with no hold: no tool");
    assert.deepEqual((await post(url("web-1"), call(3, { ref: "e1" }), sid)).body, { jsonrpc: "2.0", id: 3, error: { code: -32601, message: `Not available in the agent browser: ${HOLD_TOOL}` } }, "its call: the -32601");
  });
});

test("refusals before the hold: no ref, a ref that is no snapshot ref (a selector), an element that is no text, a maxMs out of bounds (tool errors, no hold); another key (-32602)", { timeout: 90_000 }, async () => {
  const fake = fakeHold();
  await world(() => fake.host, async ({ url, open }) => {
    const sid = await open("web-1");
    const noRef = "Not held: give ref, the element's reference from the page snapshot (for example e12, or f1e3 in a frame).";
    let id = 10;
    for (const args of [undefined, {}, { element: "the button" }, { ref: "#px-captcha" }, { ref: "button >> nth=0" }, { ref: 12 }, { ref: "e1 " }]) {
      const r = await post(url("web-1"), call(++id, args), sid);
      assert.deepEqual(r.body, toolError(id, noRef), JSON.stringify(args));
    }
    assert.deepEqual((await post(url("web-1"), call(++id, { ref: "e3", element: 5 }), sid)).body, toolError(id, "Not held: element must be a text."));
    for (const maxMs of [999, 20001, 1500.5, "5000"]) {
      const r = await post(url("web-1"), call(++id, { ref: "e3", maxMs }), sid);
      assert.deepEqual(r.body, toolError(id, "Not held: maxMs must be a whole number of ms from 1000 to 20000."), String(maxMs));
    }
    const r = await post(url("web-1"), call(++id, { ref: "e3", holdMs: 3000 }), sid);
    assert.deepEqual(r.body, { jsonrpc: "2.0", id, error: { code: -32602, message: `Not available in the agent browser: the argument holdMs of ${HOLD_TOOL}` } });
    assert.equal(fake.calls.length, 0, "no hold ran");
  });
});

test("a call runs the model's pressHold for the MCP session's scope with maxMs (15000 by default), after the browser gate, as a use while it runs; a remote admission and a blanket scope run it too", { timeout: 90_000 }, async () => {
  let open!: () => void;
  const wait = new Promise<void>((r) => { open = r; });
  const fake = fakeHold({ wait });
  await world(() => fake.host, async (w) => {
    const sid = await w.open("web-1");
    const p = post(w.url("web-1"), call(20, { ref: "e12", element: "Press and hold" }), sid);
    for (let i = 0; i < 200 && fake.calls.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(fake.calls, [{ scope: "web-1", maxMs: 15000 }]);
    assert.equal(w.t.activity().calls, 1, "a use while it runs");
    assert.deepEqual(w.gates, ["web-1"], "after the browser gate");
    open();
    assert.deepEqual((await p).body, toolText(20, "Done: the hold lasted 4321 ms; it ended when the element changed and then stayed the same."));
    assert.equal(w.t.activity().calls, 0);
    // A remote admission (a scope of another box's session gets the same rule) and a blanket scope.
    w.admission.now = "remote";
    const rs = await w.open("web-1");
    assert.deepEqual((await post(w.url("web-1"), call(21, { ref: "f1e3", maxMs: 3000 }), rs)).body, toolText(21, "Done: the hold lasted 4321 ms; it ended when the element changed and then stayed the same."));
    w.admission.now = "local";
    const bs = await w.open("bl");
    assert.equal((await post(w.url("bl"), call(22, { ref: "e2" }), bs)).body.result.isError, undefined, "a blanket scope runs it");
    assert.deepEqual(fake.calls.map((c) => [c.scope, c.maxMs]), [["web-1", 15000], ["web-1", 3000], ["bl", 15000]]);
  });
});

test("the answers: a time limit is no tool error; a hold with no press is the tool error Not held", { timeout: 90_000 }, async () => {
  const limit = fakeHold({ result: { ok: true, end: "limit", heldMs: 3000, moves: 7, maxMs: 3000, pixels: "still" } });
  await world(() => limit.host, async (w) => {
    const sid = await w.open("web-1");
    assert.deepEqual((await post(w.url("web-1"), call(30, { ref: "e1", maxMs: 3000 }), sid)).body, toolText(30, "Time limit: the hold lasted 3000 ms, the limit of 3000 ms; the element did not change."));
  });
  const none = fakeHold({ result: { ok: false, why: "another press and hold of this session runs; wait for its answer." } });
  await world(() => none.host, async (w) => {
    const sid = await w.open("web-1");
    assert.deepEqual((await post(w.url("web-1"), call(31, { ref: "e1" }), sid)).body, toolError(31, "Not held: another press and hold of this session runs; wait for its answer."));
  });
});

test("the hover: the transport sends the MCP session's worker the MCP's own browser_hover of the ref (as target), under an id of its own; the MCP's failure (no browser here) becomes the refusal, and the client's id stays its own", { timeout: 120_000 }, async () => {
  const fake = fakeHold({ hover: true });
  await world(() => fake.host, async (w) => {
    const sid = await w.open("web-1");
    const r = await post(w.url("web-1"), call(40, { ref: "e7", element: "Press and hold" }), sid);
    assert.equal(fake.calls.length, 1);
    const h = fake.calls[0].hover!;
    assert.equal(h.ok, false, "the MCP's hover fails with no browser");
    assert.match(h.why!, /^the hover of the element failed/, String(h.why));
    assert.equal(r.body.id, 40, "the client's id");
    assert.equal(r.body.result.isError, true);
    assert.match(r.body.result.content[0].text, /^Not held: the hover of the element failed/);
    // The session goes on: a ping with the client's next id.
    assert.deepEqual((await post(w.url("web-1"), { jsonrpc: "2.0", id: 41, method: "ping" }, sid)).body, { jsonrpc: "2.0", id: 41, result: {} });
  });
});
