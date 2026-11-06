// The macOS check of drive, record and one window per page (test/live/anti-detect/mac.ts, ab-v16.16): its argument
// guard, the analysis of the watcher's log (the front app, the Space, the window order, the real pointer), the pass
// rule, the summary, the dry run's stand-in watcher, and what the check and its watcher never do. The check itself
// starts an agent Chrome on the operator's screen, on macOS only, so it is not part of `npm test`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  agentWindowsOf, coveredFraction, FALLBACK_MS, ffmpegSearchPath, frontAt, frontTakes, gapProblem, giveBackRows, handover, HANDOVER_SLACK_MS, isOperatorWindow, joinVerdicts, macArgs, makeFallback,
  matchWindow, newAgentWindows, NO_GIVE_BACK_MS, noGiveBackStep, OPEN_TAKE_MS, orderOf, parseWatchLog, placement, fieldText, placementText, probeRecord, quitAgentChrome, readyText, realPointer, runStep,
  realPointerEvents, screenProblem, spaceChanges, START_MAX_AWAY_MS, stepAt, STOP_POLL_MS, stopReason, summary, swiftTools, USAGE, verdict, watchBackText, watcherProblems, windowsOf,
  type CgWin, type Hold, type MacResult, type Step, type Take, type WatchEvent,
} from "./live/anti-detect/mac-rules.ts";
import { parseWatchBack } from "./live/anti-detect/mac-watchback.ts";
import { startServer, type Rec } from "./live/anti-detect/probe.ts";
import { ROOT } from "./helpers.ts";

const DIR = join(ROOT, "test", "live", "anti-detect");
const BETA = "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta";
const CFT = "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const mac = { platform: "darwin", exists: (p: string) => [BETA, CFT, "/tmp/mac-watch", "/opt/homebrew/bin/ffmpeg"].includes(p), defaultChrome: BETA };
const linux = { platform: "linux", exists: (p: string) => ["/usr/bin/chromium", "/usr/bin/ffmpeg"].includes(p), defaultChrome: BETA };
const refused = (argv: string[], env = mac) => { const r = macArgs(argv, env); assert.equal(r.ok, false, argv.join(" ")); return (r as { message: string }).message; };
const options = (argv: string[], env = mac) => { const r = macArgs(argv, env); assert.ok(r.ok, r.ok ? "" : r.message); return r.options; };

test("the Mac check refuses without --on-my-screen, and runs only on macOS (the dry run only on Linux)", () => {
  assert.match(refused(["--out-dir", "/tmp/o"]), /--on-my-screen when the operator agrees/);
  assert.match(refused(["--on-my-screen", "--out-dir", "/tmp/o"], linux), /macOS only.*--dry-run/);
  assert.match(refused(["--dry-run", "--out-dir", "/tmp/o"]), /Linux only/);
  assert.match(refused(["--dry-run", "--on-my-screen", "--out-dir", "/tmp/o"], linux), /not both/);
  assert.match(refused(["--on-my-screen"]), /--out-dir is required/);
  assert.match(refused(["--on-my-screen", "--out-dir", "/tmp/o", "--bogus"]), /bogus/);
});

test("the Mac check takes agent-browser's agent Chrome by default, and only an app bundle's binary that is not Chrome for Testing", () => {
  const o = options(["--on-my-screen", "--out-dir", "/tmp/o"]);
  assert.equal(o.chromeBin, BETA);
  assert.equal(o.dryRun, false);
  assert.equal(o.look, 0);
  assert.deepEqual(o.skip, []);
  assert.match(refused(["--on-my-screen", "--out-dir", "/tmp/o", "--chrome-bin", "/usr/bin/chromium"]), /inside an app bundle/);
  assert.match(refused(["--on-my-screen", "--out-dir", "/tmp/o", "--chrome-bin", "Google Chrome"]), /absolute/);
  assert.match(refused(["--on-my-screen", "--out-dir", "/tmp/o", "--chrome-bin", CFT]), /Chrome for Testing/);
  assert.match(refused(["--on-my-screen", "--out-dir", "/tmp/o", "--chrome-bin", "/Applications/X.app/Contents/MacOS/X"]), /no such file/);
  assert.match(refused(["--on-my-screen", "--out-dir", "/tmp/o", "--watcher", "/nope"]), /--watcher: no such file/);
  assert.equal(options(["--on-my-screen", "--out-dir", "/tmp/o", "--watcher", "/tmp/mac-watch"]).watcher, "/tmp/mac-watch");
  assert.match(refused(["--on-my-screen", "--out-dir", "/tmp/o", "--display", "3"]), /for --dry-run/);
});

test("--look is 0 to 300 whole seconds, --skip names known parts, and the dry run takes a display and a Chromium", () => {
  assert.equal(options(["--on-my-screen", "--out-dir", "/tmp/o", "--look", "60"]).look, 60);
  for (const bad of ["301", "-1", "1.5", "x"]) assert.match(refused(["--on-my-screen", "--out-dir", "/tmp/o", `--look=${bad}`]), /--look/);
  assert.deepEqual(options(["--on-my-screen", "--out-dir", "/tmp/o", "--skip", "popups,record"]).skip, ["popups", "record"]);
  assert.match(refused(["--on-my-screen", "--out-dir", "/tmp/o", "--skip", "popups,space"]), /--skip takes record, popups, person/);
  const d = options(["--dry-run", "--out-dir", "/tmp/o"], linux);
  assert.deepEqual([d.dryRun, d.chromeBin, d.display], [true, "/usr/bin/chromium", 123]);
  assert.equal(options(["--dry-run", "--out-dir", "/tmp/o", "--display", "99"], linux).display, 99);
  assert.match(refused(["--dry-run", "--out-dir", "/tmp/o", "--display", "0"], linux), /--display/);
  assert.match(refused(["--dry-run", "--out-dir", "/tmp/o", "--chrome", "/nope"], linux), /no such file/);
  assert.equal(options(["--dry-run", "--out-dir", "/tmp/o", "--look", "5"], linux).look, 5);
  assert.match(refused(["--dry-run", "--out-dir", "/tmp/o", "--watcher", "/tmp/mac-watch"], linux), /for the Mac run/);
});

test("--part stable is the short second part (no --look in it), and --skip stable leaves it out", () => {
  const hand = ["--quiet-since=1793954298896", "--pointer=-1000,-1000.5"];
  assert.equal(options(["--on-my-screen", "--out-dir", "/tmp/o"]).part, undefined);
  assert.equal(options(["--on-my-screen", "--out-dir", "/tmp/o"]).handover, undefined);
  const o = options(["--on-my-screen", "--out-dir", "/tmp/o", "--part", "stable", ...hand]);
  assert.equal(o.part, "stable");
  assert.deepEqual(o.handover, { quietSince: 1793954298896, pointer: { x: -1000, y: -1000.5 } }, "the first part's handover: the time from which no watcher read the input, and the pointer's point");
  assert.equal(options(["--dry-run", "--out-dir", "/tmp/o", "--part", "stable", ...hand], linux).part, "stable");
  assert.match(refused(["--on-my-screen", "--out-dir", "/tmp/o", "--part", "stable"]), /--part stable needs --quiet-since and --pointer/, "the stable part never starts without the first part's handover");
  assert.match(refused(["--on-my-screen", "--out-dir", "/tmp/o", "--part", "stable", "--quiet-since=1793954298896"]), /--part stable needs --quiet-since and --pointer/);
  assert.match(refused(["--on-my-screen", "--out-dir", "/tmp/o", ...hand]), /--quiet-since and --pointer are for --part stable/);
  for (const bad of ["--quiet-since=12.5", "--quiet-since=0", "--quiet-since=x"]) assert.match(refused(["--on-my-screen", "--out-dir", "/tmp/o", "--part", "stable", bad, hand[1]]), /--quiet-since/, bad);
  for (const bad of ["--pointer=1", "--pointer=1,2,3", "--pointer=a,b", "--pointer=1,"]) assert.match(refused(["--on-my-screen", "--out-dir", "/tmp/o", "--part", "stable", hand[0], bad]), /--pointer/, bad);
  assert.match(refused(["--on-my-screen", "--out-dir", "/tmp/o", "--part", "beta"]), /--part takes stable, not "beta"/);
  assert.match(refused(["--on-my-screen", "--out-dir", "/tmp/o", "--part", "stable", ...hand, "--look", "60"]), /--look is for the first part/);
  assert.deepEqual(options(["--on-my-screen", "--out-dir", "/tmp/o", "--skip", "stable,record"]).skip, ["stable", "record"]);
  assert.match(USAGE, /--skip record,popups,person,stable/);
  assert.match(USAGE, /keep the front for up to 2 s with no give-back/);
  assert.match(USAGE, /Google Chrome \(stable\) is\s+installed/);
  assert.match(USAGE, /Do not touch the Mac until the summary prints/);
});

test("--ffmpeg takes an absolute path that exists, on the Mac and in the dry run", () => {
  assert.equal(options(["--on-my-screen", "--out-dir", "/tmp/o", "--ffmpeg", "/opt/homebrew/bin/ffmpeg"]).ffmpeg, "/opt/homebrew/bin/ffmpeg");
  assert.equal(options(["--on-my-screen", "--out-dir", "/tmp/o"]).ffmpeg, undefined);
  assert.equal(options(["--dry-run", "--out-dir", "/tmp/o", "--ffmpeg", "/usr/bin/ffmpeg"], linux).ffmpeg, "/usr/bin/ffmpeg");
  assert.match(refused(["--on-my-screen", "--out-dir", "/tmp/o", "--ffmpeg", "ffmpeg"]), /--ffmpeg must be an absolute path/);
  assert.match(refused(["--on-my-screen", "--out-dir", "/tmp/o", "--ffmpeg", "/usr/bin/ffmpeg"]), /--ffmpeg: no such file/);
});

test("ffmpegSearchPath: PATH first, then Homebrew's two folders, each once", () => {
  assert.equal(ffmpegSearchPath("/usr/bin:/bin"), "/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin");
  assert.equal(ffmpegSearchPath("/opt/homebrew/bin:/usr/bin"), "/opt/homebrew/bin:/usr/bin:/usr/local/bin");
  assert.equal(ffmpegSearchPath(undefined), "/opt/homebrew/bin:/usr/local/bin");
});

test("swiftTools: the swiftc and the macOS SDK of the developer folder that xcode-select names, so that swiftc never starts xcrun", () => {
  const clt = "/Library/Developer/CommandLineTools", xcode = "/Applications/Xcode.app/Contents/Developer";
  const has = (...paths: string[]) => (p: string) => paths.includes(p);
  assert.deepEqual(swiftTools(clt, has(`${clt}/usr/bin/swiftc`, `${clt}/SDKs/MacOSX.sdk`)), { swiftc: `${clt}/usr/bin/swiftc`, sdk: `${clt}/SDKs/MacOSX.sdk` });
  const xs = `${xcode}/Toolchains/XcodeDefault.xctoolchain/usr/bin/swiftc`, xsdk = `${xcode}/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk`;
  assert.deepEqual(swiftTools(xcode, has(xs, xsdk)), { swiftc: xs, sdk: xsdk });
  assert.deepEqual(swiftTools("", has(`${clt}/usr/bin/swiftc`, `${clt}/SDKs/MacOSX.sdk`)), { swiftc: `${clt}/usr/bin/swiftc`, sdk: `${clt}/SDKs/MacOSX.sdk` });
  assert.equal(swiftTools(clt, has(`${clt}/usr/bin/swiftc`)), undefined, "a swiftc with no SDK beside it would ask xcrun for one");
  assert.equal(swiftTools("", has()), undefined);
});

test("the watcher's log: one event per line; a broken line is bad unless it is the last one (a kill can cut it)", () => {
  const text = ['{"t":1,"ev":"ready"}', "noise", '{"t":2,"ev":"alive"}', '{"t":3}', '{"t":4,"ev":"alive"}', '{"t":5,"ev"'].join("\n");
  const r = parseWatchLog(text);
  assert.deepEqual(r.events.map((e) => e.t), [1, 2, 4]);
  assert.deepEqual(r.bad, [4]);
  assert.deepEqual(parseWatchLog('{"t":1,"ev":"ready"}\n{"t":2,"ev"\n').bad, []);
});

const steps: Step[] = [
  { phase: "start", name: "agent Chrome start", t0: 1000, t1: 3000, ok: true },
  { phase: "window", name: "open window WA", t0: 5000, t1: 5200, ok: true },
  { phase: "popup", name: "window.open() popup", t0: 9000, t1: 10_000, ok: true },
];
const OP = { pid: 500, name: "Terminal", agent: false };
const AG = { pid: 900, name: "Google Chrome Beta", agent: true };
/** The six HID readings of the watcher's ready line: seconds since the hardware's last event of each type. */
const HID = { keyDown: 4.2, flagsChanged: 30.5, leftMouseDown: 61.25, rightMouseDown: 900, otherMouseDown: 3600, scrollWheel: 75 };
const ready = (extra: Record<string, unknown> = {}): WatchEvent => ({ t: 500, ev: "ready", front: OP, pointer: [100, 200], space: 7, locked: false, asleep: false, onConsole: true, displays: [{ x: 0, y: 0, w: 1512, h: 982, main: true }], hid: HID, ...extra });
const front = (t: number, app: typeof OP) => ({ t, ev: "front", ...app });

test("stepAt names the step that runs at a time, or the one that just ended", () => {
  assert.equal(stepAt(steps, 2000), "start: agent Chrome start");
  assert.equal(stepAt(steps, 4000), "start: agent Chrome start (after it)");
  assert.equal(stepAt(steps, 4600), "between steps");
  assert.equal(stepAt(steps, 9500), "popup: window.open() popup");
});

test("frontTakes: each run of the front away from the operator's app, the step it began in, and whether it came back", () => {
  const evs: WatchEvent[] = [ready(), front(1500, AG), { t: 1510, ev: "ask" }, front(1600, OP), front(9100, AG), { t: 9110, ev: "ask" }, { t: 9360, ev: "ask" }, front(9500, OP),
    front(12_000, { pid: 77, name: "SecurityAgent", agent: false }), { t: 13_000, ev: "alive" }];
  const { operator, takes } = frontTakes(evs, steps);
  assert.deepEqual(operator, { pid: 500, name: "Terminal" });
  assert.equal(takes.length, 3);
  assert.deepEqual([takes[0].start, takes[0].ms, takes[0].agentOnly, takes[0].asks, takes[0].t1], [true, 100, true, 1, 1600]);
  assert.deepEqual([takes[1].start, takes[1].step, takes[1].ms, takes[1].asks], [false, "popup: window.open() popup", 400, 2]);
  assert.deepEqual([takes[2].t1, takes[2].ms, takes[2].agentOnly, takes[2].step], [null, 1000, false, "between steps"]);
  assert.match(takes[2].to[0], /SecurityAgent \(pid 77\)/);
  assert.deepEqual(frontAt(evs, 9200), { pid: 900, name: "Google Chrome Beta" });
  assert.deepEqual(frontAt(evs, 600), { pid: 500, name: "Terminal" });
  assert.deepEqual(frontTakes([ready({ front: { pid: 0, name: "?" } })], steps), { operator: null, takes: [] });
});

test("the pass rule: the start may take the front by agent-browser's give-back rule; after it no take and no Space change", () => {
  const take = (o: Partial<ReturnType<typeof frontTakes>["takes"][number]>) => ({ t0: 1500, t1: 1600, ms: 100, to: ["Google Chrome Beta (pid 900, the agent Chrome)"], agentOnly: true, asks: 1, step: "start: agent Chrome start", start: true, ...o });
  assert.deepEqual(verdict({ takes: [take({})], spaces: [], watcher: [], missing: [] }), { ok: true, problems: [], popupOnly: false });
  assert.equal(verdict({ takes: [], spaces: [], watcher: [], missing: [] }).ok, true);
  const slow = verdict({ takes: [take({ ms: START_MAX_AWAY_MS + 1 })], spaces: [], watcher: [], missing: [] });
  assert.equal(slow.ok, false);
  assert.match(slow.problems[0], /the start took the front and broke the give-back rule/);
  assert.match(verdict({ takes: [take({ t1: null })], spaces: [], watcher: [], missing: [] }).problems[0], /did not come back/);
  assert.match(verdict({ takes: [take({ agentOnly: false })], spaces: [], watcher: [], missing: [] }).problems[0], /broke the give-back rule/);
  const later = verdict({ takes: [take({ start: false, step: "popup: window.open() popup", ms: 40 })], spaces: [], watcher: [], missing: [] });
  assert.match(later.problems[0], /a step took the operator's front: popup: window.open\(\) popup: the front went to .* for 40 ms/);
  assert.match(verdict({ takes: [], spaces: [{ t: 5100, via: "news", space: 8, step: "window: open window WA" }], watcher: [], missing: [] }).problems[0], /the Space changed \(news\) in window: open window WA/);
  const other = verdict({ takes: [], spaces: [], watcher: ["the screen was locked during the run"], missing: ["popup: x"], aborted: "the pointer moved", error: "boom" });
  assert.deepEqual(other.problems, ["the screen was locked during the run", "the check stopped early: the pointer moved", "the check failed: boom", "not run: popup: x"]);
  assert.equal(other.popupOnly, false);
});

test("the pass rule names a run whose only problems are popup takes: an expected result of the Mac design", () => {
  const take = (step: string, start = false) => ({ t0: 1, t1: 2, ms: 60, to: ["Google Chrome Beta (pid 900, the agent Chrome)"], agentOnly: true, asks: 1, step, start });
  const only = verdict({ takes: [take("start: agent Chrome start", true), take("popup: a link with target=_blank"), take("popup: close PA (after it)")], spaces: [], watcher: [], missing: [] });
  assert.deepEqual([only.ok, only.problems.length, only.popupOnly], [false, 2, true]);
  assert.equal(verdict({ takes: [take("popup: x"), take("window: WA: click")], spaces: [], watcher: [], missing: [] }).popupOnly, false);
  assert.equal(verdict({ takes: [take("popup: x")], spaces: [], watcher: [], missing: [], quit: "the agent Chrome did not quit" }).popupOnly, false);
  assert.equal(verdict({ takes: [], spaces: [], watcher: [], missing: [] }).popupOnly, false);
  const q = verdict({ takes: [], spaces: [], watcher: [], missing: [], quit: "the agent Chrome did not quit (SIGKILL to pid 900)" });
  assert.deepEqual([q.ok, q.problems], [false, ["the agent Chrome did not quit (SIGKILL to pid 900)"]]);
});

test("stopReason: the stop rules during the measurement, and none after its end (the look, the end)", () => {
  const o = { t0: 0, limitMs: 540_000 };
  const live = (extra: WatchEvent[] = []) => [ready(), { t: 4500, ev: "alive", locked: false, asleep: false, onConsole: true }, ...extra];
  assert.equal(stopReason(live(), steps, 5000, o), undefined);
  assert.match(stopReason(live([{ t: 4600, ev: "pointer", x: 1, y: 2 }]), steps, 5000, o) ?? "", /the pointer moved: a person uses the Mac/);
  assert.equal(stopReason(live([{ t: 4600, ev: "pointer", x: 1, y: 2 }]), steps, 5000, { ...o, measureEnd: 4000 }), undefined, "after the measurement a pointer move is the operator's look");
  for (const kind of ["keyDown", "leftMouseDown", "scrollWheel"])
    assert.match(stopReason(live([{ t: 4600, ev: "input", kind, agoMs: 20 }]), steps, 5000, o) ?? "", new RegExp(`a person used the keyboard or the mouse \\(${kind}\\): a person uses the Mac`));
  assert.match(stopReason(live([{ t: 4600, ev: "alive", locked: true }]), steps, 4700, o) ?? "", /the screen locked/);
  assert.match(stopReason(live([{ t: 4600, ev: "alive", asleep: true }]), steps, 4700, o) ?? "", /the display slept/);
  assert.match(stopReason(live([{ t: 4600, ev: "alive", onConsole: false }]), steps, 4700, o) ?? "", /another user's session/);
  assert.match(stopReason(live([{ t: 4600, ev: "space", via: "news", space: 2 }]), steps, 4700, o) ?? "", /the Space changed/);
  assert.match(stopReason(live([front(4000, AG)]), steps, 5600, o) ?? "", /the front app did not come back/);
  assert.equal(stopReason(live([front(4000, AG)]), steps, 5400, o), undefined, "1.5 s for the give-back");
  assert.equal(stopReason(live([front(4000, AG), front(4100, OP)]), steps, 4700, o), undefined, "a take that came back does not stop the run (the pass rule counts it)");
  assert.match(stopReason(live([{ t: 4600, ev: "end", why: "limit" }]), steps, 4700, o) ?? "", /the watcher ended \(limit\)/);
  assert.match(stopReason(live(), steps, 8000, o) ?? "", /the watcher logged nothing for 3 s/);
  assert.match(stopReason(live([{ t: 600_000, ev: "alive" }]), steps, 600_001, o) ?? "", /time limit/);
});

test("stopReason: a take that begins in the time with no give-back may stay open until OPEN_TAKE_MS after that time, no longer; other takes keep the 1.5 s rule", () => {
  const o = { t0: 0, limitMs: 540_000 };
  const hold = { from: 4000, until: 4000 + NO_GIVE_BACK_MS };
  assert.equal(NO_GIVE_BACK_MS, 2000);
  const live = (extra: WatchEvent[]) => [ready(), ...extra, { t: 7000, ev: "alive", locked: false, asleep: false, onConsole: true }];
  const held = live([front(4100, AG)]);
  assert.match(stopReason(held, steps, 5700, o) ?? "", /did not come back/, "without the hold: 1.5 s");
  assert.equal(stopReason(held, steps, 5700, { ...o, holds: [hold] }), undefined, "in the hold");
  assert.equal(stopReason(held, steps, hold.until + OPEN_TAKE_MS, { ...o, holds: [hold] }), undefined, "until OPEN_TAKE_MS after the hold's end");
  assert.match(stopReason(held, steps, hold.until + OPEN_TAKE_MS + 1, { ...o, holds: [hold] }) ?? "", /did not come back/, "then it stops");
  const later = live([front(6500, AG)]);
  assert.match(stopReason(later, steps, 8001, { ...o, holds: [hold] }) ?? "", /did not come back/, "a take that begins after the hold has the 1.5 s rule");
  const before = live([front(3900, AG)]);
  assert.match(stopReason(before, steps, 5401, { ...o, holds: [hold] }) ?? "", /did not come back/, "and one that began before it");
});

test("stopReason: in the time with no give-back, a key, a click, a scroll or a pointer move still stops the check at once", () => {
  const o = { t0: 0, limitMs: 540_000, holds: [{ from: 4000, until: 4000 + NO_GIVE_BACK_MS }] };
  const live = (extra: WatchEvent[]) => [ready(), front(4100, AG), ...extra, { t: 4800, ev: "alive", locked: false, asleep: false, onConsole: true }];
  assert.equal(stopReason(live([]), steps, 4900, o), undefined, "the take alone does not stop the check in the hold");
  for (const kind of ["keyDown", "flagsChanged", "leftMouseDown", "scrollWheel"])
    assert.match(stopReason(live([{ t: 4500, ev: "input", kind, agoMs: 1 }]), steps, 4501, o) ?? "", new RegExp(`a person used the keyboard or the mouse \\(${kind}\\)`), kind);
  assert.match(stopReason(live([{ t: 4500, ev: "pointer", x: 1, y: 2 }]), steps, 4501, o) ?? "", /the pointer moved/);
  assert.match(stopReason(live([{ t: 4500, ev: "alive", locked: true }]), steps, 4501, o) ?? "", /the screen locked/);
  assert.match(stopReason(live([{ t: 4500, ev: "space", via: "news", space: 2 }]), steps, 4501, o) ?? "", /the Space changed/);
});

test("noGiveBackStep: the check's watcher only logs from the click on, a snap at 1 s, and it gives the front back at exactly NO_GIVE_BACK_MS; at a stop it does not arm again", async () => {
  const run = async (o: { openMs?: number; stopAt?: number; fails?: boolean } = {}) => {
    let clock = 10_000;
    const tells: [string, number][] = [], holds: Hold[] = [], snaps: number[] = [];
    const sleep = async (ms: number) => { clock += ms; };
    const r = await noGiveBackStep({
      now: () => clock, pause: sleep, tell: (cmd) => tells.push([cmd, clock - 10_000]), aborted: () => o.stopAt !== undefined && clock - 10_000 >= o.stopAt, holds,
      open: async () => { await sleep(o.openMs ?? 300); if (o.fails) throw new Error("no popup"); }, snap: async () => { snaps.push(clock - 10_000); },
    }).then(() => "ok", (e: Error) => e.message);
    return { r, tells, holds, snaps };
  };
  const a = await run();
  assert.deepEqual(a.tells, [["disarm", 0], ["arm", NO_GIVE_BACK_MS]], "the give-back is off from the click, and on again at exactly the end of the time with no give-back");
  assert.deepEqual(a.holds, [{ from: 10_000, until: 10_000 + NO_GIVE_BACK_MS }], "the hold is recorded before the give-back stops (the stop rules read it)");
  assert.deepEqual(a.snaps, [1000]);
  assert.equal(a.r, "ok");
  const slow = await run({ openMs: 2600 });
  assert.deepEqual(slow.tells, [["disarm", 0], ["arm", 2600]], "a popup that loads after the 2 s: the give-back is on again at once, never later");
  assert.deepEqual(slow.snaps, [2600]);
  const stopped = await run({ stopAt: 500, openMs: 600 });
  assert.deepEqual(stopped.tells, [["disarm", 0]], "at a stop the check gave the front back itself (checkHarm); the step never arms the watcher again");
  const failed = await run({ fails: true });
  assert.deepEqual([failed.r, failed.tells], ["no popup", [["disarm", 0], ["arm", 300]]], "a failed click or load ends the time with no give-back at once");
});

test("makeFallback: while the prototype runs, a take of the agent Chrome that is still open after FALLBACK_MS arms the check's watcher, and the front's return disarms it", () => {
  const run = (lines: { at: number; e?: WatchEvent; active?: boolean }[], o: { agentInFront?: (t: number) => boolean } = {}) => {
    let clock = 0, active = true;
    const timers: { at: number; fn: () => void; id: number }[] = [], log: string[] = [];
    let n = 0;
    const fb = makeFallback({
      active: () => active, frontIsAgent: () => o.agentInFront ? o.agentInFront(clock) : true,
      arm: () => log.push(`arm@${clock}`), disarm: () => log.push(`disarm@${clock}`),
      setTimer: (fn, ms) => { const id = ++n; timers.push({ at: clock + ms, fn, id }); return id; }, clearTimer: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    });
    for (const l of lines) {
      for (let t = timers.filter((x) => x.at <= l.at).sort((a, b) => a.at - b.at)[0]; t; t = timers.filter((x) => x.at <= l.at).sort((a, b) => a.at - b.at)[0]) { timers.splice(timers.indexOf(t), 1); clock = t.at; t.fn(); }
      clock = l.at;
      if (l.active !== undefined) active = l.active;
      if (l.e) fb.line(l.e);
    }
    return { log, armed: fb.armed, timers: timers.length };
  };
  const take = (t: number) => front(t, AG), back = (t: number) => front(t, OP);
  assert.deepEqual(run([{ at: 0, e: take(0) }, { at: 100, e: back(100) }, { at: 5000 }]).log, [], "a take that the prototype gave back: nothing");
  assert.deepEqual(run([{ at: 0, e: take(0) }, { at: FALLBACK_MS + 400, e: back(FALLBACK_MS + 400) }]).log, [`arm@${FALLBACK_MS}`, `disarm@${FALLBACK_MS + 400}`], "armed at FALLBACK_MS, disarmed when the front is back");
  assert.deepEqual(run([{ at: 0, e: back(0) }, { at: 5000 }]).log, [], "a front change to another app never arms it");
  assert.deepEqual(run([{ at: 0, e: front(0, { pid: 77, name: "SecurityAgent", agent: false }) }, { at: 5000 }]).log, []);
  assert.deepEqual(run([{ at: 0, e: take(0) }, { at: 5000 }], { agentInFront: () => false }).log, [], "at the timer the agent Chrome no longer has the front: no arm");
  assert.deepEqual(run([{ at: 0, e: take(0) }, { at: 300, active: false }, { at: 5000 }]).log, [], "the prototype ended or the check stopped: no arm");
  assert.deepEqual(run([{ at: 0, e: take(0), active: false }, { at: 5000 }]).log, [], "not active: a take starts no timer");
  assert.deepEqual(run([{ at: 0, e: take(0) }, { at: 300, e: take(300) }, { at: FALLBACK_MS + 100 }]).log, [`arm@${FALLBACK_MS}`], "one timer for one take, from its first line");
  assert.deepEqual(run([{ at: 0, e: { t: 0, ev: "alive" } }, { at: 5000 }]).log, [], "other lines change nothing");
  const reset = makeFallback({ active: () => true, frontIsAgent: () => true, arm: () => {}, disarm: () => {}, setTimer: (fn) => { fn(); return 1; }, clearTimer: () => {} });
  reset.line(take(0));
  assert.equal(reset.armed, true);
  reset.reset();
  assert.equal(reset.armed, false, "reset: the prototype ended, the check's watcher stays armed and the fallback forgets it");
});

test("handover: the first part hands the stable part the time from which no watcher read the input and the pointer's point, or why the stable part must not start", () => {
  const evs: WatchEvent[] = [ready(), { t: 9000, ev: "alive" }, { t: 9400, ev: "end", why: "quit" }];
  assert.deepEqual(handover(evs, 9000), { ok: true, handover: { quietSince: 9400 - HANDOVER_SLACK_MS, pointer: { x: 100, y: 200 } } });
  assert.ok(HANDOVER_SLACK_MS >= 100, "the watcher reads the input every 100 ms: its last look can be up to 100 ms before its last line");
  const key = handover([...evs, { t: 9200, ev: "input", kind: "keyDown", agoMs: 3 }], 9000);
  assert.deepEqual(key, { ok: false, why: "a person used the Mac (keyDown) after the first part's measurement, before the stable part" });
  assert.match((handover([...evs, { t: 9300, ev: "pointer", x: 1, y: 2 }], 9000) as { why: string }).why, /a person used the Mac \(a pointer move\)/);
  assert.equal(handover([...evs, { t: 8000, ev: "pointer", x: 1, y: 2 }], 9000).ok, true, "a move before the measurement's end is the first part's own stop");
  assert.match((handover([ready({ pointer: undefined }), { t: 9400, ev: "end", why: "quit" }], 9000) as { why: string }).why, /no pointer point/);
});

test("gapProblem: the stable part refuses before its Chrome starts when a HID reading or the pointer shows a person in the gap between the two parts", () => {
  const h = { quietSince: 10_000, pointer: { x: 100, y: 200 } };
  const at = (t: number, extra: Record<string, unknown> = {}) => ready({ t, ...extra });
  assert.equal(gapProblem(at(10_800), h), null, "HID readings of 4 s and more, the pointer where it was");
  const key = gapProblem(at(10_800, { hid: { ...HID, keyDown: 0.5 } }), h) ?? "";
  assert.match(key, /the HID reading of keyDown is 0\.5 s, shorter than the 0\.8 s since the first part's watcher last read the input: a person used the Mac between the two parts/);
  for (const name of ["flagsChanged", "leftMouseDown", "rightMouseDown", "otherMouseDown", "scrollWheel"])
    assert.match(gapProblem(at(10_800, { hid: { ...HID, [name]: 0.79 } }), h) ?? "", new RegExp(`the HID reading of ${name} is 0\\.79 s`), name);
  assert.equal(gapProblem(at(10_800, { hid: { ...HID, keyDown: 0.81 } }), h), null, "an event before the first part's last look: the first part saw it (and did not start this part)");
  assert.match(gapProblem(at(10_800, { pointer: [101, 200] }), h) ?? "", /the pointer moved between the two parts \(from 100,200 to 101,200\)/);
  assert.equal(gapProblem(at(10_800, { pointer: [100.4, 200.4] }), h), null, "less than a point, as the watcher's own rule");
  assert.match(gapProblem(at(10_800, { pointer: undefined }), h) ?? "", /no pointer/);
  assert.match(gapProblem(at(10_800, { hid: { ...HID, scrollWheel: undefined } }), h) ?? "", /the HID reading of scrollWheel is none/);
});

test("runStep: a stop rule ends the running step at once (the rules are read every 100 to 250 ms), and the step's own end or time limit else", async () => {
  assert.ok(STOP_POLL_MS >= 100 && STOP_POLL_MS <= 250, `STOP_POLL_MS ${STOP_POLL_MS}`);
  let why: string | undefined;
  const fire = setTimeout(() => { why = "a person used the keyboard or the mouse (keyDown)"; }, 150);
  const t0 = Date.now();
  const r = await runStep(() => new Promise<never>(() => {}), { limitMs: 20_000, stopped: () => why });
  const ms = Date.now() - t0;
  clearTimeout(fire);
  assert.ok(ms >= 140 && ms < 150 + STOP_POLL_MS + 60, `the step ended ${ms} ms after its start (the stop came at 150 ms)`);
  assert.deepEqual([r.ok, r.stopped], [false, "a person used the keyboard or the mouse (keyDown)"]);
  assert.match(r.error ?? "", /^stopped: a person used the keyboard/);
  const early = Date.now();
  const before = await runStep(async () => { await new Promise((x) => setTimeout(x, 2000)); return 1; }, { limitMs: 20_000, stopped: () => "the screen locked" });
  assert.ok(Date.now() - early < STOP_POLL_MS + 60, "a stop before the step ends it at once");
  assert.deepEqual([before.ok, before.stopped, before.value], [false, "the screen locked", undefined]);
  assert.deepEqual(await runStep(async () => 7, { limitMs: 1000, stopped: () => undefined }), { ok: true, value: 7 });
  const limit = await runStep(() => new Promise<never>(() => {}), { limitMs: 120, stopped: () => undefined });
  assert.deepEqual([limit.ok, limit.error], [false, "no end in 0.12 s"]);
  const fails = await runStep(async () => { throw new Error("boom\nmore"); }, { limitMs: 1000, stopped: () => undefined });
  assert.deepEqual([fails.ok, fails.error], [false, "boom"]);
  // A wake (the check's stop promise, settled at each stop of a watcher line) ends the step at once, before the next poll.
  let woke: string | undefined, wake!: () => void;
  const woken = new Promise<void>((x) => { wake = x; });
  const fire2 = setTimeout(() => { woke = "a person used the keyboard or the mouse (keyDown)"; wake(); }, 150);
  const w0 = Date.now();
  const fast = await runStep(() => new Promise<never>(() => {}), { limitMs: 20_000, stopped: () => woke, wake: woken, pollMs: 10_000 });
  clearTimeout(fire2);
  assert.ok(Date.now() - w0 < 150 + 40, `the wake ended the step ${Date.now() - w0} ms after its start (the stop came at 150 ms)`);
  assert.equal(fast.stopped, "a person used the keyboard or the mouse (keyDown)");
  const own = await runStep(async () => { await new Promise((x) => setTimeout(x, 200)); return "done"; }, { limitMs: 1000, stopped: () => "the screen locked", atOnce: false });
  assert.deepEqual([own.ok, own.value, own.stopped], [true, "done", undefined], "atOnce false (the start): the step finishes its work, so that the check knows its Chrome's pid");
});

test("probeRecord: the probe's log keeps no key values (key, code, keyCode, an input's text), only event types and counts", async () => {
  const keydown = { t: 1, tab: "WA", ev: "in", type: "keydown", trusted: true, id: "f", key: "s", code: "KeyS", kc: 83, rep: false, vis: "visible", focus: true };
  const typed = { t: 2, tab: "WA", ev: "in", type: "input", trusted: true, id: "f", it: "insertText", data: "s" };
  const moves = { t: 3, tab: "WA", ev: "moves", list: [{ type: "mousemove", cx: 1, cy: 2, key: "x" }] };
  assert.deepEqual(probeRecord(keydown as Rec), { t: 1, tab: "WA", ev: "in", type: "keydown", trusted: true, id: "f", rep: false, vis: "visible", focus: true });
  assert.deepEqual(probeRecord(typed as Rec), { t: 2, tab: "WA", ev: "in", type: "input", trusted: true, id: "f", it: "insertText" });
  assert.deepEqual(probeRecord(moves as unknown as Rec), { t: 3, tab: "WA", ev: "moves", list: [{ type: "mousemove", cx: 1, cy: 2 }] });
  assert.deepEqual(probeRecord({ t: 4, tab: "WA", ev: "load", iw: 800 } as Rec), { t: 4, tab: "WA", ev: "load", iw: 800 });
  assert.deepEqual(fieldText("hello", "hellokeys", "keys"), { charsBefore: 5, chars: 9, theCheckKeys: true });
  assert.deepEqual(fieldText("hello", "hellokesecret", "keys"), { charsBefore: 5, chars: 13, theCheckKeys: false });
  assert.deepEqual(fieldText(undefined, undefined, "keys"), { charsBefore: 0, chars: 0, theCheckKeys: false });
  // The log server keeps only what probeRecord gives (mac.ts writes that log to results.json).
  const log: Rec[] = [];
  const { server, port } = await startServer(log, { record: probeRecord });
  try {
    for (const r of [keydown, typed]) await fetch(`http://127.0.0.1:${port}/log`, { method: "POST", body: JSON.stringify(r) });
  } finally { server.close(); }
  assert.equal(log.length, 2);
  assert.doesNotMatch(JSON.stringify(log), /"(key|code|kc|data)":/);
  assert.deepEqual(log.map((r) => r.type), ["keydown", "input"]);
});

test("spaceChanges lists each Space news after the watcher got ready, with its step", () => {
  const evs: WatchEvent[] = [{ t: 100, ev: "space", via: "news", space: 3 }, ready(), { t: 5100, ev: "space", via: "id", space: 9 }];
  assert.deepEqual(spaceChanges(evs, steps), [{ t: 5100, via: "id", space: 9, step: "window: open window WA" }]);
});

test("watcherProblems: a silence, an early end, a bad line, a locked or sleeping screen, another session, a pointer move", () => {
  const alive = (t: number, extra: Record<string, unknown> = {}) => ({ t, ev: "alive", locked: false, asleep: false, onConsole: true, ...extra });
  const ok: WatchEvent[] = [ready(), ...[1500, 2500, 3500].map((t) => alive(t))];
  assert.deepEqual(watcherProblems(ok, [], 500, 4000), []);
  assert.match(watcherProblems(ok, [], 500, 7000)[0], /logged nothing for 3\.5 s/);
  assert.deepEqual(watcherProblems([], [], 0, 1), ["the watcher never got ready"]);
  const all = watcherProblems([ready({ front: { pid: 0 } }), alive(1500, { locked: true, asleep: true, onConsole: false }), { t: 2000, ev: "pointer", x: 1, y: 2 }, { t: 2400, ev: "end", why: "limit" }], [7], 500, 2500);
  assert.equal(all.length, 7);
  assert.match(all.join("\n"), /no front app|could not see the front app/);
  assert.match(all.join("\n"), /ended \(limit\)/);
  assert.match(all.join("\n"), /line 7 is not an event/);
  assert.match(all.join("\n"), /locked/);
  assert.match(all.join("\n"), /slept/);
  assert.match(all.join("\n"), /not on the console/);
  assert.match(all.join("\n"), /the pointer moved \(1 times\): a person used the Mac/);
  assert.match(watcherProblems([ready(), alive(1500), { t: 1600, ev: "input", kind: "keyDown" }], [], 500, 2000).join("\n"), /a person used the keyboard or the mouse \(keyDown\): a person used the Mac/);
});

const win = (pid: number, n: number, x: number, y: number, w: number, h: number, a = 100): number[] => [pid, n, x, y, w, h, a];
const windowsLine = (list: number[][], extra: Record<string, unknown> = {}): WatchEvent => ({ t: 600, ev: "windows", why: "change", list, owners: { 500: "Terminal", 600: "Mail", 900: "Google Chrome Beta", 1: "Dock" }, ...extra });

test("screenProblem refuses a locked screen, no front app, a sleeping display, another session and a full-screen front app", () => {
  assert.equal(screenProblem([ready(), windowsLine([win(500, 10, 0, 33, 800, 600)])]), null);
  assert.match(screenProblem([ready({ locked: true })]) ?? "", /locked/);
  assert.match(screenProblem([ready({ asleep: true })]) ?? "", /sleeps/);
  assert.match(screenProblem([ready({ onConsole: false })]) ?? "", /console/);
  assert.match(screenProblem([ready({ front: { pid: 0 } })]) ?? "", /no front app/);
  assert.match(screenProblem([ready(), windowsLine([win(500, 10, 0, 0, 1512, 982)])]) ?? "", /full screen/);
  assert.match(screenProblem([]) ?? "", /never got ready/);
});

test("screenProblem refuses before the Chrome start: a HID reading of 0 or less or none, and a person's input or a pointer move after the watcher's start", () => {
  assert.equal(screenProblem([ready(), windowsLine([win(500, 10, 0, 33, 800, 600)])]), null);
  for (const [name, bad] of [["keyDown", 0], ["scrollWheel", -1], ["leftMouseDown", null], ["otherMouseDown", Number.NaN]] as const)
    assert.match(screenProblem([ready({ hid: { ...HID, [name]: bad } })]) ?? "", new RegExp(`the HID reading of ${name} is .*0 or less.*quit apps that post keyboard or mouse events`));
  const { flagsChanged: _, ...five } = HID;
  assert.match(screenProblem([ready({ hid: five })]) ?? "", /the HID reading of flagsChanged is none/);
  assert.match(screenProblem([ready({ hid: undefined })]) ?? "", /the watcher gave no HID readings/);
  assert.match(screenProblem([ready(), { t: 700, ev: "input", kind: "keyDown", agoMs: 3 }]) ?? "", /the keyboard or the mouse \(keyDown\) after the watcher's start.*remote-desktop apps, Karabiner, a mouse jiggler, Universal Control/);
  assert.match(screenProblem([ready(), { t: 700, ev: "pointer", x: 1, y: 2 }]) ?? "", /the pointer moved after the watcher's start/);
  assert.equal(screenProblem([{ t: 400, ev: "pointer", x: 1, y: 2 }, ready()]), null, "a move before the watcher's start is not counted");
});

test("readyText: the ready line names the six HID readings and the apps that stop the check", () => {
  const text = readyText(ready());
  for (const [name, s] of Object.entries(HID)) assert.ok(text.includes(`${name} ${s} s`), name);
  assert.match(text, /Terminal \(pid 500\)/);
  assert.match(text, /remote-desktop apps, Karabiner, a mouse jiggler, Universal Control/);
});

test("placement: where an agent window is against the operator's windows, by the CGWindowList order (front to back)", () => {
  const list = windowsOf(windowsLine([win(1, 5, 0, 0, 1512, 70), win(900, 40, 0, 0, 400, 600), win(500, 10, 0, 0, 800, 600), win(600, 11, 900, 33, 500, 500), win(900, 41, 200, 200, 600, 400)]));
  assert.equal(list[0].owner, "Dock");
  assert.equal(isOperatorWindow(list[0], 900), false);
  const above = placement(list, 900, 40, 500)!;
  assert.deepEqual([above.index, above.operatorAbove, above.operatorBelow, above.frontApp, above.aboveFrontWindow, above.coveredByOperator], [1, 0, 2, "Terminal", true, 0]);
  assert.equal(above.coversFrontWindow, 0.5);
  assert.match(placementText(above), /ABOVE the front app's window \(covers 50 % of it\); above 2 and below 0/);
  const behind = placement(list, 900, 41, 500)!;
  assert.deepEqual([behind.operatorAbove, behind.operatorBelow, behind.aboveFrontWindow, behind.coversFrontWindow], [2, 0, false, 0]);
  assert.equal(behind.coveredByOperator, 1);
  assert.match(placementText(behind), /behind the front app's window/);
  assert.equal(placement(list, 900, 99, 500), null);
  assert.equal(placementText(null), "not on screen");
  assert.equal(placement(list, 900, 40, 12)!.aboveFrontWindow, null);
  assert.equal(orderOf(list, 900, 40, 41), "above");
  assert.equal(orderOf(list, 900, 41, 40), "below");
  assert.equal(orderOf(list, 900, 41, 99), null);
});

test("coveredFraction samples the area of a window that others cover", () => {
  const t = { x: 0, y: 0, w: 100, h: 100 };
  assert.equal(coveredFraction(t, []), 0);
  assert.equal(coveredFraction(t, [{ x: 0, y: 0, w: 50, h: 100 }]), 0.5);
  assert.equal(coveredFraction(t, [{ x: -10, y: -10, w: 200, h: 200 }]), 1);
  assert.equal(coveredFraction({ x: 0, y: 0, w: 0, h: 10 }, [t]), 0);
});

test("the agent's new windows of a step, and the one whose bounds match Chrome's own window bounds", () => {
  const w = (n: number, x: number, extra: Record<string, unknown> = {}) => ({ n, layer: 0, x, y: 50, w: 800, h: 600, alpha: 1, onscreen: true, ...extra });
  const before: WatchEvent = { t: 1, ev: "windows", why: "snap", label: "before x", list: [], agentAll: [w(40, 0), w(3, 0, { layer: 3 })] };
  const after: WatchEvent = { t: 2, ev: "windows", why: "snap", label: "after x", list: [], agentAll: [w(40, 0), w(41, 22), w(42, 44, { w: 10 }), w(3, 0, { layer: 3 })] };
  assert.deepEqual(agentWindowsOf(after).map((x) => x.n), [40, 41]);
  assert.deepEqual(newAgentWindows(before, after).map((x) => x.n), [41]);
  assert.deepEqual(newAgentWindows(undefined, after).map((x) => x.n), [40, 41]);
  assert.equal(matchWindow(agentWindowsOf(after), { left: 23, top: 49, width: 800, height: 601 })?.n, 41);
  assert.equal(matchWindow(agentWindowsOf(after), { left: 30, top: 50, width: 800, height: 600 }), undefined);
  assert.equal(matchWindow(agentWindowsOf(after), undefined), undefined);
});

test("realPointerEvents: a probe page's events at the real pointer's point, which macOS gave and the check's CDP input did not", () => {
  const log = [
    { t: 5100, tab: "WA", ev: "in", type: "mouseover", sx: 100, sy: 200, cx: 90, cy: 120 },
    { t: 5150, tab: "WA", ev: "moves", list: [{ type: "mousemove", sx: 100.5, sy: 200, cx: 90, cy: 120 }, { type: "mousemove", sx: 300, sy: 300, cx: 290, cy: 220 }] },
    { t: 5160, tab: "WB", ev: "in", type: "mousedown", sx: 400, sy: 400, cx: 10, cy: 10 },
  ] as unknown as Rec[];
  const r = realPointerEvents(log, realPointer([ready()]), ["WA", "WB"], steps);
  assert.deepEqual(Object.keys(r), ["WA"]);
  assert.deepEqual(r.WA.map((e) => [e.type, e.step]), [["mouseover", "window: open window WA"], ["mousemove", "window: open window WA"]]);
  assert.deepEqual(realPointerEvents(log, null, ["WA"], steps), {});
});

test("joinVerdicts: the stable part's problems join the first part's with its name; an expected result only when each part passed or had only popup takes", () => {
  const ok = { ok: true, problems: [], popupOnly: false }, popup = { ok: false, problems: ["a step took the operator's front: popup: x"], popupOnly: true };
  const bad = { ok: false, problems: ["the check stopped early: the pointer moved"], popupOnly: false };
  assert.deepEqual(joinVerdicts(ok, null, "stable"), ok);
  assert.deepEqual(joinVerdicts(ok, ok, "stable"), { ok: true, problems: [], popupOnly: false });
  assert.deepEqual(joinVerdicts(popup, ok, "stable"), { ok: false, problems: popup.problems, popupOnly: true });
  assert.deepEqual(joinVerdicts(ok, popup, "the Google Chrome stable part"), { ok: false, problems: ["the Google Chrome stable part: a step took the operator's front: popup: x"], popupOnly: true });
  assert.deepEqual(joinVerdicts(popup, popup, "s").popupOnly, true);
  assert.deepEqual(joinVerdicts(popup, bad, "s"), { ok: false, problems: [...popup.problems, "s: the check stopped early: the pointer moved"], popupOnly: false });
  assert.equal(joinVerdicts(bad, ok, "s").popupOnly, false);
  assert.equal(joinVerdicts(ok, { ok: false, problems: ["it ended with exit 2 and wrote no results"] }, "s").popupOnly, false);
});

test("giveBackRows: who gave each take back (the start guard, agent-browser's give-back watcher, the check's watcher, nobody in the hold), with the prototype's own times", () => {
  const T = Date.parse("2026-11-06T10:00:00.000Z");
  const iso = (ms: number) => new Date(T + ms).toISOString();
  const take = (o: Partial<Take>): Take => ({ t0: T, t1: T + 30, ms: 30, to: ["Google Chrome Beta (pid 900, the agent Chrome)"], agentOnly: true, asks: 0, step: "popup: x", start: false, ...o });
  const back = parseWatchBack([
    `${iso(5010)} watch-back took=900 from=500`, `${iso(5011)} watch-back asked=500 n=1 sent=true`, `${iso(5052)} watch-back back=500 after-ms=42 asks=1`,
    `${iso(9010)} watch-back took=900 from=500`, `${iso(9011)} watch-back asked=500 n=1 sent=true`, `${iso(9261)} watch-back asked=500 n=2 sent=true`, `${iso(9511)} watch-back asked=500 n=3 sent=true`,
    `${iso(9761)} watch-back refused=500 asks=3`, `${iso(9900)} watch-back back=500 after-ms=890 asks=3`,
  ].join("\n"));
  const hold = { from: T + 1000, until: T + 3000 };
  const rows = giveBackRows([
    take({ t0: T, t1: T + 130, ms: 130, step: "start: agent Chrome start", start: true }),
    take({ t0: T + 1100, t1: T + 3060, ms: 1960, asks: 1, step: "popup: BG: no give-back" }),
    take({ t0: T + 5020, t1: T + 5070, ms: 50 }),
    take({ t0: T + 9000, t1: T + 9900, ms: 900, asks: 1, step: "popup: y" }),
    take({ t0: T + 12_000, t1: T + 12_020, ms: 20, asks: 1, step: "popup: z" }),
    take({ t0: T + 14_000, t1: T + 14_020, ms: 20, step: "popup: self" }),
    take({ t0: T + 1200, t1: T + 1500, ms: 300, step: "popup: BG: no give-back (after it)" }),
  ], back, [hold]);
  assert.match(rows[0].by, /agent-browser's start guard/);
  assert.equal(rows[1].by, "nobody for 1900 ms (no give-back), then the check's watcher");
  assert.deepEqual([rows[2].by, rows[2].seenMs, rows[2].asks, rows[2].ownMs], ["agent-browser's give-back watcher (the prototype)", -10, 1, 42], "the prototype's took line can come before the watcher's line (a 25 ms poll against NSWorkspace's news and a 100 ms tick)");
  assert.equal(rows[2].ms, 50);
  assert.deepEqual([rows[3].by, rows[3].asks, rows[3].ownMs, rows[3].seenMs], ["agent-browser's give-back watcher, then the check's watcher (its fallback)", 3, 890, 10]);
  assert.match(rows[3].note, /the prototype's 3 asks were spent \(refused=500\)/);
  assert.doesNotMatch(rows[3].note, /fallback/);
  assert.match(giveBackRows([take({ t0: T + 9000, t1: T + 9900, ms: 900, asks: 1 })], back, [], [T + 9800])[0].note, /the prototype's 3 asks were spent \(refused=500\); the check armed its watcher 800 ms after the take \(its fallback\)$/);
  assert.equal(rows[4].by, "the check's watcher");
  assert.deepEqual([rows[4].seenMs, rows[4].ownMs], [null, null]);
  assert.equal(rows[5].by, "nobody: it came back by itself");
  assert.equal(rows[6].by, "nobody: it came back by itself in the time with no give-back");
  assert.equal(giveBackRows([take({ t1: null, ms: 2000 })], [], [])[0].by, "nobody: it did not come back");
  assert.equal(giveBackRows([take({ t1: null, ms: 2000 })], [], [])[0].ms, null);
  assert.ok(FALLBACK_MS >= 500 && FALLBACK_MS < OPEN_TAKE_MS - 500, "the fallback arms the check's watcher well before the stop rule");
});

test("watchBackText: the prototype's ready, its takes, and its end against the agent Chrome's quit", () => {
  const T = Date.parse("2026-11-06T10:00:00.000Z"), iso = (ms: number) => new Date(T + ms).toISOString();
  const back = parseWatchBack([`${iso(0)} watch-back watch agent=900 before=500`, `${iso(100)} watch-back took=900 from=500`, `${iso(140)} watch-back back=500 after-ms=40 asks=1`,
    `${iso(800)} watch-back took=900 from=500`, `${iso(1600)} watch-back refused=500 asks=3`, `${iso(9300)} watch-back end=agent-gone`].join("\n"));
  const text = watchBackText(back, { started: "osascript, ready in 300 ms", quitAt: T + 9000 }).join("\n");
  assert.match(text, /^osascript, ready in 300 ms\nIt watched the agent Chrome \(pid 900\) and gave the front back to pid 500\./);
  assert.match(text, /It saw 2 take\(s\) of the front by the agent Chrome and saw the front come back 1 time\(s\); its 3 asks were spent 1 time\(s\)\./);
  assert.match(text, /Its end: agent-gone, 300 ms after the check's quit of the agent Chrome began\./);
  assert.match(watchBackText(parseWatchBack(`${iso(0)} watch-back end=stopped by=check`), {}).join(" "), /Its end: stopped \(by the check\)/);
  assert.deepEqual(watchBackText([], { started: "It did not start: boom" }), ["It did not start: boom"]);
  assert.deepEqual(watchBackText([], {}), ["agent-browser's give-back watcher did not run"]);
});

test("the summary names the result first, and every part of the measurement", () => {
  const r: MacResult = {
    ok: false, problems: ["a step took the operator's front: popup: x: the front went to Google Chrome Beta for 40 ms"], dryRun: false, run: "/tmp/run-x", startedAt: "2026-11-05T00:00:00.000Z", seconds: 170,
    chrome: BETA, product: "Chrome/158", flags: ["--no-first-run"], operator: { pid: 500, name: "Terminal" }, frontAtEnd: { pid: 500, name: "Terminal" },
    takes: [{ t0: 1, t1: 41, ms: 40, to: ["Google Chrome Beta (pid 900, the agent Chrome)"], agentOnly: true, asks: 1, step: "popup: x", start: false }], spaces: [],
    startGiveBack: ["give-back took=900 from=500", "give-back back=500 after-ms=90"],
    windows: [{ step: "window: open window WA", how: "Target.createTarget", cg: "41", placement: null, onscreen: "yes", space: "unchanged", front: "Terminal" }],
    tabDrive: [{ step: "click", ok: true, ms: 30, vis: "hidden", focus: "focus@3", frames: "1", others: "F0 -", front: "Terminal" }],
    windowDrive: [{ step: "WA: click", ok: false, ms: 30, error: "boom", vis: "visible", focus: "-", frames: "60", others: "WB blur@3", front: "Terminal", order: "WA above WB" }],
    records: [{ where: "a background tab", fps: 28.1, frames: 120, seconds: 4.27, maxFrameGapMs: 630 }, { where: "a window", skipped: "--skip record" }],
    focus: ["WB: click: WA blur@40"], popups: [{ kind: "link", asked: "a tab", where: "a tab in the opener's window", outer: "800x600", popup: "visible", opener: "blur", front: "Terminal", placement: null }],
    pointer: { at: { x: 100, y: 200 }, real: { WA: [{ t: 1, type: "mouseover", cx: 1, cy: 2, step: "window: open window WA" }] } },
    apis: ["The agent Chrome has 3 window(s)"], look: ["Run the check again with --look 60"], notMeasured: ["window activation"],
  };
  const s = summary(r);
  assert.match(s.split("\n")[0], /^# macOS check of drive, record and one window per page$/);
  assert.match(s, /## Result: exit 1\n- a step took the operator's front/);
  for (const part of ["## The front app and the Space", "## Where each new agent window came", "## Drive in a background tab", "## Drive in a window of its own",
    "## Records", "## Focus between agent windows", "## Popups from a background tab", "## Popups (from a page in a window of its own)", "## The way back to the opener (no activation",
    "## Who gave the front back", "## Google Chrome (stable)", "## The real pointer", "## Mission Control", "### For the operator", "## Not measured"]) assert.ok(s.includes(part), part);
  const full = summary({
    ...r, bgPopups: [{ step: "popup: BG: a link", giveBack: "none for 2 s, then the check's watcher", where: "a tab in the opener's window", popup: "visible, focus false, history.length 1", opener: "BG -", take: "away 2040 ms", during: "front app Google Chrome Beta", front: "Terminal" }],
    back: [{ step: "popup: back to the opener: Target.closeTarget of PA", how: "Target.closeTarget", ok: true, ms: 760, opener: "WA visible@12", after: "visible, document.hasFocus() true", front: "Terminal", space: "unchanged", order: "WA: behind the front app's window" }],
    giveBack: [{ step: "popup: x", ms: 14, by: "agent-browser's give-back watcher (the prototype)", seenMs: 3, asks: 1, ownMs: 11, note: "" }], watchBack: ["It watched the agent Chrome (pid 900)"],
    stable: ["Not measured: Google Chrome (stable) is not installed"],
  });
  assert.match(full, /\| popup: BG: a link \| none for 2 s, then the check's watcher \| a tab in the opener's window \|/);
  assert.match(full, /\| popup: back to the opener: Target\.closeTarget of PA \| Target\.closeTarget \| ok \| 760 \| WA visible@12 \| visible, document\.hasFocus\(\) true \|/);
  assert.match(full, /- It watched the agent Chrome \(pid 900\)\n\| step \| away/);
  assert.match(full, /\| popup: x \| 14 \| agent-browser's give-back watcher \(the prototype\) \| 3 \| 1 \| 11 \|/);
  assert.match(full, /## Google Chrome \(stable\)\n- Not measured: Google Chrome \(stable\) is not installed/);
  assert.match(summary({ ...r, part: "stable" }).split("\n")[0], /^# macOS check of drive, record and one window per page: the Google Chrome stable part$/);
  assert.match(s, /\| a background tab \| 28\.1 \| 120 \| 4\.27 \| 630 \|/);
  assert.match(s, /FAIL boom/);
  assert.match(s, /WA: 1 event\(s\) at the real pointer's point, first mouseover at 1,2/);
  assert.match(summary({ ...r, ok: true, problems: [], dryRun: true }), /DRY RUN on Linux[\s\S]*exit 0: the check never took the operator's focus or Space/);
  assert.doesNotMatch(s, /an expected result/);
  assert.match(summary({ ...r, popupOnly: true }), /## Result: exit 1, an expected result: only popup steps took the front \(Chrome can activate itself when it shows a popup\), and a watcher gave it back each time \(in the step with no give-back, after it\)\n/);
  assert.match(summary({ ...r, end: ["the agent Chrome quit (Browser.close)", "removed the profile"] }), /## The end\n- the agent Chrome quit \(Browser\.close\)\n- removed the profile/);
});

test("quitAgentChrome: Browser.close, then SIGTERM, then SIGKILL, each to the pid on the run's own profile; a quit that ps cannot confirm is a problem", async () => {
  const run = async (states: (number | null | undefined)[], sent?: false) => {
    const signals: string[] = [];
    let i = 0, closed = 0, checks = 0;
    const r = await quitAgentChrome({
      check: () => { checks++; return states[Math.min(i++, states.length - 1)]; }, close: async () => { closed++; return sent; }, signal: (pid, sig) => { signals.push(`${sig} ${pid}`); }, sleep: async () => {},
      waits: { close: 300, term: 200, kill: 200 },
    });
    return { ...r, signals, closed, checks };
  };
  const quick = await run([null]);
  assert.deepEqual([quick.lines, quick.problem, quick.running, quick.signals, quick.closed], [["the agent Chrome quit (Browser.close)"], undefined, false, [], 1]);
  const term = await run([9, 9, 9, 9, 9, null]);
  assert.deepEqual([term.lines, term.problem, term.running, term.signals], [["the agent Chrome quit at SIGTERM (pid 9), not at Browser.close"], undefined, false, ["SIGTERM 9"]]);
  const late = await run([9, 9, 9, 9, 9, 9, 9, null]); // 4 checks in the close wait, 3 in the SIGTERM wait, then the look before the SIGKILL
  assert.equal(late.problem, undefined, "it quit just after the SIGTERM wait: no SIGKILL to an undefined pid");
  assert.deepEqual([late.signals, late.running], [["SIGTERM 9"], false]);
  assert.match(late.lines[0], /quit at SIGTERM \(pid 9\)/);
  const kill = await run([9, 9, 9, 9, 9, 9, 9, 9, null]);
  assert.deepEqual([kill.signals, kill.running], [["SIGTERM 9", "SIGKILL 9"], false]);
  assert.equal(kill.problem, "the agent Chrome did not quit at Browser.close or SIGTERM: SIGKILL to pid 9");
  const stays = await run([9]);
  assert.deepEqual([stays.running, stays.signals], [true, ["SIGTERM 9", "SIGKILL 9"]]);
  assert.match(stays.problem ?? "", /SIGKILL to pid 9, and it still runs: stop it by hand/);
  const blind = await run([undefined]);
  assert.deepEqual([blind.running, blind.signals], [null, []]);
  assert.match(blind.problem ?? "", /the quit of the agent Chrome is not confirmed: ps failed/);
  // No CDP connection (a stop before agent-browser connected): no Browser.close went out, so no wait for it; SIGTERM at once.
  const noConn = await run([9, null], false);
  assert.deepEqual([noConn.signals, noConn.running, noConn.lines], [["SIGTERM 9"], false, ["the agent Chrome quit at SIGTERM (pid 9); no Browser.close (no CDP connection)"]]);
  assert.equal(noConn.checks, 2, "one look before the SIGTERM, one after it");
  const blindLater = await run([9, 9, 9, 9, undefined]);
  assert.equal(blindLater.running, null);
  assert.match(blindLater.problem ?? "", /not confirmed/);
});

test("the dry run's stand-in watcher speaks the watcher's protocol: ready with the six HID readings, snaps, agent, giveback, quit", async () => {
  const talk = async (env: Record<string, string>, input: string) => {
    const child = spawn(process.execPath, [join(DIR, "mac-standin.ts"), "30"], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env } });
    const lines: WatchEvent[] = [];
    createInterface({ input: child.stdout! }).on("line", (l) => lines.push(JSON.parse(l)));
    const until = async (pred: () => boolean) => { for (let i = 0; i < 100 && !pred(); i++) await new Promise((r) => setTimeout(r, 20)); assert.ok(pred()); };
    await until(() => lines.some((e) => e.ev === "ready"));
    child.stdin!.write(input);
    const code = await new Promise((r) => child.once("exit", r));
    assert.equal(code, 0);
    return lines;
  };
  const lines = await talk({}, "agent 42\narm\ngiveback\nsnap after x: y\nquit\n");
  assert.deepEqual(lines.map((e) => e.ev), ["ready", "windows", "agent", "armed", "giveback", "windows", "end"]);
  assert.deepEqual(Object.keys(lines[0].hid), ["keyDown", "flagsChanged", "leftMouseDown", "rightMouseDown", "otherMouseDown", "scrollWheel"]);
  assert.equal(screenProblem(lines), null, "the stand-in's ready line passes the check's refusal rules");
  assert.equal(lines.find((e) => e.ev === "agent")!.pid, 42);
  assert.equal(lines.find((e) => e.ev === "giveback")!.asked, false, "no agent Chrome in front: no last give-back");
  assert.equal(lines.at(-2)!.label, "after x: y");
  assert.equal(lines.at(-1)!.why, "quit");
  const zero = await talk({ MAC_STANDIN_HID: "keyDown=0" }, "quit\n");
  assert.equal(zero[0].hid.keyDown, 0);
  assert.match(screenProblem(zero) ?? "", /the HID reading of keyDown is 0/);
});

test("the watcher reads only: it sends no input, moves no pointer, sends no Apple Event, and asks only for the give-back's activation", () => {
  const swift = readFileSync(join(DIR, "mac-watch.swift"), "utf8").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  const person = swift.slice(swift.indexOf("func checkPerson()"), swift.indexOf("func checkSpace("));
  assert.match(person, /emit\("pointer"[\s\S]*personSeen\(why: "pointer"\)/, "at the first pointer move the watcher stops its give-back by itself");
  assert.match(person, /CGEventSource\.secondsSinceLastEventType\(\.hidSystemState, eventType: type\)[\s\S]*personSeen\(why: "input"\)/, "and at a key press, a click or a scroll of the hardware");
  for (const type of [".keyDown", ".flagsChanged", ".leftMouseDown", ".rightMouseDown", ".otherMouseDown", ".scrollWheel"]) assert.ok(swift.includes(type), type);
  assert.match(swift.slice(swift.indexOf("func personSeen("), swift.indexOf("func checkPerson()")), /armed = false[\s\S]*emit\("disarmed", \["why": why\]\)/);
  assert.match(swift.slice(swift.indexOf("func checkFront("), swift.indexOf("func personSeen(")), /checkPerson\(\)[\s\S]*guard armed/, "it reads the person's input before it acts on a front change");
  for (const forbidden of [/CGEventPost/, /CGWarpMouseCursorPosition/, /CGEvent\(mouseEventSource/, /CGEvent\(keyboardEventSource/, /NSAppleScript/, /AXUIElement/, /\.hide\(\)/, /terminate\(/, /kill\(/, /CGDisplayMoveCursor/])
    assert.doesNotMatch(swift, forbidden);
  const activations = swift.match(/\.activate\(/g) ?? [];
  assert.equal(activations.length, 1, "one activation: the give-back to the operator's app");
  assert.match(swift, /let sent = b\.activate\(options: \[\]\)/);
  // The ready line has the six HID readings (the check refuses a reading of 0 or less).
  assert.match(swift.slice(swift.indexOf("func ready()"), swift.indexOf("func checkFront(")), /for \(type, name\) in personTypes \{ hid\[name\] = \(CGEventSource\.secondsSinceLastEventType\(\.hidSystemState, eventType: type\)[\s\S]*o\["hid"\] = hid[\s\S]*emit\("ready", o\)/);
  // The check's last give-back request asks only while the agent Chrome is in front, and does not arm the give-back again.
  const last = swift.slice(swift.indexOf("func lastGiveBack()"), swift.indexOf("func personSeen("));
  assert.match(last, /guard let app = NSWorkspace\.shared\.frontmostApplication, isAgent\(app\), let b = before else/);
  assert.doesNotMatch(last, /armed = true/);
  assert.match(swift, /case "giveback":\s+lastGiveBack\(\)/);
});

test("the Mac check never activates a window or brings a page forward, and sends no OS input", () => {
  const ts = readFileSync(join(DIR, "mac.ts"), "utf8").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  for (const forbidden of [/"Target\.activateTarget"/, /"Page\.bringToFront"/, /"windows\.update"/, /xdotool/, /osascript/, /cliclick/, /newWindow: true(?!, background: true)/])
    assert.doesNotMatch(ts, forbidden);
  // Its one osascript run is agent-browser's give-back watcher, the prototype: a constant script (mac-watchback.ts), only its arguments change.
  assert.equal((ts.match(/spawn\(OSASCRIPT/g) ?? []).length, 1);
  assert.match(ts, /spawn\(OSASCRIPT, watchBackArgs\(bundle!, chromePid, bound, process\.pid\), /);
  assert.match(ts, /\["-n", "-g", "-a", bundle!/);
  assert.match(ts, /"-sdk", swift\.sdk/, "swiftc gets the SDK, so it never starts xcrun");
  // It removes only the throwaway profile and the watcher that it compiled, both inside its own run folder, after its Chrome quit.
  assert.deepEqual(ts.match(/rmSync\([^)]*\)/g), ["rmSync(profile, { recursive: true, maxRetries: 3 })", "rmSync(watcherBin)"]);
  assert.match(ts, /if \(quit\.running !== false\) endLines\.push\(`kept the profile[\s\S]*else if \(inRun\(profile\)/, "the profile stays while the agent Chrome runs or ps cannot tell");
  assert.match(ts, /!O\.dryRun && !O\.watcher && watcher\.exitCode !== null && inRun\(watcherBin\)/);
  assert.match(ts, /startGiveBack\(bundle!/);
  // The stop rules run at each watcher line and every STOP_POLL_MS from the start on, and each step ends at a stop.
  assert.match(ts, /if \(watching\) checkHarm\(\);/);
  assert.match(ts, /stopPoll = setInterval\(checkHarm, STOP_POLL_MS\)/);
  assert.match(ts, /runStep\(fn, \{ limitMs: [^}]*stopped: \(\) => \{ checkHarm\(\); return aborted; \}/);
  assert.match(ts, /return aborted; \}, wake: stopped,/, "a stop at a watcher line ends the step at once, before the next poll");
  assert.match(ts, /tell\("disarm"\);\s+tell\("giveback"\);/);
  // No measurement CDP call goes out after a stop (only the detach and the end's Browser.close use raw.send).
  for (const call of ts.match(/raw\.send\("[^"]+"/g) ?? []) assert.ok(['raw.send("Target.detachFromTarget"', 'raw.send("Browser.close"'].includes(call), call);
  // The refusal rules (the HID readings, a person before the start) run in both modes, and again right before the launch.
  assert.equal((ts.match(/screenProblem\(events\)/g) ?? []).length, 2);
  assert.doesNotMatch(ts, /if \(!O\.dryRun\) \{\s+const problem = screenProblem/);
  // The probe's log keeps no key values, and the field only its length.
  assert.match(ts, /startServer\(log, \{ record: probeRecord \}\)/);
  assert.match(ts, /return fieldText\(before, await evaluate\(sid, FIELD\), text\)/);
});

test("ab-v16.68: the time with no give-back is bounded and gives the front back at its end, the prototype ends at a stop, and the stable part runs only after a whole first part", () => {
  const ts = readFileSync(join(DIR, "mac.ts"), "utf8").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  // The hold: recorded for the stop rules before the check's watcher stops giving the front back, and ended by it (not after a stop: checkHarm gave the front back then).
  // (noGiveBackStep in mac-rules.ts, tested above: the hold before the disarm, the arm at its end, none after a stop.)
  assert.match(ts, /await noGiveBackStep\(\{ now: Date\.now, pause, tell, aborted: \(\) => !!aborted, holds, open, snap: \(\) => snap\(`during \$\{label\}`\) \}\);/);
  assert.match(ts, /stopReason\(events, steps, Date\.now\(\), \{ t0: T0, limitMs: LIMIT_MS, measureEnd, holds \}\)/);
  assert.equal((ts.match(/tell\("disarm"\)/g) ?? []).length, 4, "a stop, the prototype's start, the fallback's end, the look (the hold's: noGiveBackStep)");
  assert.equal((ts.match(/tell\("arm"\)/g) ?? []).length, 3, "the start, the fallback, a prototype that ended by itself (the hold's end: noGiveBackStep)");
  // A stop ends agent-browser's give-back watcher at once (it cannot tell a person's own switch to the agent Chrome), and so does the look.
  assert.match(ts, /tell\("disarm"\);\s+tell\("giveback"\);\s+stopWatchBack\(\);/);
  assert.match(ts, /measureEnd = Date\.now\(\);\s+clearInterval\(stopPoll\);\s+stopWatchBack\(\);/);
  assert.match(ts, /wb\.kill\("SIGTERM"\)/, "it ends only the process that it started");
  assert.match(ts, /child\.once\("exit", \(\) => \{\s+if \(!protoOn \|\| wb !== child\) return;\s+protoOn = false;[\s\S]{0,120}if \(!aborted\) \{ tell\("arm"\);/, "a prototype that ends by itself hands the give-back back to the check's watcher");
  // The fallback arms the check's watcher only while the prototype runs and the agent Chrome still has the front.
  assert.match(ts, /active: \(\) => protoOn && !aborted, frontIsAgent: \(\) => frontAt\(events, Date\.now\(\)\)\?\.pid === chromePid,/);
  assert.match(ts, /if \(e\) fallback\.line\(e\);/);
  // The stable part: only Google Chrome stable in /Applications, never installed, and only after a first part that ran to its end and quit its Chrome.
  assert.match(ts, /!O\.dryRun && !existsSync\(CHROME_STABLE_BIN\) \? `Not measured: Google Chrome \(stable\) is not installed/);
  assert.match(ts, /aborted \? "Not run: the first part stopped early\." : fatal \? "Not run: the first part failed\." : quit\.running !== false \?/);
  assert.match(ts, /"--on-my-screen", "--part", "stable", "--out-dir", dir, "--chrome-bin", CHROME_STABLE_BIN, "--watcher", watcherBin/);
  // B1 of review-66: the first part hands the stable part its last look at the input and the pointer's point, and the stable part checks them before its Chrome starts.
  assert.match(ts, /const hand = handover\(events, measureEnd!?\)/);
  assert.match(ts, /: !hand\.ok \? `Not run: \$\{hand\.why\}\.`/);
  assert.match(ts, /filter\(\(\[k\]\) => !k\.startsWith\("MAC_STANDIN_"\) \|\| k\.startsWith\("MAC_STANDIN_STABLE_"\)\)/, "the first part's stand-in settings stay out of the stable part");
  // N2 of review-66: the prototype gets the check's own pid, and stop-chrome.txt names it.
  assert.match(ts, /watchBackArgs\(bundle!, chromePid, bound, process\.pid\)/);
  assert.match(ts, /appendFileSync\(join\(RUN, "stop-chrome\.txt"\), `\$\{help\}\\n`\);/);
  assert.match(ts, /`--quiet-since=\$\{hand\.handover\.quietSince\}`, `--pointer=\$\{hand\.handover\.pointer\.x\},\$\{hand\.handover\.pointer\.y\}`/);
  assert.match(ts, /if \(O\.handover\) \{ const gap = gapProblem\(ready, O\.handover\); if \(gap\) refuse\(`refusing, nothing started: \$\{gap\}`\); \}/);
  assert.ok(ts.indexOf("gapProblem(ready, O.handover)") < ts.indexOf('await step("start", "agent Chrome start"'), "the gap check comes before the Chrome start");
  assert.match(ts, /noGiveBackStep\(\{/);
  assert.match(ts, /const fallback = makeFallback\(\{/);
  // The way back sends no activation: a CDP click, Target.closeTarget, or the page's own window.close().
  assert.match(ts, /evaluate\(sid, "window\.close\(\), true"\)/);
  assert.equal((ts.match(/cdp\("Target\.closeTarget"/g) ?? []).length, 3, "the way back, its fallback when the page does not close itself, and the background tab's popups");
});

test("the help text names the consent limits: the apps that post HID events stop the check", () => {
  assert.match(USAGE, /Quit the apps that post keyboard or mouse events \(remote-desktop apps,\s+Karabiner, a mouse jiggler, Universal Control\)/);
  assert.match(refused(["--out-dir", "/tmp/o"]), /Universal Control/);
});
