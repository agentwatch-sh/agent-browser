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
  agentWindowsOf, coveredFraction, ffmpegSearchPath, frontAt, frontTakes, isOperatorWindow, macArgs, matchWindow, newAgentWindows, orderOf, parseWatchLog, placement,
  placementText, realPointer, realPointerEvents, screenProblem, spaceChanges, START_MAX_AWAY_MS, stepAt, stopReason, summary, swiftTools, verdict, watcherProblems, windowsOf,
  type CgWin, type MacResult, type Step, type WatchEvent,
} from "./live/anti-detect/mac-rules.ts";
import type { Rec } from "./live/anti-detect/probe.ts";
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
const ready = (extra: Record<string, unknown> = {}): WatchEvent => ({ t: 500, ev: "ready", front: OP, pointer: [100, 200], space: 7, locked: false, asleep: false, onConsole: true, displays: [{ x: 0, y: 0, w: 1512, h: 982, main: true }], ...extra });
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
    "## Records", "## Focus between agent windows", "## Popups", "## The real pointer", "## Mission Control", "### For the operator", "## Not measured"]) assert.ok(s.includes(part), part);
  assert.match(s, /\| a background tab \| 28\.1 \| 120 \| 4\.27 \| 630 \|/);
  assert.match(s, /FAIL boom/);
  assert.match(s, /WA: 1 event\(s\) at the real pointer's point, first mouseover at 1,2/);
  assert.match(summary({ ...r, ok: true, problems: [], dryRun: true }), /DRY RUN on Linux[\s\S]*exit 0: the check never took the operator's focus or Space/);
  assert.doesNotMatch(s, /an expected result/);
  assert.match(summary({ ...r, popupOnly: true }), /## Result: exit 1\n- Only popup steps took the front: an expected result/);
  assert.match(summary({ ...r, end: ["the agent Chrome quit (Browser.close)", "removed the profile"] }), /## The end\n- the agent Chrome quit \(Browser\.close\)\n- removed the profile/);
});

test("the dry run's stand-in watcher speaks the watcher's protocol: ready, snaps, agent, quit", async () => {
  const child = spawn(process.execPath, [join(DIR, "mac-standin.ts"), "30"], { stdio: ["pipe", "pipe", "pipe"] });
  const lines: WatchEvent[] = [];
  createInterface({ input: child.stdout! }).on("line", (l) => lines.push(JSON.parse(l)));
  const until = async (pred: () => boolean) => { for (let i = 0; i < 100 && !pred(); i++) await new Promise((r) => setTimeout(r, 20)); assert.ok(pred()); };
  await until(() => lines.some((e) => e.ev === "ready"));
  child.stdin!.write("agent 42\narm\nsnap after x: y\nquit\n");
  const code = await new Promise((r) => child.once("exit", r));
  assert.equal(code, 0);
  assert.deepEqual(lines.map((e) => e.ev), ["ready", "windows", "agent", "armed", "windows", "end"]);
  assert.equal(lines.find((e) => e.ev === "agent")!.pid, 42);
  assert.equal(lines.at(-2)!.label, "after x: y");
  assert.equal(lines.at(-1)!.why, "quit");
});

test("the watcher reads only: it sends no input, moves no pointer, sends no Apple Event, and asks only for the give-back's activation", () => {
  const swift = readFileSync(join(DIR, "mac-watch.swift"), "utf8").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  assert.match(swift.slice(swift.indexOf("func checkPointer()"), swift.indexOf("func checkSpace(")), /armed = false[\s\S]*emit\("disarmed", \["why": "pointer"\]\)/,
    "at the first pointer move the watcher stops its give-back by itself: a person uses the Mac");
  for (const forbidden of [/CGEventPost/, /CGWarpMouseCursorPosition/, /CGEvent\(mouseEventSource/, /CGEvent\(keyboardEventSource/, /NSAppleScript/, /AXUIElement/, /\.hide\(\)/, /terminate\(/, /kill\(/, /CGDisplayMoveCursor/])
    assert.doesNotMatch(swift, forbidden);
  const activations = swift.match(/\.activate\(/g) ?? [];
  assert.equal(activations.length, 1, "one activation: the give-back to the operator's app");
  assert.match(swift, /let sent = b\.activate\(options: \[\]\)/);
});

test("the Mac check never activates a window or brings a page forward, and sends no OS input", () => {
  const ts = readFileSync(join(DIR, "mac.ts"), "utf8").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  for (const forbidden of [/"Target\.activateTarget"/, /"Page\.bringToFront"/, /"windows\.update"/, /xdotool/, /osascript/, /cliclick/, /newWindow: true(?!, background: true)/])
    assert.doesNotMatch(ts, forbidden);
  assert.match(ts, /\["-n", "-g", "-a", bundle!/);
  assert.match(ts, /"-sdk", swift\.sdk/, "swiftc gets the SDK, so it never starts xcrun");
  // It removes only the throwaway profile and the watcher that it compiled, both inside its own run folder, after its Chrome quit.
  assert.deepEqual(ts.match(/rmSync\([^)]*\)/g), ["rmSync(profile, { recursive: true, maxRetries: 3 })", "rmSync(watcherBin)"]);
  assert.match(ts, /if \(chromePid !== undefined && ownChrome\(\)\) endLines\.push\(`kept the profile[\s\S]*else if \(inRun\(profile\)/);
  assert.match(ts, /!O\.dryRun && !O\.watcher && watcher\.exitCode !== null && inRun\(watcherBin\)/);
  assert.match(ts, /startGiveBack\(bundle!/);
});
