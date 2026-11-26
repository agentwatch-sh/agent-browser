// `agent-browser service stop --blanket --state-folder FOLDER` (board ab-4wh.17; C11, the blanket profile; C12, the
// command): after a crash of the service (a SIGKILL, the out-of-memory killer) the blanket Chrome stops at once, not at
// the service's next start. agentwatch runs it: on Linux the unit's ExecStopPost (systemd runs it also after a SIGKILL or
// an out-of-memory kill), and on both systems the daemon, once, when the control door drops with no stop that it asked
// for (launchd has no ExecStopPost).
//
// It does what the service's start does for the blanket profile (blanket/chrome.ts and blanket/template.ts, `sweep`),
// with stop --all's parts (stop-all.ts): it stops each Chrome of this user on the blanket profile, and on the Mac the
// set-up Chrome on the blanket template's profile (the template stays), and it deletes `<state>/blanket` (no link
// followed). It needs no file of the dead service. It never stops the main Chrome, the unit's Xvfb or a Chrome on another
// profile (the operator's Chrome among them).
//
// A live service. The daemon can run it while the service still runs (a broken connection, a daemon restart). So before
// it acts, and again right before each round of signals and before the delete, it reads the processes of this user: a
// process whose arguments hold `service` and `--state-folder` with the state folder (as given, or by its real path; on
// the Mac in any case) is a service that runs, and then it stops and deletes nothing (more). A socket file plays no part:
// one that a SIGKILL left is no sign of a live service. The reads fail safe: when the processes cannot be listed, when
// the arguments of a process of this user that can be the service (its program is node, or cannot be read) cannot be
// read, or when a service names its state folder by a relative path, it cannot tell, and it stops nothing.
//
// The exit codes (STOP_BLANKET_EXIT): 0 when it stopped what it found or found nothing (after a normal stop the service's
// own stop ended the blanket Chrome); 1 when a Chrome on the profiles still runs or the folder is still there after its
// acts; 2 a refused argument (the CLI's usage error); 3 a refused state folder (stop --all's rule, stateFolderRefusal);
// 4 a service runs on the state folder; 5 it cannot tell whether one runs. Each of 1, 3, 4 and 5 has one line on the log
// (standard error), which names no path.

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
 * processes cannot be listed, when the user or the arguments of a process that can be the service cannot be read, or when
 * a service names its state folder by a relative path.
 */
export function serviceOn(state: string, procs: Procs, platform: NodeJS.Platform = process.platform): ServiceRead {
  let pids: number[];
  try { pids = procs.pids(); } catch (e) { return { kind: "unknown", why: `the processes cannot be listed: ${(e as Error).message}` }; }
  // Every box has more processes than pid 1 and this one (on Linux kthreadd, pid 2): an empty list is a failed read.
  if (!pids.length) return { kind: "unknown", why: "the processes cannot be listed" };
  const fold = (p: string) => (platform === "darwin" ? p.toLowerCase() : p);
  const forms = new Set([fold(state), fold(realOf(state))]);
  for (const pid of pids) {
    if (procs.stat(pid) === null) continue;
    const uid = procs.realUid(pid);
    if (uid === null) {
      if (procs.stat(pid) === null) continue;
      return { kind: "unknown", why: `the user of pid ${pid} cannot be read` };
    }
    if (uid !== procs.uid) continue;
    const argv = procs.cmdline(pid);
    if (!argv.length) {
      if (procs.stat(pid) === null) continue;
      // The service's program is node: a process with another program is never the service.
      const exe = procs.exe(pid);
      if (exe !== null && !/node/i.test(basename(exe))) continue;
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

export type StopBlanketResult = { code: number; stopped: [string, number][]; deleted: boolean };

/** `service stop --blanket` (board ab-4wh.17): its exit code, the Chromes that it stopped first, and whether the folder went. */
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
  const s = stopper({ ...d, paths: d.paths as UnitPaths, procs, may, log });
  const profiles = blanketProfiles(state, log, STOP_BLANKET);
  const stopped: [string, number][] = [];
  for (const b of profiles) stopped.push(...await s.stopProfile(b.profile, b.what === "template" ? "set-up Chrome" : "Chrome"));
  const folder = deleteBlanket(state, procs.uid, { log, name: STOP_BLANKET, platform, may });
  if (halt.by) return end(said(halt.by, true), stopped, folder === "deleted");
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

/** The command's one line on standard output when it stopped or deleted something, else "". */
export function stopBlanketLine(r: StopBlanketResult): string {
  const parts: string[] = [];
  if (r.stopped.length) parts.push(`Stopped the blanket Chrome: ${r.stopped.map(([n, p]) => `${n} pid ${p}`).join(", ")}`);
  if (r.deleted) parts.push(parts.length ? "deleted the blanket folder" : "Deleted the blanket folder");
  return parts.length ? `${parts.join("; ")}\n` : "";
}
