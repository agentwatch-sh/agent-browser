// The pure parts of the live start check (test/live/takeover/start.ts, ab-b84.11): its argument guard
// and the analysis of a monitor log (which start changed the frontmost app). The check itself starts
// a real Chrome on a person's screen, on macOS only, so it is not part of `npm test`; here it only
// refuses, and starts nothing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { analyseStarts, exitCode, parseMonitorLog, startArgs, type Mark } from "./live/takeover/focus.ts";
import { ROOT } from "./helpers.ts";

const run = promisify(execFile);
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
  const cft = "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
  assert.match(refused(["--on-my-screen", "--chrome-bin", cft, "--monitor", MONITOR, "--out-dir", "/tmp/abfs-out"], { ...mac, exists: () => true }), /Chrome for Testing/);
  assert.match(refused(["--on-my-screen", "--chrome-bin", STABLE, "--monitor", MONITOR, "--out-dir", "/tmp/abfs-out"], { ...mac, exists: (p) => p === MONITOR }), /no such file/);
});

test("the start check needs the compiled monitor and an output folder", () => {
  assert.match(refused(["--on-my-screen", "--chrome-bin", BETA, "--out-dir", "/tmp/abfs-out"]), /--monitor/);
  assert.match(refused(["--on-my-screen", "--chrome-bin", BETA, "--monitor", "/tmp/nope", "--out-dir", "/tmp/abfs-out"]), /--monitor.*no such file|no such file.*monitor/);
  assert.match(refused(["--on-my-screen", "--chrome-bin", BETA, "--monitor", MONITOR]), /--out-dir/);
});

test("--starts is 3 by default and a whole number from 1 to 20; --after-ms is 10 s by default", () => {
  const r = startArgs(full, mac);
  assert.ok(r.ok);
  assert.deepEqual(r.options, { chromeBin: BETA, starts: 3, monitor: MONITOR, outDir: "/tmp/abfs-out", afterMs: 10_000, keepState: false });
  const five = startArgs([...full, "--starts", "5", "--after-ms", "4000", "--keep-state"], mac);
  assert.ok(five.ok);
  assert.equal(five.options.starts, 5);
  assert.equal(five.options.afterMs, 4000);
  assert.equal(five.options.keepState, true);
  for (const n of ["0", "-1", "2.5", "x", "21", ""]) assert.match(refused([...full, "--starts", n]), /--starts/, n);
  for (const ms of ["999", "x", "120001"]) assert.match(refused([...full, "--after-ms", ms]), /--after-ms/, ms);
});

test("the start check refuses an unknown flag or a stray argument", () => {
  assert.match(refused([...full, "--login"]), /--login|unknown/i);
  assert.match(refused([...full, "extra"]), /extra|argument/i);
});

test("the monitor log: one event per JSON line; other lines and a cut last line are skipped", () => {
  const text = [
    '{"t": 100.000, "front": 500, "name": "Terminal"}',
    "monitor: started",
    '{"t": 100.050, "pointer": [10, 20]}',
    '{"t": 101.5',
  ].join("\n");
  assert.deepEqual(parseMonitorLog(text), [{ t: 100, front: 500, name: "Terminal" }, { t: 100.05, pointer: [10, 20] }]);
});

// Three starts. The operator's TextEdit (pid 500) is in front all the time, except that start 2's
// agent Chrome (pid 702) takes it 1.2 s after that start's launch ended, and the operator clicks back.
const marks: Mark[] = [
  { t: 10, what: "start launch 1" }, { t: 12, what: "end launch 1" }, { t: 22, what: "start quit 1" }, { t: 23, what: "end quit 1" },
  { t: 30, what: "start launch 2" }, { t: 32, what: "end launch 2" }, { t: 42, what: "start quit 2" }, { t: 43, what: "end quit 2" },
  { t: 50, what: "start launch 3" }, { t: 52, what: "end launch 3" }, { t: 62, what: "start quit 3" }, { t: 63, what: "end quit 3" },
];
const pids = { 1: 701, 2: 702, 3: 703 };

test("the analysis names the start that changed the frontmost app, when, and to which app", () => {
  const log = parseMonitorLog([
    '{"t": 5.0, "front": 500, "name": "TextEdit"}',
    '{"t": 33.2, "front": 702, "name": "Google Chrome Beta"}',
    '{"t": 35.0, "pointer": [400, 300]}',
    '{"t": 35.1, "front": 500, "name": "TextEdit"}',
  ].join("\n"));
  const r = analyseStarts(log, marks, pids);
  assert.deepEqual(r.map((x) => [x.start, x.changed]), [[1, false], [2, true], [3, false]]);
  assert.deepEqual(r[0], { start: 1, frontBefore: { pid: 500, name: "TextEdit" }, changed: false, changes: [], quitChanges: [], pointerMoves: 0, problem: null });
  assert.deepEqual(r[1].changes, [
    { t: 33.2, afterStartMs: 3200, phase: "after", pid: 702, name: "Google Chrome Beta", agentChrome: true },
    { t: 35.1, afterStartMs: 5100, phase: "after", pid: 500, name: "TextEdit", agentChrome: false },
  ]);
  assert.equal(r[1].pointerMoves, 1, "the pointer moved: the change back can be the person's click");
  assert.equal(exitCode(r), 1);
});

test("a change while the launch command runs is in the launch phase; another app (a system prompt) counts too", () => {
  const log = parseMonitorLog([
    '{"t": 5.0, "front": 500, "name": "TextEdit"}',
    '{"t": 11.0, "front": 900, "name": "SecurityAgent"}',
  ].join("\n"));
  const r = analyseStarts(log, marks, pids);
  assert.deepEqual(r[0].changes, [{ t: 11, afterStartMs: 1000, phase: "launch", pid: 900, name: "SecurityAgent", agentChrome: false }]);
  assert.equal(r[1].frontBefore?.name, "SecurityAgent", "the next start begins with what is in front then");
  assert.equal(r[1].changed, false);
});

test("a change while the check quits its own Chrome is reported apart and is not a change of the start", () => {
  const log = parseMonitorLog([
    '{"t": 5.0, "front": 701, "name": "Google Chrome Beta"}',
    '{"t": 22.5, "front": 500, "name": "TextEdit"}',
  ].join("\n"));
  const r = analyseStarts(log, marks, pids);
  assert.equal(r[0].changed, false);
  assert.deepEqual(r[0].quitChanges, [{ t: 22.5, afterStartMs: 12500, phase: "quit", pid: 500, name: "TextEdit", agentChrome: false }]);
});

test("no change at any start gives exit 0; a start with no front app before it is a problem, not a pass", () => {
  const steady = parseMonitorLog('{"t": 5.0, "front": 500, "name": "TextEdit"}\n{"t": 20.0, "pointer": [1, 1]}');
  const r = analyseStarts(steady, marks, pids);
  assert.deepEqual(r.map((x) => x.changed), [false, false, false]);
  assert.equal(r[0].pointerMoves, 1);
  assert.equal(exitCode(r), 0);

  const late = analyseStarts(parseMonitorLog('{"t": 25.0, "front": 500, "name": "TextEdit"}'), marks, pids);
  assert.match(late[0].problem ?? "", /no frontmost app before/);
  assert.equal(late[1].problem, null);
  assert.equal(exitCode(late), 1);
  assert.equal(exitCode([]), 1, "no start measured is no pass");
});

test("the start check, run here, refuses and starts nothing (exit 2)", async () => {
  const script = join(ROOT, "test", "live", "takeover", "start.ts");
  const noConsent = await run(process.execPath, [script, "--chrome-bin", BETA, "--monitor", MONITOR, "--out-dir", "/tmp/abfs-out"]).then(() => 0, (e) => e);
  assert.equal(noConsent.code, 2);
  assert.match(noConsent.stderr, /--on-my-screen/);
  if (process.platform !== "darwin") {
    const linux = await run(process.execPath, [script, ...full]).then(() => 0, (e) => e);
    assert.equal(linux.code, 2);
    assert.match(linux.stderr, /macOS only/);
  }
});
