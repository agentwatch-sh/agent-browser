// The agent Chrome's display (ab-v16.26; review-45 F7, review-47 item 9). The design of one window per agent page, the
// activation of its window for input and the X pointer's moves apply only where the agent Chrome runs on a display of
// its own: a person's windows, focus and pointer on their own screen are theirs. That is agentwatch's private Xvfb
// behind agent mode's endpoint (cdpUrl: agentwatch's agent unit starts one Xvfb for its one Chromium), and, for an
// agent Chrome that agent-browser started, a display whose every visible window is that Chrome's (its pid, through
// xdotool), with no window manager or XWAYLAND extension on it and no WAYLAND_DISPLAY in the chosen environment.
// Elsewhere agent-browser drives the page as before (background tabs, focus emulation), with a log line.

import { execFile } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { agentChromePid, isAgentChromeCommand } from "./agent.ts";
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

/**
 * The DISPLAY, XAUTHORITY and WAYLAND_DISPLAY of a process, from its environment (/proc/<pid>/environ); undefined when
 * it has no DISPLAY or cannot be read. Chromium 156 clears its main process environment, so this normally returns
 * undefined and displayOf uses agent-browser's environment instead.
 */
export function envOf(pid: number): Record<string, string> | undefined {
  try {
    const vars = Object.fromEntries(readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").filter(Boolean).map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)]));
    return displayVars(vars);
  } catch { return undefined; }
}

function displayVars(vars: Record<string, string | undefined>): Record<string, string> | undefined {
  if (!vars.DISPLAY) return undefined;
  return { DISPLAY: vars.DISPLAY, ...(vars.XAUTHORITY ? { XAUTHORITY: vars.XAUTHORITY } : {}), ...(vars.WAYLAND_DISPLAY ? { WAYLAND_DISPLAY: vars.WAYLAND_DISPLAY } : {}) };
}

/** A program of the X display (xdotool, xprop) with this DISPLAY (and XAUTHORITY), never through Wayland. */
function xProgram(name: string, env: Record<string, string>): XdotoolRunner {
  const full: NodeJS.ProcessEnv = { ...process.env, ...env };
  delete full.WAYLAND_DISPLAY;
  return (args) => new Promise((resolve, reject) => {
    execFile(name, args, { env: full, timeout: 3000, encoding: "utf8" }, (e, out) => (e ? reject(e) : resolve(out)));
  });
}

/** xdotool with this DISPLAY (and XAUTHORITY), never through Wayland. */
export function xRunner(env: Record<string, string>): XAccess {
  return { run: xProgram("xdotool", env), display: env.DISPLAY };
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

/**
 * A window manager runs on the display: its root window has _NET_SUPPORTING_WM_CHECK (xprop's answer). Many desktops
 * set it, including some Wayland compositors; its absence does not rule out XWayland. A private Xvfb has none.
 * xprop's three answers, read on an Xvfb of taylor (ab-v16.42): "_NET_SUPPORTING_WM_CHECK(WINDOW): window id # 0x21f" (set), "...:  not found." (not
 * set) and "...:  no such atom on any window." (no client named it yet). An xprop that fails, or another answer, throws.
 */
export async function hasWindowManager(xprop: XdotoolRunner): Promise<boolean> {
  const out = await xprop(["-root", "_NET_SUPPORTING_WM_CHECK"]);
  if (/_NET_SUPPORTING_WM_CHECK\(WINDOW\): window id/.test(out)) return true;
  if (/_NET_SUPPORTING_WM_CHECK:\s+(not found|no such atom on any window)/.test(out)) return false;
  throw new Error(`xprop gave no answer: ${out.trim().split("\n")[0]}`);
}

/**
 * XWayland advertises the XWAYLAND extension. Read xdpyinfo's complete extension list; an unreadable or incomplete
 * answer throws. Older XWayland servers without this extension still need the environment or window-manager check.
 * Protocol: https://sources.debian.org/src/xorgproto/2024.1-1/xwaylandproto.txt/
 */
async function hasXwayland(xdpyinfo: XdotoolRunner): Promise<boolean> {
  const out = await xdpyinfo([]);
  const list = /number of extensions:\s*(\d+)\r?\n([\s\S]*?)default screen number:/.exec(out);
  if (!list) throw new Error("xdpyinfo gave no extension list");
  const names = list[2].split("\n").map((line) => line.trim()).filter(Boolean);
  if (names.length !== Number(list[1])) throw new Error("xdpyinfo gave no complete extension list");
  return names.includes("XWAYLAND");
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

/** The command line of a process (/proc/<pid>/cmdline, its arguments joined by spaces), or undefined. */
function cmdlineOf(pid: number): string | undefined {
  try { return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ") || undefined; } catch { return undefined; }
}

/**
 * @internal The parts of displayOf that a test replaces: the agent Chrome's pid (ps), a process's command line and
 * display, xdotool, xprop and xdpyinfo on a display, the clock.
 */
export type DisplayDeps = {
  pid?: (s: Settings) => number | undefined;
  cmdline?: (pid: number) => string | undefined;
  env?: (pid: number) => Record<string, string> | undefined;
  runner?: (env: Record<string, string>) => XAccess;
  xprop?: (env: Record<string, string>) => XdotoolRunner;
  xdpyinfo?: (env: Record<string, string>) => XdotoolRunner;
  now?: () => number;
};

/**
 * The agent Chrome's display (DisplayInfo). A test gives it (Settings.display); there is no other way past the check,
 * also under a test runner (review-45b: a consumer's own tests against a real agent Chrome must not skip it). Behind
 * cdpUrl: own; xdotool with this process's DISPLAY, which an activation must verify (input.ts). An agent Chrome that
 * agent-browser started: try /proc/<pid>/environ first, else use this process's DISPLAY, XAUTHORITY and WAYLAND_DISPLAY.
 * Chromium 156 clears its main process environment, so that fallback is the normal path. Own only when xdotool shows
 * that every visible window there is that Chrome's, the chosen environment has no WAYLAND_DISPLAY, the display's root
 * window has no _NET_SUPPORTING_WM_CHECK, and xdpyinfo lists no XWAYLAND extension (a Wayland compositor's X server).
 * Older XWayland without that extension can pass if both the environment and window-manager checks miss it.
 * That check holds for a minute for the same Chrome pid (display.json in the state folder); while it holds,
 * /proc/<pid>/cmdline of the kept pid says whether it is still this profile's agent Chrome, so no ps runs (review-45c:
 * 35 to 39 ms on taylor). A check that fails (no ps, no xdotool, no xprop, no xdpyinfo) gives "not own". A state folder
 * that cannot be written keeps no answer, and the check runs each time. With `log`, a display that is not its own gets the log line
 * of noticeNotOwn.
 */
export async function displayOf(s: Settings, log = false, deps: DisplayDeps = {}): Promise<DisplayInfo> {
  const d = s.display;
  let info: DisplayInfo;
  if (d && d.own !== undefined) {
    info = { own: d.own, x: d.xdotool ? { run: d.xdotool, display: "injected" } : undefined, chromePid: d.chromePid, ...(d.own ? {} : { why: "the test says so" }) };
  } else {
    try { info = await find(s, deps, deps.now ?? Date.now); }
    catch (e) { info = { own: false, why: `the check of the display failed (${(e as Error).message.split("\n")[0]})` }; }
  }
  if (log) noticeNotOwn(s, info, deps.now);
  return info;
}

/**
 * The log line of a display that is not the agent browser's own: why, and what agent-browser does instead. At most once
 * in 5 minutes for a state folder (display.json), and each time for a test's own answer. AgentBrowser gives it at the
 * first command that opens or attaches a page, not at a command that only lists (review-45c).
 */
export function noticeNotOwn(s: Settings, info: DisplayInfo, now: () => number = Date.now): void {
  if (info.own) return;
  if (s.display?.own !== undefined) { s.log(`agent-browser: the agent Chrome is not on a display of its own (${info.why}); ${NOT_OWN}`); return; }
  let k: Kept | undefined;
  try { k = readKept(s); } catch { k = undefined; }
  if (k?.noticeAt && now() - k.noticeAt <= 5 * 60_000) return;
  s.log(`agent-browser: the agent Chrome is not on a display of its own (${info.why}); ${NOT_OWN}`);
  try { writeKept(s, { ...(k ?? { chromePid: info.chromePid ?? 0, own: false, at: 0 }), noticeAt: now() }); } catch { /* not writable: the line comes again */ }
}

const NOT_OWN = "agent-browser opens each page as a background tab and drives it as before (focus emulation, or --hidden-drive), which a site can detect, and it brings no window forward and does not move the X pointer";

async function find(s: Settings, deps: DisplayDeps, now: () => number): Promise<DisplayInfo> {
  const d = s.display, run = deps.runner ?? xRunner;
  const fromEnv = displayVars(process.env);
  if (s.cdpUrl) return { own: true, x: d?.xdotool === false || !fromEnv ? undefined : run(fromEnv) };
  const kept = readKept(s);
  const fresh = kept !== undefined && kept.chromePid > 0 && now() - kept.at < CHECK_MS;
  // The kept pid first: when its command line is still this profile's agent Chrome, ps need not run (review-45c).
  const keptLive = fresh && isAgentChromeCommand((deps.cmdline ?? cmdlineOf)(kept.chromePid) ?? "", s.profileDir);
  const chromePid = keptLive ? kept.chromePid : (deps.pid ?? agentChromePid)(s);
  if (!chromePid) return { own: false, why: "agent-browser finds no agent Chrome of its own on this profile (an endpoint that another program started)" };
  // The kept answer holds for the same agent Chrome only: a restart on another display within the minute checks again.
  if (fresh && kept.chromePid === chromePid)
    return { own: kept.own, chromePid, why: kept.why,
      x: kept.own && kept.display && d?.xdotool !== false ? run({ DISPLAY: kept.display, ...(kept.xauthority ? { XAUTHORITY: kept.xauthority } : {}) }) : undefined };
  // Chromium clears /proc/<pid>/environ: normally these are agent-browser's display variables.
  const env = (deps.env ?? envOf)(chromePid) ?? fromEnv;
  let info: DisplayInfo;
  if (!env) info = { own: false, chromePid, why: "agent-browser cannot see the agent Chrome's display (no DISPLAY)" };
  else if (env.WAYLAND_DISPLAY) info = { own: false, chromePid, why: `the chosen display environment has WAYLAND_DISPLAY=${env.WAYLAND_DISPLAY}: treat its X display ${env.DISPLAY} as a person's screen` };
  else {
    const x = run(env);
    const only = await onlyWindowsOf(x, String(chromePid)).catch(() => undefined);
    const wm = only ? await hasWindowManager((deps.xprop ?? ((e) => xProgram("xprop", e)))(env)).catch(() => undefined) : false;
    const wayland = only && wm === false ? await hasXwayland((deps.xdpyinfo ?? ((e) => xProgram("xdpyinfo", e)))(env)).catch(() => undefined) : false;
    info = only === undefined ? { own: false, chromePid, why: `agent-browser cannot check the display ${env.DISPLAY} (no xdotool, or it cannot read the display)` }
      : !only ? { own: false, chromePid, why: `another program's window is on the display ${env.DISPLAY}` }
      : wm === undefined ? { own: false, chromePid, why: `agent-browser cannot check for a window manager on the display ${env.DISPLAY} (no xprop, or it cannot read the display)` }
      : wm ? { own: false, chromePid, why: `a window manager runs on the display ${env.DISPLAY} (_NET_SUPPORTING_WM_CHECK): a person's desktop` }
      : wayland === undefined ? { own: false, chromePid, why: `agent-browser cannot check for XWAYLAND on the display ${env.DISPLAY} (no xdpyinfo, or it cannot read the display)` }
      : wayland ? { own: false, chromePid, why: `the display ${env.DISPLAY} advertises XWAYLAND: a person's screen` }
      : { own: true, chromePid, x: d?.xdotool === false ? undefined : x };
  }
  try {
    writeKept(s, { chromePid, own: info.own, why: info.why, display: info.own ? env?.DISPLAY : undefined, xauthority: info.own ? env?.XAUTHORITY : undefined,
      at: now(), noticeAt: kept?.noticeAt });
  } catch { /* not writable: no kept answer, the check runs each time */ }
  return info;
}
