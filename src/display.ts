// The agent Chrome's display (ab-v16.26; review-45 F7, review-47 item 9). The design of one window per agent page, the
// activation of its window for input and the X pointer's moves apply only where the agent Chrome runs on a display of
// its own: a person's windows, focus and pointer on their own screen are theirs. That is agentwatch's private Xvfb
// behind agent mode's endpoint (cdpUrl: agentwatch's agent unit starts one Xvfb for its one Chromium), and, for an
// agent Chrome that agent-browser started, a display whose every visible window is that Chrome's (its pid, through
// xdotool). Elsewhere agent-browser drives the page as before (background tabs, focus emulation), with a log line.

import { execFile } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { agentChromePid } from "./agent.ts";
import { statePath, type Settings, type XdotoolRunner } from "./options.ts";

/** xdotool on one display. */
export type XAccess = { run: XdotoolRunner; display: string };

/**
 * What agent-browser knows of the agent Chrome's display. `own`: a display of its own (above). `x`: xdotool on it.
 * `chromePid`: the agent Chrome's pid, when known. `why`: why the display is not its own, for the log line.
 */
export type DisplayInfo = { own: boolean; x?: XAccess; chromePid?: number; why?: string };

const DISPLAY_FILE = "display.json";
/** How long a display check of an agent Chrome that agent-browser started holds (each check costs ps and xdotool calls). */
const CHECK_MS = 60_000;

/** The DISPLAY and XAUTHORITY of a process, from its environment (/proc/<pid>/environ), or undefined. */
export function envOf(pid: number): Record<string, string> | undefined {
  try {
    const vars = Object.fromEntries(readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").filter(Boolean).map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)]));
    return vars.DISPLAY ? { DISPLAY: vars.DISPLAY, ...(vars.XAUTHORITY ? { XAUTHORITY: vars.XAUTHORITY } : {}) } : undefined;
  } catch { return undefined; }
}

/** xdotool with this DISPLAY (and XAUTHORITY), never through Wayland. */
export function xRunner(env: Record<string, string>): XAccess {
  const full = { ...process.env, ...env };
  delete full.WAYLAND_DISPLAY;
  const run: XdotoolRunner = (args) => new Promise((resolve, reject) => {
    execFile("xdotool", args, { env: full, timeout: 3000, encoding: "utf8" }, (e, out) => (e ? reject(e) : resolve(out)));
  });
  return { run, display: env.DISPLAY };
}

const windowIds = (out: string) => out.split("\n").map((l) => l.trim()).filter(Boolean);
/** The pid of an X window (its _NET_WM_PID), or "" when it has none. */
export const pidOf = async (x: XAccess, w: string) => (await x.run(["getwindowpid", w]).catch(() => "")).trim();

/** Every visible top-level window of the display but its root belongs to `pid`: the display holds the agent browser only. */
export async function onlyWindowsOf(x: XAccess, pid: string): Promise<boolean> {
  const root = windowIds(await x.run(["search", "--maxdepth", "0", "--name", ""]))[0];
  const visible = windowIds(await x.run(["search", "--onlyvisible", "--name", ""]).catch(() => "")).filter((w) => w !== root);
  for (const w of visible) if ((await pidOf(x, w)) !== pid) return false;
  return visible.length > 0;
}

type Kept = { chromePid: number; own: boolean; why?: string; display?: string; xauthority?: string; at: number; noticeAt?: number };

function readKept(s: Settings): Kept | undefined {
  try { return JSON.parse(readFileSync(statePath(s, DISPLAY_FILE), "utf8")) as Kept; } catch { return undefined; }
}
function writeKept(s: Settings, k: Kept) {
  const path = statePath(s, DISPLAY_FILE), tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(k), { mode: 0o600 });
  renameSync(tmp, path);
}

/** @internal The parts of displayOf that a test replaces: the agent Chrome's pid, a process's display, xdotool on a display, the clock. */
export type DisplayDeps = {
  pid?: (s: Settings) => number | undefined;
  env?: (pid: number) => Record<string, string> | undefined;
  runner?: (env: Record<string, string>) => XAccess;
  now?: () => number;
};

/**
 * The agent Chrome's display (DisplayInfo). A test gives it (Settings.display); there is no other way past the check,
 * also under a test runner (review-45b: a consumer's own tests against a real agent Chrome must not skip it). Behind
 * cdpUrl: own; xdotool with this process's DISPLAY, which an activation must verify (input.ts). An agent Chrome that
 * agent-browser started: its own environment's DISPLAY first, else this process's; own only when xdotool shows that
 * every visible window there is that Chrome's. That check holds for a minute for the same Chrome pid (display.json in
 * the state folder). A check that fails (no ps, a state folder that cannot be written) gives "not own". When the
 * display is not its own, `log` says why, at most once in 5 minutes.
 */
export async function displayOf(s: Settings, log = false, deps: DisplayDeps = {}): Promise<DisplayInfo> {
  const d = s.display;
  if (d && d.own !== undefined) {
    if (!d.own && log) s.log(`agent-browser: the agent Chrome is not on a display of its own (the test says so); ${NOT_OWN}`);
    return { own: d.own, x: d.xdotool ? { run: d.xdotool, display: "injected" } : undefined, chromePid: d.chromePid, ...(d.own ? {} : { why: "the test says so" }) };
  }
  const now = deps.now ?? Date.now;
  let info: DisplayInfo;
  try { info = await find(s, deps, now); }
  catch (e) { info = { own: false, why: `the check of the display failed (${(e as Error).message.split("\n")[0]})` }; }
  if (!info.own && log) {
    let k: Kept | undefined;
    try { k = readKept(s); } catch { k = undefined; }
    if (!k?.noticeAt || now() - k.noticeAt > 5 * 60_000) {
      s.log(`agent-browser: the agent Chrome is not on a display of its own (${info.why}); ${NOT_OWN}`);
      try { writeKept(s, { ...(k ?? { chromePid: info.chromePid ?? 0, own: false, at: 0 }), noticeAt: now() }); } catch { /* not writable: the line comes again */ }
    }
  }
  return info;
}

const NOT_OWN = "agent-browser opens each page as a background tab and drives it as before (focus emulation, or --hidden-drive), which a site can detect, and it brings no window forward and does not move the X pointer";

async function find(s: Settings, deps: DisplayDeps, now: () => number): Promise<DisplayInfo> {
  const d = s.display, run = deps.runner ?? xRunner;
  const fromEnv = process.env.DISPLAY ? { DISPLAY: process.env.DISPLAY, ...(process.env.XAUTHORITY ? { XAUTHORITY: process.env.XAUTHORITY } : {}) } : undefined;
  if (s.cdpUrl) return { own: true, x: d?.xdotool === false || !fromEnv ? undefined : run(fromEnv) };
  const chromePid = (deps.pid ?? agentChromePid)(s);
  if (!chromePid) return { own: false, why: "agent-browser finds no agent Chrome of its own on this profile (an endpoint that another program started)" };
  const kept = readKept(s);
  // The kept answer holds for the same agent Chrome only: a restart on another display within the minute checks again.
  if (kept && kept.chromePid === chromePid && now() - kept.at < CHECK_MS)
    return { own: kept.own, chromePid, why: kept.why,
      x: kept.own && kept.display && d?.xdotool !== false ? run({ DISPLAY: kept.display, ...(kept.xauthority ? { XAUTHORITY: kept.xauthority } : {}) }) : undefined };
  const env = (deps.env ?? envOf)(chromePid) ?? fromEnv;
  let info: DisplayInfo;
  if (!env) info = { own: false, chromePid, why: "agent-browser cannot see the agent Chrome's display (no DISPLAY)" };
  else {
    const x = run(env);
    const own = await onlyWindowsOf(x, String(chromePid)).catch(() => undefined);
    info = own === undefined ? { own: false, chromePid, why: `agent-browser cannot check the display ${env.DISPLAY} (no xdotool, or it cannot read the display)` }
      : own ? { own: true, chromePid, x: d?.xdotool === false ? undefined : x }
      : { own: false, chromePid, why: `another program's window is on the display ${env.DISPLAY}` };
  }
  try {
    writeKept(s, { chromePid, own: info.own, why: info.why, display: info.own ? env?.DISPLAY : undefined, xauthority: info.own ? env?.XAUTHORITY : undefined,
      at: now(), noticeAt: kept?.noticeAt });
  } catch { /* not writable: no kept answer, the check runs each time */ }
  return info;
}
