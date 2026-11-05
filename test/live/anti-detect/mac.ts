// The macOS check of drive, record and one window per page (board task ab-v16.16, for ab-v16.27; the research is
// docs/research/2026-11-05-anti-detect-drive.md, sections 7 and 8). Not part of `npm test`; its pure parts
// (mac-rules.ts) are, in test/mac-measure.test.ts.
//
//   node test/live/anti-detect/mac.ts --on-my-screen --out-dir DIR [--chrome-bin APP_BINARY] [--watcher BIN]
//        [--ffmpeg PATH] [--look SECONDS] [--skip record,popups,person]
//   node test/live/anti-detect/mac.ts --dry-run --out-dir DIR [--chrome /usr/bin/chromium] [--display 123]   (Linux)
//
// On the Mac it runs with one command, in about 3 minutes, with nobody at the keyboard: the operator leaves the Mac
// unlocked and awake, with no full-screen app in front, and does not use it during the run. It starts its own agent
// Chrome (the app of --chrome-bin; default agent-browser's: Google Chrome Beta when it is installed, else Google
// Chrome) on a new profile in its run folder, as agent-browser's launch does: `open -n -g` with agent-browser's
// give-back guard (src/giveback.ts) and AGENT_ARGS (today's flags: no timer flag,
// --disable-backgrounding-occluded-windows). It adds only what the measurement needs: --remote-debugging-port=0
// (so that no "Allow remote debugging?" prompt needs a person; it sets navigator.webdriver, which this check does
// not measure), --use-mock-keychain (no keychain prompt), and no network (every host but probe.localhost fails to
// resolve and goes to a dead proxy). The debugging port is an exception (named in the README) to its rule against that flag:
// 127.0.0.1 only, an empty profile, no network, for the few minutes of the run. agent-browser's commands reach that
// Chrome through agent-browser's own proxy (the `endpoint` option), as on the Mac today. It never touches the
// operator's Chrome or another Chrome. No other agent session may use the Mac's agent browser during the run: a
// take of the front by another Chrome counts against the check.
//
// A watcher (mac-watch.swift, compiled into the run folder with the Xcode Command Line Tools' swiftc; or --watcher
// BIN) logs the front app, the pointer, the Space, the on-screen window order (CGWindowList) and the lock state,
// and gives the front back: each time the agent Chrome is the front app, it asks macOS to activate the operator's
// app again. At the first sign of a person (a pointer move, or the hardware's key press, modifier, click or scroll)
// the watcher stops that by itself. The check never moves the pointer and sends no OS input. It stops early (skips the
// steps left and quits its Chrome) when a person uses the Mac (a pointer move or such input), the screen locks, the
// display sleeps, another user's session comes to the front, the Space changes, the front does not come back in
// 1.5 s, the watcher ends or goes silent for 3 s, or the run reaches its time limit (stopReason in mac-rules.ts).
//
// What it measures, in the order it runs (each step's page signals come from the probe page, probe.ts):
//   start   the agent Chrome's start: the front app before and after (the give-back), where its first window comes
//   tab     today's agent mode: agent-browser's `open` (a background tab in the first window), then text, click,
//           type, press, shot and a 3 s record of that background tab (the README's macOS record table)
//   window  one window per agent page: two windows from Target.createTarget { newWindow: true, background: true },
//           each one's place in the window order (above or behind the operator's windows), the Space and the front
//           app; agent-browser's commands with no focus emulation (hiddenDrive) and a 3 s record in a window; a
//           click in the second window (does the first page get a blur?), keys into the first window with no click
//           (an inactive window), person-shaped CDP input (from the real pointer, when it is over the page), and a
//           click back in the first window
//   facts   what an API gives of Mission Control, App Expose, the Dock menu and Cmd-` (the agent app's windows, on
//           and off screen, its activation policy, the window titles); before the popups, which can take the front
//   popup   from a page in its own window: a target=_blank link, window.open() with no features, and window.open()
//           with "popup,width=500,height=400": a tab or a window, its size, the opener's and the popup's state
//   look    only with --look SECONDS: the give-back stops, the agent windows stay open for that long, and the
//           summary lists the one short look for the operator (Mission Control, the Dock menu, App Expose, Cmd-`)
// The real pointer: every probe event at the real pointer's point (macOS gave it, not the check's CDP input).
//
// It writes DIR/run-XXXXXX/results.json (every step, the watcher's log, the probe's log, the analysis) and
// summary.md, and prints the summary. At the end it quits its Chrome (Browser.close, else SIGTERM, else SIGKILL, each
// to the pid on its own profile, looked up again right before it: quitAgentChrome) and removes the throwaway profile
// (only when ps shows that its Chrome quit) and the compiled watcher. `open` starts Chrome
// under launchd, so a kill -9 of node leaves it running: the check prints at the start, and writes to
// DIR/run-XXXXXX/stop-chrome.txt, how to stop it by hand.
//   exit 0  every phase ran; the start's take of the front, if any, followed agent-browser's give-back rule (at most
//           250 ms away, to the agent Chrome only, and back); after the start the front app never changed; the
//           Space never changed; and the watcher shows both (it ran all the time, the screen stayed unlocked and
//           awake, and the pointer did not move)
//   exit 1  the check took the operator's focus or Space, could not show that it did not, did not finish, or its
//           Chrome did not quit: summary.md names each problem (a failed step is a measurement, not a problem). When
//           the only problems are popup takes that came back, the summary says so: an expected result of the design
//           (Chrome can activate itself when it shows a popup)
//   exit 2  it refused to start, and nothing started on the screen: a usage error, not macOS (or not Linux for
//           --dry-run), no ffmpeg with libx264 (on PATH, in /opt/homebrew/bin or /usr/local/bin; or --ffmpeg; or
//           --skip record), no swiftc with a macOS SDK (it compiles with -sdk, so swiftc never starts xcrun), a watcher
//           that did not compile, a locked screen, no front app, a full-screen app in front
// --dry-run (Linux only) runs every phase against Chromium in a private Xvfb, with a stand-in watcher
// (mac-standin.ts: no front app, no Space, no window list): a test of the drive and the analysis, not a Mac result.
// It ends only its own processes, each by the pid that it recorded: the agent Chrome on its own profile, the proxy
// of its own state folder, the watcher, caffeinate (which keeps the display awake for the run) and, in the dry run,
// its Xvfb and Chromium.

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { AGENT_ARGS, agentChromeBin, agentChromePid, appBundle } from "../../../src/agent.ts";
import { AgentBrowser } from "../../../src/browser.ts";
import type { CDPConnection } from "../../../src/cdp.ts";
import { commands } from "../../../src/commands.ts";
import { GIVE_BACK_GRACE_MS, giveBackToken, startGiveBack, type GiveBack } from "../../../src/giveback.ts";
import { MAX_SOCKET_PATH_BYTES, resolveOptions, type BrowserOptions, type Settings } from "../../../src/options.ts";
import { stopProxy } from "../../../src/proxy.ts";
import { findFfmpeg } from "../../../src/record.ts";
import {
  agentWindowsOf, ffmpegSearchPath, quitAgentChrome, frontAt, frontTakes, macArgs, matchWindow, newAgentWindows, orderOf, parseWatchLog, placement, realPointer, realPointerEvents,
  screenProblem, snapOf, spaceChanges, stopReason, summary, swiftTools, verdict, watcherProblems, windowsOf,
  type DriveRow, type MacResult, type PopupRow, type RecordRow, type Step, type WatchEvent, type WindowRow,
} from "./mac-rules.ts";
import { bothFocusedMs, LAYOUT, startServer, stepSignals, type Rec } from "./probe.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
function refuse(message: string): never { process.stderr.write(`${message}\n`); process.exit(2); }
const parsed = macArgs(process.argv.slice(2), { platform: process.platform, exists: existsSync, defaultChrome: agentChromeBin({ chromeBin: undefined }) });
if (!parsed.ok) refuse(parsed.message);
const O = parsed.options;
const OUT = resolve(O.outDir);
mkdirSync(OUT, { recursive: true });
const RUN = mkdtempSync(join(OUT, "run-"));
const T0 = Date.now();
/** The whole run stops its measurement after this (the brief: under 10 minutes). */
const LIMIT_MS = 9 * 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const say = (line: string) => process.stderr.write(`${new Date().toISOString().slice(11, 23)} ${line}\n`);
say(`${O.dryRun ? "DRY RUN (Linux): " : ""}run folder ${RUN}`);
// The records need ffmpeg with libx264: without it the run has no record numbers, so it refuses before anything starts.
let ffmpeg: string | undefined;
if (!O.skip.includes("record")) {
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
process.on("exit", () => {
  if (settings) { try { stopProxy(settings); } catch { /* not started */ } }
  const pid = ownChrome();
  if (pid) { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } }
  for (const c of children.slice().reverse()) if (c.exitCode === null && c.signalCode === null) c.kill("SIGTERM");
});
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => process.exit(130));

// ------------------------------------------------------------------ the dry run's private Xvfb
const XENV: NodeJS.ProcessEnv = { ...process.env };
if (O.dryRun) {
  const field = (b: Buffer) => { const n = Buffer.alloc(2); n.writeUInt16BE(b.length); return Buffer.concat([n, b]); };
  const xauth = join(RUN, "Xauthority");
  writeFileSync(xauth, Buffer.concat([Buffer.from([0xff, 0xff]), field(Buffer.alloc(0)), field(Buffer.from(String(O.display))), field(Buffer.from("MIT-MAGIC-COOKIE-1")), field(randomBytes(16))]), { mode: 0o600 });
  if (existsSync(`/tmp/.X11-unix/X${O.display}`)) refuse(`display :${O.display} is in use; pass --display N`);
  const xvfb = spawn("Xvfb", [`:${O.display}`, "-auth", xauth, "-nolisten", "tcp", "-screen", "0", "1600x1000x24"], { stdio: "ignore" });
  children.push(xvfb);
  for (let i = 0; i < 50 && !existsSync(`/tmp/.X11-unix/X${O.display}`) && xvfb.exitCode === null; i++) await sleep(100);
  await sleep(300);
  if (xvfb.exitCode !== null || !existsSync(`/tmp/.X11-unix/X${O.display}`)) refuse(`Xvfb did not start on :${O.display}`);
  Object.assign(XENV, { DISPLAY: `:${O.display}`, XAUTHORITY: xauth });
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
createInterface({ input: watcher.stdout! }).on("line", (line) => {
  appendFileSync(watchFile, `${line}\n`);
  try { const e = JSON.parse(line); if (typeof e?.t === "number" && typeof e.ev === "string") events.push(e); } catch { /* counted as bad in the analysis */ }
});
const tell = (cmd: string) => { if (watcher.stdin?.writable) watcher.stdin.write(`${cmd}\n`); };
async function waitEvent(pred: (e: WatchEvent) => boolean, ms: number): Promise<WatchEvent | undefined> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) { const e = events.find(pred); if (e) return e; }
  return undefined;
}
async function snap(label: string): Promise<WatchEvent | undefined> {
  tell(`snap ${label}`);
  return waitEvent((e) => e.ev === "windows" && e.why === "snap" && e.label === label, 3000);
}
const ready = await waitEvent((e) => e.ev === "ready", 20_000);
if (!ready) refuse(`the watcher did not start (see ${join(RUN, "watch.err")})`);
await sleep(400);
if (!O.dryRun) {
  const problem = screenProblem(events);
  if (problem) refuse(`refusing, nothing started: ${problem}`);
  // The display and the system stay awake for the run (an assertion that ends with this process).
  children.push(spawn("/usr/bin/caffeinate", ["-d", "-i", "-w", String(process.pid)], { stdio: "ignore" }));
}
say(`watcher ready: front app ${ready.front?.name} (pid ${ready.front?.pid}), pointer ${JSON.stringify(ready.pointer)}, Space ${ready.space ?? "unknown"}`);

// ------------------------------------------------------------------ the probe pages
const log: Rec[] = [];
const { server, port } = await startServer(log);
const urlOf = (tab: string) => `http://probe.localhost:${port}/p?tab=${tab}`;
async function loaded(tab: string, ms = 15_000): Promise<void> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (log.some((e) => e.tab === tab && e.ev === "load")) return;
  throw new Error(`page ${tab} did not load in ${ms / 1000} s`);
}

// ------------------------------------------------------------------ steps, and the stop rules
const steps: Step[] = [];
const notRun: string[] = [];
let aborted: string | undefined;
/** The end of the measurement: before the look (--look), else after the end step. The stop rules and the analysis cover only the time before it. */
let measureEnd: number | undefined;
function checkHarm() {
  if (aborted) return;
  const why = stopReason(events, steps, Date.now(), { t0: T0, limitMs: LIMIT_MS, measureEnd });
  if (!why) return;
  aborted = why;
  tell("disarm"); // the watcher also stops its give-back by itself at a pointer move
  say(`STOP: ${why}`);
}
/** One step: a snap of the windows before and after it (with `snap`), its time, its error; after it, the stop rules. `always`: it runs also after a stop. */
async function step<T>(phase: string, name: string, fn: () => Promise<T>, o: { limitMs?: number; tailMs?: number; snap?: boolean; always?: boolean } = {}): Promise<T | undefined> {
  const label = `${phase}: ${name}`;
  if (aborted && !o.always) { notRun.push(label); return undefined; }
  if (o.snap) await snap(`before ${label}`);
  await sleep(300);
  const t0 = Date.now();
  let ok = true, error: string | undefined, value: T | undefined, timer: NodeJS.Timeout | undefined;
  const limit = o.limitMs ?? 25_000;
  try { value = await Promise.race([fn(), new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`no end in ${limit / 1000} s`)), limit); })]); }
  catch (e) { ok = false; error = String((e as Error)?.message ?? e).split("\n")[0].slice(0, 240); }
  finally { clearTimeout(timer); }
  const t1 = Date.now();
  steps.push({ phase, name, t0, t1, ok, ...(error ? { error } : {}) });
  say(`${label}: ${ok ? "ok" : `FAILED: ${error}`} (${t1 - t0} ms)`);
  await sleep(o.tailMs ?? 1200);
  if (o.snap) await snap(`after ${label}`);
  checkHarm();
  return value;
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
  }
  throw new Error(`no DevToolsActivePort in ${ms / 1000} s`);
}
await step("start", "agent Chrome start", async () => {
  let guard: GiveBack | undefined;
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
  } finally {
    await guard?.finish(endpoint ? GIVE_BACK_GRACE_MS : 0);
    // From now on the watcher gives the front back (agent-browser's own guard ended with the start). Until it knows the
    // pid, a new instance of the agent's app bundle counts as the agent Chrome.
    tell("arm");
  }
  for (let i = 0; i < 50 && !chromePid; i++, await sleep(100)) chromePid = ownChrome();
  // `open` starts Chrome under launchd, not as this process's child: if this process is killed (kill -9), Chrome stays.
  const help = chromePid
    ? `If this check ends without quitting its agent Chrome (kill -9 of node), stop that Chrome by hand: check that \`ps -o command= -p ${chromePid}\` shows --user-data-dir=${profile}, then run \`kill ${chromePid}\` (the pid is also in the "agent" line of ${watchFile}).`
    : `The check did not find its agent Chrome's pid (ps). If that Chrome still runs after the check, find it with \`ps axww -o pid,command | grep -F -- '--user-data-dir=${profile}'\` and stop its main process (the line with no --type=) with kill PID.`;
  writeFileSync(join(RUN, "stop-chrome.txt"), `${help}\n`);
  say(help);
  if (!chromePid) throw new Error("the agent Chrome's pid was not found on its profile (ps)");
  tell(`agent ${chromePid}`);
  await loaded("F0");
}, { limitMs: 45_000, snap: true });

// ------------------------------------------------------------------ agent-browser through its own proxy
const base: BrowserOptions = { stateDir, socketPath, allow: ["probe.localhost"], ...(endpoint ? { endpoint } : {}), commandName: "mac check", proxyIdleMs: 60_000, log: (l) => say(`agent-browser: ${l}`) };
const oTab: BrowserOptions = { ...base, hiddenDrive: false }, oWin: BrowserOptions = { ...base, hiddenDrive: true };
let browser: AgentBrowser | undefined, fatal: string | undefined;
if (endpoint && !aborted) {
  settings = resolveOptions(base);
  try { browser = await AgentBrowser.connect(base); } catch (e) { fatal = `agent-browser could not connect through its proxy: ${(e as Error).message.split("\n")[0]}`; say(fatal); }
} else if (!endpoint) fatal = "the agent Chrome did not start";
const raw = browser?.conn as CDPConnection;
const records: RecordRow[] = [];
async function recordStep(phase: string, name: string, o: BrowserOptions, tab: string, where: string): Promise<void> {
  if (O.skip.includes("record")) { records.push({ where, skipped: "--skip record" }); return; }
  if (!ffmpeg) { records.push({ where, error: "no ffmpeg" }); return; }
  const script = join(RUN, "record-steps.json");
  writeFileSync(script, JSON.stringify([{ wait: 3000 }]));
  const r = await step(phase, name, () => commands.record(o, { tab, out: join(RUN, `${phase}-${tab.replace(/\W/g, "")}.mp4`), script, fps: 60, ffmpeg }), { limitMs: 90_000, snap: true });
  const s = steps.at(-1);
  records.push(r ? { where, fps: +(r.frames / r.seconds).toFixed(1), frames: r.frames, seconds: +r.seconds.toFixed(2), maxFrameGapMs: r.maxFrameGapMs }
    : { where, error: s && s.phase === phase && s.name === name ? s.error ?? "failed" : "not run" });
}
const attachTo = async (targetId: string) => (await raw.send("Target.attachToTarget", { targetId, flatten: true })).sessionId as string;
const evaluate = async (sid: string, expression: string) => (await raw.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sid)).result?.value;
const targetOf = async (tab: string) => ((await raw.send("Target.getTargets")).targetInfos as { targetId: string; url: string; type: string }[]).find((t) => t.type === "page" && t.url.includes(`tab=${tab}`))?.targetId;

// ------------------------------------------------------------------ tab: today's agent mode, a background tab
if (browser) {
  await step("tab", "open a background tab (agent-browser open)", async () => { await commands.open(oTab, { url: urlOf("BG"), name: "bg" }); await loaded("BG"); }, { snap: true });
  await step("tab", "idle 3 s", () => sleep(3000));
  await step("tab", "text", () => commands.text(oTab, { tab: "bg" }));
  await step("tab", "click", () => commands.click(oTab, { tab: "bg", target: "#b" }));
  await step("tab", "type", () => commands.type(oTab, { tab: "bg", text: "hello", into: "#f" }));
  await step("tab", "press End", () => commands.press(oTab, { tab: "bg", key: "End" }));
  await step("tab", "shot", () => commands.shot(oTab, { tab: "bg", path: join(RUN, "tab-bg.png") }), { limitMs: 40_000 });
  await recordStep("tab", "record 3 s", oTab, "bg", "a background tab in its window (today's agent mode)");
}

// ------------------------------------------------------------------ window: one window per agent page
const wins: Record<string, { target: string; windowId?: number; bounds?: { left?: number; top?: number; width?: number; height?: number } }> = {};
const details: Record<string, unknown> = {};
async function keysInto(targetId: string, text: string): Promise<string> {
  const sid = await attachTo(targetId);
  try {
    for (const ch of text) {
      const code = `Key${ch.toUpperCase()}`, vk = ch.toUpperCase().charCodeAt(0);
      await raw.send("Input.dispatchKeyEvent", { type: "keyDown", key: ch, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, text: ch, unmodifiedText: ch }, sid);
      await sleep(40);
      await raw.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }, sid);
      await sleep(90);
    }
    return String(await evaluate(sid, "document.getElementById('f').value"));
  } finally { await raw.send("Target.detachFromTarget", { sessionId: sid }).catch(() => {}); }
}
/** Person-shaped CDP input (the research's humanCdp): a curved path of 20 moves, a 70 ms press with force 0.5, one key pair per character. */
async function personInput(targetId: string): Promise<unknown> {
  const sid = await attachTo(targetId);
  const send = (m: string, p: object) => raw.send(m, p, sid);
  try {
    const g = await evaluate(sid, "({ sx: screenX, sy: screenY, ow: outerWidth, oh: outerHeight, iw: innerWidth, ih: innerHeight })") as Record<string, number>;
    const side = Math.max(0, Math.round((g.ow - g.iw) / 2)), ox = g.sx + side, oy = g.sy + g.oh - g.ih - side;
    const real = realPointer(events);
    const inside = real && real.x - ox >= 0 && real.x - ox < g.iw && real.y - oy >= 0 && real.y - oy < g.ih;
    let at = inside ? { x: real!.x - ox, y: real!.y - oy } : { ...LAYOUT.neutral };
    const from = { ...at };
    const move = async (to: { x: number; y: number }) => {
      for (let i = 1, n = 20; i <= n; i++) {
        const s = i / n, e = s * s * s * (10 - 15 * s + 6 * s * s);
        await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x + (to.x - at.x) * e + (i === n ? 0 : Math.sin(Math.PI * s) * 40), y: at.y + (to.y - at.y) * e });
        await sleep(14);
      }
      at = to;
    };
    const click = async (to: { x: number; y: number }) => {
      await move(to); await sleep(120);
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x: to.x, y: to.y, button: "left", buttons: 1, clickCount: 1, force: 0.5 });
      await sleep(70);
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, button: "left", buttons: 0, clickCount: 1 });
    };
    await click(LAYOUT.button);
    await sleep(300);
    await click({ x: LAYOUT.field.x + 90, y: LAYOUT.field.y });
    await sleep(200);
    for (const ch of "hello") {
      const code = `Key${ch.toUpperCase()}`, vk = ch.toUpperCase().charCodeAt(0);
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: ch, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, text: ch, unmodifiedText: ch });
      await sleep(40);
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: ch, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
      await sleep(90);
    }
    return { pathFrom: inside ? "the real pointer" : "a point of the page (the real pointer is not over it)", from, contentOrigin: { x: ox, y: oy } };
  } finally { await raw.send("Target.detachFromTarget", { sessionId: sid }).catch(() => {}); }
}
if (browser) {
  for (const name of ["WA", "WB"]) await step("window", `open window ${name} (Target.createTarget newWindow, background)`, async () => {
    const { targetId } = await raw.send("Target.createTarget", { url: urlOf(name), newWindow: true, background: true });
    wins[name] = { target: targetId };
    await loaded(name);
    const w = await raw.send("Browser.getWindowForTarget", { targetId });
    wins[name] = { target: targetId, windowId: w.windowId, bounds: w.bounds };
  }, { snap: true });
  await step("window", "idle 3 s", () => sleep(3000), { snap: true });
  const A = "tab=WA", B = "tab=WB";
  await step("window", "WA: text", () => commands.text(oWin, { tab: A }), { snap: true });
  await step("window", "WA: click", () => commands.click(oWin, { tab: A, target: "#b" }), { snap: true });
  await step("window", "WA: type", () => commands.type(oWin, { tab: A, text: "hello", into: "#f" }), { snap: true });
  await step("window", "WA: press End", () => commands.press(oWin, { tab: A, key: "End" }), { snap: true });
  await step("window", "WA: shot", () => commands.shot(oWin, { tab: A, path: join(RUN, "window-WA.png") }), { limitMs: 40_000, snap: true });
  await recordStep("window", "WA: record 3 s", oWin, A, "a page in a window of its own (the design)");
  await step("window", "WB: click (WA had the focus)", () => commands.click(oWin, { tab: B, target: "#b" }), { snap: true });
  details.keys = await step("window", "WA: keys with no click (WB has the focus)", () => keysInto(wins.WA.target, "keys"), { snap: true });
  await step("window", "WB: click (WA had the focus again)", () => commands.click(oWin, { tab: B, target: "#b" }), { snap: true });
  await step("window", "WA: click (WB had the focus)", () => commands.click(oWin, { tab: A, target: "#b" }), { snap: true });
  if (!O.skip.includes("person")) details.person = await step("window", "WA: person-shaped click and typing", () => personInput(wins.WA.target), { snap: true });
}

// ------------------------------------------------------------------ facts: what an API gives (before the popups, which can take the front)
const pages: { title: string; url: string; windowId?: number; state?: string }[] = [];
if (browser) await step("facts", "the agent app's windows", async () => {
  for (const t of ((await raw.send("Target.getTargets")).targetInfos as { targetId: string; type: string; title: string; url: string }[]).filter((x) => x.type === "page")) {
    const w = await raw.send("Browser.getWindowForTarget", { targetId: t.targetId }).catch(() => undefined);
    pages.push({ title: t.title, url: t.url.replace(/^http:\/\/probe\.localhost:\d+/, ""), windowId: w?.windowId, state: w?.bounds?.windowState });
  }
}, { snap: true });

// ------------------------------------------------------------------ popup: from a page in its own window
const POPUPS = [
  { id: "lk", y: 35, tab: "PA", kind: "a link with target=_blank", asked: "a tab" },
  { id: "o2", y: 85, tab: "PB", kind: "window.open() with no features", asked: "a tab" },
  { id: "o3", y: 135, tab: "PC", kind: "window.open() with popup,width=500,height=400", asked: "a window, outer 500x400 (inner 500x400 asked)" },
] as const;
const popupInfo: Record<string, Record<string, unknown>> = {};
if (browser && !O.skip.includes("popups") && !wins.WA) notRun.push("popup: every popup step (window WA did not open)");
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
      const sid = await attachTo(wins.WA.target);
      try {
        for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await raw.send("Input.dispatchMouseEvent", { type, x: 360, y: p.y, button: "left", clickCount: 1, buttons: type === "mousePressed" ? 1 : 0 }, sid);
      } finally { await raw.send("Target.detachFromTarget", { sessionId: sid }).catch(() => {}); }
      await loaded(p.tab, 8000);
      await sleep(1000);
      const pt = await targetOf(p.tab);
      if (!pt) throw new Error(`no target for ${p.tab}`);
      const pw = await raw.send("Browser.getWindowForTarget", { targetId: pt }), ow = await raw.send("Browser.getWindowForTarget", { targetId: wins.WA.target });
      const ps = await attachTo(pt);
      try {
        const st = await evaluate(ps, "({ ow: outerWidth, oh: outerHeight, iw: innerWidth, ih: innerHeight, vis: document.visibilityState, focus: document.hasFocus(), hl: history.length })") as Record<string, unknown>;
        popupInfo[p.tab] = { target: pt, inOpener: pw.windowId === ow.windowId, bounds: pw.bounds, ...st };
      } finally { await raw.send("Target.detachFromTarget", { sessionId: ps }).catch(() => {}); }
    }, { limitMs: 20_000, snap: true });
    const pt = popupInfo[p.tab]?.target as string | undefined;
    if (pt) await step("popup", `close ${p.tab}`, () => raw.send("Target.closeTarget", { targetId: pt }), { tailMs: 800, snap: true });
  }
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
await step("end", "quit the agent Chrome", async () => {
  if (chromePid === undefined && chromeNow() === null) { quit = { running: false }; endLines.push("no agent Chrome ran on the run's profile"); return; }
  // Each signal goes only to the pid that ps shows on this run's own profile at that moment (chromeNow).
  const q = await quitAgentChrome({
    check: chromeNow, close: async () => { if (raw) await raw.send("Browser.close", {}, undefined, 5000); },
    signal: (pid, sig) => { try { process.kill(pid, sig); } catch { /* gone */ } }, sleep,
  });
  quit = q;
  quitProblem = q.problem;
  endLines.push(...q.lines);
}, { limitMs: 45_000, tailMs: 1500, always: true });
const endStep = steps.at(-1);
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
if (!O.dryRun && !O.watcher && watcher.exitCode !== null && inRun(watcherBin)) {
  try { rmSync(watcherBin); endLines.push(`removed the compiled watcher (${watcherBin})`); } catch (e) { endLines.push(`could not remove ${watcherBin}: ${(e as Error).message}`); }
}

// ------------------------------------------------------------------ analysis
const watchText = existsSync(watchFile) ? readFileSync(watchFile, "utf8") : "";
const { bad } = parseWatchLog(watchText);
const E = events.filter((e) => e.t <= measureEnd!);
const { operator, takes } = frontTakes(E, steps);
const spaces = spaceChanges(E, steps);
const wprob = O.dryRun ? [] : watcherProblems(E, bad, ready.t, measureEnd);
const v = verdict({ takes, spaces, watcher: wprob, missing: notRun, aborted, error: fatal, quit: quitProblem });
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
const tabDrive = steps.filter((s) => s.phase === "tab").map((s) => driveRow(s, "BG", ["F0"])).filter((x): x is DriveRow => !!x);
const nOf = (name: string) => { const w = wins[name]; if (!w) return undefined; const s = steps.find((x) => x.name.startsWith(`open window ${name}`)); return s ? (matchWindow(newAgentWindows(before(label(s)), after(label(s))), w.bounds) ?? newAgentWindows(before(label(s)), after(label(s)))[0])?.n : undefined; };
const nA = nOf("WA"), nB = nOf("WB");
const windowDrive = steps.filter((s) => s.phase === "window" && !s.name.startsWith("open window")).map((s) => {
  const tab = s.name.startsWith("WB") ? "WB" : "WA";
  const row = driveRow(s, tab, ["WA", "WB", "F0", "BG"].filter((x) => x !== tab));
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
  windowRow(S("tab", "open a background tab (agent-browser open)"), "Target.createTarget { background: true } (a tab)"),
  windowRow(steps.find((s) => s.name.startsWith("open window WA")), "Target.createTarget { newWindow: true, background: true }", nA),
  windowRow(steps.find((s) => s.name.startsWith("open window WB")), "Target.createTarget { newWindow: true, background: true }", nB),
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
  (() => { const l = focusLine("WA: keys with no click (WB has the focus)", "WA", "WB"); return l && `${l}; WA's field holds ${JSON.stringify(details.keys ?? null)}`; })(),
  focusLine("WB: click (WA had the focus again)", "WB", "WA"),
  focusLine("WA: click (WB had the focus)", "WA", "WB"),
  (() => { const l = focusLine("WA: person-shaped click and typing", "WA", "WB"); const s = steps.find((x) => x.name === "WA: person-shaped click and typing"); if (!l || !s) return l; const g = stepSignals(sorted, "WA", s.t0, s.t1); return `${l}; input: ${g.moves} moves (${g.movesWithMovement} with movement), press ${g.downUpMs} ms, pressure ${g.pressure}, screen - client ${JSON.stringify(g.screenMinusClient)}, ${g.keydowns} keydown, pointer jumps ${g.pointerJumps}; path from ${JSON.stringify(details.person ?? null)}`; })(),
].filter((x): x is string => !!x);
const popups: PopupRow[] = POPUPS.map((p) => {
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
const finalSnap = after("facts: the agent app's windows");
const agentAll = agentWindowsOf(finalSnap), app = finalSnap?.agentApp as { policy?: number; hidden?: boolean; active?: boolean } | undefined;
const windowIds = [...new Set(pages.map((p) => p.windowId).filter((x) => x !== undefined))];
const apis = O.dryRun ? ["(dry run: no macOS window list)"] : [
  `The agent Chrome has ${agentAll.length} window(s) of layer 0 (CGWindowList, every window of its pid): ${agentAll.filter((w) => w.onscreen).length} on the screen of the current Space, ${agentAll.filter((w) => !w.onscreen).length} off it. Mission Control shows the windows of the current Space; App Expose and the Dock menu of the agent Chrome's icon list its windows.`,
  `CDP: ${pages.length} page(s) in ${windowIds.length} window(s): ${pages.map((p) => `"${p.title}" (window ${p.windowId}, ${p.state ?? "?"})`).join(", ")}. The first window has the name of --window-name (agent-browser's launch sets it); the Dock menu shows that name or the page title.`,
  `The agent app: activation policy ${app?.policy === 0 ? "regular (a Dock icon and a Cmd-Tab entry of its own)" : app?.policy ?? "?"}, hidden ${app?.hidden}, active ${app?.active}.`,
  "Cmd-` cycles the windows of the app in front only. The agent Chrome is an app of its own (its own pid, Dock icon and Cmd-Tab entry: check 6 of docs/research/2026-11-03-chrome-vs-chrome-beta.md), so Cmd-` in the operator's app does not reach an agent window while the agent Chrome is not in front (from that check, not measured here).",
];
const pointer = { at: realPointer(E), real: realPointerEvents(sorted, realPointer(E), ["F0", "BG", "WA", "WB", "PA", "PB", "PC"], steps) };
const notMeasured = [
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
  windows: windowRows, tabDrive, windowDrive, records, focus, popups, pointer, apis, look: LOOK, notMeasured,
};
const text = summary(result);
writeFileSync(join(RUN, "summary.md"), text);
writeFileSync(join(RUN, "results.json"), `${JSON.stringify({ options: O, result, steps, notRun, details, popupInfo, pages, wins, watch: events, probe: log }, null, 1)}\n`);
process.stdout.write(`${text}\n(results: ${join(RUN, "results.json")})\n`);
process.exit(v.ok ? 0 : 1);
