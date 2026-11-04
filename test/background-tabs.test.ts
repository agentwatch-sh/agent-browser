// The pure parts of the live background-tab check (test/live/background-tabs/rules.ts): the start guard,
// the agent Chrome's extra switches, the timer statistics, the shot's pixels and the failure rules. The
// check itself (a real Chromium in a private Xvfb) is not part of `npm test`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { assertSafeChromeArgs } from "../src/agent.ts";
import type { Pixels } from "../src/record.ts";
import { boxColour, chromeArgs, failures, LAYOUT, shotProblem, startMode, TIMER_FLAGS, timerStats, visibilityIn, visibleSpans, type Drive, type Idle, type Run, type Timer } from "./live/background-tabs/rules.ts";

const stats = (medianMs: number | null, frames = 0) => ({ ticks: 6, medianMs, maxMs: medianMs, frames });
const timer = (tab: string, expected: "visible" | "hidden", medianMs: number | null, o: Partial<Timer> = {}): Timer =>
  ({ phase: "p1", tab, front: "a", visibility: expected, expected, stats: stats(medianMs, expected === "visible" ? 360 : 0), ...o });
const idle = (tab: string, expected: "visible" | "hidden", o: Partial<Idle> = {}): Idle =>
  ({ phase: "p2", driven: "b", tab, front: "a", visibility: expected, expected, frames: expected === "visible" ? 30 : 0, ...o });
const drive = (tab: string, o: Partial<Drive> = {}): Drive => ({ phase: "p2", tab, front: "a", visibility: "hidden", during: "visible", expected: "hidden",
  steps: (["click", "type", "eval", "text", "shot"] as const).map((step) => ({ step, ok: true, ms: 40 })), ...o });
const run = (o: Partial<Run> = {}): Run => ({ before: false, tabs: ["a", "b"], drives: [drive("b"), drive("a", { visibility: "visible", expected: "visible" })],
  timers: [timer("a", "visible", 50), timer("b", "hidden", 1000)], idles: [idle("a", "visible"), idle("b", "hidden")],
  recordings: [{ tab: "b", front: "a", visibility: "hidden", frames: 30, seconds: 3, fps: 10, maxFrameGapMs: 900 }], ...o });

/**
 * A shot of the page (CSS px times dpr) after `clicks` clicks: white, with the box, the button and the
 * status line in their colours. Only the rows above `drawn` (CSS px) are drawn; the rest is `rest`.
 */
function picture(clicks: number, o: { dpr?: number; channels?: number; drawn?: number; rest?: number[] } = {}): Pixels {
  const dpr = o.dpr ?? 1, channels = o.channels ?? 3, width = 400 * dpr, height = 400 * dpr, data = Buffer.alloc(width * height * channels, 255);
  const fill = (r: { x: number; y: number; width: number; height: number }, c: readonly number[]) => {
    for (let y = r.y * dpr; y < (r.y + r.height) * dpr; y++) for (let x = r.x * dpr; x < (r.x + r.width) * dpr; x++) for (let ch = 0; ch < Math.min(c.length, channels); ch++) data[(y * width + x) * channels + ch] = c[ch];
  };
  fill(LAYOUT.box, boxColour(clicks));
  fill(LAYOUT.button, LAYOUT.button.colour);
  fill(LAYOUT.status, LAYOUT.status.colour);
  if (o.drawn !== undefined) fill({ x: 0, y: o.drawn, width: 400, height: 400 - o.drawn }, o.rest ?? [255, 255, 255, 255]);
  return { width, height, channels, data };
}

test("start guard: Linux only, in a private Xvfb; the display and the timer window are checked", () => {
  assert.deepEqual(startMode("linux", {}), { chrome: "/usr/bin/chromium", display: 98, before: false, hiddenMs: 6000 });
  assert.deepEqual(startMode("linux", { chrome: "/opt/c/chrome", display: "42", before: true, hiddenMs: "3000" }), { chrome: "/opt/c/chrome", display: 42, before: true, hiddenMs: 3000 });
  const mac = startMode("darwin", {});
  assert.ok("error" in mac && /Linux only/.test(mac.error) && /private Xvfb/.test(mac.error), JSON.stringify(mac));
  for (const f of [{ display: "x" }, { display: "0" }, { hiddenMs: "100" }, { hiddenMs: "1.5" }]) assert.ok("error" in startMode("linux", f), JSON.stringify(f));
});

test("the agent Chrome's extra switches: no network and an X11 window, the timer flags only with --before, and nothing that agent-browser refuses", () => {
  const after = chromeArgs(false), before = chromeArgs(true);
  for (const flag of TIMER_FLAGS) assert.ok(!after.includes(flag) && before.includes(flag), flag);
  assert.deepEqual(TIMER_FLAGS, ["--disable-renderer-backgrounding", "--disable-background-timer-throttling"]);
  assert.ok(after.includes("--ozone-platform=x11"));
  assert.ok(after.includes("--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE probe.localhost"));
  assert.ok(after.includes("--proxy-server=http://127.0.0.1:9"));
  assertSafeChromeArgs(before); // no debugging port, no headless, no profile switch: the check goes through agent-browser's own launch
});

test("timerStats: the ticks and frames inside the window, the median and the longest gap", () => {
  assert.deepEqual(timerStats([0, 1000, 2000, 2050, 2100, 2150, 9000], [1500, 2500, 9500], 1000, 2150), { ticks: 5, medianMs: 50, maxMs: 1000, frames: 1 });
  assert.deepEqual(timerStats([0, 1000, 2000, 3000], [], 0, 3000), { ticks: 4, medianMs: 1000, maxMs: 1000, frames: 0 });
  assert.deepEqual(timerStats([0, 50, 1050], [], 0, 2000), { ticks: 3, medianMs: 525, maxMs: 1000, frames: 0 }, "an even count: the mean of the two middle gaps");
  assert.deepEqual(timerStats([5000], [], 0, 9000), { ticks: 1, medianMs: null, maxMs: null, frames: 0 });
});

test("visibilityIn: the page's own states from one time to another, in order and without repeats", () => {
  const log = [[1000, "hidden"], [2000, "visible"], [2100, "hidden"], [5000, "visible"]] as const;
  assert.equal(visibilityIn(log, 1500, 1900), "hidden");
  assert.equal(visibilityIn(log, 1500, 3000), "hidden, visible, hidden");
  assert.equal(visibilityIn(log, 2000, 2000), "visible", "an entry at the time itself counts");
  assert.equal(visibilityIn(log, 6000, 7000), "visible");
  assert.equal(visibilityIn(log, 500, 900), "unknown");
  assert.equal(visibilityIn([[0, "hidden"], [10, "hidden"]], 0, 20), "hidden");
});

test("visibleSpans: how long each visible span lasted that began in the window, in ms; a span still open at the end is cut there", () => {
  const log = [[0, "hidden"], [1000, "visible"], [1012, "hidden"], [2000, "visible"], [3010, "hidden"], [4000, "visible"]] as const;
  assert.deepEqual(visibleSpans(log, 500, 3500), [12, 1010]);
  assert.deepEqual(visibleSpans(log, 1500, 4500), [1010, 500]);
  assert.deepEqual(visibleSpans(log, 1005, 1900), [], "a span that began before the window is not counted");
  assert.deepEqual(visibleSpans([[0, "hidden"]], 0, 100), []);
});

test("shotProblem: a full picture passes; the wrong box colour, or a picture drawn only above y=256, fails", () => {
  assert.equal(shotProblem(picture(3), 3), undefined);
  assert.equal(shotProblem(picture(2, { dpr: 2, channels: 4 }), 2, 2), undefined, "a picture at 2x, with alpha");
  assert.equal(shotProblem(picture(0), 0), undefined, "no click yet: the first colour");
  assert.match(shotProblem(picture(2), 3) ?? "", /the box is rgb\(0,0,200\), expected rgb\(0,160,0\) after 3 clicks/);
  // A frame that is not fully drawn: only the first row of 256 px raster tiles, the rest white, black or transparent.
  for (const rest of [[255, 255, 255], [0, 0, 0]]) assert.match(shotProblem(picture(3, { drawn: 256, rest }), 3) ?? "", /the button is rgb\(\d+,\d+,\d+\), expected rgb\(255,170,0\)/);
  assert.match(shotProblem(picture(3, { channels: 4, drawn: 256, rest: [255, 170, 0, 0] }), 3) ?? "", /the button is transparent/, "the right colour, but transparent");
  assert.match(shotProblem(picture(3, { drawn: 305 }), 3) ?? "", /the status line is rgb\(255,255,255\), expected rgb\(120,0,160\)/);
  assert.match(shotProblem(picture(3), 3, 2) ?? "", /the box|the button|the status line/, "the wrong pixel ratio reads the wrong pixels");
});

test("the page's parts below y=256 have colours of their own, not the default grey of a button", () => {
  assert.ok(LAYOUT.button.y >= 256 && LAYOUT.status.y >= 256, "below the first row of raster tiles");
  for (const c of [LAYOUT.button.colour, LAYOUT.status.colour]) assert.ok(new Set(c).size > 1, `rgb(${c}) is not a grey, white or black`);
});

test("failures: a good run has none", () => {
  assert.deepEqual(failures(run()), []);
  assert.deepEqual(failures(run({ before: true, timers: [timer("a", "visible", 50), timer("b", "hidden", 50)] })), []);
  assert.deepEqual(failures(run({ recordings: [{ tab: "b", front: "a", skipped: "no ffmpeg" }] })), [], "a skipped recording is no failure");
});

test("failures: a step that did not work in a hidden tab, a tab that is not hidden, a missing tab, a failed recording", () => {
  const bad = drive("b", { steps: [{ step: "click", ok: true, ms: 1 }, { step: "type", ok: false, ms: 9000, detail: "the field holds \"\"" }] });
  assert.deepEqual(failures(run({ drives: [bad] })), ['p2: tab b (front: a) type: the field holds ""']);
  assert.deepEqual(failures(run({ drives: [drive("b", { visibility: "visible" })] })), ["p2: tab b was visible before its drive, expected hidden (front: a)"]);
  assert.deepEqual(failures(run({ drives: [drive("b", { during: "hidden" }), drive("a", { visibility: "visible", during: "visible", expected: "visible" })] })), [],
    "the state during agent-browser's command is information only");
  assert.deepEqual(failures(run({ tabs: ["a"] })), ["tabs: tab b is not listed"]);
  assert.deepEqual(failures(run({ recordings: [{ tab: "b", front: "a", error: "timed out" }] })), ["record: tab b (front: a): timed out"]);
});

test("failures: a hidden tab's timer at full rate without the timer flags, or slow with them; a slow visible tab; too few ticks", () => {
  assert.match(failures(run({ timers: [timer("b", "hidden", 50)] })).join(), /median 50 ms, expected at least 500 ms \(a hidden tab without the timer flags\)/);
  assert.match(failures(run({ before: true, timers: [timer("b", "hidden", 1000)] })).join(), /median 1000 ms, expected at most 100 ms \(the timer flags\)/);
  assert.match(failures(run({ timers: [timer("a", "visible", 1000)] })).join(), /expected at most 100 ms \(a visible tab\)/);
  assert.match(failures(run({ timers: [timer("b", "hidden", null)] })).join(), /fewer than two ticks/);
  assert.match(failures(run({ timers: [timer("b", "hidden", 1000, { visibility: "visible" })] })).join(), /the page is visible, expected hidden/);
});

test("failures: animation frames in a hidden tab's timer window, or none in a visible tab's", () => {
  assert.deepEqual(failures(run({ timers: [timer("b", "hidden", 1000, { stats: stats(1000, 4) })] })), ["p1: tab b's timer (front: a): 4 animation frames in a hidden tab, expected 0"]);
  assert.deepEqual(failures(run({ timers: [timer("a", "visible", 50, { stats: stats(50, 0) })] })), ["p1: tab a's timer (front: a): no animation frame in a visible tab"]);
});

test("failures: in the 500 ms after a drive the driven tab must be hidden again with no frames, and the front tab visible with frames", () => {
  assert.deepEqual(failures(run({ idles: [idle("b", "hidden", { visibility: "hidden, visible" })] })),
    ["p2: after the drive of tab b, tab b was hidden, visible, expected hidden (front: a)"]);
  assert.deepEqual(failures(run({ idles: [idle("b", "hidden", { frames: 3 })] })), ["p2: after the drive of tab b, hidden tab b drew 3 animation frames, expected 0"]);
  assert.deepEqual(failures(run({ idles: [idle("a", "visible", { frames: 0 })] })), ["p2: after the drive of tab b, visible tab a drew no animation frame"]);
  assert.deepEqual(failures(run({ idles: [idle("a", "visible", { visibility: "hidden" })] })), ["p2: after the drive of tab b, tab a was hidden, expected visible (front: a)"]);
});
