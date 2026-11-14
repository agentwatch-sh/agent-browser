// The agent Chrome of `agent-browser service` on the Mac (board ab-v16.94.6, which folds in ab-v16.8; the self-contained
// design, section 10; the Chrome comparison, docs/research/2026-11-03-chrome-vs-chrome-beta.md, sections 7 and 8). The
// Chrome unit (unit.ts) runs it through these deps when `mac` is set:
//
// - The app: the operator's own `Google Chrome.app` (ab-9hj), started a second time with its own profile
//   (`--user-data-dir=<state>/profile`) through `open -n -g -a <app> --args ...`, with AGENT_ARGS (among them
//   `--disable-backgrounding-occluded-windows`). `chrome_bin` may name another app's binary (`<X>.app/Contents/MacOS/<X>`).
//   The version is the app's on disk (CFBundleShortVersionString of its Info.plist, read with /usr/bin/plutil).
// - Never a default folder: a profile that is, or is inside, a default user-data folder of Chrome or Chromium is refused,
//   and nothing here writes an external extensions file (the app's or the all-users folder): the agent package comes by
//   "Load unpacked" by the operator, once per agent profile. The host manifest goes into the agent profile's
//   NativeMessagingHosts/ folder only (link/manifest.ts). The folder that the operator loads is `<state>/agent-package/`:
//   before each start the unit writes the pinned package there, unpacked, when the folder differs from the pin (board
//   ab-v16.94.19; package/crx.ts, unpackAgentPackage), and the fail-closed watch waits longer for the first receiver.
// - No focus taken: the give-back guard of the start (src/giveback.ts) records the app in front before `open`, and the
//   give-back watcher (src/watchback.ts, its script) runs as the service's child for as long as the agent Chrome runs.
// - The version change: the agent Chrome starts again when the operator's running Chrome runs a newer version (its
//   relaunch after an update; `chromeVersions`, from the framework folder of each Chrome's helper processes), and the
//   version on disk is newer than the agent Chrome's too; the unit part does the restart.
// - No Xvfb and no X pointer: the unit starts none on the Mac.
//
// Nothing here runs under node --test unless a test gives a stand-in program: no test starts `open` or osascript.

import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { appBundle, CHROME_STABLE_BIN } from "../../agent.ts";
import { PACKAGE_FOLDER, unpackAgentPackage } from "../package/crx.ts";
import { startGiveBack } from "../../giveback.ts";
import { underNodeTest } from "../../options.ts";
import { watchBackArgs, OSASCRIPT, WATCH_RETRY_MS } from "../../watchback.ts";
import type { Procs } from "./procs.ts";
import { StartError } from "./unit.ts";
import { newer } from "./versions.ts";

export const OPEN = "/usr/bin/open";
export const PLUTIL = "/usr/bin/plutil";
/** How often the unit part compares the agent Chrome's version with the operator's running Chrome's. */
export const MAC_VERSION_EVERY_MS = 60_000;

/** The default user-data folders of Chrome and Chromium on the Mac (under ~/Library/Application Support). */
export const DEFAULT_FOLDERS = ["Google/Chrome", "Google/Chrome Beta", "Google/Chrome Dev", "Google/Chrome Canary", "Chromium"] as const;

/** The real path of `p`, or of its nearest folder that exists with the rest joined (a profile that is not made yet). */
function realish(p: string): string {
  const rest: string[] = [];
  for (let at = resolve(p); ; at = dirname(at)) {
    try { return join(realpathSync(at), ...rest); } catch { /* not there yet */ }
    if (dirname(at) === at) return resolve(p);
    rest.unshift(basename(at));
  }
}

/** The default folder that `profile` is or is inside, or null. Both sides are compared as real paths, with any case (the Mac's disk ignores case). */
export function defaultFolderOf(profile: string, home = homedir()): string | null {
  const p = realish(profile).toLowerCase();
  for (const f of DEFAULT_FOLDERS) {
    const d = realish(join(home, "Library", "Application Support", f)).toLowerCase();
    const r = relative(d, p);
    if (r === "" || (r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r))) return join(home, "Library", "Application Support", f);
  }
  return null;
}

/** The app that a Mac start runs. */
export type MacApp = { binary: string; bundle: string; version: string; google: boolean };

/** The deps of the Chrome unit on the Mac (unit.ts, `mac`): the app, its start through `open`, and the start's give-back guard. */
export type MacStart = {
  /** The app of `chrome_bin` (empty: Google Chrome stable) with its version on disk; throws a StartError. */
  app(chromeBin: string, profile: string): MacApp;
  /** `open -n -g -a <bundle> --args <args>`: its exit code (null: it could not run). */
  open(bundle: string, args: string[]): Promise<number | null>;
  /** The give-back guard of one start: begun before `open`, finished after the start. */
  guard(bundle: string): Promise<{ finish(ms: number): Promise<void> }>;
  /**
   * The agent package's folder for the operator's "Load unpacked" (board ab-v16.94.19; package/crx.ts,
   * unpackAgentPackage): checked, and written when it differs from the pin, before each `open`; throws on a failure.
   * `left`: the folders of a swap that it could not remove (no failure: the next start tries again).
   */
  agentPackage?(): { folder: string; version: string; written: boolean; left?: string[] };
};

/** The Mac's version form, `a.b.c.d` (CFBundleShortVersionString, and the folder of a framework version): C12's form. */
export const MAC_VERSION_RE = /^[0-9]{1,19}(\.[0-9]{1,19}){3}$/;
/** True when both are `a.b.c.d` and `version` is the newer one, by the numbers in order (review-145 B1). */
export const macNewer = (version: string, than: string): boolean => MAC_VERSION_RE.test(version) && MAC_VERSION_RE.test(than) && newer(`${version}-0`, `${than}-0`);

type Run = (argv: string[]) => string;
const runSync: Run = (argv) => execFileSync(argv[0], argv.slice(1), { encoding: "utf8", timeout: 5000 });

/** CFBundleShortVersionString of `<bundle>/Contents/Info.plist` as plutil gives it (trimmed), or null when it cannot be read. */
export function bundleVersion(bundle: string, run: Run = runSync): string | null {
  try { return run([PLUTIL, "-extract", "CFBundleShortVersionString", "raw", "-o", "-", join(bundle, "Contents", "Info.plist")]).trim(); } catch { return null; }
}

/** CFBundleShortVersionString of `<bundle>/Contents/Info.plist` in the form `a.b.c.d`, or null. */
export function appVersion(bundle: string, run: Run = runSync): string | null {
  const v = bundleVersion(bundle, run);
  return v !== null && MAC_VERSION_RE.test(v) ? v : null;
}

/** The real deps: /usr/bin/open, plutil and the give-back guard, with its log lines in `<state>/launches.log`. */
export function macStart(o: { state: string; home?: string; exists?: (p: string) => boolean; version?: (bundle: string) => string | null; openBin?: string; guardBin?: string; crx?: string }): MacStart {
  const exists = o.exists ?? existsSync;
  return {
    app(chromeBin, profile) {
      const folder = defaultFolderOf(profile, o.home);
      if (folder) throw new StartError(`the agent profile is in a default user-data folder of Chrome (${folder}); the agent browser never runs there`);
      const binary = chromeBin || CHROME_STABLE_BIN;
      const bundle = appBundle(binary);
      if (!bundle) throw new StartError(`browser.chrome_bin on the Mac names an app's binary (<X>.app/Contents/MacOS/<X>): ${binary}`);
      if (!exists(binary)) throw new StartError(binary === CHROME_STABLE_BIN ? "Google Chrome is not installed in /Applications" : `the app of browser.chrome_bin is not installed: ${bundle}`);
      // `version` gives plutil's text: a text that is not a.b.c.d names itself and C12's form (review-145b N5).
      const version = (o.version ?? bundleVersion)(bundle);
      if (!version) throw new StartError(`the version of ${bundle} cannot be read`);
      if (!MAC_VERSION_RE.test(version)) throw new StartError(`the version of ${bundle} is ${JSON.stringify(version.slice(0, 40))}, not of the form a.b.c.d (four numbers), so the agent browser cannot compare it`);
      return { binary, bundle, version, google: binary === CHROME_STABLE_BIN };
    },
    open(bundle, args) {
      if (!o.openBin && underNodeTest()) return Promise.resolve(null);
      return new Promise((r) => {
        // A small environment of its own: no variable of the service (a token among them) goes to `open`.
        const env = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: o.home ?? homedir() };
        execFile(o.openBin ?? OPEN, ["-n", "-g", "-a", bundle, "--args", ...args], { env, timeout: 30_000, killSignal: "SIGKILL" }, (e) => r(e ? (typeof e.code === "number" ? e.code : null) : 0));
      });
    },
    guard: (bundle) => startGiveBack(bundle, join(o.state, "launches.log"), o.guardBin ? { bin: o.guardBin } : {}),
    agentPackage: () => { const folder = join(o.state, PACKAGE_FOLDER); return { folder, ...unpackAgentPackage(folder, o.crx) }; },
  };
}

// ------------------------------------------------------------------ the give-back watcher

/**
 * The give-back watcher for the agent Chrome (src/watchback.ts's script, as the service's own child): one watcher for each
 * Chrome (pid and start time), started at the part's tick while that Chrome runs, ended when it stops or the service
 * stops. Its log lines go to `<state>/launches.log`. A watcher that ended while its Chrome runs is not started again for
 * that Chrome before WATCH_RETRY_MS. Under node --test it starts only a stand-in `bin`.
 */
export class GiveBackWatcher {
  private readonly o: { bundle: () => string | null; state: string; bin?: string; pre?: string[]; clock?: () => number; retryMs?: number; log: (line: string) => void };
  private child: ChildProcess | null = null;
  private chrome = "";
  private ended: { chrome: string; at: number } | null = null;
  constructor(o: GiveBackWatcher["o"]) { this.o = o; }

  get running(): boolean { return this.child !== null; }

  /** Make sure that a watcher runs for `chrome` (null: none runs, so none watches). */
  tick(chrome: { pid: number; start: number | null } | null): void {
    const key = chrome ? `${chrome.pid}/${chrome.start}` : "";
    if (this.child && this.chrome !== key) this.stop();
    if (!chrome || this.child) return;
    const now = (this.o.clock ?? Date.now)();
    if (this.ended && this.ended.chrome === key && now - this.ended.at < (this.o.retryMs ?? WATCH_RETRY_MS)) return;
    const bundle = this.o.bundle();
    if (!bundle || (!this.o.bin && underNodeTest())) return;
    let fd: number | undefined;
    try {
      try { fd = openSync(join(this.o.state, "launches.log"), "a", 0o600); } catch { /* the watcher still runs; its lines are lost */ }
      const child = spawn(this.o.bin ?? OSASCRIPT, [...(this.o.pre ?? []), ...watchBackArgs(bundle, chrome.pid, process.pid, this.o.state)], { stdio: ["ignore", "pipe", fd ?? "ignore"] });
      child.on("error", () => {});
      // Its beats on standard output: keep reading them, so that the pipe has a reader while the service lives.
      child.stdout!.resume();
      child.once("exit", () => {
        if (this.child !== child) return;
        this.child = null;
        this.ended = { chrome: key, at: (this.o.clock ?? Date.now)() };
      });
      this.child = child; this.chrome = key;
      this.o.log(`unit: the give-back watcher runs for the agent Chrome (pid ${chrome.pid})`);
    } catch (e) {
      this.ended = { chrome: key, at: now };
      this.o.log(`unit: the give-back watcher could not start: ${(e as Error).message.slice(0, 200)}`);
    } finally { if (fd !== undefined) closeSync(fd); }
  }

  /** End the watcher (its Chrome stopped, or the service stops). */
  stop(): void {
    const c = this.child;
    this.child = null; this.chrome = "";
    if (c && c.exitCode === null && c.signalCode === null) c.kill("SIGTERM");
  }
}

// ------------------------------------------------------------------ the versions

/**
 * The versions that the agent Chrome (`agentPid`) and the operator's Chrome of the same app run now. A Chrome's helper
 * processes (`--type=...`) run from `<app>/Contents/Frameworks/<framework>/Versions/<version>/Helpers/...`, the framework
 * that the main process loaded at its start, so a running Chrome's version stays readable after an update on disk. The
 * operator's Chrome is the parent of such a helper that runs the app's binary, as this user, not on the agent profile.
 */
export function chromeVersions(procs: Procs, app: { binary: string; bundle: string }, agentPid: number, profile: string): { agent: string | null; operator: string | null } {
  const frameworks = join(app.bundle, "Contents", "Frameworks") + sep;
  let agent: string | null = null, operator: string | null = null;
  for (const pid of procs.pids()) {
    const argv = procs.cmdline(pid);
    if (!argv[0]?.startsWith(frameworks) || !argv.some((a) => a.startsWith("--type="))) continue;
    const v = /\/Versions\/([^/]+)\/Helpers\//.exec(argv[0].slice(frameworks.length))?.[1];
    if (!v || !MAC_VERSION_RE.test(v)) continue;
    const parent = procs.stat(pid)?.ppid;
    if (parent === undefined) continue;
    if (parent === agentPid) agent ??= v;
    else if (operator === null && procs.mine(parent)) {
      const main = procs.cmdline(parent);
      if (main[0] === app.binary && !main.some((a) => a.startsWith("--type=")) && !main.includes(`--user-data-dir=${profile}`)) operator = v;
    }
  }
  return { agent, operator };
}
