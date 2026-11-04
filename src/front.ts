// `front` (#3): bring this consumer's agent Chrome to the front, so that the person who must answer its
// "Allow remote debugging?" prompt finds the window. It takes the operator's focus, so only a person
// runs it (README, Hard rules): no other command calls it. It never connects to a Chrome (a new
// debugging connection would raise the prompt again) and never signals a process.
//
// macOS: the agent Chrome is the one on this consumer's profile in the process table (listAgentChromes,
// as `chromes` lists it), and front asks macOS to activate that one instance by its pid, through AppKit's
// NSRunningApplication in osascript's JavaScript (JXA). The agent browser can be a second instance of
// the operator's own Google Chrome.app, with the same bundle id, so `open -a` or a bundle id cannot pick
// it; a pid can. The script addresses no app by name and sends no Apple Event, and the activation is not
// an Accessibility API, so it needs no Automation or Accessibility permission (approver.ts's System
// Events way needs Accessibility). macOS 14 and later can refuse an activation that the app in front
// did not hand over (cooperative activation), so front reads the front app afterwards (lsappinfo), asks
// once more with that app as the one that hands over, and fails when the agent Chrome is still not in
// front. Linux and other systems: refused before anything runs (the agent browser on a Linux server
// runs on a display of its own, a private Xvfb that no person watches).

import { execFile } from "node:child_process";
import { listAgentChromes, parseUserPs, readUserPs, type AgentChrome, type StatLike } from "./chromes.ts";
import { UsageError } from "./errors.ts";
import type { Settings } from "./options.ts";

export const OSASCRIPT = "/usr/bin/osascript";
export const LSAPPINFO = "/usr/bin/lsappinfo";

/**
 * The two requests: "activate" is -[NSRunningApplication activateWithOptions:] (macOS 10.6 and later),
 * "activate-from" is -[NSRunningApplication activateFromApplication:options:] (macOS 14 and later) with
 * the app in front as the one that hands over.
 */
export type FrontHow = "activate" | "activate-from";

/**
 * The JXA run handler: argv is [how, pid, binary]. It prints one JSON line: `found` (an app has that
 * pid), `path` (its executable), `before` (the front app's pid, 0 when there is none), `sent` (AppKit's
 * answer: the request was sent, not that macOS granted it) and `macos` (the major version, 0 when
 * unknown). It activates nothing unless the pid's executable is exactly the agent Chrome's binary that
 * ps showed, so a pid that the system gave to another app since is never activated. Options: 1 is
 * NSApplicationActivateAllWindows (every window of the agent Chrome, so also the one with the prompt),
 * 2 is NSApplicationActivateIgnoringOtherApps (without it macOS before 14 activates nothing while another
 * app is active; macOS 14 and later ignore it).
 */
export const FRONT_JXA = `ObjC.import("AppKit");
function run(argv) {
  var how = argv[0], pid = Number(argv[1]), bin = argv[2];
  var version = /Version (\\d+)/.exec($.NSProcessInfo.processInfo.operatingSystemVersionString.js), macos = version ? Number(version[1]) : 0;
  var app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
  if (!app || app.isNil()) return JSON.stringify({ found: false, macos: macos });
  var url = app.executableURL, path = !url || url.isNil() ? null : url.path.js;
  if (path !== bin) return JSON.stringify({ found: true, path: path, sent: false, macos: macos });
  var front = $.NSWorkspace.sharedWorkspace.frontmostApplication, hasFront = !!front && !front.isNil();
  var sent = false;
  if (how === "activate") sent = app.activateWithOptions(3);
  else if (how === "activate-from" && macos >= 14 && hasFront) sent = app.activateFromApplicationOptions(front, 1);
  return JSON.stringify({ found: true, path: path, before: hasFront ? front.processIdentifier : 0, sent: sent, macos: macos });
}`;

/** The osascript command line of one request: the script, then its run handler's arguments. */
export function osascriptFront(how: FrontHow, pid: number, bin: string): string[] {
  return [OSASCRIPT, "-l", "JavaScript", "-e", FRONT_JXA, how, String(pid), bin];
}

export type FrontRun = (argv: string[], timeoutMs: number) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

const execRun: FrontRun = (argv, timeoutMs) => new Promise((resolve) => {
  execFile(argv[0], argv.slice(1), { timeout: timeoutMs, encoding: "utf8", maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
    resolve({ ok: !error, stdout: String(stdout), stderr: String(stderr || (error ? error.message : "")) });
  });
});

/** osascript loads AppKit first, which can take a few seconds on a cold start. */
const OSASCRIPT_TIMEOUT_MS = 15_000;
/** How often and how long front reads the front app after a request: 15 reads, 100 ms apart. */
const FRONT_READS = 15, FRONT_READ_MS = 100;

export type FrontDeps = {
  platform?: NodeJS.Platform;
  ps?: () => string;
  uid?: number;
  stat?: StatLike;
  run?: FrontRun;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * The agent Chrome on this consumer's profile, and its binary as ps shows it. Refused when no
 * agent-browser Chrome of this user runs on that profile: a Chrome on it that agent-browser did not
 * start, a process that only names the profile, and another consumer's agent Chrome are never chosen.
 */
export function agentChromeFor(s: Settings, deps: Pick<FrontDeps, "ps" | "uid" | "stat"> = {}): { chrome: AgentChrome; bin: string } {
  const ps = (deps.ps ?? readUserPs)(), uid = deps.uid ?? process.getuid!();
  const chrome = listAgentChromes({ ps: () => ps, uid, stat: deps.stat }).find((c) => c.profileDir === s.profileDir);
  const row = chrome && parseUserPs(ps).find((r) => r.uid === uid && r.pid === chrome.pid);
  if (!chrome || !row) {
    throw new Error(`no agent-browser Chrome of this user runs on profile ${s.profileDir}: front brings only an agent Chrome forward (\`agent-browser chromes\` lists the agent Chromes that run)`);
  }
  return { chrome, bin: row.command.split(" -")[0] };
}

type Reply = { found: boolean; path?: string | null; before?: number; sent?: boolean; macos?: number };

function reply(stdout: string, how: FrontHow, pid: number): Reply {
  let r: unknown;
  try { r = JSON.parse(stdout); } catch { r = undefined; }
  if (!r || typeof r !== "object" || typeof (r as Reply).found !== "boolean")
    throw new Error(`osascript gave no reply that front can read (${how}, pid ${pid}): ${stdout.trim().slice(0, 300)}`);
  return r as Reply;
}

/** The front app's pid from lsappinfo, or undefined. */
async function frontPid(run: FrontRun): Promise<number | undefined> {
  const front = await run([LSAPPINFO, "front"], 5_000), asn = front.stdout.trim();
  if (!front.ok || !asn.startsWith("ASN:")) return undefined;
  const info = await run([LSAPPINFO, "info", "-only", "pid", asn], 5_000);
  const m = /"?pid"?\s*=\s*(\d+)/.exec(info.stdout);
  return info.ok && m ? Number(m[1]) : undefined;
}

/**
 * Bring the agent Chrome of `s` to the front (macOS only). Resolves with that Chrome and the request
 * that brought it there, once lsappinfo names it as the front app. Throws when nothing was brought
 * forward: the message names the pids, the requests and where to find the window by hand.
 */
export async function bringToFront(s: Settings, deps: FrontDeps = {}): Promise<{ chrome: AgentChrome; via: FrontHow }> {
  if (s.mode !== "agent") throw new UsageError("front is for the agent browser; it never brings the operator's own Chrome forward");
  const platform = deps.platform ?? process.platform;
  if (platform !== "darwin") {
    throw new UsageError(`front brings a window forward on macOS only, not on ${platform}: on a Linux server the agent browser runs on a display of its own (for example a private Xvfb), which no person watches`);
  }
  const { chrome, bin } = agentChromeFor(s, deps);
  const run = deps.run ?? execRun, sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const asked: string[] = [];
  let before: number | undefined, front: number | undefined;
  for (const how of ["activate", "activate-from"] as const) {
    const r = await run(osascriptFront(how, chrome.pid, bin), OSASCRIPT_TIMEOUT_MS);
    if (!r.ok) throw new Error(`osascript failed (${how}, pid ${chrome.pid}): ${r.stderr.trim().slice(0, 300)}`);
    const answer = reply(r.stdout, how, chrome.pid);
    if (!answer.found) throw new Error(`the agent Chrome (pid ${chrome.pid}) has quit; nothing was brought forward`);
    if (answer.path !== bin) throw new Error(`refusing: pid ${chrome.pid} is now ${answer.path ?? "an app with no executable"}, not the agent Chrome ${bin}; nothing was brought forward`);
    before ??= answer.before || undefined;
    asked.push(`${how} ${answer.sent ? "sent" : "not sent"}`);
    if (!answer.sent) continue;
    for (let i = 0; i < FRONT_READS; i++) {
      front = await frontPid(run);
      if (front === chrome.pid) return { chrome, via: how };
      await sleep(FRONT_READ_MS);
    }
  }
  const now = front === undefined ? "unknown" : front === before ? `pid ${front}, as before` : `pid ${front} (before the request: ${before === undefined ? "unknown" : `pid ${before}`})`;
  throw new Error(`macOS did not bring the agent browser to the front (pid ${chrome.pid}, profile ${chrome.profileDir}): ${asked.join(", ")}; the app in front is ${now}. `
    + "macOS 14 and later can refuse an activation that the app in front did not hand over. "
    + `Find the window in the Dock: Control-click the icon of the agent browser's Chrome and choose ${chrome.windowName === null ? "its window" : `the window ${JSON.stringify(chrome.windowName)}`}`);
}
