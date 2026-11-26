// `agent-browser service stop --all` (the self-contained design, sections 5.1 and 17, open point 3; board
// ab-v16.94.3; a port of agentwatch's daemon/browser/stop_unit.py without its relay part: the service has no relay
// process). It stops this OS user's Chrome unit with no service running: for the uninstall, and on the Mac after the
// daemon unloads the service's job (the operator's answer to open point 3). It stops, of this user only:
//
// - every process whose command line holds `--user-data-dir=<the profile>` as a whole argument (the unit's Chrome and
//   its children): SIGTERM to each root of a tree (its parent is not on the profile), then SIGKILL to each left;
// - the unit's Xvfb: the one the unit record names, when its command line still holds the record's display and the X
//   auth file, and any other whose command line holds the X auth file. Only a program named Xvfb (the base name of
//   argv[0] or of /proc/<pid>/exe): `xauth -f <the X auth file>` names the file too.
//
// - the blanket Chrome (board ab-4wh.3; C12, the blanket profile): every process on `<state>/blanket/profile`, as the
//   unit's Chrome; then `<state>/blanket` goes (C12: the blanket folder goes at the daemon's stop), with no link followed.
//   Board ab-4wh.7 (N2): a link (or a file) at `<state>/blanket` or at its `profile` is refused, not followed: no Chrome
//   is signalled for it, and the delete only unlinks the link itself. The folder goes only when `<state>` is a state
//   folder of this service (stateFolderRefusal: a real folder of this user, as the unit makes it, that holds the unit's
//   record, which each start of the unit writes; the blanket Chrome starts only on the unit). Else nothing is deleted,
//   and the log says why; a delete that fails says so on the log too (main.ts gives the command's standard error).
// - the Mac (board ab-4wh.16; C12, the blanket profile on the Mac): the set-up Chrome on the blanket template's profile,
//   `<state>/blanket-template/profile`, the same way; the template stays (it holds no site data). The blanket Chrome on the
//   Mac starts with no unit, so a state folder there can hold no unit record: its `agent-package-blanket` folder (each
//   blanket start and each set-up writes it) marks it as a state folder of this service too.
//
// A pid's command line is read again right before each signal, so a reused pid is never signalled. It writes no file:
// only the owner writes the unit record. The blanket folder is the one thing that it deletes.
//
// `service stop --blanket` (board ab-4wh.17; stop-blanket.ts) uses the same parts for the blanket's profiles and folder
// only (stopper, blanketProfiles, deleteBlanket), with its check of a live service before each round of signals (`may`).
//
// The folder can come in another form than the one that the unit's processes got (through a link, review-106 note 9):
// a process's profile argument and the Xvfb's X auth argument name the unit's file when they name it as given or when
// their real path (after links) is the real path of the unit's file. Only absolute paths count.

import { lstatSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Procs } from "./procs.ts";
import { intOf, readRecord } from "./record.ts";
import { realOf, type UnitPaths } from "./paths.ts";
import { KILL_WAIT_MS, TERM_GRACE_MS } from "./unit.ts";
import { blanketFolders, removeBlanketFolder } from "../blanket/chrome.ts";
import { BLANKET_PACKAGE_FOLDER } from "./mac-chrome.ts";
import { errorKind } from "../lists/files.ts";

/** What is at `path`, with no link followed: nothing, a real folder, or something else (a link, a file). */
export function kindAt(path: string): "none" | "folder" | "other" {
  try { return lstatSync(path).isDirectory() ? "folder" : "other"; }
  catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? "none" : "other"; }
}

/**
 * Why `state` (a real path) is no state folder of this service, or null when it is one: a real folder (no link) of the
 * user `uid`, as the unit makes it (unit.ts, privateDir), that holds the unit's record `unit.json` as a file (each start of
 * the unit writes it, and the blanket Chrome starts only on the unit). `service stop --all` deletes `<state>/blanket` only
 * in such a folder, so a wrong `--state-folder` deletes nothing.
 */
export function stateFolderRefusal(state: string, uid: number, platform: NodeJS.Platform = process.platform): string | null {
  let st;
  try { st = lstatSync(state); } catch (e) { return `it cannot be read (${errorKind(e)})`; }
  if (!st.isDirectory()) return "it is not a folder";
  if (st.uid !== uid) return "it is not a folder of this user";
  let rec;
  try { rec = lstatSync(join(state, "unit.json")); }
  catch (e) {
    // The Mac only (board ab-4wh.16; the review's m3): the blanket start's package folder, a real folder, marks the state
    // folder too. Linux never writes that folder.
    if (platform === "darwin" && kindAt(join(state, BLANKET_PACKAGE_FOLDER)) === "folder") return null;
    return `it holds no record of the Chrome unit, unit.json (${errorKind(e)})`;
  }
  return rec.isFile() ? null : "its unit.json is not a file";
}

export type StopAllDeps = { paths: UnitPaths; procs: Procs; kill?: (pid: number, sig: NodeJS.Signals) => void; clock?: () => number; sleep?: (ms: number) => Promise<void>; log?: (line: string) => void;
  /** Tests only: the system (the Mac's state folder rule; process.platform by default). */
  platform?: NodeJS.Platform;
  /**
   * `service stop --blanket` (board ab-4wh.17; stop-blanket.ts): read right before each round of signals and before the
   * delete; false gives no more signal and no delete (a service runs on the state folder again). None for stop --all.
   */
  may?: () => boolean };

/** The signals of stop --all and stop --blanket, and their reads of the processes' arguments. */
export type Stopper = {
  log: (line: string) => void;
  /** Each process of this user on `profile` (a whole `--user-data-dir=` argument, as given or by its real path), with that argument. */
  onProfile(profile: ReadonlySet<string>): Map<number, string[]>;
  /** Stop each process on `profile`: SIGTERM to each root of a tree, then SIGKILL to each left. The roots, as [label, pid]. */
  stopProfile(profile: ReadonlySet<string>, label?: string): Promise<[string, number][]>;
  stop(targets: Map<number, string[]>, first: number[], program?: string): Promise<void>;
  /** The argument of `pid` that names `file` (as given, or by its real path), after `prefix`; null when none does. */
  argFor(pid: number, prefix: string, file: ReadonlySet<string>): string | null;
};

/** A file's two forms: as given, and its real path. */
export const formsOf = (file: string): ReadonlySet<string> => new Set([file, realOf(file)]);

export function stopper(d: StopAllDeps): Stopper {
  const { procs } = d;
  const kill = d.kill ?? ((pid, sig) => process.kill(pid, sig));
  const clock = d.clock ?? (() => performance.now());
  const sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const may = d.may ?? (() => true);
  const log = d.log ?? (() => {});

  const stop = async (targets: Map<number, string[]>, first: number[], program?: string) => {
    const ours = (pid: number) => procs.holds(pid, targets.get(pid)!) && (program === undefined || procs.programIs(pid, program));
    const send = (pid: number, sig: NodeJS.Signals) => { if (ours(pid)) { try { kill(pid, sig); } catch {} } };
    if (!may()) return;
    for (const pid of first) send(pid, "SIGTERM");
    for (const [wait, last] of [[TERM_GRACE_MS, false], [KILL_WAIT_MS, true]] as const) {
      const end = clock() + wait;
      while ([...targets.keys()].some((p) => procs.alive(p)) && clock() < end) await sleep(100);
      if (last) break;
      const left = [...targets.keys()].filter((p) => procs.alive(p));
      if (left.length && !may()) return;
      for (const pid of left) send(pid, "SIGKILL");
    }
  };

  const argFor = (pid: number, prefix: string, file: ReadonlySet<string>): string | null => {
    if (!procs.mine(pid)) return null;
    for (const a of procs.cmdline(pid)) {
      if (!a.startsWith(prefix)) continue;
      const v = a.slice(prefix.length);
      if (isAbsolute(v) && (file.has(v) || file.has(realOf(v)))) return a;
    }
    return null;
  };

  // Chrome: every process on the profile; SIGTERM to each whose parent is not on the profile itself.
  const onProfile = (profile: ReadonlySet<string>) => {
    const on = new Map<number, string[]>();
    for (const p of procs.pids()) { const a = argFor(p, "--user-data-dir=", profile); if (a !== null) on.set(p, [a]); }
    return on;
  };
  const stopProfile = async (profile: ReadonlySet<string>, label = "Chrome"): Promise<[string, number][]> => {
    const on = onProfile(profile);
    if (!on.size) return [];
    const tops = [...on.keys()].filter((p) => !on.has(procs.stat(p)?.ppid ?? -1));
    await stop(on, tops);
    return tops.map((p): [string, number] => [label, p]);
  };
  return { log, onProfile, stopProfile, stop, argFor };
}

/**
 * The blanket's profiles in `state` (boards ab-4wh.3 and ab-4wh.16): the blanket Chrome's, `<state>/blanket/profile`, and
 * the Mac's set-up Chrome's, `<state>/blanket-template/profile`, each in its given form and through the real path of the
 * state folder. They resolve the links of the state folder only: a link at `<state>/blanket` or at its `profile` (or at the
 * template's) is no folder of the service (it makes both with mkdir), so it is left out, with a log line, and no Chrome is
 * signalled for it, neither on the link's target nor on the link's path (board ab-4wh.7, N2).
 */
export function blanketProfiles(state: string, log: (line: string) => void, name: string): { what: "blanket" | "template"; profile: ReadonlySet<string> }[] {
  const blanket = blanketFolders(state);
  const realState = realOf(state), realBlanket = join(realState, "blanket");
  const blanketKind = kindAt(realBlanket);
  const linked = blanketKind === "other" || (blanketKind === "folder" && kindAt(join(realBlanket, "profile")) === "other");
  if (linked) log(`${name}: the blanket folder or its profile is a link or a file, not a folder: no Chrome on it is signalled`);
  // The Mac's blanket template (board ab-4wh.16): its set-up Chrome, by the same rule of links.
  const realTemplate = join(realState, "blanket-template");
  const templateKind = kindAt(realTemplate);
  const templateLinked = templateKind === "other" || (templateKind === "folder" && kindAt(join(realTemplate, "profile")) === "other");
  if (templateLinked) log(`${name}: the blanket template's folder or its profile is a link or a file, not a folder: no Chrome on it is signalled`);
  return [...(linked ? [] : [{ what: "blanket" as const, profile: new Set([blanket.profile, join(realBlanket, "profile")]) }]),
    ...(templateLinked ? [] : [{ what: "template" as const, profile: new Set([join(state, "blanket-template", "profile"), join(realTemplate, "profile")]) }])];
}

/**
 * Delete `<state>/blanket` (its real path) only in a state folder of this service; a link there is unlinked, its target
 * stays. What it found: nothing there, the folder deleted, a refused state folder, a delete that failed (each logged), or
 * no delete because `may` said no.
 */
export function deleteBlanket(state: string, uid: number, o: { log: (line: string) => void; name: string; platform?: NodeJS.Platform; may?: () => boolean }): "none" | "deleted" | "refused" | "failed" | "skipped" {
  const realState = realOf(state), realBlanket = join(realState, "blanket");
  if (kindAt(realBlanket) === "none") return "none";
  if (o.may && !o.may()) return "skipped";
  const why = stateFolderRefusal(realState, uid, o.platform);
  if (why !== null) { o.log(`${o.name}: the state folder is no state folder of the agent browser (${why}), so its blanket folder is not deleted`); return "refused"; }
  return removeBlanketFolder(realBlanket, o.log) ? "deleted" : "failed";
}

/** Stop the unit; what was signalled first, as [program, pid]: each Chrome root, then each Xvfb. */
export async function stopAll(d: StopAllDeps): Promise<[string, number][]> {
  const { procs, paths } = d;
  const s = stopper(d);
  const log = s.log;
  const stopped: [string, number][] = [];

  // Chrome: every process on the profile. Then the blanket Chrome on its own profile, and the Mac's set-up Chrome, the
  // same way (blanketProfiles: a link there is refused).
  const profiles = [formsOf(paths.profile), ...blanketProfiles(paths.state, log, "service stop --all").map((b) => b.profile)];
  for (const profile of profiles) stopped.push(...await s.stopProfile(profile));
  // The blanket folder goes only in a state folder of this service; a link there is unlinked, its target stays.
  deleteBlanket(paths.state, procs.uid, { log, name: "service stop --all", platform: d.platform });

  // Xvfb: the record's (its display and the X auth file), then any other with the X auth file; a program named Xvfb only.
  const xauth = formsOf(paths.xauth);
  const authOf = (pid: number) => (procs.programIs(pid, "Xvfb") ? s.argFor(pid, "", xauth) : null);
  const xvfbs = new Map<number, string[]>();
  const r = readRecord(paths.unitFile);
  const rec = r.kind === "ok" ? r.record : {};
  const pid = intOf(rec.xvfb_pid), display = intOf(rec.display);
  const recAuth = pid !== null && display !== null ? authOf(pid) : null;
  if (recAuth !== null && procs.holds(pid!, [`:${display}`, recAuth])) xvfbs.set(pid!, [`:${display}`, recAuth]);
  for (const p of procs.pids()) { if (xvfbs.has(p)) continue; const a = authOf(p); if (a !== null) xvfbs.set(p, [a]); }
  if (xvfbs.size) {
    await s.stop(xvfbs, [...xvfbs.keys()], "Xvfb");
    stopped.push(...[...xvfbs.keys()].map((p): [string, number] => ["Xvfb", p]));
  }
  return stopped;
}
