// The owner rule of the Chrome unit, the service's side (the self-contained design, section 13.2; board ab-v16.94.3).
// The state of the service's own systemd unit decides who owns, and only systemd changes that state:
//
// - The service owns while its unit is `active`, `activating` (also between automatic restarts) or `deactivating`,
//   and the unit's MainPID is this process (a copy that a person starts by hand while the unit runs never owns).
// - The service runs only while it owns: it is never a passive process. At its start it reads the state once, after
//   its control door opened (build note 8) and before any owner part; when it does not own, it stops and exits.
// - It reads the state again at each 5 s tick of its supervisor and right before each owner part that can stop or
//   start Chrome (a start, a supervisor's restart, a Chrome move, the watch's stop). When it finds that it no longer
//   owns, it stops its owner parts at once and exits; Chrome and Xvfb stay for the next owner.
// - A read that fails (no answer of systemd in time, a unit that systemd does not know) is not ownership: the service
//   fails closed.
//
// The reader is one small function, `UnitStateReader`: one `systemctl --user show` of ActiveState, SubState and
// MainPID in one call. The tests give a fake reader. `--test` (the live harness only) owns with no systemd unit.

import { execFile } from "node:child_process";

export const OWNING_STATES: readonly string[] = ["active", "activating", "deactivating"];

export type UnitState = { active: string; sub: string; mainPid: number };
/** One read of the service's own unit; null when the read fails. */
export type UnitStateReader = () => Promise<UnitState | null>;

/** The service's own unit: agentwatch's install names it (the design, section 5.2). */
export const SERVICE_UNIT = "agent-browser.service";

/** The reader of the user's systemd: `systemctl --user show <unit> --property=ActiveState,SubState,MainPID` (one call). */
export function systemdUnitState(unit: string, o: { systemctl?: string; timeoutMs?: number } = {}): UnitStateReader {
  return () => new Promise((resolve) => {
    execFile(o.systemctl ?? "/usr/bin/systemctl", ["--user", "show", unit, "--property=ActiveState,SubState,MainPID,LoadState"],
      { timeout: o.timeoutMs ?? 2000, killSignal: "SIGKILL", encoding: "utf8" }, (e, stdout) => {
        if (e) return resolve(null);
        const kv = new Map<string, string>();
        for (const line of String(stdout).split("\n")) { const i = line.indexOf("="); if (i > 0) kv.set(line.slice(0, i), line.slice(i + 1).trim()); }
        const active = kv.get("ActiveState"), sub = kv.get("SubState"), main = kv.get("MainPID"), load = kv.get("LoadState");
        if (!active || sub === undefined || !main || !/^[0-9]+$/.test(main) || load === "not-found") return resolve(null);
        resolve({ active, sub, mainPid: Number(main) });
      });
  });
}

/** `--test`: the service owns with no systemd unit (the live harness only; refused with any default folder). */
export const testOwner = (pid = process.pid): UnitStateReader => async () => ({ active: "active", sub: "running", mainPid: pid });

/** The rule: owns, or why not. */
export function ownership(state: UnitState | null, pid: number): { owns: true } | { owns: false; why: string } {
  if (state === null) return { owns: false, why: "the state of its own unit cannot be read" };
  if (!OWNING_STATES.includes(state.active)) return { owns: false, why: `its own unit is ${state.active}` };
  if (state.mainPid !== pid) return { owns: false, why: `it is not the MainPID of its own unit (${state.mainPid})` };
  return { owns: true };
}

/** The owner rule of one service process: each check reads the state; the first "no" is final, and `lost` resolves. */
export class Owner {
  private readonly read: UnitStateReader;
  private readonly pid: number;
  private readonly log: (line: string) => void;
  private lostWhy: string | null = null;
  private onLost!: (why: string) => void;
  /** Resolves with the reason when the service no longer owns. */
  readonly lost: Promise<string>;

  constructor(read: UnitStateReader, log: (line: string) => void, pid = process.pid) {
    this.read = read; this.log = log; this.pid = pid;
    this.lost = new Promise((r) => { this.onLost = r; });
  }

  get owns(): boolean { return this.lostWhy === null; }

  /** Read the state now; true while the service owns. `what` names the owner part, for the log. */
  async check(what: string): Promise<boolean> {
    if (this.lostWhy !== null) return false;
    const r = ownership(await this.read().catch(() => null), this.pid);
    if (r.owns) return true;
    if (this.lostWhy === null) {
      this.lostWhy = r.why;
      this.log(`owner: the service does not own the Chrome unit (${r.why}), before ${what}; it stops its owner parts`);
      this.onLost(r.why);
    }
    return false;
  }
}
