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
import { analyseStarts, exitCode, livenessProblem, lsappinfoPid, parseMonitorLog, startArgs, type Mark } from "./live/takeover/focus.ts";
import { ROOT } from "./helpers.ts";

const run = promisify(execFile);
const START = join(ROOT, "test", "live", "takeover", "start.ts");
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
  assert.deepEqual(r.options, { chromeBin: BETA, starts: 3, monitor: MONITOR, outDir: "/tmp/abfs-out", afterMs: 10_000, keepState: false, sameProfile: false });
  const five = startArgs([...full, "--starts", "5", "--after-ms", "4000", "--keep-state", "--same-profile"], mac);
  assert.ok(five.ok);
  assert.equal(five.options.starts, 5);
  assert.equal(five.options.afterMs, 4000);
  assert.equal(five.options.keepState, true);
  assert.equal(five.options.sameProfile, true);
  for (const n of ["0", "-1", "2.5", "x", "21", ""]) assert.match(refused([...full, "--starts", n]), /--starts/, n);
  for (const ms of ["999", "x", "120001"]) assert.match(refused([...full, "--after-ms", ms]), /--after-ms/, ms);
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
  assert.deepEqual(r[0], { start: 1, frontBefore: { pid: 500, name: "TextEdit" }, changed: false, changes: [], quitChanges: [], quitCounted: false, pointerMoves: 0, launchSeen: false, problem: null });
  assert.deepEqual(r[1].changes, [
    { t: 33.2, afterStartMs: 3200, phase: "after", pid: 702, name: "Google Chrome Beta", agentChrome: true },
    { t: 35.1, afterStartMs: 5100, phase: "after", pid: 500, name: "TextEdit", agentChrome: false },
  ]);
  assert.equal(r[1].pointerMoves, 1, "the pointer moved: the change back can be the person's click");
  assert.equal(exitCode(r), 1);
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
  // A stand-in for the Chrome main process: it listens, writes DevToolsActivePort and records a
  // SIGTERM (ABFS_FAKE_IGNORE_TERM: and stays alive). It starts a decoy that shares the state folder's
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
const srv = createServer((s) => s.destroy());
srv.listen(0, "127.0.0.1", () => writeFileSync(join(profile, "DevToolsActivePort"), srv.address().port + "\\n/devtools/browser/fake\\n"));
`);
  for (const f of [monitor, lsappinfo, bin]) chmodSync(f, 0o755);
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const commandOf = (pid: number) => { try { return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }); } catch { return ""; } };
  type Started = { pid: number; decoy: number; helper: number | null; profile: string };
  const started = () => readdirSync(out).filter((f) => /^fake-\d+\.json$/.test(f)).map((f) => JSON.parse(readFileSync(join(out, f), "utf8")) as Started);
  const test = { lsappinfo, beforeMs: 1500, quitWaitMs: 1500, killWaitMs: 1500 };
  return {
    dir, preload, monitor, out, bin, alive, started,
    check: (args: string[], env: Record<string, string> = {}, overrides: Record<string, unknown> = {}) =>
      run(process.execPath, ["--import", preload, START, ...args], { env: { ...process.env, ABFS_FAKE_OUT: out, ABFS_TEST: JSON.stringify({ ...test, ...overrides }), ...env }, timeout: 120_000 })
        .then((r) => ({ code: 0, ...r }), (e) => ({ code: e.code as number, stdout: e.stdout as string, stderr: e.stderr as string })),
    /** The check as a child that the test can interrupt: Ctrl-C (SIGINT) once `until` is in its marks. */
    interrupt: (args: string[], outDir: string, until: RegExp) => new Promise<{ code: number | null; stderr: string }>((done) => {
      const c = spawn(process.execPath, ["--import", preload, START, ...args, "--out-dir", outDir], { env: { ...process.env, ABFS_FAKE_OUT: out, ABFS_TEST: JSON.stringify(test) }, stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      c.stderr!.on("data", (b) => (stderr += b));
      const poll = setInterval(() => {
        let marks = "";
        try { marks = readFileSync(join(outDir, "marks.jsonl"), "utf8"); } catch { /* not yet */ }
        if (until.test(marks)) { clearInterval(poll); c.kill("SIGINT"); }
      }, 100);
      c.on("close", (code) => { clearInterval(poll); done({ code, stderr }); });
    }),
    /** Ends this test's own fakes (each checked by its command line) and removes a state folder that its own run left. */
    cleanup: () => {
      for (const f of started()) {
        for (const pid of [f.pid, f.decoy, f.helper]) if (pid && alive(pid) && commandOf(pid).includes(dir)) process.kill(pid, "SIGKILL");
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
