// How Tab.interceptRequest and Tab.expectResponse treat what a cross-origin form submit really sends. No browser: a stub connection
// that emits CDP events the way Chrome does.
// - Chrome (156) now shows the CORS preflight (an OPTIONS request with no body) to the Fetch domain, before the POST the page sends.
//   interceptRequest took the first paused request, so it tried to rewrite the preflight's empty body as JSON, aborted it, and Suno's
//   form reported "generation failed" (`Unexpected end of JSON input`). The preflight must go through untouched and the POST be
//   the request that is rewritten; expectResponse must not return the preflight's (empty) response as "the" response either.
// - Both start waiting for their event BEFORE the action that causes it. When the action throws, that wait is abandoned, and its timeout
//   used to reject later with nobody listening: an unhandled rejection that crashed the process under the real error
//   (`CDPError: Network.responseReceived: event not seen within 90000 ms`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { CDPConnection } from "../src/cdp.ts";
import { Tab } from "../src/browser.ts";

type Handler = (params: any, sessionId?: string) => void;
function stub(bodies: Record<string, string> = {}) {
  const handlers = new Map<string, Set<Handler>>();
  const sent: { method: string; params: any }[] = [];
  const state = { waiting: 0 };
  const conn: any = {
    sent, state,
    send: async (method: string, params: any) => {
      sent.push({ method, params });
      if (method === "Network.getResponseBody") return { body: bodies[params.requestId] ?? "", base64Encoded: false };
      return {};
    },
    on: (method: string, h: Handler) => {
      let set = handlers.get(method);
      if (!set) handlers.set(method, (set = new Set()));
      set.add(h);
      return () => set!.delete(h);
    },
    // as cdp.ts: the session filter, then the predicate; settles on the event, the timeout, or (signal) a cancel
    waitForEvent: (method: string, o: { sessionId?: string; predicate?: (p: any) => boolean; timeoutMs?: number; signal?: AbortSignal } = {}) => new Promise((resolve, reject) => {
      state.waiting++;
      const done = () => { clearTimeout(timer); off(); o.signal?.removeEventListener("abort", onAbort); state.waiting--; };
      const timer = setTimeout(() => { done(); reject(new Error(`${method}: event not seen within ${o.timeoutMs ?? 30_000} ms`)); }, o.timeoutMs ?? 30_000);
      const onAbort = () => { done(); reject(new Error(`${method}: wait cancelled`)); };
      const off = conn.on(method, (p: any, sid?: string) => {
        if (o.sessionId && sid !== o.sessionId) return;
        if (o.predicate && !o.predicate(p)) return;
        done(); resolve(p);
      });
      if (o.signal?.aborted) onAbort(); else o.signal?.addEventListener("abort", onAbort);
    }),
    emit: (method: string, params: any, sessionId = "session") => { for (const h of [...(handlers.get(method) ?? [])]) h(params, sessionId); },
    handlerCount: (...methods: string[]) => methods.reduce((n, m) => n + (handlers.get(m)?.size ?? 0), 0),
  };
  return { conn, tab: new Tab({ conn } as any, "target", "session") };
}
const calls = (conn: any, method: string) => conn.sent.filter((c: any) => c.method === method).map((c: any) => c.params);

test("interceptRequest: the CORS preflight goes through untouched and the POST behind it is the request that is rewritten", async () => {
  const { conn, tab } = stub();
  const preflight = { requestId: "r1", request: { method: "OPTIONS", url: "https://api.example/gen/", headers: { "Access-Control-Request-Method": "POST" }, hasPostData: false } };
  const post = { requestId: "r2", request: { method: "POST", url: "https://api.example/gen/", headers: {}, hasPostData: true, postData: '{"a":1}' } };
  const r = await tab.interceptRequest("*/gen/*", (b) => JSON.stringify({ ...JSON.parse(b), b: 2 }), async () => { conn.emit("Fetch.requestPaused", preflight); conn.emit("Fetch.requestPaused", post); });
  assert.equal(r.original, '{"a":1}');
  assert.equal(r.sent, '{"a":1,"b":2}');
  const cont = calls(conn, "Fetch.continueRequest");
  assert.deepEqual(cont.map((c: any) => c.requestId), ["r1", "r2"]);
  assert.equal("postData" in cont[0], false, "the preflight is continued as it is");
  assert.equal(Buffer.from(cont[1].postData, "base64").toString("utf8"), '{"a":1,"b":2}');
  assert.deepEqual(calls(conn, "Fetch.failRequest"), [], "nothing is aborted");
});

test("expectResponse: the preflight's empty response is not the response; the POST's is", async () => {
  const { conn, tab } = stub({ n1: "", n2: '{"clips":[]}' });
  const url = "https://api.example/gen/";
  const r = await tab.expectResponse((u) => u === url, async () => {
    conn.emit("Network.requestWillBeSent", { requestId: "n1", request: { method: "OPTIONS", url }, initiator: { type: "preflight" } });
    conn.emit("Network.responseReceived", { requestId: "n1", response: { url, status: 204, mimeType: "" } });
    conn.emit("Network.loadingFinished", { requestId: "n1" });
    conn.emit("Network.requestWillBeSent", { requestId: "n2", request: { method: "POST", url }, initiator: { type: "script" } });
    conn.emit("Network.responseReceived", { requestId: "n2", response: { url, status: 200, mimeType: "application/json" } });
    conn.emit("Network.loadingFinished", { requestId: "n2" });
  });
  assert.equal(r.status, 200);
  assert.equal(r.body, '{"clips":[]}');
  assert.deepEqual(calls(conn, "Network.getResponseBody").map((c: any) => c.requestId), ["n2"]);
});

/** Runs `action`, then waits past the stub's timeouts: the action's own error and any rejection nobody handled. */
async function observe(action: () => Promise<unknown>): Promise<{ error: unknown; unhandled: unknown[] }> {
  const unhandled: unknown[] = [];
  const on = (e: unknown) => { unhandled.push(e); };
  process.on("unhandledRejection", on);
  let error: unknown;
  try { await action(); } catch (e) { error = e; }
  await new Promise((r) => setTimeout(r, 120));
  process.off("unhandledRejection", on);
  return { error, unhandled };
}

test("interceptRequest: an action that throws leaves no unhandled rejection from the abandoned wait", async () => {
  const { tab } = stub();
  const r = await observe(() => tab.interceptRequest("*/x", (b) => b, async () => { throw new Error("click failed"); }, 30));
  assert.match(String(r.error), /click failed/);
  assert.deepEqual(r.unhandled, []);
});

test("expectResponse: an action that throws leaves no unhandled rejection from the abandoned wait", async () => {
  const { tab } = stub();
  const r = await observe(() => tab.expectResponse(() => true, async () => { throw new Error("click failed"); }, 30));
  assert.match(String(r.error), /click failed/);
  assert.deepEqual(r.unhandled, []);
});

test("interceptRequest: a preflight paused in another session is not this tab's to continue", async () => {
  const { conn, tab } = stub();
  const other = { requestId: "x1", request: { method: "OPTIONS", url: "https://api.example/gen/", headers: {}, hasPostData: false } };
  const post = { requestId: "r2", request: { method: "POST", url: "https://api.example/gen/", headers: {}, hasPostData: true, postData: "{}" } };
  await tab.interceptRequest("*/gen/*", (b) => b, async () => { conn.emit("Fetch.requestPaused", other, "another-session"); conn.emit("Fetch.requestPaused", post); });
  assert.deepEqual(calls(conn, "Fetch.continueRequest").map((c: any) => c.requestId), ["r2"]);
});

test("interceptRequest: a transform that throws aborts the paused request, continues nothing for it, and rethrows its own error", async () => {
  const { conn, tab } = stub();
  const post = { requestId: "r2", request: { method: "POST", url: "https://api.example/gen/", headers: {}, hasPostData: true, postData: "not json" } };
  await assert.rejects(tab.interceptRequest("*/gen/*", () => { throw new Error("transform failed"); }, async () => { conn.emit("Fetch.requestPaused", post); }), /transform failed/);
  assert.deepEqual(calls(conn, "Fetch.failRequest"), [{ requestId: "r2", errorReason: "Aborted" }]);
  assert.deepEqual(calls(conn, "Fetch.continueRequest"), [], "an aborted request is never also continued");
});

test("a finished call leaves no handler of its own on the connection", async () => {
  const a = stub();
  await a.tab.interceptRequest("*/gen/*", (b) => b, async () => { a.conn.emit("Fetch.requestPaused", { requestId: "r", request: { method: "POST", headers: {}, postData: "{}" } }); });
  assert.equal(a.conn.handlerCount("Fetch.requestPaused"), 0);
  const b = stub({ n: "{}" });
  await b.tab.expectResponse(() => true, async () => {
    b.conn.emit("Network.requestWillBeSent", { requestId: "n", request: { method: "POST", url: "u" }, initiator: { type: "script" } });
    b.conn.emit("Network.responseReceived", { requestId: "n", response: { url: "u", status: 200, mimeType: "" } });
    b.conn.emit("Network.loadingFinished", { requestId: "n" });
  });
  assert.equal(b.conn.handlerCount("Network.requestWillBeSent", "Network.loadingFinished", "Network.responseReceived"), 0);
});

test("expectResponse: a response typed Preflight is skipped even when its request was never seen", async () => {
  const { conn, tab } = stub({ p: "", n: "ok" });
  const r = await tab.expectResponse(() => true, async () => {
    conn.emit("Network.responseReceived", { requestId: "p", type: "Preflight", response: { url: "u", status: 204, mimeType: "" } });
    conn.emit("Network.loadingFinished", { requestId: "p" });
    conn.emit("Network.responseReceived", { requestId: "n", type: "Fetch", response: { url: "u", status: 200, mimeType: "" } });
    conn.emit("Network.loadingFinished", { requestId: "n" });
  });
  assert.equal(r.body, "ok");
});

test("an action that throws cancels the abandoned wait at once: nothing is left waiting for its timeout (the process can exit)", async () => {
  const a = stub();
  await assert.rejects(a.tab.interceptRequest("*/x", (b) => b, async () => { throw new Error("click failed"); }, 60_000), /click failed/);
  assert.equal(a.conn.state.waiting, 0, "interceptRequest: no wait left");
  const b = stub();
  await assert.rejects(b.tab.expectResponse(() => true, async () => { throw new Error("click failed"); }, 60_000), /click failed/);
  assert.equal(b.conn.state.waiting, 0, "expectResponse: no wait left");
});

test("the real CDPConnection.waitForEvent: an aborted signal rejects it at once and removes its handler and timer", async () => {
  const conn: any = Object.create(CDPConnection.prototype); // no socket: waitForEvent only needs the handler table
  conn.handlers = new Map();
  const cancel = new AbortController();
  const wait = conn.waitForEvent("Fetch.requestPaused", { timeoutMs: 60_000, signal: cancel.signal });
  assert.equal(conn.handlers.get("Fetch.requestPaused").size, 1);
  cancel.abort();
  await assert.rejects(wait, /wait cancelled/);
  assert.equal(conn.handlers.get("Fetch.requestPaused").size, 0);
  // already aborted: it never registers a lasting handler
  await assert.rejects(conn.waitForEvent("Fetch.requestPaused", { timeoutMs: 60_000, signal: cancel.signal }), /wait cancelled/);
  assert.equal(conn.handlers.get("Fetch.requestPaused").size, 0);
  // an event still resolves it, and a later abort changes nothing
  const live = new AbortController();
  const got = conn.waitForEvent("X", { timeoutMs: 60_000, signal: live.signal });
  conn.handlers.get("X").forEach((h: any) => h({ ok: 1 }, "S"));
  assert.deepEqual(await got, { ok: 1 });
  live.abort();
  assert.equal(conn.handlers.get("X").size, 0);
});

test("watchResponses: records the status of every matching response until stop(), and nothing after", async () => {
  const { conn, tab } = stub();
  const w = await tab.watchResponses((u) => u.includes("studio-api"));
  conn.emit("Network.responseReceived", { requestId: "a", response: { url: "https://studio-api-prod.suno.com/api/x", status: 429 } });
  conn.emit("Network.responseReceived", { requestId: "b", response: { url: "https://cdn.example/y.js", status: 200 } });
  conn.emit("Network.responseReceived", { requestId: "c", response: { url: "https://studio-api-prod.suno.com/api/z", status: 200 } }, "another-session");
  w.stop();
  conn.emit("Network.responseReceived", { requestId: "d", response: { url: "https://studio-api-prod.suno.com/api/late", status: 500 } });
  assert.deepEqual(w.seen, [{ url: "https://studio-api-prod.suno.com/api/x", status: 429 }]);
  assert.equal(conn.handlerCount("Network.responseReceived"), 0);
  assert.ok(calls(conn, "Network.enable").length >= 1, "Network is enabled for the watch");
});
