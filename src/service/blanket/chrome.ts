// The blanket Chrome (board ab-4wh.3; C12, the blanket profile; the design
// docs/superpowers/specs/2026-11-25-blanket-profile-design.md, section 4.1): a second agent Chrome for the one local scope
// with the operator's blanket approval, on its own empty folder.
//
// - The folder: `<state>/blanket/`, with the user-data-dir `profile/` and the HOME `home/` (its downloads). It is made
//   new and empty (mode 0700) at the blanket scope's first start; a start after a stop by use (or another stop of the
//   unit) of the same scope reuses it, so the session's cookies live for the session's life. It goes at the scope's end,
//   at the daemon's `stop`, at `enabled: false` and at the service's start (so a crash leaves nothing for the next run).
//   No act follows a symbolic link: a link at `<state>/blanket` is removed as a link, and its target stays.
// - The process: the same Chrome copy as the main Chrome, with the same flags, on the unit's display (the unit gives the
//   argv and the environment: unit.ts, blanketLaunch), with `--user-data-dir=<state>/blanket/profile`. The receiver
//   comes from the copy's external extensions file (package/crx.ts), which Chrome reads for every profile. The native
//   host manifest in `<profile>/NativeMessagingHosts/` names the wrapper `agent-browser-host-blanket`, which gives the
//   shim the blanket link's socket and the blanket profile (link/manifest.ts). The service holds the process by pid and
//   start time in memory; it adopts none, and no supervisor starts it again after a crash (the next use starts it).
// - The service's start stops each Chrome on the blanket profile (by its whole `--user-data-dir=` argument) and deletes
//   the folder.
// - The address proxy (board ab-4wh.6; proxy.ts; C11, the blanket profile): the blanket Chrome reaches the network only
//   through it. It starts right before the Chrome (its flags go into the Chrome's argv, before the config's chrome_args)
//   and stops after the Chrome's stop, its end or a failed start, and at most WATCH_MS after the Chrome exits by itself.
//   A config whose chrome_args hold a switch of the proxy, of WebRTC's UDP or of an unpacked extension (proxy.ts,
//   PROXY_SWITCHES) fails the start.
// - The Mac (board ab-4wh.16; C12, the blanket profile on the Mac; `mac`): the operator's Google Chrome.app through
//   `open -n -g` (the unit's MacStart), with the agent Chrome's flags on the Mac and the address proxy's. Its folder is
//   made new as on Linux, and then the blanket template's two preference files are copied into it (template.ts): they
//   hold the operator's one Load unpacked of `<state>/agent-package-blanket`, which the start writes first. The start
//   finds the new main process on the blanket profile (a child of launchd), checks that its arguments hold each flag of
//   this start's address proxy exactly (else it stops that process and fails), and holds it by pid and start time. The
//   give-back guard runs around the start, and a give-back watcher runs while it runs.

import { chmodSync, closeSync, constants, lstatSync, mkdirSync, openSync, rmSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { errorKind } from "../lists/files.ts";
import { wrapperPath } from "../link/manifest.ts";
import { proxyFlags, proxySwitchRefusal } from "./proxy.ts";
import type { Procs } from "../unit/procs.ts";
import { agentPrefs, CHROME_SETTLE_MS, KILL_WAIT_MS, signalGroup, spawnDetached, TERM_GRACE_MS, type Spawn, type Spawned } from "../unit/unit.ts";
import { findMacMain, holdsFlags } from "./mac-start.ts";

/** The folders and files of the blanket Chrome (C12, the blanket profile). */
export type BlanketPaths = {
  /** `<state>/blanket`: the one folder that holds everything of the blanket Chrome. */
  root: string;
  /** Its user-data-dir. */
  profile: string;
  /** Its HOME, with its downloads. */
  home: string;
  downloads: string;
  preferences: string;
  /** `<state>/agent-browser-host-blanket`: the wrapper that the blanket profile's host manifest names. */
  wrapper: string;
  /** `link-blanket.sock`, in the folder of `link.sock`. */
  socket: string;
};

/** `<state>/blanket` and its user-data-dir (also for `service stop --all`, which has no link socket). */
export function blanketFolders(state: string): { root: string; profile: string } {
  const root = join(state, "blanket");
  return { root, profile: join(root, "profile") };
}

/**
 * Delete `root` (`<state>/blanket`) and everything in it, with no link followed: a symbolic link there is removed as a
 * link (its target stays), a folder is removed with rm's own rule (it never follows a link inside). True when nothing is
 * there now.
 */
export function removeBlanketFolder(root: string, log: (line: string) => void): boolean {
  let st;
  try { st = lstatSync(root); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return true;
    log(`blanket: the blanket folder cannot be read (${errorKind(e)})`);
    return false;
  }
  try {
    if (st.isDirectory()) rmSync(root, { recursive: true });
    else unlinkSync(root);
    return true;
  } catch (e) {
    log(`blanket: the blanket folder is not deleted (${errorKind(e)})`);
    return false;
  }
}

export function blanketPaths(state: string, linkSocket: string): BlanketPaths {
  const { root, profile } = blanketFolders(state), home = join(root, "home");
  return {
    root, profile, home, downloads: join(home, "Downloads"), preferences: join(profile, "Default", "Preferences"),
    wrapper: `${wrapperPath(state)}-blanket`, socket: join(dirname(linkSocket), "link-blanket.sock"),
  };
}

/**
 * The unit's start of a blanket Chrome (unit.ts, blanketLaunch) with `extra` (the address proxy's flags) before the
 * config's chrome_args, which it gives too; or null while the unit does not run.
 */
export type BlanketLaunch = (extra: readonly string[]) => { argv: string[]; env: Record<string, string>; version: string; google: boolean; chromeArgs: readonly string[] } | null;
/** The address proxy (proxy.ts, AddressProxy): its start gives its port. */
export type BlanketProxy = { start(): Promise<number>; stop(): Promise<void>; listening(): boolean };
/** How often the watch looks whether the blanket Chrome still runs, to stop its address proxy after an exit by itself. */
export const WATCH_MS = 2_000;

/** The reason of a Mac start whose blanket Chrome did not get every flag of its address proxy (C12). */
export const MAC_FLAGS_TEXT = "the blanket Chrome did not get its address proxy's flags";
/** The Mac: how long the give-back guard of a start still watches after the start found its Chrome (as the unit's). */
export const MAC_GUARD_AFTER_MS = 10_000;

/** The Mac's start of the blanket Chrome (board ab-4wh.16; C12, the blanket profile on the Mac). */
export type BlanketMac = {
  /** The app and the arguments of `open --args` for `profile` with `extra` (unit.ts, macBlanketLaunch); throws the start's error. */
  launch(profile: string, extra: readonly string[]): { app: { binary: string; bundle: string; version: string; google: boolean }; args: string[]; chromeArgs: readonly string[] } | null;
  /** `open -n -g -a <bundle> --args <args>` (the unit's MacStart): its exit code. */
  open(bundle: string, args: string[]): Promise<number | null>;
  /** The give-back guard of one start (the unit's MacStart). */
  guard?(bundle: string): Promise<{ finish(ms: number): Promise<void> }>;
  /** The blanket template (template.ts): its refusal of a start, and the copy of its two files. */
  template: { startRefusal(): string | null; copyInto(profile: string, downloads: string): void };
  /** Write `<state>/agent-package-blanket` (mac-chrome.ts, blanketPackage). */
  writePackage(): void;
  /** The give-back watcher of the running blanket Chrome (mac-chrome.ts, GiveBackWatcher). */
  watcher?: { tick(chrome: { pid: number; start: number | null } | null): void; stop(): void };
  /** Tests only: the wait for the new main process (mac-start.ts, MAC_FIND_MS). */
  findMs?: number;
};

export type BlanketChromeDeps = {
  paths: BlanketPaths;
  procs: Pick<Procs, "stat" | "holds" | "pids"> & Partial<Pick<Procs, "cmdline" | "exe">>;
  /** The Mac (board ab-4wh.16): the start through `open -n -g`; absent on Linux. */
  mac?: BlanketMac;
  launch: BlanketLaunch;
  /** The address proxy: the blanket Chrome never starts without it. */
  proxy: BlanketProxy;
  /** Tests only: the watch's period (WATCH_MS). */
  watchMs?: number;
  /** Write the blanket profile's host manifest and its wrapper (link/manifest.ts, writeHostFiles). */
  hostFiles: () => void;
  log: (line: string) => void;
  spawn?: Spawn;
  kill?: (pid: number, sig: NodeJS.Signals) => void;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

const POLL_MS = 50;

type Child = { pid: number; start: number | null; proc: Spawned | null };

export class BlanketChrome {
  readonly paths: BlanketPaths;
  private readonly d: BlanketChromeDeps;
  private readonly spawn: Spawn;
  private readonly kill: (pid: number, sig: NodeJS.Signals) => void;
  private readonly clock: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private child: Child | null = null;
  /** The scope whose folder `<state>/blanket` holds now (made new at its first start), or null. */
  private folderOf: string | null = null;
  /** The watch of the running blanket Chrome (its exit by itself stops the address proxy). */
  private watcher: ReturnType<typeof setInterval> | null = null;
  /** The Mac: the app of the last start (the version check of the blanket Chrome). */
  private app: { binary: string; bundle: string } | null = null;

  constructor(d: BlanketChromeDeps) {
    this.d = d;
    this.paths = d.paths;
    this.spawn = d.spawn ?? spawnDetached;
    this.kill = d.kill ?? signalGroup(d.procs as Procs);
    this.clock = d.clock ?? (() => performance.now());
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** The whole argument that names the blanket profile: the sweep and each signal check it. */
  private get marker(): string { return `--user-data-dir=${this.paths.profile}`; }

  private alive(c: Child | null): boolean {
    if (!c) return false;
    if (c.proc && c.proc.exited()) return false;
    const st = this.d.procs.stat(c.pid);
    return st !== null && (c.start === null || st.start === c.start);
  }

  /** The blanket Chrome runs (the one that this service started). */
  running(): boolean { return this.alive(this.child); }

  /** The running blanket Chrome's pid and start time (the blanket link's peer check), or null. */
  chromeId(): { pid: number; start: number | null } | null { return this.child && this.alive(this.child) ? { pid: this.child.pid, start: this.child.start } : null; }

  /** The Mac: the app of the running blanket Chrome, or null. */
  macApp(): { binary: string; bundle: string } | null { return this.d.mac && this.running() ? this.app : null; }

  // ------------------------------------------------------------------ the folder

  /**
   * Delete `<state>/blanket` and everything in it, with no link followed: a symbolic link there is removed as a link (its
   * target stays), a folder is removed with rm's own rule (it never follows a link inside). True when nothing is there now.
   */
  removeFolder(): boolean { return removeBlanketFolder(this.paths.root, this.d.log); }

  /**
   * Make `<state>/blanket` new and empty (mode 0700), with `profile/` and `home/Downloads/`, and the profile's
   * Preferences: the same as the agent profile's (unit.ts, agentPrefs). The state folder must be a real folder.
   */
  private makeFolder(): void {
    const state = dirname(this.paths.root);
    const st = lstatSync(state);
    if (!st.isDirectory()) throw new Error("the state folder is not a folder");
    if (!this.removeFolder()) throw new Error("the old blanket folder could not be deleted");
    // No `recursive`: each mkdir makes a new folder, and fails when something is there (a race, a link).
    for (const dir of [this.paths.root, this.paths.profile, join(this.paths.profile, "Default"), this.paths.home, this.paths.downloads]) {
      mkdirSync(dir, { mode: 0o700 });
      chmodSync(dir, 0o700);
    }
    // The Mac: the blanket template's two files hold the receiver's load; its Preferences gets the folder's keys (template.ts).
    if (this.d.mac) { this.d.mac.template.copyInto(this.paths.profile, this.paths.downloads); return; }
    const fd = openSync(this.paths.preferences, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeSync(fd, `${JSON.stringify(agentPrefs({}, this.paths.downloads))}\n`); } finally { closeSync(fd); }
  }

  /** The folder holds `scope`'s blanket Chrome (made at its first start, not deleted since). */
  folderFor(): string | null { return this.folderOf; }

  // ------------------------------------------------------------------ the process

  /**
   * Start the blanket Chrome for `scope` (idempotent while it runs). The folder is made new at the scope's first start,
   * and a later start of the same scope reuses it. Throws an Error whose message is the reason.
   */
  async start(scope: string): Promise<void> {
    if (this.running()) return;
    this.child = null;
    this.unwatch();
    // The proxy of an earlier blanket Chrome that exited by itself (before the watch saw it) stops first.
    await this.stopProxy();
    if (this.d.mac) return this.startMac(scope, this.d.mac);
    const pre = this.d.launch([]);
    if (!pre) throw new Error("the agent browser's Xvfb does not run");
    const refused = proxySwitchRefusal(pre.chromeArgs);
    if (refused) throw new Error(refused);
    // A Chrome on the blanket profile that this service does not hold (a leftover) would take the start's arguments and exit.
    await this.stopOthers();
    let exists = true;
    try { exists = lstatSync(this.paths.root).isDirectory(); } catch { exists = false; }
    if (this.folderOf !== scope || !exists) {
      try { this.makeFolder(); }
      catch (e) { this.folderOf = null; throw new Error(`the blanket folder could not be made (${errorKind(e)})`); }
      this.folderOf = scope;
      this.d.log(`blanket: a new empty blanket folder for the session ${scope}`);
    }
    try { this.d.hostFiles(); }
    catch (e) { throw new Error(`the blanket profile's native host files could not be written (${errorKind(e)})`); }
    // The address proxy, right before the Chrome: its port goes into the Chrome's flags.
    let port: number;
    try { port = await this.d.proxy.start(); }
    catch (e) { await this.stopProxy(); throw new Error(`the address proxy could not start (${errorKind(e)})`); }
    const launch = this.d.launch(proxyFlags(port));
    const late = launch ? proxySwitchRefusal(launch.chromeArgs) : null;
    if (!launch || late) { await this.stopProxy(); throw new Error(late ?? "the agent browser's Xvfb does not run"); }
    let proc: Spawned;
    try { proc = this.spawn(launch.argv, launch.env); }
    catch (e) { await this.stopProxy(); throw new Error(`Chrome could not start (${errorKind(e)})`); }
    const child: Child = { pid: proc.pid, start: this.d.procs.stat(proc.pid)?.start ?? null, proc };
    this.child = child;
    const end = this.clock() + CHROME_SETTLE_MS;
    while (this.alive(child) && this.clock() < end) await this.sleep(POLL_MS);
    if (!this.alive(child)) { this.child = null; await this.stopProxy(); throw new Error(`Chrome exited at start (exit ${proc.code()})`); }
    if (child.start === null) child.start = this.d.procs.stat(child.pid)?.start ?? null;
    this.watch(child);
    this.d.log(`blanket: ${launch.google ? `Google Chrome ${launch.version}` : "Chromium"} started on the blanket profile (pid ${child.pid})`);
  }

  /** The folder of `scope`: new at the scope's first start (or when it is gone), else reused. */
  private folderFor_(scope: string): void {
    let exists = true;
    try { exists = lstatSync(this.paths.root).isDirectory(); } catch { exists = false; }
    if (this.folderOf !== scope || !exists) {
      try { this.makeFolder(); }
      catch (e) {
        this.folderOf = null;
        // The template's reasons (no template, its set-up runs, a file that cannot be read) are the start's own.
        const m = (e as Error).message ?? "";
        throw new Error(m.startsWith("the blanket") ? m : `the blanket folder could not be made (${errorKind(e)})`);
      }
      this.folderOf = scope;
      this.d.log(`blanket: a new blanket folder for the session ${scope}, with a copy of the blanket template's preference files`);
    }
  }

  /**
   * The Mac's start (board ab-4wh.16): the template's check, the sweep, the folder (made new with the template's copy at
   * the scope's first start), the package folder, the host files, the address proxy, then `open -n -g`; the new main
   * process on the blanket profile, and the check of its arguments.
   */
  private async startMac(scope: string, mac: BlanketMac): Promise<void> {
    const plain = (e: unknown) => String((e as Error)?.message ?? e).replace(/[.\s]+$/, "");
    let pre;
    try { pre = mac.launch(this.paths.profile, []); } catch (e) { throw new Error(plain(e)); }
    if (!pre) throw new Error("the agent browser is not on the Mac");
    const refused = proxySwitchRefusal(pre.chromeArgs);
    if (refused) throw new Error(refused);
    const why = mac.template.startRefusal();
    if (why) throw new Error(why);
    await this.stopOthers();
    this.folderFor_(scope);
    try { mac.writePackage(); }
    catch (e) { throw new Error(`the folder agent-package-blanket could not be written (${errorKind(e)})`); }
    try { this.d.hostFiles(); }
    catch (e) { throw new Error(`the blanket profile's native host files could not be written (${errorKind(e)})`); }
    let port: number;
    try { port = await this.d.proxy.start(); }
    catch (e) { await this.stopProxy(); throw new Error(`the address proxy could not start (${errorKind(e)})`); }
    let launch;
    try { launch = mac.launch(this.paths.profile, proxyFlags(port)); }
    catch (e) { await this.stopProxy(); throw new Error(plain(e)); }
    const late = launch ? proxySwitchRefusal(launch.chromeArgs) : null;
    if (!launch || late) { await this.stopProxy(); throw new Error(late ?? "the agent browser is not on the Mac"); }
    const guard = mac.guard ? await mac.guard(launch.app.bundle).catch(() => null) : null;
    let child: Child | null = null;
    try {
      const code = await mac.open(launch.app.bundle, launch.args);
      if (code !== 0) throw new Error(`Chrome could not start: open exited ${code === null ? "with no code" : `with ${code}`}`);
      const procs = this.d.procs as Pick<Procs, "stat" | "holds" | "pids" | "cmdline" | "exe">;
      const found = await findMacMain({ procs, marker: this.marker, bundle: launch.app.bundle, what: "blanket profile", ms: mac.findMs, clock: this.clock, sleep: this.sleep });
      if ("error" in found) throw new Error(found.error);
      child = { pid: found.pid, start: found.start, proc: null };
      this.child = child;
      // The flags check: a Chrome that did not get this start's proxy flags (a lost argument, a leftover that took the
      // start) never runs as the blanket Chrome.
      if (!holdsFlags(procs.cmdline(child.pid), proxyFlags(port))) {
        this.d.log(`blanket: the blanket Chrome (pid ${child.pid}) did not get its address proxy's flags; it stops`);
        await this.stopChild(child);
        this.child = null; child = null;
        throw new Error(MAC_FLAGS_TEXT);
      }
      const end = this.clock() + CHROME_SETTLE_MS;
      while (this.alive(child) && this.clock() < end) await this.sleep(POLL_MS);
      if (!this.alive(child)) { this.child = null; child = null; throw new Error("Chrome exited at start"); }
    } catch (e) {
      await this.stopProxy();
      throw e;
    } finally {
      void guard?.finish(child ? MAC_GUARD_AFTER_MS : 0);
    }
    if (child.start === null) child.start = this.d.procs.stat(child.pid)?.start ?? null;
    this.app = { binary: launch.app.binary, bundle: launch.app.bundle };
    this.watch(child);
    mac.watcher?.tick({ pid: child.pid, start: child.start });
    this.d.log(`blanket: ${launch.app.google ? `Google Chrome ${launch.app.version}` : launch.app.bundle} started on the blanket profile through open -n -g (pid ${child.pid})`);
  }

  /** Stop the address proxy (no error leaves this call). */
  private async stopProxy(): Promise<void> {
    try { await this.d.proxy.stop(); } catch (e) { this.d.log(`blanket: the address proxy did not stop cleanly (${errorKind(e)})`); }
  }

  /** Watch `child`: when it exits by itself (no stop of the service), its address proxy stops. */
  private watch(child: Child): void {
    this.unwatch();
    const t = setInterval(() => {
      if (this.child !== child) { if (this.watcher === t) this.unwatch(); return; }
      if (this.alive(child)) { this.d.mac?.watcher?.tick({ pid: child.pid, start: child.start }); return; }
      this.unwatch();
      this.d.mac?.watcher?.stop();
      this.d.log("blanket: the blanket Chrome exited by itself; its address proxy stops");
      void this.stopProxy();
    }, this.d.watchMs ?? WATCH_MS);
    t.unref?.();
    this.watcher = t;
  }

  private unwatch(): void {
    if (this.watcher) clearInterval(this.watcher);
    this.watcher = null;
  }

  /** SIGTERM to `c`'s process group while it still runs on the blanket profile, then SIGKILL after the grace. */
  private async stopChild(c: Child): Promise<boolean> {
    const signal = (sig: NodeJS.Signals) => {
      if (!this.alive(c) || !this.d.procs.holds(c.pid, [this.marker])) return false;
      try { this.kill(c.pid, sig); return true; } catch { return false; }
    };
    if (!signal("SIGTERM")) return false;
    const wait = async (ms: number) => { const end = this.clock() + ms; while (this.alive(c) && this.clock() < end) await this.sleep(POLL_MS); return !this.alive(c); };
    if (!(await wait(TERM_GRACE_MS))) { signal("SIGKILL"); await wait(KILL_WAIT_MS); }
    return true;
  }

  /** The Chromes on the blanket profile that this service does not hold: the roots of their trees. */
  private others(): number[] {
    const held = this.child?.pid;
    const on = new Map<number, number>();
    for (const pid of this.d.procs.pids()) {
      if (pid === held || !this.d.procs.holds(pid, [this.marker])) continue;
      const st = this.d.procs.stat(pid);
      if (st) on.set(pid, st.ppid);
    }
    return [...on].filter(([, ppid]) => !on.has(ppid) && ppid !== held).map(([pid]) => pid);
  }

  private async stopOthers(): Promise<boolean> {
    let stopped = false;
    for (const pid of this.others()) {
      const st = this.d.procs.stat(pid);
      if (await this.stopChild({ pid, start: st?.start ?? null, proc: null })) { this.d.log(`blanket: stopped a Chrome on the blanket profile that the service did not hold (pid ${pid})`); stopped = true; }
    }
    return stopped;
  }

  /** Stop the blanket Chrome (and any other Chrome on the blanket profile); the folder stays. True when one ran. */
  async stop(): Promise<boolean> {
    const c = this.child;
    this.child = null;
    this.unwatch();
    this.d.mac?.watcher?.stop();
    let stopped = c ? await this.stopChild(c) : false;
    stopped = (await this.stopOthers()) || stopped;
    await this.stopProxy();
    if (stopped) this.d.log("blanket: the blanket Chrome stopped");
    return stopped;
  }

  /** Stop the blanket Chrome, then delete the folder (the scope's end, the daemon's stop, `enabled: false`). */
  async end(): Promise<void> {
    await this.stop();
    this.folderOf = null;
    if (this.removeFolder()) this.d.log("blanket: the blanket folder is deleted");
  }

  /** The service's start: stop each Chrome on the blanket profile (no adoption), then delete the folder. */
  async sweep(): Promise<void> {
    this.child = null;
    this.unwatch();
    await this.stopProxy();
    if (await this.stopOthers()) this.d.log("blanket: the service's start stopped the blanket Chrome of an earlier run");
    this.folderOf = null;
    this.removeFolder();
  }
}
