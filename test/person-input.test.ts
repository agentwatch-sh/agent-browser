// A person's input in a window of its own (ab-v16.26; docs/research/2026-11-05-anti-detect-drive.md, "The answer",
// steps 4 to 6): on Linux each input command (click, click --text, Tab.clickAt, hover, type, press, setFiles) brings
// its page's window forward when the page has no focus (Page.bringToFront), holds the input lock of the state folder
// across processes, and sends a person's input: a pointer path from the real pointer, a press of 70 to 90 ms with force
// 0.5, a person's keys per character (the keyboard model, ab-t30.4), a click on a field in place of el.focus() that leaves the caret where
// `type --into` put it, wheel events in place of scrollIntoView, and a click that opens the file chooser before
// setFiles. Against the fake Chrome (fake-chrome.ts: windows, the X pointer's event at an activation, a scrolling page,
// the caret, the file chooser). An explicit `open --tab`, the Mac and personal mode keep today's input.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentBrowser, Tab } from "../src/browser.ts";
import { optionsFromFlags } from "../src/cli.ts";
import { commands } from "../src/commands.ts";
import { INPUT_TIMING, resolveOptions, type BrowserOptions, type InputTiming } from "../src/options.ts";
import { stopProxy } from "../src/proxy.ts";
import { findFfmpeg } from "../src/record.ts";
import { NotAllowedError } from "../src/errors.ts";
import { FakeChrome, type Call, type FakePage } from "./fake-chrome.ts";
import { consumer, fixtureServer, ROOT, type Consumer, type Fixture } from "./helpers.ts";

const FFMPEG = (() => { try { return findFfmpeg(); } catch { return undefined; } })();
const needsFfmpeg = { skip: FFMPEG ? false : "no ffmpeg (with libx264) on PATH" };

/** Short input times, so that the suite stays fast; one test uses the defaults. */
const FAST: Partial<InputTiming> = { pressMs: [6, 9], keyMs: [6, 9], holdMs: [1, 2], settleMs: [1, 3], wheelMs: [1, 3], moveScale: 0.05, activateMs: 300 };

let fx: Fixture, fake: FakeChrome, c: Consumer, operator: FakePage;
/** The X pointer through a fake xdotool: its moves, in screen pixels (the fake's windows are at 0,0 with 87 px of frame). */
const xMoves: { x: number; y: number; t?: number }[] = [];
let xdotoolOn = false;
const xdotool = async (args: string[]): Promise<string> => {
  const at = fake.xPointer ?? { x: 900, y: 700 };
  if (args[0] === "getmouselocation") return `X=${Math.round(at.x)}\nY=${Math.round(at.y + 87)}\nSCREEN=0\nWINDOW=200\n`;
  if (args[0] === "mousemove") { const x = Number(args[1]), y = Number(args[2]); xMoves.push({ x, y, t: Date.now() }); fake.xPointer = { x, y: y - 87 }; return ""; }
  if (args[0] === "search" && args.includes("--maxdepth")) return "1\n";
  if (args[0] === "search") return "1\n200\n201\n";
  if (args[0] === "getwindowfocus") return "200\n";
  if (args[0] === "getwindowpid") return args[1] === "1" ? "" : "4242\n";
  throw new Error(`fake xdotool: ${args.join(" ")}`);
};
/** Agent mode on Linux, on a display of the agent browser's own (the fake's windows have the pid 4242). */
const linux = (extra: Partial<BrowserOptions> = {}) => c.options({ endpoint: fake.ws, platform: "linux", inputTiming: FAST,
  display: { own: true, xdotool: xdotoolOn ? xdotool : false, chromePid: 4242 }, ...extra });

/** A page with a field that holds text from the page, one that a script fills, an editor, buttons, a far button, file inputs. */
const PAGE = {
  title: "input",
  elements: [
    { tag: "button", id: "b", text: "Go", rect: [40, 100, 120, 30], onclick: (p: FakePage) => { p.title = "clicked"; } },
    { tag: "input", id: "i", rect: [40, 160, 200, 24] },
    { tag: "input", id: "pre", value: "abc", rect: [40, 200, 200, 24] },
    { tag: "input", id: "set", rect: [40, 240, 200, 24] },
    { tag: "div", id: "ed", attrs: { contenteditable: "true" }, text: "xyz", rect: [40, 280, 200, 24] },
    { tag: "button", id: "far", text: "Far", rect: [40, 2600, 120, 30], onclick: (p: FakePage) => { p.title = "far"; } },
    { tag: "input", id: "file", attrs: { type: "file" }, rect: [40, 320, 200, 24] },
    { tag: "input", id: "hiddenfile", attrs: { type: "file" }, hidden: true },
    { tag: "label", id: "lab", attrs: { for: "hiddenfile" }, text: "Upload", rect: [40, 360, 120, 24] },
    { tag: "input", id: "orphan", attrs: { type: "file" }, hidden: true },
    { tag: "div", id: "hov", text: "menu", rect: [300, 100, 100, 30] },
    { tag: "input", id: "farfile", attrs: { type: "file" }, rect: [40, 2700, 200, 24] },
    { tag: "a", id: "blank", text: "Elsewhere", attrs: { href: "http://evil.test/", target: "_blank", rel: "noopener" }, rect: [420, 160, 100, 24] },
  ],
  onload: (p: FakePage) => { p.select("#set")[0].value = "abc"; },
};

before(async () => {
  fx = await fixtureServer();
  // http://evil.test/ is off the allowlist: a page that goes there must get no input.
  fake = await FakeChrome.start((url) => (url.origin === fx.base || url.hostname === "evil.test" ? PAGE as never : undefined));
  fake.backgroundTabs = true;
  fake.scrolls = true;
  fake.tabSwitches = true;
  c = consumer();
  operator = fake.addPage(`${fx.base}/`);
});

after(async () => {
  stopProxy(resolveOptions(c.options()));
  await fake?.close();
  await fx?.close();
  c?.remove();
});

let n = 0;
async function windowPage(o = linux()): Promise<{ name: string; page: FakePage }> {
  const name = `p${++n}`;
  const r = await commands.open(o, { url: `${fx.base}/`, name });
  return { name, page: fake.pages.get(r.tab.targetId)! };
}
/** The calls that `fn` sent to the page and to the browser for it. */
async function callsOf(page: FakePage, fn: () => Promise<unknown>): Promise<Call[]> {
  const from = fake.calls.length;
  await fn();
  return fake.calls.slice(from).filter((x) => x.targetId === page.targetId);
}
const mouse = (calls: Call[]) => calls.filter((x) => x.method === "Input.dispatchMouseEvent");
const keys = (calls: Call[]) => calls.filter((x) => x.method === "Input.dispatchKeyEvent");
/** An input event as the player sent it: `at`, the epoch time (ms) that the player read for its timestamp at the send. */
type Sent = { method: string; params: any; at: number };
/**
 * The input events that `fn` sent to the page, on the player's side (board ab-t30.14): the fake's receive time (Call.t)
 * adds the delivery to the latency, up to 10 ms on a loaded box, so a latency check reads the player's own clock. The
 * player's Linux stamp is Date.now(), and its last read before Tab.send is the event's timestamp read (the guard runs
 * before it). `late`: each send holds the event loop that long after it, so the fake gets each event that much later.
 */
async function sentOf(page: FakePage, fn: () => Promise<unknown>, late = 0): Promise<Sent[]> {
  const now = Date.now, send = Tab.prototype.send, sent: Sent[] = [];
  let read = NaN;
  Date.now = () => (read = now.call(Date));
  Tab.prototype.send = function (this: Tab, method: string, params?: object, timeoutMs?: number) {
    if (this.targetId === page.targetId && method.startsWith("Input.dispatch")) sent.push({ method, params, at: read });
    const p = send.call(this, method, params, timeoutMs);
    for (const end = now.call(Date) + late; now.call(Date) < end;); // a box too busy to deliver at once
    return p;
  } as typeof Tab.prototype.send;
  try { await fn(); } finally { Date.now = now; Tab.prototype.send = send; }
  return sent;
}
/** The rule of each input event's timestamp: whole ms, a latency of 3 to 5 ms before the send (0.5 ms of rounding). */
function personStamp(x: Sent): void {
  const ts = x.params.timestamp * 1000;
  assert.ok(Math.abs(ts - Math.round(ts)) < 1e-6, `whole ms: ${ts}`);
  assert.ok(x.at - ts >= 2.5 && x.at - ts <= 5.5, `a latency of 3 to 5 ms before the send: ${x.at - ts} ms`);
}
const methods = (calls: Call[]) => calls.map((x) => x.method);
function operatorInFront() { fake.focusWindow(operator.windowId, "test"); fake.xPointer = undefined; }

test("the input timing: the defaults of the input design (the pointer's bounds of design 10.1 and 8.2, the keys' of 10.2), a partial option, and the CLI's --input-timing", () => {
  // keyMs: a range that does not bind the keyboard model (board ab-t30.4); holdMs: a key's hold of 50 to 250 ms (design 10.2).
  assert.deepEqual(INPUT_TIMING, { pressMs: [60, 180], keyMs: [20, 3000], holdMs: [50, 250], settleMs: [80, 400], wheelMs: [35, 90], moveScale: 1, activateMs: 1000, showMs: 2500, lockWaitMs: 600_000 });
  assert.deepEqual(resolveOptions(c.options()).inputTiming, INPUT_TIMING);
  assert.deepEqual(resolveOptions(c.options({ inputTiming: { pressMs: [10, 20] } })).inputTiming, { ...INPUT_TIMING, pressMs: [10, 20] });
  for (const bad of [{ pressMs: [20, 10] }, { keyMs: [-1, 5] }, { moveScale: 0 }, { activateMs: Number.NaN }, { nope: 1 }, { holdMs: [1] }])
    assert.throws(() => resolveOptions(c.options({ inputTiming: bad as never })), /inputTiming/, JSON.stringify(bad));
  const s = optionsFromFlags({ "state-dir": c.stateDir, "input-timing": '{"keyMs":[1,2]}' }, () => {});
  assert.deepEqual(s.inputTiming.keyMs, [1, 2]);
  assert.throws(() => optionsFromFlags({ "state-dir": c.stateDir, "input-timing": "[1" }, () => {}), /--input-timing must be a JSON object/);
});

test("click on a window page: the window comes forward first (Page.bringToFront), then a path, a press with force 0.5 and a release; no scrollIntoView", async () => {
  operatorInFront();
  const { name, page } = await windowPage();
  const calls = await callsOf(page, () => commands.click(linux(), { tab: name, target: "#b" }));
  assert.equal(page.title, "clicked");
  const m = methods(calls), front = m.indexOf("Page.bringToFront");
  assert.ok(front >= 0 && front < m.indexOf("Input.dispatchMouseEvent"), "the activation comes before the first input event");
  assert.equal(fake.windowActivations.at(-1)?.by, "bringToFront");
  const ev = mouse(calls), press = ev.findIndex((x) => x.params.type === "mousePressed");
  assert.ok(press >= 10, `${press} moves before the press`);
  assert.ok(ev.slice(0, press).every((x) => x.params.type === "mouseMoved" && (x.params.buttons ?? 0) === 0));
  assert.deepEqual(ev.slice(press).map((x) => x.params.type), ["mousePressed", "mouseReleased"]);
  const p = ev[press].params, r = ev[press + 1].params;
  assert.deepEqual([p.button, p.buttons, p.clickCount, p.force], ["left", 1, 1, 0.5]);
  assert.deepEqual([r.button, r.buttons, r.clickCount], ["left", 0, 1]);
  assert.ok(p.x > 40 && p.x < 160 && p.y > 100 && p.y < 130, `inside the button: ${p.x},${p.y}`);
  assert.equal(page.scriptScrolls, 0);
  assert.equal(page.hasFocus, true);
  await commands.close(linux(), { tab: name });
});

test("the default timing: a press of 60 to 180 ms, a path of a person's length, and the click takes about half a second or more", async () => {
  operatorInFront();
  const { name, page } = await windowPage();
  const t0 = Date.now();
  const calls = await callsOf(page, () => commands.click(linux({ inputTiming: undefined }), { tab: name, target: "#b" }));
  const ms = Date.now() - t0, ev = mouse(calls), press = ev.find((x) => x.params.type === "mousePressed")!, release = ev.find((x) => x.params.type === "mouseReleased")!;
  assert.ok(release.t - press.t >= 55 && release.t - press.t <= 200, `press ${release.t - press.t} ms`);
  const moves = ev.filter((x) => x.params.type === "mouseMoved");
  assert.ok(moves.length >= 15, `${moves.length} moves`);
  assert.ok(press.t - moves[0].t >= 300, `the path and the settle took ${press.t - moves[0].t} ms`);
  assert.ok(ms >= 450, `${ms} ms`);
  await commands.close(linux(), { tab: name });
});

test("the path starts where the pointer was: at the activation's real pointer event, then at the last point, also in a later command", async () => {
  operatorInFront();
  const { name, page } = await windowPage();
  fake.xPointer = { x: 700, y: 500 };
  let ev = mouse(await callsOf(page, () => commands.click(linux(), { tab: name, target: "#b" })));
  const first = ev[0].params;
  assert.ok(Math.hypot(first.x - 700, first.y - 500) < 60, `the first move starts near the X pointer: ${first.x},${first.y}`);
  const end = ev.at(-1)!.params;
  // The window is active now: no activation, and the next path starts at the last point.
  const calls = await callsOf(page, () => commands.click(linux(), { tab: name, target: "#i" }));
  assert.ok(!methods(calls).includes("Page.bringToFront"), "a page with the focus is not activated again");
  ev = mouse(calls);
  assert.ok(Math.hypot(ev[0].params.x - end.x, ev[0].params.y - end.y) < 60, `continues from ${end.x},${end.y}: ${ev[0].params.x},${ev[0].params.y}`);
  const stored = JSON.parse(readFileSync(join(c.stateDir, "pointer.json"), "utf8"));
  assert.ok(stored.pages[page.targetId], "the last point is in the state folder");
  await commands.close(linux(), { tab: name });
});

test("with the X pointer (xdotool on the agent browser's own display): the pointer moves to each path's end, so the next activation enters there", async () => {
  operatorInFront();
  xdotoolOn = true;
  try {
    const { name, page } = await windowPage();
    fake.xPointer = { x: 700, y: 500 };
    xMoves.length = 0;
    const ev = mouse(await callsOf(page, () => commands.click(linux(), { tab: name, target: "#b" })));
    const end = ev.at(-1)!.params, moves = ev.filter((x) => x.params.type === "mouseMoved");
    assert.deepEqual(xMoves.map(({ x, y }) => ({ x, y })), [{ x: end.x, y: end.y + 87 }], "one move of the X pointer: the path's last step, on the screen");
    assert.ok(!moves.some((x) => x.params.x === end.x && x.params.y === end.y), "no CDP move to the last point: the X pointer's move is that step");
    // Another window takes the focus, then this one comes forward again: its page enters at its own last point.
    operatorInFront();
    fake.xPointer = { x: end.x, y: end.y };
    const again = mouse(await callsOf(page, () => commands.click(linux(), { tab: name, target: "#i" })));
    assert.ok(Math.hypot(again[0].params.x - end.x, again[0].params.y - end.y) < 60);
    await commands.close(linux(), { tab: name });
  } finally { xdotoolOn = false; }
});

test("a display that holds another program's window: the X pointer never moves", async () => {
  operatorInFront();
  xdotoolOn = true;
  const other = async (args: string[]) => (args[0] === "getwindowpid" && args[1] === "201" ? "999\n" : xdotool(args));
  try {
    const { name, page } = await windowPage();
    fake.xPointer = { x: 700, y: 500 };
    xMoves.length = 0;
    const lines: string[] = [];
    await callsOf(page, () => commands.click(linux({ display: { own: true, xdotool: other, chromePid: 4242 }, log: (l) => { lines.push(l); } }), { tab: name, target: "#b" }));
    assert.equal(page.title, "clicked");
    assert.deepEqual(xMoves, []);
    assert.ok(lines.some((l) => /another program's window is on the display: agent-browser does not move the X pointer/.test(l)), lines.join("\n"));
    await commands.close(linux(), { tab: name });
  } finally { xdotoolOn = false; }
});

test("type --into a field that holds the page's text: a click at its left end, so the text goes where el.focus() put the caret (at the start); keys per character", async () => {
  operatorInFront();
  const { name, page } = await windowPage();
  const calls = await callsOf(page, () => commands.type(linux(), { tab: name, text: "hi", into: "#pre" }));
  assert.equal(page.select("#pre")[0].value, "hiabc");
  assert.equal(page.scriptFocus, 0, "no el.focus()");
  assert.ok(mouse(calls).some((x) => x.params.type === "mousePressed"), "a click on the field");
  assert.ok(!methods(calls).includes("Input.insertText"), "no inserted text");
  const k = keys(calls).filter((x) => x.params.type === "keyDown").map((x) => x.params.key);
  assert.deepEqual(k, ["h", "i"], "the click put the caret at the start: no key moved it");
  const press = mouse(calls).find((x) => x.params.type === "mousePressed")!.params;
  assert.ok(press.x >= 41 && press.x <= 46, `at the left end of the field: ${press.x}`);
  // A click that lands elsewhere in the text (a long text, a padding) is put right with a key.
  page.select("#pre")[0].value = "0123456789012345678901234567890123456789";
  page.select("#pre")[0].setSelectionRange(0, 0);
  page.select("#pre")[0].rect = [40, 200, 20, 24];
  await commands.click(linux(), { tab: name, target: "#b" });
  const again = await callsOf(page, () => commands.type(linux(), { tab: name, text: "z", into: "#pre" }));
  assert.equal(page.select("#pre")[0].value, "z0123456789012345678901234567890123456789");
  assert.deepEqual(keys(again).filter((x) => x.params.type !== "keyUp").map((x) => x.params.key), ["z"]);
  await commands.close(linux(), { tab: name });
});

test("type --into a field that a script filled: the caret goes to the end, as el.focus() put it; into the focused field again: no new click", async () => {
  operatorInFront();
  const { name, page } = await windowPage();
  await commands.type(linux(), { tab: name, text: "de", into: "#set" });
  assert.equal(page.select("#set")[0].value, "abcde");
  const calls = await callsOf(page, () => commands.type(linux(), { tab: name, text: "f", into: "#set" }));
  assert.equal(page.select("#set")[0].value, "abcdef");
  assert.ok(!mouse(calls).some((x) => x.params.type === "mousePressed"), "the field has the focus: no click");
  await commands.type(linux(), { tab: name, text: "xy", into: "#i" });
  assert.equal(page.select("#i")[0].value, "xy");
  assert.equal(page.scriptFocus, 0);
  await commands.close(linux(), { tab: name });
});

test("type --into an editable element: a click at the start of its text, where el.focus() put the caret, and keys", async () => {
  operatorInFront();
  const { name, page } = await windowPage();
  const calls = await callsOf(page, () => commands.type(linux(), { tab: name, text: "ab", into: "#ed" }));
  assert.equal(page.select("#ed")[0].text, "abxyz");
  assert.deepEqual(keys(calls).filter((x) => x.params.type !== "keyUp").map((x) => x.params.key), ["a", "b"]);
  assert.equal(page.scriptFocus, 0);
  await commands.close(linux(), { tab: name });
});

test("type --into a field in the middle of a caret, and a field that a click does not focus: keys put the caret right; el.focus() with a log line", async () => {
  operatorInFront();
  const { name, page } = await windowPage();
  const f = page.select("#set")[0];
  f.setSelectionRange(1, 1); // an earlier focus left the caret after "a"
  const calls = await callsOf(page, () => commands.type(linux(), { tab: name, text: "Q", into: "#set" }));
  assert.equal(f.value, "aQbc");
  // The capital Q gets a real Shift key before it (the keyboard model, design 10.2; board ab-t30.4).
  assert.deepEqual(keys(calls).filter((x) => x.params.type !== "keyUp").map((x) => x.params.key), ["Home", "ArrowRight", "Shift", "Q"]);
  const lines: string[] = [];
  const cover = page.select("#hov")[0];
  cover.rect = [40, 160, 200, 24]; // another element over #i: the click hits it
  await commands.type(linux({ log: (l) => { lines.push(l); } }), { tab: name, text: "w", into: "#i" });
  assert.equal(page.select("#i")[0].value, "w");
  assert.equal(page.scriptFocus, 1);
  assert.ok(lines.some((l) => /the click on #i did not focus it; it gets the focus from a script/.test(l)), lines.join("\n"));
  cover.rect = [300, 100, 100, 30];
  await commands.close(linux(), { tab: name });
});

test("the keys of type with the default timing: the keyboard model's holds (50 to 250 ms) and times from one press to the next, each key event with a person's timestamp", async () => {
  operatorInFront();
  const { name, page } = await windowPage();
  await commands.click(linux(), { tab: name, target: "#i" });
  let calls: Call[] = [];
  const sent = await sentOf(page, async () => { calls = await callsOf(page, () => commands.type(linux({ inputTiming: undefined }), { tab: name, text: "abcd" })); });
  const ev = keys(calls), downs = ev.filter((x) => x.params.type === "keyDown");
  assert.deepEqual(downs.map((x) => x.params.key), ["a", "b", "c", "d"]);
  for (const d of downs) {
    const up = ev.find((x) => x.params.type === "keyUp" && x.params.key === d.params.key)!;
    assert.ok(up.t - d.t >= 45 && up.t - d.t <= 270, `the hold of ${d.params.key}: ${up.t - d.t} ms`);
  }
  // The model's holds (mean 116 ms, SD 24 ms): the mean of four is above 80 ms (today's 20 to 50 ms gave about 35).
  const holds = downs.map((d) => ev.find((x) => x.params.type === "keyUp" && x.params.key === d.params.key)!.t - d.t);
  assert.ok(holds.reduce((a, b) => a + b, 0) / holds.length > 80, `the mean hold: ${holds.join(", ")} ms`);
  for (let i = 1; i < downs.length; i++) assert.ok(downs[i].t - downs[i - 1].t >= 15, `gap ${downs[i].t - downs[i - 1].t} ms`);
  // The latency on the player's side (sentOf): the fake's receive time adds the delivery.
  const sentKeys = sent.filter((x) => x.method === "Input.dispatchKeyEvent");
  assert.equal(sentKeys.length, ev.length);
  for (const x of sentKeys) personStamp(x);
  assert.equal(page.select("#i")[0].value, "abcd");
  await commands.close(linux(), { tab: name });
});

test("type with the keyboard model: a capital gets a real Shift key (45 to 95 ms before it, location 1 or 2, up 15 to 60 ms after its release); a run of capitals keeps it; a key with no Shift waits", async () => {
  operatorInFront();
  const { name, page } = await windowPage();
  const calls = await callsOf(page, () => commands.type(linux(), { tab: name, text: "Hi OK", into: "#i" }));
  assert.equal(page.select("#i")[0].value, "Hi OK");
  const ev = keys(calls).filter((x) => x.t >= (keys(calls).find((y) => y.params.key === "H")?.t ?? 0) - 200);
  assert.deepEqual(ev.map((x) => `${x.params.type} ${x.params.key}`).filter((x) => /Shift|keyDown/.test(x)),
    ["rawKeyDown Shift", "keyDown H", "keyUp Shift", "keyDown i", "keyDown  ", "rawKeyDown Shift", "keyDown O", "keyDown K", "keyUp Shift"]);
  const at = (type: string, key: string, n = 0) => ev.filter((x) => x.params.type === type && x.params.key === key)[n];
  for (const [n, first, last] of [[0, "H", "H"], [1, "O", "K"]] as const) {
    const down = at("rawKeyDown", "Shift", n), up = at("keyUp", "Shift", n);
    assert.ok(down.params.location === 1 || down.params.location === 2, `location ${down.params.location}`);
    assert.equal(down.params.code, down.params.location === 1 ? "ShiftLeft" : "ShiftRight");
    assert.deepEqual([down.params.modifiers, at("keyDown", first).params.modifiers, at("keyUp", last).params.modifiers, up.params.modifiers], [8, 8, 8, 0]);
    assert.ok(at("keyDown", first).t - down.t >= 40 && at("keyDown", first).t - down.t <= 110, `Shift ${at("keyDown", first).t - down.t} ms before ${first}`);
    const lastUp = Math.max(...[first, last].map((k) => at("keyUp", k).t));
    assert.ok(up.t - lastUp >= 10 && up.t - lastUp <= 75, `the Shift release ${up.t - lastUp} ms after the last key's`);
  }
  assert.ok(at("keyDown", "i").t > at("keyUp", "Shift").t, "i waits for the Shift release");
  await commands.close(linux(), { tab: name });
});

test("type with the keyboard model: rollover: a key's press comes before the release of the key before (its early answer); an inserted text and the field's read come after every release", async () => {
  operatorInFront();
  const { name, page } = await windowPage();
  await commands.click(linux(), { tab: name, target: "#i" });
  // Holds of 20 to 30 ms and times of 6 to 9 ms from one press to the next: each release is answered early and comes after the next press.
  const calls = await callsOf(page, () => commands.type(linux({ inputTiming: { ...FAST, keyMs: [6, 9], holdMs: [20, 30] } }), { tab: name, text: "abc\u00e9def" }));
  assert.equal(page.select("#i")[0].value, "abc\u00e9def");
  const ev = keys(calls), down = (k: string) => ev.find((x) => x.params.type === "keyDown" && x.params.key === k)!, up = (k: string) => ev.find((x) => x.params.type === "keyUp" && x.params.key === k)!;
  for (const [a, b] of [["a", "b"], ["b", "c"], ["d", "e"], ["e", "f"]]) assert.ok(calls.indexOf(down(b)) < calls.indexOf(up(a)), `${b} goes down before ${a} goes up`);
  for (const k of "abcdef") assert.ok(up(k).t - down(k).t >= 18, `the hold of ${k}: ${up(k).t - down(k).t} ms`);
  const ins = calls.findIndex((x) => x.method === "Input.insertText");
  assert.ok(ins > calls.indexOf(up("c")) && ins < calls.indexOf(down("d")), "the inserted text after c's release, before d");
  const lastKey = Math.max(...ev.map((x) => calls.indexOf(x))), read = calls.findIndex((x, i) => i > calls.indexOf(down("f")) && !/^Input\./.test(x.method));
  assert.ok(read > lastKey, `the field's read (${calls[read]?.method}) after the last key event`);
  await commands.close(linux(), { tab: name });
});

test("press: the window comes forward, then a key down and up", async () => {
  operatorInFront();
  const { name, page } = await windowPage();
  const calls = await callsOf(page, () => commands.press(linux(), { tab: name, key: "Enter" }));
  assert.ok(methods(calls).indexOf("Page.bringToFront") < methods(calls).indexOf("Input.dispatchKeyEvent"));
  assert.deepEqual(keys(calls).map((x) => [x.params.type, x.params.key]), [["keyDown", "Enter"], ["keyUp", "Enter"]]);
  assert.equal(page.keyFocus, false, "the window is active: no key focus without a switch");
  await commands.close(linux(), { tab: name });
});

test("hover: a path to the element, no press; clickAt: a path to the point and a press there", async () => {
  operatorInFront();
  const { name, page } = await windowPage();
  let ev = mouse(await callsOf(page, () => commands.hover(linux(), { tab: name, target: "#hov" })));
  assert.ok(ev.length >= 10 && ev.every((x) => x.params.type === "mouseMoved"));
  assert.equal(page.hovered?.id, "hov");
  const b = await AgentBrowser.connect(linux());
  try {
    const tab = await b.find(name);
    ev = mouse(await callsOf(page, () => tab.clickAt(100, 112)));
  } finally { await b.disconnect(); }
  const press = ev.find((x) => x.params.type === "mousePressed")!;
  assert.deepEqual([press.params.x, press.params.y], [100, 112]);
  assert.equal(page.title, "clicked");
  await commands.close(linux(), { tab: name });
});

test("click below the fold: wheel events of 120 px (X11's notch) until the element is in view, then the click; no scrollIntoView", async () => {
  operatorInFront();
  const { name, page } = await windowPage();
  const calls = await callsOf(page, () => commands.click(linux(), { tab: name, target: "#far" }));
  assert.equal(page.title, "far");
  const wheels = mouse(calls).filter((x) => x.params.type === "mouseWheel");
  assert.ok(wheels.length >= 10, `${wheels.length} wheel events`);
  assert.ok(wheels.every((x) => x.params.deltaY === 120 && x.params.deltaX === 0));
  assert.equal(page.scriptScrolls, 0);
  const r = page.select("#far")[0].getBoundingClientRect();
  assert.ok(r.top > 0 && r.bottom < page.height, `in view: ${r.top}`);
  const clickText = await callsOf(page, () => commands.click(linux(), { tab: name, text: "Go" }));
  assert.ok(mouse(clickText).filter((x) => x.params.type === "mouseWheel").every((x) => x.params.deltaY === -120), "back up with the wheel");
  assert.equal(page.title, "clicked");
  assert.equal(page.scriptScrolls, 0);
  await commands.close(linux(), { tab: name });
});

test("setFiles: a click on the file input opens the chooser (intercepted), and the files go to the input it names; a hidden input through its label; an input with neither as before, with a log line", async () => {
  operatorInFront();
  const { name, page } = await windowPage();
  const lines: string[] = [];
  const b = await AgentBrowser.connect(linux({ log: (l) => { lines.push(l); } }));
  try {
    const tab = await b.find(name);
    let calls = await callsOf(page, () => tab.setFiles("#file", ["/tmp/a.txt"]));
    assert.deepEqual(page.select("#file")[0].files, [{ name: "a.txt" }]);
    assert.equal(page.fileChoosers, 1);
    assert.deepEqual(calls.filter((x) => x.method === "Page.setInterceptFileChooserDialog").map((x) => x.params.enabled), [true, false]);
    assert.ok(mouse(calls).some((x) => x.params.type === "mousePressed"));
    assert.ok(calls.find((x) => x.method === "DOM.setFileInputFiles")!.params.backendNodeId > 0);
    calls = await callsOf(page, () => tab.setFiles("#hiddenfile", ["/tmp/b.txt"]));
    assert.deepEqual(page.select("#hiddenfile")[0].files, [{ name: "b.txt" }]);
    assert.equal(page.fileChoosers, 2, "the label's click opened it");
    await tab.setFiles("#orphan", ["/tmp/c.txt"]);
    assert.deepEqual(page.select("#orphan")[0].files, [{ name: "c.txt" }]);
    assert.equal(page.fileChoosers, 2);
    assert.ok(lines.some((l) => /setFiles: #orphan has no box to click and no label/.test(l)), lines.join("\n"));
  } finally { await b.disconnect(); }
  await commands.close(linux(), { tab: name });
});

test("one input at a time: two input commands of one process never overlap; the lock is the state folder's input.lock", async () => {
  operatorInFront();
  const a = await windowPage(), b = await windowPage();
  const slow = { ...FAST, pressMs: [80, 90] as [number, number] };
  const ca = await callsOf(a.page, async () => {
    await Promise.all([commands.click(linux({ inputTiming: slow }), { tab: a.name, target: "#b" }), commands.click(linux({ inputTiming: slow }), { tab: b.name, target: "#b" })]);
  });
  const all = fake.calls.filter((x) => (x.targetId === a.page.targetId || x.targetId === b.page.targetId) && (x.method === "Input.dispatchMouseEvent" || x.method === "Page.bringToFront"));
  // The pages' spans of activation and input do not overlap.
  const span = (id: string) => { const xs = all.filter((x) => x.targetId === id); return [xs[0].t, xs.at(-1)!.t]; };
  const [a0, a1] = span(a.page.targetId), [b0, b1] = span(b.page.targetId);
  assert.ok(a1 <= b0 || b1 <= a0, `a ${a0}-${a1}, b ${b0}-${b1}`);
  assert.ok(ca.length > 0);
  assert.equal(a.page.title, "clicked");
  assert.equal(b.page.title, "clicked");
  assert.equal(existsSync(join(c.stateDir, "input.lock")), false, "released");
  await commands.close(linux(), { tab: a.name });
  await commands.close(linux(), { tab: b.name });
});

test("a popup tab in the opener's window: input on it needs no activation; going back to the opener is a tab switch (Page.bringToFront), and no tab moves", async () => {
  operatorInFront();
  const { name, page } = await windowPage();
  await commands.click(linux(), { tab: name, target: "#b" });
  const popup = fake.openFrom(page, `${fx.base}/`);
  assert.equal(page.background, true, "the popup is in front of the opener's window");
  let calls = await callsOf(popup, () => commands.click(linux(), { tab: popup.targetId.slice(0, 8), target: "#b" }));
  assert.ok(!methods(calls).includes("Page.bringToFront"));
  calls = await callsOf(page, () => commands.click(linux(), { tab: name, target: "#i" }));
  assert.ok(methods(calls).includes("Page.bringToFront"), "a tab switch back to the opener");
  assert.equal(page.background, false);
  assert.equal(popup.background, true);
  assert.equal(popup.windowId, page.windowId, "no tab moved");
  await commands.close(linux(), { tab: popup.targetId.slice(0, 8) });
  await commands.close(linux(), { tab: name });
});

test("record in a window: the window comes forward first, under the input lock; the demo cursor starts where the page last saw the pointer", needsFfmpeg, async () => {
  operatorInFront();
  const { name, page } = await windowPage();
  const end = mouse(await callsOf(page, () => commands.click(linux(), { tab: name, target: "#b" }))).at(-1)!.params;
  operatorInFront();
  const script = join(c.dir, `${name}-steps.json`);
  writeFileSync(script, JSON.stringify([{ wait: 200 }, { click: "#i" }]));
  const calls = await callsOf(page, () => commands.record(linux(), { tab: name, out: join(c.dir, `${name}.mp4`), script, size: "640x360", fps: 10, settle: 100, ffmpeg: FFMPEG }));
  const m = methods(calls);
  assert.ok(m.indexOf("Page.bringToFront") >= 0 && m.indexOf("Page.bringToFront") < m.indexOf("Page.startScreencast"));
  const first = mouse(calls)[0].params;
  assert.equal(first.type, "mouseMoved");
  assert.ok(Math.hypot(first.x - end.x, first.y - end.y) < 60, `no jump at the take's first move (and no move at the start point, where the page has the pointer): ${first.x},${first.y} from ${end.x},${end.y}`);
  const press = mouse(calls).find((x) => x.params.type === "mousePressed")!.params;
  assert.deepEqual([press.force, press.buttons], [0.5, 1], "record's press has a person's force");
  await commands.close(linux(), { tab: name });
});

test("in a window agent-browser's own page code runs with no user gesture (no user activation with no input); eval runs as one; a tab as before", async () => {
  operatorInFront();
  const { name, page } = await windowPage();
  const gestures = (calls: Call[]) => calls.filter((x) => x.method === "Runtime.evaluate").map((x) => x.params.userGesture === true);
  let calls = await callsOf(page, async () => {
    await commands.text(linux(), { tab: name });
    await commands.outline(linux(), { tab: name });
    await commands.click(linux(), { tab: name, target: "#b" });
    await commands.type(linux(), { tab: name, text: "a", into: "#i" });
  });
  assert.ok(gestures(calls).length > 5 && gestures(calls).every((g) => !g), "no gesture");
  calls = await callsOf(page, () => commands.eval(linux(), { tab: name, expression: "1 + 1" }));
  assert.ok(gestures(calls).includes(true), "eval, as before");
  await commands.close(linux(), { tab: name });
  const r = await commands.open(linux(), { url: `${fx.base}/`, name: "gtab", tab: true });
  calls = await callsOf(fake.pages.get(r.tab.targetId)!, () => commands.text(linux(), { tab: "gtab" }));
  assert.ok(gestures(calls).every((g) => g), "a tab of open --tab, as before");
  await commands.close(linux(), { tab: "gtab" });
});

test("read commands never activate a window: text, eval, outline and shot", async () => {
  operatorInFront();
  const { name, page } = await windowPage();
  const calls = await callsOf(page, async () => {
    await commands.text(linux(), { tab: name });
    await commands.eval(linux(), { tab: name, expression: "1" });
    await commands.outline(linux(), { tab: name });
    await commands.shot(linux(), { tab: name, path: join(c.dir, `${name}.png`) });
  });
  assert.ok(!methods(calls).includes("Page.bringToFront") && !fake.calls.some((x) => x.method === "Target.activateTarget" && x.targetId === page.targetId));
  assert.equal(page.hasFocus, false);
  await commands.close(linux(), { tab: name });
});

test("open --tab, the Mac and personal mode keep today's input: three mouse events, inserted text, el.focus(), no activation and no lock", async () => {
  const personal = consumer();
  const po = personal.options({ endpoint: fake.ws, mode: "personal", platform: "linux" });
  try {
  for (const o of [linux(), c.options({ endpoint: fake.ws, platform: "darwin" }), po]) {
    const name = `old${++n}`;
    const r = await commands.open(o, { url: `${fx.base}/`, name, tab: o !== po });
    const page = fake.pages.get(r.tab.targetId)!;
    const calls = await callsOf(page, async () => {
      await commands.click(o, { tab: name, target: "#b" });
      await commands.type(o, { tab: name, text: "q", into: "#i" });
    });
    assert.deepEqual(mouse(calls).map((x) => x.params.type), ["mouseMoved", "mousePressed", "mouseReleased"]);
    assert.ok(methods(calls).includes("Input.insertText"));
    assert.equal(page.scriptFocus, 1);
    assert.ok(!methods(calls).includes("Page.bringToFront"));
    await commands.close(o, { tab: name });
  }
  } finally { stopProxy(resolveOptions(po)); personal.remove(); }
});

// ---------- the review of PR #47 (review-47) ----------

/** Another agent-browser process holds the input lock (a live pid in input.lock) for `ms`. */
function holdLock(ms: number) {
  const holder = spawn("sleep", [String(ms / 1000)], { stdio: "ignore" });
  writeFileSync(join(c.stateDir, "input.lock"), String(holder.pid), { mode: 0o600 });
  return holder;
}

const INPUT_COMMANDS: [string, (o: BrowserOptions, name: string) => Promise<unknown>][] = [
  ["click", (o, name) => commands.click(o, { tab: name, target: "#b" })],
  ["click --text", (o, name) => commands.click(o, { tab: name, text: "Go" })],
  ["hover", (o, name) => commands.hover(o, { tab: name, target: "#hov" })],
  ["type --into", (o, name) => commands.type(o, { tab: name, text: "secret", into: "#i" })],
  ["press", (o, name) => commands.press(o, { tab: name, key: "Enter" })],
  ["Tab.clickAt", async (o, name) => { const b = await AgentBrowser.connect(o); try { await (await b.find(name)).clickAt(100, 112); } finally { await b.disconnect(); } }],
  ["Tab.setFiles", async (o, name) => { const b = await AgentBrowser.connect(o); try { await (await b.find(name)).setFiles("#file", ["/etc/hostname"]); } finally { await b.disconnect(); } }],
];

for (const [what, run] of INPUT_COMMANDS) {
  test(`${what}: a page that leaves the allowlist while the command waits for the input lock gets no input and runs no code of ours`, async () => {
    operatorInFront();
    const { name, page } = await windowPage();
    const holder = holdLock(800);
    const t0 = Date.now();
    const done = run(linux(), name).then(() => undefined, (e: unknown) => e);
    await new Promise((r) => setTimeout(r, 300));
    fake.navigate(page, "http://evil.test/");
    const navAt = Date.now();
    const e = await done;
    holder.kill();
    assert.ok(e instanceof NotAllowedError, `refused: ${e}`);
    assert.ok(Date.now() - t0 >= 700, "it waited for the lock");
    const after = fake.calls.filter((x) => x.targetId === page.targetId && x.t >= navAt);
    assert.deepEqual(after.filter((x) => /^Input\.|^DOM\.setFileInputFiles|^Page\.bringToFront|^Page\.setInterceptFileChooserDialog/.test(x.method)).map((x) => x.method), []);
    // The one call that reached the page after it left the list is the allowlist's own read of location.href.
    assert.ok(after.filter((x) => x.method === "Runtime.evaluate").every((x) => x.params.expression.includes("location.href")),
      after.filter((x) => x.method === "Runtime.evaluate").map((x) => x.params.expression.slice(0, 60)).join(" | "));
    assert.deepEqual(page.select("#file")[0].files, []);
    await commands.close(linux(), { tab: name }).catch(() => {});
  });
}

test("Tab.waitFor's timeoutMs covers its wait for the input lock: on a hidden window page it ends near its timeout while another agent holds the lock (review-47d note 6)", async () => {
  operatorInFront();
  const { name, page } = await windowPage();
  const popup = fake.openFrom(page, `${fx.base}/`); // the page is hidden behind its popup tab
  assert.equal(page.visibilityState, "hidden");
  const b = await AgentBrowser.connect(linux());
  try {
    const tab = await b.find(name);
    const holder = holdLock(4000);
    try {
      let t0 = Date.now();
      await assert.rejects(tab.waitFor(() => false, { timeoutMs: 600, what: "nothing" }), /timed out waiting for nothing/);
      assert.ok(Date.now() - t0 < 2000, `${Date.now() - t0} ms: its timeout, not the lock's wait`);
      // A condition that holds ends the wait as before, also when the lock is not free within the timeout.
      t0 = Date.now();
      assert.equal(await tab.waitFor(() => 7, { timeoutMs: 600 }), 7);
      assert.ok(Date.now() - t0 < 2000, `${Date.now() - t0} ms`);
    } finally { holder.kill(); }
    rmSync(join(c.stateDir, "input.lock"), { force: true });
    // A free lock, and a timeout shorter than the read before the lock: the lock is still tried once, and the tab comes in front.
    assert.equal(await tab.waitFor(() => document.visibilityState === "visible", { timeoutMs: 1 }), true);
    assert.equal(page.visibilityState, "visible");
  } finally { await b.disconnect(); }
  await commands.close(linux(), { tab: popup.targetId.slice(0, 8) });
  await commands.close(linux(), { tab: name });
});

test("a page that leaves the allowlist during the path gets no press; one that leaves it at the field's click gets no key", async () => {
  operatorInFront();
  const { name, page } = await windowPage();
  // The pointer passes over #hov on its way: the page then goes off the list (a site's own redirect).
  page.select("#hov")[0].onhover = (p) => p.fake.navigate(p, "http://evil.test/");
  page.select("#hov")[0].rect = [40, 60, 300, 400];
  let calls = await callsOf(page, () => assert.rejects(commands.click(linux(), { tab: name, target: "#b" }), NotAllowedError));
  assert.ok(!mouse(calls).some((x) => x.params.type === "mousePressed"), "no press on the page off the list");
  const second = await windowPage();
  second.page.select("#i")[0].onclick = (p) => p.fake.navigate(p, "http://evil.test/");
  calls = await callsOf(second.page, () => assert.rejects(commands.type(linux(), { tab: second.name, text: "secret", into: "#i" }), NotAllowedError));
  assert.deepEqual(keys(calls), [], "no key on the page off the list");
  await commands.close(linux(), { tab: name }).catch(() => {});
  await commands.close(linux(), { tab: second.name }).catch(() => {});
});

test("the default timing with the X pointer: each path's last step that moves is the X pointer's move, before the press; the X pointer never moves after it", async () => {
  operatorInFront();
  xdotoolOn = true;
  try {
    const { name, page } = await windowPage();
    for (let i = 0; i < 4; i++) {
      operatorInFront();
      fake.xPointer = { x: 600 + 30 * i, y: 500 };
      xMoves.length = 0;
      const ev = mouse(await callsOf(page, () => commands.click(linux({ inputTiming: undefined }), { tab: name, target: i % 2 ? "#b" : "#hov" })));
      const press = ev.find((x) => x.params.type === "mousePressed")!, release = ev.find((x) => x.params.type === "mouseReleased")!;
      assert.equal(xMoves.length, 1, `one X move: ${JSON.stringify(xMoves)}`);
      assert.ok(xMoves[0].t! <= press.t, "the X move is a step of the path, before the press");
      assert.deepEqual([xMoves[0].x, xMoves[0].y - 87], [press.params.x, press.params.y], "at the press point");
      assert.ok(!ev.some((x) => x.t > release.t && x.params.type === "mouseMoved"));
    }
    await commands.close(linux(), { tab: name });
  } finally { xdotoolOn = false; }
});

test("withInput is reentrant in its own call chain: the caller's own Tab.click inside it does not wait for the lock; another call chain still waits", async () => {
  operatorInFront();
  const { name, page } = await windowPage();
  const o = linux({ inputTiming: { ...FAST, lockWaitMs: 2000 } });
  const b = await AgentBrowser.connect(o);
  try {
    const tab = await b.find(name);
    const t0 = Date.now();
    await tab.withInput(async () => { await tab.click("#b"); await tab.type("ok", "#i"); });
    assert.ok(Date.now() - t0 < 1500, `${Date.now() - t0} ms`);
    assert.equal(page.title, "clicked");
    assert.equal(page.select("#i")[0].value, "ok");
    // A second call chain of the same process waits for the first one's lock.
    const order: string[] = [];
    await Promise.all([
      tab.withInput(async () => { order.push("a in"); await new Promise((r) => setTimeout(r, 300)); order.push("a out"); }),
      (async () => { await new Promise((r) => setTimeout(r, 50)); await tab.click("#b"); order.push("click"); })(),
    ]);
    assert.deepEqual(order, ["a in", "a out", "click"]);
  } finally { await b.disconnect(); }
  await commands.close(o, { tab: name });
});

test("setFiles on a window page that its popup tab hides: its tab comes in front first (a tab switch), through the chooser and the old way alike (review-45b note 5)", async () => {
  operatorInFront();
  const { name, page } = await windowPage();
  const b = await AgentBrowser.connect(linux());
  try {
    const tab = await b.find(name);
    for (const [selector, file] of [["#file", "/tmp/a.txt"], ["#orphan", "/tmp/b.txt"]]) {
      const popup = fake.openFrom(page, `${fx.base}/`);
      assert.equal(page.visibilityState, "hidden", "behind its popup tab");
      const calls = await callsOf(page, () => tab.setFiles(selector, [file]));
      const m = methods(calls), front = m.indexOf("Page.bringToFront"), files = m.indexOf("DOM.setFileInputFiles");
      assert.ok(front >= 0 && files > front, `${selector}: the tab switch before the files (${m.filter((x) => /bringToFront|setFileInputFiles/.test(x)).join(" ")})`);
      assert.equal(page.visibilityState, "visible");
      assert.equal(popup.background, true, "the popup went behind, in the same window");
      assert.equal(popup.windowId, page.windowId);
      assert.deepEqual(page.select(selector)[0].files, [{ name: file.slice(5) }]);
      await commands.close(linux(), { tab: popup.targetId.slice(0, 8) });
    }
  } finally { await b.disconnect(); }
  await commands.close(linux(), { tab: name });
});

test("setFiles: a click that opens no file chooser in 2 s gives the files the old way, with a log line", async () => {
  operatorInFront();
  const { name, page } = await windowPage();
  page.chooserFor = () => null; // the page's own code swallows the click: no chooser opens
  const lines: string[] = [];
  const b = await AgentBrowser.connect(linux({ log: (l) => { lines.push(l); } }));
  try {
    const t0 = Date.now();
    await (await b.find(name)).setFiles("#file", ["/tmp/a.txt"]);
    assert.ok(Date.now() - t0 < 4000, `${Date.now() - t0} ms`);
  } finally { await b.disconnect(); }
  assert.deepEqual(page.select("#file")[0].files, [{ name: "a.txt" }]);
  assert.equal(page.fileChoosers, 0);
  assert.ok(lines.some((l) => /setFiles: the click on #file opened no file chooser; the files go to it with no click/.test(l)), lines.join("\n"));
  await commands.close(linux(), { tab: name });
});

test("a key that takes the page off the allowlist: no later input event reaches it, also not that key's keyUp (review-47b)", async () => {
  operatorInFront();
  const { name, page } = await windowPage();
  await commands.click(linux(), { tab: name, target: "#i" });
  let downs = 0, navIndex = Infinity;
  // The 3rd keydown takes the page off the list (its call is in fake.calls already, so the slice after it holds what came later).
  page.onKey = () => { if (++downs === 3) { navIndex = fake.calls.length; page.fake.navigate(page, "http://evil.test/"); } };
  await assert.rejects(commands.type(linux(), { tab: name, text: "abcdef" }), NotAllowedError);
  const after = fake.calls.slice(navIndex).filter((x) => x.targetId === page.targetId && /^Input\./.test(x.method));
  assert.deepEqual(after.map((x) => `${x.method} ${x.params.type}`), [], "no keyUp of the 3rd key, no 4th key");
  await commands.close(linux(), { tab: name }).catch(() => {});
});

test("setFiles: a chooser that names another input (a frame's input over this one) gets no files; a covered input gets no click; an input below the fold opens its chooser (review-47b)", async () => {
  operatorInFront();
  const { name, page } = await windowPage();
  const lines: string[] = [];
  const b = await AgentBrowser.connect(linux({ log: (l) => { lines.push(l); } }));
  try {
    const tab = await b.find(name);
    const other = page.select("#orphan")[0];
    page.chooserFor = () => other;
    await tab.setFiles("#file", ["/etc/hostname"]);
    assert.deepEqual(other.files, [], "the other input got nothing");
    assert.deepEqual(page.select("#file")[0].files, [{ name: "hostname" }], "the named input got them, the old way");
    assert.ok(lines.some((l) => /setFiles: the click on #file opened another input's file chooser/.test(l)), lines.join("\n"));
    page.chooserFor = undefined;
    // An element over the input: no click at all (the click would reach the cover), the old way with a log line.
    page.select("#hov")[0].rect = [40, 320, 200, 24];
    const before = page.fileChoosers;
    const calls = await callsOf(page, () => tab.setFiles("#file", ["/tmp/b.txt"]));
    assert.ok(!mouse(calls).some((x) => x.params.type === "mousePressed"), "no press on the cover");
    assert.equal(page.fileChoosers, before);
    assert.deepEqual(page.select("#file")[0].files, [{ name: "b.txt" }]);
    assert.ok(lines.some((l) => /setFiles: another element covers #file/.test(l)), lines.join("\n"));
    page.select("#hov")[0].rect = [300, 100, 100, 30];
    // Below the fold: the wheel and the path come first, then the chooser's wait.
    const n0 = lines.length;
    // A slow wheel (review-47c): the chooser's wait must start at the press, after the wheel, or this one falls back.
    const slow = await AgentBrowser.connect(linux({ inputTiming: { ...FAST, wheelMs: [90, 100] }, log: (l) => { lines.push(l); } }));
    try { await (await slow.find(name)).setFiles("#farfile", ["/tmp/c.txt"]); } finally { await slow.disconnect(); }
    assert.deepEqual(page.select("#farfile")[0].files, [{ name: "c.txt" }]);
    assert.equal(page.fileChoosers, before + 1, "through the chooser");
    assert.deepEqual(lines.slice(n0).filter((l) => /setFiles/.test(l)), [], "no fallback");
  } finally { await b.disconnect(); }
  await commands.close(linux(), { tab: name });
});

test("a log line names why the X-pointer method is off: no xdotool, or a pixel ratio that is not 1 (review-47b)", async () => {
  operatorInFront();
  const lines: string[] = [];
  const s = consumer();
  try {
    const o = s.options({ endpoint: fake.ws, platform: "linux", inputTiming: FAST, display: { own: true, xdotool: false }, log: (l: string) => { lines.push(l); } });
    const name = "xoff";
    await commands.open(o, { url: `${fx.base}/`, name });
    await commands.click(o, { tab: name, target: "#b" });
    assert.ok(lines.some((l) => /the X-pointer method is off \(no xdotool on the agent browser's display\)/.test(l)), lines.join("\n"));
    await commands.close(o, { tab: name });
    stopProxy(resolveOptions(o));
  } finally { s.remove(); }
});

test("a read of a hidden window page waits for another agent's input: its tab switch never lands inside the other's typing (review-47c)", async () => {
  operatorInFront();
  const slow = linux({ inputTiming: { ...FAST, keyMs: [60, 70] } });
  const a = await windowPage(slow), b = await windowPage(slow);
  const popup = fake.openFrom(b.page, `${fx.base}/`); // b's page is now hidden behind its popup tab
  assert.equal(b.page.visibilityState, "hidden");
  const from = fake.calls.length;
  const typing = commands.type(slow, { tab: a.name, text: "abcdefghijkl", into: "#i" });
  await new Promise((r) => setTimeout(r, 400));
  for (const read of [() => commands.text(slow, { tab: b.name }), () => commands.outline(slow, { tab: b.name }), () => commands.eval(slow, { tab: b.name, expression: "1" })]) {
    fake.selectTab(popup); // the popup in front of b's window again (no window activation)
    await read();
  }
  await typing;
  const calls = fake.calls.slice(from);
  const keys = calls.filter((x) => x.targetId === a.page.targetId && x.method === "Input.dispatchKeyEvent");
  const fronts = calls.filter((x) => x.targetId === b.page.targetId && x.method === "Page.bringToFront");
  assert.ok(keys.length >= 24 && fronts.length >= 1, `${keys.length} keys, ${fronts.length} tab switches`);
  assert.ok(fronts.every((x) => x.t >= keys.at(-1)!.t), "every tab switch of the reads came after the typing");
  assert.equal(a.page.select("#i")[0].value, "abcdefghijkl");
  assert.equal(a.page.keyFocus, false, "no key went into a window that had lost the focus");
  await commands.close(linux(), { tab: popup.targetId.slice(0, 8) });
  await commands.close(linux(), { tab: a.name });
  await commands.close(linux(), { tab: b.name });
});

test("a navigation off the list that the page only asks for (Page.frameRequestedNavigation) stops the input at once (review-47c)", async () => {
  operatorInFront();
  const { name, page } = await windowPage();
  page.select("#hov")[0].onhover = (p) => p.fake.requestNavigation(p, "http://evil.test/");
  page.select("#hov")[0].rect = [40, 60, 300, 400];
  let at = Infinity;
  const orig = fake.requestNavigation.bind(fake);
  fake.requestNavigation = (p, u) => { if (at === Infinity) at = fake.calls.length; orig(p, u); };
  try {
    await assert.rejects(commands.click(linux(), { tab: name, target: "#b" }), NotAllowedError);
  } finally { fake.requestNavigation = orig; }
  const after = fake.calls.slice(at).filter((x) => x.targetId === page.targetId && /^Input\./.test(x.method));
  assert.ok(after.length <= 1, `at most the move in flight: ${after.map((x) => x.params.type).join(" ")}`);
  assert.ok(!after.some((x) => x.params.type === "mousePressed"));
  await commands.close(linux(), { tab: name }).catch(() => {});
});

test("a target=_blank link to a host off the list sends no request on the opener and stops no later input; the new tab stays out of reach (review-47d note 7)", async () => {
  operatorInFront();
  const { name, page } = await windowPage();
  const b = await AgentBrowser.connect(linux());
  try {
    const tab = await b.find(name);
    // One input call chain: the click on the link, then the guard again, then a click on the opener (as a record take does).
    await tab.withInput(async (h) => { await h!.click("#blank"); await h!.check(); await tab.click("#b"); });
    assert.equal(page.title, "clicked", "the opener got the later click");
    assert.equal(page.url, `${fx.base}/`, "the opener stayed on its page");
    const opened = [...fake.pages.values()].find((p) => p.url === "http://evil.test/");
    assert.ok(opened, "the link opened its new tab");
    assert.ok(fake.calls.some((x) => x.targetId === page.targetId && x.method === "Input.dispatchMouseEvent"), "input reached the opener");
    // The new tab off the list is blocked as before: no command reaches it, and it gets no input.
    await assert.rejects(b.attach(opened.targetId), NotAllowedError);
    assert.ok(!(await commands.tabs(linux())).tabs.some((t) => t.targetId === opened.targetId));
    assert.deepEqual(fake.calls.filter((x) => x.targetId === opened.targetId && /^Input\./.test(x.method)), []);
    opened.close();
    fake.pages.delete(opened.targetId);
  } finally { await b.disconnect(); }
  await commands.close(linux(), { tab: name }).catch(() => {});
});

test("a navigation off the list that has only started (Page.frameStartedNavigating, with no commit yet) stops the input at once (review-47d note 8)", async () => {
  operatorInFront();
  const { name, page } = await windowPage();
  page.select("#hov")[0].onhover = (p) => p.fake.startNavigation(p, "http://evil.test/");
  page.select("#hov")[0].rect = [40, 60, 300, 400];
  let at = Infinity;
  const orig = fake.startNavigation.bind(fake);
  fake.startNavigation = (p, u) => { if (at === Infinity) at = fake.calls.length; orig(p, u); };
  try {
    await assert.rejects(commands.click(linux(), { tab: name, target: "#b" }), NotAllowedError);
  } finally { fake.startNavigation = orig; }
  assert.equal(page.url, `${fx.base}/`, "no commit: only the start of the navigation said it");
  const after = fake.calls.slice(at).filter((x) => x.targetId === page.targetId && /^Input\./.test(x.method));
  assert.ok(after.length <= 1, `at most the move in flight: ${after.map((x) => x.params.type).join(" ")}`);
  assert.ok(!after.some((x) => x.params.type === "mousePressed"));
  await commands.close(linux(), { tab: name }).catch(() => {});
});

test("setFiles: an element that comes over the input after the path gets no press (a second hit test); the old way checks the document's URL (review-47c)", async () => {
  operatorInFront();
  const { name, page } = await windowPage();
  const lines: string[] = [];
  const o = linux({ inputTiming: { ...FAST, settleMs: [250, 250] }, log: (l) => { lines.push(l); } });
  const cover = page.select("#hov")[0], file = page.select("#file")[0];
  let moved = false;
  file.onhover = (p) => { if (!moved) { moved = true; p.later(120, () => { cover.rect = [40, 320, 200, 24]; }); } };
  const b = await AgentBrowser.connect(o);
  try {
    const calls = await callsOf(page, () => b.find(name).then((t) => t.setFiles("#file", ["/tmp/d.txt"])));
    assert.ok(!mouse(calls).some((x) => x.params.type === "mousePressed"), "no press on the cover");
    assert.deepEqual(file.files, [{ name: "d.txt" }], "the old way");
    assert.ok(lines.some((l) => /setFiles: another element covers #file/.test(l)), lines.join("\n"));
    // The old way, while the page goes off the list as the document is read: no files.
    cover.rect = [300, 100, 100, 30];
    page.onDocument = () => { page.onDocument = undefined; page.fake.navigate(page, "http://evil.test/"); };
    await assert.rejects((await b.find(name)).setFiles("#orphan", ["/etc/hostname"]), NotAllowedError);
    assert.deepEqual(fake.calls.filter((x) => x.targetId === page.targetId && x.method === "DOM.setFileInputFiles" && x.params.files?.includes("/etc/hostname")), []);
  } finally { await b.disconnect(); }
  await commands.close(linux(), { tab: name }).catch(() => {});
});

test("record holds the input lock for the take only: the lock is free while ffmpeg encodes", needsFfmpeg, async () => {
  operatorInFront();
  const { name } = await windowPage();
  const seen = join(c.dir, "ffmpeg-saw-lock.txt"), wrapper = join(c.dir, "ffmpeg-wrapper.sh");
  writeFileSync(wrapper, `#!/bin/sh
if [ -e "${join(c.stateDir, "input.lock")}" ]; then echo "lock $*" >> "${seen}"; else echo "free $*" >> "${seen}"; fi
exec "${FFMPEG}" "$@"
`);
  chmodSync(wrapper, 0o755);
  const script = join(c.dir, `${name}-steps.json`);
  writeFileSync(script, JSON.stringify([{ wait: 200 }]));
  await commands.record(linux(), { tab: name, out: join(c.dir, `${name}.mp4`), script, size: "320x180", fps: 10, settle: 100, ffmpeg: wrapper });
  const encode = readFileSync(seen, "utf8").split("\n").filter((l) => /\.mp4/.test(l));
  assert.ok(encode.length >= 1 && encode.every((l) => l.startsWith("free")), readFileSync(seen, "utf8"));
  await commands.close(linux(), { tab: name });
});

test("a display that is not the agent browser's own (another program's windows, or not known): today's behaviour, with a log line: a background tab, today's input, no activation, no lock", async () => {
  operatorInFront();
  const lines: string[] = [];
  const o = linux({ display: { own: false }, log: (l) => { lines.push(l); } });
  const name = `notown${++n}`;
  const page = fake.pages.get((await commands.open(o, { url: `${fx.base}/`, name })).tab.targetId)!;
  assert.equal(page.background, true, "a background tab, as before");
  const calls = await callsOf(page, async () => { await commands.click(o, { tab: name, target: "#b" }); await commands.press(o, { tab: name, key: "Enter" }); });
  assert.ok(!methods(calls).includes("Page.bringToFront"));
  assert.deepEqual(mouse(calls).map((x) => x.params.type), ["mouseMoved", "mousePressed", "mouseReleased"], "today's click");
  assert.ok(calls.some((x) => x.method === "Emulation.setFocusEmulationEnabled"), "today's focus emulation");
  assert.equal(page.title, "clicked");
  assert.ok(lines.some((l) => /not on a display of its own/.test(l)), lines.join("\n"));
  await commands.close(o, { tab: name });
});

test("the X pointer only for the agent Chrome's own windows: a focused window of another pid (another Xvfb of the same size) is not used", async () => {
  operatorInFront();
  xdotoolOn = true;
  try {
    const { name, page } = await windowPage();
    fake.xPointer = { x: 700, y: 500 };
    xMoves.length = 0;
    await callsOf(page, () => commands.click(linux({ display: { own: true, xdotool, chromePid: 7777 } }), { tab: name, target: "#b" }));
    assert.equal(page.title, "clicked");
    assert.deepEqual(xMoves, [], "the windows on that display are not the agent Chrome's");
    await commands.close(linux(), { tab: name });
  } finally { xdotoolOn = false; }
});

test("one input at a time across two processes: their activations and input never overlap", async () => {
  operatorInFront();
  const a = await windowPage(), b = await windowPage();
  // Two Node processes that run commands.click with this test's options (the display is given, as for every test).
  const script = join(c.dir, "click-child.ts");
  writeFileSync(script, `import { commands } from ${JSON.stringify(join(ROOT, "src/commands.ts"))};
const o = JSON.parse(process.argv[2]);
await commands.click({ ...o, log: () => {} }, { tab: process.argv[3], target: "#b" });
`);
  const o = { ...linux({ inputTiming: { ...FAST, pressMs: [150, 160] } }), log: undefined };
  const run = (tab: string) => new Promise<number | null>((resolve) => {
    const child = spawn(process.execPath, [script, JSON.stringify(o), tab], { stdio: ["ignore", "ignore", "inherit"] });
    child.on("exit", (code) => resolve(code));
  });
  const [ra, rb] = await Promise.all([run(a.name), run(b.name)]);
  assert.deepEqual([ra, rb], [0, 0]);
  const span = (p: FakePage) => { const xs = fake.calls.filter((x) => x.targetId === p.targetId && (x.method === "Input.dispatchMouseEvent" || x.method === "Page.bringToFront")); return [xs[0].t, xs.at(-1)!.t]; };
  const [a0, a1] = span(a.page), [b0, b1] = span(b.page);
  assert.ok(a1 <= b0 || b1 <= a0, `a ${a0}-${a1}, b ${b0}-${b1}`);
  await commands.close(linux(), { tab: a.name });
  await commands.close(linux(), { tab: b.name });
});


for (const disposition of ["newTab", "newWindow"]) test(`an off-list ${disposition} request on the opener leaves its input guard open (review-47d note 7)`, async () => {
  operatorInFront();
  const { name, page } = await windowPage();
  let requests = 0;
  page.select("#hov")[0].onhover = (p) => { requests++; p.fake.requestNavigation(p, "http://evil.test/", disposition); };
  page.select("#hov")[0].onclick = (p) => { p.title = "clicked"; };
  try {
    await commands.click(linux(), { tab: name, target: "#hov" });
    assert.ok(requests > 0, "the request arrived during the input");
    assert.equal(page.title, "clicked");
    assert.equal(page.url, `${fx.base}/`);
  } finally { await commands.close(linux(), { tab: name }).catch(() => {}); }
});

// ---------- the generator of src/human/ (board ab-t30.3; the input design, sections 10.1 and 11.2) ----------

test("the generator's player: a click's moves go at the plan's rate with no wait for each answer, each event with a person's timestamp; the hold counts from the press's send", async () => {
  operatorInFront();
  const { name, page } = await windowPage();
  fake.delays.set("Input.dispatchMouseEvent", 25); // each answer comes 25 ms after the event
  try {
    // The player's side (sentOf): the sends' times and the clock that the player read, not the fake's receive times.
    const ev = (await sentOf(page, () => commands.click(linux({ inputTiming: { ...FAST, moveScale: 1, pressMs: [150, 160] } }), { tab: name, target: "#b" }))).filter((x) => x.method === "Input.dispatchMouseEvent");
    const moves = ev.filter((x) => x.params.type === "mouseMoved");
    assert.ok(moves.length >= 20, `${moves.length} moves`);
    const gaps = moves.slice(1).map((x, i) => x.at - moves[i].at).sort((a, b) => a - b);
    assert.ok(gaps[Math.floor(gaps.length / 2)] <= 12, `the moves 8 ms apart, not one answer apart: median gap ${gaps[Math.floor(gaps.length / 2)]} ms`);
    for (const x of ev) personStamp(x);
    const press = ev.find((x) => x.params.type === "mousePressed")!, release = ev.find((x) => x.params.type === "mouseReleased")!;
    assert.ok(release.at - press.at >= 148 && release.at - press.at <= 172, `a hold of 150 to 160 ms from the press's send, not from its answer: ${release.at - press.at} ms`);
  } finally { fake.delays.delete("Input.dispatchMouseEvent"); }
  assert.equal(page.title, "clicked");
  await commands.close(linux(), { tab: name });
});

test("board ab-t30.14: the latency rule reads the player's clock: a fake that gets each event 6 ms late (a loaded box) still sees the 3 to 5 ms latency before each send", async () => {
  operatorInFront();
  const { name, page } = await windowPage();
  let calls: Call[] = [];
  const sent = await sentOf(page, async () => { calls = await callsOf(page, () => commands.click(linux({ inputTiming: { ...FAST, moveScale: 1 } }), { tab: name, target: "#b" })); }, 6);
  const ev = sent.filter((x) => x.method === "Input.dispatchMouseEvent");
  assert.equal(ev.length, mouse(calls).length);
  for (const x of ev) personStamp(x);
  // The forced condition: by the fake's receive time, each event comes more than 8 ms after its timestamp (at least
  // 2.5 ms of latency and 6 of delivery), so the old check on the receive time (x.t - ts <= 8) fails on each event.
  for (const x of mouse(calls)) assert.ok(x.t - x.params.timestamp * 1000 > 8, `the fake got it ${x.t - x.params.timestamp * 1000} ms after its timestamp`);
  assert.equal(page.title, "clicked");
  await commands.close(linux(), { tab: name });
});

test("the generator's press point: a person's spread around the element's middle, at most 1/4 of its smaller side; the scope's person keeps its seed in pointer.json", async () => {
  operatorInFront();
  const { name, page } = await windowPage();
  const points = new Set<string>();
  for (let i = 0; i < 8; i++) {
    const ev = mouse(await callsOf(page, () => commands.click(linux(), { tab: name, target: i % 2 ? "#b" : "#hov" })));
    const p = ev.find((x) => x.params.type === "mousePressed")!.params;
    const [cx, cy, side] = i % 2 ? [100, 115, 30] : [350, 115, 30];
    assert.ok(Math.hypot(p.x - cx, p.y - cy) <= side / 4 + 1e-9, `${p.x},${p.y}: at most ${side / 4} px from the middle`);
    assert.ok(Number.isInteger(p.x) && Number.isInteger(p.y));
    points.add(`${p.x},${p.y}`);
  }
  assert.ok(points.size >= 4, `spread: ${[...points].join(" ")}`);
  const seed = JSON.parse(readFileSync(join(c.stateDir, "pointer.json"), "utf8")).seed;
  assert.ok(Number.isInteger(seed), "the scope's person: a seed in pointer.json");
  await commands.click(linux(), { tab: name, target: "#b" });
  assert.equal(JSON.parse(readFileSync(join(c.stateDir, "pointer.json"), "utf8")).seed, seed, "kept for the state folder's life");
  await commands.close(linux(), { tab: name });
});

test("the generator's start: a page with no last point and no X pointer starts its path in the viewport's middle 30% to 70%, never at a fixed point", async () => {
  const firsts: { x: number; y: number }[] = [];
  for (let i = 0; i < 5; i++) {
    operatorInFront();
    const { name, page } = await windowPage();
    const first = mouse(await callsOf(page, () => commands.click(linux(), { tab: name, target: "#b" })))[0].params;
    // One step of at most 28 px (3.5 px/ms for 8 ms) from a start in the middle 30% to 70% of the fake's 1280 x 800 view.
    assert.ok(first.x >= 0.3 * 1280 - 28 && first.x <= 0.7 * 1280 + 28 && first.y >= 0.3 * 800 - 28 && first.y <= 0.7 * 800 + 28, `${first.x},${first.y}`);
    firsts.push(first);
    await commands.close(linux(), { tab: name });
  }
  const xs = firsts.map((p) => p.x), ys = firsts.map((p) => p.y);
  assert.ok(Math.max(...xs) - Math.min(...xs) > 60 || Math.max(...ys) - Math.min(...ys) > 60, `no fixed start: ${firsts.map((p) => `${p.x},${p.y}`).join(" ")}`);
});

/**
 * One click on #b, with the spread point that the generator drew for it (the point of its hit test's call) and the
 * press's point (board ab-t30.16).
 */
async function pressOnB(page: FakePage, name: string): Promise<{ drawn: { x: number; y: number }; press: { x: number; y: number } }> {
  page.title = "input";
  const calls = await callsOf(page, () => commands.click(linux(), { tab: name, target: "#b" }));
  const tests = calls.filter((x) => x.method === "Runtime.evaluate" && /^\(function hits\(/.test(x.params.expression));
  assert.equal(tests.length, 1, "one hit test for each click");
  const [x, y] = JSON.parse(/\(\.\.\.(\[[^\]]*\])\)$/.exec(tests[0].params.expression)![1]) as [number, number];
  const p = mouse(calls).find((c) => c.params.type === "mousePressed")!.params;
  return { drawn: { x, y }, press: { x: p.x, y: p.y } };
}

test("the generator's press point and its hit test: a spread point over another element goes to the element's middle", async () => {
  operatorInFront();
  const { name, page } = await windowPage();
  const hov = page.select("#hov")[0], B = page.select("#b")[0];
  const middle = { x: 100, y: 115 };
  // Each press is checked against its own drawn point (board ab-t30.16), so no draw can fail the rule: 12 draws that
  // all fall on the cover come by chance (about once in 1,200 runs), and the old check (some press left of the middle)
  // failed on them.
  try {
    // The forced case: #hov covers all of #b, so each drawn point is over another element: each press at the middle.
    hov.rect = [40, 100, 120, 30];
    for (let i = 0; i < 6; i++) {
      const { drawn, press } = await pressOnB(page, name);
      assert.notEqual(page.hit(drawn.x, drawn.y), B);
      assert.deepEqual(press, middle, `the drawn point ${drawn.x},${drawn.y} is over #hov: the press goes to the middle`);
    }
    // #hov covers the right part of #b (x 101 and more): a drawn point of #b's own is the press point, one over #hov goes
    // to the middle. The clicks go on (12 at least, 60 at most) until each case came once.
    hov.rect = [101, 100, 59, 30];
    let own = 0, covered = 0;
    for (let i = 0; i < 60 && (i < 12 || !own || !covered); i++) {
      const { drawn, press } = await pressOnB(page, name);
      if (page.hit(drawn.x, drawn.y) === B) { own++; assert.deepEqual(press, drawn, `the drawn point ${drawn.x},${drawn.y} is #b's own: the press is there`); }
      else { covered++; assert.deepEqual(press, middle, `the drawn point ${drawn.x},${drawn.y} is over #hov: the press goes to the middle`); }
      assert.ok(press.x <= 100, `no press on the cover: ${press.x},${press.y}`);
      assert.equal(page.title, "clicked", `the press at ${press.x},${press.y} reached #b`);
    }
    assert.ok(own > 0 && covered > 0, `both cases came: ${own} of #b's own, ${covered} over the cover`);
  } finally { hov.rect = [300, 100, 100, 30]; }
  await commands.close(linux(), { tab: name });
});
