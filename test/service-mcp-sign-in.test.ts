// The MCP tools of the stored sign-ins, browser_sign_in and browser_sign_ins, in stage 1d's transport, for a local
// admission only (contract C11, the sign-in act's entry "The MCP"; docs/contracts/mcp-allow-list.md and its vectors;
// the stored sign-ins design, sections 5.7 and 7.1; board ab-v16.97.5). The act here is a fake of the act's two methods
// (src/service/signins/act.ts) that records each call: the act's own rules are test/sign-in-act.test.ts's. The MCP is
// the pinned @playwright/mcp in its worker (initialize and tools/list need no browser), so these tests start no Chrome.
// Every value here is a made-up test value, named so; every folder is a temp folder of the test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseStat } from "../src/relay/peer.ts";
import { checkCall, filterTools, readAllowList, SERVICE_TOOLS } from "../src/service/mcp/allow-list.ts";
import { MCP_FAILED } from "../src/service/mcp/port.ts";
import { McpTransport } from "../src/service/mcp/transport.ts";
import { ActRefusal, SignInAct } from "../src/service/signins/act.ts";
import { ACT_TEXT, signedInText } from "../src/service/signins/act-rules.ts";
import { until } from "./fake-bridge.ts";

const LIST = readAllowList();
const V = JSON.parse(readFileSync(new URL("./vectors/mcp-allow-list.json", import.meta.url), "utf8"));
const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test-client", version: "0" } } };
const ORIGIN = "http://staging.test.localhost:8080";
/** C11's tool error of check 1 (a remote admission). */
const REMOTE = `Not signed in: ${ACT_TEXT.remote}`;
/** Made-up test values that an act's answer must never carry to the client (the scan's canaries). */
const CANARY_USER = "test-user.canary@staging.test.localhost";
const CANARY_PASS = "Test-Canary-Pass-9Zr7-not-a-secret";
const holdsCanary = (s: string) => s.includes(CANARY_USER) || s.includes(CANARY_PASS);
type Admission = "local" | "remote" | undefined;

/**
 * A fake of the act's two methods: it records each call (the method, the caller and the arguments), and, as the real act
 * does, its check 1 refuses a caller whose admission is not local (the real act's own path: the test with SignInAct below).
 */
function fakeAct(o: { signIn?: (params: Record<string, unknown>) => Promise<object>; signIns?: () => object } = {}) {
  const calls: { method: string; scope: string; admission: string; params?: Record<string, unknown> }[] = [];
  return {
    calls,
    host: {
      signIn: async (c: { scope: string; admission: "local" | "remote" }, params: Record<string, unknown>) => {
        calls.push({ method: "signIn", scope: c.scope, admission: c.admission, params });
        if (c.admission !== "local") throw new ActRefusal("remote", ACT_TEXT.remote);
        return o.signIn ? o.signIn(params) : { signedIn: true, name: "staging", origin: ORIGIN };
      },
      signIns: (c: { scope: string; admission: "local" | "remote" }) => {
        calls.push({ method: "signIns", scope: c.scope, admission: c.admission });
        if (c.admission !== "local") throw new ActRefusal("remote", ACT_TEXT.remote);
        return o.signIns ? o.signIns() : { state: "open", signIns: [{ name: "staging", origin: ORIGIN }] };
      },
    },
  };
}

type Front = { url: (scope: string) => string; server: Server; close: () => Promise<void> };
/**
 * A plain HTTP server in front of the transport, as the port is: the path's scope is the connection's scope, and each
 * request carries the admission that `admission()` gives at its arrival (undefined: the request carries no word), and the
 * browser gate `gate` when there is one. A rejection of the request path gets the port's fixed 500.
 */
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
async function post(url: string, body: unknown, sid?: string, extra: Record<string, string> = {}, signal?: AbortSignal): Promise<Reply> {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(sid ? { "Mcp-Session-Id": sid } : {}), ...extra }, body: JSON.stringify(body), signal: signal ?? AbortSignal.timeout(30_000) });
  const text = await r.text();
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : null; } catch {}
  return { status: r.status, sid: r.headers.get("mcp-session-id"), body: parsed, text };
}
async function init(url: string, extra: Record<string, string> = {}): Promise<string> {
  const r = await post(url, INIT, undefined, extra);
  assert.equal(r.status, 200, r.text);
  await post(url, { jsonrpc: "2.0", method: "notifications/initialized" }, r.sid!, extra);
  return r.sid!;
}
const call = (id: number, name: string, args?: unknown) => ({ jsonrpc: "2.0", id, method: "tools/call", params: args === undefined ? { name } : { name, arguments: args } });
const toolError = (id: number, text: string) => ({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: true } });
const toolText = (id: number, text: string) => ({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });

type World = { t: McpTransport; h: Front; log: string[]; admission: { now: Admission }; gates: string[] };
async function withAct(o: { act?: ReturnType<typeof fakeAct> | null; gate?: () => Promise<boolean> }, f: (w: World) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "ab-mcp-sign-in-"));
  const log: string[] = [];
  const act = o.act === undefined ? fakeAct() : o.act;
  const t = new McpTransport({ list: LIST, stateFolder: join(dir, "state"), ticketUrl: () => null, log: (l) => log.push(l), ...({ act: () => act?.host ?? null } as object) });
  const admission: { now: Admission } = { now: "local" };
  const gates: string[] = [];
  const gate = async () => { gates.push("gate"); return o.gate ? o.gate() : true; };
  const h = await front(t, () => admission.now, gate);
  try { await f({ t, h, log, admission, gates }); } finally { await h.close(); await t.stop(); rmSync(dir, { recursive: true, force: true }); }
}
const namesOf = (r: Reply) => (r.body?.result?.tools ?? []).map((x: any) => x.name);

// ------------------------------------------------------------------ tools/list

test("tools/list: a local admission with the act gets the list's tools, then browser_sign_in and browser_sign_ins with the format's description and input schema; a remote admission, a request with no admission word and a service with no act get neither", { timeout: 60_000 }, async () => {
  await withAct({}, async ({ h, admission }) => {
    const sid = await init(h.url("web-1"));
    const local = await post(h.url("web-1"), { jsonrpc: "2.0", id: 2, method: "tools/list" }, sid);
    const names = namesOf(local);
    assert.deepEqual(names.slice(0, -2).sort(), Object.keys(LIST.tools).sort(), "the list's tools first");
    assert.deepEqual(names.slice(-2), ["browser_sign_in", "browser_sign_ins"], "then the service's own tools, in the format's order");
    for (const [n, r] of Object.entries(SERVICE_TOOLS)) {
      assert.deepEqual(local.body.result.tools.find((x: any) => x.name === n), { name: n, description: r.description, inputSchema: r.schema }, `${n}: its name, description and input schema`);
    }
    // The admission of each request, not of the MCP session: the same MCP session's next request is remote.
    admission.now = "remote";
    const remote = await post(h.url("web-1"), { jsonrpc: "2.0", id: 3, method: "tools/list" }, sid);
    assert.deepEqual(namesOf(remote).sort(), Object.keys(LIST.tools).sort(), "a remote admission: no tool of service_tools");
    admission.now = undefined;
    const none = await post(h.url("web-1"), { jsonrpc: "2.0", id: 4, method: "tools/list" }, sid);
    assert.deepEqual(namesOf(none).sort(), Object.keys(LIST.tools).sort(), "no admission word is remote: no tool of service_tools");
  });
  await withAct({ act: null }, async ({ h }) => {
    const sid = await init(h.url("web-1"));
    const r = await post(h.url("web-1"), { jsonrpc: "2.0", id: 2, method: "tools/list" }, sid);
    assert.deepEqual(namesOf(r).sort(), Object.keys(LIST.tools).sort(), "a local admission while the service has no act: no tool of service_tools");
  });
});

// ------------------------------------------------------------------ a remote admission

test("a remote admission (and a request with no admission word): a call of either tool goes at once to the act's method with the admission remote and no argument, and gets the act's check 1 as the tool's error, whatever its arguments; it passes no browser gate, is no use, never reaches the MCP, and its log line names no argument", { timeout: 60_000 }, async () => {
  const act = fakeAct();
  await withAct({ act }, async ({ t, h, log, admission, gates }) => {
    const sid = await init(h.url("web-1"));
    const w = t.workerOf("web-1")!;
    const seen: string[] = [];
    const real = w.request.bind(w);
    w.request = (s, m) => { seen.push(String(m.method)); return real(s, m); };
    let id = 10;
    for (const a of ["remote", undefined] as Admission[]) {
      admission.now = a;
      for (const [name, args] of [["browser_sign_in", { name: "staging" }], ["browser_sign_ins", {}], ["browser_sign_in", { name: "staging", password: CANARY_PASS }], ["browser_sign_in", ["x"]], ["browser_sign_ins", undefined]] as [string, unknown][]) {
        const r = await post(h.url("web-1"), call(++id, name, args), sid);
        assert.deepEqual([r.status, r.body], [200, toolError(id, REMOTE)], `${String(a)}: ${name} ${JSON.stringify(args)}`);
      }
    }
    const want = [["signIn", "remote", {}], ["signIns", "remote", undefined], ["signIn", "remote", {}], ["signIn", "remote", {}], ["signIns", "remote", undefined]];
    assert.deepEqual(act.calls.map((c) => [c.method, c.admission, c.params]), [...want, ...want], "each call went to the act's method with the admission remote and no argument of the client");
    assert.ok(act.calls.every((c) => c.scope === "web-1"));
    assert.deepEqual(gates, [], "no call passed the browser gate: a remote call needs no browser and is no use");
    assert.deepEqual(seen, [], "no call reached the MCP");
    assert.equal(t.activity().calls, 0);
    assert.ok(log.includes("mcp: MCP session 1 (scope web-1): a tools/call of browser_sign_in refused (a remote admission)"), log.join("\n"));
    assert.ok(log.includes("mcp: MCP session 1 (scope web-1): a tools/call of browser_sign_ins refused (a remote admission)"));
    assert.ok(!log.join("\n").includes("staging") && !holdsCanary(log.join("\n")), "no argument in the log");
  });
});

test("a remote call through the real act (SignInAct, with traps for its ports): browser_sign_in is refused by the act's own check 1 and sends the one refusal end (result remote, an act id of its own, no start, no credential) and the act's log line; browser_sign_ins is refused by check 1 and sends no event; neither reads the store or the model, opens a window or passes the browser gate", { timeout: 60_000 }, async () => {
  const touched: string[] = [];
  const trap = (what: string) => (..._args: unknown[]): never => { touched.push(what); throw new Error(`the test's trap: ${what}`); };
  const events: Record<string, any>[] = [];
  const lines: string[] = [];
  const real = new SignInAct({
    model: { notReady: trap("model.notReady"), entries: trap("model.entries"), call: trap("model.call"), hide: trap("model.hide"), listen: trap("model.listen"), inputLock: trap("model.inputLock"), person: trap("model.person"), random: {} as never },
    receiver: { features: trap("receiver.features"), request: trap("receiver.request") },
    store: { state: trap("store.state"), named: trap("store.named"), usable: trap("store.usable"), openForUse: trap("store.openForUse"), limit: trap("store.limit"), actStarted: trap("store.actStarted"), actEnded: trap("store.actEnded") },
    screen: { size: trap("screen.size"), moveOff: trap("screen.moveOff") },
    move: { move: trap("move.move") },
    emit: (ev) => events.push(ev), log: (l) => lines.push(l), repoOf: (scope) => (scope === "web-1" ? "owner/repo" : null),
  });
  await withAct({ act: { calls: [], host: real } as unknown as ReturnType<typeof fakeAct> }, async ({ t, h, log, admission, gates }) => {
    const sid = await init(h.url("web-1"));
    admission.now = "remote";
    const one = await post(h.url("web-1"), call(80, "browser_sign_in", { name: "staging", password: CANARY_PASS }), sid);
    assert.deepEqual([one.status, one.body], [200, toolError(80, REMOTE)]);
    assert.equal(events.length, 1, "one event");
    const ev = events[0];
    assert.deepEqual({ ...ev, act: "<act>", at: "<at>", ms: 0 }, { t: "ev", ev: "sign_in", phase: "end", act: "<act>", scope: "web-1", repo: "owner/repo", id: null, name: null, origin: null, at: "<at>", result: "remote", ms: 0, blocked: 0, guarded: 0, stopped_now: false }, "the refusal end of check 1: no start, no credential");
    assert.match(ev.act, /^[0-9a-f]{16}$/, "an act id of its own");
    assert.equal(lines.length, 1, "the act's one log line");
    assert.match(lines[0], new RegExp(`^sign-in: act ${ev.act}: user .*, scope web-1, repo owner/repo, no credential, result remote, `));
    const list = await post(h.url("web-1"), call(81, "browser_sign_ins", {}), sid);
    assert.deepEqual([list.status, list.body], [200, toolError(81, REMOTE)]);
    assert.equal(events.length, 1, "browser_sign_ins sends no event (AgentBrowser.signIns sends none)");
    assert.deepEqual(touched, [], "no call read the store or the model, or opened a window");
    assert.deepEqual(gates, [], "no browser gate");
    assert.equal(t.activity().calls, 0, "no use");
    assert.ok(!holdsCanary(JSON.stringify(events) + lines.join("\n") + log.join("\n")), "no argument in the event or the log");
  });
});

test("with no act, a remote call of either tool gets check 1's text from the transport (there is no act, so no event)", { timeout: 60_000 }, async () => {
  await withAct({ act: null }, async ({ h, admission }) => {
    const sid = await init(h.url("web-1"));
    admission.now = "remote";
    for (const [k, name] of ["browser_sign_in", "browser_sign_ins"].entries()) {
      const r = await post(h.url("web-1"), call(90 + k, name, {}), sid);
      assert.deepEqual([r.status, r.body], [200, toolError(90 + k, REMOTE)], name);
    }
  });
});

// ------------------------------------------------------------------ a local admission

test("a local call of browser_sign_in passes the browser gate, then runs the act's method for the MCP session's scope with the local admission and its arguments; its answer is C11's success text, made from the origin alone", { timeout: 60_000 }, async () => {
  // The act's answer carries more than its three fields: none of them reaches the client.
  const act = fakeAct({ signIn: async () => ({ signedIn: true, name: "staging", origin: ORIGIN, username: CANARY_USER, password: CANARY_PASS }) });
  await withAct({ act }, async ({ t, h, gates }) => {
    const sid = await init(h.url("web-7"));
    const w = t.workerOf("web-7")!;
    const seen: string[] = [];
    const real = w.request.bind(w);
    w.request = (s, m) => { seen.push(String(m.method)); return real(s, m); };
    const r = await post(h.url("web-7"), call(5, "browser_sign_in", { name: "staging" }), sid);
    assert.deepEqual([r.status, r.body], [200, toolText(5, signedInText(ORIGIN))]);
    assert.equal(r.body.result.content[0].text, `Signed in to ${ORIGIN}. Your tabs of this site were closed for the sign-in; open the site again: it loads signed in.`);
    assert.deepEqual(act.calls, [{ method: "signIn", scope: "web-7", admission: "local", params: { name: "staging" } }]);
    assert.deepEqual(gates, ["gate"], "the call passed the browser gate (the start at a use) first");
    assert.deepEqual(seen, [], "the call never reached the MCP's code");
    assert.ok(!holdsCanary(r.text), "no value of the act's answer but the origin");
    // No name: the act's method runs, and its check 2 refuses it (the vectors: review-112b).
    await post(h.url("web-7"), call(6, "browser_sign_in", {}), sid);
    await post(h.url("web-7"), call(7, "browser_sign_in"), sid);
    assert.deepEqual(act.calls.slice(1).map((c) => c.params), [{}, {}], "a call with no name, and a call with no arguments, run the act's method with {}");
  });
});

test("a refusal of the act is the tool's error: isError true and the one text `Not signed in: <text>` of C11 (check 2 with the asked name, the lock, the readiness)", { timeout: 60_000 }, async () => {
  const texts = [ACT_TEXT.no_such_name.replace("<name>", "missing"), ACT_TEXT.locked, "The agent browser is not ready: its extension is not connected."];
  let i = 0;
  const act = fakeAct({ signIn: async () => { throw new ActRefusal("locked", texts[i++]); } });
  await withAct({ act }, async ({ h }) => {
    const sid = await init(h.url("web-1"));
    for (const [k, text] of texts.entries()) {
      const r = await post(h.url("web-1"), call(20 + k, "browser_sign_in", { name: "missing" }), sid);
      assert.deepEqual([r.status, r.body], [200, toolError(20 + k, `Not signed in: ${text}`)], text);
    }
  });
});

test("browser_sign_ins answers the store's state and the names and origins that the scope may use, as compact JSON, with no other field of the act's answer", { timeout: 60_000 }, async () => {
  const act = fakeAct({ signIns: () => ({ state: "open", signIns: [{ name: "staging", origin: ORIGIN, username: CANARY_USER }, { name: "prod", origin: "https://prod.test.localhost", password: CANARY_PASS }], key: CANARY_PASS }) });
  await withAct({ act }, async ({ h, gates }) => {
    const sid = await init(h.url("web-3"));
    const r = await post(h.url("web-3"), call(8, "browser_sign_ins", {}), sid);
    assert.deepEqual([r.status, r.body], [200, toolText(8, JSON.stringify({ state: "open", signIns: [{ name: "staging", origin: ORIGIN }, { name: "prod", origin: "https://prod.test.localhost" }] }))]);
    assert.ok(!holdsCanary(r.text), "no other field");
    assert.deepEqual(act.calls, [{ method: "signIns", scope: "web-3", admission: "local" }]);
    assert.deepEqual(gates, ["gate"], "a tool call: it passes the browser gate");
  });
});

test("a local call with another key or with arguments that are no object gets the format's -32602, and with no act a call gets the -32601 of a tool that the service does not serve; none reaches the act", { timeout: 60_000 }, async () => {
  const act = fakeAct();
  await withAct({ act }, async ({ h, log }) => {
    const sid = await init(h.url("web-1"));
    const cases: [string, unknown, object][] = [
      ["browser_sign_in", { name: "staging", password: CANARY_PASS }, { code: -32602, message: "Not available in the agent browser: the argument password of browser_sign_in" }],
      ["browser_sign_ins", { name: "staging" }, { code: -32602, message: "Not available in the agent browser: the argument name of browser_sign_ins" }],
      ["browser_sign_in", ["staging"], { code: -32602, message: "Not available in the agent browser: the arguments of browser_sign_in must be a JSON object" }],
      ["browser_sign_ins", null, { code: -32602, message: "Not available in the agent browser: the arguments of browser_sign_ins must be a JSON object" }],
    ];
    let id = 30;
    for (const [name, args, error] of cases) {
      const r = await post(h.url("web-1"), call(++id, name, args), sid);
      assert.deepEqual([r.status, r.body], [200, { jsonrpc: "2.0", id, error }], `${name} ${JSON.stringify(args)}`);
    }
    assert.deepEqual(act.calls, []);
    assert.ok(log.includes("mcp: MCP session 1 (scope web-1): a tools/call refused (-32602)"));
    assert.ok(!holdsCanary(log.join("\n")));
  });
  await withAct({ act: null }, async ({ h }) => {
    const sid = await init(h.url("web-1"));
    for (const [k, name] of ["browser_sign_in", "browser_sign_ins"].entries()) {
      const r = await post(h.url("web-1"), call(40 + k, name, k ? {} : { name: "staging" }), sid);
      assert.deepEqual([r.status, r.body], [200, { jsonrpc: "2.0", id: 40 + k, error: { code: -32601, message: `Not available in the agent browser: ${name}` } }], name);
    }
  });
});

test("a call of browser_sign_in counts as a use while its act runs, also after its client closed; a client's cancel does not stop the act, its POST gets the act's answer, and its id stays busy until then", { timeout: 60_000 }, async () => {
  let finish!: () => void;
  let started = 0;
  const act = fakeAct({ signIn: () => { started++; return new Promise((r) => { finish = () => r({ signedIn: true, name: "staging", origin: ORIGIN }); }); } });
  await withAct({ act }, async ({ t, h }) => {
    const sid = await init(h.url("web-1"));
    // The worker (the MCP) gets nothing of the act's calls: no request, and no cancel when a client cancels or leaves.
    const w = t.workerOf("web-1")!;
    const toWorker: string[] = [];
    const req = w.request.bind(w), note = w.notify.bind(w);
    w.request = (s, m) => { toWorker.push(`request ${String(m.method)} ${JSON.stringify(m.id)}`); return req(s, m); };
    w.notify = (s, m) => { toWorker.push(`notify ${String(m.method)} ${JSON.stringify((m.params as any)?.requestId)}`); note(s, m); };
    // A cancel: the act runs on, and the POST gets its answer.
    const first = post(h.url("web-1"), call(50, "browser_sign_in", { name: "staging" }), sid);
    await until(() => started === 1, "the act starts");
    assert.equal(t.activity().calls, 1, "the call counts as a use while its act runs");
    assert.equal((await post(h.url("web-1"), { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 50, reason: "the test cancels it" } }, sid)).status, 202);
    const dup = await post(h.url("web-1"), { jsonrpc: "2.0", id: 50, method: "ping" }, sid);
    assert.equal(dup.status, 400, "the id stays busy: the act still runs");
    assert.equal(t.activity().calls, 1);
    finish();
    assert.deepEqual((await first).body, toolText(50, signedInText(ORIGIN)), "the cancelled call gets the act's answer");
    assert.equal(t.activity().calls, 0);
    // A client that closes: the act runs on and counts as a use until its end.
    const ac = new AbortController();
    const second = post(h.url("web-1"), call(51, "browser_sign_in", { name: "staging" }), sid, {}, ac.signal).then(() => "answered", () => "closed");
    await until(() => started === 2, "the second act starts");
    ac.abort();
    assert.equal(await second, "closed");
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(t.activity().calls, 1, "the act still counts as a use after its client closed");
    finish();
    await until(() => t.activity().calls === 0, "the use ends with the act");
    assert.deepEqual(toWorker.filter((x) => / 5[01]$/.test(x) && !x.startsWith("notify notifications/cancelled 50")), [], "no request and no cancel of the closed call reached the MCP");
  });
});

test("a call that waits at the browser gate and whose client closes never starts the act; a gate that refuses (the port answered) starts no act either", { timeout: 60_000 }, async () => {
  let open!: (v: boolean) => void;
  const act = fakeAct();
  await withAct({ act, gate: () => new Promise<boolean>((r) => { open = r; }) }, async ({ h, gates }) => {
    const sid = await init(h.url("web-1"));
    const ac = new AbortController();
    const first = post(h.url("web-1"), call(60, "browser_sign_in", { name: "staging" }), sid, {}, ac.signal).then(() => "answered", () => "closed");
    await until(() => gates.length === 1, "the call waits at the gate");
    ac.abort();
    assert.equal(await first, "closed");
    // The service's side sees the close (the request's close event) before the gate opens.
    await new Promise((r) => setTimeout(r, 300));
    open(true);
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(act.calls, [], "no act for a client that left during the gate's wait");
    // A gate that refuses: the port answered the request itself, and no act starts.
    const second = post(h.url("web-1"), call(61, "browser_sign_in", { name: "staging" }), sid, {}, AbortSignal.timeout(1500)).then(() => "answered", () => "no answer of the transport");
    await until(() => gates.length === 2, "the second call waits at the gate");
    open(false);
    assert.equal(await second, "no answer of the transport", "the transport writes nothing after a refusing gate (the port answers)");
    assert.deepEqual(act.calls, [], "no act after a gate that refuses");
  });
});

test("a client's cancel while the call waits at the browser gate ends the call: its id is free at once, its POST gets the cancelled answer, and no act starts when the gate opens", { timeout: 60_000 }, async () => {
  let open!: (v: boolean) => void;
  const act = fakeAct();
  await withAct({ act, gate: () => new Promise<boolean>((r) => { open = r; }) }, async ({ h, gates }) => {
    const sid = await init(h.url("web-1"));
    const first = post(h.url("web-1"), call(65, "browser_sign_in", { name: "staging" }), sid);
    await until(() => gates.length === 1, "the call waits at the gate");
    assert.equal((await post(h.url("web-1"), { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 65, reason: "the test cancels it" } }, sid)).status, 202);
    const again = await post(h.url("web-1"), { jsonrpc: "2.0", id: 65, method: "ping" }, sid);
    assert.deepEqual([again.status, again.body], [200, { jsonrpc: "2.0", id: 65, result: {} }], "the id is free at once");
    open(true);
    const r = await first;
    assert.deepEqual([r.status, r.body], [200, { jsonrpc: "2.0", id: 65, error: { code: -32800, message: "Request cancelled: the client sent notifications/cancelled for this request." } }]);
    await new Promise((x) => setTimeout(x, 200));
    assert.deepEqual(act.calls, [], "no act starts");
  });
});

test("an exception of the act that is no refusal: the request path rejects (the port's fixed 500), and its text reaches no answer and no log line", { timeout: 60_000 }, async () => {
  const act = fakeAct({ signIn: async () => { throw new Error(`a test failure that names ${CANARY_PASS}`); } });
  await withAct({ act }, async ({ h, log }) => {
    const sid = await init(h.url("web-1"));
    const r = await post(h.url("web-1"), call(70, "browser_sign_in", { name: "staging" }), sid);
    assert.deepEqual([r.status, r.text], [500, MCP_FAILED]);
    assert.ok(!holdsCanary(log.join("\n")));
  });
});

// ------------------------------------------------------------------ the format's vectors through the code

test("the format's vectors through the code: each call gets its answer (checkCall, then serviceCall with its admission and the act), and each tools/list vector gets its names (filterTools, then serviceTools for a local admission)", async () => {
  const al: any = await import("../src/service/mcp/allow-list.ts");
  assert.equal(typeof al.serviceCall, "function", "allow-list.ts has serviceCall");
  assert.equal(typeof al.serviceTools, "function", "allow-list.ts has serviceTools");
  const real = (map: Record<string, string> = {}) => (p: string) => map[p] ?? p;
  let own = 0;
  for (const c of V.calls) {
    const s = al.serviceCall(V.list, c.call, c.admission ?? "local", true);
    if (s === null) { assert.deepEqual(checkCall(V.list, c.call, V.folder, real(c.realpath)), c.answer === "pass" ? null : c.answer, c.note); continue; }
    own++;
    const got = s === "remote" ? { isError: true, text: REMOTE } : "tool" in s ? "service" : s;
    assert.deepEqual(got, c.answer, c.note);
  }
  assert.equal(own, 7, "the vectors' seven calls of the service's own tools");
  // A service tool with no act: the -32601 of a tool that the service does not serve (local); remote: check 1 first.
  assert.deepEqual(al.serviceCall(V.list, { name: "browser_sign_in", arguments: { name: "staging" } }, "local", false), { code: -32601, message: "Not available in the agent browser: browser_sign_in" });
  assert.equal(al.serviceCall(V.list, { name: "browser_sign_in", arguments: { name: "staging" } }, "remote", false), "remote");
  assert.equal(al.serviceCall(V.list, { name: "browser_sign_in", arguments: { name: "staging" } }, undefined, true), "remote", "no word is remote");
  assert.equal(al.serviceCall(V.list, { name: "browser_navigate", arguments: {} }, "remote", true), null, "a tool of the list goes on to checkCall");
  for (const tl of V.toolsLists) {
    const names = [...filterTools(V.list, V.pinnedTools), ...(tl.admission === "local" ? al.serviceTools(V.list) : [])].map((x: any) => x.name);
    assert.deepEqual(names, tl.names, tl.note);
  }
});

// ------------------------------------------------------------------ through the real port and the MCP part

test("through the real port and the MCP part: a connection that the uid check and the walk admit (this process, under its own root) is local, so the transport gets the word local and runs the act; the test stand-in of a remote scope gets the word remote and no act", { skip: process.platform !== "linux", timeout: 60_000 }, async () => {
  const { McpPart } = await import("../src/service/mcp/part.ts");
  const { mcpOption } = await import("../src/service/main.ts");
  const dir = mkdtempSync(join(tmpdir(), "ab-mcp-sign-in-port-"));
  const token = "abt1_" + Buffer.from("test, not a token: the sign-in tools", "latin1").toString("base64url");
  const fp = createHash("sha256").update(token, "latin1").digest("hex");
  const self = parseStat(readFileSync(`/proc/${process.pid}/stat`, "latin1"))!;
  const sessions = { sessions: [{ scope: "t-act", repo: null, roots: [{ pid: process.pid, start: self.start }], cgroup: null, lifetime_id: null, mcp_token: fp }] } as any;
  const auth = { Authorization: `Bearer ${token}` };
  const parts: any[] = [];
  try {
    for (const remote of [false, true]) {
      const act = fakeAct();
      const log: string[] = [];
      // main.ts's own option of the MCP path: --test-mcp-remote-scope t-act, or no flag.
      const p = new McpPart({ ...mcpOption({ port: 0 }, remote ? "t-act" : undefined), stateFolder: join(dir, remote ? "r" : "l"), log: (l) => log.push(l) });
      parts.push(p);
      p.setSessions(sessions);
      await (p.open as any)({ url: (s: string) => s, readiness: () => ({ controlOff: false, notReady: null, sites: 1 }), act: () => act.host });
      const url = `http://127.0.0.1:${p.mcpPort!.port}/mcp/t-act`;
      const sid = await init(url, auth);
      const l = await post(url, { jsonrpc: "2.0", id: 2, method: "tools/list" }, sid, auth);
      const r = await post(url, call(3, "browser_sign_in", { name: "staging" }), sid, auth);
      if (!remote) {
        assert.deepEqual(namesOf(l).slice(-2), ["browser_sign_in", "browser_sign_ins"], "local: the service's own tools");
        assert.deepEqual(r.body, toolText(3, signedInText(ORIGIN)));
        assert.deepEqual(act.calls.map((c) => [c.method, c.scope, c.admission]), [["signIn", "t-act", "local"]]);
      } else {
        assert.ok(!namesOf(l).includes("browser_sign_in") && !namesOf(l).includes("browser_sign_ins"), "the remote stand-in: no service tool");
        assert.deepEqual(r.body, toolError(3, REMOTE));
        assert.deepEqual(act.calls.map((c) => [c.method, c.scope, c.admission, c.params]), [["signIn", "t-act", "remote", {}]], "the remote stand-in reaches only the act's check 1, with no argument");
      }
      assert.ok(!log.join("\n").includes(token) && !log.join("\n").includes(fp));
    }
  } finally { for (const p of parts) await p.close(); rmSync(dir, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------ the live check's stand-in of a remote admission

test("--test-mcp-remote-scope takes one scope name, and main.ts's mcpOption gives the port that one scope as remote (no flag: no set)", async () => {
  const { testMcpRemoteScope, SERVICE_USAGE } = await import("../src/service/main.ts");
  for (const ok of ["live-2", "a", "web_1.x", "A".repeat(64)]) assert.equal(testMcpRemoteScope(ok), ok);
  for (const bad of ["", "-x", ".x", "a b", "a/b", "A".repeat(65), "x\n"]) assert.throws(() => testMcpRemoteScope(bad), /--test-mcp-remote-scope must be a scope name/, JSON.stringify(bad));
  assert.match(SERVICE_USAGE, /\[--test-mcp-port PORT \[--test-mcp-remote-scope SCOPE\]\]/);
  // The pairing with --test and --test-mcp-port: test/service-cli.test.ts (the refusals); the port's behaviour: the test
  // through the real port above, with main.ts's own mcpOption.
  const { mcpOption } = await import("../src/service/main.ts");
  assert.deepEqual(mcpOption({ port: 0 }, "live-2"), { listen: { port: 0 }, port: { remote: new Set(["live-2"]) } });
  assert.deepEqual(mcpOption({ port: 0 }, undefined), { listen: { port: 0 } });
  const main = readFileSync(new URL("../src/service/main.ts", import.meta.url), "utf8");
  assert.ok(main.includes("...(listen ? { mcp: mcpOption(listen, remoteScope) } : {}),"), "main.ts gives the service mcpOption's value");
});

// ------------------------------------------------------------------ a real MCP client

test("a real MCP client (the MCP SDK's Client and StreamableHTTPClientTransport of the pinned playwright-core's bundle) lists the tools and calls them over the transport: a local admission signs in, a remote one gets check 1's tool error", { timeout: 60_000 }, async () => {
  const { createRequire } = await import("node:module");
  const sdk = createRequire(import.meta.url)(join(new URL("../node_modules/playwright-core/lib/utilsBundle.js", import.meta.url).pathname));
  const act = fakeAct();
  await withAct({ act }, async ({ h, admission }) => {
    for (const a of ["local", "remote"] as const) {
      admission.now = a;
      const client = new sdk.Client({ name: "test-client", version: "0" });
      await client.connect(new sdk.StreamableHTTPClientTransport(new URL(h.url("web-1"))));
      try {
        const names = (await client.listTools()).tools.map((x: any) => x.name);
        const one = await client.callTool({ name: "browser_sign_in", arguments: { name: "staging" } });
        const list = await client.callTool({ name: "browser_sign_ins", arguments: {} });
        if (a === "local") {
          assert.deepEqual(names.slice(-2), ["browser_sign_in", "browser_sign_ins"]);
          assert.deepEqual(one, { content: [{ type: "text", text: signedInText(ORIGIN) }] });
          assert.deepEqual(JSON.parse((list as any).content[0].text), { state: "open", signIns: [{ name: "staging", origin: ORIGIN }] });
        } else {
          assert.ok(!names.includes("browser_sign_in") && !names.includes("browser_sign_ins"));
          assert.deepEqual([one, list], [{ content: [{ type: "text", text: REMOTE }], isError: true }, { content: [{ type: "text", text: REMOTE }], isError: true }]);
        }
      } finally { await client.close(); }
    }
    assert.deepEqual(act.calls.map((c) => [c.method, c.admission]), [["signIn", "local"], ["signIns", "local"], ["signIn", "remote"], ["signIns", "remote"]], "the remote client's calls reach only the act's check 1");
  });
});

test("the service's wiring (service.ts, by behaviour): with the store, the native link, the lists and the Chrome unit the service makes the act, and its MCP path's tools/list holds browser_sign_in and browser_sign_ins for a local admission, with no Chrome start; without the store, neither", { skip: process.platform !== "linux", timeout: 90_000 }, async () => {
  const { startService } = await import("../src/service/service.ts");
  const { FakeTools, World } = await import("./fake-unit-world.ts");
  const token = "abt1_" + Buffer.from("test, not a token: the service's wiring", "latin1").toString("base64url");
  const self = parseStat(readFileSync(`/proc/${process.pid}/stat`, "latin1"))!;
  const auth = { Authorization: `Bearer ${token}` };
  const DAEMON = { kind: "daemon", user: "ann", via: "daemon" };
  for (const withStore of [true, false]) {
    const w = new World();
    const tools = new FakeTools();
    const dir = mkdtempSync(join(tmpdir(), "ab-mcp-sign-in-svc-"));
    mkdirSync(join(dir, "lists"));
    writeFileSync(join(dir, "lists", "owner.repo.json"), JSON.stringify({ allow: ["a.example"], repo: "owner/repo" }));
    const s = await startService({
      agentDoor: join(dir, "cdp.sock"), controlDoor: join(dir, "control.sock"), daemonCommand: join(dir, "daemon-command.json"), log: () => {}, mainPid: async () => null,
      lists: { listsFolder: join(dir, "lists"), stateFolder: w.paths.state },
      unit: { paths: w.paths, owner: async () => ({ active: "active", sub: "running", mainPid: process.pid }), tools, procs: w.procs, part: { unit: w.deps(tools), firstCheckMs: 3_600_000, usePollMs: 5 } },
      link: { socket: join(dir, "link.sock"), pidfds: { failed: "none" }, xdotool: null, peer: async () => ({ ok: true, pid: 4242 }) },
      mcp: { listen: { port: 0 } },
      ...(withStore ? { signIns: { protections: () => null } } : {}),
    } as any);
    try {
      await s.state.handle({ t: "req", id: "c", op: "config", by: { kind: "daemon", user: "ann", via: "config" }, enabled: true, control: true, chrome_bin: "/usr/bin/chromium", chrome_args: [] } as any);
      await s.state.handle({ t: "req", id: "s", op: "set_sessions", by: DAEMON, sessions: [{ scope: "web-1", repo: "owner/repo", roots: [{ pid: process.pid, start: self.start }], cgroup: null, lifetime_id: null, mcp_token: createHash("sha256").update(token, "latin1").digest("hex") }], remote: [], box: { hosts: [], cookie_names: [] } } as any);
      const url = `http://${(s.state.status() as any).mcp.address}/mcp/web-1`;
      const sid = await init(url, auth);
      const names = namesOf(await post(url, { jsonrpc: "2.0", id: 2, method: "tools/list" }, sid, auth));
      assert.ok(names.length >= Object.keys(LIST.tools).length, `the list's tools: ${names.length}`);
      if (withStore) assert.deepEqual(names.slice(-2), ["browser_sign_in", "browser_sign_ins"], "the act reaches the MCP path");
      else assert.ok(!names.includes("browser_sign_in") && !names.includes("browser_sign_ins"), "no act: no service tool");
      assert.equal(w.named("chromium").length, 0, "tools/list starts no Chrome");
    } finally { await s.stop(); w.close(); rmSync(dir, { recursive: true, force: true }); }
  }
});
