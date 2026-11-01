// The agent browser: a separate Chrome instance on the consumer's own profile, so the operator's own
// Chrome (mail, banking, admin) is never reachable from the tooling. Each consumer has its own
// profile, so its own cookies and logins. The operator signs in to the allowlisted sites in it once;
// the logins persist in the profile.
//
// It is NEVER started with --remote-debugging-port: that flag makes navigator.webdriver true in
// every page, and Cloudflare, hCaptcha and Google then block even a human (verified on Chrome 154).
// Instead the operator turns remote debugging on in chrome://inspect/#remote-debugging, and
// approves Chrome's prompt once per proxy. assertSafeChromeArgs() enforces this for every launch.

import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// The Chrome switches a caller's flags (chromeArgs, extraArgs, urls) may never carry, by class:
// - remote debugging (every --remote-debugging-* switch) and automation mode (--enable-automation)
//   set navigator.webdriver, so bot checks then block every page;
// - --headless, in every form (--headless=new, --headless=old, ...), lets every page tell that the
//   browser is headless, so bot checks block it too;
// - --user-data-dir and --profile-directory: the caller's flags come AFTER agent-browser's own
//   --user-data-dir, so either one could point the agent Chrome at another profile, for example
//   the operator's own.
// Match the switch NAME as Chrome's own parser reads it (base/command_line.cc), not the raw arg:
// one argv element is one switch; Chrome first trims whitespace from the element, accepts "--" or a
// single "-" as the prefix ("/" too on Windows), ends the name at the first "=", and lowercases the
// name on Windows. So a raw /^--/ test is a parser differential that "-remote-debugging-port" or
// " --headless" would slip through. Normalize first (trim, strip leading dashes/slashes, cut at "=",
// lowercase), then match: a superset of what Chrome reads as that switch. Text after a space or an
// "=" inside one element is that switch's value, never a second switch, so it is not inspected.
// A denylist on these classes is deliberate: chromeArgs exists to pass arbitrary legitimate flags,
// so an allowlist would defeat it.
// The refusal names the switch by the text its pattern matched (lowercase letters, digits and "-"
// only), never the raw element: one element can hold the switch's value after a space or a "/"
// ("--headless /a/path"), and a value can be a path or a secret.
const REFUSED_SWITCHES: readonly { name: RegExp; why: string }[] = [
  {
    name: /^(?:remote-debugging-[a-z0-9-]*|enable-automation$)/,
    why: `it turns on remote debugging or automation mode, which sets navigator.webdriver and makes bot checks block every page; turn remote debugging on in ${INSPECT_URL} instead`,
  },
  {
    name: /^headless/,
    why: "it runs Chrome headless, which every page can tell (the user agent carries the HeadlessChrome token), and bot checks then block it; the agent browser always runs Chrome with a window (on a box with no screen, give it a virtual display)",
  },
  {
    name: /^(?:user-data-dir|profile-directory)$/,
    why: "it would point the agent Chrome at another profile, for example the operator's own; agent-browser sets the agent profile itself: choose it with the profileDir option (--profile)",
  },
];

/** The normalized switch name of one Chrome argv element (see above), or undefined if Chrome reads it as no switch. */
function chromeSwitchName(arg: string): string | undefined {
  const trimmed = arg.trim();
  if (!/^[-/]/.test(trimmed)) return undefined;
  return trimmed.replace(/^[-/]+/, "").split("=")[0].toLowerCase();
}

/**
 * Refuse, before any spawn, a Chrome argv that turns on remote debugging, automation mode or
 * headless mode, or that names a profile (--user-data-dir, --profile-directory), in any dash, slash
 * or case form, with or without a value. Throws a UsageError that says why and names the switch as
 * "--" plus its canonical (matched, lowercase) name: never the element's value.
 */
export function assertSafeChromeArgs(args: readonly string[]): void {
  for (const arg of args) {
    const name = chromeSwitchName(arg);
    if (name === undefined) continue;
    for (const r of REFUSED_SWITCHES) {
      const m = r.name.exec(name);
      if (m) throw new UsageError(`refusing to launch Chrome with --${m[0]}: ${r.why}`);
    }
  }
}

/** @deprecated The old name of assertSafeChromeArgs, which now refuses more than debugging flags. */
export const assertNoDebuggingFlag = assertSafeChromeArgs;

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

/**
 * Turn remote debugging on in the profile before Chrome starts, so the agent browser comes up ready
 * for an agent with no `chrome://inspect` click. This is a plain, unsigned setting in `Local State`
 * (`devtools.remote_debugging.user-enabled`), not the HMAC-signed "Secure Preferences" that holds
 * session restore, so writing it is safe and Chrome keeps it. It is agent-browser's own dedicated
 * profile, never the operator's. The per-connection approval prompt is Chrome's own gate and stays.
 * A corrupt existing file is left untouched (never clobber Chrome's own state). Returns whether the
 * setting is now on.
 */
export function seedRemoteDebugging(profileDir: string, file = join(profileDir, "Local State")): boolean {
  let state: Record<string, any>;
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      if (!parsed || typeof parsed !== "object") return false;
      state = parsed as Record<string, any>;
    } catch { return false; }
  } else {
    mkdirSync(profileDir, { recursive: true });
    state = {};
  }
  const devtools = state.devtools && typeof state.devtools === "object" ? state.devtools : (state.devtools = {});
  const rd = devtools.remote_debugging && typeof devtools.remote_debugging === "object" ? devtools.remote_debugging : (devtools.remote_debugging = {});
  if (rd["user-enabled"] === true) return true;
  rd["user-enabled"] = true;
  writeFileSync(file, JSON.stringify(state));
  return true;
}

export type SpawnLike = (bin: string, args: string[], opts: { detached: boolean; stdio: "ignore" }) => { pid?: number; exitCode: number | null; unref(): void };

/** The app bundle of a macOS Chrome binary (".../X.app/Contents/MacOS/X" -> ".../X.app"), or undefined. */
export function appBundle(bin: string): string | undefined {
  return /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(bin)?.[1];
}

/**
 * Start the agent Chrome (unless it is already running); resolves with its browser endpoint
 * once the operator has remote debugging turned on in it. It outlives this process by design.
 * With `background` on macOS it starts through `open -n -g`: a new instance that does not activate,
 * so the operator's frontmost app and Space stay as they are (a sign-in, `launch --login`, starts in
 * the foreground instead).
 */
export async function launchAgentChrome(
  s: Settings,
  opts: { urls?: string[]; extraArgs?: string[]; timeoutMs?: number; onWaiting?: () => void; background?: boolean } = {},
  deps: { endpoint?: () => Promise<string | undefined>; pid?: () => number | undefined; spawn?: SpawnLike; exists?: (p: string) => boolean; platform?: NodeJS.Platform } = {},
): Promise<string> {
  const extraArgs = [...(opts.extraArgs ?? []), ...(s.chromeArgs ?? [])];
  const urls = opts.urls?.length ? opts.urls : [INSPECT_URL];
  // One check, before any probe or spawn, of every element Chrome gets except agent-browser's own
  // --user-data-dir: AGENT_ARGS, opts.extraArgs, s.chromeArgs (the library option, a CLI
  // --chrome-args) and the urls (a library caller's urls could hold a switch too).
  assertSafeChromeArgs([...AGENT_ARGS, ...extraArgs, ...urls]);
  const endpoint = deps.endpoint ?? (() => agentEndpoint(s));
  const running = await endpoint();
  if (running) return running;
  const profile = agentProfileDir(s);
  const existingPid = (deps.pid ?? (() => agentChromePid(s)))();
  let child: ReturnType<SpawnLike> | undefined, viaOpen = false;
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
    seedRemoteDebugging(profile); // come up with remote debugging on; no chrome://inspect click needed
    const bin = agentChromeBin(s, deps.exists);
    if (bin === CHROME_STABLE_BIN && !s.chromeBin) {
      s.log(`agent browser: running from Google Chrome, so while it is open the Dock's Chrome icon brings it forward instead of your own profile; install Google Chrome Beta (brew install --cask google-chrome@beta) to keep them apart`);
    }
    // Exactly the elements checked above, plus the one profile switch agent-browser sets itself.
    const args = [...AGENT_ARGS, `--user-data-dir=${profile}`, ...extraArgs, ...urls];
    const bundle = opts.background && (deps.platform ?? process.platform) === "darwin" ? appBundle(bin) : undefined;
    const run = deps.spawn ?? (spawn as unknown as SpawnLike);
    viaOpen = !!bundle;
    child = bundle ? run("/usr/bin/open", ["-n", "-g", "-a", bundle, "--args", ...args], { detached: true, stdio: "ignore" })
      : run(bin, args, { detached: true, stdio: "ignore" });
    child.unref();
    // Who started each Chrome: a flood of launches is traceable to the command and folder behind it.
    try {
      appendFileSync(statePath(s, "launches.log"),
        `${new Date().toISOString()} chrome=${viaOpen ? "via-open-g" : child.pid ?? "?"} by=${process.pid} cwd=${process.cwd()} cmd=${process.argv.slice(1).join(" ")}\n`);
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
    // `open` exits at once with 0 when it has started Chrome; a direct child that exits handed off instead.
    if (child && child.exitCode !== null && !(viaOpen && child.exitCode === 0)) {
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
  return findAgentPid(ps(), s.profileDir);
}

/** The agent browser's main process on `profile`, found by its profile and role (see agentMainPid). */
export function findAgentPid(ps: string, profile: string): number | undefined {
  const rows = ps.split("\n").flatMap((line) => {
    const m = line.trim().match(/^(\d+) (.*)$/);
    return m ? [{ pid: Number(m[1]), command: m[2] }] : [];
  });
  return agentMainPid(rows, profile);
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

/** A Chrome child process (renderer, gpu, zygote, utility, broker) carries --type=; the main browser process does not. */
export function isBrowserChild(command: string): boolean {
  return ` ${command} `.includes(" --type=");
}

/**
 * The agent browser's main process on `profile` among `rows`: the process started with
 * --user-data-dir=<profile> that is not a --type= child. It is identified by its profile and its role,
 * NOT by the launch binary path, because on Debian/Ubuntu `chromium` and `google-chrome` are wrapper
 * scripts that exec a different real binary (e.g. /usr/lib/chromium/chromium), so the launch path never
 * appears in ps. --user-data-dir on our dedicated throwaway profile is conclusive: our own CLI and proxy
 * use --profile/--state-dir, never Chrome's --user-data-dir, so nothing else carries it.
 */
export function agentMainPid(rows: { pid: number; command: string }[], profile: string): number | undefined {
  for (const { pid, command } of rows) {
    if (hasUserDataDir(command, profile) && !isBrowserChild(command)) return pid;
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
