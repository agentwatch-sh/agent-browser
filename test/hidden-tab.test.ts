// A command on a background tab keeps the page hidden (ab-v16.15): the CDP calls that each command
// sends to a tab that is not in front, against the fake Chrome's model of one (FakePage.background:
// hidden, no frames, input dropped before the first frame, mouse moves held, captures that wait), and
// the pure parts of the live check (test/live/background-tabs/spans.ts).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentBrowser } from "../src/browser.ts";
import { commands } from "../src/commands.ts";
import { resolveOptions } from "../src/options.ts";
import { stopProxy } from "../src/proxy.ts";
import { findFfmpeg } from "../src/record.ts";
import { failures, visibleMs, visibleSpans, type Measured, type PageEvent } from "./live/background-tabs/spans.ts";
import { FakeChrome, type Call, type FakePage } from "./fake-chrome.ts";
import { consumer, fixtureServer, site, type Consumer, type Fixture } from "./helpers.ts";

const FFMPEG = (() => { try { return findFfmpeg(); } catch { return undefined; } })();

let fx: Fixture, fake: FakeChrome, c: Consumer;
const o = () => c.options({ endpoint: fake.ws });

before(async () => {
  fx = await fixtureServer();
  fake = await FakeChrome.start(site(fx.base));
  fake.backgroundTabs = true;
  c = consumer();
});

after(async () => {
  stopProxy(resolveOptions(c.options()));
  await fake?.close();
  await fx?.close();
  c?.remove();
});

/** A new background tab whose page never drew a frame (agent-browser's `open` makes a background tab). */
async function backgroundTab(name: string): Promise<FakePage> {
  const r = await commands.open(o(), { url: fx.base + "/", name });
  const page = fake.pages.get(r.tab.targetId)!;
  assert.equal(page.visibilityState, "hidden");
  assert.equal(page.drew, false, "a page that loaded in a background tab drew no frame");
  return page;
}

/** The CDP calls that `fn` sent to the page, and how long it took. */
async function callsOf(page: FakePage, fn: () => Promise<unknown>): Promise<{ calls: Call[]; ms: number }> {
  const from = fake.calls.length, t0 = Date.now();
  await fn();
  return { calls: fake.calls.slice(from).filter((x) => x.targetId === page.targetId), ms: Date.now() - t0 };
}
const methodsOf = (calls: Call[]) => calls.map((x) => x.method);
const captures = (calls: Call[]) => calls.filter((x) => x.method === "Page.captureScreenshot");

/** The page never reported "visible", no focus emulation was sent, and no capture is left in flight. */
function stayedHidden(page: FakePage, calls: Call[]) {
  assert.deepEqual(page.visibilityChanges, [], "no visibilitychange: the page stayed hidden");
  assert.ok(!methodsOf(calls).includes("Emulation.setFocusEmulationEnabled"), "no focus emulation (it makes the page visible)");
  assert.deepEqual(page.heldCaptures, [], "every capture ended: Chrome no longer draws the hidden page");
}

test("a command attaches with Page.enable only: no focus emulation, which makes a background tab's page visible", async () => {
  const page = await backgroundTab("attach");
  const { calls } = await callsOf(page, () => commands.eval(o(), { tab: "attach", expression: "document.title" }));
  const attach = methodsOf(calls).indexOf("Target.attachToTarget");
  assert.deepEqual(methodsOf(calls).slice(attach, attach + 2), ["Target.attachToTarget", "Page.enable"]);
  stayedHidden(page, calls);
  await commands.close(o(), { tab: "attach" });
});

test("eval, text, outline and goto on a background tab draw nothing: no capture, and the page stays hidden", async () => {
  const page = await backgroundTab("reads");
  const { calls } = await callsOf(page, async () => {
    assert.equal((await commands.eval(o(), { tab: "reads", expression: "document.visibilityState" })).value, "hidden");
    assert.match((await commands.text(o(), { tab: "reads" })).text, /Fixture page/);
    assert.ok((await commands.outline(o(), { tab: "reads" })).elements.length > 0);
    await commands.goto(o(), { tab: "reads", url: fx.base + "/next" });
  });
  assert.deepEqual(captures(calls), []);
  stayedHidden(page, calls);
  await commands.close(o(), { tab: "reads" });
});

test("the fake drops a press on a background page that never drew a frame, as Chrome does", async () => {
  const page = await backgroundTab("model");
  const b = await AgentBrowser.connect(o());
  try {
    const tab = await b.find("model");
    await tab.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 70, y: 22, button: "left", clickCount: 1 });
    assert.deepEqual(page.dropped, ["mousePressed"]);
  } finally { await b.disconnect(); }
  await commands.close(o(), { tab: "model" });
});

test("click on a background tab: a hidden capture keeps Chrome drawing the page, so the click arrives at once, and the page stays hidden", async () => {
  const page = await backgroundTab("click");
  const { calls, ms } = await callsOf(page, () => commands.click(o(), { tab: "click", target: "#b" }));
  assert.equal(page.title, "clicked", "the trusted click reached a page that had never drawn");
  assert.deepEqual(page.dropped, []);
  assert.ok(ms < 2000, `no mouse move waited for Blink's 5 s fallback: ${ms} ms`);
  const shots = captures(calls);
  assert.ok(shots.length >= 2, "a capture holds the page drawing, and a last one ends it");
  for (const x of shots) assert.deepEqual(x.params, { format: "jpeg", quality: 1, optimizeForSpeed: true }, "a cheap capture with no clip");
  const m = methodsOf(calls);
  assert.ok(m.indexOf("Page.captureScreenshot") < m.indexOf("Input.dispatchMouseEvent"), "the page draws before the first input event");
  assert.ok(m.lastIndexOf("Page.captureScreenshot") > m.lastIndexOf("Input.dispatchMouseEvent"), "the last capture comes after the input");
  stayedHidden(page, calls);
  await commands.close(o(), { tab: "click" });
});

test("click --text, hover, type and press on a background tab arrive at once, and the page stays hidden", async () => {
  const page = await backgroundTab("input");
  const { calls, ms } = await callsOf(page, async () => {
    await commands.hover(o(), { tab: "input", target: "#b" });
    assert.equal(page.hovered?.id, "b");
    await commands.type(o(), { tab: "input", text: "abc", into: "#i" });
    assert.equal(page.select("#i")[0].value, "abc");
    await commands.press(o(), { tab: "input", key: "Enter" });
    assert.ok(page.keyEvents.some((k) => k.key === "Enter" && k.type === "keyDown"));
    await commands.click(o(), { tab: "input", text: "Go" });
    assert.equal(page.title, "clicked");
  });
  assert.ok(ms < 4000, `no mouse move waited for Blink's 5 s fallback: ${ms} ms`);
  assert.deepEqual(page.dropped, []);
  stayedHidden(page, calls);
  await commands.close(o(), { tab: "input" });
});

test("shot of a background tab: one hidden capture first, and the shot's own capture ends it; the page stays hidden", async () => {
  const page = await backgroundTab("shot");
  await commands.text(o(), { tab: "shot" }); // the read-first rule
  const path = join(c.dir, "hidden.png");
  const { calls } = await callsOf(page, () => commands.shot(o(), { tab: "shot", path }));
  assert.ok(existsSync(path));
  const shots = captures(calls);
  assert.deepEqual(shots.map((x) => x.params), [{ format: "jpeg", quality: 1, optimizeForSpeed: true }, { format: "png" }]);
  stayedHidden(page, calls);
  await commands.close(o(), { tab: "shot" });
});

test("shot --size and --full of a background tab: no capture is sent while the device emulation is changed, but the shot's own", async () => {
  // A capture remembers the emulation that it found and restores it when it ends: one sent while the
  // size override is set would set it again after the shot cleared it.
  const page = await backgroundTab("sized");
  await commands.text(o(), { tab: "sized" });
  let { calls } = await callsOf(page, () => commands.shot(o(), { tab: "sized", path: join(c.dir, "sized.png"), size: "800x600" }));
  let m = methodsOf(calls);
  const set = m.indexOf("Emulation.setDeviceMetricsOverride"), clear = m.indexOf("Emulation.clearDeviceMetricsOverride");
  assert.ok(m.indexOf("Page.captureScreenshot") < set, "the hidden capture comes before the override");
  assert.equal(captures(calls.slice(set, clear)).length, 1, "while the override is set, only the shot's own capture");
  assert.deepEqual(captures(calls.slice(clear)), [], "none after the override is cleared");
  assert.equal(page.metrics, undefined);
  stayedHidden(page, calls);

  ({ calls } = await callsOf(page, () => commands.shot(o(), { tab: "sized", path: join(c.dir, "full.png"), full: true })));
  m = methodsOf(calls);
  const full = captures(calls).filter((x) => x.params.clip);
  assert.equal(full.length, 1);
  assert.equal(full[0].params.captureBeyondViewport, true);
  assert.equal(calls.indexOf(full[0]), calls.indexOf(captures(calls).at(-1)!), "the full-page capture is the last one");
  assert.deepEqual(captures(calls).slice(0, -1).map((x) => x.params), [{ format: "jpeg", quality: 1, optimizeForSpeed: true }]);
  stayedHidden(page, calls);
  await commands.close(o(), { tab: "sized" });
});

test("a tab in front draws by itself: click sends no capture, and shot only its own", async () => {
  const page = await backgroundTab("front");
  page.background = false;
  page.update();
  page.visibilityChanges.length = 0;
  await commands.text(o(), { tab: "front" });
  let { calls } = await callsOf(page, () => commands.click(o(), { tab: "front", target: "#b" }));
  assert.equal(page.title, "clicked");
  assert.deepEqual(captures(calls), []);
  ({ calls } = await callsOf(page, () => commands.shot(o(), { tab: "front", path: join(c.dir, "front.png") })));
  assert.deepEqual(captures(calls).map((x) => x.params), [{ format: "png" }]);
  assert.deepEqual(page.visibilityChanges, []);
  await commands.close(o(), { tab: "front" });
});

test("record on a background tab: Chrome sends no screencast frame of a hidden page, so focus emulation is on for the run only", { skip: FFMPEG ? false : "no ffmpeg (with libx264) on PATH" }, async () => {
  const page = await backgroundTab("rec");
  const script = join(c.dir, "rec-hidden-steps.json");
  writeFileSync(script, JSON.stringify([{ wait: 300 }]));
  const { calls } = await callsOf(page, async () => {
    const r = await commands.record(o(), { tab: "rec", out: join(c.dir, "rec-hidden.mp4"), script, size: "320x180", fps: 10, settle: 100, ffmpeg: FFMPEG });
    assert.ok(r.frames >= 2, `${r.frames} frames`);
  });
  const m = methodsOf(calls), focus = calls.filter((x) => x.method === "Emulation.setFocusEmulationEnabled").map((x) => x.params.enabled);
  assert.deepEqual(focus, [true, false]);
  const on = m.indexOf("Emulation.setFocusEmulationEnabled"), off = m.lastIndexOf("Emulation.setFocusEmulationEnabled");
  assert.ok(on < m.indexOf("Emulation.setDeviceMetricsOverride") && off > m.indexOf("Page.stopScreencast"), "on before the run, off after the screencast stops");
  assert.deepEqual(page.visibilityChanges, ["visible", "hidden"], "visible for the run, then hidden again");
  assert.deepEqual(page.heldCaptures, []);
  await commands.close(o(), { tab: "rec" });
});

// ---------- the live check's pure parts ----------

const ev = (t: number, tab: string, e: string, vis: string): PageEvent => ({ t, tab, ev: e, vis, focus: false });

test("visibleSpans and visibleMs: the page's visible spans in a window, an open span counted to the window's end", () => {
  const log = [ev(0, "a", "load", "hidden"), ev(100, "a", "visibilitychange", "visible"), ev(130, "b", "visibilitychange", "visible"),
    ev(150, "a", "visibilitychange", "hidden"), ev(400, "a", "visibilitychange", "visible")];
  assert.deepEqual(visibleSpans(log, "a", 0, 1000), [{ from: 100, to: 150 }, { from: 400, to: null }]);
  assert.deepEqual(visibleSpans(log, "a", 200, 300), []);
  assert.deepEqual(visibleSpans(log, "a", 120, 300), [{ from: 100, to: 150 }]);
  assert.equal(visibleMs(visibleSpans(log, "a", 0, 1000), 0, 1000), 50 + 600);
  assert.equal(visibleMs(visibleSpans(log, "a", 120, 500), 120, 500), 30 + 100);
  assert.deepEqual(visibleSpans([ev(0, "a", "load", "visible")], "a", 10, 20), [{ from: 0, to: null }], "a page that loaded visible");
});

test("failures: every command must work; a hidden tab's page stays hidden and draws nothing after a command, except a record's span; --report-only checks the results only", () => {
  const m = (x: Partial<Measured>): Measured => ({ command: "click", tab: "a", front: "x", ms: 10, ok: true, visibleMs: 0, visibilityChanges: 0, focusEvents: [], framesAfter: 0, ...x });
  assert.deepEqual(failures([m({}), m({ command: "record", visibleMs: 3000, visibilityChanges: 2 }), m({ front: "a", visibleMs: 50, framesAfter: 60 })], false), []);
  assert.deepEqual(failures([m({ visibleMs: 12, visibilityChanges: 2 })], false), [`click on tab a (front: x): the hidden page reported "visible" for 12 ms (2 visibilitychange events)`]);
  assert.deepEqual(failures([m({ framesAfter: 3 })], false), ["click on tab a (front: x): the hidden page drew 3 frames in the second after the command"]);
  assert.deepEqual(failures([m({ ok: false, detail: "no click", visibleMs: 12 })], true), ["click on tab a (front: x): no click"]);
  assert.deepEqual(failures([m({ visibleMs: 12, visibilityChanges: 2, framesAfter: 1 })], true), []);
});
