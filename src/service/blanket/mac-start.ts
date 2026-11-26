// The Mac's starts of a Chrome on a profile of the blanket part (board ab-4wh.16; the design
// docs/superpowers/specs/2026-11-26-blanket-profile-mac-design.md, sections 13.2 and 13.3; C12, the blanket profile on the
// Mac): the blanket Chrome and the blanket template's set-up Chrome. Both start through `open -n` (the unit's MacStart),
// so neither is the service's child: the service finds the new main process on its profile, as the unit finds the agent
// Chrome on the Mac (unit.ts, startMacChrome), holds it by pid and start time, and signals it only after its start time
// and its whole `--user-data-dir=` argument are read again.

import { chromeSwitchName } from "../../agent.ts";
import { PROXY_SWITCHES } from "./proxy.ts";
import { realOf } from "../unit/paths.ts";
import type { Procs } from "../unit/procs.ts";
import { KILL_WAIT_MS, TERM_GRACE_MS } from "../unit/unit.ts";

/** How long a start waits after `open` for the new Chrome's main process on its profile (as the unit's MAC_FIND_MS). */
export const MAC_FIND_MS = 15_000;
const POLL_MS = 50;

/** A Chrome that the blanket part holds: its main process by pid and start time. */
export type Held = { pid: number; start: number | null };
export type MacProcReads = Pick<Procs, "pids" | "holds" | "cmdline" | "stat" | "exe">;
type Time = { clock: () => number; sleep: (ms: number) => Promise<void> };

/** The main processes on a profile (`marker`: its whole `--user-data-dir=` argument): no `--type=` argument. */
export function mainsOn(procs: MacProcReads, marker: string): number[] {
  return procs.pids().filter((pid) => procs.holds(pid, [marker]) && !procs.cmdline(pid).some((a) => a.startsWith("--type=")));
}

/** `pid` runs the app's own binary: its executable is inside the bundle, as given or after links. */
export function runsBundle(procs: Pick<Procs, "exe">, pid: number, bundle: string): boolean {
  const exe = procs.exe(pid);
  return exe !== null && [bundle, realOf(bundle)].some((b) => exe.startsWith(`${b}/`));
}

/**
 * The new main process on the profile after `open`: the one process with the marker and no `--type=`, which runs the app's
 * binary, within `ms`. Its error names what it found.
 */
export async function findMacMain(o: { procs: MacProcReads; marker: string; bundle: string; what: string; ms?: number } & Time): Promise<Held | { error: string }> {
  const end = o.clock() + (o.ms ?? MAC_FIND_MS);
  for (;;) {
    const found = mainsOn(o.procs, o.marker);
    if (found.length > 1) return { error: `${found.length} Chromes run on the ${o.what} after the start` };
    if (found.length === 1) {
      if (!runsBundle(o.procs, found[0], o.bundle)) return { error: `the process on the ${o.what} (pid ${found[0]}) does not run ${o.bundle}` };
      return { pid: found[0], start: o.procs.stat(found[0])?.start ?? null };
    }
    if (o.clock() >= end) return { error: `the ${o.what === "blanket profile" ? "blanket" : "set-up"} Chrome did not come up on its profile within ${(o.ms ?? MAC_FIND_MS) / 1000} s after open` };
    await o.sleep(POLL_MS);
  }
}

/**
 * The process's arguments (`argv`, as KERN_PROCARGS2 gives them on the Mac) hold each of `flags` exactly, and no other
 * value of the same switch (Chrome reads the last one of a switch that comes twice), and no other switch that would take
 * Chrome past the proxy (proxy.ts, PROXY_SWITCHES: --no-proxy-server, --proxy-pac-url, --proxy-auto-detect, a bypass
 * list, an unpacked extension; the review's m1): the address proxy's flags of this start reached the Chrome, and nothing
 * overrides them (C12, the blanket profile on the Mac).
 */
export function holdsFlags(argv: readonly string[], flags: readonly string[]): boolean {
  for (const f of flags) {
    const name = chromeSwitchName(f);
    if (!argv.includes(f)) return false;
    if (argv.some((a) => a !== f && chromeSwitchName(a) === name)) return false;
  }
  return !argv.some((a) => !flags.includes(a) && PROXY_SWITCHES.includes(chromeSwitchName(a) ?? ""));
}

/** `c` runs: its pid is there with the same start time. */
export function aliveHeld(procs: Pick<Procs, "stat">, c: Held | null): boolean {
  if (!c) return false;
  const st = procs.stat(c.pid);
  return st !== null && (c.start === null || st.start === c.start);
}

/**
 * Stop `c` (a Chrome of the blanket part's Mac starts): SIGTERM, then SIGKILL after the grace, each only while it runs
 * with its start time and still holds `marker`. True when a signal went.
 */
export async function stopHeld(o: { procs: Pick<Procs, "stat" | "holds">; kill: (pid: number, sig: NodeJS.Signals) => void; c: Held; marker: string } & Time): Promise<boolean> {
  const signal = (sig: NodeJS.Signals) => {
    if (!aliveHeld(o.procs, o.c) || !o.procs.holds(o.c.pid, [o.marker])) return false;
    try { o.kill(o.c.pid, sig); return true; } catch { return false; }
  };
  if (!signal("SIGTERM")) return false;
  const wait = async (ms: number) => { const end = o.clock() + ms; while (aliveHeld(o.procs, o.c) && o.clock() < end) await o.sleep(POLL_MS); return !aliveHeld(o.procs, o.c); };
  if (!(await wait(TERM_GRACE_MS))) { signal("SIGKILL"); await wait(KILL_WAIT_MS); }
  return true;
}
