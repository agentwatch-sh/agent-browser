// The agent Chrome's display (ab-v16.26; review-45 F7, review-47 item 9). The design of one window per agent page, the
// activation of its window for input and the X pointer's moves apply only where the agent Chrome runs on a display of
// its own: a person's windows, focus and pointer on their own screen are theirs. That is agentwatch's private Xvfb
// behind agent mode's endpoint (cdpUrl: agentwatch's agent unit starts one Xvfb for its one Chromium), and, for an
// agent Chrome that agent-browser started, a display whose every visible window is that Chrome's (its pid, through
// xdotool). Elsewhere agent-browser drives the page as before (background tabs, focus emulation), with a log line.

import { execFile } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { agentChromePid } from "./agent.ts";
import { statePath, underNodeTest, type Settings, type XdotoolRunner } from "./options.ts";

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

/**
 * The agent Chrome's display (DisplayInfo). A test gives it (Settings.display); under a test with none given, the fake
 * Chrome is on no display: own, with no xdotool. Behind cdpUrl: own; xdotool with this process's DISPLAY, which an
 * activation must verify (input.ts). An agent Chrome that agent-browser started: its own environment's DISPLAY first,
 * else this process's; own only when xdotool shows that every visible window there is that Chrome's. That check holds
 * for a minute (display.json in the state folder). When the display is not its own, `log` says why, at most once in 5
 * minutes for each agent Chrome.
 */
export async function displayOf(s: Settings, log = false): Promise<DisplayInfo> {
  const d = s.display;
  if (d && d.own !== undefined) {
    if (!d.own && log) s.log(`agent-browser: the agent Chrome is not on a display of its own (the test says so); ${NOT_OWN}`);
    return { own: d.own, x: d.xdotool ? { run: d.xdotool, display: "injected" } : undefined, chromePid: d.chromePid, ...(d.own ? {} : { why: "the test says so" }) };
  }
  if (underNodeTest()) return { own: true };
  const fromEnv = process.env.DISPLAY ? { DISPLAY: process.env.DISPLAY, ...(process.env.XAUTHORITY ? { XAUTHORITY: process.env.XAUTHORITY } : {}) } : undefined;
  if (s.cdpUrl) return { own: true, x: d?.xdotool === false || !fromEnv ? undefined : xRunner(fromEnv) };
  const kept = readKept(s);
  let info: DisplayInfo;
  if (kept && Date.now() - kept.at < CHECK_MS) {
    info = { own: kept.own, chromePid: kept.chromePid, why: kept.why,
      x: kept.own && kept.display && d?.xdotool !== false ? xRunner({ DISPLAY: kept.display, ...(kept.xauthority ? { XAUTHORITY: kept.xauthority } : {}) }) : undefined };
  } else {
    const c = await check(s, fromEnv);
    info = { ...c.info, x: c.info.x && d?.xdotool !== false ? c.info.x : undefined };
    writeKept(s, { chromePid: info.chromePid ?? 0, own: info.own, why: info.why, display: c.env?.DISPLAY, xauthority: c.env?.XAUTHORITY, at: Date.now(), noticeAt: kept?.noticeAt });
  }
  if (!info.own && log) {
    const k = readKept(s);
    if (!k?.noticeAt || Date.now() - k.noticeAt > 5 * 60_000) {
      s.log(`agent-browser: the agent Chrome is not on a display of its own (${info.why}); ${NOT_OWN}`);
      if (k) writeKept(s, { ...k, noticeAt: Date.now() });
    }
  }
  return info;
}

const NOT_OWN = "agent-browser opens each page as a background tab and drives it as before (focus emulation, or --hidden-drive), which a site can detect, and it brings no window forward and does not move the X pointer";

/** The check of an agent Chrome that agent-browser started, and the display's environment when it is its own. */
async function check(s: Settings, fromEnv: Record<string, string> | undefined): Promise<{ info: DisplayInfo; env?: Record<string, string> }> {
  const chromePid = agentChromePid(s);
  if (!chromePid) return { info: { own: false, why: "agent-browser finds no agent Chrome of its own on this profile (an endpoint that another program started)" } };
  const env = envOf(chromePid) ?? fromEnv;
  if (!env) return { info: { own: false, chromePid, why: "agent-browser cannot see the agent Chrome's display (no DISPLAY)" } };
  const x = xRunner(env);
  const own = await onlyWindowsOf(x, String(chromePid)).catch(() => undefined);
  if (own === undefined) return { info: { own: false, chromePid, why: `agent-browser cannot check the display ${env.DISPLAY} (no xdotool, or it cannot read the display)` } };
  if (!own) return { info: { own: false, chromePid, why: `another program's window is on the display ${env.DISPLAY}` } };
  return { info: { own: true, chromePid, x }, env };
}
