// The input harness's cleanup (board ab-t30.2, fix round 1 of review-97): on a signal (SIGINT, SIGTERM, SIGHUP), at a
// failed start and at the run's exit, the run stops the processes that it started, by their pids, and then removes the
// folders and files that it made (its Chromium profiles, agent-browser's state folder, its socket folder, its run
// folder when it holds no results). Unit-tested in test/input-harness.test.ts with stand-in children and signals.

import { rmSync } from "node:fs";

/** A process that the run started (a ChildProcess). */
export type Child = { pid?: number; exitCode: number | null; signalCode: NodeJS.Signals | null; kill(signal?: NodeJS.Signals): boolean };
const running = (c: Child) => c.exitCode === null && c.signalCode === null;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SIGNAL_NUMBERS: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };

export class Cleanup {
  private readonly kids: Child[] = [];
  private readonly paths: { path: string; when?: () => boolean }[] = [];
  private readonly termMs: number;
  private readonly killMs: number;
  private stopping: Promise<void> | null = null;
  /** `termMs`: the wait after SIGTERM before SIGKILL; `killMs`: the wait after SIGKILL. */
  constructor(o: { termMs?: number; killMs?: number } = {}) { this.termMs = o.termMs ?? 5000; this.killMs = o.killMs ?? 2000; }
  /** A child to stop (by its pid, through its handle). */
  child(c: Child): void { this.kids.push(c); }
  /** A path to remove after the children are gone, last first; `when` says whether to remove it at that moment (default: always). */
  path(p: string, when?: () => boolean): void { this.paths.push({ path: p, when }); }
  private remove(): void {
    for (const { path, when } of [...this.paths].reverse()) {
      try { if (!when || when()) rmSync(path, { recursive: true, force: true }); } catch { /* the next path */ }
    }
  }
  /** SIGTERM to each child that runs, SIGKILL to those left after termMs, a wait of at most killMs, then the paths. */
  stop(): Promise<void> {
    this.stopping ??= (async () => {
      for (const c of this.kids) if (running(c)) c.kill("SIGTERM");
      for (let t = 0; t < this.termMs && this.kids.some(running); t += 50) await sleep(50);
      for (const c of this.kids) if (running(c)) c.kill("SIGKILL");
      for (let t = 0; t < this.killMs && this.kids.some(running); t += 50) await sleep(50);
      this.remove();
    })();
    return this.stopping;
  }
  /** At once, with no wait (the exit handler): SIGTERM to each child that runs, then the paths. */
  stopNow(): void {
    for (const c of this.kids) if (running(c)) c.kill("SIGTERM");
    this.remove();
  }
  /** On each signal: stop(), then exit with 128 + the signal's number. */
  onSignals(exit: (code: number) => void = (code) => process.exit(code), signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"]): void {
    for (const sig of signals) process.on(sig, () => { void this.stop().then(() => exit(128 + (SIGNAL_NUMBERS[sig] ?? 0))); });
  }
}
