// No browser starts: the real relay and CLI use the fake carrier and Chrome.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentBrowser } from "../src/browser.ts";
import { commands } from "../src/commands.ts";
import { NotAllowedError } from "../src/errors.ts";
import { resolveOptions } from "../src/options.ts";
import { stopProxy } from "../src/proxy.ts";
import { planRecording } from "../src/record.ts";
import * as policy from "../src/relay/policy.ts";
import { Bridge } from "../src/relay/bridge.ts";
import { backByChrome, harness, lineOf, until } from "./fake-bridge.ts";
import { FakeChrome } from "./fake-chrome.ts";
import { consumer, FIXTURE_HOST, fixtureServer, site } from "./helpers.ts";

const baseError = "Not allowed: b.example is not on the allowlist";
const prompted = baseError + ". The operator has a Browser permission prompt in the agentwatch web viewer. Tell the operator; after the notice that the operator added b.example, start the step again.";

for (const carrier of ["ok", "unknown op", "bad args", "silent", "late"]) {
  test(`navigation refusal reports its host and scope; carrier ${carrier} controls the prompt text`, async () => {
    const h = await harness();
    try {
      h.fake.daemon = ({ op }) => op !== "daemon.blocked" ? { error: "unknown op" }
        : carrier === "ok" ? {} : ["silent", "late"].includes(carrier) ? undefined : { error: carrier };
      await h.ready();
      const c = await h.connect("scope-a");
      await c.send("Target.setAutoAttach", { autoAttach: true, flatten: true });
      const attached = c.waitForEvent("Target.attachedToTarget");
      await c.send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await attached;
      for (const [method, params, sid] of [
        ["Page.navigate", { url: "https://b.example/private?secret=hidden" }, sessionId],
        ["Page.navigate", { url: "blob:https://b.example/hidden" }, sessionId],
        ["Target.createTarget", { url: "https://b.example/hidden" }, undefined],
      ] as const) {
        const before = h.fake.requests.length, start = Date.now();
        const message = await c.send(method, params, sid).then(() => "no refusal", (e: Error) => e.message.replace(/^[A-Za-z]+\.[A-Za-z]+: /, ""));
        assert.equal(message, carrier === "ok" ? prompted : baseError);
        assert.ok(Date.now() - start < 1500, "a failed or absent carrier cannot hold the refusal");
        assert.deepEqual(h.fake.requests.slice(before), [], "no refused call reaches Chrome");
        const req = h.fake.daemonRequests.at(-1)!;
        assert.equal(req.op, "daemon.blocked");
        assert.deepEqual(req.args, [{ host: "b.example", scope: "scope-a" }]);
        assert.equal(req.wait, 250);
        if (carrier === "late") h.fake.line({ t: "res", ch: "bridge", id: req.id, ok: true, data: {} });
      }
      const before = h.fake.daemonRequests.length;
      await assert.rejects(c.send("Browser.grantPermissions", { permissions: ["geolocation"], origin: "https://b.example" }), /not on the allowlist$/);
      assert.equal(h.fake.daemonRequests.length, before, "a permission refusal promises no navigation prompt");
      for (const host of ["localhost", "127.0.0.1", "intranet"]) {
        await assert.rejects(c.send("Target.createTarget", { url: `http://${host}/hidden` }), (e: Error) => {
          assert.equal(e.message, `Target.createTarget: Not allowed: ${host} is not on the allowlist`);
          return true;
        });
      }
      assert.equal(h.fake.daemonRequests.length, before, "a failed own args check sends no report");
      assert.doesNotMatch(h.logs.join("\n"), /hidden/);
    } finally { await h.close(); }
  });
}

test("a held new target reports a refusal when the scope's list changes before navigation", async () => {
  const h = await harness();
  try {
    h.fake.daemon = () => ({});
    await h.ready();
    const c = await h.connect("scope-a");
    await c.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    const attached = c.waitForEvent("Target.attachedToTarget");
    await c.send("Target.createTarget", { url: "https://a.example/path" });
    const { sessionId } = await attached;
    h.fake.line(lineOf(["b.example"]));
    await c.send("Runtime.runIfWaitingForDebugger", {}, sessionId);
    await until(() => h.logs.some((s) => s.includes("Browser permission")), "the delayed refusal");
    assert.deepEqual(h.fake.daemonRequests.filter((r) => r.op === "daemon.blocked").map((r) => r.args), [[{ host: "a.example", scope: "scope-a" }]]);
    assert.deepEqual(h.fake.sent("debugger.sendCommand", "Page.navigate"), []);
  } finally { await h.close(); }
});

test("the relay validates daemon.blocked args against C10's shared vectors", () => {
  const v = JSON.parse(readFileSync(new URL("./vectors/chrome-extension-f010103/bridge.json", import.meta.url), "utf8"));
  assert.equal(typeof policy.blockedArgsFit, "function");
  for (const row of v.blockedVectors) {
    assert.equal(policy.blockedArgsFit(row.req.args), row.res.ok || !!row.olderCarrier, row.req.id);
  }
});

test("a blocked report does not wait behind pointer requests and a silent carrier reaches the deadline", async () => {
  const sent: any[] = [];
  const bridge = new Bridge((line) => sent.push(JSON.parse(line)));
  const waiting = Array.from({ length: 64 }, () => bridge.call("daemon.pointerAt").catch(() => {}));
  const report = bridge.call("daemon.blocked", [{ host: "b.example", scope: null }], { wait: 30 });
  assert.equal(sent.at(-1).op, "daemon.blocked", "a full pointer queue never holds a block report");
  await assert.rejects(report, /the relay's timer/);
  bridge.dropAll();
  await Promise.all(waiting);
});

for (const managed of [false, true]) {
  test(`${managed ? "agentwatch" : "standalone"}: open and goto choose the relay or the local list; transfers keep local checks`, async () => {
    const fx = await fixtureServer(FIXTURE_HOST), c = consumer([FIXTURE_HOST]);
    const chrome = await FakeChrome.start(site(fx.base));
    const h = managed ? await harness() : undefined;
    const end = h ? await backByChrome(h.fake, chrome) : undefined;
    const o = c.options(h ? { cdpUrl: h.url("scope-a") } : { endpoint: chrome.ws, noLaunch: true });
    let b: AgentBrowser | undefined;
    try {
      if (h) { h.fake.daemon = () => ({}); await h.ready(lineOf([FIXTURE_HOST])); }
      const opened = await commands.open(o, { url: fx.base, name: "work" });
      for (const run of [() => commands.open(o, { url: "https://b.example/private" }), () => commands.goto(o, { tab: "work", url: "https://b.example/private" })]) {
        await assert.rejects(run(), (e: Error) => {
          assert.equal(e.message, managed ? "Page.navigate: " + prompted : "refusing: b.example is not on the allowlist");
          return true;
        });
      }
      assert.equal(chrome.pages.size, 1, "a refused open closes only its own empty tab");
      b = await AgentBrowser.connect(o);
      const tab = await b.attach(opened.tab.targetId);
      for (const run of [() => tab.fetchToFile("https://b.example/private?secret=hidden", join(c.dir, "fetch")), () => tab.download("https://b.example/private?secret=hidden", join(c.dir, "download"))]) {
        await assert.rejects(run(), (e: Error) => {
          assert.ok(e instanceof NotAllowedError);
          assert.equal(e.message, "refusing: b.example is not on the allowlist" + (managed ? ". Ask the operator to add b.example to your browser list." : ""));
          return true;
        });
      }
      if (h) assert.equal(h.fake.daemonRequests.filter((r) => r.op === "daemon.blocked").length, 2, "transfers make no prompt report");
      const script = join(c.dir, "steps.json");
      writeFileSync(script, JSON.stringify([{ goto: "https://b.example/private" }]));
      if (managed) {
        assert.equal(planRecording({ out: join(c.dir, "record.mp4"), script }, [FIXTURE_HOST], true).steps.length, 1);
        await assert.rejects(commands.record(o, { tab: "missing", out: join(c.dir, "record.mp4"), script }), /no allowlisted tab matches/);
      } else assert.throws(() => planRecording({ out: join(c.dir, "record.mp4"), script }, [FIXTURE_HOST]), NotAllowedError);
    } finally {
      await b?.disconnect(); stopProxy(resolveOptions(o)); end?.(); await h?.close(); await chrome.close(); await fx.close(); c.remove();
    }
  });
}
