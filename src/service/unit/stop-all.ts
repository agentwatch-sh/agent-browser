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

import type { Procs } from "./procs.ts";
import { intOf, readRecord } from "./record.ts";
import type { UnitPaths } from "./paths.ts";
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

  // Chrome: every process on the profile; SIGTERM to each whose parent is not on the profile itself.
  const profileArg = `--user-data-dir=${paths.profile}`;
  const onProfile = procs.pids().filter((p) => procs.holds(p, [profileArg]));
  const tops = onProfile.filter((p) => !onProfile.includes(procs.stat(p)?.ppid ?? -1));
  if (onProfile.length) {
    await stop(new Map(onProfile.map((p) => [p, [profileArg]])), tops);
    stopped.push(...tops.map((p): [string, number] => ["Chrome", p]));
  }

  // Xvfb: the record's (its display and the X auth file), then any other with the X auth file; a program named Xvfb only.
  const isXvfb = (pid: number, markers: string[]) => procs.holds(pid, markers) && procs.programIs(pid, "Xvfb");
  const xvfbs = new Map<number, string[]>();
  const r = readRecord(paths.unitFile);
  const rec = r.kind === "ok" ? r.record : {};
  const pid = intOf(rec.xvfb_pid), display = intOf(rec.display);
  if (pid !== null && display !== null && isXvfb(pid, [`:${display}`, paths.xauth])) xvfbs.set(pid, [`:${display}`, paths.xauth]);
  for (const p of procs.pids()) if (!xvfbs.has(p) && isXvfb(p, [paths.xauth])) xvfbs.set(p, [paths.xauth]);
  if (xvfbs.size) {
    await stop(xvfbs, [...xvfbs.keys()], "Xvfb");
    stopped.push(...[...xvfbs.keys()].map((p): [string, number] => ["Xvfb", p]));
  }
  return stopped;
}
