// The pure parts of the live start check (start.ts): its argument guard, and the analysis that merges
// monitor.swift's log with the check's marks and names each start that changed the frontmost app.
// Unit-tested in test/takeover-start.test.ts; the check itself is not part of `npm test`.

import { isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import { appBundle } from "../../../src/agent.ts";
import { isChromeForTesting } from "../../../src/options.ts";

export const USAGE = "usage: node test/live/takeover/start.ts --on-my-screen --chrome-bin APP_BINARY --monitor MONITOR_BIN --out-dir DIR [--starts 3] [--after-ms 10000] [--same-profile] [--keep-state]";

export type StartOptions = { chromeBin: string; starts: number; monitor: string; outDir: string; afterMs: number; keepState: boolean; sameProfile: boolean };

/**
 * The check's argv, or why it refuses (exit 2). It starts real Chrome windows on a person's screen,
 * so it runs only with --on-my-screen and only on macOS. --chrome-bin must be the binary inside an
 * app bundle (".../X.app/Contents/MacOS/X"): only then does a background start go through
 * `open -n -g`, the path under test.
 */
export function startArgs(argv: string[], env: { platform: string; exists: (p: string) => boolean }): { ok: true; options: StartOptions } | { ok: false; message: string } {
  let values: Record<string, string | boolean | undefined>;
  try {
    values = parseArgs({ args: argv, strict: true, allowPositionals: false, options: {
      "on-my-screen": { type: "boolean" }, "chrome-bin": { type: "string" }, monitor: { type: "string" }, "out-dir": { type: "string" },
      starts: { type: "string" }, "after-ms": { type: "string" }, "keep-state": { type: "boolean" }, "same-profile": { type: "boolean" },
    } }).values;
  } catch (e) { return { ok: false, message: (e as Error).message }; }
  const no = (message: string) => ({ ok: false as const, message });
  if (!values["on-my-screen"]) return no("refusing: this check starts real Chrome windows on this screen and watches the frontmost app; pass --on-my-screen when the person at this Mac agrees");
  if (env.platform !== "darwin") return no("macOS only: the check measures `open -n -g` and the macOS frontmost app");
  const bin = values["chrome-bin"];
  if (typeof bin !== "string" || !bin) return no("--chrome-bin is required: the Google Chrome or Chrome Beta app binary, e.g. \"/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta\"");
  if (!isAbsolute(bin)) return no(`--chrome-bin must be an absolute path: ${bin}`);
  if (!appBundle(bin)) return no(`--chrome-bin must be the binary inside an app bundle (/Applications/X.app/Contents/MacOS/X), so that the start goes through open -n -g: ${bin}`);
  if (isChromeForTesting(bin)) return no("--chrome-bin: the agent browser never runs from Chrome for Testing");
  if (!env.exists(bin)) return no(`--chrome-bin: no such file: ${bin}`);
  const monitor = values.monitor;
  if (typeof monitor !== "string" || !monitor) return no("--monitor is required: monitor.swift compiled with swiftc (see the head of start.ts)");
  if (!env.exists(resolve(monitor))) return no(`--monitor: no such file: ${monitor} (compile test/live/takeover/monitor.swift with swiftc first)`);
  const out = values["out-dir"];
  if (typeof out !== "string" || !out) return no("--out-dir is required: the folder for the logs and results");
  const whole = (flag: string, raw: unknown, dflt: number, min: number, max: number): number | string => {
    if (raw === undefined) return dflt;
    if (typeof raw !== "string" || !/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) return `${flag} must be a whole number from ${min} to ${max}, not ${JSON.stringify(raw)}`;
    return Number(raw);
  };
  const starts = whole("--starts", values.starts, 3, 1, 20);
  if (typeof starts === "string") return no(starts);
  const afterMs = whole("--after-ms", values["after-ms"], 10_000, 1000, 120_000);
  if (typeof afterMs === "string") return no(afterMs);
  return { ok: true, options: { chromeBin: bin, starts, monitor: resolve(monitor), outDir: resolve(out), afterMs, keepState: !!values["keep-state"], sameProfile: !!values["same-profile"] } };
}

/** One line of monitor.swift: the frontmost app changed, the pointer moved, or its once-a-second heartbeat. */
export type MonitorEvent = { t: number; front: number; name: string } | { t: number; pointer: [number, number] } | { t: number; alive: true };

/** The events, and the numbers (from 1) of the lines that start with "{" but are no event. */
export type MonitorLog = { events: MonitorEvent[]; bad: number[] };

/**
 * monitor.swift's output: one JSON object per line. A line that does not start with "{" is skipped.
 * A "{" line that is no event is bad, unless it is the last line, which a kill can cut.
 */
export function parseMonitorLog(text: string): MonitorLog {
  const lines = text.split("\n"), events: MonitorEvent[] = [], bad: number[] = [];
  lines.forEach((line, i) => {
    if (!line.startsWith("{")) return;
    let e: any;
    try { e = JSON.parse(line); } catch { /* bad, below */ }
    if (typeof e?.t === "number" && ((typeof e.front === "number" && typeof e.name === "string") || Array.isArray(e.pointer) || e.alive === true)) events.push(e);
    else if (i < lines.length - 1) bad.push(i + 1);
  });
  return { events, bad };
}

/** The longest silence of the monitor (it beats once a second) that still counts as a working monitor. */
export const MAX_MONITOR_GAP_S = 2;

/** A line of the check's marks.jsonl, in analyse.py's format: "start X", "end X" or "fail X", and "log". */
export type Mark = { t: number; what: string; detail?: unknown };

export type FrontApp = { pid: number; name: string };
export type FrontChange = { t: number; afterStartMs: number; phase: "launch" | "after" | "quit"; pid: number; name: string; agentChrome: boolean };
export type StartFocus = {
  start: number;
  /** The frontmost app when the launch began. */
  frontBefore: FrontApp | null;
  /** Whether the frontmost app changed while `launch` ran or in the seconds after it (not while the check quit its Chrome). */
  changed: boolean;
  changes: FrontChange[];
  /**
   * Changes while the check quit its own Chrome. They count against the start (quitCounted) when the
   * start's own Chrome took the focus, or when the focus did not come back to frontBefore.
   */
  quitChanges: FrontChange[];
  quitCounted: boolean;
  /** Pointer moves from the start to the quit: a person moved the mouse, so a change can be their own click. */
  pointerMoves: number;
  problem: string | null;
};

/**
 * Each start's window: from "start launch N" to "start quit N" ("launch" until "end launch N" or
 * "fail launch N", then "after"), then the quit until "end quit N". The monitor logs only changes,
 * so the app in front before a start is the last front event at or before its "start launch N".
 * `chromePids` maps a start to its own agent Chrome's pid, so a change to that pid is marked.
 * A start is a problem, never a pass, when the monitor could have missed a change in it: it stopped
 * (`monitorEnd`, the time its process exited) before the start ended, it logged nothing for more than
 * MAX_MONITOR_GAP_S in the start, or the log has a bad line.
 */
export function analyseStarts(log: MonitorLog, marks: Mark[], chromePids: Record<number, number | undefined>, opts: { monitorEnd?: number } = {}): StartFocus[] {
  const { events, bad } = log;
  const at = (what: string) => marks.find((m) => m.what === what)?.t;
  const times = events.map((e) => e.t).sort((a, b) => a - b);
  const fronts = events.filter((e): e is Extract<MonitorEvent, { front: number }> => "front" in e).sort((a, b) => a.t - b.t);
  const pointers = events.filter((e) => "pointer" in e);
  const starts = marks.flatMap((m) => { const n = /^start launch (\d+)$/.exec(m.what); return n ? [Number(n[1])] : []; });
  return starts.map((n, i) => {
    const next = i + 1 < starts.length ? at(`start launch ${starts[i + 1]}`)! : Infinity;
    const t0 = at(`start launch ${n}`)!;
    const quit = at(`start quit ${n}`) ?? next;
    const launched = at(`end launch ${n}`) ?? at(`fail launch ${n}`) ?? quit;
    const quitEnd = at(`end quit ${n}`) ?? at(`fail quit ${n}`) ?? next;
    const before = fronts.filter((e) => e.t <= t0).at(-1);
    const frontBefore = before ? { pid: before.front, name: before.name } : null;
    const changes: FrontChange[] = [], quitChanges: FrontChange[] = [];
    let current = before?.front;
    for (const e of fronts) {
      if (e.t <= t0 || e.t >= quitEnd || e.front === current) continue;
      current = e.front;
      const phase = e.t < launched ? "launch" : e.t < quit ? "after" : "quit";
      const change = { t: e.t, afterStartMs: Math.round((e.t - t0) * 1000), phase, pid: e.front, name: e.name, agentChrome: e.front === chromePids[n] } as const;
      (phase === "quit" ? quitChanges : changes).push(change);
    }
    const quitCounted = quitChanges.some((c) => c.agentChrome) || (quitChanges.length > 0 && current !== before?.front);
    const problems: string[] = [];
    if (!frontBefore) problems.push(`the monitor logged no frontmost app before start ${n}`);
    if (bad.length) problems.push(`monitor.jsonl line${bad.length > 1 ? "s" : ""} ${bad.join(", ")} ${bad.length > 1 ? "are" : "is"} not a monitor event`);
    if (quitEnd === Infinity) problems.push(`start ${n} has no end mark`);
    else {
      if (opts.monitorEnd !== undefined && opts.monitorEnd < quitEnd)
        problems.push(`the monitor stopped ${(opts.monitorEnd - t0).toFixed(1)} s from the beginning of start ${n}, before it ended`);
      const points = [t0, ...times.filter((t) => t > t0 && t < quitEnd), quitEnd];
      const gap = Math.max(...points.slice(1).map((t, j) => t - points[j]));
      if (gap > MAX_MONITOR_GAP_S) problems.push(`the monitor logged nothing for ${gap.toFixed(1)} s during start ${n} (a hung or stopped monitor)`);
    }
    return {
      start: n, frontBefore, changed: changes.length > 0 || quitCounted, changes, quitChanges, quitCounted,
      pointerMoves: pointers.filter((e) => e.t > t0 && e.t < quit).length,
      problem: problems.length ? problems.join("; ") : null,
    };
  });
}

/** 0 when every start was measured and none changed the frontmost app; 1 otherwise (a change, a problem, or no start). */
export function exitCode(results: Pick<StartFocus, "changed" | "problem">[]): 0 | 1 {
  return results.length && results.every((r) => !r.changed && !r.problem) ? 0 : 1;
}
