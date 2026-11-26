// The blanket template on the Mac (board ab-4wh.16; the design docs/superpowers/specs/2026-11-26-blanket-profile-mac-design.md,
// section 13.3; C12, the blanket profile on the Mac). Google Chrome on the Mac loads the receiver only through a person's
// "Load unpacked": it ignores --load-extension, it deletes a CDP load at its next start, and it turns off a packed CRX
// from outside the Chrome Web Store. So the operator loads the receiver once into the template, a profile at
// `<state>/blanket-template/profile`, and each blanket folder starts with a copy of two of its files:
// `Default/Preferences` and `Default/Secure Preferences`. Chrome protects the receiver's entry and developer mode with a
// MAC over the machine's id, a key's name and its value, not over the folder's path, so a copy keeps the load (the Mac
// check M2, 2026-11-26: two copies kept it; the entry and developer mode live only in Secure Preferences).
//
// - The set-up (the op `blanket_setup`, the operator's button `Set up blanket profile`): the blanket Chrome stops (its
//   folder stays), the package folder `<state>/agent-package-blanket` is written, the template folder is made new (mode
//   0700), and the set-up Chrome starts through `open -n` (no -g) with the agent Chrome's flags and an address proxy in
//   its closed mode: it reaches no network, so no site data comes into the template. Every 5 s the service reads the
//   template's files; when they hold the load, it stops the set-up Chrome (Chrome writes its files at a clean exit) and
//   reads them again: `ready`. With no load in 10 minutes, or a set-up Chrome that closes first: `failed`, with the reason.
// - The copy: the two files, with no link followed and at most 8 MiB each, a JSON object each. Secure Preferences goes as
//   its bytes; the copy's Preferences gets the blanket folder's keys (unit.ts, sitePrefs), none of which Chrome protects,
//   and no extension key.
// - The off read: after a blanket start whose receiver did not say hello, the copy's receiver entry (as the off read of
//   the agent Chrome on the Mac): turned off, or no entry, deletes the template (`none`), and the operator sets it up
//   again (a Chrome update can do this; the research note of 2026-11-24).
// - The template stays at the daemon's `stop` and at `enabled: false`: it holds no site data. The service's start stops a
//   set-up Chrome that runs (no adoption) and reads the template's files.

import { closeSync, constants, fstatSync, mkdirSync, openSync, readSync, realpathSync, writeSync } from "node:fs";
import { join } from "node:path";
import { errorKind } from "../lists/files.ts";
import { RECEIVER_ID } from "../package/pins.ts";
import { BLANKET_PACKAGE_FOLDER } from "../unit/mac-chrome.ts";
import type { Procs } from "../unit/procs.ts";
import { sitePrefs } from "../unit/unit.ts";
import { removeBlanketFolder, type BlanketProxy } from "./chrome.ts";
import { aliveHeld, findMacMain, mainsOn, stopHeld, type Held } from "./mac-start.ts";
import { proxyFlags } from "./proxy.ts";

export type TemplateState = "none" | "setting_up" | "ready" | "failed";

/** How often the set-up reads the template's files while its Chrome runs. */
export const SETUP_POLL_MS = 5_000;
/** The set-up's limit: the operator's Load unpacked within it. */
export const SETUP_WAIT_MS = 10 * 60_000;
/** After the files hold the load, the set-up Chrome runs this long before its stop (Chrome writes its files some seconds after a change). */
export const SETUP_SETTLE_MS = 2_000;
/** The largest preference file that the copy and the reads take. */
export const PREFS_MAX_BYTES = 8 * 1024 * 1024;
/** The location of an unpacked extension in Chrome's extension settings (mojom::ManifestLocation::kUnpacked). */
export const UNPACKED = 4;

/** The operator's sentences (C12, the blanket profile on the Mac). `folder`: the real absolute path of the package folder. */
export const TEMPLATE_TEXT = {
  none: (folder: string) => `The blanket profile is not set up on this Mac. Click Set up blanket profile in the Browser pane; in the Chrome window that opens on this Mac's screen, open chrome://extensions, turn on Developer mode, click Load unpacked and choose the folder ${folder} (Command-Shift-G in that dialog takes a path). The service closes that window when the extension is loaded.`,
  offLead: "Chrome turned the agent extension off in the blanket profile (a Chrome update can do this). ",
  settingUp: (folder: string) => `The set-up Chrome of the blanket profile is open on this Mac's screen: in it, open chrome://extensions, turn on Developer mode, click Load unpacked and choose the folder ${folder} (Command-Shift-G in that dialog takes a path). It closes when the extension is loaded, or after 10 minutes.`,
  failed: (reason: string) => `The set-up of the blanket profile did not finish: ${reason}. Click Set up blanket profile in the Browser pane to try again.`,
} as const;

/** The reasons of a failed set-up (C12). */
export const SETUP_REASON = {
  timeout: "the extension was not loaded in 10 minutes",
  folder: `the extension was not loaded from the folder ${BLANKET_PACKAGE_FOLDER}`,
  devOff: "Developer mode is off",
  off: (reasons: readonly number[]) => `Chrome turned the extension off (disable reason${reasons.length > 1 ? "s" : ""} ${reasons.join(", ")})`,
  unread: "the template's preference files cannot be read",
  closed: "the set-up Chrome closed before the extension was loaded",
  start: (why: string) => `the set-up Chrome could not start (${why.replace(/[.\s]+$/, "")})`,
  package: (code: string) => `the folder ${BLANKET_PACKAGE_FOLDER} could not be written (${code})`,
} as const;

/** The reasons of a blanket start on the Mac that the template refuses (C12). */
export const TEMPLATE_START = {
  none: "the blanket profile is not set up on this Mac; the Browser pane gives the steps",
  settingUp: "the blanket profile's set-up runs",
} as const;

/** What a profile's two files say of the receiver's load. */
export type LoadCheck = { ok: true } | { ok: false; why: "unread" | "none" | "folder" | "dev" | "off"; reasons?: number[] };

const obj = (x: unknown): Record<string, any> | null => (x && typeof x === "object" && !Array.isArray(x) ? x as Record<string, any> : null);

/** One preference file with no link followed: its bytes, null when it is not there, or an Error (a link, too big, unreadable). */
export function readPrefsFile(path: string): Buffer | null | Error {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? null : new Error(errorKind(e)); }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return new Error("not a file");
    if (st.size > PREFS_MAX_BYTES) return new Error("too big");
    const b = Buffer.alloc(st.size);
    let at = 0;
    while (at < b.length) { const n = readSync(fd, b, at, b.length - at, at); if (n <= 0) break; at += n; }
    return b.subarray(0, at);
  } catch (e) { return new Error(errorKind(e)); }
  finally { closeSync(fd); }
}

/** A preference file as a JSON object: {} when it is not there, null when it cannot be read or is no JSON object. */
function readPrefs(path: string): Record<string, any> | null {
  const b = readPrefsFile(path);
  if (b === null) return {};
  if (b instanceof Error) return null;
  try { return obj(JSON.parse(b.toString("utf8"))); } catch { return null; }
}

/** The disable reasons of an entry: Chrome writes a list (or an old number, a bit set); [] when none. */
export function disableReasons(entry: Record<string, any>): number[] {
  const r = entry.disable_reasons;
  if (Array.isArray(r)) return r.filter((n) => Number.isSafeInteger(n) && n !== 0);
  if (Number.isSafeInteger(r) && r !== 0) return [r as number];
  return [];
}

/**
 * The receiver's load in `profile`: its entry from `Default/Secure Preferences` when that file holds it, else from
 * `Default/Preferences` (as C12's access check reads them), and developer mode the same way. The load holds when the
 * entry has no disable reason, its `path` names `packageFolder` (by real path; any case when `foldCase`, the Mac's disk),
 * its `location` is 4 (unpacked), and developer mode is true.
 */
export function checkLoad(profile: string, packageFolder: string, foldCase = process.platform === "darwin"): LoadCheck {
  const secure = readPrefs(join(profile, "Default", "Secure Preferences")), prefs = readPrefs(join(profile, "Default", "Preferences"));
  if (secure === null || prefs === null) return { ok: false, why: "unread" };
  const from = (o: Record<string, any>) => obj(obj(obj(o.extensions)?.settings)?.[RECEIVER_ID]);
  const entry = from(secure) ?? from(prefs);
  if (!entry) return { ok: false, why: "none" };
  const reasons = disableReasons(entry);
  if (reasons.length) return { ok: false, why: "off", reasons };
  const real = (p: string) => { try { return realpathSync(p); } catch { return null; } };
  const a = typeof entry.path === "string" ? real(entry.path) : null, b = real(packageFolder);
  const same = a !== null && b !== null && (a === b || (foldCase && a.toLowerCase() === b.toLowerCase()));
  if (!same || entry.location !== UNPACKED) return { ok: false, why: "folder" };
  const ui = (o: Record<string, any>) => obj(obj(o.extensions)?.ui);
  const dev = ui(secure)?.developer_mode ?? ui(prefs)?.developer_mode;
  return dev === true ? { ok: true } : { ok: false, why: "dev" };
}

/** Write `data` as a new file at `path` (mode 0600, no link followed, it must not be there). */
function writeNew(path: string, data: Buffer | string): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { const b = typeof data === "string" ? Buffer.from(data) : data; let at = 0; while (at < b.length) at += writeSync(fd, b, at, b.length - at); }
  finally { closeSync(fd); }
}

export type TemplateDeps = {
  /** The state folder. */
  state: string;
  procs: Pick<Procs, "pids" | "holds" | "cmdline" | "stat" | "exe">;
  /** The set-up Chrome's app and arguments for the template's profile with `extra` (unit.ts, macBlanketLaunch); throws the start's error. */
  launch: (profile: string, extra: readonly string[]) => { app: { bundle: string }; args: string[] } | null;
  /** `open -n` (no -g when `front`) of the app (the unit's MacStart). */
  open: (bundle: string, args: string[], o: { front: boolean }) => Promise<number | null>;
  /** Write `<state>/agent-package-blanket` (mac-chrome.ts, blanketPackage); its caller writes it while no blanket Chrome runs. */
  writePackage: () => void;
  /** The address proxy in its closed mode (proxy.ts, `closed`). */
  proxy: BlanketProxy;
  log: (line: string) => void;
  kill: (pid: number, sig: NodeJS.Signals) => void;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Tests only: the limits above. */
  pollMs?: number;
  waitMs?: number;
  settleMs?: number;
  foldCase?: boolean;
};

/** The blanket template: its state, its set-up, the copy of its two files and the off read of a copy. */
export class BlanketTemplate {
  readonly root: string;
  readonly profile: string;
  /** `<state>/agent-package-blanket`: the folder of the operator's Load unpacked. */
  readonly packageFolder: string;
  private readonly d: TemplateDeps;
  private readonly clock: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readyNow = false;
  private settingUp: Promise<void> | null = null;
  private failure = "";
  /** The template went at an off read of a copy: the `none` sentence starts with its lead. */
  private offLead = false;
  private child: Held | null = null;
  private closed = false;

  constructor(d: TemplateDeps) {
    this.d = d;
    this.root = join(d.state, "blanket-template");
    this.profile = join(this.root, "profile");
    this.packageFolder = join(d.state, BLANKET_PACKAGE_FOLDER);
    this.clock = d.clock ?? (() => performance.now());
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); }));
    this.refresh();
  }

  private get marker(): string { return `--user-data-dir=${this.profile}`; }

  /** Read the template's files again: it is ready when they hold the load. */
  refresh(): boolean {
    this.readyNow = checkLoad(this.profile, this.packageFolder, this.d.foldCase).ok;
    return this.readyNow;
  }

  /** status's `blanket_template`. */
  state(): TemplateState {
    if (this.settingUp) return "setting_up";
    if (this.readyNow) return "ready";
    return this.failure ? "failed" : "none";
  }

  /** The reason of a blanket start that the template refuses now, or null (the template is ready). */
  startRefusal(): string | null {
    if (this.settingUp) return TEMPLATE_START.settingUp;
    return this.readyNow ? null : TEMPLATE_START.none;
  }

  /** The operator's sentences: while it is set up, after a failed set-up, and with no template while a local item has a blanket approval. */
  notes(blanketWanted: boolean): string[] {
    const s = this.state();
    if (s === "setting_up") return [TEMPLATE_TEXT.settingUp(this.packageFolder)];
    if (s === "failed") return [TEMPLATE_TEXT.failed(this.failure)];
    if (s === "none" && blanketWanted) return [`${this.offLead ? TEMPLATE_TEXT.offLead : ""}${TEMPLATE_TEXT.none(this.packageFolder)}`];
    return [];
  }

  // ------------------------------------------------------------------ the copy and the off read

  /**
   * Copy the template's two files into `profile/Default` (the new blanket folder's; `Default` is there and empty) and
   * write the blanket folder's keys into the copy's Preferences. Throws an Error whose message is the start's reason.
   */
  copyInto(profile: string, downloads: string): void {
    const why = this.startRefusal();
    if (why) throw new Error(why);
    const read = (name: string) => {
      const b = readPrefsFile(join(this.profile, "Default", name));
      if (b === null || b instanceof Error) throw new Error(`the blanket template's ${name} cannot be read (${b === null ? "ENOENT" : b.message})`);
      let o: Record<string, any> | null = null;
      try { o = obj(JSON.parse(b.toString("utf8"))); } catch {}
      if (!o) throw new Error(`the blanket template's ${name} is not a JSON object`);
      return { b, o };
    };
    const secure = read("Secure Preferences"), prefs = read("Preferences");
    writeNew(join(profile, "Default", "Secure Preferences"), secure.b);
    writeNew(join(profile, "Default", "Preferences"), `${JSON.stringify(sitePrefs(prefs.o, downloads))}\n`);
  }

  /** The off read of a copy (C12): Chrome turned the receiver off there, or the copy holds no entry. A file that cannot be read gives none. */
  offRead(profile: string): boolean {
    const r = checkLoad(profile, this.packageFolder, this.d.foldCase);
    return !r.ok && (r.why === "off" || r.why === "none");
  }

  /** After an off read: the template goes, and the operator sets it up again. */
  markOff(): void {
    this.d.log("blanket: Chrome turned the agent extension off in a copy of the blanket template; the template is deleted, and the Browser pane gives the steps to set it up again");
    removeBlanketFolder(this.root, this.d.log);
    this.readyNow = false;
    this.failure = "";
    this.offLead = true;
  }

  // ------------------------------------------------------------------ the set-up

  /**
   * The op `blanket_setup`: the set-up runs after the answer. `stopBlanket` stops the blanket Chrome first (its folder
   * stays). While a set-up runs, another changes nothing.
   */
  setup(stopBlanket: () => Promise<void>): void {
    if (this.settingUp || this.closed) return;
    this.failure = ""; this.offLead = false;
    const run = this.run(stopBlanket).catch((e) => this.fail(SETUP_REASON.start(String((e as Error).message ?? e))));
    this.settingUp = run.finally(() => { this.settingUp = null; });
  }

  /** The set-up that runs, if any (tests and the service's stop). */
  running(): Promise<void> | null { return this.settingUp; }

  private fail(reason: string): void {
    this.failure = reason;
    this.readyNow = false;
    this.d.log(`blanket: the set-up of the blanket template did not finish: ${reason}`);
  }

  private async run(stopBlanket: () => Promise<void>): Promise<void> {
    this.d.log("blanket: the set-up of the blanket template begins");
    await stopBlanket();
    if (this.closed) return;
    await this.stopOthers();
    try { this.d.writePackage(); }
    catch (e) { return this.fail(SETUP_REASON.package(errorKind(e))); }
    // The template folder, new and empty, with the blanket folder's keys and no extension key.
    if (!removeBlanketFolder(this.root, this.d.log)) return this.fail(SETUP_REASON.start("the old template folder could not be deleted"));
    this.readyNow = false;
    const downloads = join(this.root, "Downloads");
    try {
      for (const dir of [this.root, this.profile, join(this.profile, "Default"), downloads]) mkdirSync(dir, { mode: 0o700 });
      writeNew(join(this.profile, "Default", "Preferences"), `${JSON.stringify(sitePrefs({}, downloads))}\n`);
    } catch (e) { return this.fail(SETUP_REASON.start(`the template folder could not be made: ${errorKind(e)}`)); }
    let port: number;
    try { port = await this.d.proxy.start(); }
    catch (e) { await this.stopProxy(); return this.fail(SETUP_REASON.start(`the closed proxy could not start: ${errorKind(e)}`)); }
    try { await this.chrome(port); }
    finally { await this.stopChrome(); await this.stopProxy(); }
  }

  /** The set-up Chrome: its start, the reads of the template's files, and the end. */
  private async chrome(port: number): Promise<void> {
    let launch;
    try { launch = this.d.launch(this.profile, proxyFlags(port)); }
    catch (e) { return this.fail(SETUP_REASON.start((e as Error).message)); }
    if (!launch) return this.fail(SETUP_REASON.start("the agent browser is not on the Mac"));
    const code = await this.d.open(launch.app.bundle, launch.args, { front: true });
    if (code !== 0) return this.fail(SETUP_REASON.start(`open exited ${code === null ? "with no code" : `with ${code}`}`));
    const found = await findMacMain({ procs: this.d.procs, marker: this.marker, bundle: launch.app.bundle, what: "template's profile", clock: this.clock, sleep: this.sleep });
    if ("error" in found) return this.fail(SETUP_REASON.start(found.error));
    this.child = found;
    this.d.log(`blanket: the set-up Chrome of the blanket template runs (pid ${found.pid}); it reaches no network`);
    const end = this.clock() + (this.d.waitMs ?? SETUP_WAIT_MS);
    for (;;) {
      if (this.closed) return;
      const r = checkLoad(this.profile, this.packageFolder, this.d.foldCase);
      if (r.ok) {
        await this.sleep(this.d.settleMs ?? SETUP_SETTLE_MS);
        await this.stopChrome();
        return this.finish(true);
      }
      if (!aliveHeld(this.d.procs, this.child)) { this.child = null; return this.finish(false, SETUP_REASON.closed); }
      if (this.clock() >= end) { await this.stopChrome(); return this.finish(false, SETUP_REASON.timeout); }
      await this.sleep(this.d.pollMs ?? SETUP_POLL_MS);
    }
  }

  /** After the set-up Chrome's end: the files decide; `why` is the reason when they hold no entry. */
  private finish(loaded: boolean, why: string = SETUP_REASON.timeout): void {
    const r = checkLoad(this.profile, this.packageFolder, this.d.foldCase);
    if (r.ok) { this.readyNow = true; this.failure = ""; this.d.log("blanket: the blanket template is ready"); return; }
    const reason = r.why === "unread" ? SETUP_REASON.unread : r.why === "off" ? SETUP_REASON.off(r.reasons ?? []) : r.why === "folder" ? SETUP_REASON.folder : r.why === "dev" ? SETUP_REASON.devOff : loaded ? SETUP_REASON.unread : why;
    this.fail(reason);
  }

  private async stopChrome(): Promise<void> {
    const c = this.child;
    this.child = null;
    if (c) await stopHeld({ procs: this.d.procs, kill: this.d.kill, c, marker: this.marker, clock: this.clock, sleep: this.sleep });
  }

  private async stopProxy(): Promise<void> {
    try { await this.d.proxy.stop(); } catch (e) { this.d.log(`blanket: the closed proxy did not stop cleanly (${errorKind(e)})`); }
  }

  /** Stop each Chrome on the template's profile that this service does not hold (no adoption). */
  private async stopOthers(): Promise<boolean> {
    let stopped = false;
    for (const pid of mainsOn(this.d.procs, this.marker)) {
      if (pid === this.child?.pid) continue;
      if (await stopHeld({ procs: this.d.procs, kill: this.d.kill, c: { pid, start: this.d.procs.stat(pid)?.start ?? null }, marker: this.marker, clock: this.clock, sleep: this.sleep })) {
        this.d.log(`blanket: stopped a Chrome on the blanket template's profile that the service did not hold (pid ${pid})`);
        stopped = true;
      }
    }
    return stopped;
  }

  /** The service's start: a set-up Chrome of an earlier run stops (no adoption); the template's files are read. The template stays. */
  async sweep(): Promise<void> {
    await this.stopOthers();
    this.refresh();
  }

  /** The service's stop: a set-up that runs ends (its Chrome and its proxy stop). */
  async shutdown(): Promise<void> {
    this.closed = true;
    const run = this.settingUp;
    if (run) await run.catch(() => {});
    await this.stopChrome();
  }
}
