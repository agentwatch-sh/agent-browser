// The relay's policy and its side of the bridge, checked against the shared vectors of contracts C10 and C11. The
// vectors are copies of agentwatch-sh/chrome-extension test/vectors/{bridge,endpoint,scopes}.json at commit 40c2d93
// (main, the merge of PR #22: the receiver 0.3.2; its endpoint.json and scopes.json, with the peer check's vectors of
// board ab-v16.50, are the same as at c99bebb); the folder name names that commit. Copy them again when the contracts
// change.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Bridge, BridgeError, MAX_IN_FLIGHT_PER_TAB, MAX_REQUEST, WAIT_DEFAULT_MS, WAIT_MAX_MS } from "../src/relay/bridge.ts";
import { SCOPE, NOT_FOUND, FROM_PAGE } from "../src/relay/endpoint.ts";
import { CLOSE, NOT_READY, TAB_SCOPE_WAIT_MS } from "../src/relay/model.ts";
import { PEER_UNREAD, SELF_TEST_MS, sessionRefusal } from "../src/relay/peer.ts";
import { cdpError, contextOfObject, contextsNamed, COOKIE_MARKER, DEFAULT_CONTEXT, hideCookies, MODEL_SET, PAGE_MODEL_SET, route, tooLargeAction, withForce } from "../src/relay/policy.ts";

const vectors = (name: string) => JSON.parse(readFileSync(new URL(`./vectors/chrome-extension-40c2d93/${name}.json`, import.meta.url), "utf8"));
const bridgeV = vectors("bridge"), endpointV = vectors("endpoint");

test("the constants, the default context, the marker, the 404, 403 and 503 bodies and the close codes are the contracts'", () => {
  const c = bridgeV.constants;
  assert.deepEqual([WAIT_DEFAULT_MS, WAIT_MAX_MS, MAX_IN_FLIGHT_PER_TAB, MAX_REQUEST], [c.WAIT_DEFAULT_MS, c.WAIT_MAX_MS, c.MAX_IN_FLIGHT_PER_TAB, c.MAX_REQUEST]);
  assert.equal(DEFAULT_CONTEXT, endpointV.defaultContext);
  assert.equal(COOKIE_MARKER, endpointV.cookieMarker);
  const body = (id: string) => endpointV.upgradeAnswers.find((a: any) => a.id === id).body;
  assert.deepEqual([NOT_FOUND, FROM_PAGE, NOT_READY.link, NOT_READY.allowlist, NOT_READY.old, NOT_READY.noList],
    ["notFound", "fromPage", "notConnected", "notConfirmed", "tooOld", "noList"].map(body));
  // The peer check's 403s and 503s (board ab-v16.51).
  assert.deepEqual([PEER_UNREAD, sessionRefusal(3102), NOT_READY.roots, NOT_READY.cannotRead],
    [body("peerUnread"), body("session").replace("<pid>", "3102"), body("rootsWithout"), body("cannotRead")]);
  assert.deepEqual([CLOSE.browserClose, CLOSE.scopeEnded, CLOSE.linkDown, CLOSE.stopped, CLOSE.noList, CLOSE.root],
    endpointV.closes.map((x: any) => [x.code, x.reason]));
  assert.equal(TAB_SCOPE_WAIT_MS, endpointV.constants.TAB_SCOPE_WAIT_MS);
  assert.equal(SELF_TEST_MS, endpointV.constants.SELF_TEST_MS);
});

test("a scope matches the contract's pattern", () => {
  assert.equal(SCOPE.source, endpointV.scope.pattern);
  for (const s of endpointV.scope.valid) assert.ok(SCOPE.test(s), s);
  for (const s of endpointV.scope.invalid) assert.ok(!SCOPE.test(s), JSON.stringify(s));
});

test("the model's call sets are the contract's", () => {
  assert.deepEqual([...MODEL_SET].sort(), [...endpointV.modelSet].sort());
  assert.deepEqual([...PAGE_MODEL_SET].sort(), [...endpointV.pageModelSet].sort());
});

test("each call goes where the routing vectors say", () => {
  const to = (r: ReturnType<typeof route>) => (typeof r === "object" ? "refused" : r === "model" ? "the model" : "Chrome");
  for (const v of endpointV.routing) assert.equal(to(route(v.method, v.params, v.session === "page", { child: !!v.child })), v.to, `${v.session} ${v.method}`);
  for (const v of endpointV.passes) assert.notEqual(to(route(v.method, v.params, v.session === "page")), "refused", `${v.session} ${v.method}`);
});

// The master of C11's vectors (test/vectors/endpoint.json, in this repository since stage 0): its routing rows and its
// refusals of the sign-in act's methods (board ab-v16.97.1, review-112 B6). The relay and the service share route():
// AgentBrowser.* is refused on a page session (C11's table), so it never reaches Chrome, and on the root it is outside
// the set until the service's model has the act (stage 1e part 2; the row's withAct).
test("the master's routing vectors: each call goes where they say, and the sign-in act's methods are refused on a page session with the model's text", () => {
  const master = JSON.parse(readFileSync(new URL("./vectors/endpoint.json", import.meta.url), "utf8"));
  const to = (r: ReturnType<typeof route>) => (typeof r === "object" ? "refused" : r === "model" ? "the model" : "Chrome");
  for (const v of master.routing) assert.equal(to(route(v.method, v.params, v.session === "page", { child: !!v.child })), v.to, `${v.session} ${v.method}`);
  const signIn = master.refusals.filter((v: any) => v.method.startsWith("AgentBrowser."));
  assert.deepEqual(signIn.map((v: any) => [v.session, v.method]), [["page", "AgentBrowser.signIn"], ["page", "AgentBrowser.signIns"]]);
  for (const v of signIn) assert.deepEqual(route(v.method, v.params, true), { refused: v.error }, v.method);
  assert.deepEqual(route("AgentBrowser.anyOther", {}, true), { refused: "Not available in the agent browser: AgentBrowser.anyOther." }, "the whole domain");
});

test("each refusal vector that needs no model state gets its exact text from the policy", () => {
  for (const v of endpointV.refusals) {
    const r = route(v.method, v.params, v.session === "page");
    if (typeof r === "object") assert.equal(r.refused, v.error, `${v.session} ${v.method}`);
    // The rest need the model: another connection's tab, a window, a session, a context, a permission, the bridge's answers.
    else assert.ok(v.note || v.example || /^(Target|Browser)\./.test(v.method), `${v.session} ${v.method} must be refused`);
  }
});

test("the cookie marker hides every cookie value of the cookieHide vectors, at any depth", () => {
  for (const v of endpointV.cookieHide) assert.deepEqual(hideCookies(v.in), v.out, v.method);
  // No secret of the inputs survives.
  assert.ok(!JSON.stringify(endpointV.cookieHide.map((v: any) => hideCookies(v.in))).includes("s3cr3t"));
});

test("a too-large event gets the default action of the bridge vectors", () => {
  const actions = bridgeV.eventVectors.filter((v: any) => v.ev.ev === "bridge.tooLarge").map((v: any) => tooLargeAction(v.ev));
  assert.deepEqual(actions, [null, ["Fetch.continueRequest", { requestId: "interception-job-4.0" }],
    ["Fetch.continueWithAuth", { requestId: "interception-job-5.0", authChallengeResponse: { response: "CancelAuth" } }],
    ["Page.handleJavaScriptDialog", { accept: false }],
    null, null, null, null]); // tabs.onUpdated, tabs.onCreated, webNavigation and downloads.onCreated: no action
});

test("a mouse press with no force gets 0.5; a release, a move without buttons and a given force stay", () => {
  assert.equal(withForce("Input.dispatchMouseEvent", { type: "mousePressed", x: 1, y: 1 }).force, 0.5);
  assert.equal(withForce("Input.dispatchMouseEvent", { type: "mouseMoved", buttons: 1 }).force, 0.5);
  assert.equal(withForce("Input.dispatchMouseEvent", { type: "mousePressed", force: 0 }).force, 0);
  assert.equal(withForce("Input.dispatchMouseEvent", { type: "mouseReleased" }).force, undefined);
  assert.equal(withForce("Input.dispatchMouseEvent", { type: "mouseMoved" }).force, undefined);
});

test("the bridge's error answers become C11's texts; Chrome's JSON errors keep their code", () => {
  assert.equal(cdpError("Runtime.evaluate", new BridgeError("timeout", WAIT_MAX_MS)).message, "The agent browser did not answer Runtime.evaluate in 600 s.");
  assert.equal(cdpError("Target.createTarget", new BridgeError("timeout", WAIT_DEFAULT_MS)).message, "The agent browser did not answer Target.createTarget in 30 s.");
  assert.equal(cdpError("Page.captureScreenshot", new BridgeError("too large", WAIT_MAX_MS)).message, "The answer of Page.captureScreenshot is larger than the agent browser's link allows (128 MiB).");
  assert.deepEqual(cdpError("Runtime.evaluate", new BridgeError('{"code":-32601,"message":"\'Foo.bar\' wasn\'t found"}', WAIT_MAX_MS)), { code: -32601, message: "'Foo.bar' wasn't found" });
  assert.equal(cdpError("Page.navigate", new BridgeError("No tab with id: 7.", WAIT_MAX_MS)).message, "No tab with id: 7.");
});

test("the bridge sends C10 requests: an id with an 8-hex prefix, the args in a list, each op's default wait", async () => {
  const lines: any[] = [];
  const b = new Bridge((l) => lines.push(JSON.parse(l)));
  const waits = Object.fromEntries(bridgeV.ops.map((o: any) => [o.op, bridgeV.constants[o.defaultWait]]));
  for (const o of bridgeV.ops) void b.call(o.op, []).catch(() => {});
  assert.deepEqual(lines.map((l) => l.wait), bridgeV.ops.map((o: any) => waits[o.op]));
  assert.ok(lines.every((l, i) => l.t === "req" && l.op === bridgeV.ops[i].op && Array.isArray(l.args) && l.id === `${lines[0].id.split("-")[0]}-${i + 1}`));
  assert.match(lines[0].id, /^[0-9a-f]{8}-1$/);
  b.answer({ id: lines[0].id, ok: true, data: { already: false } });
  b.answer({ id: "00000000-1", ok: true, data: null }); // another relay's late answer changes nothing
  b.dropAll();
});

test("at most 64 requests per tab are in flight; the next wait in order, and another tab is never kept back", async () => {
  const lines: any[] = [];
  const b = new Bridge((l) => lines.push(JSON.parse(l)));
  const done: number[] = [];
  for (let i = 0; i < 66; i++) void b.call("debugger.sendCommand", [{ tabId: 7 }, "Runtime.evaluate", { expression: String(i) }]).then(() => done.push(i), () => {});
  void b.call("tabs.get", [8]).catch(() => {});
  void b.call("tabs.query", [{}]).catch(() => {});
  assert.equal(lines.filter((l) => l.args[0]?.tabId === 7).length, 64);
  assert.deepEqual(lines.slice(64).map((l) => l.op), ["tabs.get", "tabs.query"]);
  b.answer({ id: lines[3].id, ok: true, data: {} });
  assert.equal(lines.at(-1).args[2].expression, "64");
  b.answer({ id: lines[0].id, ok: true, data: {} });
  assert.equal(lines.at(-1).args[2].expression, "65");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(done, [3, 0]);
  const rejected = b.call("tabs.get", [7]).catch((e) => e.message);
  b.dropAll();
  assert.equal(await rejected, "disconnected");
});

test("a request above MAX_REQUEST is never written", async () => {
  const lines: string[] = [];
  const b = new Bridge((l) => lines.push(l), { maxRequest: 200 });
  await assert.rejects(b.call("debugger.sendCommand", [{ tabId: 7 }, "Runtime.callFunctionOn", { functionDeclaration: "(b) => b", arguments: [{ value: "x".repeat(200) }] }]),
    (e: BridgeError) => cdpError("Runtime.callFunctionOn", e).message === "The command is too large for the agent browser: Runtime.callFunctionOn.");
  assert.equal(lines.length, 0);
});

test("ab-v16.80 (review-72 note 4): an object id or a call-frame id names its context as V8 writes it, <isolate>.<context>.<n>; any other form names none", () => {
  assert.equal(contextOfObject("-5135176979714057620.6.1"), 6, "a negative isolate (measured on Chromium 156)");
  assert.equal(contextOfObject("7383208963520036829.12.40"), 12);
  assert.equal(contextOfObject("-1.55.1"), 55, "55, not 5: the whole number between the dots");
  assert.equal(contextOfObject("-1.5.155"), 5);
  for (const id of ['{"injectedScriptId":5,"id":1}', "5", "1.5", "a.5.1", "1.5.1.2", "", "-1.-5.1", "1.5.x"])
    assert.equal(contextOfObject(id), null, `not V8's form (the old JSON form is not parsed): ${id}`);
});

test("ab-v16.80 (review-72 note 4): the contexts that a call names: contextId, executionContextId, the object ids and call-frame ids down to 3 levels", () => {
  assert.deepEqual(contextsNamed({ expression: "1", contextId: 5 }), [5]);
  assert.deepEqual(contextsNamed({ functionDeclaration: "f", executionContextId: 7, objectId: "-1.55.1", arguments: [{ value: 5 }, { objectId: "-1.8.2" }] }), [7, 55, 8]);
  assert.deepEqual(contextsNamed({ promiseObjectId: "-1.3.1", prototypeObjectId: "-1.4.1", errorObjectId: "-1.9.1" }), [3, 4, 9]);
  assert.deepEqual(contextsNamed({ callFrameId: "-1.6.0", newValue: { objectId: "-1.2.1" } }), [6, 2]);
  assert.deepEqual(contextsNamed({ contextId: "5", executionContextId: 5.5, objectId: 5, value: { n: 5 } }), [], "no id of another type, no plain value");
  assert.deepEqual(contextsNamed({ a: { b: { c: { objectId: "-1.4.1" } } } }), [4], "3 levels down");
  assert.deepEqual(contextsNamed({ a: { b: { c: { d: { objectId: "-1.4.1" } } } } }), [], "not 4");
  assert.deepEqual(contextsNamed(undefined), []);
});
