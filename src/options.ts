// What each consumer passes. Every consumer has its own state folder, its own Chrome profile (so its
// own cookies and logins), its own proxy socket and its own allowlist. Nothing in this package names
// a consumer's path: a missing stateDir is an error, never a guess.

import { mkdirSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { UsageError } from "./errors.ts";

export type BrowserMode = "agent" | "personal";

/** status --notify: a callback (library), or a command as an argv list (CLI and library). */
export type NotifyHook = ((message: string) => unknown) | { command: string[] };

export type BrowserOptions = {
  /** Absolute folder for this consumer's state: tab names, window pin, proxy pid and log, launch log, screenshots. */
  stateDir: string;
  /** The agent Chrome's profile: its cookies and logins. Default `<stateDir>/profile`. */
  profileDir?: string;
  /** The proxy's Unix socket (mode 0600). Default `<stateDir>/chrome-proxy.sock`. At most 103 bytes. */
  socketPath?: string;
  /** JSON file `{ "allow": ["example.com", ...] }`. The package reads it and never writes it. */
  allowlistFile?: string;
  /** Library only: the allowlist as an array, in place of allowlistFile. */
  allow?: string[];
  /** "agent" (default): a separate Chrome on profileDir. "personal": the operator's own Chrome, only when the operator asks. */
  mode?: BrowserMode;
  /** The agent Chrome binary. Default: Google Chrome Beta when installed, else Google Chrome. Never Chrome for Testing. */
  chromeBin?: string;
  /** A known upstream endpoint (ws://127.0.0.1:<port>/devtools/browser/<id>). The connection still goes through the proxy. */
  endpoint?: string;
  /** Personal mode: the operator's Chrome user-data folder, where Chrome writes DevToolsActivePort. */
  personalUserDataDir?: string;
  /** Never start Chrome: a missing agent browser is an error that names the launch command. */
  noLaunch?: boolean;
  /** status --notify sends one message here. */
  notify?: NotifyHook;
  /** The proxy exits after this long with no clients. Default 12 hours. */
  proxyIdleMs?: number;
  /** How hints name the command line, for example "vedlo browser". Default "agent-browser". */
  commandName?: string;
  /** Progress and warning lines. Default: standard error. */
  log?: (line: string) => void;
};

export type Settings = {
  stateDir: string;
  profileDir: string;
  socketPath: string;
  allowlistFile?: string;
  allow?: string[];
  mode: BrowserMode;
  chromeBin?: string;
  endpoint?: string;
  personalUserDataDir?: string;
  noLaunch: boolean;
  notify?: NotifyHook;
  proxyIdleMs: number;
  commandName: string;
  log: (line: string) => void;
};

export const DEFAULT_PROXY_IDLE_MS = 12 * 60 * 60 * 1000;

/** macOS limits a Unix socket path to 104 bytes, including the final NUL. */
export const MAX_SOCKET_PATH_BYTES = 103;

const absolute = (name: string, p: string) => {
  if (typeof p !== "string" || !p) throw new UsageError(`${name} is required`);
  if (!isAbsolute(p)) throw new UsageError(`${name} must be an absolute path: ${p}`);
  return resolve(p);
};

/** Chrome for Testing is a build for automated tests; the agent browser always runs a regular Chrome. */
export function isChromeForTesting(bin: string): boolean {
  return /Chrome for Testing/i.test(bin) || /^chrome-headless-shell$/.test(basename(bin));
}

/** Validate a consumer's options and fill the defaults. Accepts settings that were already resolved. */
export function resolveOptions(o: BrowserOptions | Settings): Settings {
  if (!o || typeof o !== "object") throw new UsageError("options are required: at least stateDir");
  const stateDir = absolute("stateDir", o.stateDir);
  const profileDir = o.profileDir === undefined ? join(stateDir, "profile") : absolute("profileDir", o.profileDir);
  const socketPath = o.socketPath === undefined ? join(stateDir, "chrome-proxy.sock") : absolute("socketPath", o.socketPath);
  if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES)
    throw new UsageError(`socketPath is ${Buffer.byteLength(socketPath)} bytes; a Unix socket path holds at most ${MAX_SOCKET_PATH_BYTES}: ${socketPath}`);
  const mode = o.mode ?? "agent";
  if (mode !== "agent" && mode !== "personal") throw new UsageError(`mode must be "agent" or "personal", not ${JSON.stringify(mode)}`);
  if (o.chromeBin !== undefined) {
    absolute("chromeBin", o.chromeBin);
    if (isChromeForTesting(o.chromeBin)) throw new UsageError("chromeBin: the agent browser never runs from Chrome for Testing; use Google Chrome or Chrome Beta");
  }
  if (o.endpoint !== undefined && !/^wss?:\/\//.test(o.endpoint)) throw new UsageError(`endpoint must be a ws:// URL: ${o.endpoint}`);
  if (o.notify !== undefined && typeof o.notify !== "function") {
    const cmd = (o.notify as { command?: unknown }).command;
    if (!Array.isArray(cmd) || !cmd.length || !cmd.every((a) => typeof a === "string") || !cmd[0])
      throw new UsageError("notify must be a function or { command: [program, ...args] }");
  }
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
    endpoint: o.endpoint,
    personalUserDataDir: o.personalUserDataDir === undefined ? undefined : absolute("personalUserDataDir", o.personalUserDataDir),
    noLaunch: !!o.noLaunch,
    notify: o.notify,
    proxyIdleMs,
    commandName: o.commandName ?? "agent-browser",
    log: o.log ?? ((line: string) => { process.stderr.write(`${line}\n`); }),
  };
}

/** The state folder, created private to this user. */
export function stateDir(s: Settings): string {
  mkdirSync(s.stateDir, { recursive: true, mode: 0o700 });
  return s.stateDir;
}

export const statePath = (s: Settings, name: string) => join(stateDir(s), name);

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
