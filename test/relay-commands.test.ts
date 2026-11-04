// agent-browser's own commands over agent mode's endpoint (cdpUrl, CLI --cdp-url): the commands connect to the
// relay's socket in place of the proxy socket, and the relay drives the fake Chrome of fake-chrome.ts through the
// fake receiver. No proxy starts and no Chrome is launched; the CDP proxy stays the default path.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { commands } from "../src/commands.ts";
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
    const o = c.options({ cdpUrl: h.url("ab-lead"), noLaunch: false });
    const opened = await commands.open(o, { url: fx.base, name: "main" });
    assert.equal(opened.tab.name, "main");
    assert.match((await commands.text(o, { tab: "main" })).text, /Fixture page/);
    assert.equal((await commands.eval(o, { tab: "main", expression: "1 + 1" })).value, 2);
    assert.ok((await commands.outline(o, { tab: "main" })).elements.some((e) => e.label === "Go"));
    await commands.click(o, { tab: "main", target: "#b" });
    assert.equal((await commands.tabs(o)).tabs.length, 1);
    const status = await commands.status(o);
    assert.deepEqual([status.connected, status.proxy, status.allowedTabs], [true, null, 1]);
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
  } finally { end(); await h.close(); await chrome.close(); await fx.close(); c.remove(); }
});

test("the CLI takes --cdp-url; it refuses another URL, personal mode and --endpoint with it", async () => {
  const c = consumer();
  try {
    const opts = (o: object) => () => resolveOptions(c.options(o));
    assert.throws(opts({ cdpUrl: "http://x/devtools/browser/a" }), /cdpUrl must be a ws:\/\/, wss:\/\/ or ws\+unix:\/\/ URL/);
    assert.throws(opts({ cdpUrl: "ws+unix:///tmp/x.sock:/devtools/browser/a", mode: "personal" }), /cdpUrl is for the agent browser/);
    assert.throws(opts({ cdpUrl: "ws+unix:///tmp/x.sock:/devtools/browser/a", endpoint: "ws://127.0.0.1:1/devtools/browser/x" }), /not both/);
    const r = await cli(["tabs", "--json", "--state-dir", c.stateDir, "--allowlist", c.allowlist, "--cdp-url", `ws+unix://${join(c.dir, "none.sock")}:/devtools/browser/a`]);
    assert.equal(r.json.ok, false);
    assert.match(r.json.error.message, /none\.sock/);
  } finally { c.remove(); }
});
