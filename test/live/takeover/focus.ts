// The pure parts of the live start check (start.ts): its argument guard, its start variants and their pass
// rules, the analysis that merges monitor.swift's log with the check's marks and names each start that changed
// the frontmost app, and the reading of each start's launches.log lines. Unit-tested in
// test/takeover-start.test.ts; the check itself is not part of `npm test`.

import { isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { appBundle } from "../../../src/agent.ts";
import { isChromeForTesting } from "../../../src/options.ts";

/**
 * How one start is made (ab-b84.11). `launch` is the start as agent-browser makes it: `open -n -g` with the
 * built-in give-back guard (src/giveback.ts, phase 2 of the fix). The other variants repeat the candidates
 * that phase 1 measured on the Mac on 2026-11-04, with the built-in guard off, for comparison. Each starts
 * the agent Chrome as src/agent.ts does (through the `launch` command), changed only by what it names. No
 * variant opens a debugging WebSocket, so Chrome shows no approval prompt: `launch` probes the port with a
 * plain TCP connect.
 */
export type Variant = {
  name: "launch" | "hidden" | "give-back";
  /** "today": the start as agent-browser makes it; "comparison": a phase-1 candidate, with the built-in give-back off. */
  kind: "today" | "comparison";
  /** What the variant changes (the help text). */
  summary: string;
  /**
   * launchAgentChrome's measurement hooks, through launch-variant.ts: `hidden` starts through `open -n -g -j`,
   * and `giveBack: false` turns the built-in give-back off.
   */
  hooks?: { hidden?: true; giveBack: false };
  /** giveback.swift runs from before each launch until its quit (--giveback). */
  helper?: true;
  /**
   * "unchanged": a start passes only when the front app never changed. "given-back": a start may change it
   * to its own Chrome for a moment: it passes when the front was away from the app in front before for at
   * most GIVE_BACK_MAX_AWAY_MS in all, went to no other app, and the pointer did not move (see givenBackProblems).
   */
  rule: "unchanged" | "given-back";
};

export const VARIANTS: readonly Variant[] = [
  { name: "launch", kind: "today", rule: "given-back", summary: "agent-browser launch as it is: open -n -g with the built-in give-back (the default)" },
  { name: "hidden", kind: "comparison", rule: "unchanged", hooks: { hidden: true, giveBack: false }, summary: "open -n -g -j with the built-in give-back off (phase 1 of 2026-11-04: it did not help)" },
  { name: "give-back", kind: "comparison", rule: "given-back", hooks: { giveBack: false }, helper: true,
    summary: "open -n -g with the built-in give-back off, while giveback.swift asks macOS to activate the app that was in front again (phase 1's helper); needs --giveback" },
];

export const USAGE = `usage: node test/live/takeover/start.ts --on-my-screen --chrome-bin APP_BINARY --monitor MONITOR_BIN --out-dir DIR [--starts 3] [--after-ms 10000] [--same-profile [--restore]] [--keep-state] [--variant NAME] [--giveback GIVEBACK_BIN]
variants (--variant; none opens a debugging WebSocket):
${VARIANTS.map((v) => `  ${v.name} (${v.kind}): ${v.summary}`).join("\n")}`;

/** The lines of launches.log that src/agent.ts writes for a start of Chrome (not the give-back guard's own lines). */
const chromeLines = (lines: string[]) => lines.filter((l) => l.split(" ")[1]?.startsWith("chrome="));

/**
 * How launches.log names a start: the text between each new Chrome line's timestamp and its " by=" (for
 * example "chrome=via-open-g give-back=on front=500 ready-ms=150", or "chrome=4242 hidden=ignored" when the
 * hook did not apply), joined with "; "; null when the start logged no such line.
 */
export function startedAs(lines: string[]): string | null {
  return chromeLines(lines).map((l) => l.split(" by=")[0].split(" ").slice(1).join(" ")).join("; ") || null;
}

/** The tokens that a start of `v` must have in its launches.log line, and how the problem names that form. */
export function startForm(v: Variant): { tokens: string[]; text: string } {
  const open = v.hooks?.hidden ? "open -n -g -j" : "open -n -g";
  const tokens = [`chrome=${v.hooks?.hidden ? "via-open-g-j" : "via-open-g"}`, v.hooks?.giveBack === false ? "give-back=off" : "give-back=on"];
  return { tokens, text: `${open} with the built-in give-back ${v.hooks?.giveBack === false ? "off" : "on"}` };
}

/** Null when a Chrome line of the start's launches.log lines has every token of `v`'s form, else the problem. */
export function startFormProblem(v: Variant, lines: string[]): string | null {
  const { tokens, text } = startForm(v);
  if (chromeLines(lines).some((l) => tokens.every((t) => l.split(" ").includes(t)))) return null;
  return `the start did not go through ${text} (launches.log: ${startedAs(lines) ?? "no line"})`;
}

/**
 * The built-in give-back guard's lines of one start in launches.log ("<ISO time> give-back <what>"): its
 * lines (without the time), how it ended ("end=<why>", null with no end line; "stopped" when the start ended
 * it) and, for each take that it gave back, after how many ms the app in front before was back. Null when the
 * start has no guard line.
 */
export type BuiltInGiveBack = { lines: string[]; end: string | null; backAfterMs: number[] };
export function parseBuiltInGiveBack(lines: string[]): BuiltInGiveBack | null {
  const own = lines.flatMap((l) => { const m = /^\S+ give-back (.+)$/.exec(l); return m ? [m[1]] : []; });
  if (!own.length) return null;
  const end = own.map((l) => /^end=(\S+)/.exec(l)?.[1]).filter((x): x is string => !!x).at(-1) ?? null;
  const backAfterMs = own.flatMap((l) => { const m = /^back=\d+ after-ms=(\d+)$/.exec(l); return m ? [Number(m[1])] : []; });
  return { lines: own, end, backAfterMs };
}

/** The logs that a run writes into --out-dir; a folder that holds one of them belongs to an earlier run. */
export const RUN_LOGS = ["marks.jsonl", "results.jsonl", "monitor.jsonl"];

export type StartOptions = {
  chromeBin: string; starts: number; monitor: string; outDir: string; afterMs: number; keepState: boolean; sameProfile: boolean;
  /** --restore (with --same-profile): Chrome starts with --restore-last-session, so starts 2..N restore the session before. */
  restore: boolean;
  variant: Variant["name"];
  /** The compiled giveback.swift: only with --variant give-back. */
  giveback?: string;
};

/** The Chrome switch of --restore: Chromium's own way to restore the last session, as "Continue where you left off" does. */
export const RESTORE_SWITCH = "--restore-last-session";

/**
 * The child process that makes one start of `v`: the CLI's `launch --json`, as an agent session runs it, or for
 * a variant with hooks launch-variant.ts, which runs the same `launch` command with them. Both print launch's
 * JSON document. With `restore`, Chrome also gets RESTORE_SWITCH (the CLI's --chrome-args, the launcher's --restore).
 */
export function variantLaunch(v: Variant, p: { node: string; cli: string; launcher: string; stateDir: string; chromeBin: string; restore?: boolean }): string[] {
  if (v.hooks) {
    return [p.node, p.launcher, "--state-dir", p.stateDir, "--chrome-bin", p.chromeBin, ...(v.hooks.hidden ? ["--hidden"] : []), ...(v.hooks.giveBack === false ? ["--no-give-back"] : []),
      ...(p.restore ? ["--restore"] : [])];
  }
  return [p.node, p.cli, "launch", "--state-dir", p.stateDir, "--chrome-bin", p.chromeBin, "--json", ...(p.restore ? ["--chrome-args", JSON.stringify([RESTORE_SWITCH])] : [])];
}

/** One request of giveback.swift: the new Chrome `took` the front, and the helper asked macOS to activate `gaveBackTo`. */
export type GiveBackRequest = { t: number; took: number; name: string; gaveBackTo: number; sent: boolean };
export type GiveBackLog = { before: FrontApp | null; requests: GiveBackRequest[]; bad: number[] };

const app = (a: FrontApp) => `${a.name}, pid ${a.pid}`;

/**
 * Before a give-back start: the helper activates the app that it names, so it must be the front app
 * that the monitor and lsappinfo name. Null when the three agree, else why no Chrome may start.
 */
export function givebackReady(before: FrontApp, monitorPid: number | undefined, lsappinfoPid: number | undefined): string | null {
  const pid = (p: number | undefined) => (p === undefined ? "none" : `pid ${p}`);
  if (monitorPid !== before.pid) return `the give-back helper's front app (${app(before)}) is not the monitor's (${pid(monitorPid)})`;
  if (lsappinfoPid !== before.pid) return `the give-back helper's front app (${app(before)}) is not lsappinfo's (${pid(lsappinfoPid)})`;
  return null;
}

/**
 * The problems of a give-back start `n` (none for another variant, `giveBack` null): the helper named no
 * front app, its front app is not the app in front before the start (frontBefore of the analysis), or
 * its log has a bad line.
 */
export function giveBackProblems(n: number, giveBack: GiveBackLog | null, frontBefore: FrontApp | null): string[] {
  if (!giveBack) return [];
  const problems: string[] = [];
  if (!giveBack.before) problems.push(`the give-back helper named no front app in start ${n}`);
  else if (giveBack.before.pid !== frontBefore?.pid)
    problems.push(`the give-back helper's front app (${app(giveBack.before)}) is not the app in front before start ${n} (${frontBefore ? app(frontBefore) : "none"})`);
  const { bad } = giveBack;
  if (bad.length) problems.push(`giveback-${n}.jsonl line${bad.length > 1 ? "s" : ""} ${bad.join(", ")} ${bad.length > 1 ? "are" : "is"} no helper line`);
  return problems;
}

/**
 * giveback.swift's output: its first line names the app in front at its start ({"before": pid, "name"}),
 * then one line per request. A "{" line that is neither is bad, unless it is the last line (a kill can cut it).
 */
export function parseGiveBack(text: string): GiveBackLog {
  const lines = text.split("\n"), requests: GiveBackRequest[] = [], bad: number[] = [];
  let before: FrontApp | null = null;
  lines.forEach((line, i) => {
    if (!line.startsWith("{")) return;
    let e: any;
    try { e = JSON.parse(line); } catch { /* bad, below */ }
    if (typeof e?.t === "number" && typeof e.before === "number" && typeof e.name === "string") before ??= { pid: e.before, name: e.name };
    else if (typeof e?.t === "number" && typeof e.took === "number" && typeof e.name === "string" && typeof e.gaveBackTo === "number" && typeof e.sent === "boolean")
      requests.push({ t: e.t, took: e.took, name: e.name, gaveBackTo: e.gaveBackTo, sent: e.sent });
    else if (i < lines.length - 1) bad.push(i + 1);
  });
  return { before, requests, bad };
}

/**
 * The check's argv, or why it refuses (exit 2). It starts real Chrome windows on a person's screen,
 * so it runs only with --on-my-screen and only on macOS. --chrome-bin must be the binary inside an
 * app bundle (".../X.app/Contents/MacOS/X"): only then does a background start go through
 * `open -n -g`, the path under test. --variant names one of VARIANTS (default "launch");
 * --giveback, the compiled giveback.swift, goes with --variant give-back only.
 */
export function startArgs(argv: string[], env: { platform: string; exists: (p: string) => boolean }): { ok: true; options: StartOptions } | { ok: false; message: string } {
  let values: Record<string, string | boolean | undefined>;
  try {
    values = parseArgs({ args: argv, strict: true, allowPositionals: false, options: {
      "on-my-screen": { type: "boolean" }, "chrome-bin": { type: "string" }, monitor: { type: "string" }, "out-dir": { type: "string" },
      starts: { type: "string" }, "after-ms": { type: "string" }, "keep-state": { type: "boolean" }, "same-profile": { type: "boolean" }, restore: { type: "boolean" },
      variant: { type: "string" }, giveback: { type: "string" },
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
  const used = RUN_LOGS.find((name) => env.exists(join(resolve(out), name)));
  if (used) return no(`--out-dir already holds the logs of a run (${used}): ${out}; give a new folder, so that those logs stay`);
  const whole = (flag: string, raw: unknown, dflt: number, min: number, max: number): number | string => {
    if (raw === undefined) return dflt;
    if (typeof raw !== "string" || !/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) return `${flag} must be a whole number from ${min} to ${max}, not ${JSON.stringify(raw)}`;
    return Number(raw);
  };
  const starts = whole("--starts", values.starts, 3, 1, 20);
  if (typeof starts === "string") return no(starts);
  const afterMs = whole("--after-ms", values["after-ms"], 10_000, 1000, 120_000);
  if (typeof afterMs === "string") return no(afterMs);
  if (values.restore && !values["same-profile"]) return no("--restore needs --same-profile: only a used profile has a session to restore");
  const name = values.variant ?? "launch";
  const variant = VARIANTS.find((v) => v.name === name);
  if (!variant) return no(`--variant must be one of ${VARIANTS.map((v) => v.name).join(", ")}, not ${JSON.stringify(name)}`);
  const giveback = values.giveback;
  if (variant.helper) {
    if (typeof giveback !== "string" || !giveback) return no("--giveback is required for --variant give-back: giveback.swift compiled with swiftc (see the head of start.ts)");
    if (!env.exists(resolve(giveback))) return no(`--giveback: no such file: ${giveback} (compile test/live/takeover/giveback.swift with swiftc first)`);
  } else if (giveback !== undefined) return no(`--giveback is only for --variant give-back, not --variant ${variant.name}`);
  return { ok: true, options: { chromeBin: bin, starts, monitor: resolve(monitor), outDir: resolve(out), afterMs, keepState: !!values["keep-state"], sameProfile: !!values["same-profile"], restore: !!values.restore,
    variant: variant.name, ...(variant.helper ? { giveback: resolve(giveback as string) } : {}) } };
}

/**
 * One line of monitor.swift: the frontmost app changed (pid 0 and name "?" when the monitor cannot see
 * it), the pointer moved, its once-a-second heartbeat, or an app launched (information only).
 */
export type MonitorEvent = { t: number; front: number; name: string } | { t: number; pointer: [number, number] } | { t: number; alive: true } | { t: number; launched: number; name: string };

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
    const named = typeof e?.name === "string";
    if (typeof e?.t === "number" && ((typeof e.front === "number" && named) || (typeof e.launched === "number" && named) || Array.isArray(e.pointer) || e.alive === true)) events.push(e);
    else if (i < lines.length - 1) bad.push(i + 1);
  });
  return { events, bad };
}

/** The longest silence of the monitor (it beats once a second) that still counts as a working monitor. */
export const MAX_MONITOR_GAP_S = 2;

/** The pid in the output of `lsappinfo info -only pid <ASN>` ("pid"=123), or undefined. */
export function lsappinfoPid(text: string): number | undefined {
  const m = /"?pid"?\s*=\s*(\d+)/.exec(text);
  return m ? Number(m[1]) : undefined;
}

/**
 * The liveness check before start 1: the monitor's latest front pid must be the front pid that
 * lsappinfo gives. Null when they agree, else why the monitor cannot be trusted.
 */
export function livenessProblem(monitorPid: number | undefined, lsappinfo: number | undefined): string | null {
  if (monitorPid === undefined) return "the monitor logged no frontmost app";
  if (monitorPid === 0) return "the monitor cannot see the frontmost app (pid 0)";
  if (lsappinfo === undefined) return "lsappinfo gave no frontmost app, so the monitor cannot be checked";
  if (monitorPid !== lsappinfo) return `the monitor's frontmost app (pid ${monitorPid}) is not lsappinfo's (pid ${lsappinfo})`;
  return null;
}

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
   * Changes from "start quit N" to the next start (or the end of the run). Each one counts against the
   * start (quitCounted): a Chrome that is not in front moves no focus when it quits.
   */
  quitChanges: FrontChange[];
  quitCounted: boolean;
  /**
   * How long (ms), from the launch to the quit, the frontmost app was not the app in front before the
   * start: for give-back, the time that the guard leaves the focus away. Null with no app in front before.
   */
  awayMs: number | null;
  /** Whether the monitor logged the launch of this start's own Chrome (information only). */
  launchSeen: boolean;
  /** Pointer moves from the start to the quit: a person moved the mouse, so a change can be their own click. */
  pointerMoves: number;
  problem: string | null;
};

/**
 * Each start's window: from "start launch N" to "start quit N" ("launch" until "end launch N" or
 * "fail launch N", then "after"), then "quit" until the next start's "start launch" (or "done", the end
 * of the run), so a change between two starts counts too. The monitor logs only changes,
 * so the app in front before a start is the last front event at or before its "start launch N".
 * `chromePids` maps a start to its own agent Chrome's pid, so a change to that pid is marked.
 * A start is a problem, never a pass, when the monitor could have missed a change in it: it stopped
 * (`monitorEnd`, the time its process exited) before the start ended, it logged nothing for more than
 * MAX_MONITOR_GAP_S in the start, it could not see the front app (pid 0 or name "?") before the start
 * or at a change, or the log has a bad line.
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
    const quitEnd = i + 1 < starts.length ? next : at("done") ?? at(`end quit ${n}`) ?? at(`fail quit ${n}`) ?? Infinity;
    const before = fronts.filter((e) => e.t <= t0).at(-1);
    const frontBefore = before ? { pid: before.front, name: before.name } : null;
    const changes: FrontChange[] = [], quitChanges: FrontChange[] = [];
    let current = before?.front;
    for (const e of fronts) {
      if (e.t <= t0 || e.t > quitEnd || e.front === current) continue; // a change at the next mark's instant is still this start's
      current = e.front;
      const phase = e.t < launched ? "launch" : e.t < quit ? "after" : "quit";
      const change = { t: e.t, afterStartMs: Math.round((e.t - t0) * 1000), phase, pid: e.front, name: e.name, agentChrome: e.front === chromePids[n] } as const;
      (phase === "quit" ? quitChanges : changes).push(change);
    }
    const quitCounted = quitChanges.length > 0;
    let awayMs: number | null = null;
    if (frontBefore && quit !== Infinity) {
      let away = 0, since: number | undefined;
      for (const c of changes) {
        if (c.pid !== frontBefore.pid) since ??= c.t;
        else if (since !== undefined) { away += c.t - since; since = undefined; }
      }
      if (since !== undefined) away += quit - since;
      awayMs = Math.round(away * 1000);
    }
    const blind = (pid: number, name: string) => pid === 0 || name === "?";
    const problems: string[] = [];
    if (!frontBefore) problems.push(`the monitor logged no frontmost app before start ${n}`);
    else if (blind(frontBefore.pid, frontBefore.name)) problems.push(`the monitor could not see the frontmost app before start ${n}`);
    for (const c of [...changes, ...quitChanges]) if (blind(c.pid, c.name)) problems.push(`the monitor could not see the frontmost app at +${c.afterStartMs} ms of start ${n}`);
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
      start: n, frontBefore, changed: changes.length > 0 || quitCounted, changes, quitChanges, quitCounted, awayMs,
      pointerMoves: pointers.filter((e) => e.t > t0 && e.t < quit).length,
      launchSeen: chromePids[n] !== undefined && events.some((e) => "launched" in e && e.launched === chromePids[n] && e.t > t0 && e.t < quitEnd),
      problem: problems.length ? problems.join("; ") : null,
    };
  });
}

/** The most time (ms) that a start under the "given-back" rule may leave the front away from the app in front before it (phase 1's helper: 36 to 83 ms). */
export const GIVE_BACK_MAX_AWAY_MS = 250;

/**
 * Why a start breaks the "given-back" rule (none when the front never changed): the front went to an app that is
 * neither the app in front before nor this start's own Chrome, it changed while the check quit the Chrome, it was
 * away for more than GIVE_BACK_MAX_AWAY_MS in all (also when it never came back before the quit), or the pointer
 * moved, so that the return can be a person's click.
 */
export function givenBackProblems(f: Pick<StartFocus, "start" | "frontBefore" | "changes" | "quitChanges" | "awayMs" | "pointerMoves">): string[] {
  if (!f.changes.length && !f.quitChanges.length) return [];
  const problems: string[] = [];
  const at = (c: FrontChange) => `${c.name} (pid ${c.pid}) at +${c.afterStartMs} ms`;
  for (const c of f.changes) if (!c.agentChrome && c.pid !== f.frontBefore?.pid) problems.push(`the front went to ${at(c)} of start ${f.start}, not to this start's Chrome`);
  if (f.quitChanges.length) problems.push(`the front changed while the check quit the Chrome of start ${f.start}: ${f.quitChanges.map(at).join(", ")}`);
  if (f.awayMs !== null && f.awayMs > GIVE_BACK_MAX_AWAY_MS)
    problems.push(`the front was away from ${f.frontBefore!.name} (pid ${f.frontBefore!.pid}) for ${f.awayMs} ms in start ${f.start}, more than ${GIVE_BACK_MAX_AWAY_MS} ms`);
  if (f.pointerMoves) problems.push(`the pointer moved during start ${f.start}: the return of the front can be a person's click`);
  return problems;
}

/**
 * 0 when every start was measured and passed `rule`, else 1 (a change, a problem, or no start). Under "unchanged"
 * a start passes when the front app never changed; under "given-back" when it has no problem (the caller puts
 * givenBackProblems into it).
 */
export function exitCode(results: Pick<StartFocus, "changed" | "problem">[], rule: Variant["rule"] = "unchanged"): 0 | 1 {
  return results.length && results.every((r) => (rule === "given-back" || !r.changed) && !r.problem) ? 0 : 1;
}
