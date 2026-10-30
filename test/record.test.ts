// `record` and `shot --size`: the step script, the plan checks, the MP4 and its provenance JSON, the
// cursor motion, the cleanup, and the safety rules, through the real CLI against the fake Chrome. The
// fake screencasts real JPEG frames and, like Google Sheets, refuses innerHTML, <style> and inline
// style attributes, so a passing run proves the overlay uses DOM calls only. Tests that encode need
// ffmpeg (with libx264) on PATH and are skipped without it.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveOptions } from "../src/options.ts";
import { stopProxy } from "../src/proxy.ts";
import { findFfmpeg, fittsMs, parseKey, parseSize, parseSteps, planMove, planRecording, pointAt, seededRandom } from "../src/record.ts";
import { FakeChrome, type FakePage } from "./fake-chrome.ts";
import { cli, consumer, fixtureServer, flags, site, type CliRun, type Consumer, type Fixture } from "./helpers.ts";

const FFMPEG = (() => { try { return findFfmpeg(); } catch { return undefined; } })();
const FFPROBE = FFMPEG && existsSync(join(dirname(FFMPEG), "ffprobe")) ? join(dirname(FFMPEG), "ffprobe") : undefined;
const needsFfmpeg = { skip: FFMPEG && FFPROBE ? false : "no ffmpeg (with libx264) and ffprobe on PATH" };

let fx: Fixture, fake: FakeChrome, c: Consumer;

before(async () => {
  fx = await fixtureServer();
  fake = await FakeChrome.start(site(fx.base));
  c = consumer();
});

after(async () => {
  stopProxy(resolveOptions(c.options()));
  await fake?.close();
  await fx?.close();
  c?.remove();
});

async function run(args: string[], opts: { extra?: string[] } = {}): Promise<CliRun> {
  const r = await cli([...args, ...flags(c, fake.ws, opts.extra), "--json"]);
  assert.equal(r.stdout.trim().split("\n").length, 1, `one line on stdout: ${r.stdout} ${r.stderr}`);
  assert.ok(r.json && typeof r.json === "object", `JSON on stdout: ${r.stdout} ${r.stderr}`);
  return r;
}

function script(name: string, steps: unknown): string {
  const path = join(c.dir, name);
  writeFileSync(path, JSON.stringify(steps));
  return path;
}

async function openTab(name: string): Promise<FakePage> {
  const r = await run(["open", fx.base + "/", "--name", name]);
  assert.equal(r.json.ok, true, r.stdout);
  return fake.pages.get(r.json.tab.targetId)!;
}

function probe(path: string): Record<string, string> {
  const out = execFileSync(FFPROBE!, ["-v", "error", "-show_entries", "stream=codec_name,width,height,pix_fmt,r_frame_rate:format=duration", "-of", "default=noprint_wrappers=1", path], { encoding: "utf8" });
  return Object.fromEntries(out.trim().split("\n").map((l) => l.split("=")));
}

const methods = (page: FakePage) => fake.callsFor(page.targetId).map((x) => x.method);
const recordings = () => (existsSync(join(c.stateDir, "recordings")) ? readdirSync(join(c.stateDir, "recordings")) : []);

test("the step script is checked before anything runs: one action per step, known options, allowlisted goto, keys", () => {
  const vp = { width: 1920, height: 1080, scale: 1 };
  const ok = parseSteps([{ wait: 10 }, { click: "#b", duration: 300 }, { click: { x: 10, y: 20 } }, { type: "=SUM(1,2)", into: "#i", delay: 40 }, { press: "Shift+ArrowDown", repeat: 2 },
    { scroll: 300 }, { scroll: "#b" }, { highlight: { x: 1, y: 2, width: 3, height: 4 } }, { waitFor: "#later", text: "ready", timeoutMs: 1000 }, { eval: "1" },
    { goto: "https://docs.google.com/x" }], vp, ["docs.google.com"]);
  assert.equal(ok.length, 11);
  const bad: [unknown, RegExp][] = [
    [{}, /exactly one of/], [{ click: "#a", hover: "#b" }, /exactly one of/], [{ click: "#a", delay: 3 }, /"delay" is not an option of click/],
    [{ wait: -1 }, /wait must be a number of ms/], [{ click: { x: 5000, y: 1 } }, /outside the 1920x1080 viewport/], [{ press: "Hyper+A" }, /unknown modifier/],
    [{ press: "F13" }, /unknown key/], [{ press: "Enter", repeat: 0 }, /repeat is a whole number/], [{ highlight: { x: 1 } }, /highlight is a selector/],
    [{ waitFor: "" }, /waitFor is a CSS selector/], [{ type: 5 }, /type is the text/], [{ goto: "https://mail.google.com/" }, /mail\.google\.com is not on the allowlist/],
    [{ goto: "https://example.com/" }, /example\.com is not on the allowlist/],
  ];
  for (const [step, message] of bad) assert.throws(() => parseSteps([step], vp, ["docs.google.com"]), message, JSON.stringify(step));
  assert.throws(() => parseSteps({ steps: [] }, vp, []), /JSON array/);
  assert.throws(() => parseSteps([{ type: "hunter2-secret", delay: -1 }], vp, []), (e: Error) => e.message.includes('"type":"<14 characters>"') && !e.message.includes("hunter2"),
    "a message shows typed text only as its length");
  assert.deepEqual(parseSize("1280x720"), { width: 1280, height: 720 });
  assert.throws(() => parseSize("1280"), /WIDTHxHEIGHT/);
});

test("keys: chords keep their letter, Shift is implied only by a character, and macOS editing commands are named", () => {
  assert.deepEqual(parseKey("Meta+A"), { key: "a", code: "KeyA", keyCode: 65, text: undefined, modifiers: 4 });
  assert.deepEqual(parseKey("Shift+ArrowDown"), { key: "ArrowDown", code: "ArrowDown", keyCode: 40, text: undefined, modifiers: 8 });
  assert.deepEqual(parseKey("("), { key: "(", code: "Digit9", keyCode: 57, text: "(", modifiers: 8 });
  assert.deepEqual(parseKey("Enter"), { key: "Enter", code: "Enter", keyCode: 13, text: "\r", modifiers: 0 });
  assert.equal(parseKey("Control+c").text, undefined, "a chord types nothing");
});

test("the cursor path: ghost-cursor's curve, a minimum-jerk speed (slow, fast, slow), Fitts timing, the same path for the same seed", async () => {
  const from = { x: 100, y: 800 }, to = { x: 400, y: 700 };
  const legs = await planMove(from, to, 30, seededRandom(1));
  assert.equal(legs.length, 1);
  const ms = legs[0].ms;
  assert.ok(Math.abs(ms - fittsMs(Math.hypot(300, 100), 30)) < 1e-9 && ms >= 300 && ms <= 1000, `${ms} ms`);
  assert.deepEqual(pointAt(legs, 0), from);
  assert.deepEqual(pointAt(legs, ms), to);
  const step = (t: number) => { const a = pointAt(legs, t), b = pointAt(legs, t + 16); return Math.hypot(b.x - a.x, b.y - a.y); };
  assert.ok(step(ms / 2 - 8) > 3 * step(0) && step(ms / 2 - 8) > 3 * step(ms - 16), "slow start, fast middle, slow arrival");
  const straight = legs[0].points.every((p) => Math.abs((p.y - from.y) * 300 - (p.x - from.x) * -100) < 1e-6);
  assert.ok(!straight, "a curve, not a straight line");
  assert.deepEqual(await planMove(from, to, 30, seededRandom(9)), await planMove(from, to, 30, seededRandom(9)));
  const far = await planMove(from, { x: 1500, y: 100 }, 30, seededRandom(1));
  assert.equal(far.length, 2, "over 500 px: an overshoot, then a correction");
  assert.deepEqual(pointAt(far, far[0].ms + far[1].ms), { x: 1500, y: 100 });
  const fixed = await planMove(from, to, 30, seededRandom(1), 777);
  assert.ok(Math.abs(fixed.reduce((a, l) => a + l.ms, 0) - 777) < 1e-9, "a step's duration overrides the total");
  assert.deepEqual(await planMove(from, from, 30, seededRandom(1)), []);
});

test("planRecording: .mp4 only, even pixel sizes, the provenance never replaces a script, ffmpeg is required", () => {
  const steps = script("steps.json", [{ wait: 1 }]);
  assert.throws(() => planRecording({ out: join(c.dir, "clip.mov") }, []), /must end in \.mp4/);
  assert.throws(() => planRecording({ out: join(c.dir, "clip.mp4"), size: "1921x1080" }, []), /even whole numbers/);
  assert.throws(() => planRecording({ out: join(c.dir, "clip.mp4"), fps: 0 }, []), /--fps/);
  assert.throws(() => planRecording({ out: join(c.dir, "steps.mp4"), script: steps }, []), /must not replace the step script/);
  assert.throws(() => planRecording({ out: join(c.dir, "steps.mp4"), setup: steps }, []), /must not replace the setup script/);
  assert.throws(() => planRecording({ out: join(c.dir, "clip.mp4"), ffmpeg: "/nonexistent/ffmpeg" }, []), /cannot run ffmpeg at \/nonexistent\/ffmpeg/);
  assert.throws(() => planRecording({ out: join(c.dir, "clip.mp4"), ffmpeg: "ffmpeg" }, []), /--ffmpeg must be an absolute path/);
  assert.throws(() => findFfmpeg(undefined, "/nonexistent-a:/nonexistent-b"), /there is none on PATH/);
});

test("refused before the tab is touched: a missing ffmpeg, a script the provenance would overwrite, an off-list goto", async () => {
  const page = await openTab("early");
  const calls = fake.callsFor(page.targetId).length;
  let r = await run(["record", "early", "--out", join(c.dir, "x.mp4"), "--ffmpeg", "/nonexistent/ffmpeg"]);
  assert.equal(r.json.error.code, "usage");
  const s = script("clip.json", [{ wait: 1 }]);
  r = await run(["record", "early", "--out", join(c.dir, "clip.mp4"), "--script", s]);
  assert.equal(r.json.error.code, "usage");
  assert.match(r.json.error.message, /must not replace the step script/);
  r = await run(["record", "early", "--out", join(c.dir, "y.mp4"), "--script", script("away.json", [{ goto: "https://example.com/" }])]);
  assert.equal(r.json.error.code, "not_allowed");
  assert.equal(fake.callsFor(page.targetId).length, calls, "no CDP call reached the tab");
  await run(["close", "early"]);
});

test("record: an exact-size H.264 MP4, the steps acted on the page, event times, and the tab left as it was", needsFfmpeg, async () => {
  const page = await openTab("rec");
  const out = join(c.dir, "out", "clip.mp4");
  const steps = script("rec-steps.json", [
    { hover: "#b", duration: 200 }, { click: "#b" }, { type: "abc", into: "#i", delay: 10 }, { press: "Shift+ArrowDown", repeat: 2, delay: 20 },
    { highlight: "#b", duration: 150 }, { scroll: 120, duration: 100 }, { waitFor: "#later", text: "ready", timeoutMs: 3000 }, { wait: 100 },
  ]);
  const setup = script("rec-setup.json", [{ press: "Escape" }, { type: "off-camera", delay: 5 }]);
  const r = await run(["record", "rec", "--out", out, "--script", steps, "--setup", setup, "--size", "640x360", "--fps", "10", "--settle", "200", "--seed", "3"]);
  assert.equal(r.json.ok, true, r.stdout);
  assert.deepEqual(Object.keys(r.json).sort(), ["command", "events", "fps", "frames", "height", "maxFrameGapMs", "ok", "path", "provenance", "scale", "seconds",
    "steps", "tab", "videoHeight", "videoWidth", "warnings", "width"]);
  assert.deepEqual({ ...r.json, tab: undefined, events: undefined, frames: undefined, seconds: undefined, maxFrameGapMs: undefined }, {
    ok: true, command: "record", tab: undefined, path: out, provenance: join(c.dir, "out", "clip.json"), width: 640, height: 360, scale: 1, fps: 10,
    videoWidth: 640, videoHeight: 360, steps: 8, events: undefined, frames: undefined, seconds: undefined, maxFrameGapMs: undefined, warnings: [],
  });
  assert.ok(r.json.frames >= 10 && r.json.seconds > 0.5, `${r.json.frames} frames, ${r.json.seconds} s`);

  const v = probe(out);
  assert.deepEqual([v.codec_name, v.width, v.height, v.pix_fmt, v.r_frame_rate], ["h264", "640", "360", "yuv420p", "10/1"]);
  assert.ok(Math.abs(Number(v.duration) - r.json.seconds) <= 0.15, `the MP4 lasts as long as the run: ${v.duration} vs ${r.json.seconds}`);

  // The steps reached the page: a trusted click, key events with text, the chord, the wheel.
  assert.equal(page.title, "clicked");
  assert.equal(page.select("#i")[0].value, "abc");
  assert.deepEqual(page.keyEvents.filter((k) => k.type !== "keyUp").map((k) => k.key), ["Escape", ..."off-camera", "a", "b", "c", "ArrowDown", "ArrowDown"]);
  assert.ok(page.keyEvents.filter((k) => k.key === "ArrowDown").every((k) => k.modifiers === 8));
  assert.ok(Math.abs(page.wheel - 120) < 1e-6, `wheel ${page.wheel}`);
  assert.ok(page.animations >= 2, "the ripple and the ring animate");

  // The page and the window are as they were: no overlay, no emulated size, no screencast, no frames on disk.
  assert.deepEqual(page.appended, [], "the overlay is removed");
  assert.equal(page.metrics, undefined, "the device metrics override is cleared");
  const m = methods(page);
  assert.ok(m.indexOf("Page.bringToFront") < m.indexOf("Emulation.setDeviceMetricsOverride"));
  assert.ok(m.lastIndexOf("Page.stopScreencast") > m.indexOf("Page.startScreencast"));
  assert.ok(m.lastIndexOf("Emulation.clearDeviceMetricsOverride") > m.indexOf("Page.startScreencast"));
  const set = fake.callsFor(page.targetId).find((x) => x.method === "Emulation.setDeviceMetricsOverride")!;
  assert.deepEqual(set.params, { width: 640, height: 360, deviceScaleFactor: 1, mobile: false });
  assert.ok(fake.frames.acked >= fake.frames.sent - 1, `every frame acknowledged: ${fake.frames.acked}/${fake.frames.sent}`);
  assert.deepEqual(recordings(), [], "the frames are removed");

  // The provenance: facts only, the setup and the steps, event times on the MP4's clock.
  const prov = JSON.parse(readFileSync(join(c.dir, "out", "clip.json"), "utf8"));
  assert.equal(prov.service, "agent-browser");
  assert.equal("license" in prov, false);
  assert.deepEqual(prov.steps, JSON.parse(readFileSync(steps, "utf8")));
  assert.deepEqual(prov.setup, [{ press: "Escape" }, { type: "<10 characters>", delay: 5 }], "setup text is off camera: only its length is kept");
  assert.ok(!readFileSync(join(c.dir, "out", "clip.json"), "utf8").includes("off-camera"));
  assert.equal(statSync(join(c.dir, "out", "clip.json")).mode & 0o777, 0o600, "the provenance is private to this user");
  assert.equal(r.json.tab.url, fx.base + "/", "the tab's URL from the end of the run");
  const calls = fake.callsFor(page.targetId).map((x) => x.method);
  assert.ok(calls.lastIndexOf("Runtime.evaluate") < calls.lastIndexOf("Emulation.clearDeviceMetricsOverride"),
    "nothing runs in the tab after the cleanup (the encode can take minutes; the tab may have moved on)");
  for (const k of ["url", "finalUrl", "width", "height", "scale", "fps", "seed", "createdAt", "startedAt", "endedAt", "seconds", "frames", "events"]) assert.ok(k in prov, k);
  assert.equal(prov.seed, 3);
  const events = r.json.events;
  assert.deepEqual(prov.events, events);
  assert.deepEqual(events.map((e: any) => [e.step, e.kind]), [[1, "hover"], [2, "click"], [3, "type"], [4, "press"], [5, "highlight"], [6, "scroll"], [7, "waitFor"], [8, "wait"]]);
  let last = 0;
  for (const e of events) {
    assert.ok(e.start >= last - 0.001 && e.end >= e.start && e.end <= r.json.seconds + 0.05, JSON.stringify(e));
    last = e.end;
  }
  assert.ok(events[0].start >= 0.19, `the still pre-roll (--settle 200) comes first: ${events[0].start}`);
  assert.ok(events[1].press > events[1].start && events[1].press < events[1].end);
  assert.ok(events[2].first <= events[2].last && events[2].first > events[2].start);
  assert.equal(events[3].keys.length, 2);
  await run(["close", "rec"]);
});

test("record stops at once when the tab leaves the allowlist: nothing written, nothing run in the off-list page, the tab restored", needsFfmpeg, async () => {
  const page = await openTab("wander");
  const out = join(c.dir, "wander.mp4");
  const started = Date.now();
  // The fake page's #away link goes to https://elsewhere.invalid/.
  const r = await run(["record", "wander", "--out", out, "--script", script("wander-steps.json", [{ click: "#away", duration: 100 }, { wait: 20_000 }]), "--settle", "100"]);
  assert.equal(r.json.error.code, "not_allowed");
  assert.match(r.json.error.message, /elsewhere\.invalid, which is not on the allowlist; the recording stopped and nothing was written/);
  assert.ok(Date.now() - started < 10_000, "the 20 s wait ended at once");
  assert.equal(existsSync(out), false);
  assert.equal(existsSync(join(c.dir, "wander.json")), false);
  assert.deepEqual(recordings(), []);
  assert.equal(page.metrics, undefined, "the override is cleared");
  const m = methods(page);
  assert.ok(m.lastIndexOf("Page.stopScreencast") > m.indexOf("Page.startScreencast"));
  const navigated = fake.callsFor(page.targetId).findIndex((x) => x.method === "Input.dispatchMouseEvent" && x.params.type === "mouseReleased");
  assert.ok(!fake.callsFor(page.targetId).slice(navigated + 1).some((x) => x.method === "Runtime.evaluate"), "no page code ran after the navigation");
  fake.pages.delete(page.targetId);
});

test("a cleanup failure never hides the run's own error; after a good run it is a warning", needsFfmpeg, async () => {
  let page = await openTab("cleanup");
  fake.failOnce.set("Emulation.clearDeviceMetricsOverride", "Target closed");
  let r = await run(["record", "cleanup", "--out", join(c.dir, "c1.mp4"), "--script", script("c1-steps.json", [{ click: "#away", duration: 50 }, { wait: 5000 }]), "--settle", "50"]);
  assert.equal(r.json.error.code, "not_allowed", "the run's own error, not the cleanup's");
  assert.match(r.json.error.message, /not on the allowlist.*; cleanup also failed: clear the device metrics override: .*Target closed/);
  fake.pages.delete(page.targetId);

  page = await openTab("cleanup2");
  fake.failOnce.set("Emulation.clearDeviceMetricsOverride", "Target closed");
  r = await run(["record", "cleanup2", "--out", join(c.dir, "c2.mp4"), "--script", script("c2-steps.json", [{ wait: 200 }]), "--size", "320x240", "--settle", "50"]);
  assert.equal(r.json.ok, true, r.stdout);
  assert.equal(r.json.warnings.length, 1);
  assert.match(r.json.warnings[0], /^cleanup failed: clear the device metrics override: .*Target closed/);
  assert.match(r.stderr, /cleanup failed: clear the device metrics override/);
  assert.ok(existsSync(join(c.dir, "c2.mp4")));
  page.metrics = undefined;

  // A step that fails: its own error names the step (typed text only as its length), and the tab is restored.
  r = await run(["record", "cleanup2", "--out", join(c.dir, "c3.mp4"), "--script", script("c3-steps.json", [{ wait: 10 }, { type: "pa55word", into: "#missing" }]), "--settle", "0"]);
  assert.equal(r.json.error.code, "error");
  assert.equal(r.json.error.message, 'step 2 ({"type":"<8 characters>","into":"#missing"}): no element matches #missing');
  assert.ok(!r.stdout.includes("pa55word") && !r.stderr.includes("pa55word"));
  assert.equal(page.metrics, undefined);
  assert.deepEqual(page.appended, []);
  assert.equal(existsSync(join(c.dir, "c3.mp4")), false);
  await run(["close", "cleanup2"]);
});

test("record refuses a tab off the allowlist and never touches it", async () => {
  const mail = fake.addPage("https://mail.example.org/inbox");
  const r = await run(["record", mail.targetId.slice(0, 8), "--out", join(c.dir, "mail.mp4")]);
  assert.equal(r.json.error.code, "tab_not_found");
  assert.deepEqual(fake.callsFor(mail.targetId), []);
  fake.pages.delete(mail.targetId);
});

test("shot --size/--scale lays the page out at that size for the shot only; a failed restore is reported, never hidden", async () => {
  fake.failOnce.clear();
  const page = await openTab("sized");
  await run(["text", "sized"]);
  const png = join(c.dir, "sized.png");
  let r = await run(["shot", "sized", png, "--size", "800x600", "--scale", "2"]);
  assert.equal(r.json.ok, true, r.stdout);
  const set = fake.callsFor(page.targetId).filter((x) => x.method === "Emulation.setDeviceMetricsOverride").map((x) => x.params);
  assert.deepEqual(set, [{ width: 800, height: 600, deviceScaleFactor: 2, mobile: false }]);
  assert.equal(page.metrics, undefined);
  r = await run(["shot", "sized", png, "--scale", "1"]);
  assert.equal(r.json.ok, true, r.stdout);
  assert.deepEqual(fake.callsFor(page.targetId).filter((x) => x.method === "Emulation.setDeviceMetricsOverride").at(-1)!.params, { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  fake.failOnce.set("Emulation.clearDeviceMetricsOverride", "Target closed");
  r = await run(["shot", "sized", png, "--size", "640x480"]);
  assert.equal(r.json.error.code, "error");
  assert.match(r.json.error.message, /the screenshot was saved to .*sized\.png, but the tab keeps the emulated size: clear the device metrics override: .*Target closed/);
  r = await run(["shot", "sized", png, "--size", "640"]);
  assert.equal(r.json.error.code, "usage");
  await run(["close", "sized"]);
});
