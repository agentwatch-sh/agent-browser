// `agent-browser service stop --blanket --state-folder FOLDER` (board ab-4wh.17; C11, the blanket profile; C12, the
// command): after a crash of the service (a SIGKILL, the out-of-memory killer) the blanket Chrome stops at once, not at
// the service's next start. agentwatch runs it: on Linux the unit's ExecStopPost (systemd runs it also after a SIGKILL or
// an out-of-memory kill), and on both systems the daemon, once, when the control door drops with no stop that it asked
// for (launchd has no ExecStopPost).
//
// It does what the service's start does for the blanket profile (blanket/chrome.ts and blanket/template.ts, `sweep`),
// with stop --all's parts (stop-all.ts): it stops each Chrome of this user on the blanket profile, and on the Mac the
// set-up Chrome on the blanket template's profile (the template stays), and it deletes `<state>/blanket` (no link
// followed). It reads no pid file and no other state of the dead service (the state folder's mark of stop --all still
// applies: `unit.json`, or on the Mac also `agent-package-blanket/`). It never stops the main Chrome, the unit's Xvfb or a
// Chrome on another profile (the operator's Chrome among them).
//
// A live service. The daemon can run it while the service still runs (a broken connection, a daemon restart). So before
// it acts, and again right before each round of signals and before the delete, it reads the processes of this user: a
// process whose arguments hold `service` and `--state-folder` with the state folder (as given, or by its real path; on
// the Mac in any case) is a service that runs, and then it stops and deletes nothing (more). A socket file plays no part:
// one that a SIGKILL left is no sign of a live service. The reads fail safe: when the processes cannot be listed, when
// /proc can hide a process of this user (a hidepid mount option of /proc: the service is non-dumpable, so hidepid hides
// it or refuses its reads; or subset=pid, which hides no process but is refused too), when a read of a process fails for
// another reason than its end (EPERM, EACCES), when the user of a process or the arguments of a process of this user that
// can be the service (its program is node, or cannot be read) cannot be read, or when a service names its state folder
// by a relative path, it cannot tell, and it stops nothing. A process that ends during a read is none (board ab-4wh.26):
// one that is gone or a zombie, and on Linux one in its exit (PF_EXITING), whose arguments and program went with its
// memory before it is a zombie.
//
// The exit codes (STOP_BLANKET_EXIT): 0 when it stopped what it found or found nothing (after a normal stop the service's
// own stop ended the blanket Chrome); 1 when a Chrome on the profiles still runs or the folder is still there after its
// acts; 2 a refused argument (the CLI's usage error); 3 a refused state folder (stop --all's rule, stateFolderRefusal);
// 4 a service runs on the state folder; 5 it cannot tell whether one runs. Each of 2 (the CLI's), 3, 4 and 5 has exactly
// one line on the log (standard error); 0 and 1 have a line for each link that it refuses (blanketProfiles), and 1 also a
// line for each thing that is left (a delete that fails among them); no line names a path. The standard output's line
// names only a root Chrome that got a signal and has ended, and the delete.

import { basename, isAbsolute, join } from "node:path";
import type { Procs } from "./procs.ts";
import { realOf, type UnitPaths } from "./paths.ts";
import { blanketProfiles, deleteBlanket, kindAt, stateFolderRefusal, stopper, type StopAllDeps } from "./stop-all.ts";

export const STOP_BLANKET = "service stop --blanket";

export const STOP_BLANKET_EXIT = Object.freeze({ done: 0, left: 1, usage: 2, folder: 3, live: 4, unknown: 5 });

/** What the reads of the processes say about a service on the state folder. */
export type ServiceRead = { kind: "none" } | { kind: "live"; pid: number } | { kind: "unknown"; why: string };

/**
 * Whether an agent-browser service runs on `state` (board ab-4wh.17): a process of this user (not this one) that is no
 * zombie, whose arguments hold `service` and `--state-folder <folder>` or `--state-folder=<folder>` that names `state`, as
 * given or by its real path (on the Mac in any case: its disk ignores case). A run of `service stop` (its arguments hold
 * `--blanket` or `--all`, which a service's own arguments never hold) is no service. It fails safe: "unknown" when the
 * processes cannot be listed, when /proc can hide a process of this user (a hidepid mount option of /proc: the
 * non-dumpable service is then hidden or unreadable; or subset=pid), when a read of a process fails for another reason
 * than its end, when the user or the arguments of a process that can be the service cannot be read, or when a service
 * names its state folder by a relative path. A process that ends during the reads is none: gone, a zombie, or in its
 * exit (board ab-4wh.26).
 */
export function serviceOn(state: string, procs: Procs, platform: NodeJS.Platform = process.platform): ServiceRead {
  let pids: number[];
  try { pids = procs.pids(); } catch (e) { return { kind: "unknown", why: `the processes cannot be listed: ${(e as Error).message}` }; }
  // Every box has more processes than pid 1 and this one (on Linux kthreadd, pid 2): an empty list is a failed read.
  if (!pids.length) return { kind: "unknown", why: "the processes cannot be listed" };
  // hidepid=2 or 4 does not list the non-dumpable service at all, and hidepid=1 refuses its reads (board ab-4wh.17, I1).
  const mount = procs.procMountFault();
  if (mount !== null) return { kind: "unknown", why: mount };
  // A read that fails for another reason than the pid's end (EACCES, for example) is no sign that the pid is gone.
  const fault = (pid: number): ServiceRead | null => {
    const f = procs.readFault(pid);
    return f === null ? null : { kind: "unknown", why: `a read of pid ${pid} fails (${f})` };
  };
  // Board ab-4wh.26: a process that has ended is none: gone, a zombie, or in its exit (a short-lived process of this user
  // that ends during the scan, the service's own end too). One in its exit runs no code of its own; its memory, and with
  // it its arguments and its exe link, goes before it is a zombie. Only for a process whose arguments read empty.
  const ended = (pid: number) => procs.exiting(pid) || procs.stat(pid) === null;
  const fold = (p: string) => (platform === "darwin" ? p.toLowerCase() : p);
  const forms = new Set([fold(state), fold(realOf(state))]);
  for (const pid of pids) {
    if (procs.stat(pid) === null) { const f = fault(pid); if (f) return f; continue; }
    const uid = procs.realUid(pid);
    if (uid === null) {
      const f = fault(pid);
      if (f) return f;
      if (procs.stat(pid) === null) continue;
      return { kind: "unknown", why: `the user of pid ${pid} cannot be read` };
    }
    if (uid !== procs.uid) continue;
    const argv = procs.cmdline(pid);
    if (!argv.length) {
      const f = fault(pid);
      if (f) return f;
      if (ended(pid)) continue;
      // The service's program is node: a process with another program is never the service.
      const exe = procs.exe(pid);
      if (exe !== null && !/node/i.test(basename(exe))) continue;
      // Read again: a process whose exe link went because it ended meanwhile is none too.
      if (ended(pid)) continue;
      return { kind: "unknown", why: `the arguments of pid ${pid} cannot be read` };
    }
    if (!argv.includes("service") || argv.includes("--blanket") || argv.includes("--all")) continue;
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      const v = a === "--state-folder" ? argv[i + 1] : a.startsWith("--state-folder=") ? a.slice("--state-folder=".length) : undefined;
      if (v === undefined) continue;
      if (!isAbsolute(v)) return { kind: "unknown", why: `the service of pid ${pid} names its state folder by a relative path` };
      if (forms.has(fold(v)) || forms.has(fold(realOf(v)))) return { kind: "live", pid };
    }
  }
  return { kind: "none" };
}

export type StopBlanketDeps = Omit<StopAllDeps, "procs" | "may" | "paths"> & {
  paths: Pick<UnitPaths, "state">;
  /** The process reads (main.ts, macProcsOrWhy): /proc on Linux, libSystem on the Mac; `failed` when they cannot load. */
  procs: () => Promise<Procs | { failed: string }>;
  /** The uid of the state folder's check before the process reads (this process's uid by default). */
  uid?: number;
};

/** The exit code; each root Chrome that got a signal and has ended (as [label, pid]); whether the folder went. */
export type StopBlanketResult = { code: number; stopped: [string, number][]; deleted: boolean };

/**
 * `service stop --blanket` (board ab-4wh.17). Its log has one line for each exit code but 0 and 1: the lines of its acts
 * (a link at the blanket folder, a delete that fails) wait until the end, and a halt (a service that starts during the
 * acts) drops them, so that exit 4 or 5 has its one reason line only.
 */
export async function stopBlanket(d: StopBlanketDeps): Promise<StopBlanketResult> {
  const log = d.log ?? (() => {});
  const state = d.paths.state;
  const end = (code: number, stopped: [string, number][] = [], deleted = false): StopBlanketResult => ({ code, stopped, deleted });
  const refused = stateFolderRefusal(realOf(state), d.uid ?? process.getuid?.() ?? -1, d.platform);
  if (refused !== null) { log(`${STOP_BLANKET}: the state folder is no state folder of the agent browser (${refused}): nothing is stopped or deleted`); return end(STOP_BLANKET_EXIT.folder); }
  let procs: Procs;
  try {
    const p = await d.procs();
    if ("failed" in p) throw new Error(p.failed);
    procs = p;
  } catch (e) {
    log(`${STOP_BLANKET}: it cannot tell whether a service runs on the state folder (the processes cannot be read: ${(e as Error).message}): nothing is stopped or deleted`);
    return end(STOP_BLANKET_EXIT.unknown);
  }
  const platform = d.platform ?? process.platform;
  const said = (r: ServiceRead, more: boolean) => {
    const what = more ? "nothing more is stopped or deleted" : "nothing is stopped or deleted";
    if (r.kind === "live") { log(`${STOP_BLANKET}: a service runs on the state folder (pid ${r.pid}): ${what}`); return STOP_BLANKET_EXIT.live; }
    if (r.kind === "unknown") { log(`${STOP_BLANKET}: it cannot tell whether a service runs on the state folder (${r.why}): ${what}`); return STOP_BLANKET_EXIT.unknown; }
    return STOP_BLANKET_EXIT.done;
  };
  const first = serviceOn(state, procs, platform);
  if (first.kind !== "none") return end(said(first, false));
  // Again right before each round of signals and before the delete: a service that starts meanwhile stops the act.
  const halt: { by: ServiceRead | null } = { by: null };
  const may = () => {
    if (halt.by) return false;
    const r = serviceOn(state, procs, platform);
    if (r.kind === "none") return true;
    halt.by = r;
    return false;
  };
  const lines: string[] = [];
  const acts = (line: string) => { lines.push(line); };
  const s = stopper({ ...d, paths: d.paths as UnitPaths, procs, may, log: acts });
  const profiles = blanketProfiles(state, acts, STOP_BLANKET);
  const signalled: [string, number][] = [];
  for (const b of profiles) signalled.push(...await s.stopProfile(b.profile, b.what === "template" ? "set-up Chrome" : "Chrome"));
  const folder = deleteBlanket(state, procs.uid, { log: acts, name: STOP_BLANKET, platform, may });
  // A root that got a signal and has ended (the stdout line names no other one).
  const stopped = signalled.filter(([, pid]) => !procs.alive(pid));
  if (halt.by) return end(said(halt.by, true), stopped, folder === "deleted");
  for (const line of lines) log(line);
  // What is left after the acts: a Chrome on the profiles, or the folder.
  let code: number = STOP_BLANKET_EXIT.done;
  for (const b of profiles) for (const pid of s.onProfile(b.profile).keys()) {
    log(`${STOP_BLANKET}: a Chrome on the ${b.what === "template" ? "blanket template's" : "blanket"} profile still runs (pid ${pid})`);
    code = STOP_BLANKET_EXIT.left;
  }
  if (folder === "failed" || folder === "refused") code = STOP_BLANKET_EXIT.left;
  else if (kindAt(join(realOf(state), "blanket")) !== "none") { log(`${STOP_BLANKET}: the blanket folder is still there`); code = STOP_BLANKET_EXIT.left; }
  return end(code, stopped, folder === "deleted");
}

/** The command's one line on standard output when a Chrome that it signalled has ended or the folder went, else "". */
export function stopBlanketLine(r: StopBlanketResult): string {
  const parts: string[] = [];
  if (r.stopped.length) parts.push(`Stopped the blanket Chrome: ${r.stopped.map(([n, p]) => `${n} pid ${p}`).join(", ")}`);
  if (r.deleted) parts.push(parts.length ? "deleted the blanket folder" : "Deleted the blanket folder");
  return parts.length ? `${parts.join("; ")}\n` : "";
}
