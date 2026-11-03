// The live start check (macOS, ab-b84.11): an agent Chrome start must never take the operator's focus.
// It starts the agent Chrome N times through agent-browser's real start path (the `launch` command, run
// as the CLI, as an agent session runs it), while monitor.swift logs the frontmost app and the pointer:
// before the start, while `launch` runs, and for --after-ms after it. Then it quits that Chrome with
// `quit` (a signal to the Chrome main process on the check's own profile, never another Chrome) and
// waits until no process names the state folder in its command line (the main process, its helpers,
// crashpad's --database=). If a process still names it 15 s after `quit`, the check sends SIGKILL to
// the main process on its own profile (looked up again; never a helper or another Chrome), says so on
// stderr, records "killed", and waits 5 s more. If a process still names the folder then, the check
// leaves the folder in place and starts no more Chrome.
//
// Two modes:
//   default         each start on a new, empty state folder (/tmp/abfs-<n>-XXXXXX, short because the
//                   proxy socket path must fit in 103 bytes): every start is Chrome's first start of a
//                   profile (the first-run path, which AGENT_ARGS turn off with --no-first-run).
//   --same-profile  one new state folder (/tmp/abfs-s-XXXXXX) for all N starts: start 1 is a first
//                   start, and starts 2..N restart that profile after a clean quit, as an agent's next
//                   start does. No session restore: the profile opens the start URL that `launch` gives
//                   (chrome://inspect/#remote-debugging), because "Continue where you left off" is a
//                   signed setting that the check does not set. After a SIGKILL the check stops: the
//                   next start would be a crash restart, not a clean one.
// The check deletes each state folder that it made once no process names it (--keep-state keeps them).
// It runs only `launch` and `quit`: `launch` probes the debugging port with a plain TCP connect, so the
// check opens no debugging WebSocket and Chrome shows no "Allow remote debugging?" prompt. It does not
// measure a change of the Space. It refuses to run without --on-my-screen (the windows reach the
// person's screen), and with an --out-dir that holds the logs of an earlier run. Not part of `npm
// test` (test/takeover-start.test.ts runs its flow with a fake Chrome; only those tests set ABFS_TEST,
// a JSON object that replaces the lsappinfo binary and shortens the waits).
//
//   swiftc -swift-version 5 -O test/live/takeover/monitor.swift -o /tmp/abfs-monitor
//   node test/live/takeover/start.ts --on-my-screen --monitor /tmp/abfs-monitor --out-dir <dir> \
//     --chrome-bin "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta" [--starts 3] [--after-ms 10000] [--same-profile]
//   python3 -I test/live/takeover/analyse.py <dir> [<Chrome pid> ...]   (the timeline: each front change and the start it fell in)
//
// Keep a window of your own in front, and do not touch the mouse or the keyboard until the summary
// prints: the monitor cannot tell your click from Chrome's activation (results count the pointer moves).
// Before start 1 the check compares the monitor's front app with `lsappinfo front`: a monitor that
// cannot see the front app, a different pid, or no answer from lsappinfo ends the check (exit 1, no
// start). A start is a problem, never a pass, when the monitor stopped, logged nothing for more than 2 s
// (it beats once a second), or could not see the front app (pid 0) during that start; after the monitor
// stops, the check starts no more Chrome. It writes <dir>/monitor.jsonl, <dir>/marks.jsonl,
// <dir>/results.jsonl (one JSON line per start: the app in front before, each change, when, in which
// phase, and whether the new front app is this start's own Chrome; every change from the quit to the
// next start counts too) and <dir>/summary.json, and prints the summary. Exit 0: every start was
// measured and none changed the frontmost app; 1: a start changed it, or a start could not be measured;
// 2: a usage error; 130: stopped with Ctrl-C (the check sends SIGTERM to its own Chromes, deletes a
// folder of its own that no process names and that no start is using, and names on stderr each folder
// that it leaves). A start whose Chrome ended before the quit is a problem: it may have shown no window.

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { agentChromePid, appBundle } from "../../../src/agent.ts";
import { resolveOptions } from "../../../src/options.ts";
import { analyseStarts, exitCode, livenessProblem, lsappinfoPid, parseMonitorLog, startArgs, USAGE, type Mark } from "./focus.ts";

const parsed = startArgs(process.argv.slice(2), { platform: process.platform, exists: existsSync });
if (!parsed.ok) {
  process.stderr.write(`${parsed.message}\n${USAGE}\n`);
  process.exit(2);
}
const o = parsed.options;
let testing: { lsappinfo?: string; beforeMs?: number; quitWaitMs?: number; killWaitMs?: number } = {};
if (process.env.ABFS_TEST) {
  try { testing = JSON.parse(process.env.ABFS_TEST); } catch { process.stderr.write("ABFS_TEST (tests only) must be a JSON object\n"); process.exit(2); }
}
const BIN_JS = fileURLToPath(new URL("../../../bin/agent-browser.js", import.meta.url));
const LSAPPINFO = testing.lsappinfo ?? "/usr/bin/lsappinfo";
const LAUNCH_TIMEOUT_MS = 60_000, QUIT_TIMEOUT_MS = 30_000, GAP_MS = 3000;
const BEFORE_MS = testing.beforeMs ?? 3000, QUIT_WAIT_MS = testing.quitWaitMs ?? 15_000, KILL_WAIT_MS = testing.killWaitMs ?? 5000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

mkdirSync(o.outDir, { recursive: true });
const MARKS = join(o.outDir, "marks.jsonl"), MONITOR_LOG = join(o.outDir, "monitor.jsonl"), RESULTS = join(o.outDir, "results.jsonl");
writeFileSync(MARKS, "");
writeFileSync(RESULTS, "");
function mark(what: string, detail?: unknown) {
  appendFileSync(MARKS, JSON.stringify({ t: Date.now() / 1000, what, ...(detail === undefined ? {} : { detail }) }) + "\n");
}

/** The Chrome main process on this state folder's own profile (its --user-data-dir), if it runs. */
const ownPid = (stateDir: string) => agentChromePid(resolveOptions({ stateDir }));
/** Whether any process names this (unique, mkdtemp) state folder, or a path in it, as an argument. */
function usesFolder(stateDir: string): boolean {
  const literal = stateDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const named = new RegExp(`(^|[\\s=])${literal}(?=/|\\s|$)`);
  return execFileSync("ps", ["axww", "-o", "pid=,command="], { encoding: "utf8", maxBuffer: 64 << 20 }).split("\n").some((line) => named.test(line));
}
async function gone(stateDir: string, ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) if (!usesFolder(stateDir)) return true;
  return !usesFolder(stateDir);
}
/** The lines of the state folder's launches.log (one per Chrome start). */
function launchLines(stateDir: string): string[] {
  try { return readFileSync(join(stateDir, "launches.log"), "utf8").split("\n").filter(Boolean); } catch { return []; }
}
/** The front app's pid from lsappinfo, or undefined. */
function lsappinfoFront(): number | undefined {
  try {
    const asn = execFileSync(LSAPPINFO, ["front"], { encoding: "utf8", timeout: 5000 }).trim();
    if (!asn.startsWith("ASN:")) return undefined;
    return lsappinfoPid(execFileSync(LSAPPINFO, ["info", "-only", "pid", asn], { encoding: "utf8", timeout: 5000 }));
  } catch { return undefined; }
}

/** The agent-browser CLI as an agent session runs it; each stderr line becomes a "log" mark when it arrives. */
function cli(args: string[], timeoutMs: number): Promise<{ code: number | null; doc: any; ms: number }> {
  return new Promise((done) => {
    const t = Date.now();
    const c = spawn(process.execPath, [BIN_JS, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", rest = "";
    c.stdout!.on("data", (b) => (stdout += b));
    c.stderr!.on("data", (b) => {
      const lines = (rest + b).split("\n");
      rest = lines.pop()!;
      for (const line of lines) if (line.trim()) mark("log", line);
    });
    const timer = setTimeout(() => c.kill("SIGTERM"), timeoutMs);
    c.on("close", (code) => {
      clearTimeout(timer);
      if (rest.trim()) mark("log", rest);
      let doc: any = null;
      try { doc = JSON.parse(stdout); } catch { /* no JSON document: a kill or a crash */ }
      done({ code, doc, ms: Date.now() - t });
    });
  });
}

// Only the check's own state folders and Chromes are ever signalled or deleted. At any exit (also
// Ctrl-C), a folder of its own that still exists gets: SIGTERM to its Chrome main process if one runs,
// deletion if no process names it (and --keep-state is off), else a stderr line with its path. The
// folder of a start in progress (from its launch to the end of its quit) is never deleted: after `open`
// exits, its Chrome can still be starting there before its main process shows in ps.
const made: { stateDir: string; ended: boolean }[] = [];
let inProgress: string | undefined;
let monitor: ChildProcess | undefined;
process.on("exit", () => {
  monitor?.kill("SIGTERM");
  for (const m of made) {
    if (!existsSync(m.stateDir) || (o.keepState && m.ended)) continue;
    const pid = ownPid(m.stateDir), starting = m.stateDir === inProgress;
    if (pid) try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
    if (!pid && !starting && !o.keepState && !usesFolder(m.stateDir)) {
      rmSync(m.stateDir, { recursive: true });
      process.stderr.write(`deleted ${m.stateDir}: no process names it\n`);
    } else {
      const why = pid ? `its Chrome, pid ${pid}, got SIGTERM` : starting ? "a start was in progress: its Chrome can still be starting there" : "a process still names it";
      process.stderr.write(`left in place (${why}): ${m.stateDir}\n`);
    }
  }
});
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => process.exit(130));

let chromeVersion: string | null = null;
try { chromeVersion = execFileSync("plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", join(appBundle(o.chromeBin)!, "Contents", "Info.plist")], { encoding: "utf8" }).trim(); }
catch { /* the version is informative only */ }

// The monitor's own time limit covers the longest run, so a monitor left behind ends by itself.
const perStartMs = LAUNCH_TIMEOUT_MS + o.afterMs + QUIT_TIMEOUT_MS + QUIT_WAIT_MS + KILL_WAIT_MS + GAP_MS;
let monitorEnd: number | undefined;
monitor = spawn(o.monitor, [String(Math.ceil((BEFORE_MS + o.starts * perStartMs) / 1000) + 30)], { stdio: ["ignore", openSync(MONITOR_LOG, "w"), "inherit"] });
monitor.on("error", (e) => { process.stderr.write(`the monitor did not start: ${e.message}\n`); process.exit(1); });
monitor.on("exit", () => { monitorEnd = Date.now() / 1000; });
const latestFront = () => parseMonitorLog(readFileSync(MONITOR_LOG, "utf8")).events.flatMap((e) => ("front" in e ? [e.front] : [])).at(-1);
for (let i = 0; i < 50 && latestFront() === undefined; i++) await sleep(100);
process.stderr.write(`starting ${o.starts} agent Chrome${o.starts === 1 ? "" : "s"} (${o.chromeBin}${chromeVersion ? ` ${chromeVersion}` : ""}; ${o.sameProfile ? "one profile for all starts" : "a fresh profile for each start"}), one at a time; keep your own window in front and do not touch the mouse or the keyboard until the summary prints (about ${Math.ceil(o.starts * (o.afterMs + 10_000) / 1000)} s)\n`);
await sleep(BEFORE_MS);

// The liveness check: the monitor must see the front app that lsappinfo names (three tries, so that a
// real front change between the two reads does not fail it).
let liveness: string | null = "not checked";
for (let i = 0; i < 3 && liveness; i++) {
  if (i) await sleep(500);
  liveness = monitorEnd !== undefined ? "the monitor stopped before start 1" : livenessProblem(latestFront(), lsappinfoFront());
}
mark("liveness", liveness ?? "ok");

type Run = {
  start: number; stateDir: string; profile: "fresh" | "used"; chromePid: number | null; viaOpenG: boolean;
  launch: { code: number | null; ms: number; started: boolean | null }; quit: { code: number | null; ended: boolean; killed: boolean }; stateDeleted: boolean; problem: string | null;
};
const runs: Run[] = [];
const shared = o.sameProfile && !liveness ? { stateDir: mkdtempSync("/tmp/abfs-s-"), ended: true } : undefined;
if (shared) made.push(shared);
for (let n = 1; n <= o.starts && !liveness; n++) {
  if (monitorEnd !== undefined) { process.stderr.write(`the monitor stopped: no start ${n}\n`); break; }
  const own = shared ?? { stateDir: mkdtempSync(`/tmp/abfs-${n}-`), ended: true };
  if (!shared) made.push(own);
  own.ended = false;
  const { stateDir } = own;
  const profile = join(stateDir, "profile");
  const logged = launchLines(stateDir).length;
  inProgress = stateDir;
  mark(`start launch ${n}`, { stateDir });
  const launch = await cli(["launch", "--state-dir", stateDir, "--chrome-bin", o.chromeBin, "--json"], LAUNCH_TIMEOUT_MS);
  const launched = launch.code === 0 && launch.doc?.ok === true;
  mark(`${launched ? "end" : "fail"} launch ${n}`, launched ? { started: launch.doc.started, ms: launch.ms } : { code: launch.code, error: launch.doc?.error ?? null });
  const chromePid = ownPid(stateDir) ?? null;
  await sleep(o.afterMs);

  mark(`start quit ${n}`);
  const quit = await cli(["quit", "--state-dir", stateDir, "--json"], QUIT_TIMEOUT_MS);
  let ended = await gone(stateDir, QUIT_WAIT_MS), killed = false;
  if (!ended) {
    const pid = ownPid(stateDir); // looked up again: the main process on this check's own profile, now
    if (pid) {
      try { process.kill(pid, "SIGKILL"); killed = true; } catch { /* already gone */ }
      process.stderr.write(`Chrome (pid ${pid}) on ${profile} did not end ${QUIT_WAIT_MS / 1000} s after quit: sent SIGKILL\n`);
    }
    ended = await gone(stateDir, KILL_WAIT_MS);
  }
  own.ended = ended;
  inProgress = undefined;
  mark(`${ended ? "end" : "fail"} quit ${n}`, { code: quit.code, closed: quit.doc?.closed ?? null, killed });

  const viaOpenG = launchLines(stateDir).slice(logged).some((l) => /\bchrome=via-open-g\b/.test(l));
  const problems = [
    !launched && `launch failed (exit ${launch.code}): ${launch.doc?.error?.message ?? "no result"}`,
    launched && chromePid === null && `no Chrome main process ran on ${profile} after the launch`,
    launched && chromePid !== null && quit.doc?.closed !== true && "Chrome ended by itself before the quit (quit found no Chrome): the start may have shown no window",
    !viaOpenG && "the start did not go through open -n -g (launches.log)",
    !ended && `Chrome on ${profile} did not end; its state folder is left in place`,
  ].filter((p): p is string => !!p);
  let stateDeleted = false;
  if (!shared && ended && !o.keepState) { rmSync(stateDir, { recursive: true }); stateDeleted = true; }
  runs.push({ start: n, stateDir, profile: shared && n > 1 ? "used" : "fresh", chromePid, viaOpenG,
    launch: { code: launch.code, ms: launch.ms, started: launch.doc?.started ?? null }, quit: { code: quit.code, ended, killed }, stateDeleted, problem: problems.join("; ") || null });
  if (!ended) { process.stderr.write(`a process still names ${stateDir}: no more starts\n`); break; }
  if (killed && shared && n < o.starts) { process.stderr.write("--same-profile: after a SIGKILL the next start would be a crash restart, not a clean one: no more starts\n"); break; }
  if (n < o.starts) await sleep(GAP_MS);
}
if (shared?.ended && !o.keepState) {
  rmSync(shared.stateDir, { recursive: true });
  if (runs.length) runs[runs.length - 1].stateDeleted = true;
}
await sleep(1000);
mark("done");
const stoppedEarly = monitorEnd;
if (monitorEnd === undefined) {
  monitor.kill("SIGTERM");
  await new Promise((r) => (monitor!.exitCode !== null || monitor!.signalCode !== null ? r(null) : monitor!.once("exit", r)));
}

const marks: Mark[] = readFileSync(MARKS, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const focus = analyseStarts(parseMonitorLog(readFileSync(MONITOR_LOG, "utf8")), marks, Object.fromEntries(runs.map((r) => [r.start, r.chromePid ?? undefined])), { monitorEnd });
const results = runs.map((r) => {
  const f = focus.find((x) => x.start === r.start)!;
  return { ...r, chromeBin: o.chromeBin, chromeVersion, ...f, problem: [r.problem, f.problem].filter(Boolean).join("; ") || null };
});
for (const r of results) appendFileSync(RESULTS, JSON.stringify(r) + "\n");
const code = liveness || results.length < o.starts ? 1 : exitCode(results);
const summary = {
  ok: code === 0, chromeBin: o.chromeBin, chromeVersion, mode: o.sameProfile ? "same-profile" : "fresh-profile", starts: o.starts, measured: results.length, afterMs: o.afterMs,
  liveness,
  frontBefore: results.map((r) => r.frontBefore?.name ?? null),
  changed: results.filter((r) => r.changed).map((r) => ({ start: r.start, to: [...r.changes, ...r.quitChanges]
    .map((c) => `${c.name} (pid ${c.pid}${c.agentChrome ? ", this start's Chrome" : ""}) at +${c.afterStartMs} ms, ${c.phase}`) })),
  problems: results.filter((r) => r.problem).map((r) => ({ start: r.start, problem: r.problem })),
  pointerMoved: results.filter((r) => r.pointerMoves).map((r) => r.start),
  killed: results.filter((r) => r.quit.killed).map((r) => r.start),
  monitorStopped: stoppedEarly === undefined ? null : `the monitor exited by itself at ${new Date(stoppedEarly * 1000).toISOString()}`,
  outDir: o.outDir,
};
writeFileSync(join(o.outDir, "summary.json"), JSON.stringify(summary, null, 1) + "\n");
process.stdout.write(JSON.stringify(summary, null, 1) + "\n");
process.exit(code);
