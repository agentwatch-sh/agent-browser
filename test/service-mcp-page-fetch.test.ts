// The MCP tool PageFetch in stage 1d's transport (contract C11, "PageFetch"; docs/contracts/mcp-allow-list.md; board
// ab-v16.102): an own tool of the service, served while the service has PageFetch, for a local admission only. PageFetch
// here is a fake of its one method that records each call (its own rules are test/page-fetch.test.ts's). The MCP is the
// pinned @playwright/mcp in its worker (initialize and tools/list need no browser), so these tests start no Chrome.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAllowList, SERVICE_TOOLS } from "../src/service/mcp/allow-list.ts";
import { MCP_FAILED } from "../src/service/mcp/port.ts";
import { McpTransport } from "../src/service/mcp/transport.ts";
import { FetchRefusal } from "../src/service/fetch/page-fetch.ts";

const LIST = readAllowList();
const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test-client", version: "0" } } };
type Admission = "local" | "remote" | undefined;
type Call = { scope: string; admission: string; args: Record<string, unknown> };

function fakeFetch(o: { answer?: (args: Record<string, unknown>) => Promise<string> } = {}) {
  const calls: Call[] = [];
  return {
    calls,
    host: {
      fetch: async (c: { scope: string; admission: "local" | "remote" }, args: Record<string, unknown>) => {
        calls.push({ scope: c.scope, admission: c.admission, args });
        if (c.admission !== "local") throw new FetchRefusal("unavailable", "PageFetch works only for sessions of this box.");
        return o.answer ? o.answer(args) : "URL: https://pages.example.test/\nTitle: T\n\n# T";
      },
    },
  };
}
const fakeAct = () => ({ signIn: async () => ({ signedIn: true, name: "staging", origin: "http://staging.test.localhost" }), signIns: () => ({ state: "open", signIns: [] }) });

async function post(url: string, body: unknown, sid?: string) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(sid ? { "Mcp-Session-Id": sid } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  const text = await r.text();
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : null; } catch {}
  return { status: r.status, sid: r.headers.get("mcp-session-id"), body: parsed, text };
}
const call = (id: number, name: string, args?: unknown) => ({ jsonrpc: "2.0", id, method: "tools/call", params: args === undefined ? { name } : { name, arguments: args } });
const toolError = (id: number, text: string) => ({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: true } });
const toolText = (id: number, text: string) => ({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });
const namesOf = (r: any) => (r.body?.result?.tools ?? []).map((x: any) => x.name);

type World = { t: McpTransport; url: string; log: string[]; admission: { now: Admission }; gates: string[]; sid: string };
async function withFetch(o: { fetch?: ReturnType<typeof fakeFetch> | null; act?: boolean }, f: (w: World) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "ab-mcp-page-fetch-"));
  const log: string[] = [];
  const pf = o.fetch === undefined ? fakeFetch() : o.fetch;
  const t = new McpTransport({ list: LIST, stateFolder: join(dir, "state"), ticketUrl: () => null, log: (l) => log.push(l), act: () => (o.act ? (fakeAct() as any) : null), fetch: () => pf?.host ?? null });
  const admission: { now: Admission } = { now: "local" };
  const gates: string[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const scope = /^\/mcp\/([^/?]+)/.exec(req.url ?? "")?.[1] ?? "none";
    const a = admission.now;
    const gate = async () => { gates.push("gate"); return true; };
    const p = a === undefined ? t.request(req, res, scope, gate) : (t.request as any)(req, res, scope, gate, a);
    void Promise.resolve(p).catch(() => { if (!res.headersSent) res.writeHead(500, { "Content-Length": Buffer.byteLength(MCP_FAILED) }).end(MCP_FAILED); });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp/web-1`;
  try {
    const r = await post(url, INIT);
    assert.equal(r.status, 200, r.text);
    await post(url, { jsonrpc: "2.0", method: "notifications/initialized" }, r.sid!);
    await f({ t, url, log, admission, gates, sid: r.sid! });
  } finally {
    await new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); });
    await t.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("tools/list: PageFetch after the list's tools for a local admission while the service has PageFetch (with or without the act); a remote admission, no admission word and a service with no PageFetch get none", { timeout: 60_000 }, async () => {
  await withFetch({}, async ({ url, sid, admission }) => {
    const local = await post(url, { jsonrpc: "2.0", id: 2, method: "tools/list" }, sid);
    const names = namesOf(local);
    assert.deepEqual(names.slice(0, -1).sort(), Object.keys(LIST.tools).sort());
    assert.deepEqual(names.slice(-1), ["PageFetch"], "PageFetch with no act: no sign-in tool");
    const r = SERVICE_TOOLS.PageFetch;
    assert.deepEqual(local.body.result.tools.at(-1), { name: "PageFetch", description: r.description, inputSchema: r.schema });
    admission.now = "remote";
    assert.ok(!namesOf(await post(url, { jsonrpc: "2.0", id: 3, method: "tools/list" }, sid)).includes("PageFetch"));
    admission.now = undefined;
    assert.ok(!namesOf(await post(url, { jsonrpc: "2.0", id: 4, method: "tools/list" }, sid)).includes("PageFetch"));
  });
  await withFetch({ act: true }, async ({ url, sid }) => {
    assert.deepEqual(namesOf(await post(url, { jsonrpc: "2.0", id: 2, method: "tools/list" }, sid)).slice(-3), ["browser_sign_in", "browser_sign_ins", "PageFetch"]);
  });
  await withFetch({ fetch: null, act: true }, async ({ url, sid }) => {
    const names = namesOf(await post(url, { jsonrpc: "2.0", id: 2, method: "tools/list" }, sid));
    assert.deepEqual(names.slice(-2), ["browser_sign_in", "browser_sign_ins"]);
    assert.ok(!names.includes("PageFetch"));
  });
});

test("a local call passes the browser gate (the start at a use), runs PageFetch for the MCP session's scope with its arguments, counts as a use while it runs, and gives its text; a refusal is the tool error Not fetched (<code>): <sentence>", { timeout: 60_000 }, async () => {
  let open!: () => void;
  const hold = new Promise<void>((r) => (open = r));
  const pf = fakeFetch({ answer: async (args) => { if (args.url === "https://pages.example.test/slow") await hold; if (args.url === "https://pages.example.test/no") throw new FetchRefusal("blocked", "The page shows a check that needs a person's click (hCaptcha); PageFetch never clicks."); return "URL: x\n\nthe text"; } });
  await withFetch({ fetch: pf }, async ({ t, url, sid, gates, log }) => {
    const one = await post(url, call(10, "PageFetch", { url: "https://pages.example.test/", mode: "whole", offset: 5 }), sid);
    assert.deepEqual([one.status, one.body], [200, toolText(10, "URL: x\n\nthe text")]);
    assert.deepEqual(pf.calls[0], { scope: "web-1", admission: "local", args: { url: "https://pages.example.test/", mode: "whole", offset: 5 } });
    assert.deepEqual(gates, ["gate"]);
    const slow = post(url, call(11, "PageFetch", { url: "https://pages.example.test/slow" }), sid);
    for (let i = 0; i < 100 && t.activity().calls === 0; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(t.activity().calls, 1, "a use while it runs");
    open();
    assert.equal((await slow).status, 200);
    assert.equal(t.activity().calls, 0);
    const no = await post(url, call(12, "PageFetch", { url: "https://pages.example.test/no" }), sid);
    assert.deepEqual(no.body, toolError(12, "Not fetched (blocked): The page shows a check that needs a person's click (hCaptcha); PageFetch never clicks."));
    const key = await post(url, call(13, "PageFetch", { url: "https://pages.example.test/", headers: {} }), sid);
    assert.deepEqual(key.body.error, { code: -32602, message: "Not available in the agent browser: the argument headers of PageFetch" });
    assert.equal(pf.calls.length, 3, "the key check runs before PageFetch");
    assert.ok(!log.join("\n").includes("pages.example.test"), "no argument in the transport's log");
  });
});

test("a remote admission (and no admission word): PageFetch's own refusal at once, with no argument of the client; no browser gate, no use; with no PageFetch the transport's text; a local call with no PageFetch gets -32601", { timeout: 60_000 }, async () => {
  const pf = fakeFetch();
  await withFetch({ fetch: pf }, async ({ t, url, sid, gates, admission, log }) => {
    for (const a of ["remote", undefined] as Admission[]) {
      admission.now = a;
      const r = await post(url, call(20, "PageFetch", { url: "https://pages.example.test/", other: 1 }), sid);
      assert.deepEqual(r.body, toolError(20, "Not fetched (unavailable): PageFetch works only for sessions of this box."));
    }
    assert.deepEqual(pf.calls, [{ scope: "web-1", admission: "remote", args: {} }, { scope: "web-1", admission: "remote", args: {} }]);
    assert.deepEqual(gates, []);
    assert.equal(t.activity().calls, 0);
    assert.ok(log.includes("mcp: MCP session 1 (scope web-1): a tools/call of PageFetch refused (a remote admission)"), log.join("\n"));
  });
  await withFetch({ fetch: null }, async ({ url, sid, admission }) => {
    const local = await post(url, call(30, "PageFetch", { url: "https://pages.example.test/" }), sid);
    assert.deepEqual(local.body.error, { code: -32601, message: "Not available in the agent browser: PageFetch" });
    admission.now = "remote";
    assert.deepEqual((await post(url, call(31, "PageFetch", {}), sid)).body, toolError(31, "Not fetched (unavailable): PageFetch works only for sessions of this box."));
  });
});

test("the live tests' admit (board ab-v16.102): only the service's option pageFetch gives PageFetch its admit; no CLI path sets it", () => {
  const src = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
  const service = src("service/service.ts");
  assert.match(service, /pageFetch\?: Pick<PageFetchOptions, "admit">;/);
  assert.match(service, /log: o\.log,\n {8}\.\.\.\(o\.pageFetch\?\.admit \? \{ admit: o\.pageFetch\.admit \} : \{\}\),\n {6}\}\);/);
  for (const f of ["service/main.ts", "cli.ts"]) assert.doesNotMatch(src(f), /pageFetch|\badmit:/, f);
});
