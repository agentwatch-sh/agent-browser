// The CDP calls that each command sends to a background tab (ab-v16.15), in both modes, against the
// fake Chrome's model of a tab that is not in front (FakePage.background: hidden, no frames, input
// dropped before the first frame, mouse moves held, captures that wait), and the pure parts of the live
// check (test/live/background-tabs/spans.ts).
//   default        focus emulation while a command is attached: the page is visible for the command;
//                  a shot under Tab.whileDrawnForShot too (ab-b84.17): alone, its capture would wait for ever
//   hiddenDrive    no focus emulation; input under Tab.whileDrawn, shots under Tab.whileDrawnForShot: the page stays hidden
// Each hidden-mode command gets a new tab whose page never drew a frame, so no earlier command drew it.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentBrowser, Tab } from "../src/browser.ts";
import { optionsFromFlags } from "../src/cli.ts";
import { commands } from "../src/commands.ts";
import { resolveOptions, type InputTiming } from "../src/options.ts";
import { stopProxy } from "../src/proxy.ts";
import { findFfmpeg, planRecording, pngPixels, recordTab } from "../src/record.ts";
import { failures, visibleMs, visibleSpans, type Measured, type PageEvent } from "./live/background-tabs/spans.ts";
import { FakeChrome, SHOT_COLOUR, type Call, type FakePage } from "./fake-chrome.ts";
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
 * A new background tab (`open --tab` makes a background tab; on the Mac a plain `open` does too), opened
 * in the mode `mode`. With the hidden drive its page never drew a frame; in the default mode the open's
 * focus emulation can let it draw. On Linux the explicit tab is what keeps these two modes (ab-v16.26):
 * every other page opens in a window of its own (test/window-per-page.test.ts).
 */
async function backgroundTab(path = "/", mode = h): Promise<{ name: string; page: FakePage }> {
  const name = `t${++tabs}`;
  const r = await commands.open(mode(), { url: fx.base + path, name, tab: true });
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

/** Run `fn` with shorter shot timings (Tab.shotTiming), then set them back. */
async function withTiming<T>(t: Partial<typeof Tab.shotTiming>, fn: () => Promise<T>): Promise<T> {
  const was = { ...Tab.shotTiming };
  Object.assign(Tab.shotTiming, t);
  try { return await fn(); } finally { Object.assign(Tab.shotTiming, was); }
}

/** The options of mode `mode`, with each log line kept in `lines`. */
const logged = (mode: typeof o, lines: string[]) => ({ ...mode(), log: (l: string) => { lines.push(l); } });

/** The shot is complete: its bottom row is drawn too (the fake's frame before Chrome drew two frames of the page lacks it). */
function complete(path: string) {
  const px = pngPixels(readFileSync(path)), i = px.width * (px.height - 1) * px.channels;
  assert.deepEqual([px.data[i], px.data[i + 1], px.data[i + 2]], [...SHOT_COLOUR], "a full frame, not only its top row");
}

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

test("default: click and type on a new background tab send no capture; its shot sends one capture in flight and its own", async () => {
  const { name, page } = await backgroundTab("/", o);
  let { calls } = await callsOf(page, async () => {
    await commands.click(o(), { tab: name, target: "#b" });
    await commands.type(o(), { tab: name, text: "abc", into: "#i" });
    await commands.text(o(), { tab: name });
  });
  assert.equal(page.title, "clicked");
  assert.equal(page.select("#i")[0].value, "abc");
  assert.deepEqual(captures(calls), [], "focus emulation makes the page draw for input");
  assert.deepEqual(page.dropped, []);
  const path = join(c.dir, `${name}.png`);
  let ms: number;
  ({ calls, ms } = await callsOf(page, () => commands.shot(o(), { tab: name, path })));
  fast(ms);
  complete(path);
  assert.deepEqual(captures(calls).map((x) => x.params), [HOLD, { format: "png" }]);
  assert.deepEqual(page.heldCaptures, []);
  await commands.close(o(), { tab: name });
});

test("the fake holds a lone capture of a background page, also while focus emulation makes the page visible and draw, until a later capture ends it", async () => {
  // Chrome ends a capture when the frame that it forces is presented, and a frame of a tab that is not
  // in front is never on screen: on a page that does not change, only a later capture ends it.
  const { name, page } = await backgroundTab("/", o);
  const b = await AgentBrowser.connect(o());
  try {
    const tab = await b.find(name);
    assert.equal(page.visibilityState, "visible", "focus emulation (the attach)");
    let ended = false;
    const first = tab.send("Page.captureScreenshot", { format: "png" }).then(() => { ended = true; });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(ended, false, "alone, the capture waits");
    assert.equal(page.heldCaptures.length, 1);
    await tab.send("Page.captureScreenshot", HOLD);
    await first;
    assert.deepEqual(page.heldCaptures, [], "the later capture ended it, and itself");
  } finally { await b.disconnect(); }
  await commands.close(o(), { tab: name });
});

test("default: shot of a new background tab that never drew: a capture in flight, two frames, then the shot's own capture ends it; complete, at once, focus emulation as before", async () => {
  // As main sent it (its own capture only) the shot waited for ever: 30 s, then an error.
  const { name, page } = await backgroundTab(); // its page never drew a frame
  await commands.text(h(), { tab: name }); // the read-first rule, with no frame
  assert.equal(page.drew, false);
  const path = join(c.dir, `${name}.png`);
  const { calls, ms } = await callsOf(page, () => commands.shot(o(), { tab: name, path }));
  fast(ms);
  complete(path);
  assert.deepEqual(captures(calls).map((x) => x.params), [HOLD, { format: "png" }]);
  const m = methodsOf(calls), attach = m.indexOf("Target.attachToTarget");
  assert.deepEqual(m.slice(attach, attach + 3), ["Target.attachToTarget", "Page.enable", "Emulation.setFocusEmulationEnabled"], "the attach, as before");
  assert.deepEqual(focusCalls(calls), [true]);
  assert.deepEqual(page.visibilityChanges, ["visible", "hidden"], "visible for the command, as before");
  assert.deepEqual(page.heldCaptures, [], "every capture ended");
  await commands.close(o(), { tab: name });
});

test("default: shot of a background tab that drew at its open (default mode): the same, complete and at once", async () => {
  const { name, page } = await backgroundTab("/", o);
  await commands.text(o(), { tab: name });
  const path = join(c.dir, `${name}.png`);
  const { calls, ms } = await callsOf(page, () => commands.shot(o(), { tab: name, path }));
  fast(ms);
  complete(path);
  assert.deepEqual(captures(calls).map((x) => x.params), [HOLD, { format: "png" }]);
  assert.deepEqual(page.heldCaptures, []);
  await commands.close(o(), { tab: name });
});

test("default: shot --size and --full of a new background tab: the capture in flight comes before the override, and none but the shot's own while it is set", async () => {
  let { name, page } = await backgroundTab();
  await commands.text(h(), { tab: name });
  let { calls, ms } = await callsOf(page, () => commands.shot(o(), { tab: name, path: join(c.dir, `${name}.png`), size: "800x600" }));
  assert.ok(ms < 3000, `${ms} ms (with the 0.5 s settle)`);
  const m = methodsOf(calls);
  const set = m.indexOf("Emulation.setDeviceMetricsOverride"), clear = m.indexOf("Emulation.clearDeviceMetricsOverride");
  assert.ok(m.indexOf("Page.captureScreenshot") < set, "the capture in flight comes before the override");
  assert.deepEqual(captures(calls.slice(set, clear)).map((x) => x.params), [{ format: "png" }], "while the override is set, only the shot's own capture (in this mode the relayout does not end the first one)");
  assert.deepEqual(captures(calls.slice(clear)), [], "none after the override is cleared");
  assert.equal(page.metrics, undefined);
  assert.deepEqual(page.heldCaptures, []);
  await commands.close(o(), { tab: name });

  ({ name, page } = await backgroundTab());
  await commands.text(h(), { tab: name });
  ({ calls, ms } = await callsOf(page, () => commands.shot(o(), { tab: name, path: join(c.dir, `${name}.png`), full: true })));
  fast(ms);
  const full = captures(calls).filter((x) => x.params.clip);
  assert.equal(full.length, 1);
  assert.equal(calls.indexOf(full[0]), calls.indexOf(captures(calls).at(-1)!), "the full-page capture is the last one");
  assert.deepEqual(captures(calls).slice(0, -1).map((x) => x.params), [HOLD]);
  assert.deepEqual(page.heldCaptures, []);
  await commands.close(o(), { tab: name });
});

test("default: a tab in front: the shot's capture in flight ends after a frame, then its own", async () => {
  // Focus emulation makes every page "visible", so a shot cannot tell a tab in front from a background one.
  const { name, page } = await backgroundTab("/", o);
  page.background = false;
  page.update();
  await commands.text(o(), { tab: name });
  const { calls, ms } = await callsOf(page, () => commands.shot(o(), { tab: name, path: join(c.dir, `${name}.png`) }));
  fast(ms);
  assert.deepEqual(captures(calls).map((x) => x.params), [HOLD, { format: "png" }]);
  assert.deepEqual(page.heldCaptures, []);
  await commands.close(o(), { tab: name });
});

test("the fake ends earlier captures with a later one only when Chrome drew a frame between them, as Chrome does", async () => {
  // Two captures sent before the next frame share that frame, and nothing replaces it: both wait
  // (review-41, Chromium 156: without a frame between the two captures, every shot failed after 30 s).
  const { name, page } = await backgroundTab("/", o);
  const b = await AgentBrowser.connect(o());
  try {
    const tab = await b.find(name);
    let ended = 0;
    const two = [tab.send("Page.captureScreenshot", HOLD), tab.send("Page.captureScreenshot", HOLD)].map((p) => p.then(() => { ended++; }));
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(ended, 0, "no frame between them: neither ends, though the page drew frames since");
    assert.equal(page.heldCaptures.length, 2);
    await tab.send("Page.captureScreenshot", HOLD);
    await Promise.all(two);
    assert.deepEqual(page.heldCaptures, [], "a third one, after a frame, ends all three");
  } finally { await b.disconnect(); }
  await commands.close(o(), { tab: name });
});

test("the fake models Chrome's size override per session, as measured on Chromium 156 (shot-tidy): a capture that found it and ends after the clear sets the view size for good; a session's end clears its override, and its captures change nothing when they end later", async () => {
  const size = { width: 800, height: 600, deviceScaleFactor: 1, mobile: false }, set = { width: 800, height: 600, deviceScaleFactor: 1 };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  /** A background tab, a session that sets the override and sends a capture that waits under it, then `rest` in that session. */
  async function heldUnder(mode: typeof o, rest: (tab: Tab, held: Promise<unknown>) => Promise<void>): Promise<FakePage> {
    const { page, name } = await backgroundTab("/", mode);
    const b = await AgentBrowser.connect(mode());
    try {
      const tab = await b.find(name);
      await tab.send("Emulation.setDeviceMetricsOverride", size);
      const held = tab.send("Page.captureScreenshot", HOLD);
      held.catch(() => {}); // a capture of a session that ended gets no reply
      await sleep(100);
      assert.equal(page.heldCaptures.length, 1, "a lone capture waits");
      await rest(tab, held);
    } finally { await b.disconnect(); }
    return page;
  }
  /** A capture of a new session: it ends every earlier one. */
  async function laterSession(page: FakePage, mode: typeof o) {
    const b = await AgentBrowser.connect(mode());
    try { await (await b.attach(page.targetId)).send("Page.captureScreenshot", HOLD); } finally { await b.disconnect(); }
    assert.deepEqual(page.heldCaptures, []);
  }
  // The same session (test/live/background-tabs/override.ts): a later capture after the clear ends it (3 of 3, the page
  // visible), and so does the clear's relayout of a hidden page (6 of 6).
  let page = await heldUnder(o, async (tab, held) => {
    await tab.send("Emulation.clearDeviceMetricsOverride");
    await tab.send("Page.captureScreenshot", HOLD);
    await held;
  });
  assert.deepEqual(page.stuck, { width: 800, height: 600 }, "a later capture of the session: the view keeps the shot's size");
  await commands.close(o(), { tab: page.targetId });
  page = await heldUnder(h, async (tab, held) => {
    await tab.send("Emulation.clearDeviceMetricsOverride");
    await held;
  });
  assert.deepEqual(page.stuck, { width: 800, height: 600 }, "the clear's relayout of the hidden page ended it");
  await commands.close(h(), { tab: page.targetId });
  // The session ends with the override set (6 of 6), or after it cleared it (3 of 3, the page visible): a later session
  // ends the capture, with no effect.
  page = await heldUnder(o, async () => {});
  assert.deepEqual(page.metrics, set, "left set by the session");
  assert.equal(page.override, undefined, "the session's end cleared it");
  assert.equal(page.width, 1280);
  await laterSession(page, o);
  assert.equal(page.override, undefined);
  assert.equal(page.stuck, undefined, "the late end changed nothing");
  await commands.close(o(), { tab: page.targetId });
  page = await heldUnder(o, async (tab) => { await tab.send("Emulation.clearDeviceMetricsOverride"); });
  await laterSession(page, o);
  assert.equal(page.override, undefined);
  assert.equal(page.stuck, undefined, "the late end changed nothing");
  await commands.close(o(), { tab: page.targetId });
});

for (const [label, mode] of [["default", o], ["hiddenDrive", h]] as const) {
  test(`${label}: shot of a tab of which Chrome draws no frame: a clear error at the frame limit and a log line, not a silent 30 s wait`, async () => {
    const { name, page } = await backgroundTab("/", mode);
    await commands.text(mode(), { tab: name });
    page.noFrames = true;
    const lines: string[] = [], t0 = Date.now();
    await withTiming({ framesMs: 300 }, () => assert.rejects(commands.shot(logged(mode, lines), { tab: name, path: join(c.dir, `${name}.png`) }),
      /shot: Chrome drew no frame of tab \w+ in 0\.3 s after the shot's first capture/));
    assert.ok(Date.now() - t0 < 3000, `${Date.now() - t0} ms`);
    assert.ok(lines.some((l) => /tab \w+ drew 0 of 2 frames in 0\.3 s/.test(l)), JSON.stringify(lines));
    assert.ok(lines.some((l) => /1 capture of tab \w+ stays in flight/.test(l)), JSON.stringify(lines));
    await commands.close(mode(), { tab: name });
  });

  test(`${label}: shot whose first capture ends just before its own goes out: one more capture ends the shot's capture at once, and none stays in flight`, async () => {
    // The page changes once by itself between the two (review-41, against the fake): the shot's capture
    // then waits alone, and without one more capture it fails after 30 s.
    const { name, page } = await backgroundTab("/", mode);
    await commands.text(mode(), { tab: name });
    page.onCapture = (p) => { if (p.format === "png") page.changeOnce(); };
    const lines: string[] = [], path = join(c.dir, `${name}.png`);
    const { calls, ms } = await withTiming({ lateMs: 300 }, () => callsOf(page, () => commands.shot(logged(mode, lines), { tab: name, path })));
    page.onCapture = undefined;
    fast(ms);
    complete(path);
    assert.deepEqual(captures(calls).map((x) => x.params), [HOLD, { format: "png" }, HOLD]);
    assert.ok(lines.some((l) => /the shot's capture of tab \w+ did not end in 0\.3 s; one more capture goes out to end it/.test(l)), JSON.stringify(lines));
    assert.deepEqual(page.heldCaptures, [], "no capture stays in flight");
    if (mode === h) stayedHidden(page, calls);
    await commands.close(mode(), { tab: name });
  });

  test(`${label}: shot --size of a still page: when the override's relayout ends the first capture in the settle (the hidden drive), a new first capture and two frames come before the shot's own; at once, with no fallback`, async () => {
    // review-41b, Chromium 156, --hidden-drive: without the new first capture, 3 of 3 such shots waited
    // for the 3 s fallback (3.58 s, with its log line); with it, 5 of 5 took 0.61 to 0.64 s.
    const { name, page } = await backgroundTab("/", mode);
    await commands.text(mode(), { tab: name });
    const lines: string[] = [];
    const { calls, ms } = await callsOf(page, () => commands.shot(logged(mode, lines), { tab: name, path: join(c.dir, `${name}.png`), size: "800x600" }));
    assert.ok(ms < 2000, `${ms} ms (with the 0.5 s settle)`);
    const m = methodsOf(calls), set = m.indexOf("Emulation.setDeviceMetricsOverride"), clear = m.indexOf("Emulation.clearDeviceMetricsOverride");
    assert.deepEqual(captures(calls.slice(0, set)).map((x) => x.params), [HOLD]);
    assert.deepEqual(captures(calls.slice(set, clear)).map((x) => x.params), mode === h ? [HOLD, { format: "png" }] : [{ format: "png" }]);
    assert.deepEqual(lines, [], "no limit and no extra capture");
    assert.equal(page.metrics, undefined);
    assert.deepEqual(page.heldCaptures, []);
    await commands.close(mode(), { tab: name });
  });

  test(`${label}: shot --size whose first capture ends just before its own goes out: the extra capture ends before the override is cleared, so the override stays cleared`, async () => {
    const { name, page } = await backgroundTab("/", mode);
    await commands.text(mode(), { tab: name });
    page.onCapture = (p) => { if (p.format === "png") page.changeOnce(); };
    const { calls } = await withTiming({ lateMs: 300 }, () => callsOf(page, () => commands.shot(mode(), { tab: name, path: join(c.dir, `${name}.png`), size: "800x600" })));
    page.onCapture = undefined;
    const m = methodsOf(calls), set = m.indexOf("Emulation.setDeviceMetricsOverride"), clear = m.indexOf("Emulation.clearDeviceMetricsOverride");
    assert.deepEqual(captures(calls.slice(set, clear)).map((x) => x.params), [...(mode === h ? [HOLD] : []), { format: "png" }, HOLD], "the extra capture goes out while the override is set");
    assert.deepEqual(captures(calls.slice(clear)), [], "none after the override is cleared");
    assert.equal(page.metrics, undefined, "no capture ended after the clear (it would set the override again)");
    assert.deepEqual(page.heldCaptures, []);
    await commands.close(mode(), { tab: name });
  });

  test(`${label}: shot when Chrome stops drawing after the two frames: one chain of last captures, not two, and the error gives the shot's true time`, async () => {
    // review-41b: the shot waited about 42 s, its error said 30 s, and two chains left 13 captures.
    const { name, page } = await backgroundTab("/", mode);
    await commands.text(mode(), { tab: name });
    page.onCapture = (p) => { if (p.format === "png") page.noFrames = true; };
    const lines: string[] = [], t0 = Date.now();
    let err = "";
    const { calls } = await withTiming({ lateMs: 100, ownMs: 600, lastMs: 300 },
      () => callsOf(page, () => commands.shot(logged(mode, lines), { tab: name, path: join(c.dir, `${name}.png`) }).catch((e) => { err = (e as Error).message; })));
    const ms = Date.now() - t0;
    page.onCapture = undefined;
    assert.match(err, /did not end the shot's capture of tab \w+ in 0\.6 s \(also not with 3 more captures\).*; the shot gave up after \d+\.\d s\./);
    const said = Number(/gave up after (\d+\.\d) s/.exec(err)![1]) * 1000;
    assert.ok(said > 600 && said <= ms + 100, `the error says ${said} ms; the shot took ${ms} ms`);
    assert.equal(lines.filter((l) => /the last .*capture of tab \w+ did not end/.test(l)).length, 1, `one chain: ${JSON.stringify(lines)}`);
    const n = captures(calls).length;
    assert.ok(n <= 1 + 1 + 3 + 4, `${n} captures: the first, the own, 3 extra, at most 4 last ones`);
    assert.ok(lines.some((l) => new RegExp(`did not end in 0\\.3 s; ${n} captures of it stay in flight`).test(l)), `the true count, ${n}: ${JSON.stringify(lines)}`);
    assert.equal(page.heldCaptures.length, n, "the fake holds them all");
    page.noFrames = false;
    await commands.close(mode(), { tab: name });
  });

  test(`${label}: shot --size when Chrome stops drawing after the two frames and draws no more: its last captures go out under the override, which stays set while captures sent under it may still end; the session's end clears it, and a later command ends them with no change of the size`, async () => {
    // The rest of review-41b's N3 (ab-b84.18): the shot cleared the override with those captures in flight, and its
    // last captures went out after the clear; a capture that ends after the clear sets the view to 800x600 for good.
    const { name, page } = await backgroundTab("/", mode);
    await commands.text(mode(), { tab: name });
    page.onCapture = (p) => { if (p.format === "png") page.noFrames = true; };
    const lines: string[] = [];
    const { calls } = await withTiming({ lateMs: 100, ownMs: 600, lastMs: 300 },
      () => callsOf(page, () => assert.rejects(commands.shot(logged(mode, lines), { tab: name, path: join(c.dir, `${name}.png`), size: "800x600" }), /the shot gave up after/)));
    page.onCapture = undefined;
    const m = methodsOf(calls), set = m.indexOf("Emulation.setDeviceMetricsOverride");
    assert.equal(m.indexOf("Emulation.clearDeviceMetricsOverride"), -1, "no clear while captures sent under the override may still end");
    const under = captures(calls.slice(set)).map((x) => x.params), own = mode === h ? 5 : 4;
    assert.deepEqual(under.slice(0, own), [...(mode === h ? [HOLD] : []), { format: "png" }, HOLD, HOLD, HOLD], "the new first capture (the hidden drive), the own one and 3 extra");
    assert.deepEqual(under.slice(own), [HOLD, HOLD, HOLD, HOLD], "then one chain of last captures, under the override");
    assert.ok(lines.some((l) => /\d+ captures of tab \w+ sent under the size override may still end, .*; the override stays set until the tab's session ends/.test(l)), JSON.stringify(lines));
    assert.ok(lines.some((l) => /stay in flight \(the last captures did not end\).*; \d+ of them went out under the size override/.test(l)), JSON.stringify(lines));
    assert.deepEqual(page.metrics, { width: 800, height: 600, deviceScaleFactor: 1 }, "left set by the shot");
    assert.equal(page.override, undefined, "the end of the command's session cleared it");
    // Chrome draws again: the tab's next commands end those captures, which Chrome dropped with their session.
    page.noFrames = false;
    assert.equal((await commands.eval(mode(), { tab: name, expression: "`${innerWidth}x${innerHeight}`" })).value, "1280x800");
    await commands.shot(mode(), { tab: name, path: join(c.dir, `${name}-2.png`) });
    assert.deepEqual(page.heldCaptures, []);
    assert.equal(page.override, undefined);
    assert.equal(page.stuck, undefined, "no capture set the view size again");
    await commands.close(mode(), { tab: name });
  });

  test(`${label}: shot --size when Chrome stops drawing during its own capture and draws again at its last captures: they go out under the override and end every capture sent under it; then the override is cleared, and the size stays cleared`, async () => {
    // review-41e note 2: after the own capture's timeout the last captures went out after the clear, and ended
    // the captures sent under the override then: the view kept 800x600.
    const { name, page } = await backgroundTab("/", mode);
    await commands.text(mode(), { tab: name });
    let after = 0;
    page.onCapture = (p) => {
      if (p.format === "png") { page.noFrames = true; after = 0; }
      else if (page.noFrames && ++after === 4) page.noFrames = false; // the 3 extra captures, then the first last one
    };
    const lines: string[] = [];
    const { calls } = await withTiming({ lateMs: 100, ownMs: 600, lastMs: 300 },
      () => callsOf(page, () => assert.rejects(commands.shot(logged(mode, lines), { tab: name, path: join(c.dir, `${name}.png`), size: "800x600" }), /the shot gave up after/)));
    page.onCapture = undefined;
    await new Promise((r) => setTimeout(r, 100)); // a frame after the clear
    assert.equal(page.stuck, undefined, "no capture sent under the override ended after the clear");
    assert.equal(page.metrics, undefined);
    assert.deepEqual(page.heldCaptures, []);
    const m = methodsOf(calls), clear = m.indexOf("Emulation.clearDeviceMetricsOverride");
    assert.ok(clear > 0, "cleared");
    assert.deepEqual(captures(calls.slice(clear)), [], "no capture after the clear");
    assert.deepEqual(lines.filter((l) => /stays? set|in flight/.test(l)), [], JSON.stringify(lines));
    await commands.close(mode(), { tab: name });
  });

  test(`${label}: Tab.screenshot with a size when Chrome stops drawing, on a tab that stays attached: the override stays set; the tab's next shot first ends the captures sent under it, then clears it`, async () => {
    const { name, page } = await backgroundTab("/", mode);
    const b = await AgentBrowser.connect(mode());
    try {
      const tab = await b.find(name);
      page.onCapture = (p) => { if (p.format === "png") page.noFrames = true; };
      await withTiming({ lateMs: 100, ownMs: 600, lastMs: 300 },
        () => assert.rejects(tab.screenshot(join(c.dir, `${name}.png`), { viewport: { width: 800, height: 600, scale: 1 } }), /the shot gave up after/));
      page.onCapture = undefined;
      assert.deepEqual(page.override, { width: 800, height: 600, deviceScaleFactor: 1 }, "set while captures sent under it may still end");
      page.noFrames = false;
      const { calls } = await callsOf(page, () => tab.screenshot(join(c.dir, `${name}-2.png`)));
      const m = methodsOf(calls), clear = m.indexOf("Emulation.clearDeviceMetricsOverride");
      const own = calls.findIndex((x) => x.method === "Page.captureScreenshot" && x.params.format === "png");
      assert.ok(clear >= 0 && clear < own, `cleared before the shot's own capture: ${JSON.stringify(m)}`);
      assert.deepEqual(captures(calls.slice(0, clear)).map((x) => x.params), [HOLD], "a last capture under the override ended them all");
      assert.equal(page.override, undefined);
      assert.equal(page.stuck, undefined);
      assert.deepEqual(page.heldCaptures, []);
    } finally { await b.disconnect(); }
    await commands.close(mode(), { tab: name });
  });

  test(`${label}: shot whose last capture Chrome refuses at once: the log gives Chrome's error, not a timeout, and counts only the captures that Chrome may hold`, async () => {
    const { name, page } = await backgroundTab("/", mode);
    await commands.text(mode(), { tab: name });
    let refuse = false;
    page.onCapture = (p) => {
      if (refuse) throw new Error("refused by the test");
      if (p.format === "png") { page.noFrames = true; refuse = true; }
    };
    const lines: string[] = [];
    await withTiming({ lateMs: 100, ownMs: 600, lastMs: 300 },
      () => assert.rejects(commands.shot(logged(mode, lines), { tab: name, path: join(c.dir, `${name}.png`) }), /the shot gave up after/));
    page.onCapture = undefined;
    const chain = lines.filter((l) => /the last .*capture of tab/.test(l));
    assert.equal(chain.length, 1, JSON.stringify(lines));
    assert.match(chain[0], /failed \(Page\.captureScreenshot: refused by the test\); 2 captures of it stay in flight/, "the first and the own capture; Chrome holds no refused one");
    assert.doesNotMatch(chain[0], /did not end in/);
    page.noFrames = false;
    await commands.close(mode(), { tab: name });
  });

  test(`${label}: shot whose page goes to a new page during its own capture: a clear error at once, not a 30 s wait, and no file`, async () => {
    // review-41b, Chromium 156, default mode: Chrome never ended that capture, and the shot failed after 30 s.
    const { name, page } = await backgroundTab("/", mode);
    await commands.text(mode(), { tab: name });
    page.onCapture = (p) => { if (p.format === "png") setTimeout(() => fake.navigate(page, fx.base + "/next"), 5); };
    const path = join(c.dir, `${name}.png`), t0 = Date.now();
    await assert.rejects(commands.shot(mode(), { tab: name, path }), /shot: tab \w+ went to a new page during the shot/);
    page.onCapture = undefined;
    assert.ok(Date.now() - t0 < 2000, `${Date.now() - t0} ms`);
    assert.equal(existsSync(path), false, "no file");
    await commands.close(mode(), { tab: name });
  });

  test(`${label}: shot whose own capture gets Chrome's "Not attached to an active page" before Page.frameNavigated: the clear navigation error`, async () => {
    // review-41e note 6: no test for this mapping (review-41d F2: Chrome's own error in 4 of 56 hidden-drive runs).
    const { name, page } = await backgroundTab("/", mode);
    await commands.text(mode(), { tab: name });
    page.onCapture = (p) => { if (p.format === "png") throw new Error("Not attached to an active page"); };
    const path = join(c.dir, `${name}.png`);
    await assert.rejects(commands.shot(mode(), { tab: name, path }), /shot: tab \w+ went to a new page during the shot/);
    page.onCapture = undefined;
    assert.equal(existsSync(path), false, "no file");
    await commands.close(mode(), { tab: name });
  });

  test(`${label}: shot --size whose own capture Chrome refuses and whose override clear fails: a log line gives the page's size after the shot and before the override`, async () => {
    // review-41e note 6: no test for this log line.
    const { name, page } = await backgroundTab("/", mode);
    await commands.text(mode(), { tab: name });
    page.onCapture = (p) => { if (p.format === "png") throw new Error("refused by the test"); };
    fake.failOnce.set("Emulation.clearDeviceMetricsOverride", "clear refused by the test");
    const lines: string[] = [];
    await withTiming({ underMs: 300 }, () => assert.rejects(commands.shot(logged(mode, lines), { tab: name, path: join(c.dir, `${name}.png`), size: "800x600" }),
      /refused by the test.*; cleanup also failed: clear the device metrics override: .*clear refused by the test/));
    page.onCapture = undefined;
    fake.failOnce.delete("Emulation.clearDeviceMetricsOverride");
    assert.ok(lines.some((l) => /after the failed shot the page of tab \w+ is 800x600, not 1280x800 as before the size override/.test(l)), JSON.stringify(lines));
    await commands.close(mode(), { tab: name });
  });

  test(`${label}: shot whose page goes to a new page during the frame wait, before its own capture: the same clear error at once, not CDP's raw text`, async () => {
    const { name, page } = await backgroundTab("/", mode);
    await commands.text(mode(), { tab: name });
    let first = true;
    page.onCapture = (p) => { if (first && p.format === "jpeg") { first = false; setTimeout(() => fake.navigate(page, fx.base + "/next"), 5); } };
    const path = join(c.dir, `${name}.png`), t0 = Date.now();
    await assert.rejects(commands.shot(mode(), { tab: name, path }), /shot: tab \w+ went to a new page during the shot/);
    page.onCapture = undefined;
    assert.ok(Date.now() - t0 < 2000, `${Date.now() - t0} ms`);
    assert.equal(existsSync(path), false, "no file");
    await commands.close(mode(), { tab: name });
  });

  test(`${label}: shot whose frame wait gets Chrome's "Cannot find context with specified id" before Page.frameNavigated: the clear navigation error, not CDP's raw text`, async () => {
    // review-41e note 4: a navigation destroys the isolated world of the frame wait, and a new world can fail the same way.
    const { name, page } = await backgroundTab("/", mode);
    await commands.text(mode(), { tab: name });
    let first = true;
    page.onCapture = (p) => {
      if (!first || p.format !== "jpeg") return;
      first = false;
      fake.failOnce.set("Runtime.evaluate", "Cannot find context with specified id");
      fake.failOnce.set("Page.createIsolatedWorld", "Cannot find context with specified id");
    };
    const path = join(c.dir, `${name}.png`);
    await assert.rejects(commands.shot(mode(), { tab: name, path }), /shot: tab \w+ went to a new page during the shot/);
    page.onCapture = undefined;
    fake.failOnce.delete("Runtime.evaluate");
    fake.failOnce.delete("Page.createIsolatedWorld");
    assert.equal(existsSync(path), false, "no file");
    await commands.close(mode(), { tab: name });
  });

  test(`${label}: shot --size whose own capture times out and whose override clear fails: the error keeps the cleanup note and gives the whole time`, async () => {
    // review-41c: gaveUpAfter built the message again from its parts and dropped the note. Chrome draws again at
    // the shot's first last capture, so that the shot clears the override (ab-b84.18).
    const { name, page } = await backgroundTab("/", mode);
    await commands.text(mode(), { tab: name });
    let after = 0;
    page.onCapture = (p) => {
      if (p.format === "png") { page.noFrames = true; after = 0; }
      else if (page.noFrames && ++after === 4) page.noFrames = false;
    };
    fake.failOnce.set("Emulation.clearDeviceMetricsOverride", "clear refused by the test");
    await withTiming({ lateMs: 100, ownMs: 600, lastMs: 300 },
      () => assert.rejects(commands.shot(mode(), { tab: name, path: join(c.dir, `${name}.png`), size: "800x600" }),
        /did not end the shot's capture of tab \w+ in 0\.6 s.*; the shot gave up after \d+\.\d s\. .*; cleanup also failed: clear the device metrics override: .*clear refused by the test/));
    page.onCapture = undefined;
    fake.failOnce.delete("Emulation.clearDeviceMetricsOverride");
    page.noFrames = false;
    await commands.close(mode(), { tab: name }).catch(() => {});
  });

  test(`${label}: shot --size whose page goes to a new page during its own capture: the override is cleared only after the captures sent under it ended, so the size stays cleared`, async () => {
    // review-41d live: the shot cleared the override at once; the own capture ended 25 ms to 1.1 s
    // later and set the view to 800x600 again, for good (default mode 9 of 18 runs at c86c9b3).
    const { name, page } = await backgroundTab("/", mode);
    await commands.text(mode(), { tab: name });
    page.onCapture = (p) => { if (p.format === "png") setTimeout(() => fake.navigate(page, fx.base + "/next"), 5); };
    const lines: string[] = [];
    await assert.rejects(commands.shot(logged(mode, lines), { tab: name, path: join(c.dir, `${name}.png`), size: "800x600" }), /went to a new page during the shot/);
    page.onCapture = undefined;
    await new Promise((r) => setTimeout(r, 200)); // a late capture would end by now
    assert.equal(page.metrics, undefined, "no capture sent under the override ended after the clear");
    assert.equal(page.stuck, undefined, "the view size was not set again for good");
    assert.deepEqual(lines.filter((l) => /is \d+x\d+, not/.test(l)), [], JSON.stringify(lines));
    await commands.close(mode(), { tab: name });
  });

  test(`${label}: shot whose tab is off the allowlist when its own capture ends: refused, and no file`, async () => {
    const { name, page } = await backgroundTab("/", mode);
    await commands.text(mode(), { tab: name });
    page.onCapture = (p) => { if (p.format === "png") page.url = "https://off-the-list.example/"; };
    const path = join(c.dir, `${name}.png`);
    await assert.rejects(commands.shot(mode(), { tab: name, path }), /off-the-list\.example is not on the allowlist/);
    page.onCapture = undefined;
    assert.equal(existsSync(path), false, "no file");
    await commands.close(mode(), { tab: name }).catch(() => {});
  });

  test(`${label}: shot --size whose tab is off the allowlist when its own capture ends: refused, the override cleared, and no page code in the off-list page after the failure`, async () => {
    // review-41e note 1: the page-size read after the failure ran in the off-list page (Page.createIsolatedWorld,
    // Runtime.evaluate; 1 of 3 default-mode runs, 6 of 6 hidden-drive runs).
    const { name, page } = await backgroundTab("/", mode);
    await commands.text(mode(), { tab: name });
    page.onCapture = (p) => { if (p.format === "png") page.url = "https://off-the-list.example/"; };
    const path = join(c.dir, `${name}.png`);
    const { calls } = await callsOf(page, () => assert.rejects(commands.shot(mode(), { tab: name, path, size: "800x600" }), /off-the-list\.example is not on the allowlist/));
    page.onCapture = undefined;
    const m = methodsOf(calls), clear = m.indexOf("Emulation.clearDeviceMetricsOverride");
    assert.ok(clear > 0, "cleared");
    assert.deepEqual(m.slice(clear).filter((x) => x === "Runtime.evaluate" || x === "Page.createIsolatedWorld"), [], "no page code after the failure");
    assert.equal(existsSync(path), false, "no file");
    await commands.close(mode(), { tab: name }).catch(() => {});
  });

  test(`${label}: shot --full whose first capture ends during the frame wait: one more first capture and two frames come before the full-page capture`, async () => {
    // No capture may go out while a full-page capture waits: it changes the device emulation, and a
    // capture sent then would set that emulation again when it ends.
    const { name, page } = await backgroundTab("/", mode);
    await commands.text(mode(), { tab: name });
    let first = true;
    page.onCapture = (p) => { if (first && p.format === "jpeg") { first = false; page.atFrame(() => page.atFrame(() => page.changeOnce())); } };
    const { calls, ms } = await callsOf(page, () => commands.shot(mode(), { tab: name, path: join(c.dir, `${name}.png`), full: true }));
    page.onCapture = undefined;
    fast(ms);
    const all = captures(calls);
    assert.deepEqual(all.slice(0, -1).map((x) => x.params), [HOLD, HOLD]);
    assert.ok(all.at(-1)!.params.clip, "the full-page capture is the last one");
    assert.deepEqual(page.heldCaptures, []);
    await commands.close(mode(), { tab: name });
  });
}

test("default: shot --size --full whose full-page capture never ends, the only capture under the override: no clear while it may still end; the session's end clears the override", async () => {
  // review-65 N1: when the shot's own capture was not marked as sent under the override, no test failed; here it is
  // the only one (a full-page capture gets no extra capture), and the shot would clear the override while it is in flight.
  const { name, page } = await backgroundTab("/", o);
  await commands.text(o(), { tab: name });
  page.onCapture = (p) => { if (p.format === "png") page.noFrames = true; };
  const lines: string[] = [];
  const { calls } = await withTiming({ lateMs: 100, ownMs: 600, lastMs: 300, underMs: 300 },
    () => callsOf(page, () => assert.rejects(commands.shot(logged(o, lines), { tab: name, path: join(c.dir, `${name}.png`), size: "800x600", full: true }), /the shot gave up after/)));
  page.onCapture = undefined;
  const m = methodsOf(calls), set = m.indexOf("Emulation.setDeviceMetricsOverride");
  assert.deepEqual(captures(calls.slice(set)).map((x) => !!x.params.clip), [true], "the full-page capture alone under the override");
  assert.equal(m.indexOf("Emulation.clearDeviceMetricsOverride"), -1, "no clear while it may still end");
  assert.ok(lines.some((l) => /1 capture of tab \w+ sent under the size override may still end/.test(l)), JSON.stringify(lines));
  assert.deepEqual(page.metrics, { width: 800, height: 600, deviceScaleFactor: 1 }, "left set by the shot");
  assert.equal(page.override, undefined, "the end of the command's session cleared it");
  page.noFrames = false;
  await commands.close(o(), { tab: name });
});

// ---------- a size override that a shot left set, on a Tab kept attached ----------

/** A page in a window of its own (Linux, on a display of the agent browser's own; ab-v16.26), with fast input. */
const FAST_INPUT: Partial<InputTiming> = { pressMs: [6, 9], keyMs: [6, 9], holdMs: [1, 2], settleMs: [1, 3], wheelMs: [1, 3], moveScale: 0.05, activateMs: 300 };
const w = () => c.options({ endpoint: fake.ws, platform: "linux", display: { own: true }, inputTiming: FAST_INPUT });

/**
 * A Tab kept attached (a program's, not the CLI's), whose Tab.screenshot with a size failed while Chrome drew nothing:
 * the shot left the override set, with captures sent under it in flight. Then Chrome draws again. In a window of its
 * own the page is behind another tab of its window, so that it holds captures (review-65's probe).
 */
async function withSizeLeft(drive: "window" | "hidden"): Promise<{ b: AgentBrowser; tab: Tab; page: FakePage; name: string }> {
  const mode = drive === "window" ? w : h, name = `s${++tabs}`;
  const r = await commands.open(mode(), { url: fx.base + "/", name, ...(drive === "window" ? {} : { tab: true }) });
  const page = fake.pages.get(r.tab.targetId)!;
  const b = await AgentBrowser.connect(mode());
  const tab = await b.find(name);
  assert.equal(tab.drive, drive);
  if (drive === "window") { page.background = true; page.update(); }
  page.onCapture = (p) => { if (p.format === "png") page.noFrames = true; };
  await withTiming({ lateMs: 100, ownMs: 600, lastMs: 300 },
    () => assert.rejects(tab.screenshot(join(c.dir, `${name}.png`), { viewport: { width: 800, height: 600, scale: 1 } }), /the shot gave up after/));
  page.onCapture = undefined;
  assert.deepEqual(page.override, { width: 800, height: 600, deviceScaleFactor: 1 }, "left set");
  assert.ok(page.heldCaptures.length > 0, "captures sent under it are in flight");
  page.noFrames = false;
  return { b, tab, page, name };
}

/** The next command ended the captures under the override and cleared it before its own work (`own`); no size stuck. */
function endedFirst(page: FakePage, calls: Call[], own: (x: Call) => boolean) {
  const clear = calls.findIndex((x) => x.method === "Emulation.clearDeviceMetricsOverride"), first = calls.findIndex(own);
  assert.ok(clear >= 0 && first > clear, `the clear before the command's own work: ${JSON.stringify(methodsOf(calls))}`);
  assert.deepEqual(captures(calls.slice(0, clear)).map((x) => x.params), [HOLD], "a last capture under the override ended them");
  assert.equal(page.stuck, undefined, "no capture sent under the override ended after the clear");
  assert.deepEqual(page.heldCaptures, []);
}

for (const drive of ["window", "hidden"] as const) {
  const label = drive === "window" ? "a window of its own" : "hiddenDrive";
  for (const [input, run] of [["click", (tab: Tab) => tab.click("#b")], ["type", (tab: Tab) => tab.type("abc", "#i")]] as const)
    test(`${label}: Tab.${input} on a tab kept attached, after a Tab.screenshot with a size left the override set: the input first ends the captures sent under it, then clears it`, async () => {
      // review-65 B1: in a window of its own, input goes to Tab.byHand, which did not end them: after a click the
      // override was still 800x600, with 9 captures held.
      const { b, tab, page, name } = await withSizeLeft(drive);
      try {
        const { calls } = await callsOf(page, () => run(tab));
        endedFirst(page, calls, (x) => x.method.startsWith("Input."));
        assert.equal(page.override, undefined);
        if (input === "click") assert.equal(page.title, "clicked");
        else assert.equal(page.select("#i")[0].value, "abc");
      } finally { await b.disconnect(); }
      await commands.close(drive === "window" ? w() : h(), { tab: name });
    });
}

for (const drive of ["window", "hidden"] as const) {
  const label = drive === "window" ? "a window of its own" : "hiddenDrive";
  const mode = drive === "window" ? w : h;

  test(`${label}: Tab.setFiles on a tab kept attached, after a Tab.screenshot with a size left the override set: it first ends the captures sent under it, then clears it`, async () => {
    // review-65 B1: out of a window of its own, setFiles goes neither to whileDrawn nor to byHand (review-65b N4: both drives).
    const { b, tab, page, name } = await withSizeLeft(drive);
    const file = join(c.dir, `${name}.txt`);
    writeFileSync(file, "x");
    try {
      const { calls } = await callsOf(page, () => tab.setFiles("#f", [file]));
      endedFirst(page, calls, (x) => x.method.startsWith("Input.") || x.method === "DOM.setFileInputFiles");
      assert.equal(page.override, undefined);
      assert.ok(calls.some((x) => x.method === "DOM.setFileInputFiles"), "the files reached the input");
    } finally { await b.disconnect(); }
    await commands.close(mode(), { tab: name });
  });

  test(`${label}: recordTab on a tab kept attached, after a Tab.screenshot with a size left the override set: the record first ends the captures sent under it and clears it, before its own override`, needsFfmpeg, async () => {
    // review-65: record set and cleared its own override while those captures were in flight; one that ends after
    // that clear sets 800x600 again (review-65b N4: both drives; around the take, Tab.withInput, as the record command).
    const { b, tab, page, name } = await withSizeLeft(drive);
    try {
      const plan = planRecording({ out: join(c.dir, `${name}.mp4`), size: "320x180", fps: 10, settle: 100, ffmpeg: FFMPEG }, b.allow);
      const { calls } = await callsOf(page, () => recordTab(tab, plan, (take) => tab.withInput(take)));
      assert.deepEqual(calls.filter((x) => x.method === "Emulation.setDeviceMetricsOverride").map((x) => x.params.width), [320], "the record's own override only");
      endedFirst(page, calls, (x) => x.method === "Emulation.setDeviceMetricsOverride");
      assert.equal(page.override, undefined, "the record cleared its own");
    } finally { await b.disconnect(); }
    await commands.close(mode(), { tab: name });
  });

  test(`${label}: two clicks at the same time on a tab kept attached, after a Tab.screenshot with a size left the override set: one ending of those captures and one clear, which the second click waits for`, async () => {
    // review-65b B1: each call of endSizeLeft sent its own captures and its own clear; a capture of the second ended
    // after the first's clear, and the view kept 800x600 (9 of 24 cases of its probe). The second click comes while
    // the first one's last capture under the override is in flight.
    const { b, tab, page, name } = await withSizeLeft(drive);
    try {
      let second: Promise<void> | undefined;
      page.onCapture = (p) => { if (!second && p.format === "jpeg" && page.override) second = tab.click("#b"); };
      const { calls } = await callsOf(page, async () => {
        const first = tab.click("#b");
        await first.finally(() => { page.onCapture = undefined; });
        assert.ok(second, "the second click came during the first one's ending of those captures");
        await second;
      });
      const m = methodsOf(calls), clear = m.indexOf("Emulation.clearDeviceMetricsOverride");
      assert.equal(m.filter((x) => x === "Emulation.clearDeviceMetricsOverride").length, 1, `one clear: ${JSON.stringify(m)}`);
      assert.deepEqual(captures(calls.slice(0, clear)).map((x) => x.params), [HOLD], "one last capture under the override, for both clicks");
      await new Promise((r) => setTimeout(r, 100)); // a frame after the clear
      assert.equal(page.stuck, undefined, "no capture sent under the override ended after the clear");
      assert.equal(page.override, undefined);
      assert.deepEqual(page.heldCaptures, []);
      assert.equal(page.title, "clicked");
    } finally { page.onCapture = undefined; await b.disconnect(); }
    await commands.close(mode(), { tab: name });
  });

  test(`${label}: Tab.goto on a tab kept attached, after a Tab.screenshot with a size left the override set: it first ends the captures sent under it and clears it, so the new page loads at the tab's own size`, async () => {
    // review-65b N1: after goto the new page loaded at the shot's size. The reads (text, outline, eval, waitFor)
    // still see the shot's size until the next input, shot, record or goto.
    const { b, tab, page, name } = await withSizeLeft(drive);
    try {
      const { calls } = await callsOf(page, () => tab.goto(fx.base + "/next"));
      endedFirst(page, calls, (x) => x.method === "Page.navigate");
      assert.equal(page.override, undefined);
      assert.equal(await tab.evaluate(() => `${innerWidth}x${innerHeight}`), "1280x800");
    } finally { await b.disconnect(); }
    await commands.close(mode(), { tab: name });
  });
}

test("default: record keeps the attach's focus emulation and turns none on or off itself", needsFfmpeg, async () => {
  const { name, page } = await backgroundTab("/", o);
  const script = join(c.dir, `${name}-steps.json`);
  writeFileSync(script, JSON.stringify([{ wait: 200 }]));
  const { calls } = await callsOf(page, () => commands.record(o(), { tab: name, out: join(c.dir, `${name}.mp4`), script, size: "320x180", fps: 10, settle: 100, ffmpeg: FFMPEG }));
  assert.deepEqual(focusCalls(calls), [true], "the attach's only");
  await commands.close(o(), { tab: name });
});

// ---------- the hidden drive ----------

test("hiddenDrive: shot --size whose new first capture, sent under the override, gets no frame: the shot fails at the limit, and the override stays set while that capture may still end; the session's end clears it", async () => {
  // review-41c: that step ran outside the own capture's try, so nothing said that the override can
  // come back when the capture ends after the clear. ab-b84.18: no clear while it may still end.
  const { name, page } = await backgroundTab();
  await commands.text(h(), { tab: name });
  page.onCapture = (p) => { if (p.format === "jpeg" && page.override) page.noFrames = true; };
  const lines: string[] = [];
  const { calls } = await withTiming({ framesMs: 300, underMs: 300 },
    () => callsOf(page, () => assert.rejects(commands.shot(logged(h, lines), { tab: name, path: join(c.dir, `${name}.png`), size: "800x600" }), /shot: Chrome drew no frame of tab \w+ in 0\.3 s/)));
  page.onCapture = undefined;
  assert.equal(methodsOf(calls).indexOf("Emulation.clearDeviceMetricsOverride"), -1, "no clear");
  assert.deepEqual(page.metrics, { width: 800, height: 600, deviceScaleFactor: 1 }, "left set by the shot");
  assert.equal(page.override, undefined, "the end of the command's session cleared it");
  assert.ok(lines.some((l) => /1 capture of tab \w+ sent under the size override may still end/.test(l)), JSON.stringify(lines));
  assert.ok(lines.some((l) => /stays? in flight \(Chrome drew no frame\).*; 1 of them went out under the size override/.test(l)), JSON.stringify(lines));
  page.noFrames = false;
  await commands.close(h(), { tab: name });
});

test("hiddenDrive: shot --size whose own capture Chrome refuses while the new first capture waits under the override: a log line when it did not end in the wait (underMs); a last capture under the override ends it, and only then the override is cleared", async () => {
  // review-41e note 6: no test for that log line. Before ab-b84.18 the shot cleared the override next, and the
  // clear's relayout (or the last capture after it) ended that capture: the view kept 800x600.
  const { name, page } = await backgroundTab();
  await commands.text(h(), { tab: name });
  page.onCapture = (p) => { if (p.format === "png") throw new Error("refused by the test"); };
  const lines: string[] = [];
  const { calls } = await withTiming({ underMs: 300 },
    () => callsOf(page, () => assert.rejects(commands.shot(logged(h, lines), { tab: name, path: join(c.dir, `${name}.png`), size: "800x600" }), /refused by the test/)));
  page.onCapture = undefined;
  await new Promise((r) => setTimeout(r, 100)); // a frame after the clear
  assert.equal(page.stuck, undefined, "no capture sent under the override ended after the clear");
  assert.equal(page.metrics, undefined);
  assert.deepEqual(page.heldCaptures, []);
  assert.ok(lines.some((l) => /the captures of tab \w+ sent under the size override did not end in 0\.3 s after the shot failed/.test(l)), JSON.stringify(lines));
  const m = methodsOf(calls), set = m.indexOf("Emulation.setDeviceMetricsOverride"), clear = m.indexOf("Emulation.clearDeviceMetricsOverride");
  assert.deepEqual(captures(calls.slice(set, clear)).map((x) => x.params), [HOLD, { format: "png" }, HOLD], "the new first capture, the own one, a last one");
  assert.deepEqual(captures(calls.slice(clear)), [], "no capture after the clear");
  await commands.close(h(), { tab: name });
});

test("hiddenDrive: shot --size whose page goes to a new page during the new first capture's frame wait: the clear error, and the override is cleared only after that capture ended", async () => {
  // review-41c and review-41d live: the first capture ended after the clear and set 800x600 again.
  const { name, page } = await backgroundTab();
  await commands.text(h(), { tab: name });
  page.onCapture = (p) => { if (p.format === "jpeg" && page.metrics) setTimeout(() => fake.navigate(page, fx.base + "/next"), 5); };
  const { calls } = await callsOf(page, () => assert.rejects(commands.shot(h(), { tab: name, path: join(c.dir, `${name}.png`), size: "800x600" }), /went to a new page during the shot/));
  page.onCapture = undefined;
  assert.equal(methodsOf(calls).filter((x) => x === "Emulation.clearDeviceMetricsOverride").length, 1);
  assert.equal(page.metrics, undefined, "the capture under the override ended before the clear");
  assert.equal(page.stuck, undefined, "and did not set the view size again for good");
  await commands.close(h(), { tab: name });
});

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

test("hiddenDrive: shot of a new background tab: one hidden capture first, two frames, and the shot's own capture ends it; complete, at once", async () => {
  const { name, page } = await backgroundTab();
  await commands.text(h(), { tab: name }); // the read-first rule
  const path = join(c.dir, `${name}.png`);
  const { calls, ms } = await callsOf(page, () => commands.shot(h(), { tab: name, path }));
  assert.ok(existsSync(path));
  fast(ms);
  complete(path);
  assert.deepEqual(captures(calls).map((x) => x.params), [HOLD, { format: "png" }]);
  stayedHidden(page, calls);
  await commands.close(h(), { tab: name });
});

test("hiddenDrive: shot --size and --full of a new background tab: while the size override is set, only a new first capture and the shot's own, which end before the clear", async () => {
  // A capture remembers the emulation that it found and restores it when it ends: one sent while the
  // size override is set would set it again if it ended after the shot cleared it.
  let { name, page } = await backgroundTab();
  await commands.text(h(), { tab: name });
  let { calls } = await callsOf(page, () => commands.shot(h(), { tab: name, path: join(c.dir, `${name}.png`), size: "800x600" }));
  const m = methodsOf(calls);
  const set = m.indexOf("Emulation.setDeviceMetricsOverride"), clear = m.indexOf("Emulation.clearDeviceMetricsOverride");
  assert.ok(m.indexOf("Page.captureScreenshot") < set, "the hidden capture comes before the override");
  assert.deepEqual(captures(calls.slice(set, clear)).map((x) => x.params), [HOLD, { format: "png" }], "while the override is set, a new first capture (the relayout ended the first) and the shot's own");
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
