// The macOS check of drive, record and one window per page (board task ab-v16.16, for ab-v16.27; the research is
// docs/research/2026-11-05-anti-detect-drive.md, sections 7 and 8). Not part of `npm test`; its pure parts
// (mac-rules.ts) are, in test/mac-measure.test.ts.
//
//   node test/live/anti-detect/mac.ts --on-my-screen --out-dir DIR [--chrome-bin APP_BINARY] [--watcher BIN]
//        [--ffmpeg PATH] [--look SECONDS] [--skip record,popups,person,front,stable]
//   node test/live/anti-detect/mac.ts --dry-run --out-dir DIR [--chrome /usr/bin/chromium] [--display 123]   (Linux)
//   (--part stable: the second part, which the check runs itself; see "stable" below)
//
// On the Mac it runs with one command, in about 3 minutes, with nobody at the keyboard: the operator leaves the Mac
// unlocked and awake, with no full-screen app in front, does not use it during the run, and first quits the apps that
// post keyboard or mouse events (remote-desktop apps, Karabiner, a mouse jiggler, Universal Control): the watcher
// takes their events as a person's, so they stop the check (or make it refuse before its Chrome starts). It starts its own agent
// Chrome (the app of --chrome-bin; default agent-browser's: Google Chrome Beta when it is installed, else Google
// Chrome) on a new profile in its run folder, as agent-browser's launch does: `open -n -g` with agent-browser's
// give-back guard (src/giveback.ts) and AGENT_ARGS (today's flags: no timer flag,
// --disable-backgrounding-occluded-windows). It adds only what the measurement needs: --remote-debugging-port=0
// (so that no "Allow remote debugging?" prompt needs a person; it sets navigator.webdriver, which this check does
// not measure), --use-mock-keychain (no keychain prompt), and no network (every host but probe.localhost fails to
// resolve and goes to a dead proxy). The debugging port is an exception (named in the README) to its rule against that flag:
// 127.0.0.1 only, an empty profile, no network, for the few minutes of the run. agent-browser's commands reach that
// Chrome through agent-browser's own proxy (the `endpoint` option), with agent-browser's Mac design (ab-v16.27). It never touches the
// operator's Chrome or another Chrome. No other agent session may use the Mac's agent browser during the run: a
// take of the front by another Chrome counts against the check.
//
// A watcher (mac-watch.swift, compiled into the run folder with the Xcode Command Line Tools' swiftc; or --watcher
// BIN) logs the front app, the pointer, the Space, the on-screen window order (CGWindowList) and the lock state,
// and gives the front back: each time the agent Chrome is the front app, it asks macOS to activate the operator's
// app again. At the first sign of a person (a pointer move, or the hardware's key press, modifier, click or scroll)
// the watcher stops that by itself. The check never moves the pointer and sends no OS input. It refuses (exit 2,
// before its Chrome starts) when one of the six HID readings of the watcher's ready line is 0 or less, or when a
// person's input or a pointer move came after the watcher's start. After the start it stops early when a person uses
// the Mac (a pointer move, a key press, a modifier key, a click or a scroll of the hardware), the screen locks, the
// display sleeps, another user's session comes to the front, the Space changes, the front does not come back in
// 1.5 s, the watcher ends or goes silent for 3 s, or the run reaches its time limit (stopReason in mac-rules.ts). It
// reads these rules at each watcher line and every 100 ms (STOP_POLL_MS), also inside a step: at a stop the step in
// progress ends at once, the watcher gets one last give-back request (only while the agent Chrome is in front), and
// the check goes to its end step (it quits its Chrome by the recorded pid, then writes its results). The probe's log
// keeps no key values (probeRecord: no key, code, keyCode or input text; only event types and counts), so a person's
// keys that reach a probe page never go into results.json.
//
// What it measures, in the order it runs (each step's page signals come from the probe page, probe.ts). Since ab-v16.27
// it runs agent-browser's built Mac design (src/: options.ts macWindows, input.ts, watchback.ts), not a prototype:
//   start   the agent Chrome's start: the front app before and after (the give-back), where its first window comes
//   giveback agent-browser's give-back watcher (src/watchback.ts, the operator's answer ab-or9): AgentBrowser.connect
//           starts it, as it does on the Mac for each command, for as long as the agent Chrome runs; the check waits
//           for its watch line in launches.log (it names the operator's app). From then on it gives the front back,
//           and the check's watcher only logs (and arms again as a fallback when a take is still open after
//           FALLBACK_MS); the summary gives each take's times as both saw them; stop-chrome.txt names it
//   window  one window per agent page with agent-browser's `open` (Target.createTarget { newWindow: true, background:
//           true }), each one's place in the window order (above or behind the operator's windows), the Space and the
//           front app; agent-browser's commands in the window (no focus emulation, no activation, a person's input:
//           paths from the page's last point) and a 3 s record; a click in the second window (does the first page get
//           a blur?), keys into the first window with no click (an inactive window), a person-shaped click and typing,
//           and a click back in the first window
//   facts   what an API gives of Mission Control, App Expose, the Dock menu and Cmd-` (the agent app's windows, on
//           and off screen, its activation policy, the window titles); before the popups, which can take the front
//   popup   from a page in its own window, each opened by agent-browser's click: a target=_blank link, window.open()
//           with no features, and window.open() with "popup,width=500,height=400": a tab or a window, its size, the
//           opener's and the popup's state; then the popup rule as built: agent-browser's click in the popup tab, the
//           way back to the opener only by the popup's close (agent-browser's close, or the page's own
//           window.close()), and agent-browser's next click in the opener, which waits until the opener shows again
//           (about 1.0 s on 2026-11-06; input.ts, showMs). For each: the opener's visibility, its focus and blur events
//           and document.hasFocus(), the front app, the Space, the opener window's place
//   front   (--skip front leaves it out) agent-browser's `front`: the agent Chrome comes to the front on purpose, the
//           give-back watcher must leave it there (own=front: it never fights the operator), and after FRONT_STEP_MS
//           the check gives the front back itself
//   look    only with --look SECONDS: the give-back stops, the agent windows stay open for that long, and the
//           summary lists the one short look for the operator (Mission Control, the Dock menu, App Expose, Cmd-`)
//   end     the agent Chrome quits; the give-back watcher must end with it within WATCH_END_MS (on 2026-11-06 the
//           prototype missed the quit of a second Google Chrome instance for 3.8 s)
//   stable  (ab-v16.68) after the first agent Chrome quit, when Google Chrome (stable) is installed in /Applications
//           and is not the first part's agent Chrome: a second, short run of this check in it (--part stable, its own
//           run folder DIR/run-XXXXXX/stable/run-YYYYYY, its own watcher process from the same compiled watcher, a new
//           empty profile): its start, agent-browser's give-back watcher, one window (WA) and the popups from it with
//           the popup rule. It runs only when the first part ran to its end. Else the summary says why not (not
//           installed: the check reads /Applications and installs nothing). Between the two parts no watcher runs
//           (review-66, B1): the first part hands the stable part its watcher's last look at the input, the pointer's
//           point, the Space and a monotonic lower limit of the gap (--quiet-since, --pointer, --space, --gap-ms; after
//           any person's input or pointer move in its log it starts no stable part), and the stable part refuses (exit
//           2, before its Chrome starts) when a HID reading of its own watcher is shorter than that gap, the pointer
//           moved, the Space changed or the wall clock went back (gapProblem)
// The real pointer: every probe event at the real pointer's point (macOS gave it, not the check's CDP input).
//
// It writes DIR/run-XXXXXX/results.json (every step, the watcher's log, the probe's log, the analysis) and
// summary.md, and prints the summary. At the end it quits its Chrome (Browser.close, else SIGTERM, else SIGKILL, each
// to the pid on its own profile, looked up again right before it: quitAgentChrome) and removes the throwaway profile
// (only when ps shows that its Chrome quit) and the compiled watcher (also after a refusal, exit 2). `open` starts Chrome
// under launchd, so a kill -9 of node leaves it running: the check prints at the start, and writes to
// DIR/run-XXXXXX/stop-chrome.txt, how to stop it by hand.
//   exit 0  every phase ran; the start's take of the front, if any, followed agent-browser's give-back rule (at most
//           250 ms away, to the agent Chrome only, and back); after the start the front app never changed; the
//           Space never changed; the watcher shows both (it ran all the time, the screen stayed unlocked and awake,
//           the pointer did not move, and no key, click or scroll of the hardware came); and the agent Chrome quit
//   exit 1  the check took the operator's focus or Space, could not show that it did not, did not finish, or its
//           Chrome did not quit: summary.md names each problem (a failed step is a measurement, not a problem). When
//           the only problems are popup takes that came back, the summary says so: an expected result of the design
//           (Chrome can activate itself when it shows a popup). The stable part's problems count too, with its name
//   exit 2  it refused to start, and nothing started on the screen: a usage error, not macOS (or not Linux for
//           --dry-run), no ffmpeg with libx264 (on PATH, in /opt/homebrew/bin or /usr/local/bin; or --ffmpeg; or
//           --skip record), no swiftc with a macOS SDK (it compiles with -sdk, so swiftc never starts xcrun), a watcher
//           that did not compile, a locked screen, no front app, a full-screen app in front, a HID reading of 0 or
//           less (or none), a person's input or a pointer move after the watcher's start
// --dry-run (Linux only) runs every phase against Chromium in a private Xvfb, with a stand-in watcher
// (mac-standin.ts: no front app, no Space, no window list): a test of the drive, the stop rules, the refusals and the
// analysis, not a Mac result.
// --dry-run runs agent-browser's Mac design (the internal platform option "darwin") with a stand-in in place of the
// give-back watcher's osascript (mac-standin-watchback.ts, the watchBackCommand option).
// It ends only its own processes, each by the pid that it recorded: the agent Chrome on its own profile, the proxy
// of its own state folder, the watcher, agent-browser's give-back watcher of its own state folder (by its record, only
// when ps shows it as that folder's watcher: stopWatchBack), caffeinate (which keeps the display awake for the run),
// the stable part's node process and, in the dry run, its Xvfb and Chromium.

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { AGENT_ARGS, agentChromeBin, agentChromePid, appBundle, CHROME_STABLE_BIN } from "../../../src/agent.ts";
import { AgentBrowser } from "../../../src/browser.ts";
import type { CDPConnection } from "../../../src/cdp.ts";
import { commands } from "../../../src/commands.ts";
import { bringToFront, execRun, psStartTime, type FrontDeps } from "../../../src/front.ts";
import { GIVE_BACK_GRACE_MS, giveBackToken, startGiveBack, type GiveBack } from "../../../src/giveback.ts";
import { MAX_SOCKET_PATH_BYTES, resolveOptions, type BrowserOptions, type Settings } from "../../../src/options.ts";
import { stopProxy } from "../../../src/proxy.ts";
import { findFfmpeg } from "../../../src/record.ts";
import {
  agentWindowsOf, FALLBACK_MS, ffmpegSearchPath, fieldText, frontStepProblem, gapProblem, giveBackRows, handover, joinVerdicts, makeFallback, quitAgentChrome, frontAt, frontTakes, macArgs, matchWindow,
  newAgentWindows, orderOf,
  parseWatchLog, placement, placementText, probeRecord, readyText, realPointer, realPointerEvents, runStep, screenProblem, snapOf, spaceChanges, STOP_POLL_MS, stopReason, summary, swiftTools,
  verdict, WATCH_END_MS, watchBackProblems, watchBackText, watcherProblems, windowsOf,
  type BackRow, type DriveRow, type Hold, type MacResult, type PopupRow, type RecordRow, type Step, type Verdict, type WatchEvent, type WindowRow,
} from "./mac-rules.ts";
import { parseWatchLines, readWatch, stopWatchBack as stopBuiltWatcher } from "../../../src/watchback.ts";
import { bothFocusedMs, inputs, startServer, stepSignals, type Rec } from "./probe.ts";
import { harnessGuard } from "../guard.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
function refuse(message: string): never { process.stderr.write(`${message}\n`); process.exit(2); }
const parsed = macArgs(process.argv.slice(2), { platform: process.platform, exists: existsSync, defaultChrome: agentChromeBin({ chromeBin: undefined }) });
if (!parsed.ok) refuse(parsed.message);
const O = parsed.options;
/** The first part (every phase), or the short second part in Google Chrome stable (--part stable). */
const FULL = O.part === undefined;
const OUT = resolve(O.outDir);
mkdirSync(OUT, { recursive: true });
const RUN = mkdtempSync(join(OUT, "run-"));
const T0 = Date.now();
/** The whole run stops its measurement after this (the brief: under 10 minutes). */
const LIMIT_MS = 9 * 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const say = (line: string) => process.stderr.write(`${new Date().toISOString().slice(11, 23)} ${line}\n`);
say(`${O.dryRun ? "DRY RUN (Linux): " : ""}${FULL ? "" : "the Google Chrome stable part: "}run folder ${RUN}`);
// The records need ffmpeg with libx264: without it the run has no record numbers, so it refuses before anything starts.
// The stable part has no record.
let ffmpeg: string | undefined;
if (FULL && !O.skip.includes("record")) {
  try { ffmpeg = findFfmpeg(O.ffmpeg, ffmpegSearchPath(process.env.PATH)); }
  catch (e) { refuse(`refusing, nothing started: ${(e as Error).message.split("\n")[0]} (it looked on PATH, in /opt/homebrew/bin and in /usr/local/bin; or pass --skip record)`); }
}

// ------------------------------------------------------------------ own processes only, each by its recorded pid
const children: ChildProcess[] = [];
let settings: Settings | undefined;
let chromePid: number | undefined;
/**
 * Our agent Chrome as ps shows it on our own profile: its pid, null (none: a pid can be given to another process, so
 * a pid is ours only while ps shows it there), or undefined (ps failed: not known).
 */
const chromeNow = (): number | null | undefined => {
  if (!settings) return null;
  try { const pid = agentChromePid(settings); return pid !== undefined && (chromePid === undefined || pid === chromePid) ? pid : null; } catch { return undefined; }
};
/** Our agent Chrome's pid, or undefined (none, or not known). */
const ownChrome = (): number | undefined => chromeNow() ?? undefined;
/** The watcher binary that this run compiled into its run folder: it goes at the end, and also after a refusal (exit 2). */
let compiled: string | undefined;
process.on("exit", () => {
  if (settings) { try { stopProxy(settings); } catch { /* not started */ } }
  const pid = ownChrome();
  if (pid) { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } }
  // agent-browser's give-back watcher of this run's state folder, only when no agent Chrome of this run is left (review-69d
  // note 4): else it gives a take of that Chrome back until it quits, and ends with it (within about 0.25 s).
  if (settings && chromeNow() === null) { try { stopBuiltWatcher(settings); } catch { /* none */ } }
  for (const c of children.slice().reverse()) if (c.exitCode === null && c.signalCode === null) c.kill("SIGTERM");
  // Only the file that this run compiled, only inside its own run folder (the run of 2026-11-06 kept it after a refusal).
  if (compiled) { try { if (realpathSync(compiled).startsWith(`${realpathSync(RUN)}/`)) rmSync(compiled); } catch { /* gone, or not made */ } }
});
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => process.exit(130));

// ------------------------------------------------------------------ the dry run's private Xvfb
const XENV: NodeJS.ProcessEnv = { ...process.env };
if (O.dryRun) {
  // One live harness at a time, and nothing of this dry run after its end, also after a kill -9 (test/live/README.md);
  // the stable part, a child of the first part, runs under the first part's lock.
  const harness = await harnessGuard(`anti-detect mac dry run (${O.part ?? "first"} part)`);
  const field = (b: Buffer) => { const n = Buffer.alloc(2); n.writeUInt16BE(b.length); return Buffer.concat([n, b]); };
  const xauth = join(RUN, "Xauthority");
  writeFileSync(xauth, Buffer.concat([Buffer.from([0xff, 0xff]), field(Buffer.alloc(0)), field(Buffer.from(String(O.display))), field(Buffer.from("MIT-MAGIC-COOKIE-1")), field(randomBytes(16))]), { mode: 0o600 });
  if (existsSync(`/tmp/.X11-unix/X${O.display}`)) refuse(`display :${O.display} is in use; pass --display N`);
  const xvfb = spawn("Xvfb", [`:${O.display}`, "-auth", xauth, "-nolisten", "tcp", "-screen", "0", "1600x1000x24"], { stdio: "ignore" });
  children.push(xvfb);
  harness.track(xvfb.pid, "Xvfb");
  for (let i = 0; i < 50 && !existsSync(`/tmp/.X11-unix/X${O.display}`) && xvfb.exitCode === null; i++) await sleep(100);
  await sleep(300);
  if (xvfb.exitCode !== null || !existsSync(`/tmp/.X11-unix/X${O.display}`)) refuse(`Xvfb did not start on :${O.display}`);
  Object.assign(XENV, { DISPLAY: `:${O.display}`, XAUTHORITY: xauth });
  // The stand-in's "in-gap" reading (a key in the gap between the two parts) is half the time since the first part's last look.
  if (O.handover) XENV.MAC_STANDIN_QUIET_SINCE = String(O.handover.quietSince);
  delete XENV.WAYLAND_DISPLAY; delete XENV.XDG_SESSION_TYPE;
}

// ------------------------------------------------------------------ the watcher
const bundle = O.dryRun ? null : appBundle(O.chromeBin)!;
const watchFile = join(RUN, "watch.jsonl");
const events: WatchEvent[] = [];
/**
 * The Command Line Tools' (or Xcode's) swiftc and macOS SDK, found without xcrun: xcrun offers an install dialog when
 * they are missing, and a dialog takes the front. The compile gets the SDK with -sdk (and SDKROOT), so swiftc never asks xcrun for one.
 */
function findSwift(): { swiftc: string; sdk: string } | undefined {
  let dev = "";
  try { dev = execFileSync("/usr/bin/xcode-select", ["-p"], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { /* none */ }
  return swiftTools(dev, existsSync);
}
let watcherBin: string, watcherArgs: string[];
/** The watcher's own time limit: the measurement, the look and the end. */
const WATCH_S = String(LIMIT_MS / 1000 + O.look + 120);
if (O.dryRun) { watcherBin = process.execPath; watcherArgs = [join(HERE, "mac-standin.ts"), WATCH_S]; }
else {
  watcherBin = O.watcher ?? join(RUN, "mac-watch");
  if (!O.watcher) {
    const swift = findSwift();
    if (!swift) refuse("refusing, nothing started: no swiftc with a macOS SDK beside it: install the Xcode Command Line Tools (xcode-select --install), or pass --watcher with mac-watch.swift compiled elsewhere");
    say(`compiling the watcher with ${swift.swiftc} (SDK ${swift.sdk})`);
    try {
      execFileSync(swift.swiftc, ["-sdk", swift.sdk, "-swift-version", "5", "-O", join(HERE, "mac-watch.swift"), "-o", watcherBin],
        { stdio: ["ignore", "pipe", "pipe"], timeout: 300_000, env: { ...process.env, SDKROOT: swift.sdk } });
      compiled = watcherBin;
    }
    catch (e) {
      const err = e as { stderr?: Buffer; message: string };
      writeFileSync(join(RUN, "swiftc.log"), String(err.stderr ?? err.message));
      refuse(`the watcher did not compile (mac-watch.swift); see ${join(RUN, "swiftc.log")}`);
    }
  }
  watcherArgs = [bundle!, WATCH_S];
}
const watcher = spawn(watcherBin, watcherArgs, { env: XENV, stdio: ["pipe", "pipe", openSync(join(RUN, "watch.err"), "a")] });
children.push(watcher);
watcher.on("error", (e) => say(`watcher: ${e.message}`));
/** From the Chrome start on, the stop rules run at each watcher line (and every STOP_POLL_MS: checkHarm below). */
let watching = false;
/**
 * Monotonic times of this process (performance.now(): ms since its start): when its watcher's ready line came, and when
 * its watcher's last line came (the handover's lower limit of the gap between the two parts: review-66b A).
 */
let readyMono = 0, lastLineMono = 0;
createInterface({ input: watcher.stdout! }).on("line", (line) => {
  appendFileSync(watchFile, `${line}\n`);
  lastLineMono = performance.now();
  let e: WatchEvent | undefined;
  try { const x = JSON.parse(line); if (typeof x?.t === "number" && typeof x.ev === "string") { events.push(x); e = x; if (x.ev === "ready" && !readyMono) readyMono = lastLineMono; } } catch { /* counted as bad in the analysis */ }
  if (watching) checkHarm();
  if (e) fallback.line(e);
});
const tell = (cmd: string) => { if (watcher.stdin?.writable) watcher.stdin.write(`${cmd}\n`); };
async function waitEvent(pred: (e: WatchEvent) => boolean, ms: number): Promise<WatchEvent | undefined> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) { const e = events.find(pred); if (e) return e; }
  return undefined;
}
// ------------------------------------------------------------------ the stop rules: at each watcher line, every STOP_POLL_MS, inside each step
let aborted: string | undefined;
/** From the end step's start on: no agent-browser command, input, front request or watcher start any more (abCommands, base.stopped). */
let quitting = false;
/** The stop: its time, the step in progress then, and the watcher line of the person's first sign (pointer or input). */
let stopInfo: { why: string; t: number; step: string; cause?: WatchEvent } | undefined;
let onStop: () => void = () => {};
/** Settles at the first stop: each pause, snap and step of the measurement ends at once then. */
const stopped = new Promise<void>((r) => { onStop = r; });
let stopPoll: NodeJS.Timeout | undefined;
const steps: Step[] = [];
/** The end of the measurement: before the look (--look), else after the end step. The stop rules and the analysis cover only the time before it. */
let measureEnd: number | undefined;
let current: string | undefined;
/** The times with no give-back (the front step: agent-browser's front, on purpose): a take that begins in one may stay open until OPEN_TAKE_MS after it (stopReason). */
const holds: Hold[] = [];
function checkHarm() {
  if (aborted) return;
  const why = stopReason(events, steps, Date.now(), { t0: T0, limitMs: LIMIT_MS, measureEnd, holds });
  if (!why) return;
  aborted = why;
  stopInfo = { why, t: Date.now(), step: current ?? "between steps", cause: events.find((e) => e.ev === "pointer" || e.ev === "input") };
  // The watcher stops its give-back by itself at a person's first sign (a pointer move, a key press, a modifier key,
  // a click or a scroll of the hardware); "disarm" stops it for the other stops. Then one last request, only while
  // the agent Chrome is in front, so that a person's keys go to their own app while the end step quits that Chrome.
  // agent-browser's give-back watcher keeps running until the agent Chrome quits (review-69c B1): a command that is in
  // progress at the stop can still bring the agent Chrome to the front (its CDP calls already sent), and the watcher
  // gives that back; it leaves a take less than 1 s after a person's click or Command key to the person. No
  // agent-browser command starts after the stop (abCommands), none sends input or a front request after it, and no
  // watcher starts after it (the stopped option). The check's fallback ends here (its watcher is disarmed).
  tell("disarm");
  tell("giveback");
  watchOn = false;
  fallback.reset();
  say(`STOP${stopInfo.cause ? ` (${stopInfo.t - stopInfo.cause.t} ms after the watcher's ${stopInfo.cause.ev} line)` : ""} in ${stopInfo.step}: ${why}`);
  onStop();
}
// ------------------------------------------------------------------ agent-browser's give-back watcher (src/watchback.ts)
/**
 * True while agent-browser's give-back watcher gives the front back: the check's own watcher then only logs (disarmed).
 * When a take of the agent Chrome is still open FALLBACK_MS after the watcher's line of it, the check arms its watcher
 * (it gives the front back at once), and disarms it again when the front is back: a fallback (makeFallback), measured
 * apart (the takes table names it). In the front step (agent-browser's `front`) the fallback is off: that take is on
 * purpose, and the check gives the front back itself at the step's end.
 */
let watchOn = false, inFront = false;
const fallbacks: { t: number; step: string }[] = [];
const fallback = makeFallback({
  active: () => watchOn && !inFront && !aborted, frontIsAgent: () => frontAt(events, Date.now())?.pid === chromePid,
  arm: () => {
    fallbacks.push({ t: Date.now(), step: current ?? "between steps" });
    tell("arm");
    say(`fallback: the agent Chrome still had the front ${FALLBACK_MS} ms after it took it; the check's watcher gives it back`);
  },
  disarm: () => tell("disarm"), setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (t) => clearTimeout(t),
});
/** Ends agent-browser's give-back watcher of this run's state folder (src/watchback.ts, stopWatchBack: only that folder's watcher), and the check's fallback with it. */
function stopWatchBack(): void {
  watchOn = false;
  fallback.reset();
  if (settings) { try { stopBuiltWatcher(settings); } catch { /* none */ } }
}
/** A sleep that ends at once at a stop. */
const pause = (ms: number) => Promise.race([sleep(ms), stopped]);
async function snap(label: string): Promise<WatchEvent | undefined> {
  if (aborted) return undefined;
  tell(`snap ${label}`);
  return Promise.race([waitEvent((e) => e.ev === "windows" && e.why === "snap" && e.label === label, 3000), stopped.then(() => undefined)]);
}
const ready = await waitEvent((e) => e.ev === "ready", 20_000);
if (!ready) refuse(`the watcher did not start (see ${join(RUN, "watch.err")})`);
await sleep(400);
// Before anything starts on the screen: the screen, the six HID readings, and nobody at the Mac since the watcher's
// start (also in the dry run, with the stand-in's lines). The start step looks again right before its launch.
const problem = screenProblem(events);
if (problem) refuse(`refusing, nothing started: ${problem}`);
// The stable part (review-66, B1): no watcher read the input between the two parts; its own watcher's HID readings,
// pointer and Space show whether a person used the Mac in that gap (with a monotonic lower limit of the gap: review-66b A).
if (O.handover) { const gap = gapProblem(ready, O.handover, readyMono); if (gap) refuse(`refusing, nothing started: ${gap}`); }
// The display and the system stay awake for the run (an assertion that ends with this process).
if (!O.dryRun) children.push(spawn("/usr/bin/caffeinate", ["-d", "-i", "-w", String(process.pid)], { stdio: "ignore" }));
say(readyText(ready));

// ------------------------------------------------------------------ the probe pages
// The log keeps no key values (probeRecord): a person's keys that reach a probe page never go into results.json.
const log: Rec[] = [];
const { server, port } = await startServer(log, { record: probeRecord });
const urlOf = (tab: string) => `http://probe.localhost:${port}/p?tab=${tab}`;
async function loaded(tab: string, ms = 15_000): Promise<void> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
    if (log.some((e) => e.tab === tab && e.ev === "load")) return;
    if (aborted) throw new Error("stopped");
  }
  throw new Error(`page ${tab} did not load in ${ms / 1000} s`);
}

// ------------------------------------------------------------------ steps
const notRun: string[] = [];
/**
 * One step: a snap of the windows before and after it (with `snap`), its time, its error; the stop rules before, in
 * and after it (runStep reads them every STOP_POLL_MS, and a stop ends the step at once: its work is left behind,
 * and the end step's quit of the agent Chrome ends that work). `always`: it runs also after a stop, to its own end
 * (the end step). `atOnce: false`: a stop does not cut the step short (the start: it must learn its Chrome's pid).
 */
const DRY_STOP_IN = O.dryRun ? process.env.MAC_DRY_STOP_IN ?? "" : "", DRY_STOP_AFTER_MS = Number(process.env.MAC_DRY_STOP_AFTER_MS ?? 300);
let dryStopSent = false;
async function step<T>(phase: string, name: string, fn: () => Promise<T>, o: { limitMs?: number; tailMs?: number; snap?: boolean; always?: boolean; atOnce?: boolean } = {}): Promise<T | undefined> {
  const label = `${phase}: ${name}`;
  if (aborted && !o.always) { notRun.push(label); return undefined; }
  if (o.snap) await snap(`before ${label}`);
  if (!aborted) await pause(300);
  if (aborted && !o.always) { notRun.push(label); return undefined; }
  current = label;
  const t0 = Date.now();
  // The dry run's stop inside a named step (MAC_DRY_STOP_IN, a step label's start; MAC_DRY_STOP_AFTER_MS after it begins):
  // the stand-in watcher then gives a person's key, as a person at the Mac would (review-69c B1: a stop in front, in a click).
  // (The front step's stop comes inside front's ps reads instead: dryFront.started.)
  if (O.dryRun && DRY_STOP_IN && label.startsWith(DRY_STOP_IN) && !label.startsWith("front: ") && !dryStopSent) { dryStopSent = true; setTimeout(() => tell("person"), DRY_STOP_AFTER_MS); }
  const r = await runStep(fn, { limitMs: o.limitMs ?? 25_000, stopped: () => { checkHarm(); return aborted; }, wake: stopped, atOnce: !o.always && o.atOnce !== false });
  current = undefined;
  const t1 = Date.now();
  steps.push({ phase, name, t0, t1, ok: r.ok, ...(r.error ? { error: r.error } : {}) });
  if (r.stopped) notRun.push(`${label} (stopped in it after ${t1 - t0} ms)`);
  say(`${label}: ${r.ok ? "ok" : r.stopped ? "STOPPED" : `FAILED: ${r.error}`} (${t1 - t0} ms)`);
  if (o.always) await sleep(o.tailMs ?? 1200); else await pause(o.tailMs ?? 1200);
  if (o.snap) await snap(`after ${label}`);
  checkHarm();
  return r.value;
}

// ------------------------------------------------------------------ the agent Chrome's start
const stateDir = join(RUN, "state");
mkdirSync(join(stateDir, "profile"), { recursive: true, mode: 0o700 });
const profile = join(stateDir, "profile");
const sock = join(stateDir, "chrome-proxy.sock");
const socketPath = Buffer.byteLength(sock) <= MAX_SOCKET_PATH_BYTES ? sock : join(mkdtempSync(join(tmpdir(), "ab-mac-")), "proxy.sock");
settings = resolveOptions({ stateDir, socketPath, allow: ["probe.localhost"], commandName: "mac check" });
/** What the measurement adds to agent-browser's own flags (see the head of this file). */
const MEASURE_ARGS = ["--remote-debugging-port=0", "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-default-apps",
  "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE probe.localhost", "--proxy-server=http://127.0.0.1:9", "--proxy-bypass-list=probe.localhost",
  ...(O.dryRun ? ["--ozone-platform=x11", "--password-store=basic", "--window-position=0,0", "--window-size=1100,700"] : ["--use-mock-keychain"])];
const CHROME_ARGS = [...AGENT_ARGS, `--user-data-dir=${profile}`, `--window-name=mac check: ${stateDir}`, ...MEASURE_ARGS];
const launches = join(stateDir, "launches.log");
let endpoint: string | undefined;
async function devtoolsEndpoint(ms: number): Promise<string> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) {
    try { const [p, path] = readFileSync(join(profile, "DevToolsActivePort"), "utf8").trim().split("\n"); if (/^\d+$/.test(p) && path?.startsWith("/devtools/browser/")) return `ws://127.0.0.1:${p}${path}`; } catch { /* not yet */ }
    if (aborted) throw new Error("stopped before the DevTools port");
  }
  throw new Error(`no DevToolsActivePort in ${ms / 1000} s`);
}
await step("start", "agent Chrome start", async () => {
  // Right before the launch, a look again: the HID readings, and nobody at the Mac since the watcher's start (exit 2).
  const late = screenProblem(events);
  if (late) refuse(`refusing, nothing started: ${late}`);
  // From now on the stop rules run at each watcher line and every STOP_POLL_MS, also between and inside steps.
  watching = true;
  stopPoll = setInterval(checkHarm, STOP_POLL_MS);
  let guard: GiveBack | undefined, failed: unknown;
  try {
    if (O.dryRun) {
      const fd = openSync(join(RUN, "chrome.log"), "a");
      children.push(spawn(O.chromeBin, [...CHROME_ARGS, urlOf("F0")], { env: XENV, stdio: ["ignore", fd, fd] }));
    } else {
      // As launchAgentChrome does: the guard records the app in front, then `open -n -g` starts a new instance.
      guard = await startGiveBack(bundle!, launches).catch((): undefined => undefined);
      const open = spawn("/usr/bin/open", ["-n", "-g", "-a", bundle!, "--args", ...CHROME_ARGS, urlOf("F0")], { stdio: "ignore" });
      const code = await new Promise<number | null>((r) => open.once("exit", (c) => r(c)));
      appendFileSync(launches, `${new Date().toISOString()} chrome=via-open-g ${giveBackToken(guard)} by=${process.pid} cmd=mac check\n`);
      if (code !== 0) throw new Error(`open exited with ${code}`);
    }
    endpoint = await devtoolsEndpoint(30_000);
  } catch (e) { failed = e; } finally {
    await guard?.finish(endpoint ? GIVE_BACK_GRACE_MS : 0);
    // From now on the watcher gives the front back (agent-browser's own guard ended with the start), unless the check
    // stopped. Until it knows the pid, a new instance of the agent's app bundle counts as the agent Chrome.
    if (!aborted) tell("arm");
  }
  // The pid, also after a stop or a failed start: the end step quits this Chrome by it. (This step finishes its own
  // work at a stop: atOnce false; its waits for the DevTools port and the first page end at a stop.)
  for (let i = 0; i < 50 && !chromePid; i++, await sleep(100)) chromePid = ownChrome();
  // `open` starts Chrome under launchd, not as this process's child: if this process is killed (kill -9), Chrome stays.
  const help = chromePid
    ? `If this check ends without quitting its agent Chrome (kill -9 of node), stop that Chrome by hand: check that \`ps -o command= -p ${chromePid}\` shows --user-data-dir=${profile}, then run \`kill ${chromePid}\` (the pid is also in the "agent" line of ${watchFile}).`
    : `The check did not find its agent Chrome's pid (ps). If that Chrome still runs after the check, find it with \`ps axww -o pid,command | grep -F -- '--user-data-dir=${profile}'\` and stop its main process (the line with no --type=) with kill PID.`;
  writeFileSync(join(RUN, "stop-chrome.txt"), `${help}\n`);
  say(help);
  if (chromePid) tell(`agent ${chromePid}`);
  if (failed) throw failed;
  if (!chromePid) throw new Error("the agent Chrome's pid was not found on its profile (ps)");
  await loaded("F0");
}, { limitMs: 45_000, snap: true, atOnce: false });

// ------------------------------------------------------------------ agent-browser through its own proxy, with its Mac design
/** The operator's app, as the watcher saw it at its start. */
const operatorPid = Number(ready.front?.pid ?? -1);
/** agent-browser's give-back watcher's osascript in the dry run: a stand-in that names the operator's app as the stand-in watcher saw it. */
const STANDIN_WATCHBACK = [process.execPath, join(HERE, "mac-standin-watchback.ts")];
if (O.dryRun) process.env.MAC_STANDIN_WATCHBACK_FRONT = String(operatorPid);
// The Mac's design (platform "darwin": on the Mac the default; in the dry run on Linux the internal option). chromeBin:
// the give-back watcher activates nothing but checks that the pid is an instance of this app bundle.
const base: BrowserOptions = { stateDir, socketPath, allow: ["probe.localhost"], ...(endpoint ? { endpoint } : {}), commandName: "mac check", proxyIdleMs: 60_000, log: (l) => say(`agent-browser: ${l}`),
  platform: "darwin", ...(O.dryRun ? { watchBackCommand: STANDIN_WATCHBACK } : { chromeBin: O.chromeBin }),
  // review-69c B1: from a stop, and from the quit on, no more input event, no front request and no watcher start.
  stopped: () => !!aborted || quitting };
const oWin: BrowserOptions = base;
/**
 * agent-browser's commands, only before a stop (review-69c B1): after it no command starts. A command in progress at
 * the stop sends no more input event and no front request, and starts no watcher (the stopped option of `base`).
 */
function abCommands(): typeof commands {
  if (aborted || quitting) throw new Error(`stopped: no agent-browser command after ${aborted ? "the stop" : "the quit began"}`);
  return commands;
}
let browser: AgentBrowser | undefined, fatal: string | undefined;
if (endpoint && !aborted) {
  settings = resolveOptions(base);
  // The connection ends its wait at a stop (the end step then quits the Chrome with SIGTERM: no CDP connection). On the
  // Mac AgentBrowser.connect starts agent-browser's give-back watcher (ensureWatchBack), as for each command.
  try { browser = await Promise.race([AgentBrowser.connect(base), stopped.then(() => undefined)]); } catch (e) { fatal = `agent-browser could not connect through its proxy: ${(e as Error).message.split("\n")[0]}`; say(fatal); }
} else if (!endpoint && !aborted) fatal = "the agent Chrome did not start";
const raw = browser?.conn as CDPConnection;
/** The measurement's own CDP calls: none goes out after a stop, so a step's work that a stop left behind sends no more input. */
const cdp = (method: string, params: object = {}, sessionId?: string): Promise<any> => aborted ? Promise.reject(new Error("stopped")) : raw.send(method, params, sessionId);
const records: RecordRow[] = [];
async function recordStep(phase: string, name: string, o: BrowserOptions, tab: string, where: string): Promise<void> {
  if (O.skip.includes("record")) { records.push({ where, skipped: "--skip record" }); return; }
  if (!ffmpeg) { records.push({ where, error: "no ffmpeg" }); return; }
  const script = join(RUN, "record-steps.json");
  writeFileSync(script, JSON.stringify([{ wait: 3000 }]));
  const r = await step(phase, name, () => abCommands().record(o, { tab, out: join(RUN, `${phase}-${tab.replace(/\W/g, "")}.mp4`), script, fps: 60, ffmpeg }), { limitMs: 90_000, snap: true });
  const s = steps.at(-1);
  records.push(r ? { where, fps: +(r.frames / r.seconds).toFixed(1), frames: r.frames, seconds: +r.seconds.toFixed(2), maxFrameGapMs: r.maxFrameGapMs }
    : { where, error: s && s.phase === phase && s.name === name ? s.error ?? "failed" : "not run" });
}
const attachTo = async (targetId: string) => (await cdp("Target.attachToTarget", { targetId, flatten: true })).sessionId as string;
const evaluate = async (sid: string, expression: string) => (await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sid)).result?.value;
const targetOf = async (tab: string) => ((await cdp("Target.getTargets")).targetInfos as { targetId: string; url: string; type: string }[]).find((t) => t.type === "page" && t.url.includes(`tab=${tab}`))?.targetId;

/** Waits until the operator's app is the front app again (the watcher's view), at most `ms`; whether it is. */
async function frontBack(ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end && !aborted; await sleep(25)) if (frontAt(events, Date.now())?.pid === operatorPid) return true;
  return frontAt(events, Date.now())?.pid === operatorPid;
}
/** A popup page's place and state: a tab in its opener's window or a window of its own, its bounds, its size, visibility, focus and history.length. */
async function popupState(tab: string, opener: string): Promise<Record<string, unknown>> {
  const pt = await targetOf(tab);
  if (!pt) throw new Error(`no target for ${tab}`);
  const pw = await cdp("Browser.getWindowForTarget", { targetId: pt }), ow = await cdp("Browser.getWindowForTarget", { targetId: opener });
  const ps = await attachTo(pt);
  try {
    const st = await evaluate(ps, "({ ow: outerWidth, oh: outerHeight, iw: innerWidth, ih: innerHeight, vis: document.visibilityState, focus: document.hasFocus(), hl: history.length })") as Record<string, unknown>;
    return { target: pt, inOpener: pw.windowId === ow.windowId, bounds: pw.bounds, ...st };
  } finally { await raw.send("Target.detachFromTarget", { sessionId: ps }).catch(() => {}); }
}

// ------------------------------------------------------------------ giveback: agent-browser's give-back watcher (src/watchback.ts)
const launchesLog = join(stateDir, "launches.log");
/** agent-browser's give-back watcher's lines in this run's launches.log. */
const builtLines = () => (existsSync(launchesLog) ? parseWatchLines(readFileSync(launchesLog, "utf8")) : []);
let wbStarted: string | undefined;
/**
 * Waits for agent-browser's give-back watcher, which AgentBrowser.connect started for this agent Chrome: its watch line
 * in launches.log, and the operator's app as the app to give the front back to (its watch line, or a before= line when
 * the agent Chrome was in front at its start). Then the check's own watcher only logs (watchOn), with its fallback.
 */
async function waitWatchBack(): Promise<string> {
  if (!chromePid) throw new Error("no agent Chrome pid");
  const t0 = Date.now();
  let watch: ReturnType<typeof builtLines>[number] | undefined, named = false;
  for (const end = Date.now() + 8000; Date.now() < end && !aborted && !named; await sleep(50)) {
    const lines = builtLines();
    watch = lines.find((l) => "watch" in l.kv && l.kv.agent === String(chromePid));
    const ended = lines.find((l) => "end" in l.kv && l.t >= (watch?.t ?? 0));
    if (ended && !watch) throw new Error(`agent-browser's give-back watcher did not watch: ${ended.text}`);
    named = !!watch && (watch.kv.before === String(operatorPid) || lines.some((l) => l.t >= watch!.t && l.kv.before === String(operatorPid)));
  }
  if (aborted) throw new Error("stopped");
  if (!watch) throw new Error("agent-browser's give-back watcher wrote no watch line in 8 s (launches.log)");
  if (!named) throw new Error(`agent-browser's give-back watcher does not name the operator's app (pid ${operatorPid}): ${watch.text}`);
  tell("disarm");
  watchOn = true;
  const rec = settings ? readWatch(settings) : undefined;
  // stop-chrome.txt names it too: it ends by itself when its agent Chrome quits.
  const help = `agent-browser's give-back watcher (node${rec ? `, pid ${rec.pid}` : ""}, with ${O.dryRun ? "the dry run's stand-in" : "/usr/bin/osascript"} as its child) ends by itself within about 0.25 s when the agent Chrome quits; to stop it at once, check that \`ps -o command= -p ${rec?.pid ?? "PID"}\` shows "agent-browser.js give-back-watch --state-dir ${stateDir}", then run \`kill ${rec?.pid ?? "PID"}\`.`;
  appendFileSync(join(RUN, "stop-chrome.txt"), `${help}\n`);
  say(help);
  return `agent-browser's give-back watcher (src/watchback.ts${O.dryRun ? "; the dry run's stand-in in place of osascript: it sees no take on Linux" : ", osascript JavaScript for Automation"}), started by AgentBrowser.connect, `
    + `watching ${watch.t - t0} ms after this step began: ${watch.text}. From then on the check's watcher only logs, and arms again only when a take is still open after ${FALLBACK_MS} ms (fallbacks: see the takes table).`;
}
if (browser) {
  // The operator's app must be in front when the watcher starts: it records the app in front as the app to give the front back to.
  wbStarted = await step("giveback", "agent-browser's give-back watcher (started by AgentBrowser.connect)", async () => {
    if (!(await frontBack(1500))) throw new Error("the operator's app is not in front");
    return waitWatchBack();
  }, { limitMs: 15_000, tailMs: 500 });
}

// ------------------------------------------------------------------ window: one window per agent page (agent-browser's open and commands)
const wins: Record<string, { target: string; windowId?: number; bounds?: { left?: number; top?: number; width?: number; height?: number } }> = {};
const details: Record<string, unknown> = {};
const FIELD = "document.getElementById('f').value";
/** A field's text through CDP (no activation): its value, for fieldText (the results keep only its length). */
async function fieldOf(targetId: string): Promise<unknown> {
  const sid = await attachTo(targetId);
  try { return await evaluate(sid, FIELD); } finally { await raw.send("Target.detachFromTarget", { sessionId: sid }).catch(() => {}); }
}
/** Keys into a page with no click (agent-browser's type with no --into: the keys go to the page's focused element); the field's lengths and whether exactly these keys arrived (fieldText). */
async function keysInto(name: string, text: string): Promise<{ charsBefore: number; chars: number; theCheckKeys: boolean }> {
  const before = await fieldOf(wins[name].target);
  await abCommands().type(oWin, { tab: `tab=${name}`, text });
  return fieldText(before, await fieldOf(wins[name].target), text);
}
if (browser) {
  for (const name of FULL ? ["WA", "WB"] : ["WA"]) await step("window", `open window ${name} (agent-browser open: Target.createTarget newWindow, background)`, async () => {
    const r = await abCommands().open(oWin, { url: urlOf(name), name });
    wins[name] = { target: r.tab.targetId };
    await loaded(name);
    const w = await cdp("Browser.getWindowForTarget", { targetId: r.tab.targetId });
    wins[name] = { target: r.tab.targetId, windowId: w.windowId, bounds: w.bounds };
  }, { snap: true });
}
if (browser && FULL) {
  await step("window", "idle 3 s", () => sleep(3000), { snap: true });
  const A = "tab=WA", B = "tab=WB";
  await step("window", "WA: text", () => abCommands().text(oWin, { tab: A }), { snap: true });
  await step("window", "WA: click", () => abCommands().click(oWin, { tab: A, target: "#b" }), { snap: true });
  await step("window", "WA: type", () => abCommands().type(oWin, { tab: A, text: "hello", into: "#f" }), { snap: true });
  await step("window", "WA: press End", () => abCommands().press(oWin, { tab: A, key: "End" }), { snap: true });
  await step("window", "WA: shot", () => abCommands().shot(oWin, { tab: A, path: join(RUN, "window-WA.png") }), { limitMs: 40_000, snap: true });
  await recordStep("window", "WA: record 3 s", oWin, A, "a page in a window of its own (the design)");
  await step("window", "WB: click (WA had the focus)", () => abCommands().click(oWin, { tab: B, target: "#b" }), { snap: true });
  if (wins.WA) details.keys = await step("window", "WA: keys with no click (WB has the focus)", () => keysInto("WA", "keys"), { snap: true });
  await step("window", "WB: click (WA had the focus again)", () => abCommands().click(oWin, { tab: B, target: "#b" }), { snap: true });
  await step("window", "WA: click (WB had the focus)", () => abCommands().click(oWin, { tab: A, target: "#b" }), { snap: true });
  if (!O.skip.includes("person")) details.person = await step("window", "WA: person-shaped click and typing", async () => {
    // agent-browser's own input (input.ts): each path starts at the page's last point (pointer.json), never at the real pointer.
    const last = (() => { try { return JSON.parse(readFileSync(join(stateDir, "pointer.json"), "utf8")).pages?.[wins.WA.target] ?? null; } catch { return null; } })();
    await abCommands().click(oWin, { tab: A, target: "#b" });
    await abCommands().type(oWin, { tab: A, text: "hello", into: "#f" });
    return { pathFrom: "the page's last point (agent-browser's pointer.json)", last };
  }, { snap: true });
}

// ------------------------------------------------------------------ facts: what an API gives (before the popups, which can take the front)
const pages: { title: string; url: string; windowId?: number; state?: string }[] = [];
if (browser && FULL) await step("facts", "the agent app's windows", async () => {
  for (const t of ((await cdp("Target.getTargets")).targetInfos as { targetId: string; type: string; title: string; url: string }[]).filter((x) => x.type === "page")) {
    const w = await cdp("Browser.getWindowForTarget", { targetId: t.targetId }).catch(() => undefined);
    pages.push({ title: t.title, url: t.url.replace(/^http:\/\/probe\.localhost:\d+/, ""), windowId: w?.windowId, state: w?.bounds?.windowState });
  }
}, { snap: true });

// ------------------------------------------------------------------ popup: from a page in its own window, and the popup rule as built
const POPUPS = [
  { id: "lk", y: 35, tab: "PA", kind: "a link with target=_blank", asked: "a tab", drive: true, back: "close" },
  { id: "o2", y: 85, tab: "PB", kind: "window.open() with no features", asked: "a tab", drive: false, back: "self" },
  { id: "o3", y: 135, tab: "PC", kind: "window.open() with popup,width=500,height=400", asked: "a window, outer 500x400 (inner 500x400 asked)", drive: false, back: "close" },
] as const;
/** The step names of the popup rule: agent-browser's click in the popup tab (drive the new tab), the popup's close, and agent-browser's next click in the opener (it waits until the opener shows). */
const backName = (p: (typeof POPUPS)[number], what: "drive" | "back" | "next") => what === "drive" ? `${p.tab}: agent-browser's click in the popup (the popup rule: drive the new tab)`
  : what === "next" ? `WA: agent-browser's click after ${p.tab} closed (it waits until WA shows)`
  : p.back === "close" ? `back to the opener: agent-browser's close of ${p.tab}` : `back to the opener: ${p.tab} closes itself (window.close())`;
const popupInfo: Record<string, Record<string, unknown>> = {};
/** The opener WA after each way back (the popup's target gone, and how it closed), and after the next click in it. */
const backInfo: Record<string, Record<string, unknown>> = {};
/** The popup and its opener WA right after agent-browser's click in the popup (the popup rule: drive the new tab). */
const driveInfo: Record<string, { popup: Record<string, unknown>; opener: Record<string, unknown> }> = {};
/** WA after agent-browser's next click in it, after each popup closed. */
const nextInfo: Record<string, Record<string, unknown>> = {};
/** A page's visibility and document.hasFocus() now (a CDP read: no activation). */
async function stateOf(targetId: string): Promise<Record<string, unknown>> {
  const sid = await attachTo(targetId);
  try { return await evaluate(sid, "({ vis: document.visibilityState, focus: document.hasFocus() })") as Record<string, unknown>; }
  finally { await raw.send("Target.detachFromTarget", { sessionId: sid }).catch(() => {}); }
}
/** The way back to the opener, as built: the popup closes (agent-browser's close: Target.closeTarget; or the page's own window.close()), with no activation. */
async function wayBack(p: (typeof POPUPS)[number]): Promise<Record<string, unknown>> {
  const pt = popupInfo[p.tab]?.target as string;
  if (p.back === "close") await abCommands().close(oWin, { tab: pt });
  // The page closes during the call: its session ends, so the call can fail; the target list below says whether it closed.
  else await abCommands().eval(oWin, { tab: pt, expression: "window.close(), true" }).catch(() => {});
  const isGone = async () => !((await cdp("Target.getTargets")).targetInfos as { targetId: string }[]).some((t) => t.targetId === pt);
  let gone = false, closedBy = p.back === "close" ? "agent-browser's close (Target.closeTarget)" : "its own window.close() (agent-browser's eval)";
  for (const end = Date.now() + 3000; Date.now() < end && !gone; await sleep(50)) gone = await isGone();
  if (!gone && p.back === "self") {
    // Chrome kept the page (no script close): the check closes it, so that the next popup's opener is in front again.
    closedBy = "Target.closeTarget (its own window.close() did not close it)";
    await cdp("Target.closeTarget", { targetId: pt });
    for (const end = Date.now() + 3000; Date.now() < end && !gone; await sleep(50)) gone = await isGone();
  }
  return { gone, closedBy };
}
if (browser && !O.skip.includes("popups") && !wins.WA) notRun.push(aborted ? "popup: every popup step" : "popup: every popup step (window WA did not open)");
if (browser && !O.skip.includes("popups") && wins.WA) {
  await step("popup", "WA: add the link and the two buttons", async () => {
    const sid = await attachTo(wins.WA.target);
    try {
      await evaluate(sid, `(() => { const mk = (id, top) => { const b = document.createElement("button"); b.id = id; b.style = "position:fixed;left:300px;top:" + top + "px;width:120px;height:30px"; document.body.append(b); return b; };
        const a = document.createElement("a"); a.id = "lk"; a.href = "/p?tab=PA"; a.target = "_blank"; a.textContent = "link"; a.style = "position:fixed;left:300px;top:20px;width:120px;height:30px;display:block"; document.body.append(a);
        mk("o2", 70).onclick = () => window.open("/p?tab=PB"); mk("o3", 120).onclick = () => window.open("/p?tab=PC", "", "popup,width=500,height=400"); })()`);
    } finally { await raw.send("Target.detachFromTarget", { sessionId: sid }).catch(() => {}); }
  });
  for (const p of POPUPS) {
    await step("popup", p.kind, async () => {
      await abCommands().click(oWin, { tab: "tab=WA", target: `#${p.id}` });
      await loaded(p.tab, 8000);
      await sleep(1000);
      popupInfo[p.tab] = await popupState(p.tab, wins.WA.target);
    }, { limitMs: 20_000, snap: true });
    if (!popupInfo[p.tab]?.target) continue;
    if (p.drive) {
      const d = await step("popup", backName(p, "drive"), async () => {
        const pt = popupInfo[p.tab].target as string;
        await abCommands().click(oWin, { tab: pt, target: "#b" });
        await sleep(300);
        return { popup: await stateOf(pt), opener: await stateOf(wins.WA.target) };
      }, { tailMs: 800, snap: true });
      if (d) driveInfo[p.tab] = d;
    }
    const r = await step("popup", backName(p, "back"), () => wayBack(p), { limitMs: 15_000, tailMs: 0, snap: false });
    if (r) backInfo[p.tab] = r;
    // The opener's next input right after the close: agent-browser waits (input.ts, showMs) until WA shows again.
    const n = await step("popup", backName(p, "next"), async () => {
      await abCommands().click(oWin, { tab: "tab=WA", target: "#b" });
      return stateOf(wins.WA.target);
    }, { limitMs: 20_000, tailMs: 800, snap: true });
    if (n) nextInfo[p.tab] = n;
  }
}

// ------------------------------------------------------------------ front: agent-browser's front, on purpose (the watcher leaves it to the operator)
/** How long the check leaves the agent Chrome in front after agent-browser's front, before it gives the front back itself. */
const FRONT_STEP_MS = 1500;
/** front's activation requests (its osascript runs; in the dry run its stand-in's): their times, and whether the check had stopped then (exact, not by the clock's ms). */
const frontRequests: { t: number; afterStop: boolean }[] = [];
const frontRequest = () => { frontRequests.push({ t: Date.now(), afterStop: !!aborted }); };
/** On the Mac: front's own runner, with each request counted (review-69d note 1). */
const macFront: FrontDeps = { run: (argv, ms) => { if (argv[0].endsWith("/osascript")) frontRequest(); return execRun(argv, ms); } };
/** The dry run's stand-ins for front (src/front.ts, FrontDeps): macOS's tools answer that the agent Chrome is in front. */
const dryFront: FrontDeps = {
  platform: "darwin", release: () => "24.1.0", sleep: (ms) => sleep(ms),
  // The start time from ps, as front reads it. With MAC_DRY_STOP_IN on the front step, a person's key comes while front
  // reads ps (its reads block node for about 0.3 s): front must see that stop before its request.
  started: (pid) => {
    if (DRY_STOP_IN.startsWith("front: ") && !dryStopSent) {
      dryStopSent = true;
      tell("person");
      for (const end = Date.now() + 300; Date.now() < end;) { /* as a slow ps read */ }
    }
    try { return psStartTime(execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 5000, env: { ...process.env, LC_ALL: "C" } })); } catch { return undefined; }
  },
  run: async (argv) => {
    if (argv[0] === "/usr/bin/osascript") {
      frontRequest();
      // review-69d B1: the person's key while osascript starts (MAC_DRY_STOP_IN=front-request): the request is out, and
      // its activation lands after the stop.
      if (DRY_STOP_IN === "front-request" && !dryStopSent) { dryStopSent = true; tell("person"); await sleep(300); }
      return { ok: true, stdout: `${JSON.stringify({ found: true, path: argv[7], launched: null, before: operatorPid, sent: true })}\n`, stderr: "" }; }
    if (argv[0] === "/usr/bin/lsappinfo" && argv[1] === "front") return { ok: true, stdout: "ASN:0x0-0x1:\n", stderr: "" };
    if (argv[0] === "/usr/bin/lsappinfo") return { ok: true, stdout: `"pid"=${chromePid}\n`, stderr: "" };
    return { ok: true, stdout: "15.1\n", stderr: "" };
  },
};
const FRONT_STEP = "front: agent-browser's front (the agent Chrome in front on purpose)";
if (browser && FULL && !O.skip.includes("front")) {
  await step("front", "agent-browser's front (the agent Chrome in front on purpose)", async () => {
    // The take is on purpose: the stop rules let it stay open (a hold), and the fallback stays off for it.
    const from = Date.now();
    holds.push({ from, until: from + 60_000 + FRONT_STEP_MS });
    inFront = true;
    try {
      // agent-browser's front (commands.front is this call): its request goes out only while the check has not stopped
      // (the stopped option, read right before each request). The dry run gives it a stand-in for osascript and
      // lsappinfo (Linux has neither), which records each request and says that the agent Chrome came to the front.
      abCommands();
      const r = await bringToFront(resolveOptions(oWin), O.dryRun ? dryFront : macFront);
      await pause(FRONT_STEP_MS);
      return r.via;
    } finally {
      // The check gives the front back itself (one request of its watcher), and waits for it; also after a stop (review-69d
      // B1): a request that went out before the stop can bring the agent Chrome to the front after the stop's own request.
      holds[holds.length - 1].until = Date.now() + 200;
      tell("giveback");
      await frontBack(1500);
      inFront = false;
    }
  }, { limitMs: 75_000, snap: true });
}

// ------------------------------------------------------------------ look (only with --look): the give-back stops
const LOOK = [
  "Run the check again with --look 60 when you can look at the Mac. When it prints LOOK NOW (the agent windows stay open 60 s, and the check gives the front back no more):",
  "1. Press Mission Control (F3, or Control-Up arrow). Count the agent Chrome's windows (they show probe pages), then press Escape.",
  "2. Right-click the agent Chrome's icon in the Dock (the second Chrome icon). Count the windows in its menu. Choose Show All Windows (App Expose), then press Escape.",
  "3. In your own app in front, press Cmd-` (Command and the key left of 1). Does an agent window come forward? Then leave the Mac.",
  "Tell the agent the three answers. The check's exit code covers only the measurement before LOOK NOW.",
];
if (O.look && browser && !aborted) {
  measureEnd = Date.now();
  clearInterval(stopPoll);
  stopWatchBack();
  tell("disarm");
  process.stdout.write(`\nLOOK NOW (${O.look} s):\n${LOOK.slice(1).join("\n")}\n\n`);
  say(`LOOK NOW: the agent windows stay open for ${O.look} s`);
  await sleep(O.look * 1000);
}

// ------------------------------------------------------------------ the end: our Chrome, our proxy, the watcher
const endLines: string[] = [];
let quitProblem: string | undefined;
// running: false when ps shows that the Chrome quit; true or null (ps cannot tell) keep the profile.
let quit: { running: boolean | null } = { running: null };
quitting = true;
await step("end", "quit the agent Chrome", async () => {
  if (chromePid === undefined && chromeNow() === null) { quit = { running: false }; endLines.push("no agent Chrome ran on the run's profile"); return; }
  // Each signal goes only to the pid that ps shows on this run's own profile at that moment (chromeNow).
  const q = await quitAgentChrome({
    // With no CDP connection (a stop before agent-browser connected) no Browser.close goes out: SIGTERM at once.
    check: chromeNow, close: async () => { if (!raw) return false; await raw.send("Browser.close", {}, undefined, 5000); },
    signal: (pid, sig) => { try { process.kill(pid, sig); } catch { /* gone */ } }, sleep,
  });
  quit = q;
  quitProblem = q.problem;
  endLines.push(...q.lines);
}, { limitMs: 45_000, tailMs: 1500, always: true });
clearInterval(stopPoll);
const endStep = steps.at(-1);
// agent-browser's give-back watcher ends by itself when the agent Chrome quits ("end=agent-gone by=node" in
// launches.log): the check waits WATCH_END_MS and a second for it (the summary names a late end), then ends it.
const nodeEnd = () => builtLines().some((l) => "end" in l.kv && l.kv.by === "node" && l.t >= (endStep?.t0 ?? 0));
if (wbStarted && quit.running === false) {
  for (const until = Date.now() + WATCH_END_MS + 1000; Date.now() < until && !nodeEnd(); ) await sleep(50);
  if (!nodeEnd()) endLines.push("agent-browser's give-back watcher did not end with its agent Chrome: the check stopped it");
}
// Only after a quit that ps confirmed (review-69d note 4): else the watcher keeps giving a take of that Chrome back, and
// ends by itself when it quits (stop-chrome.txt names both).
if (quit.running === false) stopWatchBack();
else { watchOn = false; fallback.reset(); if (wbStarted) endLines.push("kept agent-browser's give-back watcher: ps does not confirm that the agent Chrome quit; the watcher ends by itself when it does (stop-chrome.txt)"); }
if (stopInfo) {
  // How fast the stop was: from the watcher's line of the person's first sign (or the stop) to the end of the step in
  // progress and to the start of the end step.
  const from = stopInfo.cause?.t ?? stopInfo.t, cut = steps.find((x) => `${x.phase}: ${x.name}` === stopInfo!.step);
  endLines.push(`the stop (${stopInfo.why}) came in ${stopInfo.step}, ${stopInfo.t - from} ms after the watcher's ${stopInfo.cause ? `${stopInfo.cause.ev} line${stopInfo.cause.kind ? ` (${stopInfo.cause.kind})` : ""}` : "line"}; `
    + `${cut ? `that step ended ${cut.t1 - from} ms after it; ` : ""}the end step began ${endStep?.phase === "end" ? `${endStep.t0 - from} ms` : "?"} after it`
    + `${endStep?.phase === "end" ? `, and the agent Chrome had quit ${endStep.t1 - from} ms after it` : ""}`);
  // review-69c B1: what of agent-browser still acted after the stop (a command in progress at the stop).
  // Presses, releases, clicks, keys and wheel (not the pointer's out and leave events of the windows that the quit closes).
  const PRESSES = ["pointerdown", "mousedown", "pointerup", "mouseup", "click", "dblclick", "auxclick", "contextmenu", "keydown", "keyup", "keypress", "wheel", "input"];
  const late = ["WA", "WB", "PA", "PB", "PC"].flatMap((tab) => inputs(log, tab, stopInfo!.t, Number.POSITIVE_INFINITY).filter((e) => PRESSES.includes(String(e.type))).map((e) => ({ tab, t: e.t as number, type: String(e.type) })));
  const popups = ["PA", "PB", "PC"].filter((tab) => log.some((e) => e.tab === tab && e.ev === "load" && e.t >= stopInfo!.t));
  const asked = builtLines().filter((l) => "asked" in l.kv && l.t >= stopInfo!.t).length;
  endLines.push(`after the stop: ${late.length} press, click, key or wheel event(s) reached a probe page${late.length ? ` (${late.slice(0, 4).map((e) => `${e.type} in ${e.tab} +${e.t - stopInfo!.t} ms`).join(", ")})` : ""}; ${popups.length ? `popup page(s) ${popups.join(", ")} loaded` : "no popup page loaded"}; `
    + `${frontRequests.filter((r) => r.afterStop).length} front request(s) sent after it (${frontRequests.length} in all)${O.dryRun ? " (the dry run's stand-in)" : ""}; agent-browser's give-back watcher asked ${asked} time(s) to give the front back; `
    + `the check asked its watcher ${events.filter((e) => e.ev === "giveback" && e.t >= stopInfo!.t).length} time(s) for the front (review-69d B1: at the stop, and after a front step); `
    + `front's hold ${existsSync(join(stateDir, "give-back-hold-front.json")) ? "was still there at the end" : "was gone at the end"}`);
}
if (endStep?.phase === "end" && !endStep.ok && !quitProblem) quitProblem = `the quit of the agent Chrome did not finish (${endStep.error}); see stop-chrome.txt in the run folder`;
await browser?.disconnect().catch(() => {});
try { stopProxy(settings!); } catch { /* none */ }
measureEnd ??= Date.now();
tell("quit");
await new Promise((r) => { if (watcher.exitCode !== null) r(null); watcher.once("exit", r); setTimeout(r, 3000); });
server.close();
// The run folder keeps the logs, the shots and the records; the throwaway profile and the compiled watcher go, once
// nothing uses them: only paths that this run made inside its own run folder.
const inRun = (p: string) => { try { return realpathSync(p).startsWith(`${realpathSync(RUN)}/`); } catch { return false; } };
if (quit.running !== false) endLines.push(`kept the profile: ${quit.running ? "the agent Chrome still runs" : "ps cannot confirm that the agent Chrome quit"} (${profile})`);
else if (inRun(profile) && statSync(profile).isDirectory()) {
  try { rmSync(profile, { recursive: true, maxRetries: 3 }); endLines.push(`removed the agent Chrome's throwaway profile (${profile})`); }
  catch (e) { endLines.push(`could not remove the profile ${profile}: ${(e as Error).message.split("\n")[0]}`); }
}

// ------------------------------------------------------------------ stable: the second part, in Google Chrome stable (ab-v16.68)
// A run of its own (this script with --part stable), after the first agent Chrome quit, with the same compiled watcher.
// Only when Google Chrome stable is installed (the check reads /Applications and installs nothing), is not the first
// part's agent Chrome, and the first part ran to its end. The dry run runs it with its own Chromium on the next display.
// The first part's handover (review-66, B1): its watcher's last look at the input, and the pointer's point. A person's
// input or a pointer move after the measurement's end (the stop rules end there) keeps the stable part from starting;
// from that last look to the stable part's watcher, no watcher runs, and the stable part checks that gap (gapProblem).
const hand = handover(events, measureEnd!);
const stable: string[] = [];
let stablePart: { ok: boolean; problems: string[]; popupOnly?: boolean } | null = null, stableResult: Record<string, any> | undefined;
const stableWhyNot = !FULL ? "this run is the stable part"
  : O.skip.includes("stable") ? "Left out by --skip stable."
  : O.look ? "Not run: --look (the operator was at the Mac for the look; run the check again without --look for this part)."
  : !O.dryRun && !existsSync(CHROME_STABLE_BIN) ? `Not measured: Google Chrome (stable) is not installed (no ${CHROME_STABLE_BIN}). The check installs nothing.`
  : !O.dryRun && O.chromeBin === CHROME_STABLE_BIN ? `Measured in the first part: Google Chrome (stable) was this run's agent Chrome (${CHROME_STABLE_BIN}).`
  : aborted ? "Not run: the first part stopped early." : fatal ? "Not run: the first part failed." : quit.running !== false ? "Not run: the first part's agent Chrome did not quit (or ps cannot confirm it)."
  : !hand.ok ? `Not run: ${hand.why}.`
  : O.dryRun && O.display >= 9999 ? "Not run: no display after --display for the dry run's second part." : undefined;
if (stableWhyNot && FULL) stable.push(stableWhyNot);
if (!stableWhyNot && hand.ok) {
  const dir = join(RUN, "stable");
  mkdirSync(dir);
  const args = O.dryRun
    ? ["--dry-run", "--part", "stable", "--out-dir", dir, "--chrome", O.chromeBin, "--display", String(O.display + 1)]
    : ["--on-my-screen", "--part", "stable", "--out-dir", dir, "--chrome-bin", CHROME_STABLE_BIN, "--watcher", watcherBin];
  // review-66b A: a monotonic lower limit of the gap, from this process's receipt of its watcher's last line (its last
  // look at the input came before that line) to now; the stable part adds its own time to its watcher's ready line.
  args.push(`--quiet-since=${hand.handover.quietSince}`, `--pointer=${hand.handover.pointer.x},${hand.handover.pointer.y}`,
    `--gap-ms=${Math.max(0, Math.floor(performance.now() - lastLineMono))}`, ...(hand.handover.space !== undefined ? [`--space=${hand.handover.space}`] : []));
  if (O.skip.includes("popups")) args.push("--skip", "popups");
  // The first part's stand-in settings (MAC_STANDIN_*) stay out; MAC_STANDIN_STABLE_X becomes the stable part's MAC_STANDIN_X (a dry run's test of the gap).
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("MAC_STANDIN_") || k.startsWith("MAC_STANDIN_STABLE_"))
    .map(([k, v]) => [k.replace(/^MAC_STANDIN_STABLE_/, "MAC_STANDIN_"), v]));
  say(`stable: the second part runs in ${O.dryRun ? `the dry run's Chromium (${O.chromeBin})` : CHROME_STABLE_BIN}: node ${join(HERE, "mac.ts")} ${args.join(" ")}`);
  const t0 = Date.now();
  const child = spawn(process.execPath, [join(HERE, "mac.ts"), ...args], { stdio: ["ignore", "inherit", "inherit"], env });
  children.push(child);
  const timer = setTimeout(() => { say("stable: the second part did not end in 5 minutes: the check ends it (SIGTERM to its node process)"); child.kill("SIGTERM"); }, 300_000);
  const code = await new Promise<number | null>((r) => { child.once("exit", (c) => r(c)); child.once("error", () => r(null)); });
  clearTimeout(timer);
  const runs = existsSync(dir) ? readdirSync(dir).filter((n) => n.startsWith("run-")) : [];
  const file = runs.length === 1 ? join(dir, runs[0], "results.json") : undefined;
  try { stableResult = file && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).result : undefined; } catch { stableResult = undefined; }
  if (stableResult) {
    stablePart = { ok: !!stableResult.ok, problems: stableResult.problems ?? [], popupOnly: !!stableResult.popupOnly };
    stable.push(`Ran as the second part, a run of its own: ${stableResult.product} (${stableResult.chrome}), ${stableResult.seconds} s, exit ${code}${stablePart.popupOnly ? " (an expected result: only popup takes that came back)" : ""}; its summary: ${join(stableResult.run, "summary.md")}.`);
    for (const g of (stableResult.giveBack ?? []) as { step: string; ms: number | null; by: string; ownMs: number | null }[])
      stable.push(`A take of the front: ${g.step}: ${g.ms === null ? "did not come back" : `${g.ms} ms`}, given back by ${g.by}${g.ownMs !== null ? ` (the prototype's own after-ms ${g.ownMs})` : ""}.`);
    for (const b of (stableResult.back ?? []) as BackRow[]) stable.push(`${b.step}: ${b.ok ? "" : `FAIL ${b.error ?? ""}; `}the opener ${b.opener}; after: ${b.after}; the front app ${b.front}; the Space ${b.space}.`);
    for (const w of ((stableResult.windows ?? []) as WindowRow[]).filter((x) => x.cg !== "no new window")) stable.push(`New window: ${w.step}: ${placementText(w.placement)}; on screen ${w.onscreen}; the Space ${w.space}.`);
  } else {
    stablePart = { ok: false, problems: [`it ended with exit ${code ?? "?"} after ${Math.round((Date.now() - t0) / 1000)} s and wrote no results${code === 2 ? " (exit 2: it refused before its Chrome started; see its output above)" : ""}`], popupOnly: false };
    stable.push(`The second part (${dir}): ${stablePart.problems[0]}.`);
  }
}
if (!O.dryRun && !O.watcher && watcher.exitCode !== null && inRun(watcherBin)) {
  try { rmSync(watcherBin); compiled = undefined; endLines.push(`removed the compiled watcher (${watcherBin})`); } catch (e) { endLines.push(`could not remove ${watcherBin}: ${(e as Error).message}`); }
}

// ------------------------------------------------------------------ analysis
const watchText = existsSync(watchFile) ? readFileSync(watchFile, "utf8") : "";
const { bad } = parseWatchLog(watchText);
const E = events.filter((e) => e.t <= measureEnd!);
/** agent-browser's give-back watcher's lines (src/watchback.ts) in this run's launches.log. */
const backLines = builtLines();
const { operator, takes } = frontTakes(E, steps);
const spaces = spaceChanges(E, steps);
const wprob = O.dryRun ? [] : watcherProblems(E, bad, ready.t, measureEnd);
// The front step (ab-v16.27): its take is on purpose; the watcher must leave it to the operator, and the front must come back.
const frontStep = steps.find((x) => `${x.phase}: ${x.name}` === FRONT_STEP);
const frontProblem = !frontStep ? undefined : frontStepProblem(backLines, frontStep, takes, FRONT_STEP)
  ?? (takes.some((t) => t.step.startsWith(FRONT_STEP) && t.t1 === null) ? "the front did not come back to the operator's app after front" : undefined);
const wbProblems = wbStarted ? watchBackProblems(backLines, { quitAt: endStep?.phase === "end" ? endStep.t0 : undefined, aborted: !!aborted, look: !!O.look }) : [];
const v: Verdict = joinVerdicts(verdict({ takes, spaces, watcher: wprob, missing: notRun, aborted, error: fatal, quit: quitProblem,
  front: frontStep ? { step: FRONT_STEP, problem: frontProblem } : undefined, watchBack: wbProblems }), stablePart, "the Google Chrome stable part");
const sorted = log.slice().sort((a, b) => a.t - b.t);
const S = (phase: string, name: string) => steps.find((s) => s.phase === phase && s.name === name);
const after = (label: string) => snapOf(E, `after ${label}`), before = (label: string) => snapOf(E, `before ${label}`);
const opPid = operator?.pid ?? -1, agentPid = chromePid ?? -1;
const frontName = (t: number) => { const f = frontAt(E, t); return f ? `${f.name}${f.pid === opPid ? "" : " (NOT the operator's app)"}` : "?"; };
const tookIn = (s: Step) => takes.filter((t) => t.step.startsWith(`${s.phase}: ${s.name}`)).map((t) => `took the front ${t.ms} ms`).join(", ");
function driveRow(s: Step | undefined, tab: string, others: string[]): DriveRow | undefined {
  if (!s) return undefined;
  const g = stepSignals(sorted, tab, s.t0, s.t1);
  const other = others.map((o) => { const x = stepSignals(sorted, o, s.t0, s.t1); return `${o} ${[...x.focusEvents, ...x.visChanges].join(" ") || "-"}`; }).join("; ");
  return {
    step: s.name, ok: s.ok, ms: s.t1 - s.t0, ...(s.error ? { error: s.error } : {}),
    vis: `${g.visBefore ?? "(no page yet)"}${g.visChanges.length ? ` [${g.visChanges.join(" ")}]` : ""}, visible ${g.visibleMs} ms`,
    focus: `${g.focusEvents.join(" ") || "-"}; after: ${g.focusAfter}`,
    frames: `${g.framesDuring} during, ${g.framesAfter} in the s after`, others: other,
    front: [frontName(s.t1 + 1000), tookIn(s)].filter(Boolean).join("; "),
  };
}
const label = (s: Step) => `${s.phase}: ${s.name}`;
const nOf = (name: string) => { const w = wins[name]; if (!w) return undefined; const s = steps.find((x) => x.name.startsWith(`open window ${name}`)); return s ? (matchWindow(newAgentWindows(before(label(s)), after(label(s))), w.bounds) ?? newAgentWindows(before(label(s)), after(label(s)))[0])?.n : undefined; };
const nA = nOf("WA"), nB = nOf("WB");
const windowDrive = steps.filter((s) => s.phase === "window" && !s.name.startsWith("open window")).map((s) => {
  const tab = s.name.startsWith("WB") ? "WB" : "WA";
  const row = driveRow(s, tab, ["WA", "WB", "F0"].filter((x) => x !== tab));
  const snapAfter = after(label(s));
  if (row && snapAfter && nA !== undefined && nB !== undefined) {
    const list = windowsOf(snapAfter), pa = placement(list, agentPid, nA, opPid);
    row.order = `WA ${orderOf(list, agentPid, nA, nB) ?? "?"} WB; ${!pa ? "WA not on screen" : pa.aboveFrontWindow === null ? "no window of the front app on screen" : pa.aboveFrontWindow ? "WA ABOVE the front app's window" : "WA behind the front app's window"}`;
  }
  return row;
}).filter((x): x is DriveRow => !!x);
const windowRow = (s: Step | undefined, how: string, n?: number): WindowRow | undefined => {
  if (!s) return undefined;
  const a = after(label(s)), fresh = newAgentWindows(before(label(s)), a);
  const ns = n !== undefined ? [n] : fresh.map((w) => w.n);
  const all = agentWindowsOf(a);
  const pl = ns.length ? placement(windowsOf(a), agentPid, ns[0], opPid) : null;
  return {
    step: label(s), how, cg: ns.length ? ns.join(", ") : "no new window",
    placement: pl, onscreen: ns.length ? ns.map((x) => all.find((w) => w.n === x)?.onscreen ? "yes" : "no").join(", ") : "-",
    space: spaces.some((x) => x.step.startsWith(label(s))) ? "CHANGED" : "unchanged", front: frontName((a?.t ?? s.t1) + 0),
  };
};
const startStep = S("start", "agent Chrome start");
const windowRows = [
  windowRow(startStep, "the start's first window (open -n -g, then the give-back)", agentWindowsOf(after(startStep ? label(startStep) : ""))[0]?.n),
  windowRow(steps.find((s) => s.name.startsWith("open window WA")), "agent-browser open: Target.createTarget { newWindow: true, background: true }", nA),
  windowRow(steps.find((s) => s.name.startsWith("open window WB")), "agent-browser open: Target.createTarget { newWindow: true, background: true }", nB),
  ...POPUPS.map((p) => windowRow(S("popup", p.kind), p.kind)),
].filter((x): x is WindowRow => !!x);
// Each record's window at the record's start (its snap before): how much of it the operator's windows cover.
const nFirst = startStep ? agentWindowsOf(after(label(startStep)))[0]?.n : undefined;
for (const r of records) {
  const phase = r.where.startsWith("a page in a window") ? "window" : "tab";
  const s = steps.find((x) => x.phase === phase && x.name.endsWith("record 3 s"));
  const snapB = s && before(label(s)), n = phase === "window" ? nA : nFirst, who = phase === "window" ? "WA" : "the first window";
  if (!snapB || n === undefined) continue;
  const pl = placement(windowsOf(snapB), agentPid, n, opPid), w = agentWindowsOf(snapB).find((x) => x.n === n);
  r.covered = `${who}: ${pl ? `${Math.round(pl.coveredByOperator * 100)} % covered, ${pl.aboveFrontWindow === null ? "no window of the front app on screen" : pl.aboveFrontWindow ? "above the front app's window" : "behind the front app's window"}`
    : w ? (w.onscreen ? "on screen" : "off screen (minimized, or another Space)") : "not found"}`;
}
const focusLine = (name: string, a: string, b: string) => {
  const s = steps.find((x) => x.phase === "window" && x.name === name);
  if (!s) return undefined;
  const ga = stepSignals(sorted, a, s.t0, s.t1), gb = stepSignals(sorted, b, s.t0, s.t1);
  return `${name}: ${a} ${ga.focusEvents.join(" ") || "no focus or blur"} (has the focus after: ${ga.focusAfter}); ${b} ${gb.focusEvents.join(" ") || "no focus or blur"} (after: ${gb.focusAfter}); both pages focused ${bothFocusedMs(sorted, "WA", "WB", s.t0, s.t1 + 1200)} ms; the front app ${frontName(s.t1 + 1000)}`;
};
const focus = [
  focusLine("WA: click", "WA", "WB"),
  focusLine("WB: click (WA had the focus)", "WB", "WA"),
  (() => {
    const l = focusLine("WA: keys with no click (WB has the focus)", "WA", "WB"), k = details.keys as { charsBefore: number; chars: number; theCheckKeys: boolean } | undefined;
    return l && `${l}; WA's field: ${k ? `${k.charsBefore} characters before the keys, ${k.chars} after (${k.theCheckKeys ? "the check's keys arrived" : "NOT only the check's keys"})` : "not read"}`;
  })(),
  focusLine("WB: click (WA had the focus again)", "WB", "WA"),
  focusLine("WA: click (WB had the focus)", "WA", "WB"),
  (() => { const l = focusLine("WA: person-shaped click and typing", "WA", "WB"); const s = steps.find((x) => x.name === "WA: person-shaped click and typing"); if (!l || !s) return l; const g = stepSignals(sorted, "WA", s.t0, s.t1); return `${l}; input: ${g.moves} moves (${g.movesWithMovement} with movement), press ${g.downUpMs} ms, pressure ${g.pressure}, screen - client ${JSON.stringify(g.screenMinusClient)}, ${g.keydowns} keydown, pointer jumps ${g.pointerJumps}; path from ${JSON.stringify(details.person ?? null)}`; })(),
].filter((x): x is string => !!x);
const popups: PopupRow[] = POPUPS.map((p): PopupRow | undefined => {
  const s = S("popup", p.kind), i = popupInfo[p.tab];
  if (!s) return undefined;
  const g = stepSignals(sorted, "WA", s.t0, s.t1);
  const fresh = newAgentWindows(before(label(s)), after(label(s)));
  return {
    kind: p.kind, asked: p.asked, where: i ? (i.inOpener ? "a tab in the opener's window" : "a window of its own") : `- (${s.error ?? "?"})`,
    outer: i ? `${i.ow}x${i.oh} (inner ${i.iw}x${i.ih})` : "-", popup: i ? `${i.vis}, focus ${i.focus}, history.length ${i.hl}` : "-",
    opener: `${[...g.focusEvents, ...g.visChanges].join(" ") || "-"}; after: ${g.visAfter}, focus ${g.focusAfter}`,
    front: [frontName(s.t1 + 1000), tookIn(s)].filter(Boolean).join("; "),
    placement: fresh.length ? placement(windowsOf(after(label(s))), agentPid, fresh[0].n, opPid) : null,
  };
}).filter((x): x is PopupRow => !!x);
// ------------------------------------------------------------------ the popup rule as built, and who gave the front back
const back: BackRow[] = POPUPS.flatMap((p) => (["drive", "back", "next"] as const).filter((w) => w !== "drive" || p.drive).map((what) => {
  const name = backName(p, what), s = S("popup", name);
  if (!s) return undefined;
  const g = stepSignals(sorted, "WA", s.t0, s.t1), b = backInfo[p.tab], d = driveInfo[p.tab], n = nextInfo[p.tab];
  const pg = what === "drive" ? stepSignals(sorted, p.tab, s.t0, s.t1) : undefined;
  const snapA = after(label(s)), pa = snapA && nA !== undefined ? placement(windowsOf(snapA), agentPid, nA, opPid) : null;
  // The next click's wait: from the step's start to the opener's first input event (agent-browser waits until it shows).
  const firstIn = inputs(sorted, "WA", s.t0, s.t1)[0];
  const how = what === "drive" ? `agent-browser's click in ${p.tab} (the popup rule: drive the new tab); ${p.tab} ${[...pg!.focusEvents, ...pg!.visChanges].join(" ") || "no focus, blur or visibility change"}; after: ${d ? `${d.popup.vis}, document.hasFocus() ${d.popup.focus}` : "not read"}`
    : what === "next" ? `agent-browser's click in WA: its first input event ${firstIn ? `${firstIn.t - s.t0} ms after the step began` : "not seen"}`
    : String(b?.closedBy ?? (p.back === "close" ? "agent-browser's close" : "its own window.close()")) + (b && !b.gone ? `; ${p.tab} did NOT close` : "");
  return {
    step: label(s), how, ok: s.ok, ms: s.t1 - s.t0, ...(s.error ? { error: s.error } : {}),
    opener: `WA ${[...g.focusEvents, ...g.visChanges].join(" ") || "-"}`,
    after: what === "drive" ? (d ? `${d.opener.vis}, document.hasFocus() ${d.opener.focus}` : "not read") : what === "next" ? (n ? `${n.vis}, document.hasFocus() ${n.focus}` : "-") : "-",
    front: [frontName(s.t1 + 1000), tookIn(s)].filter(Boolean).join("; "),
    space: spaces.some((x) => x.step.startsWith(label(s))) ? "CHANGED" : "unchanged",
    order: nA === undefined ? "?" : `WA: ${placementText(pa)}`,
  };
})).filter((x): x is BackRow => !!x);
const giveBack = giveBackRows(takes, backLines, holds, fallbacks.map((f) => f.t));
const wbStep = S("giveback", "agent-browser's give-back watcher (started by AgentBrowser.connect)");
const watchBack = watchBackText(backLines, { started: wbStarted ?? (wbStep?.error ? `It did not watch: ${wbStep.error}` : undefined), quitAt: endStep?.phase === "end" ? endStep.t0 : undefined });
const frontLines = !frontStep ? [O.skip.includes("front") ? "Left out by --skip front." : "Not run."]
  : !frontStep.ok ? [`front failed (${frontStep.error}): the watcher's rule for front is not measured in this run.`] : [
    `front brought the agent Chrome to the front (${frontStep.t1 - frontStep.t0} ms in all, with the check's wait of ${FRONT_STEP_MS} ms).`,
    ...backLines.filter((l) => l.t >= frontStep.t0 && l.t <= frontStep.t1 + 1500 && ("took" in l.kv || "asked" in l.kv || "back" in l.kv || "own" in l.kv)).map((l) => `The watcher: ${l.text}`),
    frontProblem ? `PROBLEM: ${frontProblem}.` : "The watcher left the agent Chrome in front (it did not fight the operator), and the check gave the front back.",
  ];
const finalSnap = after("facts: the agent app's windows");
const agentAll = agentWindowsOf(finalSnap), app = finalSnap?.agentApp as { policy?: number; hidden?: boolean; active?: boolean } | undefined;
const windowIds = [...new Set(pages.map((p) => p.windowId).filter((x) => x !== undefined))];
const apis = O.dryRun ? ["(dry run: no macOS window list)"] : [
  `The agent Chrome has ${agentAll.length} window(s) of layer 0 (CGWindowList, every window of its pid): ${agentAll.filter((w) => w.onscreen).length} on the screen of the current Space, ${agentAll.filter((w) => !w.onscreen).length} off it. Mission Control shows the windows of the current Space; App Expose and the Dock menu of the agent Chrome's icon list its windows.`,
  `CDP: ${pages.length} page(s) in ${windowIds.length} window(s): ${pages.map((p) => `"${p.title}" (window ${p.windowId}, ${p.state ?? "?"})`).join(", ")}. The first window has the name of --window-name (agent-browser's launch sets it); the Dock menu shows that name or the page title.`,
  `The agent app: activation policy ${app?.policy === 0 ? "regular (a Dock icon and a Cmd-Tab entry of its own)" : app?.policy ?? "?"}, hidden ${app?.hidden}, active ${app?.active}.`,
  "Cmd-` cycles the windows of the app in front only. The agent Chrome is an app of its own (its own pid, Dock icon and Cmd-Tab entry: check 6 of docs/research/2026-11-03-chrome-vs-chrome-beta.md), so Cmd-` in the operator's app does not reach an agent window while the agent Chrome is not in front (from that check, not measured here).",
];
const pointer = { at: realPointer(E), real: realPointerEvents(sorted, realPointer(E), ["F0", "WA", "WB", "PA", "PB", "PC"], steps) };
const notMeasured = [
  "A tab switch back to an opener while its popup tab stays open: CDP has no tab switch without an activation (Target.activateTarget and Page.bringToFront activate the window), so the Mac design has none: agent-browser refuses input to such an opener after its wait (input.ts), and this check does not try it.",
  "The give-back watcher's rule for a person's own switch to the agent Chrome (a click, Cmd-Tab): the check makes no person's input; test/watchback.test.ts covers the rule, and this check covers agent-browser's front (its front step).",
  "Window activation (Target.activateTarget, Page.bringToFront, the relay's chrome.windows.update({ focused: true })): the Mac design never activates a window, and the research says that it can bring the agent's app to the front (section 7). The check never sends them.",
  "Target.createTarget with newWindow and no background (a window shown in front): not sent.",
  "The relay's chrome.windows.create({ focused: false }): it needs the agent extension, which Google Chrome on macOS does not load from the command line (the 2026-11-03 report, check 1).",
  "Mission Control, App Expose, the Dock menu and Cmd-` as the operator sees them: only with --look (the operator's one short look).",
  "A full-screen app in front, Chrome Beta assigned to a desktop of its own, and a second display: the check refuses a full-screen front window and moves no window between displays.",
  "navigator.webdriver: the check's --remote-debugging-port sets it; agent-browser's own transport does not.",
  "Page freezing and intensive timer throttling after 5 minutes hidden: the run keeps a page hidden for less than a minute.",
  ...(O.skip.length ? [`Left out by --skip: ${O.skip.join(", ")}.`] : []),
];
const startGB = existsSync(launches) ? readFileSync(launches, "utf8").split("\n").flatMap((l) => { const m = /^\S+ (give-back .+|chrome=.+)$/.exec(l); return m ? [m[1]] : []; }) : [];
const result: MacResult = {
  ok: v.ok, problems: v.problems, popupOnly: v.popupOnly, end: endLines, dryRun: O.dryRun, run: RUN, startedAt: new Date(T0).toISOString(), seconds: Math.round((Date.now() - T0) / 1000),
  chrome: O.chromeBin, product: browser?.product ?? "?", flags: CHROME_ARGS.map((a) => a.startsWith("--user-data-dir=") ? "--user-data-dir=<run>/state/profile" : a.startsWith("--window-name=") ? "--window-name=<name>" : a),
  operator, frontAtEnd: frontAt(E, measureEnd), takes, spaces, startGiveBack: startGB,
  windows: windowRows, windowDrive, records, focus, popups, pointer, apis, look: LOOK, notMeasured,
  ...(O.part ? { part: O.part } : {}), back, giveBack, watchBack, stable, front: frontLines,
};
const text = summary(result);
writeFileSync(join(RUN, "summary.md"), text);
// The probe's log has no key values (probeRecord), and details.keys only a length (fieldText).
writeFileSync(join(RUN, "results.json"), `${JSON.stringify({ options: O, result, steps, notRun, stop: stopInfo ?? null, details, popupInfo, backInfo, driveInfo, nextInfo, holds, fallbacks, pages, wins, watch: events, watchBack: backLines, probe: log }, null, 1)}\n`);
process.stdout.write(`${text}\n(results: ${join(RUN, "results.json")})\n`);
process.exit(v.ok ? 0 : 1);
