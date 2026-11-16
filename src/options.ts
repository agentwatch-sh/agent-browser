// What each consumer passes. Every consumer has its own state folder and its own allowlist, and reaches the agent
// browser through agent mode's endpoint (cdpUrl, from agentwatch): the only way to drive it (board ab-v16.9.3; the
// CDP proxy, the agent Chrome that agent-browser started itself and personal mode are gone). Nothing in this package
// names a consumer's path: a missing stateDir or cdpUrl is an error, never a guess.

import { realpathSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { UsageError } from "./errors.ts";

/** status --notify: a callback (library), or a command as an argv list (CLI and library). */
export type NotifyHook = ((message: string) => unknown) | { command: string[] };

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
  /** How long an input command waits for another input command of the same agent browser (the input lock). */
  lockWaitMs: number;
};

/**
 * The defaults: a person's input (the input design's first values). A click costs about 0.5 to 1.5 s, a typed character
 * about 0.2 to 0.3 s for the first 12 s of a run and 0.1 to 0.12 s after them.
 */
export const INPUT_TIMING: Readonly<InputTiming> = Object.freeze({
  pressMs: [60, 180], keyMs: [20, 3000], holdMs: [50, 250], settleMs: [80, 400], wheelMs: [35, 90], moveScale: 1, activateMs: 1000, lockWaitMs: 600_000,
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
  /** Absolute folder for this consumer's state: tab names and scopes, window pin, input lock, pointer, screenshots. */
  stateDir: string;
  /**
   * Agent mode's CDP endpoint (agentwatch's relay: ws+unix://<socket>:/devtools/browser/<scope>, from `agentwatch
   * browser endpoint`): required, and the only way to drive the agent browser. Each connection goes to it; agent-browser
   * starts no Chrome and no proxy, because that agent browser belongs to agentwatch.
   */
  cdpUrl: string;
  /** JSON file `{ "allow": ["example.com", ...] }`. The package reads it and never writes it. */
  allowlistFile?: string;
  /** Library only: the allowlist as an array, in place of allowlistFile. */
  allow?: string[];
  /** status --notify sends one message here when agent mode's endpoint does not answer. */
  notify?: NotifyHook;
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
   * two modes**), where a page has no window of its own (the relay on the Mac, a display that is not the agent
   * browser's own). Default off: a command turns on focus emulation while it is attached, so a background tab's
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
   * platform's behaviour. On "linux" each page has a window of its own (windowPerPage).
   */
  platform?: NodeJS.Platform;
  /**
   * The shape of a person's input in a window of its own (Linux; ab-v16.26), in parts: the fields that it
   * names replace the defaults (INPUT_TIMING). CLI --input-timing JSON, Python input_timing=.
   */
  inputTiming?: Partial<InputTiming>;
  /** @internal The agent Chrome's display, for the tests (DisplayOption). Default: found (display.ts, displayOf). */
  display?: DisplayOption;
};

export type Settings = {
  stateDir: string;
  cdpUrl: string;
  allowlistFile?: string;
  allow?: string[];
  notify?: NotifyHook;
  commandName: string;
  tabScope?: string;
  hiddenDrive: boolean;
  log: (line: string) => void;
  platform: NodeJS.Platform;
  inputTiming: InputTiming;
  display?: DisplayOption;
};

/**
 * On Linux (ab-v16.26; docs/research/2026-11-05-anti-detect-drive.md; the relay's windows, ab-v16.28): each page gets a
 * window of its own and no focus emulation, as a person's page in a window that is not in front. This is the first half
 * of the gate: the design applies only where the agent Chrome also runs on a display of its own (display.ts, displayOf;
 * AgentBrowser.windows), so that it never puts windows on a person's screen or takes their focus. On the Mac the relay
 * keeps its tabs, so every page there is driven as a background tab (focus emulation, or hiddenDrive).
 */
export const windowPerPage = (s: Settings): boolean => s.platform === "linux";

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

/**
 * An endpoint scope: the <scope> of agent mode's endpoint, /devtools/browser/<scope> (the relay's SCOPE in
 * src/relay/endpoint.ts; agentwatch passes the calling session's name). The relay lists each scope's own tabs only.
 */
export const ENDPOINT_SCOPE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Agent mode's endpoint (contract C11): ws+unix://<absolute socket path>:/devtools/browser/<scope> (group 1: the
 * socket path; group 2: the endpoint scope, ENDPOINT_SCOPE_RE). Nothing else: a loopback ws:// URL would reach a
 * Chrome's own debugging port (an "Allow remote debugging?" prompt on each connection, or a Chrome started with a
 * debugging port, which sets navigator.webdriver), and a wss:// URL would send page data to another host.
 */
export const CDP_URL_RE = /^ws\+unix:\/\/(\/[^:]+):\/devtools\/browser\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/;

/** Validate a consumer's options and fill the defaults. Accepts settings that were already resolved. */
export function resolveOptions(o: BrowserOptions | Settings): Settings {
  if (!o || typeof o !== "object") throw new UsageError("options are required: at least stateDir");
  const stateDir = absolute("stateDir", o.stateDir);
  // The options of the CDP proxy, of the agent Chrome that agent-browser started itself and of personal mode are gone
  // (board ab-v16.9.3): each one is refused by name, so that an old caller learns why, not only that it failed.
  const gone = REMOVED_OPTIONS.filter((k) => (o as Record<string, unknown>)[k] !== undefined);
  if (gone.length) throw new UsageError(`${gone.join(", ")}: ${gone.length > 1 ? "these options are" : "this option is"} gone with the CDP proxy; ${CDP_URL_NEEDED}`);
  if (o.cdpUrl === undefined) throw new UsageError(`cdpUrl is required: ${CDP_URL_NEEDED}`);
  if (typeof o.cdpUrl !== "string" || !CDP_URL_RE.test(o.cdpUrl))
    throw new UsageError(`cdpUrl must be agent mode's endpoint, ws+unix://<absolute socket path>:/devtools/browser/<scope> (from \`agentwatch browser endpoint\`): ${o.cdpUrl}`);
  if (o.notify !== undefined && typeof o.notify !== "function") {
    const cmd = (o.notify as { command?: unknown }).command;
    if (!Array.isArray(cmd) || !cmd.length || !cmd.every((a) => typeof a === "string") || !cmd[0])
      throw new UsageError("notify must be a function or { command: [program, ...args] }");
  }
  if (o.tabScope !== undefined && (typeof o.tabScope !== "string" || !TAB_SCOPE_RE.test(o.tabScope)))
    throw new UsageError(`tabScope must be 1 to 64 letters, digits, ".", "_" or "-", starting with a letter or a digit, not ${JSON.stringify(o.tabScope)}`);
  return {
    stateDir,
    cdpUrl: o.cdpUrl,
    allowlistFile: o.allowlistFile === undefined ? undefined : absolute("allowlistFile", o.allowlistFile),
    allow: o.allow,
    notify: o.notify,
    commandName: o.commandName ?? "agent-browser",
    tabScope: o.tabScope,
    hiddenDrive: !!o.hiddenDrive,
    log: o.log ?? ((line: string) => { process.stderr.write(`${line}\n`); }),
    platform: o.platform ?? process.platform,
    inputTiming: resolveInputTiming(o.inputTiming),
    display: o.display,
  };
}

/**
 * The library options that went with the CDP proxy (board ab-v16.9.3; the operator's decision ab-ag0: "No backward
 * compat. We move everything over to the new browser so that operator approvals are not required."). resolveOptions
 * refuses each of them by name.
 */
export const REMOVED_OPTIONS = ["profileDir", "socketPath", "mode", "chromeBin", "chromeArgs", "endpoint", "personalUserDataDir", "noLaunch",
  "noPrompt", "approve", "approveAfterWake", "proxyIdleMs"] as const;

/** What a caller does in place of the proxy: the one way to the agent browser. */
export const CDP_URL_NEEDED = "agent mode's endpoint (cdpUrl; CLI --cdp-url URL; Python cdp_url=) is the only way to drive the agent browser: get it with `agentwatch browser endpoint`; agent-browser no longer starts Chrome or a CDP proxy, and no approval of Chrome's \"Allow remote debugging?\" prompt is needed";

/** The state folder, created private to this user. */
export function stateDir(s: Settings): string {
  mkdirSync(s.stateDir, { recursive: true, mode: 0o700 });
  return s.stateDir;
}

export const statePath = (s: Settings, name: string) => join(stateDir(s), name);

/** The endpoint scope of agent mode's endpoint: the <scope> of cdpUrl's /devtools/browser/<scope>. */
export function endpointScope(s: Settings): string {
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
 * The folder of the tab record (browser.ts: tabs.json, tab-scopes.json, reads.json, window.json and their lock
 * tabs.lock). A record change creates it private to this user; a read creates no folder. Behind agent mode's endpoint
 * each endpoint scope lists only its own tabs, and a record change drops the entries of every tab that its connection
 * does not list, so each endpoint scope keeps a record of its own: <stateDir>/endpoint-scopes/<scopeFolderName(scope)>/
 * (board task ab-v16.58). Every other file of the state folder stays one per agent browser for every endpoint scope:
 * input.lock and pointer.json (input.ts), shots/ and recordings/.
 */
export function recordDir(s: Settings): string {
  return join(s.stateDir, ENDPOINT_SCOPES_DIR, scopeFolderName(endpointScope(s)));
}

/** A file of the tab record (recordDir). */
export const recordPath = (s: Settings, name: string) => join(recordDir(s), name);

/** True in a process started by Node's test runner (it sets NODE_TEST_CONTEXT in test children). */
export function underNodeTest(): boolean {
  return !!process.env.NODE_TEST_CONTEXT || process.execArgv.includes("--test")
    || /\.test\.[cm]?[jt]s$/.test(process.argv[1] ?? "");
}

/** Under a test, browser state must live in the temp folder, so no test can reach a real state folder. */
export function assertTestStateIsolated(s: Settings): void {
  if (!underNodeTest()) return;
  const t = realpathSync(tmpdir());
  const inside = (p: string) => { const r = realpathSync(p); return r === t || r.startsWith(t + sep); };
  stateDir(s);
  if (!inside(s.stateDir)) throw new UsageError(`refusing: under node --test the state dir (${s.stateDir}) is outside the temp dir`);
}
