// `front` (#3): bring this consumer's agent Chrome to the front, so that the person who must answer its
// "Allow remote debugging?" prompt finds the window. It takes the operator's focus, so only a person
// runs it (README, Hard rules): no other command calls it. It never connects to a Chrome (a new
// debugging connection would raise the prompt again) and never signals a process.
//
// macOS: the agent Chrome is the Chrome main process that holds this consumer's profile (the pid in the
// profile's SingletonLock, which Chrome itself makes at its start; a lock older than that process is
// stale), when the process table lists it as an agent Chrome of this user (listAgentChromes, as
// `chromes` lists it) on that profile. front asks macOS to unhide and activate that one instance by its
// pid, through AppKit's NSRunningApplication in osascript's JavaScript (JXA). The agent browser can be
// a second instance of the operator's own Google Chrome.app, with the same bundle id, so `open -a` or a
// bundle id cannot pick it; a pid can. The script
// addresses no app by name and sends no Apple Event, and the activation is not an Accessibility API, so
// it needs no Automation or Accessibility permission (approver.ts's System Events way needs
// Accessibility). macOS 14 and later can refuse an activation from a process that is not the active app
// (cooperative activation), so front reads the front app afterwards (lsappinfo). On macOS 14 and later
// it then asks once more with activateFromApplication:options:, naming the app in front; that app did
// not yield its activation, so macOS probably refuses this request too (the Mac check measures it).
// front fails when the agent Chrome is still not in front, and it stops after FRONT_LIMIT_MS.
// Linux and other systems: refused before anything runs (the agent browser on a Linux server runs on a
// display of its own, a private Xvfb that no person watches).

import { execFile, execFileSync } from "node:child_process";
import { lstatSync, readlinkSync } from "node:fs";
import { release } from "node:os";
import { join } from "node:path";
import { hasUserDataDir } from "./agent.ts";
import { listAgentChromes, parseUserPs, readUserPs, type AgentChrome, type StatLike } from "./chromes.ts";
import { UsageError } from "./errors.ts";
import type { Settings } from "./options.ts";
import { holdGiveBack, releaseGiveBack } from "./watchback.ts";

export const OSASCRIPT = "/usr/bin/osascript";
export const LSAPPINFO = "/usr/bin/lsappinfo";
export const SW_VERS = "/usr/bin/sw_vers";

/** The whole of front, from the first request to the failure: under the Python adapter's default timeout (120 s). */
export const FRONT_LIMIT_MS = 60_000;
/** After front, how long the Mac's give-back watcher still takes a take of the front as the operator's (a late activation). */
export const FRONT_HOLD_TAIL_MS = 3000;
/** While front runs, how often it renews its hold (each time FRONT_HOLD_TAIL_MS ahead). */
export const FRONT_HOLD_RENEW_MS = 1000;

/**
 * The two requests: "activate" is -[NSRunningApplication activateWithOptions:] (macOS 10.6 and later);
 * "activate-from" is -[NSRunningApplication activateFromApplication:options:] (macOS 14 and later),
 * naming the app in front, which did not yield its activation (so macOS probably refuses it too).
 */
export type FrontHow = "activate" | "activate-from";

/**
 * The JXA run handler: argv is [how, pid, binary, start], where start is the pid's start time from ps
 * (seconds since 1970). It prints one JSON line: `found` (this login session has an app with that pid),
 * `path` (its executable), `launched` (its launch date from Launch Services, in seconds, or null: Apple
 * gives none for an app that did not start through Launch Services), `before` (the front app's pid, 0
 * when there is none) and `sent` (AppKit's answer: the request was sent, not that macOS granted it).
 * It changes nothing unless the pid's executable is the agent Chrome's binary that ps showed and, when
 * there is a launch date, that date is within 5 s of the start time: so a pid that another program
 * has now is refused, and so is a pid that a later Chrome has now. Then it unhides the app (activation
 * does not show a hidden app's windows) and sends the request. Options: 1 is
 * NSApplicationActivateAllWindows (every window of the agent Chrome, so also the one with the prompt),
 * 2 is NSApplicationActivateIgnoringOtherApps (without it macOS before 14 activates nothing while
 * another app is active; macOS 14 and later ignore it). Apple's JXA notes: a method with no arguments
 * runs when its property is read (`app.unhide`); the script calls it only when the bridge gives a
 * function instead.
 */
export const FRONT_JXA = `ObjC.import("AppKit");
function run(argv) {
  var how = argv[0], pid = Number(argv[1]), bin = argv[2], start = Number(argv[3]);
  var app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
  if (!app || app.isNil()) return JSON.stringify({ found: false });
  var url = app.executableURL, path = !url || url.isNil() ? null : url.path.js;
  var date = app.launchDate, launched = !date || date.isNil() ? null : date.timeIntervalSince1970;
  if (path !== bin || (launched !== null && !(Math.abs(launched - start) <= 5))) return JSON.stringify({ found: true, path: path, launched: launched, sent: false });
  var unhidden = app.unhide;
  if (typeof unhidden === "function") unhidden = app.unhide();
  var front = $.NSWorkspace.sharedWorkspace.frontmostApplication, hasFront = !!front && !front.isNil();
  var sent = false;
  if (how === "activate") sent = app.activateWithOptions(3);
  else if (how === "activate-from" && hasFront) sent = app.activateFromApplicationOptions(front, 1);
  return JSON.stringify({ found: true, path: path, launched: launched, before: hasFront ? front.processIdentifier : 0, sent: sent });
}`;

/** The osascript command line of one request: the script, then its run handler's arguments. */
export function osascriptFront(how: FrontHow, pid: number, bin: string, start: number): string[] {
  return [OSASCRIPT, "-l", "JavaScript", "-e", FRONT_JXA, how, String(pid), bin, String(start)];
}

/** The pid in the output of `lsappinfo info -only pid <ASN>` (macOS), `"pid"=48285`, or of a full `lsappinfo info`, `pid = 48285`. */
export function lsappinfoPid(out: string): number | undefined {
  const m = /(?<![A-Za-z])"?pid"?\s*=\s*(\d+)/.exec(out);
  return m ? Number(m[1]) : undefined;
}

/** One ASN, as `lsappinfo front` prints it, for example `ASN:0x0-0x14dd4dc:`: only that goes to `lsappinfo info`. */
export function isAsn(s: string): boolean {
  return /^ASN:0x[0-9a-f]+-0x[0-9a-f]+:$/i.test(s);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A start time as `LC_ALL=C ps -o lstart=` prints it (local time, for example `Wed Nov  4 18:07:12 2026`), in seconds since 1970. */
export function psStartTime(lstart: string): number | undefined {
  const m = /^[A-Z][a-z]{2} ([A-Z][a-z]{2}) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(lstart.trim());
  const month = m ? MONTHS.indexOf(m[1]) : -1;
  if (!m || month < 0) return undefined;
  return new Date(Number(m[6]), month, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])).getTime() / 1000;
}

/**
 * The profile's SingletonLock, which the Chrome that holds the profile makes at its start: a symlink
 * to "<host>-<pid>". Its pid, and when the link was made (seconds since 1970). Undefined when there is
 * none, or when this user does not own the link.
 */
export function singletonLock(profileDir: string, uid: number): { pid: number; made: number } | undefined {
  const lock = join(profileDir, "SingletonLock");
  try {
    const st = lstatSync(lock);
    if (st.uid !== uid || !st.isSymbolicLink()) return undefined;
    const m = /-(\d+)$/.exec(readlinkSync(lock));
    return m ? { pid: Number(m[1]), made: st.mtimeMs / 1000 } : undefined;
  } catch { return undefined; }
}

export type FrontRun = (argv: string[], timeoutMs: number) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

/** front's own runner of macOS's tools (osascript, lsappinfo, sw_vers): exported for a caller that counts the requests (the Mac check). */
export const execRun: FrontRun = (argv, timeoutMs) => new Promise((resolve) => {
  execFile(argv[0], argv.slice(1), { timeout: timeoutMs, encoding: "utf8", maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
    resolve({ ok: !error, stdout: String(stdout), stderr: String(stderr || (error ? error.message : "")) });
  });
});

const startOf = (pid: number): number | undefined => {
  try {
    return psStartTime(execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 5_000, env: { ...process.env, LC_ALL: "C" } }));
  } catch { return undefined; }
};

/** osascript loads AppKit first, which can take a few seconds on a cold start. */
const OSASCRIPT_TIMEOUT_MS = 15_000;
/** How often and how long front reads the front app after a request: 15 reads, 100 ms apart. */
const FRONT_READS = 15, FRONT_READ_MS = 100;

export type FrontDeps = {
  platform?: NodeJS.Platform;
  ps?: () => string;
  uid?: number;
  stat?: StatLike;
  /** The pid's start time in seconds since 1970 (`ps -o lstart=`), or undefined when ps has no such pid. */
  started?: (pid: number) => number | undefined;
  /** The Darwin release (os.release()): Darwin 23 is macOS 14. */
  release?: () => string;
  run?: FrontRun;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

/**
 * The agent Chrome on this consumer's profile, its binary as ps shows it, and when its SingletonLock
 * was made. It is the pid in the profile's SingletonLock, when the process table lists that pid as an
 * agent Chrome of this user (launched by agent-browser, or driven by an agent-browser proxy of this
 * user) on this profile, with `--user-data-dir=<profile>` in its row. Refused otherwise: a Chrome on the
 * profile that agent-browser did not start and that no agent-browser proxy of this user drives, a
 * process that only names the profile, another consumer's agent Chrome (also one whose profile ps reads
 * short at a " -": ps cannot tell "<profile> -b/x" from "<profile>" and a switch, the lock can), and
 * a lock that names no agent Chrome. bringToFront also refuses a lock older than its pid's process.
 */
export function agentChromeFor(s: Settings, deps: Pick<FrontDeps, "ps" | "uid" | "stat"> = {}): { chrome: AgentChrome; bin: string; lockMade: number } {
  const ps = (deps.ps ?? readUserPs)(), uid = deps.uid ?? process.getuid!();
  const lock = singletonLock(s.profileDir, uid);
  const chrome = lock && listAgentChromes({ ps: () => ps, uid, stat: deps.stat }).find((c) => c.pid === lock.pid && c.profileDir === s.profileDir);
  const row = chrome && parseUserPs(ps).find((r) => r.uid === uid && r.pid === chrome.pid && hasUserDataDir(r.command, s.profileDir));
  if (!lock || !chrome || !row) {
    throw new Error(`no agent-browser Chrome of this user holds profile ${s.profileDir}: front brings only an agent Chrome forward (\`agent-browser chromes\` lists the agent Chromes that run)`);
  }
  return { chrome, bin: row.command.split(" -")[0], lockMade: lock.made };
}

type Reply = { found: boolean; path?: string | null; launched?: number | null; before?: number; sent?: boolean };

function reply(stdout: string, how: FrontHow, pid: number): Reply {
  let r: unknown;
  try { r = JSON.parse(stdout); } catch { r = undefined; }
  if (!r || typeof r !== "object" || typeof (r as Reply).found !== "boolean")
    throw new Error(`osascript gave no reply that front can read (${how}, pid ${pid}): ${stdout.trim().slice(0, 300)}`);
  return r as Reply;
}

/**
 * Bring the agent Chrome of `s` to the front (macOS only). Resolves with that Chrome and the request
 * that brought it there, once lsappinfo names it as the front app. Throws when nothing was brought
 * forward: the message names the pids, the requests, the macOS version and where to find the window by
 * hand. It stops after FRONT_LIMIT_MS.
 */
export async function bringToFront(s: Settings, deps: FrontDeps = {}): Promise<{ chrome: AgentChrome; via: FrontHow }> {
  if (s.mode !== "agent") throw new UsageError("front is for the agent browser; it never brings the operator's own Chrome forward");
  const platform = deps.platform ?? process.platform;
  if (platform !== "darwin") {
    throw new UsageError(`front brings a window forward on macOS only, not on ${platform}: on a Linux server the agent browser runs on a display of its own (for example a private Xvfb), which no person watches`);
  }
  const { chrome, bin, lockMade } = agentChromeFor(s, deps);
  const start = (deps.started ?? startOf)(chrome.pid);
  if (start === undefined) throw new Error(`the agent Chrome (pid ${chrome.pid}) has quit; nothing was brought forward`);
  // ps gives whole seconds. A lock made before its pid's process started is stale: a Chrome that quit
  // left it, and another process has that pid now.
  if (lockMade < start - 2) {
    throw new Error(`refusing: the SingletonLock of profile ${s.profileDir} names pid ${chrome.pid}, but it is older than that process (a stale lock); nothing was brought forward`);
  }
  const run = deps.run ?? execRun, sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const clock = deps.now ?? Date.now, deadline = clock() + FRONT_LIMIT_MS;
  const darwin = Number((deps.release ?? release)().split(".")[0]);
  const asked: string[] = [];
  let before: number | undefined, front: number | undefined;
  /** One command within the time limit: its own timeout, at most what is left. */
  const step = async (argv: string[], timeoutMs: number) => {
    const left = deadline - clock();
    if (left <= 0) {
      throw new Error(`front stopped at its time limit of ${FRONT_LIMIT_MS / 1000} s (pid ${chrome.pid}${asked.length ? `; ${asked.join(", ")}` : ""}); the agent browser may not be in front`);
    }
    return run(argv, Math.min(timeoutMs, left));
  };
  const frontPid = async (): Promise<number | undefined> => {
    const r = await step([LSAPPINFO, "front"], 5_000), asn = r.stdout.trim();
    if (!r.ok || !isAsn(asn)) return undefined;
    const info = await step([LSAPPINFO, "info", "-only", "pid", asn], 5_000);
    return info.ok ? lsappinfoPid(info.stdout) : undefined;
  };
  // The Mac's give-back watcher (watchback.ts) leaves the agent Chrome in front when front brings it there: a hold of
  // FRONT_HOLD_TAIL_MS, renewed every second while front runs (so a kill -9 of this process leaves it at most that long:
  // review-69d note 7), then FRONT_HOLD_TAIL_MS for a late take (ab-v16.27: the watcher never fights the operator).
  // After a caller's stop the hold goes at once (review-69d B1): an activation that lands after the stop is then not
  // the operator's, and the watcher gives it back.
  holdGiveBack(s, "front", Date.now() + FRONT_HOLD_TAIL_MS);
  const renew = setInterval(() => holdGiveBack(s, "front", Date.now() + FRONT_HOLD_TAIL_MS), FRONT_HOLD_RENEW_MS);
  try {
    return await requests();
  } finally {
    clearInterval(renew);
    if (s.stopped?.()) releaseGiveBack(s, "front");
    else holdGiveBack(s, "front", Date.now() + FRONT_HOLD_TAIL_MS);
  }
  async function requests(): Promise<{ chrome: AgentChrome; via: FrontHow }> {
    for (const how of ["activate", "activate-from"] as const) {
      if (how === "activate-from" && !(darwin >= 23)) { asked.push("activate-from not sent (macOS before 14)"); continue; }
      // A caller's stop (the internal stopped option, the Mac check): no request after it (review-69c B1). The ps reads
      // above block node; a yield first lets the event loop deliver a stop that came meanwhile.
      if (s.stopped) await new Promise((r) => setImmediate(r));
      if (s.stopped?.()) throw new Error(`front stopped before its request (${how}): the caller stopped it; nothing was brought forward`);
      const r = await step(osascriptFront(how, chrome.pid, bin, start), OSASCRIPT_TIMEOUT_MS);
      if (!r.ok) throw new Error(`osascript failed (${how}, pid ${chrome.pid}): ${r.stderr.trim().slice(0, 300)}`);
      const answer = reply(r.stdout, how, chrome.pid);
      if (!answer.found) {
        throw new Error(`this login session has no app with pid ${chrome.pid}: the agent Chrome has quit, or it runs in another login session; nothing was brought forward`);
      }
      if (answer.path !== bin) {
        throw new Error(`refusing: pid ${chrome.pid} is now ${answer.path ?? "an app with no executable"}, not the agent Chrome ${bin}; nothing was brought forward`);
      }
      if (typeof answer.launched === "number" && !(Math.abs(answer.launched - start) <= 5)) {
        throw new Error(`refusing: pid ${chrome.pid} is now an app that started at ${new Date(answer.launched * 1000).toISOString()}, not the agent Chrome that started at ${new Date(start * 1000).toISOString()}; nothing was brought forward`);
      }
      before ??= answer.before || undefined;
      asked.push(`${how} ${answer.sent ? "sent" : "not sent"}`);
      if (!answer.sent) continue;
      for (let i = 0; i < FRONT_READS; i++) {
        front = await frontPid();
        if (front === chrome.pid) return { chrome, via: how };
        await sleep(FRONT_READ_MS);
      }
    }
    const version = await run([SW_VERS, "-productVersion"], 5_000); // outside the limit (5 s at most): the failure names the version
    const macos = version.ok && /^\d+(\.\d+)*$/.test(version.stdout.trim()) ? `macOS ${version.stdout.trim()}` : `macOS (Darwin ${darwin})`;
    const inFront = front === undefined ? "unknown" : front === before ? `pid ${front}, as before` : `pid ${front} (before the request: ${before === undefined ? "unknown" : `pid ${before}`})`;
    throw new Error(`${macos} did not bring the agent browser to the front (pid ${chrome.pid}, profile ${chrome.profileDir}): ${asked.join(", ")}; the app in front is ${inFront}. `
      + "macOS 14 and later can refuse an activation that the app in front did not yield. "
      + `Find the window in the Dock: Control-click the icon of the agent browser's Chrome and choose ${chrome.windowName === null ? "its window" : `the window ${JSON.stringify(chrome.windowName)}`}`);
  }
}
