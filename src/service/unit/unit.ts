// The Chrome unit of `agent-browser service` on Linux: a private Xvfb and a Chrome on it (the self-contained design,
// sections 5.1, 5.2 and 13.2; board ab-v16.94.3; a port of agentwatch's daemon/browser/unit.py, BrowserUnit).
//
// - The service starts Xvfb and Chrome detached, each in its own session, so they outlive the service (its unit has
//   KillMode=process). The unit record (unit.json, record.ts) names them by pid and start time.
// - A new service adopts them from the record: only what the record names, by pid and start time (when the record
//   has them; a record of agentwatch's daemon has none), on the agent profile (`--user-data-dir=<profile>`) and the X
//   auth file of the state folder, of this user only. A pid is never signalled until its command line and its start
//   time show that it is the unit's process, so a reused pid is safe.
// - Which Chrome: `chrome_bin` empty (or null) in `config` runs Google Chrome stable from the tools folder
//   (google-chrome.ts), the newest copy whose move did not fail; with no copy a start begins the install and waits for
//   it up to 45 s. A set `chrome_bin` keeps the way back to Chromium.
// - The flags: AGENT_ARGS and agent-browser's assertSafeChromeArgs alone on the config's `chrome_args` (no
//   --remote-debugging-*, no --enable-automation, no --headless, no other profile). Chrome's environment is built
//   from scratch: no token reaches it. The X cookie lives only in the 0600 X auth file.
// - The supervisor checks the local pids every 5 s and starts a wanted Chrome again after a backoff of 1 s doubling to
//   60 s; three failed starts in a row report once.
//
// The Mac (board ab-v16.94.6; the design, section 10): with `mac` (mac-chrome.ts) the unit runs the operator's own Google
// Chrome.app a second time on the agent profile, through `open -n -g`, and finds the new Chrome's main process on the
// profile (a child of launchd, not of the service); it starts no Xvfb, stages no CRX, and its record has no display.
// The give-back guard records the front app before `open`. Before `open` the unit writes the agent package's folder for
// the operator's "Load unpacked" when it differs from the pin (board ab-v16.94.19; mac-chrome.ts, agentPackage).
//
// Stage 1b part 1 has no agent package and no native link (part 2, board ab-v16.94.9): Chrome starts with no
// extension, so the fail-closed watch (watch.ts) stops it 60 s after its last confirm. The owner rule (owner.ts) is
// asked right before each Chrome start (`mayAct`).

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { AGENT_ARGS, appBundle, assertSafeChromeArgs, CHROME_STABLE_BIN } from "../../agent.ts";
import { BINARY_REL } from "./deb.ts";
import { RECEIVER_ID } from "../package/pins.ts";
import { displayInUse, abstractDisplays, DISPLAY_FIRST, DISPLAY_LAST, type DisplayFs } from "./display.ts";
import type { ChromeTools, ChromeCopy } from "./google-chrome.ts";
import type { MacApp, MacStart } from "./mac-chrome.ts";
import { Mutex } from "./mutex.ts";
import { realOf, type UnitPaths } from "./paths.ts";
import type { Procs } from "./procs.ts";
import { intOf, readRecord, writeJsonDurable, type RecordRead } from "./record.ts";
import { VERSION_RE } from "./versions.ts";
import { writeXauthority, COOKIE_LEN } from "./xauth.ts";

export const KIND_GOOGLE = "google-chrome";
export const KIND_CHROMIUM = "chromium";
export const XVFB_TRIES = 10;
export const XVFB_WAIT_MS = 5000;
const XVFB_POLL_MS = 50;
/** How long a started Chrome must stay alive before the start reports it running. */
export const CHROME_SETTLE_MS = 1000;
const SETTLE_POLL_MS = 100;
/** SIGTERM, then this long, then SIGKILL. */
export const TERM_GRACE_MS = 5000;
export const KILL_WAIT_MS = 2000;
const STOP_POLL_MS = 100;
/** The supervisor's local pid check. */
export const SUPERVISE_MS = 5000;
export const BACKOFF_MIN_MS = 1000;
export const BACKOFF_MAX_MS = 60_000;
/** A Chrome that lived this long was healthy: the backoff and the failure streak start again. */
export const HEALTHY_MS = 300_000;
/** Failed starts in a row before one start_failed report. */
export const FAILURES_TO_REPORT = 3;
/** How long a start waits for a Google Chrome install that it began or found running. */
export const CHROME_INSTALL_WAIT_MS = 45_000;
const CHROME_INSTALL_POLL_MS = 500;
export const SIZE_MIN = 320, SIZE_MAX = 7680;
/** The Mac: how long a start waits after `open` for the new Chrome's main process on the agent profile. */
export const MAC_FIND_MS = 15_000;
/** The Mac: how long the give-back guard of a start still watches after the start found its Chrome. */
export const MAC_GUARD_AFTER_MS = 10_000;
/** The only variables of the service that Xvfb and Chrome inherit. */
export const ENV_COPIED = ["PATH", "HOME", "LANG", "XDG_RUNTIME_DIR"] as const;

// The texts below name no command (I2 of agentwatch's gateway): a start of a stopped agent browser ends no sign-in.
export const CHROME_INSTALLING = "Google Chrome is being installed into the tools folder; the agent browser can start when the install ends, in a few minutes";
export const CHROME_NOT_INSTALLED = "Google Chrome is not installed; the next start of the agent browser installs it";
export const STOPPED_DURING_INSTALL = "the agent browser was stopped while Google Chrome was being installed; it stays stopped";
export const SANDBOX_NEEDS_USERNS = "Chrome's sandbox needs unprivileged user namespaces on this box";
const USERNS_OFF: readonly [string, string][] = [["kernel/unprivileged_userns_clone", "0"], ["user/max_user_namespaces", "0"], ["kernel/apparmor_restrict_unprivileged_userns", "1"]];
export const chromeFailed = (reason: string) => `Google Chrome could not be set up: ${reason}. To keep the box's Chromium, set browser.chrome_bin: /usr/bin/chromium`;

/** A start that failed: the text is the start's answer. */
export class StartError extends Error {}
/** A start that the config refuses (browser.enabled false, a refused flag, a bad size): not a failure of a copy. */
export class ConfigError extends StartError {}
/** The owner rule said no right before an owner part: the service no longer owns the Chrome unit. */
export class NotOwnerError extends Error {}

/** The keys of `config` that the unit reads (C12: `enabled`, `chrome_bin`, `chrome_args`, and agentwatch's other browser.* keys). */
export type UnitConfig = { enabled: boolean; chromeBin: string; chromeArgs: string[]; displaySize: string; lang: string; timezone: string };
export const DEFAULT_CONFIG: UnitConfig = Object.freeze({ enabled: true, chromeBin: "", chromeArgs: [], displaySize: "1280x900", lang: "en-US", timezone: "" }) as UnitConfig;

/** The unit's config from the keys of one `config` request (the shape step checked enabled, chrome_bin and chrome_args). */
export function configFrom(keys: Record<string, unknown>): UnitConfig {
  const str = (k: string, d: string) => (typeof keys[k] === "string" ? keys[k] as string : d);
  return {
    enabled: keys.enabled !== false,
    chromeBin: typeof keys.chrome_bin === "string" ? keys.chrome_bin : "",
    chromeArgs: Array.isArray(keys.chrome_args) ? (keys.chrome_args as string[]).filter((a) => typeof a === "string") : [],
    displaySize: str("display_size", DEFAULT_CONFIG.displaySize),
    lang: str("lang", DEFAULT_CONFIG.lang),
    timezone: str("timezone", DEFAULT_CONFIG.timezone),
  };
}

/** "WxH" with each side from SIZE_MIN to SIZE_MAX, else a ConfigError. */
export function parseDisplaySize(value: unknown): [number, number] {
  const m = typeof value === "string" ? /^([0-9]{1,5})x([0-9]{1,5})$/.exec(value) : null;
  if (m) {
    const w = Number(m[1]), h = Number(m[2]);
    if (w >= SIZE_MIN && w <= SIZE_MAX && h >= SIZE_MIN && h <= SIZE_MAX) return [w, h];
  }
  throw new ConfigError(`browser.display_size must be WIDTHxHEIGHT, each side ${SIZE_MIN} to ${SIZE_MAX}`);
}

/** The flags check of a start: AGENT_ARGS and the config's chrome_args through assertSafeChromeArgs, the only check. */
export function checkChromeArgs(args: readonly string[]): void {
  try { assertSafeChromeArgs([...AGENT_ARGS, ...args]); }
  catch (e) { throw new ConfigError((e as Error).message); }
}

/**
 * The agent profile's Preferences (writeDownloadPrefs): `o` with the downloads' folder, no password saving, no leak check,
 * no autofill, and the receiver allowed in incognito and with access to local files. The blanket Chrome's empty profile
 * gets the same (board ab-4wh.3).
 */
export function agentPrefs(o: Record<string, any>, downloads: string): Record<string, any> {
  const obj = (x: unknown): Record<string, any> => (x && typeof x === "object" && !Array.isArray(x) ? x as Record<string, any> : {});
  for (const [section, values] of [["download", { default_directory: downloads, prompt_for_download: false, directory_upgrade: true }], ["savefile", { default_directory: downloads }],
    ["profile", { password_manager_enabled: false, password_manager_leak_detection: false }],
    ["autofill", { enabled: false, profile_enabled: false, credit_card_enabled: false }]] as const) {
    o[section] = { ...obj(o[section]), ...values };
  }
  o.credentials_enable_service = false;
  const ext = obj(o.extensions), settings = obj(ext.settings);
  settings[RECEIVER_ID] = { ...obj(settings[RECEIVER_ID]), incognito: true, newAllowFileAccess: true };
  o.extensions = { ...ext, settings };
  return o;
}

/** A process that the unit started. */
export type Spawned = { readonly pid: number; exited(): boolean; code(): number | null };
export type Spawn = (argv: string[], env: Record<string, string>) => Spawned;

/** Start `argv` detached: a new session and process group (setsid), no stdio, umask 077, and the service does not wait for it. */
export const spawnDetached: Spawn = (argv, env) => {
  const umask = process.umask(0o077);
  let child;
  try { child = spawn(argv[0], argv.slice(1), { env, stdio: "ignore", detached: true }); }
  finally { process.umask(umask); }
  let exited = false, code: number | null = null;
  child.once("exit", (c, s) => { exited = true; code = c ?? (s ? 128 : null); });
  child.once("error", () => { exited = true; });
  child.unref();
  if (child.pid === undefined) throw new StartError(`could not start ${argv[0]}`);
  return { pid: child.pid, exited: () => exited, code: () => code };
};

/** Signal the process group of `pid` when it leads one (the unit starts each process as a session leader), else `pid`. */
export const signalGroup = (procs: Procs) => (pid: number, sig: NodeJS.Signals) => {
  const st = procs.stat(pid);
  process.kill(st && st.pgrp === pid ? -pid : pid, sig);
};

type Child = { pid: number; start: number | null; proc: Spawned | null; startedAt: number | null };
type Plan = { binary: string; kind: string; version: string; recordedBin: string };

/**
 * The supervisor's events: `gone` when it finds a wanted Chrome gone (a crash; the part drops that Chrome's link: board
 * ab-b84.36), `ready` after its start again, and `start_failed` once for a run of failed starts.
 */
export type UnitEvent =
  | { kind: "gone" }
  | { kind: "ready" }
  | { kind: "start_failed"; reason: string };

export type UnitDeps = {
  paths: UnitPaths;
  procs: Procs;
  tools: ChromeTools;
  spawn?: Spawn;
  kill?: (pid: number, sig: NodeJS.Signals) => void;
  /** A monotonic clock in ms. */
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** The X sockets' folder (/tmp: /tmp/.X11-unix/X<n> and /tmp/.X<n>-lock). */
  xRoot?: string;
  displayFs: DisplayFs;
  displays?: { first: number; last: number };
  which: (name: string) => string | null;
  /** The versions whose move failed (the updater's state): a start never runs them. */
  refused?: () => ReadonlySet<string>;
  /** The owner rule, right before each Chrome start; false: the service no longer owns. */
  mayAct?: (what: string) => Promise<boolean>;
  log: (line: string) => void;
  /** The supervisor's backoff sleep, which the service's stop ends at once (default: `sleep`). */
  nap?: (ms: number) => Promise<void>;
  /**
   * A start found the last Chrome gone before the supervisor's check did (a crash), or stopped a Chrome whose display is
   * gone: called once, before the new Chrome starts (the part drops that Chrome's link, as at the supervisor's `gone`;
   * board ab-b84.37).
   */
  gone?: () => void;
  env?: Record<string, string | undefined>;
  wall?: () => number;
  random?: (n: number) => Buffer;
  /**
   * The agent package (stage 1b part 2, board ab-v16.94.9; package/crx.ts): before each start of a Google Chrome copy,
   * check the pinned CRX, stage it and write the copy's external extensions file; returns the staged CRX's version.
   * `lastFile`: the version of the copy's extensions file of an earlier start, only when its staged CRX still has the
   * pinned SHA-256 (review-110 B1); else null, and Chrome then starts with no agent package.
   */
  prepare?: { run: (copy: ChromeCopy) => string; lastFile: (copy: ChromeCopy) => string | null };
  /** The Mac (mac-chrome.ts): the operator's Google Chrome.app through `open -n -g`, with no Xvfb and no agent package. */
  mac?: MacStart;
  /**
   * Right before each start of Chrome, after the unit's own writes into the profile (`Preferences`; on the Mac also the
   * agent package's folder), with the version that the start runs ("" for a Chromium): board ab-v16.118, the part's read
   * of the profile. It never fails a start.
   */
  beforeChrome?: (version: string) => void;
};

export class ChromeUnit {
  private readonly d: UnitDeps;
  private readonly spawn: Spawn;
  private readonly kill: (pid: number, sig: NodeJS.Signals) => void;
  private readonly clock: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly lock = new Mutex();
  config: UnitConfig | null = null;
  private wantedFlag = false;
  private display: number | null = null;
  private displaySize: [number, number] | null = null;
  private xvfb: Child | null = null;
  private chrome: Child | null = null;
  private chromeInfo: { kind: string; version: string } | null = null;
  /** The Mac: the app of the last start or adoption. */
  private mac: MacApp | null = null;
  /** The version of the agent package that the last start's prepare staged; null before one, for a Chromium, or after a failed one. */
  private staged: string | null = null;
  private chromeBin = "";
  /** The newest version that the last start allowed (the way back after a failed move); the supervisor keeps it. */
  private upto: string | null = null;
  /** Processes that adopt() found but did not take (an Xvfb whose Chrome is gone): SIGTERM at once, a start or stop finishes. */
  private leftovers: { child: Child; markers: string[] }[] = [];
  private installJob: { done: boolean; result: string } | null = null;
  private installSeen = true;
  private stops = 0;
  private backoff = BACKOFF_MIN_MS;
  private failures = 0;
  private reported = false;
  private lastFailure = "";
  /** A start or a restart runs now (the status's `starting`). */
  starting = false;
  /** The service stops: the supervisor starts nothing more. */
  private halted = false;

  constructor(d: UnitDeps) {
    this.d = d;
    this.spawn = d.spawn ?? spawnDetached;
    this.kill = d.kill ?? signalGroup(d.procs);
    this.clock = d.clock ?? (() => performance.now());
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  get paths(): UnitPaths { return this.d.paths; }
  get wanted(): boolean { return this.wantedFlag; }
  get stopCount(): number { return this.stops; }
  get locked(): boolean { return this.lock.locked; }
  /** The service stops: no start and no restart after this (Chrome itself stays). */
  halt(): void { this.halted = true; }

  // ------------------------------------------------------------------ processes

  private aliveChild(c: Child | null): boolean {
    if (!c) return false;
    if (c.proc && c.proc.exited()) return false;
    const st = this.d.procs.stat(c.pid);
    return st !== null && (c.start === null || st.start === c.start);
  }

  running(): boolean { return this.aliveChild(this.chrome) && (!!this.d.mac || this.aliveChild(this.xvfb)); }

  /** The Mac: the app of the running Chrome (its bundle, binary and version), or null. */
  macApp(): MacApp | null { return this.d.mac && this.running() ? this.mac : null; }

  private xvfbMarkers(display: number): string[] { return [`:${display}`, this.d.paths.xauth]; }
  private chromeMarkers(): string[] { return [`--user-data-dir=${this.d.paths.profile}`]; }

  /** True when `c` is alive, this user's, has each marker as a whole argument, and its start time is the recorded one. */
  private isOurs(c: Child, markers: string[]): boolean {
    if (!this.d.procs.holds(c.pid, markers)) return false;
    const st = this.d.procs.stat(c.pid);
    return st !== null && (c.start === null || st.start === c.start);
  }

  private signal(c: Child, markers: string[], sig: NodeJS.Signals): boolean {
    if (c.pid <= 1 || !this.aliveChild(c)) return false;
    if (!this.isOurs(c, markers)) { this.d.log(`unit: pid ${c.pid} no longer runs the unit's program; not signalled`); return false; }
    try { this.kill(c.pid, sig); } catch { return false; }
    return true;
  }

  private async waitGone(c: Child, ms: number): Promise<boolean> {
    const end = this.clock() + ms;
    while (this.aliveChild(c)) {
      if (this.clock() >= end) return false;
      await this.sleep(STOP_POLL_MS);
    }
    return true;
  }

  /** SIGTERM, TERM_GRACE_MS, SIGKILL. True when `c` was ours and alive. */
  private async stopChild(c: Child | null, markers: string[]): Promise<boolean> {
    if (!c || !this.signal(c, markers, "SIGTERM")) return false;
    if (!(await this.waitGone(c, TERM_GRACE_MS))) { this.signal(c, markers, "SIGKILL"); await this.waitGone(c, KILL_WAIT_MS); }
    return true;
  }

  private async stopLeftovers(): Promise<boolean> {
    const l = this.leftovers;
    this.leftovers = [];
    let stopped = false;
    for (const x of l) stopped = (await this.stopChild(x.child, x.markers)) || stopped;
    return stopped;
  }

  /**
   * The Chromes on the unit's profile that the unit does not hold: the roots of the trees (a process whose parent is
   * not on the profile itself), never a held pid nor a process below one at any depth.
   */
  orphanChromes(held: ReadonlySet<number>): number[] {
    const markers = this.chromeMarkers();
    const onProfile = new Map<number, number>();
    for (const pid of this.d.procs.pids()) {
      if (!this.d.procs.holds(pid, markers)) continue;
      const st = this.d.procs.stat(pid);
      if (st) onProfile.set(pid, st.ppid);
    }
    const below = (pid: number) => {
      const seen = new Set([pid]);
      for (let at = this.d.procs.stat(pid)?.ppid; at !== undefined && at > 1 && !seen.has(at); at = this.d.procs.stat(at)?.ppid) {
        if (held.has(at)) return true;
        seen.add(at);
      }
      return false;
    };
    return [...onProfile].filter(([pid, ppid]) => !held.has(pid) && !onProfile.has(ppid) && !below(pid)).map(([pid]) => pid).sort((a, b) => a - b);
  }

  private async stopOrphanChromes(): Promise<boolean> {
    const held = new Set(this.chrome ? [this.chrome.pid] : []);
    let stopped = false;
    for (const pid of this.orphanChromes(held)) {
      const st = this.d.procs.stat(pid);
      if (await this.stopChild({ pid, start: st?.start ?? null, proc: null, startedAt: null }, this.chromeMarkers())) {
        this.d.log(`unit: stopped a Chrome on the unit's profile that no unit held (pid ${pid})`);
        stopped = true;
      }
    }
    return stopped;
  }

  private async stopXvfb(): Promise<boolean> {
    const c = this.xvfb, display = this.display;
    this.xvfb = null; this.display = null;
    if (!c || display === null) return false;
    return this.stopChild(c, this.xvfbMarkers(display));
  }

  private baseEnv(): Record<string, string> {
    const env = this.d.env ?? process.env;
    const out: Record<string, string> = {};
    for (const k of ENV_COPIED) if (env[k] !== undefined) out[k] = env[k]!;
    return out;
  }

  // ------------------------------------------------------------------ the record

  readRecord(): RecordRead { return readRecord(this.d.paths.unitFile); }

  private writeRecord(record: Record<string, unknown>): void {
    try { writeJsonDurable(this.d.paths.unitFile, record); }
    catch (e) { this.d.log(`unit: could not write the unit record: ${(e as NodeJS.ErrnoException).code ?? (e as Error).name}`); }
  }

  private privateDir(dir: string): void {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const st = lstatSync(dir);
    if (!st.isDirectory() || st.uid !== this.d.procs.uid) throw new StartError(`${dir} is not a folder of this user`);
  }

  // ------------------------------------------------------------------ the start

  private checkedConfig(): { cfg: UnitConfig; width: number; height: number } {
    const cfg = this.config;
    if (!cfg) throw new StartError("the agent browser has no config yet: the daemon sends it at its connect");
    if (!cfg.enabled) throw new ConfigError("browser.enabled is false in config");
    const [width, height] = parseDisplaySize(cfg.displaySize);
    checkChromeArgs(cfg.chromeArgs);
    return { cfg, width, height };
  }

  private async waitDisplay(c: Child, display: number): Promise<"up" | "exited" | "timeout"> {
    const sock = join(this.d.xRoot ?? "/tmp", ".X11-unix", `X${display}`);
    const end = this.clock() + XVFB_WAIT_MS;
    for (;;) {
      if (!this.aliveChild(c)) return "exited";
      if (this.d.displayFs.exists(sock)) return "up";
      if (this.clock() >= end) return "timeout";
      await this.sleep(XVFB_POLL_MS);
    }
  }

  /** Start Xvfb on the first free display that takes, with a fresh cookie; the display. */
  private async startXvfb(xvfbBin: string, width: number, height: number): Promise<number> {
    const { first, last } = this.d.displays ?? { first: DISPLAY_FIRST, last: DISPLAY_LAST };
    const xRoot = this.d.xRoot ?? "/tmp";
    const abstract = abstractDisplays(this.d.displayFs.netUnix());
    let tries = 0;
    for (let display = first; display <= last; display++) {
      if (displayInUse(display, xRoot, this.d.displayFs, abstract)) continue;
      tries++;
      try { writeXauthority(this.d.paths.xauth, display, (this.d.random ?? randomBytes)(COOKIE_LEN)); }
      catch (e) { throw new StartError(`could not write the X auth file: ${(e as NodeJS.ErrnoException).code ?? "error"}`); }
      const argv = [xvfbBin, `:${display}`, "-nolisten", "tcp", "-auth", this.d.paths.xauth, "-screen", "0", `${width}x${height}x24`];
      let proc: Spawned;
      try { proc = this.spawn(argv, this.baseEnv()); }
      catch (e) { throw new StartError(`could not start Xvfb: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`); }
      const child: Child = { pid: proc.pid, start: this.d.procs.stat(proc.pid)?.start ?? null, proc, startedAt: this.clock() };
      // Tracked at once, so a cut start leaves nothing unknown behind.
      this.xvfb = child; this.display = display;
      const outcome = await this.waitDisplay(child, display);
      if (outcome === "up") {
        if (child.start === null) child.start = this.d.procs.stat(child.pid)?.start ?? null;
        this.displaySize = [width, height];
        this.writeRecord({ wanted: false, display, xvfb_pid: child.pid, xvfb_start: child.start, chrome_pid: null, display_size: [width, height] });
        this.d.log(`unit: Xvfb up on :${display} (pid ${child.pid})`);
        return display;
      }
      if (outcome === "timeout") { await this.stopXvfb(); throw new StartError(`Xvfb did not open display :${display} in ${XVFB_WAIT_MS / 1000} s`); }
      this.xvfb = null; this.display = null;
      this.d.log(`unit: Xvfb exited on :${display} (code ${proc.code()})`);
      if (tries >= XVFB_TRIES) throw new StartError(`Xvfb exited on ${XVFB_TRIES} displays in a row`);
    }
    throw new StartError(`no free X display from :${first} to :${last}`);
  }

  /** The sysctl that takes unprivileged user namespaces away, as "<name> is <value>"; "" when none does. */
  usernsProblem(): string {
    for (const [rel, off] of USERNS_OFF) {
      const v = this.d.procs.sys(rel);
      if (v === off) return `${rel.replace(/\//g, ".")} is ${v}`;
    }
    return "";
  }

  private recordedChromium(): string | null {
    const r = this.readRecord();
    if (r.kind !== "ok") return null;
    if (!("chrome" in r.record)) return "/usr/bin/chromium"; // a record of agentwatch's step B
    const c = r.record.chrome as Record<string, unknown> | null;
    if (!c || c.kind !== KIND_CHROMIUM) return null;
    return typeof r.record.chrome_bin === "string" && r.record.chrome_bin ? r.record.chrome_bin : null;
  }

  private refusedVersions(): ReadonlySet<string> {
    try { return this.d.refused?.() ?? new Set(); } catch { return new Set(); }
  }

  /** What this start runs. */
  private plan(cfg: UnitConfig, fetch: boolean): Plan {
    // Each start sets its own staged package: a Chromium of chrome_bin has none (review-110b).
    this.staged = null;
    if (this.d.mac) {
      const app = this.d.mac.app(cfg.chromeBin, this.d.paths.profile);
      this.mac = app;
      return { binary: app.binary, kind: app.google ? KIND_GOOGLE : KIND_CHROMIUM, version: app.version, recordedBin: app.binary };
    }
    const chromium = (bin: string): Plan => {
      const found = this.d.which(bin);
      if (!found) throw new StartError(`Chromium not found: ${bin}`);
      return { binary: found, kind: KIND_CHROMIUM, version: "", recordedBin: found };
    };
    if (cfg.chromeBin) return chromium(cfg.chromeBin);
    const refused = this.refusedVersions();
    // The newest copy (never an install's return) whose move did not fail, not newer than `upto` (the way back).
    let copy: ChromeCopy | null = refused.size || this.upto !== null ? this.d.tools.newest(refused, this.upto) : this.d.tools.newest();
    if (!copy && this.upto !== null) copy = this.d.tools.newest(refused);
    if (copy) return this.preparePlan(copy, fetch);
    if (refused.size && this.d.tools.newest()) throw new StartError(chromeFailed("every Google Chrome copy in the tools folder failed to start after an update; the next check installs a newer release"));
    if (!fetch) {
      // The supervisor never installs: it keeps a recorded Chromium until a start installs Google Chrome.
      const recorded = this.recordedChromium();
      if (!recorded) throw new StartError(CHROME_NOT_INSTALLED);
      return chromium(recorded);
    }
    const why = this.d.tools.unsupported();
    if (why) throw new StartError(chromeFailed(why));
    if (this.chromeInstalling()) throw new StartError(CHROME_INSTALLING);
    throw new StartError(chromeFailed("the install left no copy in the tools folder"));
  }

  /**
   * A Google Chrome copy's plan: the agent package first (prepare), so Chrome installs it at its start. A start fails when
   * the package cannot be checked or its file written; the supervisor then starts the copy with the file of its last
   * start, and with no such file it starts the recorded Chromium, else it fails (agentwatch's _google_plan).
   */
  private preparePlan(copy: ChromeCopy, fetch: boolean): Plan {
    const plan: Plan = { binary: copy.binary, kind: KIND_GOOGLE, version: copy.version, recordedBin: copy.binary };
    const p = this.d.prepare;
    this.staged = null;
    if (!p) return plan;
    try { this.staged = p.run(copy); return plan; }
    catch (e) {
      // A file error's message holds a path of the tools folder: the log takes its code only (review-110 note 3).
      const code = (e as NodeJS.ErrnoException).code, reason = typeof code === "string" ? code : (e as Error).message || (e as Error).name;
      if (fetch) throw new StartError(chromeFailed(reason));
      const last = p.lastFile(copy);
      if (last === null) {
        const recorded = this.recordedChromium();
        if (!recorded) throw new StartError(chromeFailed(reason));
        this.d.log(`unit: could not write the agent package for Google Chrome ${copy.version} (${reason.slice(0, 200)}); starting the recorded Chromium again`);
        const found = this.d.which(recorded);
        if (!found) throw new StartError(`Chromium not found: ${recorded}`);
        return { binary: found, kind: KIND_CHROMIUM, version: "", recordedBin: found };
      }
      this.staged = last;
      this.d.log(`unit: could not write the agent package (${reason.slice(0, 200)}); Google Chrome starts with the package file of its last start`);
      return plan;
    }
  }

  /** The version of the agent package that the running Chrome's start staged, or null. */
  stagedPackage(): string | null { return this.running() ? this.staged : null; }

  /** The unit's own Xvfb while the unit runs: its display, its X auth file and its size (null while it is not known). */
  xDisplay(): { display: number; xauth: string; size: [number, number] | null } | null {
    if (!this.running() || this.display === null) return null;
    return { display: this.display, xauth: this.d.paths.xauth, size: this.displaySize ? [this.displaySize[0], this.displaySize[1]] : null };
  }

  chromeInstalling(): boolean { return this.installJob !== null && !this.installJob.done; }

  /** The last failed install's text while a start runs Google Chrome; "" otherwise. */
  chromeInstallFailed(): string {
    const j = this.installJob;
    if (!j || !j.done || !j.result || this.config?.chromeBin) return "";
    return chromeFailed(j.result);
  }

  private beginInstall(): { done: boolean; result: string } {
    const job = { done: false, result: "" };
    this.installJob = job; this.installSeen = false;
    this.d.log("unit: installing Google Chrome into the tools folder");
    this.d.tools.ensure().then(() => { job.done = true; this.d.log("unit: Google Chrome is installed"); }, (e) => {
      job.result = (e as Error).message || (e as Error).name; job.done = true;
      this.d.log(`unit: Google Chrome could not be installed: ${job.result.slice(0, 300)}`);
    });
    return job;
  }

  /**
   * Before a start takes the lock: when it runs Google Chrome and no copy is installed, begin the install (one at a
   * time) and wait for it up to CHROME_INSTALL_WAIT_MS, outside the lock (a stop never waits for an install).
   */
  private async awaitInstall(): Promise<boolean> {
    const { cfg } = this.checkedConfig();
    // The Mac runs the operator's own Google Chrome.app: the service installs no copy there.
    if (this.d.mac || cfg.chromeBin || this.running() || this.d.tools.newest()) return false;
    if (this.d.tools.unsupported()) return false; // plan() names the reason
    if (!this.d.which("Xvfb")) throw new StartError("Xvfb not found on PATH");
    const problem = this.usernsProblem();
    if (problem) throw new StartError(chromeFailed(`${SANDBOX_NEEDS_USERNS} (${problem})`));
    let job = this.installJob;
    if (job && job.done && !this.installSeen) {
      this.installSeen = true;
      if (job.result) throw new StartError(chromeFailed(job.result));
    }
    if (!job || job.done) job = this.beginInstall();
    const end = this.clock() + CHROME_INSTALL_WAIT_MS;
    while (!job.done) {
      if (this.clock() >= end) throw new StartError(CHROME_INSTALLING);
      await this.sleep(CHROME_INSTALL_POLL_MS);
    }
    this.installSeen = true;
    if (job.result) throw new StartError(chromeFailed(job.result));
    return true;
  }

  /**
   * The profile's Preferences before each Chrome start: the downloads' folder; and for the stored sign-ins (C11, the
   * sign-in act; the design, sections 7.3 and 4.3 T17): no password saving, no leak check, no autofill, and the receiver
   * allowed in incognito (`extensions.settings.<receiver ID>.incognito`), so that it can open the act window. And the
   * receiver's access to local files (`newAllowFileAccess`, chrome://extensions' "Allow access to file URLs"; C12, the
   * agent package; board ab-t30.27): without it Chrome answers the receiver's `DOM.setFileInputFiles` (chrome.debugger)
   * with "Not allowed", so the input stage's file chooser and a client's paths fail. Chrome gives a packed extension
   * (the CRX from the external extensions file) none by default; an unpacked one (the relay's, the Mac's) gets it. No
   * Chrome runs on the profile here (the sweep of startLocked), and the file is replaced whole (writeJsonDurable).
   */
  private writeDownloadPrefs(): void {
    const p = this.d.paths.preferences;
    let prefs: unknown = {};
    try { prefs = JSON.parse(readFileSync(p, "utf8")); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") prefs = null; }
    if (prefs === null || typeof prefs !== "object" || Array.isArray(prefs)) { this.d.log("unit: the Preferences file is not a JSON object; downloads keep Chrome's own folder, the sign-in act has no private window, and the receiver has no access to local files"); return; }
    const o = agentPrefs(prefs as Record<string, any>, this.d.paths.downloads);
    this.privateDir(join(this.d.paths.profile, "Default"));
    writeJsonDurable(p, o);
  }

  /** The step right before a start of Chrome (UnitDeps.beforeChrome; board ab-v16.118): it never fails the start. */
  private beforeChrome(version: string): void {
    try { this.d.beforeChrome?.(version); } catch {}
  }

  /**
   * The argv and the environment of a Chrome start on `profile`, with `home` as its HOME: the main Chrome's (the agent
   * profile, the state folder's home) and the blanket Chrome's (board ab-4wh.3: its own folder), with the same flags.
   */
  private chromeLaunch(binary: string, google: boolean, cfg: UnitConfig, width: number, height: number, display: number, profile: string, home: string): { argv: string[]; env: Record<string, string> } {
    const env = this.baseEnv();
    env.DISPLAY = `:${display}`;
    env.XAUTHORITY = this.d.paths.xauth;
    env.HOME = home; // its downloads stay in the state folder
    if (cfg.timezone) env.TZ = cfg.timezone;
    // Google's own wrapper exports it; without it a branded Linux Chrome reports its channel as "unknown".
    if (google) env.CHROME_VERSION_EXTRA = "stable";
    // --password-store=basic: Chromium and Google Chrome then keep the sign-ins of the profile across a move.
    const argv = [binary, `--user-data-dir=${profile}`, ...AGENT_ARGS, "--password-store=basic",
      "--silent-debugger-extension-api", "--enable-unsafe-swiftshader", `--lang=${cfg.lang}`, "--window-position=0,0",
      `--window-size=${width},${height}`, ...cfg.chromeArgs, "about:blank"];
    return { argv, env };
  }

  /**
   * The blanket Chrome's start (board ab-4wh.3; C12, the blanket profile): the running Chrome's own binary (the same
   * Google Chrome copy, whose external extensions file installs the receiver in every profile), its display and X auth
   * file, and the same flags (AGENT_ARGS and the checked chrome_args), with `profile` as the user-data-dir and `home` as
   * HOME. Null while the unit does not run, on the Mac, or with a config that a start would refuse. It writes nothing.
   */
  blanketLaunch(profile: string, home: string): { argv: string[]; env: Record<string, string>; version: string; google: boolean } | null {
    if (this.d.mac || !this.running() || this.display === null || !this.chromeInfo || !this.chromeBin) return null;
    let checked: { cfg: UnitConfig; width: number; height: number };
    try { checked = this.checkedConfig(); } catch { return null; }
    const size = this.displaySize ?? [checked.width, checked.height];
    const google = this.chromeInfo.kind === KIND_GOOGLE;
    return { ...this.chromeLaunch(this.chromeBin, google, checked.cfg, size[0], size[1], this.display, profile, home), version: this.chromeInfo.version, google };
  }

  private async startChrome(plan: Plan, cfg: UnitConfig, width: number, height: number, display: number): Promise<Child> {
    const google = plan.kind === KIND_GOOGLE;
    const { argv, env } = this.chromeLaunch(plan.binary, google, cfg, width, height, display, this.d.paths.profile, this.d.paths.home);
    try {
      this.privateDir(this.d.paths.home);
      this.privateDir(this.d.paths.downloads);
      this.writeDownloadPrefs();
    } catch (e) { throw new StartError(`could not make the downloads folder: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`); }
    this.beforeChrome(plan.version);
    let proc: Spawned;
    try { proc = this.spawn(argv, env); }
    catch (e) {
      const why = (e as NodeJS.ErrnoException).code ?? (e as Error).message;
      throw new StartError(google ? chromeFailed(`it could not start: ${why}`) : `could not start Chromium: ${why}`);
    }
    const child: Child = { pid: proc.pid, start: this.d.procs.stat(proc.pid)?.start ?? null, proc, startedAt: this.clock() };
    this.chrome = child;
    const end = this.clock() + CHROME_SETTLE_MS;
    while (this.aliveChild(child) && this.clock() < end) await this.sleep(SETTLE_POLL_MS);
    if (!this.aliveChild(child)) {
      this.chrome = null;
      if (google) {
        const problem = this.usernsProblem();
        throw new StartError(chromeFailed(problem ? `it exited at start (exit ${proc.code()}): ${SANDBOX_NEEDS_USERNS} (${problem})` : `it exited at start (exit ${proc.code()})`));
      }
      throw new StartError(`Chromium exited at start (exit ${proc.code()})`);
    }
    if (child.start === null) child.start = this.d.procs.stat(child.pid)?.start ?? null;
    this.chromeInfo = { kind: plan.kind, version: plan.version };
    this.chromeBin = plan.recordedBin;
    this.d.log(`unit: ${google ? `Google Chrome ${plan.version}` : "Chromium"} started on :${display} (pid ${child.pid})`);
    return child;
  }

  /**
   * The Mac: the give-back guard, then `open -n -g -a <app> --args ...` on the agent profile, then the new Chrome's main
   * process: the one Chrome on the profile (a child of launchd), found within MAC_FIND_MS. No Xvfb, no X pointer, no
   * staged CRX (the operator loads the agent package's folder unpacked once per agent profile; the unit writes that
   * folder first), and no environment of the service: Launch Services starts the app with the user's own.
   */
  private async startMacChrome(mac: MacStart, plan: Plan, cfg: UnitConfig, width: number, height: number): Promise<Child> {
    const app = this.mac!;
    const name = plan.kind === KIND_GOOGLE ? "Google Chrome" : app.bundle;
    const args = [`--user-data-dir=${this.d.paths.profile}`, ...AGENT_ARGS, "--silent-debugger-extension-api", `--lang=${cfg.lang}`,
      "--window-position=0,0", `--window-size=${width},${height}`, ...cfg.chromeArgs, "about:blank"];
    try {
      this.privateDir(this.d.paths.home);
      this.privateDir(this.d.paths.downloads);
      this.writeDownloadPrefs();
    } catch (e) { throw new StartError(`could not make the downloads folder: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`); }
    // The agent package's folder for the operator's "Load unpacked" (board ab-v16.94.19): checked, and written when it
    // differs from the pin, while no agent Chrome runs (the sweep above stopped each one on the profile).
    if (mac.agentPackage) {
      try {
        const p = mac.agentPackage();
        if (p.written) this.d.log(`unit: the agent package ${p.version} is now in ${p.folder}; the agent Chrome loads it from there after the operator's one-time "Load unpacked" of that folder`);
        for (const l of p.left ?? []) this.d.log(`unit: a folder of the agent package's swap could not be removed: ${l}; the next start tries again`);
      } catch (e) {
        // A file error's message holds a path: the start's text takes its code only (as on Linux).
        const code = (e as NodeJS.ErrnoException).code;
        throw new StartError(`the agent package could not be written for ${name}: ${typeof code === "string" ? code : (e as Error).message}`);
      }
    }
    this.beforeChrome(plan.version);
    const guard = await mac.guard(app.bundle).catch(() => null);
    let child: Child | null = null;
    try {
      const code = await mac.open(app.bundle, args);
      if (code !== 0) throw new StartError(`${name} could not start: open exited ${code === null ? "with no code" : `with ${code}`}`);
      const end = this.clock() + MAC_FIND_MS;
      for (;;) {
        const found = this.macMains();
        if (found.length > 1) throw new StartError(`${found.length} Chromes run on the agent profile after the start`);
        if (found.length === 1) {
          // The main process runs the app's own binary (review-145 N5): a process of this user with the profile argument is no agent Chrome.
          if (!this.runsBundle(found[0], app.bundle)) throw new StartError(`the process on the agent profile (pid ${found[0]}) does not run ${app.bundle}`);
          child = { pid: found[0], start: this.d.procs.stat(found[0])?.start ?? null, proc: null, startedAt: this.clock() };
          break;
        }
        if (this.clock() >= end) throw new StartError(`${name} did not come up on the agent profile within ${MAC_FIND_MS / 1000} s after open`);
        await this.sleep(SETTLE_POLL_MS);
      }
      this.chrome = child;
      const settle = this.clock() + CHROME_SETTLE_MS;
      while (this.aliveChild(child) && this.clock() < settle) await this.sleep(SETTLE_POLL_MS);
      if (!this.aliveChild(child)) { this.chrome = null; child = null; throw new StartError(`${name} exited at start`); }
    } finally {
      // The guard watches the start's first window and a session restore's second take, then ends (the watcher goes on).
      void guard?.finish(child ? MAC_GUARD_AFTER_MS : 0);
    }
    if (child.start === null) child.start = this.d.procs.stat(child.pid)?.start ?? null;
    this.chromeInfo = { kind: plan.kind, version: plan.version };
    this.chromeBin = plan.recordedBin;
    this.d.log(`unit: ${name} ${plan.version} started through open -n -g (pid ${child.pid})`);
    return child;
  }

  /** Bring the unit up; true when it started anything. The caller holds the lock. */
  private async startLocked(fetch: boolean): Promise<boolean> {
    const { cfg, width, height } = this.checkedConfig();
    if (this.running()) return false;
    const xvfbBin = this.d.mac ? "" : this.d.which("Xvfb");
    if (xvfbBin === null) throw new StartError("Xvfb not found on PATH");
    const plan = this.plan(cfg, fetch);
    try { this.privateDir(this.d.paths.state); this.privateDir(this.d.paths.profile); }
    catch (e) { throw new StartError(`could not make the browser's folders: ${(e as Error).message}`); }
    // The owner rule, right before the start (the design, section 13.2).
    if (this.d.mayAct && !(await this.d.mayAct("a Chrome start"))) throw new NotOwnerError("the service no longer owns the Chrome unit");
    this.starting = true;
    try {
      // A Chrome on a display that is gone: stop it; both start again. That Chrome, or one that is gone (a crash that the
      // supervisor's check did not see yet: a start op, startWanted, a way back), sends `gone` before the new Chrome
      // starts, so the part drops its link at once, not at its shim's late end (review-149 note 1, board ab-b84.37).
      const last = this.chrome;
      if (last) {
        const name = this.chromeInfo?.kind === KIND_GOOGLE ? "Google Chrome" : "Chromium";
        if (this.aliveChild(last) && !this.aliveChild(this.xvfb)) {
          this.d.log(`unit: the display of ${name} (pid ${last.pid}) is gone; stopping it`);
          await this.stopChild(last, this.chromeMarkers());
        } else this.d.log(`unit: ${name} (pid ${last.pid}) is gone; this start starts it again`);
      }
      this.chrome = null; this.chromeInfo = null;
      if (last) { try { this.d.gone?.(); } catch {} }
      // Nothing of an earlier unit may hold the display auth or the profile (a Chrome there would take the start's arguments and exit).
      await this.stopLeftovers();
      await this.stopOrphanChromes();
      let spawnedXvfb = false;
      let display = this.display;
      if (this.d.mac) display = null;
      else if (display === null || !this.aliveChild(this.xvfb)) {
        this.xvfb = null; this.display = null;
        display = await this.startXvfb(xvfbBin, width, height);
        spawnedXvfb = true;
      }
      let chrome: Child;
      try { chrome = this.d.mac ? await this.startMacChrome(this.d.mac, plan, cfg, width, height) : await this.startChrome(plan, cfg, width, height, display!); }
      catch (e) { if (spawnedXvfb) await this.stopXvfb(); throw e; }
      this.wantedFlag = true;
      this.writeRecord({
        wanted: true, display, display_size: this.displaySize, xvfb_pid: this.xvfb?.pid ?? null, xvfb_start: this.xvfb?.start ?? null,
        chrome_pid: chrome.pid, chrome_start: chrome.start, receiver: null, chrome: { kind: plan.kind, version: plan.version }, chrome_bin: plan.recordedBin,
        started_at: (this.d.wall ?? Date.now)() / 1000,
      });
      return true;
    } finally { this.starting = false; }
  }

  /**
   * Start the unit (idempotent). `upto`: run the newest Google Chrome copy not newer than it (the way back after a
   * failed move); the supervisor's restarts keep that choice until the next start. Throws a StartError (its text is
   * the start's answer), a ConfigError, or NotOwnerError.
   */
  async start(o: { upto?: string | null } = {}): Promise<boolean> {
    if (this.halted) throw new StartError("the agent-browser service stops");
    const stops = this.stops;
    this.starting = true;
    try {
      const waited = await this.awaitInstall();
      return await this.lock.run(async () => {
        if (waited && this.stops !== stops && !this.running()) throw new StartError(STOPPED_DURING_INSTALL);
        if (!this.running()) this.upto = o.upto ?? null;
        return this.startLocked(true);
      });
    } finally { this.starting = false; }
  }

  /** Stop Chrome, then Xvfb, every leftover and every Chrome on the profile; record `wanted: false`. True when one ran. */
  async stop(): Promise<boolean> {
    this.stops++;
    return this.lock.run(async () => {
      this.wantedFlag = false;
      this.resetStreak();
      const chrome = this.chrome;
      this.chrome = null; this.chromeInfo = null;
      let stopped = await this.stopChild(chrome, this.chromeMarkers());
      stopped = (await this.stopXvfb()) || stopped;
      stopped = (await this.stopLeftovers()) || stopped;
      stopped = (await this.stopOrphanChromes()) || stopped;
      const r = this.readRecord();
      this.writeRecord({ ...(r.kind === "ok" ? r.record : {}), wanted: false });
      this.d.log(stopped ? "unit: stopped" : "unit: nothing was running");
      return stopped;
    });
  }

  /** The boot sweep: stop every Chrome on the unit's profile that the unit does not hold (never on a record that cannot be read). */
  async stopOrphans(): Promise<boolean> { return this.lock.run(() => this.stopOrphanChromes()); }

  // ------------------------------------------------------------------ the status

  chromePid(): number | null { return this.chrome && this.aliveChild(this.chrome) ? this.chrome.pid : null; }
  /** The live Chrome's pid and start time (the watch counts for this Chrome only). */
  chromeId(): { pid: number; start: number | null } | null { return this.chrome && this.aliveChild(this.chrome) ? { pid: this.chrome.pid, start: this.chrome.start } : null; }
  /** The running Chrome's kind and version; null while none runs. */
  chromeFacts(): { kind: string; version: string } | null { return this.running() && this.chromeInfo ? { ...this.chromeInfo } : null; }
  /** The running unit's display. */
  runningDisplay(): number | null { return this.running() ? this.display : null; }
  /** The kind that a start runs while none runs. */
  idleKind(): string { return this.config?.chromeBin ? KIND_CHROMIUM : KIND_GOOGLE; }

  // ------------------------------------------------------------------ the adoption

  /**
   * Take over the Xvfb and the Chrome of the unit record at the service's start (only what the record names). Adopts
   * when the record says `wanted` and both recorded processes are alive, this user's, carry the unit's markers and
   * (when the record has them) their recorded start times. When it does not adopt, a live Xvfb of the record gets
   * SIGTERM (a start or a stop finishes it). An unreadable record: the Chrome on the profile and the Xvfb with the X
   * auth file in the process table, when exactly one of each runs (no boot sweep then). The result says what came.
   */
  adopt(): { adopted: boolean; wanted: boolean; unreadable: string | null } {
    if (this.chrome || this.xvfb) return { adopted: false, wanted: this.wantedFlag, unreadable: null };
    const r = this.readRecord();
    if (r.kind === "none") { this.d.log("unit: no unit record; nothing adopted"); return { adopted: false, wanted: false, unreadable: null }; }
    if (r.kind === "unreadable") return { adopted: this.adoptByProfile(r.why), wanted: this.wantedFlag, unreadable: r.why };
    const rec = r.record;
    const display = intOf(rec.display), xvfbPid = intOf(rec.xvfb_pid), chromePid = intOf(rec.chrome_pid);
    const xvfbStart = intOf(rec.xvfb_start), chromeStart = intOf(rec.chrome_start);
    let xvfb: Child | null = null, chrome: Child | null = null;
    if (display !== null && display >= 0 && xvfbPid !== null && xvfbPid > 1) {
      const c: Child = { pid: xvfbPid, start: xvfbStart, proc: null, startedAt: null };
      if (this.aliveChild(c) && this.isOurs(c, this.xvfbMarkers(display)) && this.d.procs.programIs(xvfbPid, "Xvfb")) xvfb = c;
    }
    if (chromePid !== null && chromePid > 1) {
      const c: Child = { pid: chromePid, start: chromeStart, proc: null, startedAt: null };
      if (this.aliveChild(c) && this.isOurs(c, this.chromeMarkers())) chrome = c;
    }
    const wanted = rec.wanted === true;
    if (wanted && chrome && (this.d.mac ? this.adoptMac(rec) : display !== null && xvfb)) {
      if (xvfb) xvfb.start ??= this.d.procs.stat(xvfb.pid)?.start ?? null;
      chrome.start ??= this.d.procs.stat(chrome.pid)?.start ?? null;
      this.xvfb = this.d.mac ? null : xvfb; this.chrome = chrome; this.display = this.d.mac ? null : display;
      const size = rec.display_size;
      this.displaySize = Array.isArray(size) && size.length === 2 && size.every((n) => Number.isSafeInteger(n) && n >= 1) ? [size[0], size[1]] : null;
      const c = rec.chrome as Record<string, unknown> | undefined;
      this.chromeInfo = c && (c.kind === KIND_GOOGLE || c.kind === KIND_CHROMIUM) ? { kind: c.kind as string, version: typeof c.version === "string" ? c.version : "" } : { kind: KIND_CHROMIUM, version: "" };
      this.chromeBin = typeof rec.chrome_bin === "string" ? rec.chrome_bin : "";
      this.wantedFlag = true;
      // The start times that a record of agentwatch's daemon lacks.
      if ((xvfb && xvfbStart === null) || chromeStart === null) this.writeRecord({ ...rec, xvfb_start: xvfb?.start ?? null, chrome_start: chrome.start });
      this.d.log(`unit: adopted ${xvfb && !this.d.mac ? `Xvfb :${display} (pid ${xvfb.pid}) and ` : ""}${this.chromeInfo.kind === KIND_GOOGLE ? "Google Chrome" : "Chromium"} (pid ${chrome.pid})`);
      return { adopted: true, wanted: true, unreadable: null };
    }
    this.wantedFlag = wanted;
    if (xvfb && display !== null) {
      const markers = this.xvfbMarkers(display);
      this.d.log(`unit: stopping Xvfb :${display} (pid ${xvfb.pid}): no unit holds it`);
      this.signal(xvfb, markers, "SIGTERM");
      this.leftovers.push({ child: xvfb, markers });
    } else this.d.log("unit: the unit record names no live process of the unit; nothing adopted");
    return { adopted: false, wanted, unreadable: null };
  }

  /**
   * The kind, version and binary of a Chrome that no readable record names, from its program (argv[0], else the exe
   * link): a copy of the tools folder (<tools>/google-chrome/<version>/opt/google/chrome/chrome) is Google Chrome of that
   * version, any other program Chromium.
   */
  private programOf(pid: number): { kind: string; version: string; binary: string } {
    const argv0 = this.d.procs.cmdline(pid)[0] ?? "", exe = this.d.procs.exe(pid) ?? "";
    for (const binary of [argv0, exe]) {
      const parts = binary ? relative(this.d.paths.chromes, binary).split(sep) : [];
      if (parts.length > 1 && VERSION_RE.test(parts[0]) && parts.slice(1).join(sep) === BINARY_REL) return { kind: KIND_GOOGLE, version: parts[0], binary };
    }
    return { kind: KIND_CHROMIUM, version: "", binary: argv0 || exe };
  }

  /** The adoption of an unreadable record: the one Chrome root on the profile and the one Xvfb with the X auth file. */
  private adoptByProfile(why: string): boolean {
    if (this.d.mac) return this.adoptMacByProfile(this.macMains(), why);
    const chromes = this.orphanChromes(new Set());
    const xvfbs = this.d.procs.pids().filter((p) => this.d.procs.holds(p, [this.d.paths.xauth]) && this.d.procs.programIs(p, "Xvfb"));
    if (chromes.length !== 1 || xvfbs.length !== 1) {
      this.d.log(`unit: the unit record cannot be read (${why}); ${chromes.length} Chrome and ${xvfbs.length} Xvfb of the unit run, so nothing is adopted and no orphan is stopped`);
      return false;
    }
    const display = this.d.procs.cmdline(xvfbs[0]).map((a) => /^:([0-9]{1,5})$/.exec(a)?.[1]).find((x) => x !== undefined);
    if (display === undefined) return false;
    this.xvfb = { pid: xvfbs[0], start: this.d.procs.stat(xvfbs[0])?.start ?? null, proc: null, startedAt: null };
    this.chrome = { pid: chromes[0], start: this.d.procs.stat(chromes[0])?.start ?? null, proc: null, startedAt: null };
    this.display = Number(display);
    const program = this.programOf(chromes[0]);
    this.chromeInfo = { kind: program.kind, version: program.version };
    this.chromeBin = program.binary;
    this.wantedFlag = true;
    this.writeRecord({ wanted: true, display: this.display, display_size: null, xvfb_pid: this.xvfb.pid, xvfb_start: this.xvfb.start, chrome_pid: this.chrome.pid, chrome_start: this.chrome.start, receiver: null, chrome: { ...this.chromeInfo }, chrome_bin: program.binary, started_at: (this.d.wall ?? Date.now)() / 1000 });
    this.d.log(`unit: the unit record cannot be read (${why}); adopted the Chrome on the profile (pid ${this.chrome.pid}) and Xvfb :${this.display} (pid ${this.xvfb.pid})`);
    return true;
  }

  /**
   * The Mac: the main processes on the agent profile, the roots of orphanChromes with no `--type=` argument (review-145 N5):
   * a helper or a crash handler that launchd adopted, with the profile argument, is no second Chrome. The sweep before a
   * start (stopOrphanChromes) still stops such a helper, as on Linux.
   */
  private macMains(): number[] { return this.orphanChromes(new Set()).filter((pid) => !this.d.procs.cmdline(pid).some((a) => a.startsWith("--type="))); }

  /**
   * The Mac: `pid` runs the app's own binary: its executable (proc_pidpath, the kernel's path after links) is inside the
   * bundle, as given or after links (review-145 N5; review-145b N1: a `chrome_bin` through a link).
   */
  private runsBundle(pid: number, bundle: string): boolean {
    const exe = this.d.procs.exe(pid);
    return exe !== null && [bundle, realOf(bundle)].some((b) => exe.startsWith(`${b}/`));
  }

  /** The Mac: the app of an adopted Chrome, from its record; false when the record names no app's binary. */
  private adoptMac(rec: Record<string, unknown>): boolean {
    const binary = typeof rec.chrome_bin === "string" ? rec.chrome_bin : "";
    const bundle = appBundle(binary);
    if (!bundle) return false;
    const c = rec.chrome as Record<string, unknown> | undefined;
    this.mac = { binary, bundle, version: typeof c?.version === "string" ? c.version : "", google: c?.kind === KIND_GOOGLE };
    return true;
  }

  /**
   * The Mac's adoption of an unreadable record: the one Chrome root on the profile, when it runs an app's binary: its
   * argv[0] names the binary, and its executable is inside that app (review-145b N2: the start's check).
   */
  private adoptMacByProfile(chromes: number[], why: string): boolean {
    const binary = chromes.length === 1 ? this.d.procs.cmdline(chromes[0])[0] ?? "" : "";
    const bundle = appBundle(binary);
    if (chromes.length !== 1 || !bundle || !this.runsBundle(chromes[0], bundle)) {
      this.d.log(`unit: the unit record cannot be read (${why}); ${chromes.length} Chrome of the unit run${chromes.length === 1 ? ", not from an app" : ""}, so nothing is adopted and no orphan is stopped`);
      return false;
    }
    const google = binary === CHROME_STABLE_BIN;
    this.chrome = { pid: chromes[0], start: this.d.procs.stat(chromes[0])?.start ?? null, proc: null, startedAt: null };
    this.mac = { binary, bundle, version: "", google };
    this.chromeInfo = { kind: google ? KIND_GOOGLE : KIND_CHROMIUM, version: "" };
    this.chromeBin = binary;
    this.wantedFlag = true;
    this.writeRecord({ wanted: true, display: null, display_size: null, xvfb_pid: null, xvfb_start: null, chrome_pid: this.chrome.pid, chrome_start: this.chrome.start, receiver: null, chrome: { ...this.chromeInfo }, chrome_bin: binary, started_at: (this.d.wall ?? Date.now)() / 1000 });
    this.d.log(`unit: the unit record cannot be read (${why}); adopted the Chrome on the profile (pid ${this.chrome.pid})`);
    return true;
  }

  // ------------------------------------------------------------------ the supervisor

  private resetStreak(): void { this.backoff = BACKOFF_MIN_MS; this.failures = 0; this.reported = false; this.lastFailure = ""; }
  private noteFailure(reason: string): void { this.failures++; this.lastFailure = reason.slice(0, 200); }
  private report(on: (e: UnitEvent) => void): void {
    if (this.failures < FAILURES_TO_REPORT || this.reported) return;
    this.reported = true;
    this.d.log(`unit: ${this.failures} failed starts in a row: ${this.lastFailure}`);
    try { on({ kind: "start_failed", reason: this.lastFailure }); } catch {}
  }

  /** One check of the supervisor: a wanted Chrome that is gone starts again after the backoff. */
  async superviseOnce(on: (e: UnitEvent) => void): Promise<void> {
    // Before the first config the unit starts nothing (build note 8): the part starts a wanted Chrome at that config.
    if (!this.wantedFlag || !this.config) return;
    const now = this.clock();
    const chrome = this.chrome;
    if (this.running()) {
      if (chrome && (chrome.startedAt === null || now - chrome.startedAt >= HEALTHY_MS)) this.resetStreak();
      return;
    }
    if (this.lock.locked) return; // a start or a stop runs: it decides
    if (chrome && !this.aliveChild(chrome)) {
      this.chrome = null;
      const name = this.chromeInfo?.kind === KIND_GOOGLE ? "Google Chrome" : "Chromium";
      const lived = chrome.startedAt === null ? null : now - chrome.startedAt;
      if (lived !== null && lived < HEALTHY_MS) this.noteFailure(`${name} exited ${Math.round(lived / 1000)} s after its start`);
      else this.resetStreak();
      this.d.log(`unit: ${name} (pid ${chrome.pid}) is gone; starting it again in ${Math.round(this.backoff / 1000)} s`);
      // At once, before the backoff: no start runs (the lock is free), so the link that the part drops is the gone Chrome's.
      try { on({ kind: "gone" }); } catch {}
    }
    this.report(on);
    await (this.d.nap ?? this.sleep)(this.backoff);
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
    let started = false;
    await this.lock.run(async () => {
      if (this.halted || !this.wantedFlag || this.running()) return;
      try { started = await this.startLocked(false); }
      catch (e) {
        if (e instanceof NotOwnerError) throw e;
        this.noteFailure(e instanceof StartError ? e.message : `unexpected error: ${(e as Error).name}`);
        this.d.log(`unit: start again failed: ${(e as Error).message}`);
      }
    });
    if (started) on({ kind: "ready" });
    this.report(on);
  }
}

