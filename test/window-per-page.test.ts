// One window per agent page (ab-v16.26; docs/research/2026-11-05-anti-detect-drive.md, "The answer"):
// in agent mode on Linux, `open` gives each page a window of its own and no command sends focus
// emulation, against the fake Chrome's model of a window that is not in front (visible, drawing, the
// focus at the first press: FakeChrome.focusedWindow). An explicit `open --tab` keeps the old modes for
// its tab. On the Mac (ab-v16.27) the same design with no activation: against the fake's Mac model
// (FakeChrome.macWindows: a press gives the focus with no activation, a popup tab hides its opener, which
// shows again about 1.0 s after the popup closed). In personal mode every behaviour stays as it was. Each
// test names its platform (the internal `platform` option), so the suite gives the same results on Linux
// and macOS.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentBrowser } from "../src/browser.ts";
import { commands } from "../src/commands.ts";
import { macWindows, resolveOptions, windowPerPage, type BrowserOptions, type InputTiming } from "../src/options.ts";
import { stopProxy } from "../src/proxy.ts";
import { findFfmpeg } from "../src/record.ts";
import { FakeChrome, type Call, type FakePage } from "./fake-chrome.ts";
import { cli, consumer, fixtureServer, flags, site, type Consumer, type Fixture } from "./helpers.ts";

const FFMPEG = (() => { try { return findFfmpeg(); } catch { return undefined; } })();
const needsFfmpeg = { skip: FFMPEG ? false : "no ffmpeg (with libx264) on PATH" };

let fx: Fixture, fake: FakeChrome, c: Consumer, operator: FakePage;
/** Agent mode on Linux, through the proxy to the fake, on a display of the agent browser's own (the fake is on none: the test says so). */
const linux = (extra: Partial<BrowserOptions> = {}) => c.options({ endpoint: fake.ws, platform: "linux", display: { own: true }, ...extra });
const mac = (extra: Partial<BrowserOptions> = {}) => c.options({ endpoint: fake.ws, platform: "darwin", ...extra });
/** Short input times, as in person-input.test.ts. */
const FAST: Partial<InputTiming> = { pressMs: [6, 9], keyMs: [6, 9], holdMs: [1, 2], settleMs: [1, 3], wheelMs: [1, 3], moveScale: 0.05, activateMs: 300 };

before(async () => {
  fx = await fixtureServer();
  fake = await FakeChrome.start(site(fx.base));
  fake.backgroundTabs = true;
  c = consumer();
  // The page in front of the active window: the operator's tab, or another agent's page.
  operator = fake.addPage(`${fx.base}/next`);
});

after(async () => {
  stopProxy(resolveOptions(c.options()));
  await fake?.close();
  await fx?.close();
  c?.remove();
});

let n = 0;
/** The CDP calls that `fn` sent to the page. */
async function callsOf(page: FakePage, fn: () => Promise<unknown>): Promise<Call[]> {
  const from = fake.calls.length;
  await fn();
  return fake.calls.slice(from).filter((x) => x.targetId === page.targetId);
}
const focusCalls = (calls: Call[]) => calls.filter((x) => x.method === "Emulation.setFocusEmulationEnabled").map((x) => x.params.enabled);
const createCalls = (from: number) => fake.calls.slice(from).filter((x) => x.method === "Target.createTarget").map((x) => x.params);

/** Open a page with `open` in the options `o` (and `tab`): its fake page, its name, and the Target.createTarget it sent. */
async function opened(o: BrowserOptions, tab = false): Promise<{ name: string; page: FakePage; create: any }> {
  const name = `w${++n}`, from = fake.calls.length;
  const r = await commands.open(o, { url: `${fx.base}/`, name, ...(tab ? { tab: true } : {}) });
  const create = createCalls(from);
  assert.equal(create.length, 1);
  return { name, page: fake.pages.get(r.tab.targetId)!, create: create[0] };
}

/** The operator's page is in front and has the focus again (another test may have activated its own window). */
function operatorInFront() {
  fake.focusWindow(operator.windowId, "test");
  operator.focusEvents.length = 0;
}

test("windowPerPage: agent mode on Linux and on the Mac (on the Mac not behind agent mode's endpoint); not in personal mode", () => {
  assert.equal(windowPerPage(resolveOptions(linux())), true);
  assert.equal(windowPerPage(resolveOptions(mac())), true);
  assert.equal(windowPerPage(resolveOptions({ ...linux(), mode: "personal" })), false);
  assert.equal(windowPerPage(resolveOptions({ ...mac(), mode: "personal" })), false);
  assert.equal(windowPerPage(resolveOptions({ ...mac(), endpoint: undefined, cdpUrl: "ws+unix:///tmp/x.sock:/devtools/browser/a" })), false, "the relay keeps its tabs on the Mac");
  assert.equal(windowPerPage(resolveOptions({ ...linux(), platform: "win32" })), false);
  assert.equal(macWindows(resolveOptions(mac())), true);
  assert.equal(macWindows(resolveOptions(linux())), false);
  assert.equal(resolveOptions(c.options()).platform, process.platform, "the default is this machine's platform");
});

test("Linux: open gives the page a window of its own, in the background: visible and drawing, no focus, no focus emulation", async () => {
  operatorInFront();
  const { name, page, create } = await opened(linux());
  assert.deepEqual(create, { url: "about:blank", background: true, newWindow: true });
  assert.notEqual(page.windowId, operator.windowId, "a window of its own");
  assert.equal(page.background, false, "the front tab of its window");
  assert.equal(page.visibilityState, "visible");
  assert.equal(page.drawing, true, "Chrome draws a window that is not in front (with --disable-backgrounding-occluded-windows)");
  assert.equal(page.hasFocus, false, "a new window with background: true does not take the focus");
  assert.equal(fake.focusedWindow, operator.windowId);
  assert.deepEqual(page.focusEmulated, new Set(), "no focus emulation");
  assert.deepEqual(focusCalls(fake.callsFor(page.targetId)), [], "the open sent none");
  assert.deepEqual(operator.focusEvents, [], "the operator's page kept the focus");
  assert.equal(existsSync(join(c.stateDir, "tab-pages.json")), false, "a window page is not a tab page");
  await commands.close(linux(), { tab: name });
});

test("Linux: commands on a window page send no focus emulation; its first press activates its window, as a person's click does", async () => {
  operatorInFront();
  const { name, page } = await opened(linux());
  let calls = await callsOf(page, async () => {
    await commands.text(linux(), { tab: name });
    await commands.eval(linux(), { tab: name, expression: "document.hasFocus()" });
  });
  assert.deepEqual(focusCalls(calls), []);
  assert.equal(page.hasFocus, false, "a read gives the page no focus");
  assert.deepEqual(page.visibilityChanges, [], "and no visibility change");
  calls = await callsOf(page, () => commands.click(linux(), { tab: name, target: "#b" }));
  assert.equal(page.title, "clicked");
  assert.deepEqual(focusCalls(calls), []);
  assert.equal(page.hasFocus, true, "the press gave the page the focus");
  assert.equal(fake.focusedWindow, page.windowId, "Chrome activated the page's window");
  assert.deepEqual(operator.focusEvents, ["blur"], "the operator's page got a blur, as for a person's click on another window");
  calls = await callsOf(page, async () => {
    await commands.type(linux(), { tab: name, text: "abc", into: "#i" });
    await commands.press(linux(), { tab: name, key: "Enter" });
    await commands.text(linux(), { tab: name });
    await commands.shot(linux(), { tab: name, path: join(c.dir, `${name}.png`) });
  });
  assert.equal(page.select("#i")[0].value, "abc");
  assert.deepEqual(focusCalls(calls), []);
  assert.deepEqual(page.visibilityChanges, [], "the page was visible all the time");
  assert.deepEqual(page.focusEvents, ["focus"], "one focus, from the press");
  assert.deepEqual(page.heldCaptures, [], "the shot's captures ended: Chrome draws the window");
  await commands.close(linux(), { tab: name });
});

test("Linux: a shot of a window page is complete and fast, with no focus emulation", async () => {
  const { name, page } = await opened(linux());
  await commands.text(linux(), { tab: name });
  const t0 = Date.now();
  const calls = await callsOf(page, () => commands.shot(linux(), { tab: name, path: join(c.dir, `${name}.png`) }));
  assert.ok(Date.now() - t0 < 2000, `${Date.now() - t0} ms`);
  assert.ok(readFileSync(join(c.dir, `${name}.png`)).length > 0);
  assert.deepEqual(focusCalls(calls), []);
  assert.deepEqual(page.heldCaptures, []);
  await commands.close(linux(), { tab: name });
});

test("Linux: open --tab keeps the old default for its tab: a background tab, focus emulation on each attach; the record of tab pages drops it at its close", async () => {
  operatorInFront();
  const { name, page, create } = await opened(linux(), true);
  assert.deepEqual(create, { url: "about:blank", background: true, newWindow: false });
  assert.equal(page.windowId, operator.windowId, "a tab in the current window");
  assert.equal(page.background, true);
  assert.deepEqual(JSON.parse(readFileSync(join(c.stateDir, "tab-pages.json"), "utf8")), [page.targetId]);
  page.visibilityChanges.length = 0;
  const calls = await callsOf(page, () => commands.click(linux(), { tab: name, target: "#b" }));
  assert.equal(page.title, "clicked");
  assert.deepEqual(focusCalls(calls), [true], "a later command (a new connection) knows the tab page too");
  assert.deepEqual(page.visibilityChanges, ["visible", "hidden"], "the old default: visible for the command");
  await commands.close(linux(), { tab: name });
  assert.deepEqual(JSON.parse(readFileSync(join(c.stateDir, "tab-pages.json"), "utf8")), []);
});

test("Linux: open --tab with hiddenDrive keeps the hidden drive: no focus emulation, the page stays hidden", async () => {
  const { name, page } = await opened(linux({ hiddenDrive: true }), true);
  assert.equal(page.background, true);
  page.visibilityChanges.length = 0;
  const calls = await callsOf(page, () => commands.click(linux({ hiddenDrive: true }), { tab: name, target: "#b" }));
  assert.equal(page.title, "clicked");
  assert.deepEqual(focusCalls(calls), []);
  assert.ok(calls.some((x) => x.method === "Page.captureScreenshot"), "a hidden capture keeps Chrome drawing the hidden page (Tab.whileDrawn)");
  assert.deepEqual(page.visibilityChanges, []);
  await commands.close(linux(), { tab: name });
});

test("Linux: hiddenDrive does not change a window page: no focus emulation and no hidden capture for input", async () => {
  const { name, page } = await opened(linux({ hiddenDrive: true }));
  assert.equal(page.background, false);
  const calls = await callsOf(page, () => commands.click(linux({ hiddenDrive: true }), { tab: name, target: "#b" }));
  assert.equal(page.title, "clicked");
  assert.deepEqual(focusCalls(calls), []);
  assert.ok(!calls.some((x) => x.method === "Page.captureScreenshot"));
  await commands.close(linux(), { tab: name });
});

test("Linux: a page that a site opens from a window page (window.open) is driven where it opened, with no focus emulation", async () => {
  const { name, page } = await opened(linux());
  const b = await AgentBrowser.connect(linux());
  let popupId: string;
  try {
    const tab = await b.find(name);
    const before = new Set(fake.pages.keys());
    await tab.evaluate((u: string) => { window.open(u, "_blank"); }, `${fx.base}/next`);
    popupId = [...fake.pages.keys()].find((id) => !before.has(id))!;
  } finally { await b.disconnect(); }
  const popup = fake.pages.get(popupId!)!;
  assert.equal(popup.windowId, page.windowId, "the site put it in the opener's window");
  const calls = await callsOf(popup, async () => {
    const r = await commands.text(linux(), { tab: popupId.slice(0, 8) });
    assert.match(r.text, /the next page/);
  });
  assert.deepEqual(focusCalls(calls), []);
  assert.equal(popup.windowId, page.windowId, "never moved to another window");
  await commands.close(linux(), { tab: popupId!.slice(0, 8) });
  await commands.close(linux(), { tab: name });
});

test("Linux: record in a window page sends no focus emulation, also with hiddenDrive", needsFfmpeg, async () => {
  for (const o of [linux(), linux({ hiddenDrive: true })]) {
    const { name, page } = await opened(o);
    const script = join(c.dir, `${name}-steps.json`);
    writeFileSync(script, JSON.stringify([{ wait: 300 }]));
    const calls = await callsOf(page, async () => {
      const r = await commands.record(o, { tab: name, out: join(c.dir, `${name}.mp4`), script, size: "320x180", fps: 10, settle: 100, ffmpeg: FFMPEG });
      assert.ok(r.frames >= 2, `${r.frames} frames`);
    });
    assert.deepEqual(focusCalls(calls), []);
    assert.deepEqual(page.visibilityChanges, [], "visible all the time");
    await commands.close(o, { tab: name });
  }
});

test("the Mac: open gives the page a window of its own in the background, with no focus emulation; open --tab keeps the old default for its tab", async () => {
  operatorInFront();
  const { name, page, create } = await opened(mac());
  assert.deepEqual(create, { url: "about:blank", background: true, newWindow: true });
  assert.notEqual(page.windowId, operator.windowId, "a window of its own");
  assert.equal(page.visibilityState, "visible");
  assert.equal(page.hasFocus, false);
  assert.equal(fake.focusedWindow, operator.windowId, "the operator's window keeps the focus");
  assert.deepEqual(focusCalls(fake.callsFor(page.targetId)), [], "no focus emulation");
  const tab = await opened(mac(), true);
  assert.deepEqual(tab.create, { url: "about:blank", background: true, newWindow: false });
  assert.equal(tab.page.background, true);
  tab.page.visibilityChanges.length = 0;
  const calls = await callsOf(tab.page, () => commands.click(mac(), { tab: tab.name, target: "#b" }));
  assert.deepEqual(focusCalls(calls), [true], "open --tab: focus emulation, as before");
  assert.deepEqual(tab.page.visibilityChanges, ["visible", "hidden"]);
  assert.ok(JSON.parse(readFileSync(join(c.stateDir, "tab-pages.json"), "utf8")).includes(tab.page.targetId), "the Mac records the tab page");
  await commands.close(mac(), { tab: tab.name });
  await commands.close(mac(), { tab: name });
});

/** The fake as the Mac measured it (FakeChrome.macWindows), with short input times. */
async function onTheMac(fn: () => Promise<void>, reshowMs = 0) {
  fake.macWindows = true; fake.tabSwitches = true; fake.reshowMs = reshowMs;
  try { await fn(); } finally { fake.macWindows = false; fake.tabSwitches = false; fake.reshowMs = 0; }
}
const ACTIVATIONS = ["Page.bringToFront", "Target.activateTarget"];
const activations = (from: number) => fake.calls.slice(from).filter((x) => ACTIVATIONS.includes(x.method));

test("the Mac: input never activates a window (no Page.bringToFront, no Target.activateTarget); a press gives the page the focus, and two pages can both have it (accepted: ab-or9)", async () => {
  await onTheMac(async () => {
    operatorInFront();
    const from = fake.calls.length, active = fake.windowActivations.length;
    const a = await opened(mac({ inputTiming: FAST })), b = await opened(mac({ inputTiming: FAST }));
    await commands.click(mac({ inputTiming: FAST }), { tab: a.name, target: "#b" });
    assert.equal(a.page.title, "clicked");
    assert.equal(a.page.hasFocus, true, "the press gave the page the focus");
    await commands.type(mac({ inputTiming: FAST }), { tab: b.name, text: "abc", into: "#i" });
    await commands.press(mac({ inputTiming: FAST }), { tab: b.name, key: "Enter" });
    assert.equal(b.page.select("#i")[0].value, "abc");
    assert.equal(b.page.hasFocus, true);
    assert.equal(a.page.hasFocus, true, "the first page kept its focus: no blur (the Mac's trait)");
    assert.deepEqual(a.page.focusEvents, ["focus"]);
    assert.deepEqual(operator.focusEvents, [], "the operator's page kept its focus");
    assert.equal(fake.focusedWindow, operator.windowId);
    assert.deepEqual(activations(from), [], "no activation");
    assert.equal(fake.windowActivations.length, active, "no window was activated");
    assert.deepEqual([...focusCalls(fake.callsFor(a.page.targetId)), ...focusCalls(fake.callsFor(b.page.targetId))], [], "no focus emulation");
    const press = fake.calls.slice(from).find((x) => x.targetId === a.page.targetId && x.method === "Input.dispatchMouseEvent" && x.params.type === "mousePressed")!;
    assert.equal(press.params.force, 0.5, "a person's press");
    await commands.close(mac(), { tab: a.name });
    await commands.close(mac(), { tab: b.name });
  });
});

test("the Mac: each input path starts at the page's last point (pointer.json), never at the real pointer; the first one inside the page", async () => {
  await onTheMac(async () => {
    operatorInFront();
    const o = mac({ inputTiming: FAST });
    const { name, page } = await opened(o);
    const mouse = (from: number) => fake.calls.slice(from).filter((x) => x.targetId === page.targetId && x.method === "Input.dispatchMouseEvent");
    let from = fake.calls.length;
    await commands.click(o, { tab: name, target: "#b" });
    const first = mouse(from);
    assert.ok(first.length >= 10, `a path: ${first.length} events`);
    const end = first.at(-1)!.params;
    from = fake.calls.length;
    await commands.click(o, { tab: name, target: "#i" });
    const second = mouse(from);
    assert.ok(Math.hypot(second[0].params.x - end.x, second[0].params.y - end.y) < 60, `continues from ${end.x},${end.y}: ${second[0].params.x},${second[0].params.y}`);
    assert.ok(JSON.parse(readFileSync(join(c.stateDir, "pointer.json"), "utf8")).pages[page.targetId], "the last point is in the state folder");
    // A real pointer event that reaches the page (the operator's pointer over a visible part of the window) is not used.
    page.dispatch("mousemove", { isTrusted: true, clientX: 900, clientY: 700, movementX: 0, movementY: 0 });
    const last = second.at(-1)!.params;
    from = fake.calls.length;
    await commands.click(o, { tab: name, target: "#b" });
    const third = mouse(from);
    assert.ok(Math.hypot(third[0].params.x - last.x, third[0].params.y - last.y) < 60, `continues from ${last.x},${last.y}, not from the real pointer: ${third[0].params.x},${third[0].params.y}`);
    await commands.close(o, { tab: name });
  });
});

test("the Mac: drive the popup tab; back to the opener only by the popup's close; the opener's next input waits until it shows again (about 1.0 s on the Mac), with no activation", async () => {
  await onTheMac(async () => {
    operatorInFront();
    const o = mac({ inputTiming: FAST });
    const { name, page } = await opened(o);
    const from = fake.calls.length;
    await commands.click(o, { tab: name, target: "#b" });
    const popup = fake.openFrom(page, `${fx.base}/`);
    assert.equal(page.visibilityState, "hidden", "the popup tab hides its opener");
    assert.equal(page.hasFocus, true, "the opener keeps its focus (the Mac)");
    assert.equal(popup.hasFocus, false, "the popup has none");
    page.title = "input";
    await commands.click(o, { tab: popup.targetId.slice(0, 8), target: "#b" });
    assert.equal(popup.title, "clicked", "the popup rule: drive the new tab");
    await commands.close(o, { tab: popup.targetId.slice(0, 8) });
    const closedAt = Date.now();
    assert.equal(page.visibilityState, "hidden", "still hidden right after the close");
    await commands.click(o, { tab: name, target: "#b" });
    const press = fake.calls.find((x) => x.t >= closedAt && x.targetId === page.targetId && x.method === "Input.dispatchMouseEvent")!;
    assert.ok(press.t - closedAt >= 380, `the input waited until the opener showed: ${press.t - closedAt} ms`);
    assert.equal(page.title, "clicked");
    assert.equal(page.visibilityState, "visible");
    assert.deepEqual(activations(from), [], "no activation");
    assert.deepEqual(focusCalls(fake.callsFor(page.targetId)), [], "no focus emulation");
    await commands.close(o, { tab: name });
  }, 400);
});

test("the Mac: input to a window page that its popup tab still hides fails with a clear error and sends it no input; a read works there with no activation", async () => {
  await onTheMac(async () => {
    operatorInFront();
    const o = mac({ inputTiming: { ...FAST, showMs: 300 } });
    const { name, page } = await opened(o);
    const popup = fake.openFrom(page, `${fx.base}/next`);
    const from = fake.calls.length, t0 = Date.now();
    await assert.rejects(commands.click(o, { tab: name, target: "#b" }), (e: Error) => /hidden behind another tab of its window/.test(e.message) && /close/.test(e.message));
    assert.ok(Date.now() - t0 >= 280, "it waited for the page to show first");
    assert.deepEqual(fake.calls.slice(from).filter((x) => x.targetId === page.targetId && /^Input\./.test(x.method)).map((x) => x.method), [], "no input");
    const r = await commands.text(o, { tab: name });
    assert.match(r.text, /./);
    assert.deepEqual(activations(from), [], "no activation, also for the read");
    assert.equal(page.visibilityState, "hidden");
    await commands.close(o, { tab: popup.targetId.slice(0, 8) });
    await commands.close(o, { tab: name });
  }, 100);
});

test("the Mac: record in a window page sends no activation and no focus emulation", needsFfmpeg, async () => {
  await onTheMac(async () => {
    const o = mac({ inputTiming: FAST });
    const { name, page } = await opened(o);
    const script = join(c.dir, `${name}-steps.json`);
    writeFileSync(script, JSON.stringify([{ wait: 300 }]));
    const from = fake.calls.length;
    const calls = await callsOf(page, async () => {
      const r = await commands.record(o, { tab: name, out: join(c.dir, `${name}.mp4`), script, size: "320x180", fps: 10, settle: 100, ffmpeg: FFMPEG });
      assert.ok(r.frames >= 2, `${r.frames} frames`);
    });
    assert.deepEqual(focusCalls(calls), []);
    assert.deepEqual(activations(from), []);
    assert.deepEqual(page.visibilityChanges, [], "visible all the time");
    await commands.close(o, { tab: name });
  });
});

test("personal mode on Linux: open gets a window of its own that it pins, with focus emulation, as before", async () => {
  const p = consumer();
  try {
    const o = p.options({ endpoint: fake.ws, mode: "personal", platform: "linux" });
    const from = fake.calls.length;
    const r = await commands.open(o, { url: `${fx.base}/`, name: "pw" });
    assert.deepEqual(createCalls(from), [{ url: "about:blank", background: true, newWindow: true }]);
    const page = fake.pages.get(r.tab.targetId)!;
    assert.equal(r.window, page.windowId, "pinned");
    assert.deepEqual(focusCalls(fake.callsFor(page.targetId)), [true]);
    await commands.close(o, { tab: "pw" });
    stopProxy(resolveOptions(o));
  } finally { p.remove(); }
});

// ---------- review-45: a window page that is not in front of its own window ----------

/** A click handler whose content only an animation frame writes: a page that Chrome does not draw never shows it. */
const framed = (p: FakePage) => p.atFrame(() => { p.title = "framed"; });

async function checkBroughtForward(name: string, page: FakePage) {
  assert.equal(page.visibilityState, "hidden", "behind another tab of its window");
  page.select("#b")[0].onclick = framed;
  let calls = await callsOf(page, () => commands.click(linux(), { tab: name, target: "#b" }));
  const m = calls.map((x) => x.method);
  assert.ok(m.includes("Page.bringToFront") && m.indexOf("Page.bringToFront") < m.indexOf("Input.dispatchMouseEvent"), "a tab switch before the input");
  assert.equal(page.visibilityState, "visible");
  assert.deepEqual(focusCalls(calls), [], "no focus emulation");
  // A library wait for content that a frame writes: the page draws, so it comes.
  const b = await AgentBrowser.connect(linux());
  try { await (await b.find(name)).waitFor(() => document.title === "framed", { timeoutMs: 2000, what: "the frame's content" }); } finally { await b.disconnect(); }
  return calls;
}

test("Linux: the opener behind a site's popup tab is hidden; input, a wait and record bring its tab in front first (a person's tab switch), no tab moves", async () => {
  fake.tabSwitches = true;
  try {
    operatorInFront();
    const { name, page } = await opened(linux());
    const popup = fake.openFrom(page, `${fx.base}/next`);
    assert.equal(popup.windowId, page.windowId);
    await checkBroughtForward(name, page);
    // The popup comes in front again; a wait alone brings the opener back too.
    fake.activateTab(popup, "test");
    assert.equal(page.visibilityState, "hidden");
    const b = await AgentBrowser.connect(linux());
    try {
      const tab = await b.find(name);
      await tab.evaluate(() => { document.title = "not yet"; });
      page.atFrame(() => { page.title = "drawn"; });
      await tab.waitFor(() => document.title === "drawn", { timeoutMs: 2000, what: "a frame" });
    } finally { await b.disconnect(); }
    assert.equal(popup.windowId, page.windowId, "no tab moved");
    await commands.close(linux(), { tab: popup.targetId.slice(0, 8) });
    await commands.close(linux(), { tab: name });
  } finally { fake.tabSwitches = false; }
});

test("Linux: record in the hidden opener brings its tab in front, so Chrome sends frames", needsFfmpeg, async () => {
  fake.tabSwitches = true;
  try {
    const { name, page } = await opened(linux());
    const popup = fake.openFrom(page, `${fx.base}/next`);
    assert.equal(page.visibilityState, "hidden");
    const script = join(c.dir, `${name}-steps.json`);
    writeFileSync(script, JSON.stringify([{ wait: 200 }]));
    const calls = await callsOf(page, async () => {
      const r = await commands.record(linux(), { tab: name, out: join(c.dir, `${name}.mp4`), script, size: "320x180", fps: 10, settle: 100, ffmpeg: FFMPEG });
      assert.ok(r.frames >= 2, `${r.frames} frames`);
    });
    const m = calls.map((x) => x.method);
    assert.ok(m.indexOf("Page.bringToFront") >= 0 && m.indexOf("Page.bringToFront") < m.indexOf("Page.startScreencast"));
    assert.deepEqual(focusCalls(calls), []);
    await commands.close(linux(), { tab: popup.targetId.slice(0, 8) });
    await commands.close(linux(), { tab: name });
  } finally { fake.tabSwitches = false; }
});

test("Linux: an older tab of a pinned window (open puts each new tab there) is brought in front for input and waits", async () => {
  fake.tabSwitches = true;
  try {
    const { name, page } = await opened(linux());
    await commands.window(linux(), { pin: name });
    const later = await commands.open(linux(), { url: `${fx.base}/`, name: `${name}-later` });
    const newer = fake.pages.get(later.tab.targetId)!;
    assert.equal(newer.windowId, page.windowId, "in the pinned window");
    await checkBroughtForward(name, page);
    assert.equal(newer.visibilityState, "hidden", "the tab switch put the newer tab behind, as a person's does");
    await commands.window(linux(), { unpin: true });
    await commands.close(linux(), { tab: `${name}-later` });
    await commands.close(linux(), { tab: name });
  } finally { fake.tabSwitches = false; }
});

test("Linux, a display that is not the agent browser's own: open makes a background tab, driven as before (focus emulation), with a log line", async () => {
  const lines: string[] = [];
  const o = linux({ display: { own: false }, log: (l: string) => { lines.push(l); } });
  const { name, page, create } = await opened(o);
  assert.deepEqual(create, { url: "about:blank", background: true, newWindow: false });
  const calls = await callsOf(page, () => commands.click(o, { tab: name, target: "#b" }));
  assert.deepEqual(focusCalls(calls), [true]);
  assert.ok(lines.some((l) => /not on a display of its own/.test(l)), lines.join("\n"));
  await commands.close(o, { tab: name });
});

test("Linux, a display that is not the agent browser's own: the log line comes at the first command that opens or attaches a page, not at tabs, status or window (review-45c)", async () => {
  const lines: string[] = [];
  const o = linux({ display: { own: false }, log: (l: string) => { lines.push(l); } });
  const gate = () => lines.filter((l) => /not on a display of its own/.test(l)).length;
  await commands.tabs(o);
  await commands.status(o);
  await commands.window(o);
  assert.equal(gate(), 0, lines.join("\n"));
  const { name } = await opened(o);
  assert.equal(gate(), 1, "open: one line, also for its attach");
  await commands.text(o, { tab: name });
  assert.equal(gate(), 2, "a command that attaches a page");
  await commands.close(o, { tab: name });
});

test("Linux, a display that is not the agent browser's own: open --tab records its tab page, so it keeps the old modes when the gate opens later; a plain open's background tab is a window page then (review-45b note 6)", async () => {
  operatorInFront();
  const o = linux({ display: { own: false } });
  const tabPages = () => (existsSync(join(c.stateDir, "tab-pages.json")) ? JSON.parse(readFileSync(join(c.stateDir, "tab-pages.json"), "utf8")) as string[] : []);
  const tab = await opened(o, true), plain = await opened(o);
  assert.deepEqual([tab.create, plain.create], [{ url: "about:blank", background: true, newWindow: false }, { url: "about:blank", background: true, newWindow: false }]);
  assert.ok(tabPages().includes(tab.page.targetId), "the explicit tab");
  assert.ok(!tabPages().includes(plain.page.targetId), "the fallback's own background tab");
  // The gate opens (a display of its own): the explicit tab keeps the old default, focus emulation on each attach.
  let calls = await callsOf(tab.page, () => commands.click(linux(), { tab: tab.name, target: "#b" }));
  assert.equal(tab.page.title, "clicked");
  assert.deepEqual(focusCalls(calls), [true]);
  // The plain open's tab is a window page now: no focus emulation, and its window comes forward for input.
  calls = await callsOf(plain.page, () => commands.click(linux(), { tab: plain.name, target: "#b" }));
  assert.equal(plain.page.title, "clicked");
  assert.deepEqual(focusCalls(calls), []);
  assert.ok(calls.some((x) => x.method === "Page.bringToFront"));
  await commands.close(linux(), { tab: tab.name });
  await commands.close(linux(), { tab: plain.name });
  assert.ok(!tabPages().includes(tab.page.targetId), "dropped at its close");
});

test("Linux, through bin/agent-browser.js: open without --tab gives the page a window of its own, and click drives it as a person's input, on a display that the real check finds the agent browser's own (review-45c)", { skip: process.platform === "linux" ? false : "the CLI's platform is this machine's" }, async () => {
  operatorInFront();
  const own = consumer();
  try {
    // The real display check, with stand-ins on PATH: ps names an agent Chrome on this profile (a pid above pid_max: no
    // real process has it), xdotool shows only its windows, xprop no window manager. Every other ps call is the real one.
    const bin = join(own.dir, "bin"), log = join(own.dir, "x.log"), pid = 4194999;
    const realPs = ["/usr/bin/ps", "/bin/ps"].find((p) => existsSync(p))!;
    const profile = resolveOptions(own.options()).profileDir;
    mkdirSync(bin);
    const script = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, name), 0o755); };
    script("ps", `if [ "$1" = "axww" ]; then echo "${pid} /usr/lib/chromium/chromium --user-data-dir=${profile} --window-name=agent"; exit 0; fi\nexec ${realPs} "$@"`);
    script("xdotool", [`echo "$*" >> ${log}`, "case \"$1\" in",
      "  search) if [ \"$2\" = \"--maxdepth\" ]; then echo 1; else printf '1\\n200\\n'; fi ;;",
      `  getwindowpid) echo ${pid} ;;`, "  getmouselocation) printf 'X=900\\nY=700\\nSCREEN=0\\nWINDOW=200\\n' ;;",
      "  mousemove) ;;", "  *) exit 1 ;;", "esac"].join("\n"));
    script("xprop", `echo "$*" >> ${log}\necho "_NET_SUPPORTING_WM_CHECK:  not found."`);
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}`, DISPLAY: ":4194" };
    delete env.WAYLAND_DISPLAY; delete env.XAUTHORITY;
    const run = (args: string[]) => cli([...args, ...flags(own, fake.ws), "--json", "--input-timing", JSON.stringify(FAST)], { env });
    const from = fake.calls.length;
    const r = await run(["open", `${fx.base}/`, "--name", "w"]);
    assert.equal(r.json?.ok, true, r.stdout + r.stderr);
    assert.deepEqual(fake.calls.slice(from).filter((x) => x.method === "Target.createTarget").map((x) => x.params), [{ url: "about:blank", background: true, newWindow: true }]);
    const page = fake.pages.get(r.json.tab.targetId)!;
    assert.notEqual(page.windowId, operator.windowId, "a window of its own");
    assert.doesNotMatch(r.stderr, /not on a display of its own/);
    assert.equal(JSON.parse(readFileSync(join(own.stateDir, "display.json"), "utf8")).own, true);
    const c2 = await run(["click", "w", "#b"]);
    assert.equal(c2.json?.ok, true, c2.stdout + c2.stderr);
    assert.equal(page.title, "clicked");
    const calls = fake.calls.slice(from).filter((x) => x.targetId === page.targetId), m = calls.map((x) => x.method);
    assert.deepEqual(focusCalls(calls), [], "no focus emulation");
    assert.ok(m.indexOf("Page.bringToFront") >= 0 && m.indexOf("Page.bringToFront") < m.indexOf("Input.dispatchMouseEvent"), "the window comes forward first");
    const press = calls.find((x) => x.method === "Input.dispatchMouseEvent" && x.params.type === "mousePressed")!;
    assert.equal(press.params.force, 0.5, "a person's press");
    const x = readFileSync(log, "utf8");
    assert.match(x, /^search --onlyvisible --name $/m, "the real windows check");
    assert.match(x, /^-root _NET_SUPPORTING_WM_CHECK$/m, "the real window manager check");
    assert.match(x, /^mousemove \d+ \d+$/m, "the X pointer's move: the last step of the path");
    await run(["close", "w"]);
  } finally { stopProxy(resolveOptions(own.options())); own.remove(); }
});

test("Linux: reads of a hidden opener (text, outline, eval) bring its tab in front first, so an eval that waits for a frame ends (review-45b)", async () => {
  fake.tabSwitches = true;
  try {
    const { name, page } = await opened(linux());
    const popup = fake.openFrom(page, `${fx.base}/next`);
    for (const read of [
      () => commands.text(linux(), { tab: name }),
      () => commands.outline(linux(), { tab: name }),
      () => commands.eval(linux(), { tab: name, expression: "new Promise((r) => requestAnimationFrame(() => r('drawn')))" }),
    ]) {
      fake.activateTab(popup, "test");
      assert.equal(page.visibilityState, "hidden");
      const calls = await callsOf(page, async () => { await read(); });
      assert.ok(calls.some((x) => x.method === "Page.bringToFront"), "a tab switch first");
      assert.equal(page.visibilityState, "visible");
    }
    const r = await commands.eval(linux(), { tab: name, expression: "new Promise((r) => requestAnimationFrame(() => r('drawn')))" });
    assert.equal(r.value, "drawn");
    // A read of a visible window page brings nothing forward.
    const calls = await callsOf(page, () => commands.text(linux(), { tab: name }));
    assert.ok(!calls.some((x) => x.method === "Page.bringToFront"));
    await commands.close(linux(), { tab: popup.targetId.slice(0, 8) });
    await commands.close(linux(), { tab: name });
  } finally { fake.tabSwitches = false; }
});
