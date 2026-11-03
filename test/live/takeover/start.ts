// The live start check (macOS, ab-b84.11): an agent Chrome start must never take the operator's focus.
// It starts the agent Chrome N times through agent-browser's real start path (the `launch` command, run
// as the CLI, as an agent session runs it), while monitor.swift logs the frontmost app and the pointer:
// before the start, while `launch` runs, and for --after-ms after it. Then it quits that Chrome with
// `quit` (a signal to the Chrome main process on the check's own profile, never another Chrome) and
// waits until no process uses the profile. If that Chrome has not ended 15 s after `quit`, the check
// sends SIGKILL to the main process on its own profile (looked up again) and waits 5 s more; if it still
// runs, the check leaves that folder in place and starts no more Chrome.
//
// Two modes:
//   default         each start on a new, empty state folder (/tmp/abfs-<n>-XXXXXX, short because the
//                   proxy socket path must fit in 103 bytes): every start is Chrome's first start of a
//                   profile (the first-run path, which AGENT_ARGS turn off with --no-first-run).
//   --same-profile  one new state folder (/tmp/abfs-s-XXXXXX) for all N starts: start 1 is a first
//                   start, and starts 2..N restart that profile after a clean quit, as an agent's next
//                   start does. No session restore: a new profile opens the New Tab page, and "Continue
//                   where you left off" is a signed setting that the check does not set.
// The check deletes each state folder that it made once no process uses its profile (--keep-state keeps
// them). It runs only `launch` and `quit`: `launch` probes the debugging port with a plain TCP connect,
// so the check opens no debugging WebSocket and Chrome shows no "Allow remote debugging?" prompt. It does
// not measure a change of the Space. It refuses to run without --on-my-screen: the windows reach the
// person's screen. Not part of `npm test` (test/takeover-start.test.ts runs its flow with a fake Chrome).
//
//   swiftc -O test/live/takeover/monitor.swift -o /tmp/abfs-monitor
//   node test/live/takeover/start.ts --on-my-screen --monitor /tmp/abfs-monitor --out-dir <dir> \
//     --chrome-bin "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta" [--starts 3] [--after-ms 10000] [--same-profile]
//   python3 -I test/live/takeover/analyse.py <dir>      (the timeline: each front change and the start it fell in)
//
// Keep a window of your own in front, and do not touch the mouse or the keyboard until the summary
// prints: the monitor cannot tell your click from Chrome's activation (results count the pointer moves).
// A start is a problem, never a pass, when the monitor stopped, or logged nothing for more than 2 s (it
// beats once a second), during that start; after the monitor stops, the check starts no more Chrome.
// It writes <dir>/monitor.jsonl, <dir>/marks.jsonl, <dir>/results.jsonl (one JSON line per start: the
// app in front before, each change, when, in which phase, and whether the new front app is this start's
// own Chrome; a change while the check quits counts when it is this start's Chrome, or when the focus
// does not come back) and <dir>/summary.json, and prints the summary. Exit 0: every start was measured
// and none changed the frontmost app; 1: a start changed it, or a start could not be measured; 2: a
// usage error; 130: stopped with Ctrl-C (the check sends SIGTERM to its own Chromes and keeps their folders).

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { agentChromePid, appBundle, hasUserDataDir } from "../../../src/agent.ts";
import { resolveOptions } from "../../../src/options.ts";
import { analyseStarts, exitCode, parseMonitorLog, startArgs, USAGE, type Mark } from "./focus.ts";

const parsed = startArgs(process.argv.slice(2), { platform: process.platform, exists: existsSync });
if (!parsed.ok) {
  process.stderr.write(`${parsed.message}\n${USAGE}\n`);
  process.exit(2);
}
const o = parsed.options;
const BIN_JS = fileURLToPath(new URL("../../../bin/agent-browser.js", import.meta.url));
const LAUNCH_TIMEOUT_MS = 60_000, QUIT_TIMEOUT_MS = 30_000, QUIT_WAIT_MS = 15_000, KILL_WAIT_MS = 5000, BEFORE_MS = 3000, GAP_MS = 3000;
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
/** Every process (main, helpers) whose command line names this profile. */
const onProfile = (profile: string) => execFileSync("ps", ["axww", "-o", "pid=,command="], { encoding: "utf8", maxBuffer: 64 << 20 })
  .split("\n").filter((line) => hasUserDataDir(line.trim(), profile)).length;
async function gone(profile: string, ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) if (!onProfile(profile)) return true;
  return !onProfile(profile);
}
/** The lines of the state folder's launches.log (one per Chrome start). */
function launchLines(stateDir: string): string[] {
  try { return readFileSync(join(stateDir, "launches.log"), "utf8").split("\n").filter(Boolean); } catch { return []; }
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

// Only the check's own state folders and Chromes are ever signalled or deleted.
const made: { stateDir: string; ended: boolean }[] = [];
let monitor: ChildProcess | undefined;
process.on("exit", () => {
  monitor?.kill("SIGTERM");
  for (const m of made.filter((x) => !x.ended)) {
    const pid = ownPid(m.stateDir);
    if (pid) try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
    process.stderr.write(`left in place (its Chrome may still run): ${m.stateDir}\n`);
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
const fronts = () => parseMonitorLog(readFileSync(MONITOR_LOG, "utf8")).events.some((e) => "front" in e);
for (let i = 0; i < 50 && !fronts(); i++) await sleep(100);
if (!fronts()) {
  process.stderr.write(`the monitor logged no frontmost app in 5 s: ${o.monitor}\n`);
  process.exit(1);
}
process.stderr.write(`starting ${o.starts} agent Chrome${o.starts === 1 ? "" : "s"} (${o.chromeBin}${chromeVersion ? ` ${chromeVersion}` : ""}; ${o.sameProfile ? "one profile for all starts" : "a fresh profile for each start"}), one at a time; keep your own window in front and do not touch the mouse or the keyboard until the summary prints (about ${Math.ceil(o.starts * (o.afterMs + 10_000) / 1000)} s)\n`);
await sleep(BEFORE_MS);

type Run = {
  start: number; stateDir: string; profile: "fresh" | "used"; chromePid: number | null; viaOpenG: boolean;
  launch: { code: number | null; ms: number; started: boolean | null }; quit: { code: number | null; ended: boolean }; stateDeleted: boolean; problem: string | null;
};
const runs: Run[] = [];
const shared = o.sameProfile ? { stateDir: mkdtempSync("/tmp/abfs-s-"), ended: true } : undefined;
if (shared) made.push(shared);
for (let n = 1; n <= o.starts; n++) {
  if (monitorEnd !== undefined) { process.stderr.write(`the monitor stopped: no start ${n}\n`); break; }
  const own = shared ?? { stateDir: mkdtempSync(`/tmp/abfs-${n}-`), ended: true };
  if (!shared) made.push(own);
  own.ended = false;
  const { stateDir } = own;
  const profile = join(stateDir, "profile");
  const logged = launchLines(stateDir).length;
  mark(`start launch ${n}`, { stateDir });
  const launch = await cli(["launch", "--state-dir", stateDir, "--chrome-bin", o.chromeBin, "--json"], LAUNCH_TIMEOUT_MS);
  const launched = launch.code === 0 && launch.doc?.ok === true;
  mark(`${launched ? "end" : "fail"} launch ${n}`, launched ? { started: launch.doc.started, ms: launch.ms } : { code: launch.code, error: launch.doc?.error ?? null });
  const chromePid = ownPid(stateDir) ?? null;
  await sleep(o.afterMs);

  mark(`start quit ${n}`);
  const quit = await cli(["quit", "--state-dir", stateDir, "--json"], QUIT_TIMEOUT_MS);
  let ended = await gone(profile, QUIT_WAIT_MS);
  if (!ended) {
    const pid = ownPid(stateDir); // looked up again: the main process on this check's own profile, now
    if (pid) try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    ended = await gone(profile, KILL_WAIT_MS);
  }
  own.ended = ended;
  mark(`${ended ? "end" : "fail"} quit ${n}`, { code: quit.code, closed: quit.doc?.closed ?? null });

  const viaOpenG = launchLines(stateDir).slice(logged).some((l) => /\bchrome=via-open-g\b/.test(l));
  const problem = !launched ? `launch failed (exit ${launch.code}): ${launch.doc?.error?.message ?? "no result"}`
    : !viaOpenG ? "the start did not go through open -n -g (launches.log)"
    : !ended ? `Chrome on ${profile} did not end; its state folder is left in place`
    : null;
  let stateDeleted = false;
  if (!shared && ended && !o.keepState) { rmSync(stateDir, { recursive: true }); stateDeleted = true; }
  runs.push({ start: n, stateDir, profile: shared && n > 1 ? "used" : "fresh", chromePid, viaOpenG,
    launch: { code: launch.code, ms: launch.ms, started: launch.doc?.started ?? null }, quit: { code: quit.code, ended }, stateDeleted, problem });
  if (!ended) { process.stderr.write(`Chrome on ${profile} did not end: no more starts\n`); break; }
  if (n < o.starts) await sleep(GAP_MS);
}
if (shared?.ended && !o.keepState) {
  rmSync(shared.stateDir, { recursive: true });
  if (runs.length) runs[runs.length - 1].stateDeleted = true;
}
await sleep(1000);
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
const code = results.length < o.starts ? 1 : exitCode(results);
const summary = {
  ok: code === 0, chromeBin: o.chromeBin, chromeVersion, mode: o.sameProfile ? "same-profile" : "fresh-profile", starts: o.starts, measured: results.length, afterMs: o.afterMs,
  frontBefore: results.map((r) => r.frontBefore?.name ?? null),
  changed: results.filter((r) => r.changed).map((r) => ({ start: r.start, to: [...r.changes, ...(r.quitCounted ? r.quitChanges : [])]
    .map((c) => `${c.name} (pid ${c.pid}${c.agentChrome ? ", this start's Chrome" : ""}) at +${c.afterStartMs} ms, ${c.phase}`) })),
  problems: results.filter((r) => r.problem).map((r) => ({ start: r.start, problem: r.problem })),
  pointerMoved: results.filter((r) => r.pointerMoves).map((r) => r.start),
  monitorStopped: stoppedEarly === undefined ? null : `the monitor exited by itself at ${new Date(stoppedEarly * 1000).toISOString()}`,
  outDir: o.outDir,
};
writeFileSync(join(o.outDir, "summary.json"), JSON.stringify(summary, null, 1) + "\n");
process.stdout.write(JSON.stringify(summary, null, 1) + "\n");
process.exit(code);
