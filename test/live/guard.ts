// The live harnesses' guard for agent-browser's Node harnesses (board ab-v16.78): one harness at a time for each
// user, and no Xvfb, Chromium, stand-in daemon, relay or proxy of a harness after its driver ends, also after a kill
// -9 of the driver. The guard is a process of its own, test/live/harness_guard.py (the same file is in
// chrome-extension); see its head for the lock, the records and the stop. A harness calls harnessGuard() before its
// first Xvfb or Chromium and starts nothing before it returns, and gives each process that it starts to track().
// The guard also records every process of the driver's tree every 0.5 s, so track() only closes that 0.5 s gap.
//
// Linux only: on another platform (the Mac checks run on the person's own screen and start no Xvfb) harnessGuard()
// returns a guard that does nothing, and says so.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Writable } from "node:stream";
import { fileURLToPath } from "node:url";

export const GUARD_PY = fileURLToPath(new URL("./harness_guard.py", import.meta.url));
/** The X displays that no harness takes, whatever its setting is: 0 (a desktop), 90 (agentwatch's agent browser on
 *  taylor, the operator's), 147, 190, 191, 192 (other programs' displays on taylor). The same list as
 *  RESERVED_DISPLAYS in harness_guard.py and chrome-extension's run.sh (test/harness-guard.test.ts compares them). */
export const RESERVED_DISPLAYS: readonly number[] = [0, 90, 147, 190, 191, 192];

export type HarnessGuard = {
  /** The guard's pid (0: no guard, not Linux). */
  pid: number;
  /** "locked": this harness holds the harness lock; "nested": its parent harness holds it; "off": not Linux. */
  mode: "locked" | "nested" | "off";
  /** Record a process that this harness started: the guard stops it after the driver's end. */
  track(pid: number | undefined, name: string): void;
};

/**
 * Wait for the harness lock (at most HARNESS_LOCK_WAIT s, default 1200; the guard writes one line on stderr while it
 * waits) and start the guard. On a refusal (the time ran out, or the guard could not start) it writes the reason on
 * stderr and exits 2: the harness started nothing. Children that this process starts later inherit
 * HARNESS_GUARD_HELD, so that a harness that a harness starts does not wait for its parent's lock.
 */
export async function harnessGuard(name: string): Promise<HarnessGuard> {
  if (process.platform !== "linux") {
    process.stderr.write(`harness-guard: ${name}: no guard on ${process.platform} (Linux only)\n`);
    return { pid: 0, mode: "off", track() {} };
  }
  // The pipe on fd 3 is the driver's end for the guard: the kernel closes it when this process ends in any way. (Not
  // stdin: Node closes a child's stdin when that child exits, and the guard's first process exits at once.)
  const child = spawn("python3", ["-I", "-B", GUARD_PY, "--name", name, "--driver", String(process.pid), "--channel-fd", "3"], { stdio: ["ignore", "pipe", "inherit", "pipe"] });
  const chan = child.stdio[3] as Writable & { unref(): void };
  chan.on("error", () => {});
  const line = await new Promise<string>((resolve) => {
    let got = "";
    child.once("error", (e) => resolve(`refused the guard did not start: ${e.message}`));
    const rl = createInterface({ input: child.stdout! });
    rl.once("line", (l) => { got = l; resolve(l); });
    rl.once("close", () => resolve(got || "refused the guard ended with no answer"));
  });
  const [mode, pid] = line.split(" ");
  if ((mode !== "locked" && mode !== "nested") || !/^\d+$/.test(pid ?? "")) {
    process.stderr.write(`${name}: ${line.replace(/^refused /, "")}\n`);
    process.exit(2);
  }
  child.stdout!.destroy();
  // The pipe stays open, but it must not keep this process alive.
  chan.unref();
  child.unref();
  process.env.HARNESS_GUARD_HELD = pid;
  return {
    pid: Number(pid),
    mode,
    track(p, what) {
      if (p) chan.write(`track ${p} ${what.replace(/[^\w.-]+/g, "-") || "process"}\n`);
    },
  };
}
