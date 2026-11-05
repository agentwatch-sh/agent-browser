// agent-browser's own commands over agent mode's endpoint (cdpUrl, CLI --cdp-url): the commands connect to the
// relay's socket in place of the proxy socket, and the relay drives the fake Chrome of fake-chrome.ts through the
// fake receiver. No proxy starts and no Chrome is launched; the CDP proxy stays the default path.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { commands } from "../src/commands.ts";
import { NOT_READY } from "../src/relay/model.ts";
import { resolveOptions } from "../src/options.ts";
import { MODEL_SET } from "../src/relay/policy.ts";
import { FakeChrome } from "./fake-chrome.ts";
import { backByChrome, harness } from "./fake-bridge.ts";
import { cli, consumer, fixtureServer, site } from "./helpers.ts";

test("agent-browser's commands work over the endpoint, in its scope, with no proxy and no launch", async () => {
  const fx = await fixtureServer(), chrome = await FakeChrome.start(site(fx.base)), h = await harness(), c = consumer();
  const end = await backByChrome(h.fake, chrome);
  try {
    await h.ready();
    const o = c.options({ cdpUrl: h.url("ab-lead") });
    const opened = await commands.open(o, { url: fx.base, name: "main" });
    assert.equal(opened.tab.name, "main");
    assert.match((await commands.text(o, { tab: "main" })).text, /Fixture page/);
    assert.equal((await commands.eval(o, { tab: "main", expression: "1 + 1" })).value, 2);
    assert.ok((await commands.outline(o, { tab: "main" })).elements.some((e) => e.label === "Go"));
    await commands.click(o, { tab: "main", target: "#b" });
    // On Linux the page has a window of its own, the relay answers focus emulation itself, and the press of the click
    // brought the page's window forward (ab-v16.28).
    assert.deepEqual(h.fake.sent("windows.create").map((r) => r.args), [[{ url: "about:blank", focused: false }]]);
    assert.deepEqual(h.fake.sent("tabs.create"), []);
    assert.ok(!chrome.calls.some((x) => x.method === "Emulation.setFocusEmulationEnabled"), "focus emulation reached Chrome");
    const win = chrome.pages.get(opened.tab.targetId)!.windowId;
    assert.deepEqual(h.fake.sent("windows.update").map((r) => r.args), [[win, { focused: true }]]);
    assert.equal((await commands.tabs(o)).tabs.length, 1);
    const status = await commands.status(o);
    assert.deepEqual([status.connected, status.proxy, status.allowedTabs, status.profileDir, status.target], [true, null, 1, null, `agent mode's endpoint ${h.url("ab-lead")}`]);
    // The tab is in the endpoint's scope: another scope's connection does not see it.
    const other = await h.connect("s2");
    assert.deepEqual((await other.send("Target.getTargets")).targetInfos, []);
    await commands.close(o, { tab: "main" });
    assert.equal((await commands.tabs(o)).tabs.length, 0);
    // The relay answered every browser-level call itself: none reached Chrome, and nothing was refused.
    assert.deepEqual(chrome.calls.filter((x) => x.sessionId && MODEL_SET.has(x.method) && x.method !== "Target.setAutoAttach").map((x) => x.method), []);
    assert.ok(!h.logs.some((l) => /refus/i.test(l)));
    assert.ok(!existsSync(resolveOptions(o).socketPath), "no proxy socket");
    // The agent browser behind the endpoint belongs to agentwatch: no command launches or quits it.
    await assert.rejects(commands.launch(o), /cdpUrl/);
    await assert.rejects(commands.quit(o), /cdpUrl/);
    await assert.rejects(commands.front(o), /cdpUrl/);
  } finally { end(); await h.close(); await chrome.close(); await fx.close(); c.remove(); }
});

test("an endpoint that is not ready: status names the endpoint and C11's text, also in --notify; a command fails with that text", async () => {
  const h = await harness(), c = consumer(), sent: string[] = [];
  try {
    const o = c.options({ cdpUrl: h.url("ab-lead"), notify: async (m: string) => { sent.push(m); } });
    const status = await commands.status(o, { notify: true });
    assert.deepEqual([status.connected, status.profileDir, status.target], [false, null, `agent mode's endpoint ${h.url("ab-lead")}`]);
    assert.ok(status.detail!.includes(NOT_READY.link) && !/approval|prompt|profile/i.test(status.detail!), status.detail!);
    assert.ok(sent[0].includes(NOT_READY.link));
    await assert.rejects(commands.tabs(o), (e: Error) => e.message.includes(NOT_READY.link));
  } finally { await h.close(); c.remove(); }
});

test("the CLI takes --cdp-url: only agent mode's endpoint, and none of the proxy's options", async () => {
  const c = consumer();
  try {
    const opts = (o: object) => () => resolveOptions(c.options(o));
    const good = "ws+unix:///run/user/1000/agentwatch/browser-cdp.sock:/devtools/browser/ab-lead";
    assert.equal(resolveOptions(c.options({ cdpUrl: good })).cdpUrl, good);
    for (const bad of ["ws://127.0.0.1:9222/devtools/browser/0b1c", "wss://remote.example/devtools/browser/x", "ws+unix://relative.sock:/devtools/browser/a",
      "ws+unix:///tmp/x.sock:/anything", "ws+unix:///tmp/x.sock:/devtools/browser/.x", "http://x/devtools/browser/a"]) {
      assert.throws(opts({ cdpUrl: bad }), /cdpUrl must be agent mode's endpoint/, bad);
    }
    for (const extra of [{ socketPath: "/tmp/x.sock" }, { approve: "auto" }, { chromeBin: "/usr/bin/chromium" }, { proxyIdleMs: 1000 }]) {
      assert.throws(opts({ cdpUrl: good, ...extra }), /with cdpUrl/, JSON.stringify(extra));
    }
    // No proxy socket, so no limit on its default path: a long state folder is fine.
    assert.ok(resolveOptions({ ...c.options({ cdpUrl: good }), stateDir: join(c.dir, "x".repeat(120)) }));
    assert.throws(opts({ cdpUrl: good, mode: "personal" }), /cdpUrl is for the agent browser/);
    assert.throws(opts({ cdpUrl: good, endpoint: "ws://127.0.0.1:1/devtools/browser/x" }), /not both/);
    const r = await cli(["tabs", "--json", "--state-dir", c.stateDir, "--allowlist", c.allowlist, "--cdp-url", `ws+unix://${join(c.dir, "none.sock")}:/devtools/browser/a`]);
    assert.equal(r.json.ok, false);
    assert.match(r.json.error.message, /none\.sock/);
  } finally { c.remove(); }
});
