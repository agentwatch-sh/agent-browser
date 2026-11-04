// The CDP calls that each command sends to a background tab (ab-v16.15), in both modes, against the
// fake Chrome's model of a tab that is not in front (FakePage.background: hidden, no frames, input
// dropped before the first frame, mouse moves held, captures that wait), and the pure parts of the live
// check (test/live/background-tabs/spans.ts).
//   default        focus emulation while a command is attached: the page is visible for the command
//   hiddenDrive    no focus emulation; input and shots under Tab.whileDrawn: the page stays hidden
// Each hidden-mode command gets a new tab whose page never drew a frame, so no earlier command drew it.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentBrowser } from "../src/browser.ts";
import { optionsFromFlags } from "../src/cli.ts";
import { commands } from "../src/commands.ts";
import { resolveOptions } from "../src/options.ts";
import { stopProxy } from "../src/proxy.ts";
import { findFfmpeg } from "../src/record.ts";
import { failures, visibleMs, visibleSpans, type Measured, type PageEvent } from "./live/background-tabs/spans.ts";
import { FakeChrome, type Call, type FakePage } from "./fake-chrome.ts";
import { consumer, fixtureServer, site, type Consumer, type Fixture } from "./helpers.ts";

const FFMPEG = (() => { try { return findFfmpeg(); } catch { return undefined; } })();
const needsFfmpeg = { skip: FFMPEG ? false : "no ffmpeg (with libx264) on PATH" };
const HOLD = { format: "jpeg", quality: 1, optimizeForSpeed: true };

let fx: Fixture, fake: FakeChrome, c: Consumer;
/** The default mode. */
const o = () => c.options({ endpoint: fake.ws });
/** The hidden drive. */
const h = () => c.options({ endpoint: fake.ws, hiddenDrive: true });

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

let tabs = 0;
/**
 * A new background tab (agent-browser's `open` makes a background tab), opened in the mode `mode`. With
 * the hidden drive its page never drew a frame; in the default mode the open's focus emulation can let
 * it draw.
 */
async function backgroundTab(path = "/", mode = h): Promise<{ name: string; page: FakePage }> {
  const name = `t${++tabs}`;
  const r = await commands.open(mode(), { url: fx.base + path, name });
  const page = fake.pages.get(r.tab.targetId)!;
  assert.equal(page.visibilityState, "hidden");
  if (mode === h) assert.equal(page.drew, false, "a page that loaded in a background tab drew no frame");
  page.visibilityChanges.length = 0; // the open's own attach
  return { name, page };
}

/** The CDP calls that `fn` sent to the page, and how long it took. */
async function callsOf(page: FakePage, fn: () => Promise<unknown>): Promise<{ calls: Call[]; ms: number }> {
  const from = fake.calls.length, t0 = Date.now();
  await fn();
  return { calls: fake.calls.slice(from).filter((x) => x.targetId === page.targetId), ms: Date.now() - t0 };
}
const methodsOf = (calls: Call[]) => calls.map((x) => x.method);
const captures = (calls: Call[]) => calls.filter((x) => x.method === "Page.captureScreenshot");
const focusCalls = (calls: Call[]) => calls.filter((x) => x.method === "Emulation.setFocusEmulationEnabled").map((x) => x.params.enabled);

/** The page never reported "visible", no focus emulation was sent, and no capture is left in flight. */
function stayedHidden(page: FakePage, calls: Call[]) {
  assert.deepEqual(page.visibilityChanges, [], "no visibilitychange: the page stayed hidden");
  assert.deepEqual(focusCalls(calls), [], "no focus emulation (it makes the page visible)");
  assert.deepEqual(page.heldCaptures, [], "every capture ended: Chrome no longer draws the hidden page");
  assert.deepEqual(page.dropped, [], "no input was dropped");
}

/** No mouse move waited for Blink's 5 s fallback, and the input reached the page. */
function fast(ms: number) { assert.ok(ms < 2000, `${ms} ms`); }

// ---------- the default mode ----------

test("default: attach sends Page.enable and focus emulation, as before: the page is visible while the command is attached", async () => {
  const { name, page } = await backgroundTab("/", o);
  const { calls } = await callsOf(page, () => commands.eval(o(), { tab: name, expression: "document.visibilityState" }));
  const m = methodsOf(calls), attach = m.indexOf("Target.attachToTarget");
  assert.deepEqual(m.slice(attach, attach + 3), ["Target.attachToTarget", "Page.enable", "Emulation.setFocusEmulationEnabled"]);
  assert.deepEqual(focusCalls(calls), [true]);
  assert.deepEqual(page.visibilityChanges, ["visible", "hidden"], "visible for the command, hidden after the detach");
  assert.deepEqual(captures(calls), []);
  await commands.close(o(), { tab: name });
});

test("default: click, type and shot on a new background tab work with no hidden capture", async () => {
  const { name, page } = await backgroundTab("/", o);
  const { calls } = await callsOf(page, async () => {
    await commands.click(o(), { tab: name, target: "#b" });
    await commands.type(o(), { tab: name, text: "abc", into: "#i" });
    await commands.text(o(), { tab: name });
    await commands.shot(o(), { tab: name, path: join(c.dir, `${name}.png`) });
  });
  assert.equal(page.title, "clicked");
  assert.equal(page.select("#i")[0].value, "abc");
  assert.deepEqual(captures(calls).map((x) => x.params), [{ format: "png" }], "only the shot's own capture");
  assert.deepEqual(page.dropped, []);
  await commands.close(o(), { tab: name });
});

test("default: record keeps the attach's focus emulation and turns none on or off itself", needsFfmpeg, async () => {
  const { name, page } = await backgroundTab("/", o);
  const script = join(c.dir, `${name}-steps.json`);
  writeFileSync(script, JSON.stringify([{ wait: 200 }]));
  const { calls } = await callsOf(page, () => commands.record(o(), { tab: name, out: join(c.dir, `${name}.mp4`), script, size: "320x180", fps: 10, settle: 100, ffmpeg: FFMPEG }));
  assert.deepEqual(focusCalls(calls), [true], "the attach's only");
  await commands.close(o(), { tab: name });
});

// ---------- the hidden drive ----------

test("hiddenDrive: --hidden-drive sets it; it is off by default", () => {
  assert.equal(optionsFromFlags({ "state-dir": c.stateDir, "hidden-drive": true }, () => {}).hiddenDrive, true);
  assert.equal(optionsFromFlags({ "state-dir": c.stateDir }, () => {}).hiddenDrive, false);
  assert.equal(resolveOptions(c.options()).hiddenDrive, false);
});

test("hiddenDrive: attach sends Page.enable only; eval, text, outline and goto draw nothing and the page stays hidden", async () => {
  const { name, page } = await backgroundTab();
  const { calls } = await callsOf(page, async () => {
    assert.equal((await commands.eval(h(), { tab: name, expression: "document.visibilityState" })).value, "hidden");
    assert.match((await commands.text(h(), { tab: name })).text, /Fixture page/);
    assert.ok((await commands.outline(h(), { tab: name })).elements.length > 0);
    await commands.goto(h(), { tab: name, url: fx.base + "/next" });
  });
  const m = methodsOf(calls), attach = m.indexOf("Target.attachToTarget");
  assert.deepEqual(m.slice(attach, attach + 2), ["Target.attachToTarget", "Page.enable"]);
  assert.notEqual(m[attach + 2], "Emulation.setFocusEmulationEnabled");
  assert.deepEqual(captures(calls), []);
  stayedHidden(page, calls);
  await commands.close(h(), { tab: name });
});

test("the fake drops a press on a background page that never drew a frame, as Chrome does", async () => {
  const { name, page } = await backgroundTab();
  const b = await AgentBrowser.connect(h());
  try {
    const tab = await b.find(name);
    await tab.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 70, y: 22, button: "left", clickCount: 1 });
    assert.deepEqual(page.dropped, ["mousePressed"]);
  } finally { await b.disconnect(); }
  await commands.close(h(), { tab: name });
});

test("hiddenDrive: click on a new background tab: a hidden capture keeps Chrome drawing it, the click arrives at once, the page stays hidden", async () => {
  const { name, page } = await backgroundTab();
  const { calls, ms } = await callsOf(page, () => commands.click(h(), { tab: name, target: "#b" }));
  assert.equal(page.title, "clicked", "the trusted click reached a page that had never drawn");
  fast(ms);
  const shots = captures(calls);
  assert.ok(shots.length >= 2, "a capture holds the page drawing, and a last one ends it");
  for (const x of shots) assert.deepEqual(x.params, HOLD, "a cheap capture with no clip");
  const m = methodsOf(calls);
  assert.ok(m.indexOf("Page.captureScreenshot") < m.indexOf("Input.dispatchMouseEvent"), "the page draws before the first input event");
  assert.ok(m.lastIndexOf("Page.captureScreenshot") > m.lastIndexOf("Input.dispatchMouseEvent"), "the last capture comes after the input");
  stayedHidden(page, calls);
  await commands.close(h(), { tab: name });
});

test("hiddenDrive: click --text on a new background tab", async () => {
  const { name, page } = await backgroundTab();
  const { calls, ms } = await callsOf(page, () => commands.click(h(), { tab: name, text: "Go" }));
  assert.equal(page.title, "clicked");
  fast(ms);
  stayedHidden(page, calls);
  await commands.close(h(), { tab: name });
});

test("hiddenDrive: hover on a new background tab: the move is not held for 5 s", async () => {
  const { name, page } = await backgroundTab();
  const { calls, ms } = await callsOf(page, () => commands.hover(h(), { tab: name, target: "#b" }));
  assert.equal(page.hovered?.id, "b");
  fast(ms);
  stayedHidden(page, calls);
  await commands.close(h(), { tab: name });
});

test("hiddenDrive: press as the first command on a new background tab", async () => {
  const { name, page } = await backgroundTab();
  const { calls, ms } = await callsOf(page, () => commands.press(h(), { tab: name, key: "Enter" }));
  assert.deepEqual(page.keyEvents.map((k) => [k.type, k.key]), [["keyDown", "Enter"], ["keyUp", "Enter"]]);
  fast(ms);
  stayedHidden(page, calls);
  await commands.close(h(), { tab: name });
});

test("hiddenDrive: type into a field as the first command on a new background tab", async () => {
  const { name, page } = await backgroundTab();
  const { calls, ms } = await callsOf(page, () => commands.type(h(), { tab: name, text: "abc", into: "#i" }));
  assert.equal(page.select("#i")[0].value, "abc");
  fast(ms);
  stayedHidden(page, calls);
  await commands.close(h(), { tab: name });
});

test("hiddenDrive: type into an app's own editor (key events only) as the first command on a new background tab", async () => {
  const { name, page } = await backgroundTab("/editor");
  const { calls, ms } = await callsOf(page, () => commands.type(h(), { tab: name, text: "xy\t", into: "#cell" }));
  assert.deepEqual(page.keyEvents.filter((k) => k.type !== "keyUp").map((k) => k.key), ["x", "y", "Tab"], "every key reached the page");
  assert.deepEqual(page.cells, ["xy"]);
  fast(ms);
  stayedHidden(page, calls);
  await commands.close(h(), { tab: name });
});

test("hiddenDrive: Tab.clickAt (the library's click at a point) on a new background tab", async () => {
  const { name, page } = await backgroundTab();
  const b = await AgentBrowser.connect(h());
  let r: { calls: Call[]; ms: number };
  try {
    const tab = await b.find(name);
    r = await callsOf(page, () => tab.clickAt(70, 22)); // the centre of #b, the first row
  } finally { await b.disconnect(); }
  assert.equal(page.title, "clicked");
  fast(r.ms);
  assert.ok(captures(r.calls).length >= 2);
  stayedHidden(page, r.calls);
  await commands.close(h(), { tab: name });
});

test("hiddenDrive: on a page that draws by itself each capture ends after a frame, so a new one is sent each time (repeat)", async () => {
  // Without a new capture, Chrome would stop drawing the page after the first one, and the hover's
  // mouse move would wait for Blink's 5 s fallback.
  const { name, page } = await backgroundTab();
  page.drawsByItself = true;
  const { calls, ms } = await callsOf(page, () => commands.hover(h(), { tab: name, target: "#b" }));
  assert.equal(page.hovered?.id, "b");
  fast(ms);
  assert.ok(captures(calls).length >= 3, `${captures(calls).length} captures: each one that ended was followed by a new one`);
  stayedHidden(page, calls);
  await commands.close(h(), { tab: name });
});

test("hiddenDrive: shot of a new background tab: one hidden capture first, and the shot's own capture ends it", async () => {
  const { name, page } = await backgroundTab();
  await commands.text(h(), { tab: name }); // the read-first rule
  const path = join(c.dir, `${name}.png`);
  const { calls } = await callsOf(page, () => commands.shot(h(), { tab: name, path }));
  assert.ok(existsSync(path));
  assert.deepEqual(captures(calls).map((x) => x.params), [HOLD, { format: "png" }]);
  stayedHidden(page, calls);
  await commands.close(h(), { tab: name });
});

test("hiddenDrive: shot --size and --full of a new background tab: no capture is sent while the device emulation is changed, but the shot's own", async () => {
  // A capture remembers the emulation that it found and restores it when it ends: one sent while the
  // size override is set would set it again after the shot cleared it.
  let { name, page } = await backgroundTab();
  await commands.text(h(), { tab: name });
  let { calls } = await callsOf(page, () => commands.shot(h(), { tab: name, path: join(c.dir, `${name}.png`), size: "800x600" }));
  const m = methodsOf(calls);
  const set = m.indexOf("Emulation.setDeviceMetricsOverride"), clear = m.indexOf("Emulation.clearDeviceMetricsOverride");
  assert.ok(m.indexOf("Page.captureScreenshot") < set, "the hidden capture comes before the override");
  assert.equal(captures(calls.slice(set, clear)).length, 1, "while the override is set, only the shot's own capture");
  assert.deepEqual(captures(calls.slice(clear)), [], "none after the override is cleared");
  assert.equal(page.metrics, undefined);
  stayedHidden(page, calls);
  await commands.close(h(), { tab: name });

  ({ name, page } = await backgroundTab());
  await commands.text(h(), { tab: name });
  ({ calls } = await callsOf(page, () => commands.shot(h(), { tab: name, path: join(c.dir, `${name}.png`), full: true })));
  const full = captures(calls).filter((x) => x.params.clip);
  assert.equal(full.length, 1);
  assert.equal(full[0].params.captureBeyondViewport, true);
  assert.equal(calls.indexOf(full[0]), calls.indexOf(captures(calls).at(-1)!), "the full-page capture is the last one");
  assert.deepEqual(captures(calls).slice(0, -1).map((x) => x.params), [HOLD]);
  stayedHidden(page, calls);
  await commands.close(h(), { tab: name });
});

test("hiddenDrive: a tab in front draws by itself: click sends no capture, and shot only its own", async () => {
  const { name, page } = await backgroundTab();
  page.background = false;
  page.update();
  page.visibilityChanges.length = 0;
  await commands.text(h(), { tab: name });
  let { calls } = await callsOf(page, () => commands.click(h(), { tab: name, target: "#b" }));
  assert.equal(page.title, "clicked");
  assert.deepEqual(captures(calls), []);
  ({ calls } = await callsOf(page, () => commands.shot(h(), { tab: name, path: join(c.dir, `${name}.png`) })));
  assert.deepEqual(captures(calls).map((x) => x.params), [{ format: "png" }]);
  assert.deepEqual(page.visibilityChanges, []);
  await commands.close(h(), { tab: name });
});

test("hiddenDrive: record turns focus emulation on for its run only: Chrome sends no screencast frame of a hidden page", needsFfmpeg, async () => {
  const { name, page } = await backgroundTab();
  const script = join(c.dir, `${name}-steps.json`);
  writeFileSync(script, JSON.stringify([{ wait: 300 }]));
  const { calls } = await callsOf(page, async () => {
    const r = await commands.record(h(), { tab: name, out: join(c.dir, `${name}.mp4`), script, size: "320x180", fps: 10, settle: 100, ffmpeg: FFMPEG });
    assert.ok(r.frames >= 2, `${r.frames} frames`);
  });
  const m = methodsOf(calls);
  assert.deepEqual(focusCalls(calls), [true, false]);
  const on = m.indexOf("Emulation.setFocusEmulationEnabled"), off = m.lastIndexOf("Emulation.setFocusEmulationEnabled");
  assert.ok(on < m.indexOf("Emulation.setDeviceMetricsOverride") && off > m.indexOf("Page.stopScreencast"), "on before the run, off after the screencast stops");
  assert.deepEqual(page.visibilityChanges, ["visible", "hidden"], "visible for the run, then hidden again");
  assert.deepEqual(page.heldCaptures, []);
  await commands.close(h(), { tab: name });
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

test("failures: every command must work; with the hidden drive a hidden tab's page stays hidden and draws nothing after a command, except a record's span", () => {
  const m = (x: Partial<Measured>): Measured => ({ command: "click", tab: "a", front: "x", ms: 10, ok: true, visibleMs: 0, visibilityChanges: 0, focusEvents: [], framesAfter: 0, ...x });
  assert.deepEqual(failures([m({}), m({ command: "record", visibleMs: 3000, visibilityChanges: 2 }), m({ front: "a", visibleMs: 50, framesAfter: 60 })], true), []);
  assert.deepEqual(failures([m({ visibleMs: 12, visibilityChanges: 2 })], true), [`click on tab a (front: x): the hidden page reported "visible" for 12 ms (2 visibilitychange events)`]);
  assert.deepEqual(failures([m({ framesAfter: 3 })], true), ["click on tab a (front: x): the hidden page drew 3 frames in the second after the command"]);
  assert.deepEqual(failures([m({ ok: false, detail: "no click", visibleMs: 12 })], false), ["click on tab a (front: x): no click"], "the default mode: the results only");
  assert.deepEqual(failures([m({ visibleMs: 12, visibilityChanges: 2, framesAfter: 1 })], false), []);
});
