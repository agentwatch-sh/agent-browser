// The test processes' temp folders: each folder that tempDir() makes (or atEnd() records) goes at the process's exit,
// and also when SIGTERM, SIGINT or SIGHUP ends the process (a stopped run, the timeout of a test wrapper, a closed
// terminal). The default action of such a signal ends a node process with no "exit" listener and no test's finally or
// after(): thousands of /tmp/ab-* folders stayed on the Linux server that way.

import { mkdtempSync, rmSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";

/** Each recorded folder and what removes it, until the test removed it itself (done) or the process ends. */
const ends = new Map<string, () => void>();
const SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
let armed = false;

function endAll(): void {
  for (const [dir, end] of ends) {
    ends.delete(dir);
    try { end(); } catch {}
  }
}

/** The signal ends the process with its usual exit code (128 + its number), after the folders went. Another listener
 *  of the signal (a test's own, or the code under test) decides itself: when it ends the process, the exit removes
 *  the folders. */
function onSignal(signal: NodeJS.Signals): void {
  if (process.listenerCount(signal) > 1) return;
  endAll();
  process.exit(128 + constants.signals[signal]);
}

function arm(): void {
  if (armed) return;
  armed = true;
  process.on("exit", endAll);
  for (const s of SIGNALS) process.on(s, onSignal);
}

/** `end` removes `dir` (and whatever else of the test belongs to it) at the process's exit or at one of the signals. */
export function atEnd(dir: string, end: () => void = () => rmSync(dir, { recursive: true, force: true })): void {
  ends.set(dir, end);
  arm();
}

/** The test removed `dir` itself: the end leaves it alone. */
export function done(dir: string): void { ends.delete(dir); }

/** A new temp folder `<tmpdir>/<prefix>XXXXXX` (as mkdtempSync makes it) that goes at the process's end. */
export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  atEnd(dir);
  return dir;
}
