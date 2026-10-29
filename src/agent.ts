// The agent browser: a separate Chrome instance on the consumer's own profile, so the operator's own
// Chrome (mail, banking, admin) is never reachable from the tooling. Each consumer has its own
// profile, so its own cookies and logins. The operator signs in to the allowlisted sites in it once;
// the logins persist in the profile.
//
// It is NEVER started with --remote-debugging-port: that flag makes navigator.webdriver true in
// every page, and Cloudflare, hCaptcha and Google then block even a human (verified on Chrome 154).
// Instead the operator turns remote debugging on in chrome://inspect/#remote-debugging, and
// approves Chrome's prompt once per proxy. assertNoDebuggingFlag() enforces this for every launch.

import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { UsageError } from "./errors.ts";
import { isChromeForTesting, statePath, type Settings } from "./options.ts";

/**
 * Chrome Beta installs as its own app (com.google.Chrome.beta), so while the agent browser runs,
 * the Dock icon, Cmd-Tab and `open -a "Google Chrome"` still start the operator's own Chrome.
 * From the same Google Chrome.app, macOS would bring the agent browser forward instead. Stable is
 * the fallback when Beta isn't installed; the chromeBin option overrides both. The keychain item
 * that encrypts cookies is shared by Google's channels, so a profile moves between them signed in
 * (macOS asks once to let Beta use "Chrome Safe Storage").
 */
export const CHROME_BETA_BIN = "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta";
export const CHROME_STABLE_BIN = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export function agentChromeBin(s: Pick<Settings, "chromeBin">, exists: (p: string) => boolean = existsSync): string {
  const bin = s.chromeBin ?? (exists(CHROME_BETA_BIN) ? CHROME_BETA_BIN : CHROME_STABLE_BIN);
  if (isChromeForTesting(bin)) throw new UsageError("the agent browser never runs from Chrome for Testing");
  return bin;
}

/** The agent profile folder, created on first use. */
export function agentProfileDir(s: Settings): string {
  mkdirSync(s.profileDir, { recursive: true, mode: 0o700 });
  return s.profileDir;
}

const LSOF = ["/usr/sbin/lsof", "/usr/bin/lsof"];

/** The running agent Chrome's browser WebSocket URL, or undefined if it isn't running. */
export async function agentEndpoint(s: Settings, deps: {
  ownerPids?: (port: number) => number[];
  chromePid?: () => number | undefined;
} = {}): Promise<string | undefined> {
  let port: string, path: string;
  try {
    [port, path] = readFileSync(join(s.profileDir, "DevToolsActivePort"), "utf8").trim().split("\n");
  } catch { return undefined; }
  const portNumber = Number(port);
  if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535 || !path?.startsWith("/devtools/browser/")) return undefined;
  // A stale DevToolsActivePort can point at an unrelated listener. Match its owning pid to the
  // Chrome main process on this exact profile before returning any endpoint.
  let owners: number[], chromePid: number | undefined;
  try {
    chromePid = (deps.chromePid ?? (() => agentChromePid(s)))();
    owners = (deps.ownerPids ?? ((p) => {
      const lsof = LSOF.find((b) => existsSync(b)) ?? "lsof";
      return execFileSync(lsof, ["-nP", "-t", `-iTCP:${p}`, "-sTCP:LISTEN"], { encoding: "utf8" }).trim().split(/\s+/).map(Number);
    }))(portNumber);
  } catch { return undefined; }
  if (!chromePid || !owners.includes(chromePid)) return undefined;
  // Debugging turned on in chrome://inspect serves no /json endpoints, and opening a WebSocket
  // would raise Chrome's approval prompt, so check the port without a CDP handshake.
  const listening = await new Promise<boolean>((resolve) => {
    const sock = connect({ host: "127.0.0.1", port: portNumber });
    sock.setTimeout(1_000);
    sock.once("connect", () => { sock.destroy(); resolve(true); });
    sock.once("timeout", () => { sock.destroy(); resolve(false); });
    sock.once("error", () => resolve(false));
  });
  return listening ? `ws://127.0.0.1:${port}${path}` : undefined;
}

export const INSPECT_URL = "chrome://inspect/#remote-debugging";

export const AGENT_ARGS: readonly string[] = [
  "--no-first-run",
  "--no-default-browser-check",
  // The agent window usually sits behind the operator's windows; keep it rendering at full speed.
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--disable-background-timer-throttling",
];

/** Flags that open a debugging port or pipe. They set navigator.webdriver, so bot checks block every page. */
const DEBUGGING_FLAG = /^--remote-debugging-(port|pipe|address)(=|$)/;

export function assertNoDebuggingFlag(args: readonly string[]): void {
  const bad = args.find((a) => DEBUGGING_FLAG.test(a));
  if (bad) throw new UsageError(`refusing to launch Chrome with ${bad.split("=")[0]}: it sets navigator.webdriver and bot checks then block every page; turn remote debugging on in ${INSPECT_URL} instead`);
}

/**
 * Whether the profile restores the previous session on startup ("Continue where you left off"),
 * which makes Chrome keep session cookies across quits so site logins survive a restart. It is a
 * protected setting (signed in "Secure Preferences"): never write it from outside Chrome, since an
 * unsigned change can trigger Chrome's settings reset. The operator sets it once in
 * chrome://settings/onStartup; the launcher only checks and reminds.
 */
export function restoresOnStartup(profile: string): boolean | undefined {
  for (const f of ["Secure Preferences", "Preferences"]) {
    try {
      const v = JSON.parse(readFileSync(join(profile, "Default", f), "utf8"))?.session?.restore_on_startup;
      if (v !== undefined) return v === 1;
    } catch { /* missing or new profile */ }
  }
  return undefined;
}

export type SpawnLike = (bin: string, args: string[], opts: { detached: boolean; stdio: "ignore" }) => { pid?: number; exitCode: number | null; unref(): void };

/**
 * Start the agent Chrome (unless it is already running); resolves with its browser endpoint
 * once the operator has remote debugging turned on in it. It outlives this process by design.
 */
export async function launchAgentChrome(
  s: Settings,
  opts: { urls?: string[]; extraArgs?: string[]; timeoutMs?: number; onWaiting?: () => void } = {},
  deps: { endpoint?: () => Promise<string | undefined>; pid?: () => number | undefined; spawn?: SpawnLike; exists?: (p: string) => boolean } = {},
): Promise<string> {
  const extraArgs = opts.extraArgs ?? [];
  assertNoDebuggingFlag(extraArgs);
  const endpoint = deps.endpoint ?? (() => agentEndpoint(s));
  const running = await endpoint();
  if (running) return running;
  const profile = agentProfileDir(s);
  const existingPid = (deps.pid ?? (() => agentChromePid(s)))();
  let child: ReturnType<SpawnLike> | undefined;
  if (existingPid) {
    s.log(`agent browser already running (pid ${existingPid}; profile ${profile}); turn on remote debugging in ${INSPECT_URL}`);
  } else {
    // Automation sets noLaunch so a missing browser is an error, not a new Chrome plus a
    // remote-debugging approval the operator has to click.
    if (s.noLaunch) {
      throw new UsageError(`the agent browser is not running (profile ${profile}); start it once with \`${s.commandName} launch\` (it asks the operator for one remote-debugging approval), then re-run`);
    }
    if (restoresOnStartup(profile) === false) {
      s.log(`agent browser: logins that use session cookies are lost on quit; set "Continue where you left off" in chrome://settings/onStartup`);
    }
    rmSync(join(profile, "DevToolsActivePort"), { force: true });
    const bin = agentChromeBin(s, deps.exists);
    if (bin === CHROME_STABLE_BIN && !s.chromeBin) {
      s.log(`agent browser: running from Google Chrome, so while it is open the Dock's Chrome icon brings it forward instead of your own profile; install Google Chrome Beta (brew install --cask google-chrome@beta) to keep them apart`);
    }
    const args = [...AGENT_ARGS, `--user-data-dir=${profile}`, ...extraArgs, ...(opts.urls?.length ? opts.urls : [INSPECT_URL])];
    assertNoDebuggingFlag(args);
    child = (deps.spawn ?? (spawn as unknown as SpawnLike))(bin, args, { detached: true, stdio: "ignore" });
    child.unref();
    // Who started each Chrome: a flood of launches is traceable to the command and folder behind it.
    try {
      appendFileSync(statePath(s, "launches.log"),
        `${new Date().toISOString()} chrome=${child.pid ?? "?"} by=${process.pid} cwd=${process.cwd()} cmd=${process.argv.slice(1).join(" ")}\n`);
    } catch { /* logging never blocks a launch */ }
  }
  const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
  // The toggle persists in the profile, so debugging usually comes up by itself within seconds.
  const waitingAt = Date.now() + 5_000;
  let told = false;
  while (Date.now() < deadline) {
    const ws = await endpoint();
    if (ws) return ws;
    if (!told && Date.now() > waitingAt) { told = true; opts.onWaiting?.(); }
    if (child && child.exitCode !== null) {
      // Chrome hands the launch to an instance already running on this profile and exits.
      throw new Error(`the agent browser is open but remote debugging is off: turn it on in ${INSPECT_URL}
(Profile: ${profile})`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`agent Chrome is not reachable. In the agent browser, open ${INSPECT_URL},
turn remote debugging on, and approve Chrome's prompt when the tooling connects. Profile: ${profile}`);
}

/** pid of the agent browser's main Chrome process, if it is running. */
export function agentChromePid(s: Settings, ps: () => string = () => execFileSync("ps", ["axww", "-o", "pid=,command="], { encoding: "utf8", maxBuffer: 64 << 20 })): number | undefined {
  return findAgentPid(ps(), s.profileDir, agentBins(s));
}

/** The binaries an agent browser on this profile may run from: the configured one, Beta and stable. */
export function agentBins(s: Pick<Settings, "chromeBin">): string[] {
  return [...new Set([s.chromeBin ?? CHROME_BETA_BIN, CHROME_BETA_BIN, CHROME_STABLE_BIN])];
}

/**
 * The main process on `profile`, launched from one of `bins` (an agent browser started before Beta
 * was installed must still be found, e.g. by `quit`).
 */
export function findAgentPid(ps: string, profile: string, bins: string[]): number | undefined {
  const rows = ps.split("\n").flatMap((line) => {
    const m = line.trim().match(/^(\d+) (.*)$/);
    return m ? [{ pid: Number(m[1]), command: m[2] }] : [];
  });
  return agentMainPid(rows, profile, bins);
}

export type ProcessRow = { pid: number; ppid: number; command: string };

/** Rows of `ps ax -o pid=,ppid=,command=`. */
export function parsePs(ps: string): ProcessRow[] {
  return ps.split("\n").flatMap((line) => {
    const m = line.trim().match(/^(\d+) +(\d+) (.*)$/);
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] }] : [];
  });
}

/**
 * Was this `ps` command line started with `--user-data-dir=<dir>`? Folders can contain spaces
 * ("Application Support", a checkout under "My Projects"), so the whole flag is matched between
 * spaces, not word by word; a longer folder that starts with `dir` does not match.
 */
export function hasUserDataDir(command: string, dir: string): boolean {
  return ` ${command} `.includes(` --user-data-dir=${dir} `);
}

/** The agent browser's main process on `profile` among `rows` (see findAgentPid). */
export function agentMainPid(rows: { pid: number; command: string }[], profile: string, bins: string[]): number | undefined {
  for (const { pid, command } of rows) {
    if (bins.some((b) => command.startsWith(`${b} `)) && hasUserDataDir(command, profile)) return pid;
  }
  return undefined;
}

/**
 * A process and everything below it. Chrome starts its renderers, GPU process and audio service as
 * children of its main process, so this is one browser instance, and only that one: Chrome Beta's
 * helper apps carry the same bundle ids as stable Chrome's (com.google.Chrome.helper), so a bundle
 * id cannot tell the two apart, or two Betas on different profiles. Empty if `root` is not in `rows`.
 */
export function processTree(rows: ProcessRow[], root: number): number[] {
  if (!rows.some((r) => r.pid === root)) return [];
  const seen = new Set([root]);
  for (let grew = true; grew;) {
    grew = false;
    for (const r of rows) if (!seen.has(r.pid) && seen.has(r.ppid)) { seen.add(r.pid); grew = true; }
  }
  return [...seen].sort((a, b) => a - b);
}
