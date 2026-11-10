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
// A pid's command line is read again right before each signal, so a reused pid is never signalled. It writes no file:
// only the owner writes the unit record.
//
// The folder can come in another form than the one that the unit's processes got (through a link, review-106 note 9):
// a process's profile argument and the Xvfb's X auth argument name the unit's file when they name it as given or when
// their real path (after links) is the real path of the unit's file. Only absolute paths count.

import { isAbsolute } from "node:path";
import type { Procs } from "./procs.ts";
import { intOf, readRecord } from "./record.ts";
import { realOf, type UnitPaths } from "./paths.ts";
import { KILL_WAIT_MS, TERM_GRACE_MS } from "./unit.ts";

export type StopAllDeps = { paths: UnitPaths; procs: Procs; kill?: (pid: number, sig: NodeJS.Signals) => void; clock?: () => number; sleep?: (ms: number) => Promise<void> };

/** Stop the unit; what was signalled first, as [program, pid]: each Chrome root, then each Xvfb. */
export async function stopAll(d: StopAllDeps): Promise<[string, number][]> {
  const { procs, paths } = d;
  const kill = d.kill ?? ((pid, sig) => process.kill(pid, sig));
  const clock = d.clock ?? (() => performance.now());
  const sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const stopped: [string, number][] = [];

  const stop = async (targets: Map<number, string[]>, first: number[], program?: string) => {
    const ours = (pid: number) => procs.holds(pid, targets.get(pid)!) && (program === undefined || procs.programIs(pid, program));
    const send = (pid: number, sig: NodeJS.Signals) => { if (ours(pid)) { try { kill(pid, sig); } catch {} } };
    for (const pid of first) send(pid, "SIGTERM");
    for (const [wait, last] of [[TERM_GRACE_MS, false], [KILL_WAIT_MS, true]] as const) {
      const end = clock() + wait;
      while ([...targets.keys()].some((p) => procs.alive(p)) && clock() < end) await sleep(100);
      if (last) break;
      for (const pid of targets.keys()) if (procs.alive(pid)) send(pid, "SIGKILL");
    }
  };

  // The argument of `pid` that names `file` (as given, or by its real path), after `prefix`; null when none does.
  const forms = (file: string) => new Set([file, realOf(file)]);
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
  const profile = forms(paths.profile);
  const onProfile = new Map<number, string[]>();
  for (const p of procs.pids()) { const a = argFor(p, "--user-data-dir=", profile); if (a !== null) onProfile.set(p, [a]); }
  const tops = [...onProfile.keys()].filter((p) => !onProfile.has(procs.stat(p)?.ppid ?? -1));
  if (onProfile.size) {
    await stop(onProfile, tops);
    stopped.push(...tops.map((p): [string, number] => ["Chrome", p]));
  }

  // Xvfb: the record's (its display and the X auth file), then any other with the X auth file; a program named Xvfb only.
  const xauth = forms(paths.xauth);
  const authOf = (pid: number) => (procs.programIs(pid, "Xvfb") ? argFor(pid, "", xauth) : null);
  const xvfbs = new Map<number, string[]>();
  const r = readRecord(paths.unitFile);
  const rec = r.kind === "ok" ? r.record : {};
  const pid = intOf(rec.xvfb_pid), display = intOf(rec.display);
  const recAuth = pid !== null && display !== null ? authOf(pid) : null;
  if (recAuth !== null && procs.holds(pid!, [`:${display}`, recAuth])) xvfbs.set(pid!, [`:${display}`, recAuth]);
  for (const p of procs.pids()) { if (xvfbs.has(p)) continue; const a = authOf(p); if (a !== null) xvfbs.set(p, [a]); }
  if (xvfbs.size) {
    await stop(xvfbs, [...xvfbs.keys()], "Xvfb");
    stopped.push(...[...xvfbs.keys()].map((p): [string, number] => ["Xvfb", p]));
  }
  return stopped;
}
