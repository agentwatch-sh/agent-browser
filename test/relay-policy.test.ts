// The relay's policy and its side of the bridge, checked against the shared vectors of contracts C10 and C11. The
// vectors are copies of agentwatch-sh/chrome-extension test/vectors/{bridge,endpoint}.json at commit ffaf794 (main,
// the merge of PR #5); the folder name names that commit. Copy them again when the contracts change.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Bridge, BridgeError, MAX_IN_FLIGHT_PER_TAB, MAX_REQUEST, WAIT_DEFAULT_MS, WAIT_MAX_MS } from "../src/relay/bridge.ts";
import { SCOPE, NOT_FOUND, FROM_PAGE } from "../src/relay/endpoint.ts";
import { CLOSE, NOT_READY } from "../src/relay/model.ts";
import { cdpError, COOKIE_MARKER, DEFAULT_CONTEXT, hideCookies, MODEL_SET, PAGE_MODEL_SET, route, tooLargeAction, withForce } from "../src/relay/policy.ts";

const vectors = (name: string) => JSON.parse(readFileSync(new URL(`./vectors/chrome-extension-ffaf794/${name}.json`, import.meta.url), "utf8"));
const bridgeV = vectors("bridge"), endpointV = vectors("endpoint");

test("the constants, the default context, the marker, the 404, 403 and 503 bodies and the close codes are the contracts'", () => {
  const c = bridgeV.constants;
  assert.deepEqual([WAIT_DEFAULT_MS, WAIT_MAX_MS, MAX_IN_FLIGHT_PER_TAB, MAX_REQUEST], [c.WAIT_DEFAULT_MS, c.WAIT_MAX_MS, c.MAX_IN_FLIGHT_PER_TAB, c.MAX_REQUEST]);
  assert.equal(DEFAULT_CONTEXT, endpointV.defaultContext);
  assert.equal(COOKIE_MARKER, endpointV.cookieMarker);
  assert.deepEqual([NOT_FOUND, FROM_PAGE, NOT_READY.link, NOT_READY.allowlist, NOT_READY.old], endpointV.upgradeAnswers.map((a: any) => a.body));
  assert.deepEqual([CLOSE.browserClose, CLOSE.scopeEnded, CLOSE.linkDown, CLOSE.stopped], endpointV.closes.map((x: any) => [x.code, x.reason]));
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
