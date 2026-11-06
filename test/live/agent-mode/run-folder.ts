// The end of the agent-mode live suite's run folder (run.ts; board ab-v16.64): what the run removes after it stopped
// its children and wrote results.json. Pure, so that `npm test` checks it (test/agent-live-run-folder.test.ts).

import { basename, dirname, resolve } from "node:path";

export type RunEnd = {
  /** The run folder (RUN). */
  run: string;
  /** True when the run made the run folder itself: no RUN in the environment. */
  ownRun: boolean;
  /** The large parts that the run made in the run folder, as the run recorded them (never from a listing of the
   *  folder): each one is a folder that the run's own mkdir made, a mkdir that fails when anything is at the path. */
  made: string[];
  /** KEEP_RUN from the environment. */
  keep?: string;
  /** The count of the cases that failed. */
  failed: number;
  /** The reason of the abort (an error or a signal) when the run did not get to its end; also an empty one is an abort. */
  aborted?: string;
  /** The count of the run's processes that still run after the stop (its children, its relay, its short calls, the
   *  group peer's tmux servers). */
  running: number;
};

/** The paths that the run removes at its end, whether that is the whole run folder, and the line that it prints. */
export type Removal = { remove: string[]; whole: boolean; line: string };

/** KEEP_RUN=1 keeps everything: any value but an empty one or 0. */
export const keepRun = (v: string | undefined) => v !== undefined && v !== "" && v !== "0";

/**
 * What the run removes: nothing with KEEP_RUN or while a process of the run still runs; the whole run folder when the
 * run made that folder itself and no case failed and the run was not aborted; else the large parts that it made,
 * each one an entry of the run folder (never the folder itself, nothing above it or elsewhere), and logs/ and
 * results.json stay.
 */
export function runFolderEnd(o: RunEnd): Removal {
  const run = resolve(o.run);
  if (keepRun(o.keep)) return { remove: [], whole: false, line: `KEEP_RUN=${o.keep}: the run removed nothing in ${run}` };
  if (o.running > 0) {
    const n = o.running === 1 ? "1 process of the run still runs" : `${o.running} processes of the run still run`;
    return { remove: [], whole: false, line: `${n}: the run removed nothing in ${run}` };
  }
  if (o.ownRun && o.failed === 0 && o.aborted === undefined && dirname(run) !== run)
    return { remove: [run], whole: true, line: `removed the run folder ${run}: no case failed (KEEP_RUN=1 keeps it)` };
  const remove = [...new Set(o.made.filter((p) => p.startsWith("/")).map((p) => resolve(p)))].filter((p) => p !== run && dirname(p) === run);
  if (remove.length === 0) return { remove, whole: false, line: `the run made no large part in ${run}: it removed nothing` };
  const why = !o.ownRun ? "RUN came from the environment" : o.aborted !== undefined ? `the run was aborted (${o.aborted || "no reason"})`
    : `${o.failed} case${o.failed === 1 ? "" : "s"} failed`;
  return { remove, whole: false, line: `removed ${remove.map((p) => basename(p)).join(", ")} from ${run}; logs and results.json stay: ${why} (KEEP_RUN=1 keeps everything)` };
}
