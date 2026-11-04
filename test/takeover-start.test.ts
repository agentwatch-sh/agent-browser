// The live start check (test/live/takeover/start.ts, ab-b84.11): its argument guard, the analysis of
// a monitor log (which start changed the frontmost app), and its whole flow with a fake Chrome and a
// fake monitor. The check itself starts a real Chrome on a person's screen, on macOS only, so it is
// not part of `npm test`; here no real Chrome and no real monitor run.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { analyseStarts, exitCode, livenessProblem, lsappinfoPid, parseGiveBack, parseMonitorLog, startArgs, USAGE, VARIANTS, variantLaunch, type Mark, type Variant } from "./live/takeover/focus.ts";
import { INSPECT_URL, launchAgentChrome } from "../src/agent.ts";
import { resolveOptions } from "../src/options.ts";
import { ROOT } from "./helpers.ts";

const run = promisify(execFile);
const START = join(ROOT, "test", "live", "takeover", "start.ts");
const LAUNCH_HIDDEN = join(ROOT, "test", "live", "takeover", "launch-hidden.ts");
const BETA = "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta";
const STABLE = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const MONITOR = "/tmp/abfs-monitor/monitor";
const mac = { platform: "darwin", exists: (p: string) => [BETA, STABLE, MONITOR].includes(p) };
const full = ["--on-my-screen", "--chrome-bin", BETA, "--monitor", MONITOR, "--out-dir", "/tmp/abfs-out"];

const refused = (argv: string[], env = mac) => {
  const r = startArgs(argv, env);
  assert.equal(r.ok, false, `refused: ${argv.join(" ")}`);
  return (r as { message: string }).message;
};

test("the start check refuses without --on-my-screen: a person must agree to Chrome windows on the screen", () => {
  assert.match(refused(full.filter((a) => a !== "--on-my-screen")), /--on-my-screen/);
  assert.match(refused([]), /--on-my-screen/);
});

test("the start check runs on macOS only", () => {
  assert.match(refused(full, { ...mac, platform: "linux" }), /macOS only/);
});

test("the start check needs an app binary of Google Chrome or Chrome Beta, so that the start goes through `open -n -g`", () => {
  assert.match(refused(full.filter((a) => a !== BETA && a !== "--chrome-bin")), /--chrome-bin/);
  for (const bin of ["Google Chrome Beta", "/usr/bin/chromium", "/Applications/Google Chrome Beta.app", "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta/"]) {
    assert.match(refused(["--on-my-screen", "--chrome-bin", bin, "--monitor", MONITOR, "--out-dir", "/tmp/abfs-out"], { ...mac, exists: () => true }), /--chrome-bin/, bin);
  }
  // An app binary in the right form, but relative: it would resolve against the current folder.
  assert.match(refused(["--on-my-screen", "--chrome-bin", "Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta", "--monitor", MONITOR, "--out-dir", "/tmp/abfs-out"], { ...mac, exists: () => true }), /--chrome-bin must be an absolute path/);
  const cft = "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
  assert.match(refused(["--on-my-screen", "--chrome-bin", cft, "--monitor", MONITOR, "--out-dir", "/tmp/abfs-out"], { ...mac, exists: () => true }), /Chrome for Testing/);
  assert.match(refused(["--on-my-screen", "--chrome-bin", STABLE, "--monitor", MONITOR, "--out-dir", "/tmp/abfs-out"], { ...mac, exists: (p) => p === MONITOR }), /no such file/);
});

test("the start check needs the compiled monitor and an output folder", () => {
  assert.match(refused(["--on-my-screen", "--chrome-bin", BETA, "--out-dir", "/tmp/abfs-out"]), /--monitor/);
  assert.match(refused(["--on-my-screen", "--chrome-bin", BETA, "--monitor", "/tmp/nope", "--out-dir", "/tmp/abfs-out"]), /--monitor.*no such file|no such file.*monitor/);
  assert.match(refused(["--on-my-screen", "--chrome-bin", BETA, "--monitor", MONITOR]), /--out-dir/);
});

test("--starts is 3 by default and a whole number from 1 to 20; --after-ms is 10 s by default; a fresh profile per start by default", () => {
  const r = startArgs(full, mac);
  assert.ok(r.ok);
  assert.deepEqual(r.options, { chromeBin: BETA, starts: 3, monitor: MONITOR, outDir: "/tmp/abfs-out", afterMs: 10_000, keepState: false, sameProfile: false, variant: "launch" });
  const five = startArgs([...full, "--starts", "5", "--after-ms", "4000", "--keep-state", "--same-profile"], mac);
  assert.ok(five.ok);
  assert.equal(five.options.starts, 5);
  assert.equal(five.options.afterMs, 4000);
  assert.equal(five.options.keepState, true);
  assert.equal(five.options.sameProfile, true);
  for (const n of ["0", "-1", "2.5", "x", "21", ""]) assert.match(refused([...full, "--starts", n]), /--starts/, n);
  for (const ms of ["999", "x", "120001"]) assert.match(refused([...full, "--after-ms", ms]), /--after-ms/, ms);
});

test("the start check refuses an --out-dir that holds the logs of a run, so a second run never deletes them", () => {
  for (const name of ["marks.jsonl", "results.jsonl", "monitor.jsonl"]) {
    const message = refused(full, { ...mac, exists: (p) => mac.exists(p) || p === `/tmp/abfs-out/${name}` });
    assert.match(message, new RegExp(`--out-dir already holds the logs of a run \\(${name.replace(".", "\\.")}\\)`), name);
    assert.doesNotMatch(message, /\n/, "one line");
  }
});

const variant = (name: string): Variant => VARIANTS.find((v) => v.name === name)!;

test("the variant table: today's start and the two acceptable candidates; each changes one thing and says what; the usage names each", () => {
  assert.deepEqual(VARIANTS.map((v) => [v.name, v.kind, v.hidden ?? false, v.giveBack ?? false]), [
    ["launch", "today", false, false], ["hidden", "candidate", true, false], ["give-back", "candidate", false, true]]);
  for (const v of VARIANTS) assert.ok(USAGE.includes(`  ${v.name} (${v.kind}): ${v.summary}`), v.name);
  assert.match(USAGE, /none opens a debugging WebSocket/);
});

test("--variant: launch (today's start) by default; an unknown variant is refused with the list", () => {
  for (const name of ["launch", "hidden"]) {
    const r = startArgs([...full, "--variant", name], mac);
    assert.ok(r.ok, name);
    assert.equal(r.options.variant, name);
    assert.equal("giveback" in r.options, false);
  }
  assert.match(refused([...full, "--variant", "fast"]), /^--variant must be one of launch, hidden, give-back, not "fast"$/);
  assert.match(refused([...full, "--variant", "no-startup-window"]), /--variant must be one of/, "not a candidate: with no window, Chrome denies every debugging connection");
  assert.match(refused([...full, "--variant", ""]), /--variant must be one of/);
});

test("--variant give-back needs the compiled give-back helper (--giveback); --giveback with another variant is refused", () => {
  const GIVEBACK = "/tmp/abfs-giveback";
  const env = { ...mac, exists: (p: string) => mac.exists(p) || p === GIVEBACK };
  assert.match(refused([...full, "--variant", "give-back"], env), /--giveback is required for --variant give-back/);
  assert.match(refused([...full, "--variant", "give-back", "--giveback", "/tmp/nope"], env), /--giveback: no such file: \/tmp\/nope/);
  assert.match(refused([...full, "--giveback", GIVEBACK], env), /--giveback is only for --variant give-back/);
  const r = startArgs([...full, "--variant", "give-back", "--giveback", GIVEBACK], env);
  assert.ok(r.ok);
  assert.equal(r.options.variant, "give-back");
  assert.equal(r.options.giveback, GIVEBACK);
});

test("each variant's start command: the CLI's launch as an agent session runs it, or for hidden the launcher that runs the same launch with its hook", () => {
  const p = { node: "/usr/local/bin/node", cli: "/r/bin/agent-browser.js", launcher: "/r/test/live/takeover/launch-hidden.ts", stateDir: "/tmp/abfs-1-AbC123", chromeBin: BETA };
  const cli = [p.node, p.cli, "launch", "--state-dir", p.stateDir, "--chrome-bin", BETA, "--json"];
  assert.deepEqual(variantLaunch(variant("launch"), p), cli);
  assert.deepEqual(variantLaunch(variant("give-back"), p), cli, "the guard runs beside the start; the start itself is today's");
  assert.deepEqual(variantLaunch(variant("hidden"), p), [p.node, p.launcher, "--state-dir", p.stateDir, "--chrome-bin", BETA]);
});

test("each variant starts the agent Chrome as src/agent.ts does, changed only by its candidate (a macOS start with a fake spawn)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "abfs-test-"));
  try {
    const startOf = async (v: Variant) => {
      const s = resolveOptions({ stateDir: join(dir, v.name), chromeBin: BETA, log: () => {} });
      const calls: { bin: string; args: string[] }[] = [];
      let probes = 0;
      // What `launch` (no --login) gives launchAgentChrome, with the variant's hook.
      await launchAgentChrome(s, { timeoutMs: 2_000, urls: [INSPECT_URL], background: true, hidden: v.hidden }, {
        endpoint: async () => ++probes < 2 ? undefined : "ws://127.0.0.1:9/devtools/browser/x", pid: () => undefined, platform: "darwin", exists: () => true,
        spawn: (bin, args) => { calls.push({ bin, args }); return { pid: 1, exitCode: 0, unref() {} }; },
      });
      assert.equal(calls.length, 1, v.name);
      return { bin: calls[0].bin, args: calls[0].args.map((a) => a.replaceAll(s.stateDir, "<state>")) };
    };
    const today = await startOf(variant("launch"));
    assert.deepEqual([today.bin, ...today.args.slice(0, 5)], ["/usr/bin/open", "-n", "-g", "-a", "/Applications/Google Chrome Beta.app", "--args"]);
    assert.equal(today.args.at(-1), INSPECT_URL);
    for (const v of VARIANTS.filter((x) => x.name !== "launch")) {
      const want = [...today.args];
      if (v.hidden) want.splice(2, 0, "-j");
      assert.deepEqual(await startOf(v), { bin: today.bin, args: want }, v.name);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the give-back helper's log: the app in front at its start, then one line per request; a cut last line is no error", () => {
  const log = parseGiveBack([
    '{"t": 10.0, "before": 500, "name": "TextEdit"}',
    '{"t": 11.0, "took": 701, "name": "Google Chrome Beta", "gaveBackTo": 500, "sent": true}',
    '{"t": 11.5, "took": 701, "name": "Google Chrome Beta", "gaveBackTo": 500, "sent": fal',
  ].join("\n"));
  assert.deepEqual(log, { before: { pid: 500, name: "TextEdit" }, requests: [{ t: 11, took: 701, name: "Google Chrome Beta", gaveBackTo: 500, sent: true }], bad: [] });
  const odd = parseGiveBack('{"t": 1, "what": 2}\n{"t": 2, "before": 5, "name": "X"}\n{"t": 3, "took": 6, "name": "Y", "gaveBackTo": 5, "sent": "yes"}\n');
  assert.deepEqual(odd.bad, [1, 3]);
  assert.deepEqual(odd.before, { pid: 5, name: "X" });
  assert.deepEqual(parseGiveBack(""), { before: null, requests: [], bad: [] });
});

test("the start check refuses an unknown flag or a stray argument", () => {
  assert.match(refused([...full, "--login"]), /--login|unknown/i);
  assert.match(refused([...full, "extra"]), /extra|argument/i);
});

test("the monitor log: one event per JSON line; a bad JSON line is reported unless it is the last line, which a kill can cut", () => {
  const text = [
    '{"t": 100.000, "front": 500, "name": "Terminal"}',
    "monitor: started",
    '{"t": 100.050, "pointer": [10, 20]}',
    '{"t": 101.000, "alive": true}',
    '{"t": 101.200, "launched": 702, "name": "Google Chrome Beta"}',
    '{"t": 101.5',
  ].join("\n");
  assert.deepEqual(parseMonitorLog(text), { events: [{ t: 100, front: 500, name: "Terminal" }, { t: 100.05, pointer: [10, 20] }, { t: 101, alive: true }, { t: 101.2, launched: 702, name: "Google Chrome Beta" }], bad: [] });
  const broken = parseMonitorLog('{"t": 100.000, "front": 500, "name": "Bad "quote""}\n{"t": 100.1, "alive": true}\n{"t": 100.2, "what": 1}\n');
  assert.deepEqual(broken.bad, [1, 3], "an unescaped name and a line that is no event, both before the last line");
  assert.deepEqual(broken.events, [{ t: 100.1, alive: true }]);
});

test("the liveness check: lsappinfo's front pid must be the monitor's latest front pid", () => {
  assert.equal(lsappinfoPid('"pid"=48285\n'), 48285);
  assert.equal(lsappinfoPid("[ NULL ]\n"), undefined);
  assert.equal(lsappinfoPid(""), undefined);
  assert.equal(livenessProblem(500, 500), null);
  assert.match(livenessProblem(500, undefined) ?? "", /lsappinfo/);
  assert.match(livenessProblem(undefined, 500) ?? "", /the monitor logged no frontmost app/);
  assert.match(livenessProblem(0, 500) ?? "", /the monitor cannot see the frontmost app/);
  assert.match(livenessProblem(500, 600) ?? "", /pid 500.*pid 600/);
});

// Three starts, then the end of the run at t=64. The monitor's heartbeat comes once a second, from
// t=5 to t=65. A start's quit phase runs to the next start (or to the end of the run).
const marks: Mark[] = [
  { t: 10, what: "start launch 1" }, { t: 12, what: "end launch 1" }, { t: 22, what: "start quit 1" }, { t: 23, what: "end quit 1" },
  { t: 30, what: "start launch 2" }, { t: 32, what: "end launch 2" }, { t: 42, what: "start quit 2" }, { t: 43, what: "end quit 2" },
  { t: 50, what: "start launch 3" }, { t: 52, what: "end launch 3" }, { t: 62, what: "start quit 3" }, { t: 63, what: "end quit 3" },
  { t: 64, what: "done" },
];
const pids = { 1: 701, 2: 702, 3: 703 };
const beats = (from = 5, to = 65, skip: (t: number) => boolean = () => false) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i).filter((t) => !skip(t)).map((t) => `{"t": ${t}.5, "alive": true}`);
const monitorLog = (lines: string[], hb = beats()) => parseMonitorLog([...lines, ...hb].join("\n"));

test("the analysis names the start that changed the frontmost app, when, and to which app", () => {
  const log = monitorLog([
    '{"t": 5.0, "front": 500, "name": "TextEdit"}',
    '{"t": 33.2, "front": 702, "name": "Google Chrome Beta"}',
    '{"t": 35.0, "pointer": [400, 300]}',
    '{"t": 35.1, "front": 500, "name": "TextEdit"}',
  ]);
  const r = analyseStarts(log, marks, pids);
  assert.deepEqual(r.map((x) => [x.start, x.changed]), [[1, false], [2, true], [3, false]]);
  assert.deepEqual(r[0], { start: 1, frontBefore: { pid: 500, name: "TextEdit" }, changed: false, changes: [], quitChanges: [], quitCounted: false, awayMs: 0, pointerMoves: 0, launchSeen: false, problem: null });
  assert.equal(r[1].awayMs, 1900, "TextEdit was back 1.9 s after Chrome took the front");
  assert.deepEqual(r[1].changes, [
    { t: 33.2, afterStartMs: 3200, phase: "after", pid: 702, name: "Google Chrome Beta", agentChrome: true },
    { t: 35.1, afterStartMs: 5100, phase: "after", pid: 500, name: "TextEdit", agentChrome: false },
  ]);
  assert.equal(r[1].pointerMoves, 1, "the pointer moved: the change back can be the person's click");
  assert.equal(exitCode(r), 1);
});

test("awayMs: how long the front app was not the app in front before, in the launch and after phases (not in the quit)", () => {
  const r = analyseStarts(monitorLog([
    '{"t": 5.0, "front": 500, "name": "TextEdit"}',
    '{"t": 11.0, "front": 701, "name": "Google Chrome Beta"}',
    '{"t": 11.4, "front": 500, "name": "TextEdit"}',
    '{"t": 33.0, "front": 702, "name": "Google Chrome Beta"}',
    '{"t": 34.0, "front": 600, "name": "Finder"}',
    '{"t": 42.5, "front": 500, "name": "TextEdit"}',
  ]), marks, pids, { monitorEnd: 70 });
  assert.deepEqual(r.map((x) => x.awayMs), [400, 9000, 0], "start 1: given back after 0.4 s; start 2: away from +3 s to the quit at +12 s, through another app");
  assert.equal(analyseStarts(monitorLog(['{"t": 25.0, "front": 500, "name": "TextEdit"}']), marks, pids)[0].awayMs, null, "no app in front before the start");
});

test("a change while the launch command runs is in the launch phase; another app (a system prompt) counts too", () => {
  const log = monitorLog(['{"t": 5.0, "front": 500, "name": "TextEdit"}', '{"t": 11.0, "front": 900, "name": "SecurityAgent"}']);
  const r = analyseStarts(log, marks, pids);
  assert.deepEqual(r[0].changes, [{ t: 11, afterStartMs: 1000, phase: "launch", pid: 900, name: "SecurityAgent", agentChrome: false }]);
  assert.equal(r[1].frontBefore?.name, "SecurityAgent", "the next start begins with what is in front then");
  assert.equal(r[1].changed, false);
});

test("the start's own Chrome takes the focus after the launch, and the focus goes back while the check quits it", () => {
  const log = monitorLog([
    '{"t": 5.0, "front": 500, "name": "TextEdit"}',
    '{"t": 13.0, "front": 701, "name": "Google Chrome Beta"}',
    '{"t": 22.5, "front": 500, "name": "TextEdit"}',
  ]);
  const r = analyseStarts(log, marks, pids);
  assert.equal(r[0].changed, true);
  assert.deepEqual(r[0].changes, [{ t: 13, afterStartMs: 3000, phase: "after", pid: 701, name: "Google Chrome Beta", agentChrome: true }]);
  assert.deepEqual(r[0].quitChanges, [{ t: 22.5, afterStartMs: 12500, phase: "quit", pid: 500, name: "TextEdit", agentChrome: false }]);
  assert.equal(r[0].quitCounted, true, "every change in the quit phase counts");
});

test("every change in the quit phase counts: a Chrome that is not in front moves no focus when it quits", () => {
  const late = analyseStarts(monitorLog([
    '{"t": 5.0, "front": 500, "name": "TextEdit"}',
    '{"t": 22.2, "front": 701, "name": "Google Chrome Beta"}',
    '{"t": 22.8, "front": 500, "name": "TextEdit"}',
  ]), marks, pids);
  assert.equal(late[0].changes.length, 0);
  assert.equal(late[0].quitCounted, true, "a late activation of the start's own Chrome, 0.2 s into the quit");
  assert.equal(late[0].changed, true);
  assert.equal(exitCode(late), 1);

  const stays = analyseStarts(monitorLog(['{"t": 5.0, "front": 500, "name": "TextEdit"}', '{"t": 22.5, "front": 600, "name": "Finder"}']), marks, pids);
  assert.equal(stays[0].quitCounted, true, "the focus went to another app and stayed there");
  assert.equal(stays[0].changed, true);

  const back = analyseStarts(monitorLog([
    '{"t": 5.0, "front": 500, "name": "TextEdit"}',
    '{"t": 22.5, "front": 600, "name": "Finder"}',
    '{"t": 22.9, "front": 500, "name": "TextEdit"}',
  ]), marks, pids);
  assert.equal(back[0].quitCounted, true, "another app for a moment, then the app in front before");
  assert.equal(back[0].changed, true);

  // Between "end quit 1" (t=23) and "start launch 2" (t=30): still start 1's quit phase.
  const gap = analyseStarts(monitorLog(['{"t": 5.0, "front": 500, "name": "TextEdit"}', '{"t": 26.0, "front": 701, "name": "Google Chrome Beta"}']), marks, pids);
  assert.deepEqual(gap[0].quitChanges, [{ t: 26, afterStartMs: 16000, phase: "quit", pid: 701, name: "Google Chrome Beta", agentChrome: true }]);
  assert.equal(gap[0].changed, true);
  assert.equal(gap[1].changed, false);
});

test("a change at the same instant as the next start's launch mark, or as \"done\", still counts for the start before", () => {
  const atNext = analyseStarts(monitorLog(['{"t": 5.0, "front": 500, "name": "TextEdit"}', '{"t": 30.0, "front": 600, "name": "Finder"}']), marks, pids, { monitorEnd: 70 });
  assert.deepEqual(atNext[0].quitChanges, [{ t: 30, afterStartMs: 20000, phase: "quit", pid: 600, name: "Finder", agentChrome: false }]);
  assert.equal(atNext[0].changed, true);
  assert.deepEqual(atNext[1].frontBefore, { pid: 600, name: "Finder" }, "it is what is in front when start 2 begins");
  assert.equal(atNext[1].changed, false, "and it counts once, for start 1");
  const atDone = analyseStarts(monitorLog(['{"t": 5.0, "front": 500, "name": "TextEdit"}', '{"t": 64.0, "front": 703, "name": "Google Chrome Beta"}']), marks, pids, { monitorEnd: 70 });
  assert.deepEqual(atDone[2].quitChanges, [{ t: 64, afterStartMs: 14000, phase: "quit", pid: 703, name: "Google Chrome Beta", agentChrome: true }]);
  assert.equal(atDone[2].changed, true);
});

test("a front pid of 0 or a name \"?\" (the monitor sees no front app) is a problem, before a start and as a change", () => {
  const blind = analyseStarts(monitorLog(['{"t": 5.0, "front": 0, "name": "?"}']), marks, pids, { monitorEnd: 70 });
  for (const x of blind) assert.match(x.problem ?? "", /the monitor could not see the frontmost app before start \d/);
  assert.equal(exitCode(blind), 1);
  const lost = analyseStarts(monitorLog(['{"t": 5.0, "front": 500, "name": "TextEdit"}', '{"t": 33.0, "front": 0, "name": "?"}']), marks, pids, { monitorEnd: 70 });
  assert.equal(lost[0].problem, null);
  assert.match(lost[1].problem ?? "", /the monitor could not see the frontmost app at \+3000 ms of start 2/);
  const noName = analyseStarts(monitorLog(['{"t": 5.0, "front": 500, "name": "TextEdit"}', '{"t": 13.0, "front": 701, "name": "?"}']), marks, pids, { monitorEnd: 70 });
  assert.match(noName[0].problem ?? "", /could not see the frontmost app at \+3000 ms of start 1/);
});

test("the analysis records whether the monitor saw the launch of the start's own Chrome (information only)", () => {
  const r = analyseStarts(monitorLog(['{"t": 5.0, "front": 500, "name": "TextEdit"}', '{"t": 30.5, "launched": 702, "name": "Google Chrome Beta"}']), marks, pids, { monitorEnd: 70 });
  assert.deepEqual(r.map((x) => x.launchSeen), [false, true, false]);
  assert.deepEqual(r.map((x) => x.problem), [null, null, null]);
});

test("no change at any start gives exit 0; a start with no front app before it is a problem, not a pass", () => {
  const steady = monitorLog(['{"t": 5.0, "front": 500, "name": "TextEdit"}', '{"t": 20.0, "pointer": [1, 1]}']);
  const r = analyseStarts(steady, marks, pids, { monitorEnd: 70 });
  assert.deepEqual(r.map((x) => [x.changed, x.problem]), [[false, null], [false, null], [false, null]]);
  assert.equal(r[0].pointerMoves, 1);
  assert.equal(exitCode(r), 0);

  const late = analyseStarts(monitorLog(['{"t": 25.0, "front": 500, "name": "TextEdit"}']), marks, pids);
  assert.match(late[0].problem ?? "", /no frontmost app before/);
  assert.equal(late[1].problem, null);
  assert.equal(exitCode(late), 1);
  assert.equal(exitCode([]), 1, "no start measured is no pass");
});

test("a monitor that stopped, or that logged nothing for more than 2 s, makes the start a problem, not a pass", () => {
  // It stopped after its first line: no event in any start, so nothing "changed".
  const stopped = analyseStarts(parseMonitorLog('{"t": 5.0, "front": 500, "name": "TextEdit"}\n'), marks, pids, { monitorEnd: 5.1 });
  assert.deepEqual(stopped.map((x) => x.changed), [false, false, false]);
  for (const x of stopped) assert.match(x.problem ?? "", /the monitor stopped/);
  assert.equal(exitCode(stopped), 1);

  // It stopped in the middle of start 2: start 1 is measured.
  const mid = analyseStarts(monitorLog(['{"t": 5.0, "front": 500, "name": "TextEdit"}'], beats(5, 35)), marks, pids, { monitorEnd: 35.9 });
  assert.equal(mid[0].problem, null);
  assert.match(mid[1].problem ?? "", /the monitor stopped/);
  assert.match(mid[2].problem ?? "", /the monitor stopped/);

  // It hung for 4 s during start 2 (no heartbeat), and still ran at the end.
  const hung = analyseStarts(monitorLog(['{"t": 5.0, "front": 500, "name": "TextEdit"}'], beats(5, 65, (t) => t >= 33 && t <= 36)), marks, pids, { monitorEnd: 70 });
  assert.equal(hung[0].problem, null);
  assert.match(hung[1].problem ?? "", /the monitor logged nothing for 5\.0 s during start 2/);
  assert.equal(hung[2].problem, null);
});

test("a bad line in the monitor log makes every start a problem: the lost line can be a front change", () => {
  const log = monitorLog(['{"t": 5.0, "front": 500, "name": "TextEdit"}', '{"t": 33.0, "front": 702, "name": "Bad "name""}']);
  const r = analyseStarts(log, marks, pids, { monitorEnd: 70 });
  for (const x of r) assert.match(x.problem ?? "", /monitor\.jsonl line 2 is not a monitor event/);
});

// ---------- the check as a process ----------

/**
 * A private folder: a darwin preload for start.ts only, a fake monitor, a fake lsappinfo, and a fake
 * Chrome app binary. ABFS_TEST (read by start.ts only when a test sets it) points start.ts at the fake
 * lsappinfo and shortens its waits.
 */
function fakes() {
  const dir = mkdtempSync(join(tmpdir(), "abfs-test-"));
  const preload = join(dir, "darwin.mjs");
  writeFileSync(preload, 'Object.defineProperty(process, "platform", { value: "darwin" });\n');
  // A stand-in for monitor.swift: TextEdit (pid 111) in front, a heartbeat once a second; ABFS_MONITOR_STOP_MS stops it early.
  const monitor = join(dir, "monitor");
  writeFileSync(monitor, `#!${process.execPath}
const line = (o) => process.stdout.write(JSON.stringify({ t: Number((Date.now() / 1000).toFixed(3)), ...o }) + "\\n");
line({ front: 111, name: "TextEdit" });
setInterval(() => line({ alive: true }), 1000);
setTimeout(() => process.exit(0), Number(process.env.ABFS_MONITOR_STOP_MS || Number(process.argv[2]) * 1000));
process.on("SIGTERM", () => process.exit(0));
`);
  // A stand-in for lsappinfo: the front app is pid 111, or ABFS_FAKE_FRONT_PID.
  const lsappinfo = join(dir, "lsappinfo");
  writeFileSync(lsappinfo, `#!${process.execPath}
if (process.argv[2] === "front") console.log("ASN:0x0-0x1:");
else if (process.argv[2] === "info") console.log('"pid"=' + (process.env.ABFS_FAKE_FRONT_PID || 111));
`);
  // A stand-in for giveback.swift: it records its argv, prints the app in front (TextEdit, pid 111) and
  // one request, and stays until SIGTERM (which it records) or its time limit. ABFS_FAKE_GIVEBACK_SILENT:
  // it prints nothing.
  const giveback = join(dir, "giveback");
  writeFileSync(giveback, `#!${process.execPath}
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
const out = process.env.ABFS_FAKE_OUT;
const line = (o) => process.stdout.write(JSON.stringify({ t: Number((Date.now() / 1000).toFixed(3)), ...o }) + "\\n");
writeFileSync(join(out, "giveback-" + process.pid + ".json"), JSON.stringify(process.argv.slice(2)));
if (!process.env.ABFS_FAKE_GIVEBACK_SILENT) { line({ before: 111, name: "TextEdit" }); line({ took: 999, name: "X", gaveBackTo: 111, sent: true }); }
process.on("SIGTERM", () => { writeFileSync(join(out, "giveback-sigterm-" + process.pid), ""); process.exit(0); });
setTimeout(() => process.exit(0), Number(process.argv[3]) * 1000);
`);
  // A stand-in for the Chrome main process: it listens, writes DevToolsActivePort and records a
  // SIGTERM (ABFS_FAKE_IGNORE_TERM: and stays alive; ABFS_FAKE_EXIT_MS: it ends by itself after that time). It starts a decoy that shares the state folder's
  // name as a prefix but lies outside it ("<state folder>-x/profile"), and with ABFS_FAKE_HELPER a
  // "--type=renderer" helper on its own profile that outlives it. Decoy and helper record a SIGTERM
  // and stay alive.
  const out = join(dir, "fake-out");
  mkdirSync(out);
  const bin = join(dir, "X.app", "Contents", "MacOS", "X");
  mkdirSync(join(dir, "X.app", "Contents", "MacOS"), { recursive: true });
  const stay = (name: string) => `process.on("SIGTERM", () => require("node:fs").writeFileSync(require("node:path").join(process.argv[1], "${name}-sigterm-" + process.pid), "")); setInterval(() => {}, 1000);`;
  writeFileSync(bin, `#!${process.execPath}
const { createServer } = require("node:net");
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const profile = process.argv.find((a) => a.startsWith("--user-data-dir=")).slice("--user-data-dir=".length);
const out = process.env.ABFS_FAKE_OUT;
const keep = (script, args) => { const c = spawn(process.execPath, ["-e", script, "--", out, ...args], { detached: true, stdio: "ignore" }); c.unref(); return c.pid; };
const decoy = keep(${JSON.stringify(stay("decoy"))}, ["--user-data-dir=" + dirname(profile) + "-x/profile"]);
const helper = process.env.ABFS_FAKE_HELPER ? keep(${JSON.stringify(stay("helper"))}, ["--type=renderer", "--user-data-dir=" + profile]) : null;
writeFileSync(join(out, "fake-" + process.pid + ".json"), JSON.stringify({ pid: process.pid, decoy, helper, profile }));
process.on("SIGTERM", () => { writeFileSync(join(out, "sigterm-" + process.pid), ""); if (!process.env.ABFS_FAKE_IGNORE_TERM) process.exit(0); });
if (process.env.ABFS_FAKE_EXIT_MS) setTimeout(() => process.exit(0), Number(process.env.ABFS_FAKE_EXIT_MS));
const srv = createServer((s) => s.destroy());
srv.listen(0, "127.0.0.1", () => writeFileSync(join(profile, "DevToolsActivePort"), srv.address().port + "\\n/devtools/browser/fake\\n"));
`);
  for (const f of [monitor, lsappinfo, giveback, bin]) chmodSync(f, 0o755);
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const commandOf = (pid: number) => { try { return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }); } catch { return ""; } };
  type Started = { pid: number; decoy: number; helper: number | null; profile: string };
  const started = () => readdirSync(out).filter((f) => /^fake-\d+\.json$/.test(f)).map((f) => JSON.parse(readFileSync(join(out, f), "utf8")) as Started);
  const test = { lsappinfo, beforeMs: 1500, quitWaitMs: 1500, killWaitMs: 1500, givebackWaitMs: 1500 };
  /** The give-back stand-ins that ran: their pid and argv. */
  const givebacks = () => readdirSync(out).flatMap((f) => { const m = /^giveback-(\d+)\.json$/.exec(f); return m ? [{ pid: Number(m[1]), argv: JSON.parse(readFileSync(join(out, f), "utf8")) as string[] }] : []; });
  return {
    dir, preload, monitor, giveback, out, bin, alive, started, givebacks,
    check: (args: string[], env: Record<string, string> = {}, overrides: Record<string, unknown> = {}) =>
      run(process.execPath, ["--import", preload, START, ...args], { env: { ...process.env, ABFS_FAKE_OUT: out, ABFS_TEST: JSON.stringify({ ...test, ...overrides }), ...env }, timeout: 120_000 })
        .then((r) => ({ code: 0, ...r }), (e) => ({ code: e.code as number, stdout: e.stdout as string, stderr: e.stderr as string })),
    /**
     * The check as a child that the test can interrupt: SIGINT once `until` is in its marks, to the check
     * only, or with `group` to its whole process group (the check and its CLI child), as a terminal's Ctrl-C does.
     */
    interrupt: (args: string[], outDir: string, until: RegExp, group = false) => new Promise<{ code: number | null; stderr: string }>((done) => {
      const c = spawn(process.execPath, ["--import", preload, START, ...args, "--out-dir", outDir], { env: { ...process.env, ABFS_FAKE_OUT: out, ABFS_TEST: JSON.stringify(test) }, stdio: ["ignore", "ignore", "pipe"], detached: group });
      let stderr = "";
      c.stderr!.on("data", (b) => (stderr += b));
      const poll = setInterval(() => {
        let marks = "";
        try { marks = readFileSync(join(outDir, "marks.jsonl"), "utf8"); } catch { /* not yet */ }
        if (until.test(marks)) { clearInterval(poll); if (group) process.kill(-c.pid!, "SIGINT"); else c.kill("SIGINT"); }
      }, 100);
      c.on("close", (code) => { clearInterval(poll); done({ code, stderr }); });
    }),
    /** Ends this test's own fakes (each checked by its command line) and removes a state folder that its own run left. */
    cleanup: () => {
      for (const f of started()) {
        for (const pid of [f.pid, f.decoy, f.helper]) if (pid && alive(pid) && commandOf(pid).includes(dir)) process.kill(pid, "SIGKILL");
      }
      for (const g of givebacks()) if (alive(g.pid) && commandOf(g.pid).includes(dir)) process.kill(g.pid, "SIGKILL");
      for (const f of started()) {
        const stateDir = dirname(f.profile);
        if (/^\/tmp\/abfs-(\d+|s)-[A-Za-z0-9]{6}$/.test(stateDir) && existsSync(stateDir)) rmSync(stateDir, { recursive: true });
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
const jsonl = (file: string) => readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

test("the start check, run here, refuses and starts nothing (exit 2), and makes no output folder", async () => {
  const f = fakes();
  try {
    const outDir = join(f.dir, "results");
    const noConsent = await run(process.execPath, [START, "--chrome-bin", BETA, "--monitor", MONITOR, "--out-dir", outDir]).then(() => 0, (e) => e);
    assert.equal(noConsent.code, 2);
    assert.match(noConsent.stderr, /--on-my-screen/);
    if (process.platform !== "darwin") {
      const linux = await run(process.execPath, [START, ...full.slice(0, -1), outDir]).then(() => 0, (e) => e);
      assert.equal(linux.code, 2);
      assert.match(linux.stderr, /macOS only/);
    }
    const relative = await f.check(["--on-my-screen", "--chrome-bin", "X.app/Contents/MacOS/X", "--monitor", f.monitor, "--out-dir", outDir]);
    assert.equal(relative.code, 2);
    assert.match(relative.stderr, /--chrome-bin must be an absolute path/);
    assert.equal(existsSync(outDir), false, "a refused run writes nothing");
    assert.deepEqual(f.started(), [], "and starts nothing");
    const launcher = await run(process.execPath, [LAUNCH_HIDDEN, "--state-dir", "relative"]).then(() => 0, (e) => e);
    assert.equal(launcher.code, 2, "the hidden variant's launcher needs absolute paths, as the CLI does");
    assert.match(launcher.stderr, /usage: node test\/live\/takeover\/launch-hidden\.ts/);
  } finally { f.cleanup(); }
});

const onLinux = { skip: process.platform === "darwin" ? "on macOS the launch would go through the real open(1) with the fake app" : false, timeout: 120_000 };

test("the check's whole flow with a fake Chrome: it quits only its own Chrome, deletes only its own folder, and a start not through open -g is no pass", onLinux, async () => {
  const f = fakes();
  try {
    const outDir = join(f.dir, "results");
    const r = await f.check(["--on-my-screen", "--chrome-bin", f.bin, "--monitor", f.monitor, "--out-dir", outDir, "--starts", "1", "--after-ms", "1000"]);
    assert.equal(r.code, 1, r.stderr);
    const results = jsonl(join(outDir, "results.jsonl"));
    assert.equal(results.length, 1);
    assert.match(results[0].problem, /the start did not go through open -n -g/, "on Linux the CLI spawns the binary itself");
    assert.equal(results[0].changed, false);
    assert.deepEqual(results[0].quit, { code: 0, ended: true, killed: false });
    const [fake] = f.started();
    assert.equal(results[0].chromePid, fake.pid);
    assert.equal(fake.profile, join(results[0].stateDir, "profile"));
    assert.ok(existsSync(join(f.out, `sigterm-${fake.pid}`)), "the fake on the check's own profile got SIGTERM");
    assert.equal(f.alive(fake.pid), false);
    assert.ok(f.alive(fake.decoy), "the decoy beside the state folder still runs");
    assert.equal(existsSync(join(f.out, `decoy-sigterm-${fake.decoy}`)), false, "and got no signal");
    assert.equal(existsSync(results[0].stateDir), false, "the check deleted the state folder that it made");
    assert.equal(results[0].stateDeleted, true);
    const summary = JSON.parse(readFileSync(join(outDir, "summary.json"), "utf8"));
    assert.equal(summary.ok, false);
    assert.equal(summary.monitorStopped, null);
    assert.equal(summary.liveness, null);
  } finally { f.cleanup(); }
});

test("the liveness check before start 1: a monitor that does not show lsappinfo's front app, or no lsappinfo, starts no Chrome (exit 1)", onLinux, async () => {
  const f = fakes();
  try {
    const mismatch = await f.check(["--on-my-screen", "--chrome-bin", f.bin, "--monitor", f.monitor, "--out-dir", join(f.dir, "a")], { ABFS_FAKE_FRONT_PID: "222" });
    assert.equal(mismatch.code, 1, mismatch.stderr);
    assert.match(JSON.parse(readFileSync(join(f.dir, "a", "summary.json"), "utf8")).liveness, /pid 111.*pid 222/);
    assert.deepEqual(jsonl(join(f.dir, "a", "results.jsonl")), []);
    const missing = await f.check(["--on-my-screen", "--chrome-bin", f.bin, "--monitor", f.monitor, "--out-dir", join(f.dir, "b")], {}, { lsappinfo: join(f.dir, "no-such-lsappinfo") });
    assert.equal(missing.code, 1, missing.stderr);
    assert.match(JSON.parse(readFileSync(join(f.dir, "b", "summary.json"), "utf8")).liveness, /lsappinfo/);
    assert.deepEqual(f.started(), [], "no Chrome started");
  } finally { f.cleanup(); }
});

test("a monitor that stops during a start: that start is a problem, and the check starts no more Chrome", onLinux, async () => {
  const f = fakes();
  try {
    const outDir = join(f.dir, "results");
    const r = await f.check(["--on-my-screen", "--chrome-bin", f.bin, "--monitor", f.monitor, "--out-dir", outDir, "--starts", "2", "--after-ms", "3000"], { ABFS_MONITOR_STOP_MS: "4000" });
    assert.equal(r.code, 1, r.stderr);
    const results = jsonl(join(outDir, "results.jsonl"));
    assert.equal(results.length, 1, "no second start after the monitor stopped");
    assert.match(results[0].problem, /the monitor stopped/);
    assert.match(results[0].problem, /did not go through open -n -g/, "all the causes, not the first only");
    assert.equal(f.started().length, 1);
    const summary = JSON.parse(readFileSync(join(outDir, "summary.json"), "utf8"));
    assert.equal(typeof summary.monitorStopped, "string");
    assert.equal(existsSync(results[0].stateDir), false);
  } finally { f.cleanup(); }
});

test("--same-profile: one folder for all starts, so the later starts restart a used profile; the folder goes at the end", onLinux, async () => {
  const f = fakes();
  try {
    const outDir = join(f.dir, "results");
    const r = await f.check(["--on-my-screen", "--chrome-bin", f.bin, "--monitor", f.monitor, "--out-dir", outDir, "--starts", "2", "--after-ms", "1000", "--same-profile"]);
    assert.equal(r.code, 1, r.stderr);
    const results = jsonl(join(outDir, "results.jsonl"));
    assert.deepEqual(results.map((x) => x.profile), ["fresh", "used"]);
    assert.equal(results[0].stateDir, results[1].stateDir);
    assert.match(results[0].stateDir, /^\/tmp\/abfs-s-/);
    assert.deepEqual(results.map((x) => x.stateDeleted), [false, true]);
    assert.equal(existsSync(results[0].stateDir), false);
    const fakesStarted = f.started();
    assert.equal(fakesStarted.length, 2);
    assert.deepEqual(new Set(fakesStarted.map((x) => x.profile)), new Set([join(results[0].stateDir, "profile")]));
    for (const x of fakesStarted) assert.ok(existsSync(join(f.out, `sigterm-${x.pid}`)));
    assert.equal(JSON.parse(readFileSync(join(outDir, "summary.json"), "utf8")).mode, "same-profile");
  } finally { f.cleanup(); }
});

test("a Chrome that ignores SIGTERM gets SIGKILL (only it), and --same-profile then stops: the next start would be a crash restart", onLinux, async () => {
  const f = fakes();
  try {
    const outDir = join(f.dir, "results");
    const r = await f.check(["--on-my-screen", "--chrome-bin", f.bin, "--monitor", f.monitor, "--out-dir", outDir, "--starts", "2", "--after-ms", "1000", "--same-profile"], { ABFS_FAKE_IGNORE_TERM: "1" });
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /sent SIGKILL/);
    const results = jsonl(join(outDir, "results.jsonl"));
    assert.equal(results.length, 1, "no restart after a SIGKILL");
    assert.deepEqual(results[0].quit, { code: 0, ended: true, killed: true });
    const [fake] = f.started();
    assert.ok(existsSync(join(f.out, `sigterm-${fake.pid}`)), "quit sent SIGTERM first");
    assert.equal(f.alive(fake.pid), false, "SIGKILL ended it");
    assert.ok(f.alive(fake.decoy));
    assert.equal(existsSync(join(f.out, `decoy-sigterm-${fake.decoy}`)), false, "the decoy got no signal");
    assert.equal(existsSync(results[0].stateDir), false, "no process names the folder any more, so it is deleted");
  } finally { f.cleanup(); }
});

test("a process that still names the profile after SIGTERM and SIGKILL: \"did not end\", the folder stays, and no more starts", onLinux, async () => {
  const f = fakes();
  try {
    const outDir = join(f.dir, "results");
    const r = await f.check(["--on-my-screen", "--chrome-bin", f.bin, "--monitor", f.monitor, "--out-dir", outDir, "--starts", "2", "--after-ms", "1000"], { ABFS_FAKE_HELPER: "1" });
    assert.equal(r.code, 1, r.stderr);
    const results = jsonl(join(outDir, "results.jsonl"));
    assert.equal(results.length, 1, "no more starts");
    assert.match(results[0].problem, /did not end; its state folder is left in place/);
    assert.equal(results[0].quit.ended, false);
    assert.equal(results[0].quit.killed, false, "the main process ended; the check never signals a helper");
    assert.ok(existsSync(results[0].stateDir), "the folder stays while a process names it");
    assert.match(r.stderr, new RegExp(`left in place.*${results[0].stateDir}`));
    const [fake] = f.started();
    assert.ok(fake.helper && f.alive(fake.helper));
    assert.equal(existsSync(join(f.out, `helper-sigterm-${fake.helper}`)), false, "the helper got no signal");
    assert.equal(existsSync(join(f.out, `decoy-sigterm-${fake.decoy}`)), false, "the decoy got no signal");
  } finally { f.cleanup(); }
});

test("Ctrl-C in --same-profile mode: the check names the shared folder that it leaves, or deletes it when no process names it", onLinux, async () => {
  const f = fakes();
  try {
    const args = ["--on-my-screen", "--chrome-bin", f.bin, "--monitor", f.monitor, "--starts", "2", "--after-ms", "3000", "--same-profile"];
    // During start 1: its Chrome runs, so it gets SIGTERM and the folder stays.
    const during = await f.interrupt(args, join(f.dir, "a"), /"end launch 1"/);
    assert.equal(during.code, 130);
    const [fake] = f.started();
    const shared = dirname(fake.profile);
    assert.match(shared, /^\/tmp\/abfs-s-/);
    assert.ok(during.stderr.includes(`left in place (its Chrome, pid ${fake.pid}, got SIGTERM): ${shared}\n`), during.stderr);
    for (let i = 0; i < 50 && !existsSync(join(f.out, `sigterm-${fake.pid}`)); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(existsSync(join(f.out, `sigterm-${fake.pid}`)));
    // Between start 1 and start 2: no process names the folder, so the check deletes it.
    const between = await f.interrupt(args, join(f.dir, "b"), /"end quit 1"/);
    assert.equal(between.code, 130);
    const second = f.started().find((x) => x.pid !== fake.pid)!;
    assert.ok(between.stderr.includes(`deleted ${dirname(second.profile)}: no process names it\n`), between.stderr);
    assert.equal(existsSync(dirname(second.profile)), false);
  } finally { f.cleanup(); }
});

test("a Chrome that ends by itself before the quit is no pass: the start may have shown no window", onLinux, async () => {
  const f = fakes();
  try {
    const outDir = join(f.dir, "results");
    const r = await f.check(["--on-my-screen", "--chrome-bin", f.bin, "--monitor", f.monitor, "--out-dir", outDir, "--starts", "1", "--after-ms", "3000"], { ABFS_FAKE_EXIT_MS: "1500" });
    assert.equal(r.code, 1, r.stderr);
    const [result] = jsonl(join(outDir, "results.jsonl"));
    assert.equal(typeof result.chromePid, "number", "the Chrome ran after the launch");
    assert.match(result.problem, /Chrome ended by itself before the quit \(quit found no Chrome\): the start may have shown no window/);
    assert.equal(existsSync(join(f.out, `sigterm-${result.chromePid}`)), false, "quit found nothing to signal");
  } finally { f.cleanup(); }
});

test("Ctrl-C to the process group just after a launch began: the check keeps that start's folder and names it", onLinux, async () => {
  const f = fakes();
  let left: string | undefined;
  try {
    const r = await f.interrupt(["--on-my-screen", "--chrome-bin", f.bin, "--monitor", f.monitor, "--starts", "1", "--after-ms", "3000"], join(f.dir, "results"), /"start launch 1"/, true);
    assert.equal(r.code, 130);
    left = /left in place \([^)]*\): (\/tmp\/abfs-1-[A-Za-z0-9]{6})\n/.exec(r.stderr)?.[1];
    assert.ok(left, r.stderr);
    assert.ok(existsSync(left), "a start was in progress: its Chrome can still be starting on that folder");
    assert.doesNotMatch(r.stderr, /deleted \/tmp\/abfs-/);
    // The CLI child may have started the fake before it got SIGINT; give it time to show, so that cleanup ends it.
    for (let i = 0; i < 30 && !f.started().length; i++) await new Promise((res) => setTimeout(res, 100));
  } finally {
    f.cleanup();
    if (left && /^\/tmp\/abfs-1-[A-Za-z0-9]{6}$/.test(left) && existsSync(left)) rmSync(left, { recursive: true }); // this test's own run made it
  }
});

test("--variant hidden: launch-hidden.ts runs the launch command with its hook; on Linux there is no open -n -g -j, so the start is no pass", onLinux, async () => {
  const f = fakes();
  try {
    const outDir = join(f.dir, "results");
    const r = await f.check(["--on-my-screen", "--chrome-bin", f.bin, "--monitor", f.monitor, "--out-dir", outDir, "--starts", "1", "--after-ms", "1000", "--variant", "hidden"]);
    assert.equal(r.code, 1, r.stderr);
    const [result] = jsonl(join(outDir, "results.jsonl"));
    assert.equal(result.variant, "hidden");
    assert.equal(result.launch.code, 0, "the launcher printed launch's JSON document and exited 0");
    assert.equal(result.launch.started, true);
    assert.match(result.problem, /the start did not go through open -n -g -j \(launches\.log\)/);
    const [fake] = f.started();
    assert.equal(fake.profile, join(result.stateDir, "profile"));
    assert.deepEqual(result.quit, { code: 0, ended: true, killed: false });
    assert.equal(existsSync(result.stateDir), false);
  } finally { f.cleanup(); }
});

test("--variant give-back: the helper runs from before each launch to its quit, gets the app bundle, and its log reaches the results", onLinux, async () => {
  const f = fakes();
  try {
    const outDir = join(f.dir, "results");
    const r = await f.check(["--on-my-screen", "--chrome-bin", f.bin, "--monitor", f.monitor, "--out-dir", outDir, "--starts", "2", "--after-ms", "1000", "--variant", "give-back", "--giveback", f.giveback]);
    assert.equal(r.code, 1, r.stderr);
    const results = jsonl(join(outDir, "results.jsonl"));
    assert.equal(results.length, 2);
    for (const x of results) {
      assert.equal(x.variant, "give-back");
      assert.deepEqual(x.giveBack.before, { pid: 111, name: "TextEdit" });
      assert.deepEqual(x.giveBack.requests.map((q: { took: number; sent: boolean }) => [q.took, q.sent]), [[999, true]]);
    }
    const helpers = f.givebacks();
    assert.equal(helpers.length, 2, "one helper per start");
    for (const g of helpers) {
      assert.equal(g.argv[0], join(f.dir, "X.app"), "the bundle of --chrome-bin");
      assert.match(g.argv[1], /^\d+$/, "a time limit, so that a helper left behind ends by itself");
      assert.ok(existsSync(join(f.out, `giveback-sigterm-${g.pid}`)), "the check ended the helper");
      assert.equal(f.alive(g.pid), false);
    }
    const marks = jsonl(join(outDir, "marks.jsonl")).map((m) => m.what);
    for (const n of [1, 2]) {
      assert.ok(marks.indexOf(`giveback ready ${n}`) >= 0 && marks.indexOf(`giveback ready ${n}`) < marks.indexOf(`start launch ${n}`), "the helper saw the front app before the launch");
      assert.ok(marks.indexOf(`giveback stopped ${n}`) < marks.indexOf(`start quit ${n}`), "and it stops before the quit");
    }
    assert.equal(JSON.parse(readFileSync(join(outDir, "summary.json"), "utf8")).variant, "give-back");
  } finally { f.cleanup(); }
});

test("--variant give-back: a helper that names no front app ends the check before it starts a Chrome", onLinux, async () => {
  const f = fakes();
  try {
    const outDir = join(f.dir, "results");
    const r = await f.check(["--on-my-screen", "--chrome-bin", f.bin, "--monitor", f.monitor, "--out-dir", outDir, "--variant", "give-back", "--giveback", f.giveback], { ABFS_FAKE_GIVEBACK_SILENT: "1" });
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /the give-back helper named no front app within 1\.5 s: no start 1/);
    assert.deepEqual(f.started(), [], "no Chrome started");
    assert.deepEqual(jsonl(join(outDir, "results.jsonl")), []);
    const [g] = f.givebacks();
    assert.ok(existsSync(join(f.out, `giveback-sigterm-${g.pid}`)), "the check ended the helper");
    assert.doesNotMatch(r.stderr, /left in place|deleted \/tmp\/abfs-/, "it made no state folder for that start");
  } finally { f.cleanup(); }
});
