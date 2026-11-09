// These tests catch a missing full-height surface, measurement at the old width, and a missing clear.
// The CLI reaches the fake Chrome through the default proxy and through the real agent-mode relay.
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { commands } from "../src/commands.ts";
import { AgentBrowser } from "../src/browser.ts";
import { resolveOptions } from "../src/options.ts";
import { stopProxy } from "../src/proxy.ts";
import { FakeChrome } from "./fake-chrome.ts";
import { backByChrome, harness, lineOf } from "./fake-bridge.ts";
import { cli, consumer, FIXTURE_HOST, fixtureServer, site } from "./helpers.ts";

for (const mode of ["default", "agent"] as const) {
  test(`${mode}: shot --full --size measures at the requested width and captures on a full-height surface`, async () => {
    const fx = await fixtureServer(FIXTURE_HOST), fake = await FakeChrome.start(site(fx.base)), c = consumer([FIXTURE_HOST]);
    const relay = mode === "agent" ? await harness() : undefined;
    const end = relay && await backByChrome(relay.fake, fake);
    try {
      if (relay) await relay.ready(lineOf([FIXTURE_HOST]));
      const connection = relay ? { cdpUrl: relay.url("shots") } : { endpoint: fake.ws };
      const o = c.options(connection);
      const { tab } = await commands.open(o, { url: fx.base, name: "tall" });
      const page = fake.pages.get(tab.targetId)!;
      // Like a vh-sized page: expanding the viewport grows the content again. A second measurement would
      // produce 6202, above the 3101-pixel surface, and allow the overlapping capture to resize it again.
      page.contentSize = (width, height) => ({ width, height: width === 800 ? (height === 600 ? 3100.25 : 6202) : 2400 });
      await commands.text(o, { tab: "tall" });
      const path = join(c.dir, "full.png"), from = fake.calls.length;
      const r = await cli(["shot", "tall", path, "--full", "--size", "800x600", "--scale", "2", "--json",
        "--state-dir", c.stateDir, "--allowlist", c.allowlist, "--no-launch", ...(relay ? ["--cdp-url", connection.cdpUrl!] : ["--endpoint", fake.ws])]);
      assert.equal(r.json.ok, true, r.stdout + r.stderr);
      const calls = fake.calls.slice(from).filter((x) => x.targetId === page.targetId);
      const relevant = calls.filter((x) => x.method === "Emulation.setDeviceMetricsOverride" || x.method === "Page.getLayoutMetrics" ||
        (x.method === "Page.captureScreenshot" && x.params.clip) || x.method === "Emulation.clearDeviceMetricsOverride");
      assert.deepEqual(relevant.map((x) => [x.method, x.params]), [
        ["Emulation.setDeviceMetricsOverride", { width: 800, height: 600, deviceScaleFactor: 2, mobile: false }],
        ["Page.getLayoutMetrics", {}],
        ["Emulation.setDeviceMetricsOverride", { width: 800, height: 3101, deviceScaleFactor: 2, mobile: false }],
        ["Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width: 800, height: 3101, scale: 1 } }],
        ["Emulation.clearDeviceMetricsOverride", {}],
      ]);
      assert.equal(page.metrics, undefined, "the override clears before the command returns");
      assert.ok(existsSync(path));
      await commands.close(o, { tab: "tall" });
    } finally { if (end) end(); if (relay) await relay.close(); stopProxy(resolveOptions(c.options())); await fake.close(); await fx.close(); c.remove(); }
  });
}

test("full-size shot clears the override when layout measurement or Chrome's size or capture limit fails", async () => {
  const fx = await fixtureServer(), fake = await FakeChrome.start(site(fx.base)), c = consumer();
  const o = c.options({ endpoint: fake.ws });
  try {
    const { tab } = await commands.open(o, { url: fx.base, name: "tall" });
    const page = fake.pages.get(tab.targetId)!, path = join(c.dir, "failed.png");
    await commands.text(o, { tab: "tall" });
    for (const fail of ["layout", "size", "limit"] as const) {
      if (fail === "layout") fake.failOnce.set("Page.getLayoutMetrics", "layout unavailable");
      else if (fail === "size") page.contentSize = (width) => {
        fake.failOnce.set("Emulation.setDeviceMetricsOverride", "Height exceeds the device metrics limit");
        return { width, height: 10000000 };
      };
      else { page.contentSize = () => ({ width: 800, height: 100000 }); page.captureLimit = 50000; }
      const from = fake.calls.length;
      await assert.rejects(commands.shot(o, { tab: "tall", path, full: true, size: "800x600" }),
        fail === "layout" ? /layout unavailable/ : fail === "size" ? /exceeds the device metrics limit/ : /exceeds the capture limit/);
      assert.equal(page.metrics, undefined, `${fail}: the override clears on error`);
      assert.equal(fake.calls.slice(from).filter((x) => x.method === "Emulation.clearDeviceMetricsOverride").length, 1);
      assert.equal(existsSync(path), false, "a failed capture writes no file");
    }
  } finally { stopProxy(resolveOptions(c.options())); await fake.close(); await fx.close(); c.remove(); }
});

test("shot keeps plain --full and viewport-only captures unchanged", async () => {
  const fx = await fixtureServer(), fake = await FakeChrome.start(site(fx.base)), c = consumer();
  const o = c.options({ endpoint: fake.ws });
  try {
    const { tab } = await commands.open(o, { url: fx.base, name: "plain" });
    const page = fake.pages.get(tab.targetId)!;
    await commands.text(o, { tab: "plain" });
    let from = fake.calls.length;
    await commands.shot(o, { tab: "plain", path: join(c.dir, "viewport.png"), size: "800x600" });
    let calls = fake.calls.slice(from);
    assert.deepEqual(calls.filter((x) => x.method === "Emulation.setDeviceMetricsOverride").map((x) => x.params),
      [{ width: 800, height: 600, deviceScaleFactor: 1, mobile: false }]);
    assert.equal(calls.some((x) => x.method === "Page.getLayoutMetrics"), false);
    assert.equal(page.metrics, undefined);
    from = fake.calls.length;
    await commands.shot(o, { tab: "plain", path: join(c.dir, "full.png"), full: true });
    calls = fake.calls.slice(from);
    assert.equal(calls.some((x) => x.method === "Emulation.setDeviceMetricsOverride"), false);
    assert.deepEqual(calls.find((x) => x.method === "Page.captureScreenshot" && x.params.clip)!.params,
      { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width: 1280, height: 2400, scale: 1 } });
  } finally { stopProxy(resolveOptions(c.options())); await fake.close(); await fx.close(); c.remove(); }
});

test("a full-size shot of an off-list page sends no capture or metrics override", async () => {
  const fx = await fixtureServer(), fake = await FakeChrome.start(site(fx.base)), c = consumer();
  const browser = await AgentBrowser.connect(c.options({ endpoint: fake.ws }));
  try {
    const tab = await browser.open(fx.base);
    fake.navigate(fake.pages.get(tab.targetId)!, "https://off-list.invalid/");
    const from = fake.calls.length;
    await assert.rejects(tab.screenshot(join(c.dir, "refused.png"), { fullPage: true, viewport: { width: 800, height: 600, scale: 1 } }), /not on the allowlist/);
    const methods = fake.calls.slice(from).map((x) => x.method);
    for (const forbidden of ["Page.captureScreenshot", "Page.getLayoutMetrics", "Emulation.setDeviceMetricsOverride", "Emulation.clearDeviceMetricsOverride"])
      assert.equal(methods.includes(forbidden), false, forbidden);
  } finally { await browser.disconnect(); stopProxy(resolveOptions(c.options())); await fake.close(); await fx.close(); c.remove(); }
});
