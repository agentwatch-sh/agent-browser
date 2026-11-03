// The live start check (macOS, ab-b84.11): an agent Chrome start must never take the operator's focus.
// It starts the agent Chrome N times through agent-browser's real start path (the `launch` command,
// run as the CLI, as an agent session runs it), each time on a fresh, short state folder of its own
// (/tmp/abfs-<n>-XXXXXX: the proxy socket path must fit in 103 bytes), while monitor.swift logs the
// frontmost app and the pointer: before the start, while `launch` runs, and for --after-ms after it.
// Then it quits that Chrome with `quit` (a signal to the Chrome main process on the check's own
// profile, never another Chrome), waits until no process uses the profile, and deletes the state folder
// it made (--keep-state keeps it). It runs only `launch` and `quit`: `launch` probes the debugging port
// with a plain TCP connect, never a WebSocket, so Chrome shows no "Allow remote debugging?" prompt.
// It refuses to run without --on-my-screen: the windows reach the person's screen. Not part of `npm test`.
//
//   swiftc -O test/live/takeover/monitor.swift -o /tmp/abfs-monitor
//   node test/live/takeover/start.ts --on-my-screen --monitor /tmp/abfs-monitor --out-dir <dir> \
//     --chrome-bin "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta" [--starts 3] [--after-ms 10000]
//   python3 -I test/live/takeover/analyse.py <dir>      (the timeline: each front change and the start it fell in)
//
// Keep a window of your own in front, and do not touch the mouse or the keyboard until the summary
// prints: the monitor cannot tell your click from Chrome's activation (results count the pointer moves).
// It writes <dir>/monitor.jsonl, <dir>/marks.jsonl, <dir>/results.jsonl (one JSON line per start: the
// app in front before, each change, when, in which phase, and whether the new front app is this start's
// own Chrome) and <dir>/summary.json, and prints the summary. Exit 0: every start was measured and none
// changed the frontmost app; 1: a start changed it, or a start could not be measured; 2: a usage error.

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
const LAUNCH_TIMEOUT_MS = 60_000, QUIT_WAIT_MS = 15_000, BEFORE_MS = 3000, GAP_MS = 3000;
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

/** The agent-browser CLI as an agent session runs it; its stderr lines become "log" marks. */
function cli(args: string[], timeoutMs: number): Promise<{ code: number | null; doc: any; ms: number }> {
  return new Promise((done) => {
    const t = Date.now();
    const c = spawn(process.execPath, [BIN_JS, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    c.stdout!.on("data", (b) => (stdout += b));
    c.stderr!.on("data", (b) => (stderr += b));
    const timer = setTimeout(() => c.kill("SIGTERM"), timeoutMs);
    c.on("close", (code) => {
      clearTimeout(timer);
      for (const line of stderr.split("\n")) if (line.trim()) mark("log", line);
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

const perStartMs = LAUNCH_TIMEOUT_MS + o.afterMs + 30_000 + QUIT_WAIT_MS + GAP_MS;
monitor = spawn(o.monitor, [String(Math.ceil((BEFORE_MS + o.starts * perStartMs) / 1000) + 30)], { stdio: ["ignore", openSync(MONITOR_LOG, "w"), "inherit"] });
monitor.on("error", (e) => { process.stderr.write(`the monitor did not start: ${e.message}\n`); process.exit(1); });
for (let i = 0; i < 50 && !parseMonitorLog(readFileSync(MONITOR_LOG, "utf8")).some((e) => "front" in e); i++) await sleep(100);
if (!parseMonitorLog(readFileSync(MONITOR_LOG, "utf8")).some((e) => "front" in e)) {
  process.stderr.write(`the monitor logged no frontmost app in 5 s: ${o.monitor}\n`);
  process.exit(1);
}
process.stderr.write(`starting ${o.starts} agent Chrome${o.starts === 1 ? "" : "s"} (${o.chromeBin}${chromeVersion ? ` ${chromeVersion}` : ""}), one at a time; keep your own window in front and do not touch the mouse or the keyboard until the summary prints (about ${Math.ceil(o.starts * (o.afterMs + 10_000) / 1000)} s)\n`);
await sleep(BEFORE_MS);

type Run = { start: number; stateDir: string; chromePid: number | null; viaOpenG: boolean; launch: { code: number | null; ms: number; started: boolean | null }; quit: { code: number | null; ended: boolean }; stateDeleted: boolean; problem: string | null };
const runs: Run[] = [];
for (let n = 1; n <= o.starts; n++) {
  const stateDir = mkdtempSync(`/tmp/abfs-${n}-`);
  const own = { stateDir, ended: false };
  made.push(own);
  const profile = join(stateDir, "profile");
  mark(`start launch ${n}`, { stateDir });
  const launch = await cli(["launch", "--state-dir", stateDir, "--chrome-bin", o.chromeBin, "--json"], LAUNCH_TIMEOUT_MS);
  const launched = launch.code === 0 && launch.doc?.ok === true;
  mark(`${launched ? "end" : "fail"} launch ${n}`, launched ? { started: launch.doc.started, ms: launch.ms } : { code: launch.code, error: launch.doc?.error ?? null });
  const chromePid = ownPid(stateDir) ?? null;
  await sleep(o.afterMs);

  mark(`start quit ${n}`);
  const quit = await cli(["quit", "--state-dir", stateDir, "--json"], 30_000);
  let ended = await gone(profile, QUIT_WAIT_MS);
  if (!ended) {
    const pid = ownPid(stateDir); // looked up again: the main process on this check's own profile, now
    if (pid) try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    ended = await gone(profile, 5000);
  }
  own.ended = ended;
  mark(`${ended ? "end" : "fail"} quit ${n}`, { code: quit.code, closed: quit.doc?.closed ?? null });

  let launches = "";
  try { launches = readFileSync(join(stateDir, "launches.log"), "utf8"); } catch { /* no start was logged */ }
  const viaOpenG = /\bchrome=via-open-g\b/.test(launches);
  const problem = !launched ? `launch failed (exit ${launch.code}): ${launch.doc?.error?.message ?? "no result"}`
    : !viaOpenG ? "the start did not go through open -n -g (launches.log)"
    : !ended ? `Chrome on ${profile} did not end; its state folder is left in place`
    : null;
  let stateDeleted = false;
  if (ended && !o.keepState) { rmSync(stateDir, { recursive: true }); stateDeleted = true; }
  runs.push({ start: n, stateDir, chromePid, viaOpenG, launch: { code: launch.code, ms: launch.ms, started: launch.doc?.started ?? null }, quit: { code: quit.code, ended }, stateDeleted, problem });
  if (n < o.starts) await sleep(GAP_MS);
}
await sleep(1000);
monitor.kill("SIGTERM");
await new Promise((r) => (monitor!.exitCode !== null || monitor!.signalCode !== null ? r(null) : monitor!.once("exit", r)));

const marks: Mark[] = readFileSync(MARKS, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const focus = analyseStarts(parseMonitorLog(readFileSync(MONITOR_LOG, "utf8")), marks, Object.fromEntries(runs.map((r) => [r.start, r.chromePid ?? undefined])));
const results = runs.map((r) => {
  const f = focus.find((x) => x.start === r.start)!;
  return { ...r, chromeBin: o.chromeBin, chromeVersion, ...f, problem: r.problem ?? f.problem };
});
for (const r of results) appendFileSync(RESULTS, JSON.stringify(r) + "\n");
const code = exitCode(results);
const summary = {
  ok: code === 0, chromeBin: o.chromeBin, chromeVersion, starts: o.starts, afterMs: o.afterMs,
  frontBefore: results.map((r) => r.frontBefore?.name ?? null),
  changed: results.filter((r) => r.changed).map((r) => ({ start: r.start, to: r.changes.map((c) => `${c.name} (pid ${c.pid}${c.agentChrome ? ", this start's Chrome" : ""}) at +${c.afterStartMs} ms, ${c.phase}`) })),
  problems: results.filter((r) => r.problem).map((r) => ({ start: r.start, problem: r.problem })),
  pointerMoved: results.filter((r) => r.pointerMoves).map((r) => r.start),
  outDir: o.outDir,
};
writeFileSync(join(o.outDir, "summary.json"), JSON.stringify(summary, null, 1) + "\n");
process.stdout.write(JSON.stringify(summary, null, 1) + "\n");
process.exit(code);
