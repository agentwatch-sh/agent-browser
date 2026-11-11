// What each consumer passes. Every consumer has its own state folder, its own Chrome profile (so its
// own cookies and logins), its own proxy socket and its own allowlist. Nothing in this package names
// a consumer's path: a missing stateDir is an error, never a guess.

import { createHash } from "node:crypto";
import { mkdirSync, realpathSync, statSync, type Stats } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { UsageError } from "./errors.ts";

export type BrowserMode = "agent" | "personal";

/** status --notify: a callback (library), or a command as an argv list (CLI and library). */
export type NotifyHook = ((message: string) => unknown) | { command: string[] };

/**
 * Approve Chrome's per-connection "Allow remote debugging?" dialog for unattended use (approver.ts):
 * true/"auto" pick a built-in mechanism by platform (macOS osascript, Linux xdotool); "osascript" or
 * "xdotool" force one; { command } runs a custom argv. Undefined (default) means the operator clicks.
 */
export type ApproveSpec = boolean | "auto" | "osascript" | "xdotool" | { command: string[] };

export function validateApprove(spec: ApproveSpec): void {
  if (typeof spec === "boolean" || spec === "auto" || spec === "osascript" || spec === "xdotool") return;
  const cmd = (spec as { command?: unknown }).command;
  if (!Array.isArray(cmd) || !cmd.length || !cmd.every((a) => typeof a === "string") || !cmd[0])
    throw new UsageError('approve must be true, "osascript", "xdotool", or { command: [program, ...args] }');
}

/**
 * The shape of a person's input in a window of its own (ab-v16.26; docs/research/2026-11-05-anti-detect-drive.md,
 * section 5). Ranges are [min, max] in ms. The pointer's and the keys' draws come from the person of src/human/ (boards
 * ab-t30.3 and ab-t30.4; the input design, sections 10.1 and 10.2), bounded by these ranges: the defaults are the design's
 * bounds (keyMs: a range that does not bind the model), and a shorter range (a test's) keeps every draw inside it.
 */
export type InputTiming = {
  /** From a click's press to its release: a lognormal, median 100 ms, within this range (design 10.1: 60 to 180 ms). */
  pressMs: [number, number];
  /**
   * From one typed key's press to the next one's: the keyboard model's time (a person's, with the letter pair's part, the
   * pauses at word and line ends, the drift; the fast end after 12 s of a run) is kept inside this range.
   */
  keyMs: [number, number];
  /** How long each key stays down: a lognormal, mean 116 ms, SD 24 ms, within this range (design 10.2: 50 to 250 ms). */
  holdMs: [number, number];
  /** The pause on the target after the pointer arrives, before the press: a lognormal, median 140 ms, within this range (design 10.1: 80 to 400 ms). */
  settleMs: [number, number];
  /** From one wheel notch (120 px) to the next, when a command scrolls an element into view (design 8.2: 35 to 90 ms). */
  wheelMs: [number, number];
  /**
   * A factor on the time of each pointer path (Fitts's law: 300 to 1000 ms; one sample each 8 ms): 1 for a person's rate;
   * a smaller factor (a test's) keeps the samples and makes them faster, at most one each 2 ms.
   */
  moveScale: number;
  /** How long an input command waits for its page's focus after it brings the page's window forward. */
  activateMs: number;
  /**
   * On the Mac (ab-v16.27): how long an input command, `record` or a read waits for a hidden window page to show again,
   * with no activation. After a popup tab in front of its opener closes, the opener showed again about 1.0 s later (1006
   * to 1012 ms on the Mac, 2026-11-06).
   */
  showMs: number;
  /** How long an input command waits for another input command of the same agent browser (the input lock). */
  lockWaitMs: number;
};

/**
 * The defaults: a person's input (the input design's first values). A click costs about 0.5 to 1.5 s, a typed character
 * about 0.2 to 0.3 s for the first 12 s of a run and 0.1 to 0.12 s after them.
 */
export const INPUT_TIMING: Readonly<InputTiming> = Object.freeze({
  pressMs: [60, 180], keyMs: [20, 3000], holdMs: [50, 250], settleMs: [80, 400], wheelMs: [35, 90], moveScale: 1, activateMs: 1000, showMs: 2500, lockWaitMs: 600_000,
}) as Readonly<InputTiming>;

/** The input timing of a caller's partial option, checked: each range two numbers, 0 <= min <= max; the factor and the waits positive. */
export function resolveInputTiming(t: unknown): InputTiming {
  if (t === undefined) return { ...INPUT_TIMING, pressMs: [...INPUT_TIMING.pressMs], keyMs: [...INPUT_TIMING.keyMs], holdMs: [...INPUT_TIMING.holdMs],
    settleMs: [...INPUT_TIMING.settleMs], wheelMs: [...INPUT_TIMING.wheelMs] } as InputTiming;
  if (!t || typeof t !== "object" || Array.isArray(t)) throw new UsageError("inputTiming must be an object, for example { \"pressMs\": [70, 90] }");
  const out = resolveInputTiming(undefined) as Record<string, unknown>;
  for (const [k, v] of Object.entries(t as Record<string, unknown>)) {
    if (!(k in INPUT_TIMING)) throw new UsageError(`inputTiming: no field ${JSON.stringify(k)}; the fields are ${Object.keys(INPUT_TIMING).join(", ")}`);
    if (Array.isArray((INPUT_TIMING as Record<string, unknown>)[k])) {
      if (!Array.isArray(v) || v.length !== 2 || !v.every((x) => typeof x === "number" && Number.isFinite(x)) || v[0] < 0 || v[1] < v[0])
        throw new UsageError(`inputTiming.${k} must be [min, max] in ms, with 0 <= min <= max`);
      out[k] = [v[0], v[1]];
    } else {
      if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) throw new UsageError(`inputTiming.${k} must be a positive number`);
      out[k] = v;
    }
  }
  return out as InputTiming;
}

/** Run xdotool with these arguments on the agent browser's display and give its standard output (display.ts). */
export type XdotoolRunner = (args: string[]) => Promise<string>;

/**
 * @internal What agent-browser knows of the agent Chrome's display, for the tests (default: found; display.ts,
 * displayOf). `own`: the agent Chrome runs on a display of its own, where the design of one window per page applies.
 * `xdotool`: a runner of xdotool commands on that display, or false for none. `chromePid`: the agent Chrome's pid,
 * whose windows the display must hold.
 */
export type DisplayOption = { own?: boolean; xdotool?: XdotoolRunner | false; chromePid?: number };

export type BrowserOptions = {
  /** Absolute folder for this consumer's state: tab names and scopes, window pin, proxy pid and log, launch log, screenshots. */
  stateDir: string;
  /** The agent Chrome's profile: its cookies and logins. Default `<stateDir>/profile`. */
  profileDir?: string;
  /** The proxy's Unix socket (mode 0600). Default `<stateDir>/chrome-proxy.sock`. At most 103 bytes: for a long stateDir, give a short path in a folder that only this user can write. */
  socketPath?: string;
  /** JSON file `{ "allow": ["example.com", ...] }`. The package reads it and never writes it. */
  allowlistFile?: string;
  /** Library only: the allowlist as an array, in place of allowlistFile. */
  allow?: string[];
  /** "agent" (default): a separate Chrome on profileDir. "personal": the operator's own Chrome, only when the operator asks. */
  mode?: BrowserMode;
  /** The agent Chrome binary. Default: Google Chrome Beta when installed, else Google Chrome. Never Chrome for Testing. */
  chromeBin?: string;
  /** Extra flags for the agent Chrome at launch, e.g. ["--enable-unsafe-swiftshader", "--lang=en-US"]. Refused at launch: --remote-debugging-*, --enable-automation, --headless, --user-data-dir and --profile-directory. No secrets: Chrome flags show in `ps`. */
  chromeArgs?: string[];
  /** A known upstream endpoint (ws://127.0.0.1:<port>/devtools/browser/<id>). The connection still goes through the proxy. */
  endpoint?: string;
  /**
   * Agent mode's CDP endpoint (agentwatch's relay: ws+unix://<socket>:/devtools/browser/<scope>, from `agentwatch
   * browser endpoint`). Each connection goes to it in place of the proxy socket: no proxy starts, no Chrome is
   * launched, and launch and quit refuse, because that agent browser belongs to agentwatch. Agent mode only.
   */
  cdpUrl?: string;
  /** Personal mode: the operator's Chrome user-data folder, where Chrome writes DevToolsActivePort. */
  personalUserDataDir?: string;
  /** Never start Chrome: a missing agent browser is an error that names the launch command. */
  noLaunch?: boolean;
  /**
   * Never open a new debugging connection, so never a new "Allow remote debugging?" prompt: with no
   * approved proxy up, fail at once (code approval_needed) and start nothing. For unattended callers:
   * a prompt that nobody answers can leave Chrome refusing every later connection until it restarts.
   */
  noPrompt?: boolean;
  /** status --notify sends one message here. */
  notify?: NotifyHook;
  /** Approve Chrome's per-connection debugging dialog for unattended use. Default: the operator clicks. */
  approve?: ApproveSpec;
  /** The proxy exits after this long with no clients. Default 12 hours. */
  proxyIdleMs?: number;
  /** How hints name the command line, for example "vedlo browser". Default "agent-browser". */
  commandName?: string;
  /**
   * Work only in the tabs of this scope (for example the calling agent session's name), when several
   * callers share one agent browser: `open` records each new tab under the scope, a `<tab>` resolves
   * only among the scope's tabs, and `tabs` lists them with a count of the others. A command's
   * anyScope (--any-scope) reaches the other tabs. Advisory: it keeps callers apart, it is not a
   * security boundary. Default: no scope, every tab is visible. See TAB_SCOPE_RE for the name.
   */
  tabScope?: string;
  /**
   * Drive a background tab and keep its page hidden (ab-v16.15; README, **A command on a background tab:
   * two modes**). Default off: a command turns on focus emulation while it is attached, so a background tab's
   * page is visible (and draws) for the length of each command. On: no focus emulation; click, hover,
   * type, press, clickAt and shot keep Chrome drawing the hidden page with a hidden capture
   * (Tab.whileDrawn), and the page stays hidden. Between those commands, and during open, goto, text,
   * outline, eval and waitFor, a background page draws nothing. Measured on Linux only.
   */
  hiddenDrive?: boolean;
  /** Progress and warning lines. Default: standard error. */
  log?: (line: string) => void;
  /**
   * @internal The platform whose design applies (default process.platform), for the tests of each
   * platform's behaviour. On "linux" and "darwin" agent mode gives each page a window of its own (windowPerPage).
   */
  platform?: NodeJS.Platform;
  /**
   * The shape of a person's input in a window of its own (Linux; ab-v16.26), in parts: the fields that it
   * names replace the defaults (INPUT_TIMING). CLI --input-timing JSON, Python input_timing=.
   */
  inputTiming?: Partial<InputTiming>;
  /** @internal The agent Chrome's display, for the tests (DisplayOption). Default: found (display.ts, displayOf). */
  display?: DisplayOption;
  /**
   * @internal The argv that runs in place of /usr/bin/osascript for the Mac's give-back watcher (watchback.ts), for the
   * tests and the Mac check's dry run on Linux: a stand-in that gets the watcher's arguments. With it the watcher also
   * starts under node --test and off the Mac. Never set by the CLI's users.
   */
  watchBackCommand?: string[];
  /**
   * @internal A caller's stop (the Mac check, test/live/anti-detect/mac.ts, after a person's input and from its quit on;
   * review-69c B1): read before each input event of a person's input (browser.ts, byHand's guard), before each
   * activation request of `front` (front.ts), and before a start of the give-back watcher (watchback.ts). When it gives
   * true, the input command and `front` fail with a "stopped" error, and no watcher starts: a command that is in
   * progress then sends no more input. Never set by the CLI.
   */
  stopped?: () => boolean;
};

export type Settings = {
  stateDir: string;
  profileDir: string;
  socketPath: string;
  allowlistFile?: string;
  allow?: string[];
  mode: BrowserMode;
  chromeBin?: string;
  chromeArgs?: string[];
  endpoint?: string;
  cdpUrl?: string;
  personalUserDataDir?: string;
  noLaunch: boolean;
  noPrompt: boolean;
  notify?: NotifyHook;
  approve?: ApproveSpec;
  proxyIdleMs: number;
  commandName: string;
  tabScope?: string;
  hiddenDrive: boolean;
  log: (line: string) => void;
  platform: NodeJS.Platform;
  inputTiming: InputTiming;
  display?: DisplayOption;
  watchBackCommand?: string[];
  stopped?: () => boolean;
};

/**
 * Agent mode on Linux (ab-v16.26; docs/research/2026-11-05-anti-detect-drive.md) and on the Mac (ab-v16.27): each page
 * that agent-browser opens gets a window of its own and no focus emulation, as a person's page in a window that is not
 * in front. An explicit `open --tab` keeps the old modes for its tab (focus emulation while a command is attached, or
 * hiddenDrive). In personal mode every behaviour stays as it was. On Linux this is the first half of the gate: the
 * design applies only where the agent Chrome also runs on a display of its own (display.ts, displayOf;
 * AgentBrowser.windows), so that it never puts windows on a person's screen or takes their focus. On the Mac it
 * applies to an agent Chrome that agent-browser reaches itself (macWindows), never behind agent mode's endpoint (the
 * relay keeps its tabs there).
 */
export const windowPerPage = (s: Settings): boolean => s.mode === "agent" && (s.platform === "linux" || macWindows(s));

/**
 * The Mac's design (ab-v16.27; the Mac check of 2026-11-05 and 2026-11-06, README **One window per agent page on the
 * Mac**): agent mode, not behind agent mode's endpoint. Each page gets a window of its own with Target.createTarget
 * { newWindow: true, background: true }, which comes behind the front window on the current Space, and draws at 60
 * frames a second (--disable-backgrounding-occluded-windows). No command ever activates a window there (no
 * Page.bringToFront, no Target.activateTarget): a CDP click gives its page the focus with no activation, and the front
 * app stays the operator's. Input paths start at the page's last point, never at the real pointer, which never moves.
 * The give-back watcher (watchback.ts) gives the front back each time the agent Chrome takes it, for as long as that
 * Chrome runs, except when the operator brought it to the front.
 */
export const macWindows = (s: Settings): boolean => s.mode === "agent" && s.platform === "darwin" && !s.cdpUrl;

export const DEFAULT_PROXY_IDLE_MS = 12 * 60 * 60 * 1000;

/** macOS limits a Unix socket path to 104 bytes, including the final NUL. */
export const MAX_SOCKET_PATH_BYTES = 103;

/** The real path of `p`, which need not exist: the real path of its nearest folder that exists, then the rest of `p`. */
function realPathOf(p: string): string {
  const rest: string[] = [];
  for (let head = p; ; head = dirname(head)) {
    try { return join(realpathSync(head), ...rest); }
    catch { if (dirname(head) === head) return p; rest.unshift(basename(head)); }
  }
}

/**
 * An example --socket path for a refusal of a socket path that is too long:
 * `<dir>/ab-<first 8 hex of the sha256 of the state folder's real path>.sock`, so two spellings of one
 * folder (a symlink, or /tmp and /private/tmp on macOS) give one name. `<dir>` is the real path of the
 * first of `dirs` ($XDG_RUNTIME_DIR, then $TMPDIR) that is a folder of this user's with no group or
 * other write bit, when the path fits in MAX_SOCKET_PATH_BYTES: a symlink, which another user can own,
 * never appears in it, and the shared /tmp is never the example. Undefined when no folder passes.
 * Only a message names it: nothing is made.
 */
export function socketPathExample(stateDir: string, dirs: (string | undefined)[] = [process.env.XDG_RUNTIME_DIR, process.env.TMPDIR],
  uid = process.getuid?.()): string | undefined {
  const name = `ab-${createHash("sha256").update(realPathOf(stateDir)).digest("hex").slice(0, 8)}.sock`;
  for (const d of dirs) {
    if (!d || !isAbsolute(d) || uid === undefined) continue;
    let real: string, st: Stats;
    try { real = realpathSync(d); st = statSync(real); } catch { continue; }
    const path = join(real, name);
    if (st.isDirectory() && st.uid === uid && (st.mode & 0o022) === 0 && Buffer.byteLength(path) <= MAX_SOCKET_PATH_BYTES) return path;
  }
  return undefined;
}

/** The way out of a socket path that is too long: the CLI flag, the library option and the Python argument, in a private folder. */
const SOCKET_WAY_OUT = "give --socket PATH (library option socketPath, Python socket=) with a short path in a folder that only you can write (mode 0700)";

/** The refusal's way out for this state folder: SOCKET_WAY_OUT, an example (socketPathExample) when there is one, and that every caller must agree. */
const socketWayOut = (stateDir: string) => {
  const example = socketPathExample(stateDir);
  return `${SOCKET_WAY_OUT}${example ? `, for example --socket ${example}` : ""}; every caller of this state folder must give the same --socket`;
};

/**
 * A tab scope name: 1 to 64 characters, letters, digits, ".", "_" and "-", the first a letter or a
 * digit. The name goes into tab-scopes.json, error messages and the CLI's text output, so it is one
 * plain word: no space, quote, slash, colon or control character, and it never looks like a flag.
 * agentwatch's session names (letters, digits, "_" and "-", at most 64) all fit.
 */
export const TAB_SCOPE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const absolute = (name: string, p: string) => {
  if (typeof p !== "string" || !p) throw new UsageError(`${name} is required`);
  if (!isAbsolute(p)) throw new UsageError(`${name} must be an absolute path: ${p}`);
  return resolve(p);
};

/** Chrome for Testing is a build for automated tests; the agent browser always runs a regular Chrome. */
export function isChromeForTesting(bin: string): boolean {
  return /Chrome for Testing/i.test(bin) || /^chrome-headless-shell$/.test(basename(bin));
}

/**
 * An endpoint scope: the <scope> of agent mode's endpoint, /devtools/browser/<scope> (the relay's SCOPE in
 * src/relay/endpoint.ts; agentwatch passes the calling session's name). The relay lists each scope's own tabs only.
 */
export const ENDPOINT_SCOPE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Agent mode's endpoint (contract C11): ws+unix://<absolute socket path>:/devtools/browser/<scope> (group 1: the
 * socket path; group 2: the endpoint scope, ENDPOINT_SCOPE_RE). Nothing else: a loopback ws:// URL would reach a
 * Chrome's own debugging port (a prompt on each command, past noPrompt), and a wss:// URL would send page data to
 * another host.
 */
export const CDP_URL_RE = /^ws\+unix:\/\/(\/[^:]+):\/devtools\/browser\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/;

/** Validate a consumer's options and fill the defaults. Accepts settings that were already resolved. */
export function resolveOptions(o: BrowserOptions | Settings): Settings {
  if (!o || typeof o !== "object") throw new UsageError("options are required: at least stateDir");
  const stateDir = absolute("stateDir", o.stateDir);
  const profileDir = o.profileDir === undefined ? join(stateDir, "profile") : absolute("profileDir", o.profileDir);
  const socketPath = o.socketPath === undefined ? join(stateDir, "chrome-proxy.sock") : absolute("socketPath", o.socketPath);
  const cdp = o.cdpUrl !== undefined;
  const bytes = cdp ? 0 : Buffer.byteLength(socketPath), limit = `a Unix socket path holds at most ${MAX_SOCKET_PATH_BYTES} bytes (the macOS limit)`;
  if (bytes > MAX_SOCKET_PATH_BYTES && o.socketPath !== undefined)
    throw new UsageError(`socketPath is ${bytes} bytes, and ${limit}: ${socketPath}; ${socketWayOut(stateDir)}`);
  if (bytes > MAX_SOCKET_PATH_BYTES)
    throw new UsageError(`the default proxy socket ${socketPath} is ${bytes} bytes, and ${limit}: ${socketWayOut(stateDir)}`);
  const mode = o.mode ?? "agent";
  if (mode !== "agent" && mode !== "personal") throw new UsageError(`mode must be "agent" or "personal", not ${JSON.stringify(mode)}`);
  if (o.chromeBin !== undefined) {
    absolute("chromeBin", o.chromeBin);
    if (isChromeForTesting(o.chromeBin)) throw new UsageError("chromeBin: the agent browser never runs from Chrome for Testing; use Google Chrome or Chrome Beta");
  }
  if (o.endpoint !== undefined && !/^wss?:\/\//.test(o.endpoint)) throw new UsageError(`endpoint must be a ws:// URL: ${o.endpoint}`);
  if (o.cdpUrl !== undefined) {
    if (typeof o.cdpUrl !== "string" || !CDP_URL_RE.test(o.cdpUrl))
      throw new UsageError(`cdpUrl must be agent mode's endpoint, ws+unix://<absolute socket path>:/devtools/browser/<scope> (from \`agentwatch browser endpoint\`): ${o.cdpUrl}`);
    if (mode !== "agent") throw new UsageError("cdpUrl is for the agent browser (agent mode's endpoint), not for personal mode");
    if (o.endpoint !== undefined) throw new UsageError("cdpUrl or endpoint, not both: cdpUrl replaces the proxy, endpoint feeds it");
    // The proxy's and the launch's own options mean nothing here (a resolved Settings carries their defaults).
    const proxyOnly: [string, boolean][] = [["socketPath", o.socketPath !== undefined && o.socketPath !== join(stateDir, "chrome-proxy.sock")],
      ["approve", o.approve !== undefined && o.approve !== false], ["chromeBin", o.chromeBin !== undefined],
      ["proxyIdleMs", o.proxyIdleMs !== undefined && o.proxyIdleMs !== DEFAULT_PROXY_IDLE_MS]];
    for (const [name, given] of proxyOnly) if (given) throw new UsageError(`${name} is for the proxy and the agent Chrome that agent-browser starts; with cdpUrl there is neither`);
  }
  if (o.notify !== undefined && typeof o.notify !== "function") {
    const cmd = (o.notify as { command?: unknown }).command;
    if (!Array.isArray(cmd) || !cmd.length || !cmd.every((a) => typeof a === "string") || !cmd[0])
      throw new UsageError("notify must be a function or { command: [program, ...args] }");
  }
  if (o.approve !== undefined) {
    validateApprove(o.approve);
    if (o.approve !== false && mode === "personal")
      throw new UsageError("approve is only for the agent browser; in personal mode a person must approve the dialog on the operator's own Chrome");
  }
  if (o.chromeArgs !== undefined && (!Array.isArray(o.chromeArgs) || o.chromeArgs.some((a) => typeof a !== "string" || a.length === 0)))
    throw new UsageError("chromeArgs must be an array of non-empty strings"); // a remote-debugging, automation, headless or profile switch among them is refused at launch (assertSafeChromeArgs), in any dash/case form
  if (o.tabScope !== undefined && (typeof o.tabScope !== "string" || !TAB_SCOPE_RE.test(o.tabScope)))
    throw new UsageError(`tabScope must be 1 to 64 letters, digits, ".", "_" or "-", starting with a letter or a digit, not ${JSON.stringify(o.tabScope)}`);
  if (o.watchBackCommand !== undefined && (!Array.isArray(o.watchBackCommand) || !o.watchBackCommand.length || !o.watchBackCommand.every((x) => typeof x === "string" && x.length > 0)))
    throw new UsageError("watchBackCommand must be a non-empty array of non-empty strings");
  const proxyIdleMs = o.proxyIdleMs ?? DEFAULT_PROXY_IDLE_MS;
  if (!Number.isFinite(proxyIdleMs) || proxyIdleMs <= 0) throw new UsageError("proxyIdleMs must be a positive number");
  return {
    stateDir,
    profileDir,
    socketPath,
    allowlistFile: o.allowlistFile === undefined ? undefined : absolute("allowlistFile", o.allowlistFile),
    allow: o.allow,
    mode,
    chromeBin: o.chromeBin,
    chromeArgs: o.chromeArgs,
    endpoint: o.endpoint,
    cdpUrl: o.cdpUrl,
    personalUserDataDir: o.personalUserDataDir === undefined ? undefined : absolute("personalUserDataDir", o.personalUserDataDir),
    noLaunch: !!o.noLaunch,
    noPrompt: !!o.noPrompt,
    notify: o.notify,
    approve: o.approve,
    proxyIdleMs,
    commandName: o.commandName ?? "agent-browser",
    tabScope: o.tabScope,
    hiddenDrive: !!o.hiddenDrive,
    log: o.log ?? ((line: string) => { process.stderr.write(`${line}\n`); }),
    platform: o.platform ?? process.platform,
    inputTiming: resolveInputTiming(o.inputTiming),
    display: o.display,
    watchBackCommand: o.watchBackCommand,
    stopped: o.stopped,
  };
}

/** The state folder, created private to this user. */
export function stateDir(s: Settings): string {
  mkdirSync(s.stateDir, { recursive: true, mode: 0o700 });
  return s.stateDir;
}

export const statePath = (s: Settings, name: string) => join(stateDir(s), name);

/** The endpoint scope of agent mode's endpoint: the <scope> of cdpUrl's /devtools/browser/<scope>; undefined with no cdpUrl. */
export function endpointScope(s: Settings): string | undefined {
  if (s.cdpUrl === undefined) return undefined;
  const scope = CDP_URL_RE.exec(s.cdpUrl)?.[2];
  if (scope === undefined) throw new UsageError(`cdpUrl names no endpoint scope (ws+unix://<socket>:/devtools/browser/<scope>): ${s.cdpUrl}`);
  return scope;
}

/** The folder of the endpoint scopes' tab records in the state folder (recordDir). */
export const ENDPOINT_SCOPES_DIR = "endpoint-scopes";

/**
 * The folder name of an endpoint scope's tab record (recordDir): the scope, with each capital letter written as "+" and
 * its small letter ("My-Repo" gives "+my-+repo"). So no folder name has a capital letter, and two scopes that differ
 * only in case get two folders also on a disk that ignores case (the Mac's). No scope holds a "+", so no two scopes get
 * one name. A scope that ENDPOINT_SCOPE_RE does not match is refused: no ".", "..", slash or other path part gets in.
 */
export function scopeFolderName(scope: string): string {
  if (typeof scope !== "string" || !ENDPOINT_SCOPE_RE.test(scope))
    throw new UsageError(`an endpoint scope is 1 to 64 letters, digits, ".", "_" or "-", starting with a letter or a digit, not ${JSON.stringify(scope)}`);
  return scope.replace(/[A-Z]/g, (c) => `+${c.toLowerCase()}`);
}

/**
 * The folder of the tab record (browser.ts: tabs.json, tab-scopes.json, reads.json, window.json, tab-pages.json and their
 * lock tabs.lock). A record change creates it private to this user; a read creates no folder. Behind agent mode's
 * endpoint (cdpUrl) each endpoint scope lists only its own tabs, and a record change drops the entries of every tab that its connection does not list, so each endpoint scope
 * keeps a record of its own: <stateDir>/endpoint-scopes/<scopeFolderName(scope)>/ (board task ab-v16.58). With no
 * endpoint scope (the proxy, or a known endpoint) the record stays in the state folder itself, as before. Every other
 * file of the state folder stays one per agent browser for every endpoint scope: input.lock and pointer.json (input.ts),
 * display.json, chrome.json, the proxy's files, launches.log, shots/ and recordings/.
 */
export function recordDir(s: Settings): string {
  const scope = endpointScope(s);
  if (scope === undefined) return s.stateDir;
  return join(s.stateDir, ENDPOINT_SCOPES_DIR, scopeFolderName(scope));
}

/** A file of the tab record (recordDir). */
export const recordPath = (s: Settings, name: string) => join(recordDir(s), name);

/** True in a process started by Node's test runner (it sets NODE_TEST_CONTEXT in test children). */
export function underNodeTest(): boolean {
  return !!process.env.NODE_TEST_CONTEXT || process.execArgv.includes("--test")
    || /\.test\.[cm]?[jt]s$/.test(process.argv[1] ?? "");
}

/** Under a test, browser state must live in the temp folder, so no test can reach a real profile or proxy. */
export function assertTestStateIsolated(s: Settings): void {
  if (!underNodeTest()) return;
  const t = realpathSync(tmpdir());
  const inside = (p: string) => { const r = realpathSync(p); return r === t || r.startsWith(t + sep); };
  stateDir(s);
  if (!inside(s.stateDir)) throw new UsageError(`refusing: under node --test the state dir (${s.stateDir}) is outside the temp dir`);
}

/** The operator's own Chrome profile folder (personal mode). Under a test, never the real one. */
export function personalUserDataDir(s: Settings): string {
  if (s.personalUserDataDir) return s.personalUserDataDir;
  if (underNodeTest()) return join(tmpdir(), "agent-browser-test-no-real-chrome-profile");
  return join(homedir(), "Library", "Application Support", "Google", "Chrome");
}
