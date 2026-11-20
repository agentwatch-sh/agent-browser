// The agent Chrome's display (ab-v16.26; review-45 F7, review-47 item 9). The design of one window per agent page, the
// activation of its window for input and the X pointer's moves apply only where the agent Chrome runs on a display of
// its own: a person's windows, focus and pointer on their own screen are theirs. That is agentwatch's private Xvfb
// behind agent mode's endpoint (agentwatch's agent unit starts one Xvfb for its one Chromium; since board ab-v16.9.3
// the endpoint is the only way to the agent browser). An activation verifies it before the X pointer moves (input.ts,
// Hands.begin). A test can say that the display is not its own (Settings.display): agent-browser then drives the page
// as before (background tabs, focus emulation), with a log line.

import { execFile } from "node:child_process";
import { type Settings, type XdotoolRunner } from "./options.ts";

/** xdotool on one display. */
export type XAccess = { run: XdotoolRunner; display: string };

/**
 * What agent-browser knows of the agent Chrome's display. `own`: a display of its own (above). `x`: xdotool on it.
 * `chromePid`: the agent Chrome's pid, when known. `why`: why the display is not its own, for the log line.
 */
export type DisplayInfo = { own: boolean; x?: XAccess; chromePid?: number; why?: string };

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

/** @internal The part of displayOf that a test replaces: the xdotool runner of a display. */
export type DisplayDeps = { runner?: (env: Record<string, string>) => XAccess };

/**
 * The agent Chrome's display (DisplayInfo). A test gives it (Settings.display); there is no other way past the check,
 * also under a test runner (review-45b: a consumer's own tests against a real agent Chrome must not skip it). Behind
 * agent mode's endpoint the display is agentwatch's own Xvfb: own, with xdotool on this process's DISPLAY, which an
 * activation must verify (input.ts). With `log`, a display that is not its own gets the log line of noticeNotOwn.
 */
export async function displayOf(s: Settings, log = false, deps: DisplayDeps = {}): Promise<DisplayInfo> {
  const d = s.display;
  let info: DisplayInfo;
  if (d && d.own !== undefined) {
    info = { own: d.own, x: d.xdotool ? { run: d.xdotool, display: "injected" } : undefined, chromePid: d.chromePid, ...(d.own ? {} : { why: "the test says so" }) };
  } else {
    const fromEnv = displayVars(process.env);
    info = { own: true, x: d?.xdotool === false || !fromEnv ? undefined : (deps.runner ?? xRunner)(fromEnv) };
  }
  if (log) noticeNotOwn(s, info);
  return info;
}

/**
 * The log line of a display that is not the agent browser's own: why, and what agent-browser does instead. AgentBrowser
 * gives it at the first command that opens or attaches a page, not at a command that only lists (review-45c).
 */
export function noticeNotOwn(s: Settings, info: DisplayInfo): void {
  if (info.own) return;
  s.log(`agent-browser: the agent Chrome is not on a display of its own (${info.why}); ${NOT_OWN}`);
}

const NOT_OWN = "agent-browser opens each page as a background tab and drives it as before (focus emulation, or --hidden-drive), which a site can detect, and it brings no window forward and does not move the X pointer";
