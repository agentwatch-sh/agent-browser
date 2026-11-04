// The relay (agent mode's CDP endpoint) end to end: real CDP clients on its Unix socket, and the fake receiver of
// fake-bridge.ts behind its bridge. The vectors are the C11 copies of relay-policy.test.ts (chrome-extension 5021038).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { CDPConnection } from "../src/cdp.ts";
import { harness, raw, UA, until, type Harness } from "./fake-bridge.ts";
import { BIN_JS } from "./helpers.ts";

const endpointV = JSON.parse(readFileSync(new URL("./vectors/chrome-extension-5021038/endpoint.json", import.meta.url), "utf8"));

/** A tab of the connection's own, opened with auto-attach on: its target id, its session and the fake's tab. */
async function page(h: Harness, c: CDPConnection, wait = false) {
  await c.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: wait, flatten: true });
  const order: string[] = [];
  const attached = c.waitForEvent("Target.attachedToTarget").then((e) => { order.push("attached"); return e; });
  const { targetId } = await c.send("Target.createTarget", { url: "about:blank" });
  order.push("answer");
  const ev = await attached;
  assert.deepEqual(order, ["attached", "answer"], "Playwright needs Target.attachedToTarget before the answer");
  return { targetId, sessionId: ev.sessionId as string, info: ev.targetInfo, tab: [...h.fake.tabs.values()].find((t) => t.targetId === targetId)! };
}

const failure = (p: Promise<unknown>) => p.then(() => "no error", (e: Error) => e.message.replace(/^[A-Za-z]+\.[A-Za-z]+: /, ""));

test("the endpoint refuses connections until the extension is linked, confirmed the allowlist and knows the bridge", async () => {
  const h = await harness();
  try {
    assert.deepEqual(await raw(h.url("s1")).then((r) => [r.status, r.body]), [503, endpointV.upgradeAnswers[2].body]);
    h.fake.line({ t: "link", up: true, version: "0.2.0" });
    await until(() => h.fake.sent("bridge.info").length, "bridge.info");
    assert.deepEqual(await raw(h.url("s1")).then((r) => [r.status, r.body]), [503, endpointV.upgradeAnswers[3].body]);
    await h.ready();
    // The first link up clears the six content-setting types; the allowlist sets automatic downloads for its domains.
    await until(() => h.fake.sent("contentSettings.set").length, "the automatic-downloads setting");
    assert.deepEqual(h.fake.sent("contentSettings.clear").slice(0, 6).map((r) => r.args[0]), ["location", "notifications", "camera", "microphone", "clipboard", "automaticDownloads"]);
    assert.deepEqual(h.fake.sent("contentSettings.set").map((r) => r.args), [["automaticDownloads", { primaryPattern: "*://*.a.example/*", setting: "allow" }]]);
    assert.deepEqual(await raw(h.url("s1"), { Origin: "https://a.example" }).then((r) => [r.status, r.body]), [403, endpointV.upgradeAnswers[1].body]);
    for (const path of ["/devtools/browser/.x", "/devtools/browser/a%2Fb", "/json/version", "/devtools/page/T7"]) {
      assert.deepEqual(await raw(`ws+unix://${h.socket}:${path}`).then((r) => [r.status, r.body]), [404, endpointV.upgradeAnswers[0].body], path);
    }
    const c = await h.connect();
    assert.deepEqual(await c.send("Browser.getVersion"), { protocolVersion: "1.3", product: "Chrome/1.0.0.0", revision: "", userAgent: UA, jsVersion: "" });
    assert.ok(h.fake.attachNew, "the eager attach is on while a connection is open");
    // A receiver before stage 2 answers unknown op to bridge.info: too old, so the endpoint fails closed.
    h.fake.op = ({ op }) => (op === "bridge.info" ? { error: "unknown op" } : undefined);
    h.fake.line({ t: "link", up: false });
    await c.closedPromise;
    const asked = h.fake.sent("bridge.info").length;
    h.fake.line({ t: "link", up: true, version: "0.1.0" });
    h.fake.line({ t: "allowlist", domains: ["a.example"] });
    await until(() => h.fake.sent("bridge.info").length > asked && h.relay.model.notReady() === endpointV.upgradeAnswers[4].body, "the too-old answer");
    assert.deepEqual(await raw(h.url("s1")).then((r) => [r.status, r.body]), [503, endpointV.upgradeAnswers[4].body]);
  } finally { await h.close(); }
});

test("every refusal of the vectors gets its exact text before any bridge request", async () => {
  const h = await harness();
  try {
    await h.ready();
    const c = await h.connect();
    const { sessionId } = await page(h, c);
    await new Promise((r) => setTimeout(r, 20));
    // These need another connection, the bridge's answers or a small MAX_REQUEST: their own tests below.
    const elsewhere = /Another connection|receiver answered|MAX_REQUEST/;
    for (const v of endpointV.refusals.filter((v: any) => !elsewhere.test(v.note ?? ""))) {
      const before = h.fake.requests.length;
      const sid = v.session === "page" ? (/does not hold/.test(v.note ?? "") ? "NOT-A-SESSION" : sessionId) : undefined;
      assert.equal(await failure(c.send(v.method, v.params, sid)), v.error, `${v.session} ${v.method}`);
      // Only the window check reads which tabs a window holds.
      assert.deepEqual(h.fake.requests.slice(before).filter((r) => r.op !== "tabs.query"), [], `${v.method} reached the bridge`);
    }
    // Playwright sends Runtime.addBinding again for each new page after a refused exposeFunction: each page refuses it.
    const second = await page(h, c);
    assert.equal(await failure(c.send("Runtime.addBinding", { name: "__playwright__binding__" }, second.sessionId)), endpointV.templates[11]);
    // The passes reach Chrome as they are, on the page's own target.
    for (const v of endpointV.passes) {
      const before = h.fake.requests.length;
      await c.send(v.method, v.params, v.session === "page" ? sessionId : undefined);
      const reached = h.fake.requests.slice(before).find((r) => (r.op === "debugger.sendCommand" && r.args[1] === v.method) || (r.op === "tabs.create" && v.method === "Target.createTarget"));
      assert.ok(reached, `${v.method} did not reach Chrome`);
      if (reached.op === "debugger.sendCommand") assert.deepEqual(reached.args[2], v.params);
    }
  } finally { await h.close(); }
});

test("a tab belongs to one connection of its scope; another scope never sees it; the owner's leave frees it", async () => {
  const h = await harness();
  try {
    await h.ready();
    const a = await h.connect("s1"), b = await h.connect("s1"), other = await h.connect("s2");
    const { targetId, info, tab } = await page(h, a);
    assert.equal(info.browserContextId, "agentwatch-default");
    assert.deepEqual((await b.send("Target.getTargets")).targetInfos.map((t: any) => [t.targetId, t.attached]), [[targetId, true]]);
    assert.equal(await failure(b.send("Target.attachToTarget", { targetId, flatten: true })), endpointV.templates[15]);
    assert.deepEqual((await other.send("Target.getTargets")).targetInfos, []);
    for (const method of ["Target.attachToTarget", "Target.closeTarget", "Target.activateTarget", "Target.getTargetInfo", "Browser.getWindowForTarget"]) {
      assert.equal(await failure(other.send(method, { targetId })), "No target with given id found", method);
    }
    await a.close();
    await until(() => h.fake.sent("debugger.detach").some((r) => r.args[0] === tab.id), "the detach of the owner's tab");
    const { sessionId } = await b.send("Target.attachToTarget", { targetId, flatten: true });
    await b.send("Runtime.evaluate", { expression: "1" }, sessionId);
    assert.deepEqual(h.fake.sent("debugger.sendCommand", "Runtime.evaluate").at(-1)!.args[0], { tabId: tab.id });
    assert.deepEqual((await b.send("Target.getTargetInfo", {}, sessionId)).targetInfo.browserContextId, "agentwatch-default");
  } finally { await h.close(); }
});

test("each popup goes to its opener's owner, held until its runIfWaitingForDebugger is answered; a tab with no opener is in no scope", async () => {
  const h = await harness();
  try {
    await h.ready();
    const a = await h.connect("s1"), b = await h.connect("s1");
    await b.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    const opener = await page(h, a, true);
    let toB = 0;
    b.on("Target.attachedToTarget", () => toB++);
    for (let i = 0; i < 5; i++) {
      const attached = a.waitForEvent("Target.attachedToTarget");
      const popup = h.fake.newTab(`https://a.example/popup${i}`, opener.tab);
      const ev = await attached;
      assert.deepEqual([ev.waitingForDebugger, ev.targetInfo.openerId, ev.targetInfo.targetId], [true, opener.targetId, popup.targetId]);
      assert.ok(!h.fake.sent("bridge.release").some((r) => r.args[0] === popup.id), "released before the client was ready");
      await a.send("Runtime.runIfWaitingForDebugger", {}, ev.sessionId);
      await until(() => h.fake.sent("bridge.release").some((r) => r.args[0] === popup.id), "the release of the popup");
    }
    assert.equal(toB, 0);
    const stray = h.fake.newTab("https://a.example/operator");
    await until(() => h.fake.sent("debugger.detach").some((r) => r.args[0] === stray.id), "the detach of a tab in no scope");
    assert.ok(h.fake.sent("bridge.release").some((r) => r.args[0] === stray.id));
    assert.ok(!(await a.send("Target.getTargets")).targetInfos.some((t: any) => t.targetId === stray.targetId));
  } finally { await h.close(); }
});

test("a command that timed out detaches its tab, which returns to its auto-attach owner; a promise wait leaves it attached", async () => {
  const h = await harness();
  try {
    await h.ready();
    const c = await h.connect();
    const { sessionId, tab } = await page(h, c);
    h.fake.command = (_t, method) => (method === "Page.navigate" || method === "Runtime.evaluate" ? { error: "timeout" } : undefined);
    const detached = c.waitForEvent("Target.detachedFromTarget"), again = c.waitForEvent("Target.attachedToTarget");
    assert.equal(await failure(c.send("Page.navigate", { url: "https://a.example/" }, sessionId)), "The agent browser did not answer Page.navigate in 600 s.");
    assert.equal((await detached).sessionId, sessionId);
    const fresh = (await again).sessionId;
    assert.notEqual(fresh, sessionId);
    assert.equal(h.fake.sent("debugger.detach").filter((r) => r.args[0] === tab.id).length, 1);
    assert.equal(await failure(c.send("Runtime.evaluate", { expression: "new Promise(() => {})", awaitPromise: true }, fresh)), endpointV.refusals.at(-1).error);
    assert.equal(await failure(c.send("Page.captureScreenshot", {}, sessionId)), "Session with given id not found.");
    h.fake.command = (_t, method) => (method === "Page.captureScreenshot" ? { error: "too large" } : undefined);
    assert.equal(await failure(c.send("Page.captureScreenshot", { captureBeyondViewport: true }, fresh)), endpointV.refusals.find((v: any) => /too large/.test(v.note ?? "")).error);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(h.fake.sent("debugger.detach").filter((r) => r.args[0] === tab.id).length, 1, "a promise wait or a large answer detaches nothing");
  } finally { await h.close(); }
});

test("the relay hides cookie values, adds the mouse force, and answers an event too large for the link", async () => {
  const h = await harness();
  try {
    await h.ready();
    const c = await h.connect();
    const { sessionId, tab } = await page(h, c);
    const v = endpointV.cookieHide[0];
    const got = c.waitForEvent(v.method, { sessionId });
    h.fake.emit("debugger.onEvent", { source: { tabId: tab.id }, method: v.method, params: v.in });
    assert.deepEqual(await got, v.out);
    await c.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 5, y: 5, button: "left", clickCount: 1 }, sessionId);
    assert.equal(h.fake.sent("debugger.sendCommand", "Input.dispatchMouseEvent")[0].args[2].force, 0.5);
    h.fake.emit("bridge.tooLarge", { of: "debugger.onEvent", tabId: tab.id, sessionId: "A1B2C3", method: "Fetch.requestPaused", requestId: "interception-job-4.0" });
    h.fake.emit("bridge.tooLarge", { of: "debugger.onEvent", tabId: tab.id, method: "Page.javascriptDialogOpening" });
    await until(() => h.fake.sent("debugger.sendCommand", "Page.handleJavaScriptDialog").length, "the dialog's default action");
    assert.deepEqual(h.fake.sent("debugger.sendCommand", "Fetch.continueRequest")[0].args, [{ tabId: tab.id, sessionId: "A1B2C3" }, "Fetch.continueRequest", { requestId: "interception-job-4.0" }]);
    assert.deepEqual(h.fake.sent("debugger.sendCommand", "Page.handleJavaScriptDialog")[0].args, [{ tabId: tab.id }, "Page.handleJavaScriptDialog", { accept: false }]);
  } finally { await h.close(); }
});

test("permissions become content settings for allowlisted origins only, and go when their connection resets or leaves", async () => {
  const h = await harness();
  try {
    await h.ready();
    await until(() => h.fake.sent("contentSettings.set").length, "the allowlist's settings");
    const c = await h.connect();
    const sets = () => h.fake.sent("contentSettings.set").map((r) => r.args).slice(1);
    await c.send("Browser.grantPermissions", { permissions: ["geolocation"] });
    await c.send("Browser.grantPermissions", { permissions: ["clipboardReadWrite"], origin: "https://a.example:8443" });
    assert.deepEqual(sets(), [["location", { primaryPattern: "*://*.a.example/*", setting: "allow" }], ["clipboard", { primaryPattern: "https://a.example:8443/*", setting: "allow" }]]);
    const clears = h.fake.sent("contentSettings.clear").length;
    await c.send("Browser.resetPermissions");
    assert.deepEqual(h.fake.sent("contentSettings.clear").slice(clears).map((r) => r.args[0]).sort(), ["clipboard", "location"]);
    assert.equal(sets().length, 2, "a reset grants nothing again");
    await c.send("Browser.grantPermissions", { permissions: ["notifications"] });
    await c.close();
    await until(() => h.fake.sent("contentSettings.clear").at(-1)?.args[0] === "notifications", "the clear at the leave");
  } finally { await h.close(); }
});

test("a download reaches the client's folder under its guid; cancel and a dangerous file end it as canceled", async () => {
  const h = await harness();
  const dir = mkdtempSync(join(tmpdir(), "ab-dl-"));
  try {
    await h.ready();
    const c = await h.connect();
    const { tab } = await page(h, c);
    await c.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: dir, eventsEnabled: true });
    const saved = join(dir, "chrome-saved.txt");
    writeFileSync(saved, "file content");
    h.fake.downloads.push({ id: 3, url: "https://a.example/f.txt", filename: saved, state: "complete" });
    const ev = (method: string, params: object) => h.fake.emit("debugger.onEvent", { source: { tabId: tab.id }, method, params });
    const begin = c.waitForEvent("Browser.downloadWillBegin");
    const done = c.waitForEvent("Browser.downloadProgress", { predicate: (p: any) => p.guid === "g1" && p.state === "completed" });
    ev("Page.downloadWillBegin", { frameId: "F1", guid: "g1", url: "https://a.example/f.txt", suggestedFilename: "f.txt" });
    h.fake.emit("downloads.onCreated", { item: { id: 3, url: "https://a.example/f.txt", state: "in_progress", danger: "safe" } });
    ev("Page.downloadProgress", { guid: "g1", totalBytes: 12, receivedBytes: 12, state: "completed" });
    assert.equal((await begin).guid, "g1");
    await done;
    assert.equal(readFileSync(join(dir, "g1"), "utf8"), "file content");
    ev("Page.downloadWillBegin", { frameId: "F1", guid: "g2", url: "https://a.example/big.bin", suggestedFilename: "big.bin" });
    h.fake.emit("downloads.onCreated", { item: { id: 4, url: "https://a.example/big.bin", state: "in_progress" } });
    await new Promise((r) => setTimeout(r, 20));
    await c.send("Browser.cancelDownload", { guid: "g2" });
    assert.deepEqual(h.fake.sent("downloads.cancel").map((r) => r.args), [[4]]);
    const canceled = c.waitForEvent("Browser.downloadProgress", { predicate: (p: any) => p.guid === "g3" });
    ev("Page.downloadWillBegin", { frameId: "F1", guid: "g3", url: "https://a.example/x.exe", suggestedFilename: "x.exe" });
    h.fake.emit("downloads.onCreated", { item: { id: 5, url: "https://a.example/x.exe", state: "in_progress" } });
    h.fake.emit("downloads.onChanged", { delta: { id: 5, danger: { previous: "safe", current: "file" } } });
    assert.equal((await canceled).state, "canceled");
    assert.deepEqual(h.fake.sent("downloads.cancel").map((r) => r.args), [[4], [5]]);
  } finally { await h.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("each end of a connection has the contract's close code and reason", async () => {
  const h = await harness({ maxRequest: 1000 });
  try {
    await h.ready();
    const closes = endpointV.closes.map((x: any) => [x.code, x.reason]);
    const one = await raw(h.url("s1"));
    one.ws!.send(JSON.stringify({ id: 1, method: "Browser.close" }));
    assert.deepEqual(await one.closed, closes[0]);
    const big = await raw(h.url("s1"));
    big.ws!.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: "x".repeat(1000) } }));
    assert.equal((await big.closed)[0], 1009);
    const c = await h.connect("ab-lead");
    const { tab } = await page(h, c);
    const scoped = await raw(h.url("ab-lead")), kept = await raw(h.url("s1"));
    h.fake.line({ t: "end_scope", scope: "ab-lead" });
    assert.deepEqual(await scoped.closed, closes[1]);
    await until(() => h.fake.sent("tabs.remove").some((r) => r.args[0] === tab.id), "the removal of the scope's tab");
    h.fake.line({ t: "link", up: false });
    assert.deepEqual(await kept.closed, closes[2]);
    await h.ready();
    const last = await raw(h.url("s1"));
    h.fake.input.end();
    assert.deepEqual(await last.closed, closes[3]);
    await h.relay.closed;
    assert.ok(!existsSync(h.socket), "the relay removes its socket when its standard input ends");
  } finally { await h.close(); }
});

test("agent-browser relay serves the socket, writes only bridge requests on its standard output, and ends with its standard input", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-relay-"));
  const socket = join(dir, "cdp.sock");
  try {
    const child = spawn(process.execPath, [BIN_JS, "relay", "--socket", socket], { stdio: ["pipe", "pipe", "pipe"] });
    const out: any[] = [];
    createInterface({ input: child.stdout }).on("line", (l) => out.push(JSON.parse(l)));
    const exited = new Promise((r) => child.once("exit", r));
    await until(() => existsSync(socket), "the relay's socket", 20_000);
    child.stdin.write(`${JSON.stringify({ t: "link", up: true, version: "0.2.0" })}\n`);
    await until(() => out.length, "the relay's first request");
    assert.deepEqual([out[0].t, out[0].op, out[0].wait], ["req", "bridge.info", 30_000]);
    child.stdin.end();
    assert.equal(await exited, 0);
    assert.ok(!existsSync(socket));
    const usage = spawn(process.execPath, [BIN_JS, "relay"], { stdio: "ignore" });
    assert.equal(await new Promise((r) => usage.once("exit", r)), 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
