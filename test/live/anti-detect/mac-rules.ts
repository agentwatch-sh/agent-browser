// The pure parts of the macOS check (mac.ts beside this file, board task ab-v16.16): its argument guard, the
// watcher's log (mac-watch.swift), the analysis (the front app and each take of it, the Space, where each new
// window came in the window order, the real pointer's events in the probe pages), the pass rule and the
// summary. No Chrome and no I/O, so that test/mac-measure.test.ts runs them in `npm test`.

import { isAbsolute } from "node:path";
import { parseArgs } from "node:util";
import { appBundle } from "../../../src/agent.ts";
import { isChromeForTesting } from "../../../src/options.ts";
import { inputs, type Rec } from "./probe.ts";

/** The parts of the check that --skip can leave out (each needs no consent of its own; popups are the most likely to take the front). */
export const SKIPPABLE = ["record", "popups", "person"] as const;
export type Skip = (typeof SKIPPABLE)[number];

export type MacOptions = {
  /** Linux only: the whole drive in a private Xvfb, with a stand-in watcher (no front app, no Space, no window list). */
  dryRun: boolean;
  outDir: string;
  /** macOS: the binary inside the agent's app bundle. Dry run: a Chromium binary. */
  chromeBin: string;
  /** A compiled mac-watch.swift (else the check compiles it into its run folder). */
  watcher?: string;
  /** Seconds to keep the agent windows open after the measurement, with the give-back off, for the operator's look. */
  look: number;
  skip: Skip[];
  /** Dry run: the private X display. */
  display: number;
};

export const USAGE = `usage (macOS; the operator agrees, and nobody uses the Mac during the run):
  node test/live/anti-detect/mac.ts --on-my-screen --out-dir DIR [--chrome-bin APP_BINARY] [--watcher BIN] [--look SECONDS] [--skip record,popups,person]
dry run (Linux, in a private Xvfb, with a stand-in watcher; not a Mac result):
  node test/live/anti-detect/mac.ts --dry-run --out-dir DIR [--chrome /usr/bin/chromium] [--display 123] [--skip record,popups,person]`;

/**
 * The check's argv, or why it refuses (exit 2, before anything starts). On macOS it starts an agent Chrome on the
 * operator's screen, so it needs --on-my-screen; its --chrome-bin is the binary inside an app bundle (so that the
 * start goes through `open -n -g`, as agent-browser's launch does), never Chrome for Testing. --dry-run is for
 * Linux only.
 */
export function macArgs(argv: string[], env: { platform: string; exists: (p: string) => boolean; defaultChrome: string }): { ok: true; options: MacOptions } | { ok: false; message: string } {
  let v: Record<string, string | boolean | undefined>;
  try {
    v = parseArgs({ args: argv, strict: true, allowPositionals: false, options: {
      "on-my-screen": { type: "boolean" }, "dry-run": { type: "boolean" }, "out-dir": { type: "string" }, "chrome-bin": { type: "string" }, chrome: { type: "string" },
      watcher: { type: "string" }, look: { type: "string" }, skip: { type: "string" }, display: { type: "string" },
    } }).values;
  } catch (e) { return { ok: false, message: `${(e as Error).message}\n${USAGE}` }; }
  const no = (message: string) => ({ ok: false as const, message });
  const dryRun = !!v["dry-run"];
  if (dryRun && v["on-my-screen"]) return no("--dry-run or --on-my-screen, not both");
  if (dryRun && env.platform !== "linux") return no(`--dry-run runs on Linux only, in a private Xvfb (this is ${env.platform})`);
  if (!dryRun && !v["on-my-screen"]) return no(`refusing: this check starts an agent Chrome on this screen and watches the front app and the Space; pass --on-my-screen when the operator agrees\n${USAGE}`);
  if (!dryRun && env.platform !== "darwin") return no(`--on-my-screen is for macOS only (this is ${env.platform}); on Linux use --dry-run`);
  const out = v["out-dir"];
  if (typeof out !== "string" || !out) return no(`--out-dir is required\n${USAGE}`);
  const skip: Skip[] = [];
  if (typeof v.skip === "string") for (const s of v.skip.split(",").filter(Boolean)) {
    if (!(SKIPPABLE as readonly string[]).includes(s)) return no(`--skip takes ${SKIPPABLE.join(", ")}, not ${JSON.stringify(s)}`);
    skip.push(s as Skip);
  }
  if (dryRun) {
    for (const f of ["chrome-bin", "watcher", "look"]) if (v[f] !== undefined) return no(`--${f} is for the Mac run, not --dry-run`);
    const display = Number(v.display ?? 123);
    if (typeof v.display === "string" && !/^\d+$/.test(v.display) || !Number.isInteger(display) || display < 1 || display > 9999) return no(`--display is a whole display number: ${v.display}`);
    const chrome = typeof v.chrome === "string" ? v.chrome : "/usr/bin/chromium";
    if (!env.exists(chrome)) return no(`--chrome: no such file: ${chrome}`);
    return { ok: true, options: { dryRun, outDir: out, chromeBin: chrome, look: 0, skip, display } };
  }
  for (const f of ["chrome", "display"]) if (v[f] !== undefined) return no(`--${f} is for --dry-run; on the Mac use --chrome-bin`);
  const bin = typeof v["chrome-bin"] === "string" ? v["chrome-bin"] : env.defaultChrome;
  if (!isAbsolute(bin)) return no(`--chrome-bin must be an absolute path: ${bin}`);
  if (!appBundle(bin)) return no(`--chrome-bin must be the binary inside an app bundle (/Applications/X.app/Contents/MacOS/X), so that the start goes through open -n -g: ${bin}`);
  if (isChromeForTesting(bin)) return no("--chrome-bin: the agent browser never runs from Chrome for Testing");
  if (!env.exists(bin)) return no(`--chrome-bin: no such file: ${bin}`);
  const watcher = v.watcher;
  if (watcher !== undefined && (typeof watcher !== "string" || !env.exists(watcher))) return no(`--watcher: no such file: ${watcher} (or leave it out: the check compiles test/live/anti-detect/mac-watch.swift)`);
  const look = Number(v.look ?? 0);
  if (typeof v.look === "string" && !/^\d+$/.test(v.look) || !Number.isInteger(look) || look < 0 || look > 300) return no(`--look is a whole number of seconds from 0 to 300: ${v.look}`);
  return { ok: true, options: { dryRun, outDir: out, chromeBin: bin, ...(typeof watcher === "string" ? { watcher } : {}), look, skip, display: 0 } };
}

// ------------------------------------------------------------------------------------------------ the watcher's log

/** One line of mac-watch.swift (or the dry run's stand-in): "t" in ms since 1970, "ev" its kind. */
export type WatchEvent = { t: number; ev: string; [k: string]: any };

/** The watcher's output: its events, and the numbers (from 1) of the lines that start with "{" but are no event (the last line may be cut). */
export function parseWatchLog(text: string): { events: WatchEvent[]; bad: number[] } {
  const lines = text.split("\n"), events: WatchEvent[] = [], bad: number[] = [];
  lines.forEach((line, i) => {
    if (!line.startsWith("{")) return;
    let e: any;
    try { e = JSON.parse(line); } catch { /* bad, below */ }
    if (e && typeof e.t === "number" && typeof e.ev === "string") events.push(e);
    else if (i < lines.length - 1 && lines.slice(i + 1).some((l) => l.trim())) bad.push(i + 1);
  });
  return { events, bad };
}

/** One step of the drive, as mac.ts records it (t0 and t1 in ms since 1970). */
export type Step = { phase: string; name: string; t0: number; t1: number; ok: boolean; error?: string; detail?: unknown };

/** The time after a step that still counts as its own (the frames and the windows of the second after it). */
export const STEP_TAIL_MS = 1500;

/** The step at time t: the one that runs then, else the last one that ended in the STEP_TAIL_MS before t ("after X"), else "between steps". */
export function stepAt(steps: readonly Step[], t: number): string {
  const inside = steps.filter((s) => s.t0 <= t && t <= s.t1).at(-1);
  if (inside) return `${inside.phase}: ${inside.name}`;
  const after = steps.filter((s) => s.t1 < t && t - s.t1 <= STEP_TAIL_MS).at(-1);
  return after ? `${after.phase}: ${after.name} (after it)` : "between steps";
}

export type FrontApp = { pid: number; name: string };

/**
 * One time that the front app was not the operator's app: from the change to the return (t1 null: it never came
 * back before the watcher's last line). `to` names each app that was in front then; agentOnly: only the agent
 * Chrome was. asks: the watcher's give-back requests in it.
 */
export type Take = { t0: number; t1: number | null; ms: number; to: string[]; agentOnly: boolean; asks: number; step: string; start: boolean };

/** The most time (ms) that the start of the agent Chrome may leave the front away from the operator's app (test/live/takeover/focus.ts, GIVE_BACK_MAX_AWAY_MS). */
export const START_MAX_AWAY_MS = 250;

/**
 * The operator's app (the front app when the watcher got ready) and each take of the front: each run of front
 * changes away from that app and back. A take that begins in a step named `start` (the agent Chrome's start) is a
 * start take.
 */
export function frontTakes(events: readonly WatchEvent[], steps: readonly Step[], startStep = "start"): { operator: FrontApp | null; takes: Take[] } {
  const ready = events.find((e) => e.ev === "ready");
  const op = ready?.front && ready.front.pid ? { pid: Number(ready.front.pid), name: String(ready.front.name) } : null;
  if (!op || !ready) return { operator: op, takes: [] };
  const sorted = events.filter((e) => e.t >= ready.t).slice().sort((a, b) => a.t - b.t);
  const last = sorted.at(-1)?.t ?? ready.t;
  const takes: Take[] = [];
  let cur: Take | undefined;
  const close = (t1: number | null, t: number) => {
    if (!cur) return;
    cur.t1 = t1;
    cur.ms = t - cur.t0;
    cur.asks = events.filter((e) => e.ev === "ask" && e.t >= cur!.t0 && e.t <= t).length;
    takes.push(cur);
    cur = undefined;
  };
  for (const e of sorted) {
    if (e.ev !== "front") continue;
    const pid = Number(e.pid);
    if (pid === op.pid) { close(e.t, e.t); continue; }
    const label = `${e.name ?? "?"} (pid ${pid}${e.agent ? ", the agent Chrome" : ""})`;
    if (!cur) {
      const step = stepAt(steps, e.t);
      cur = { t0: e.t, t1: null, ms: 0, to: [label], agentOnly: !!e.agent, asks: 0, step, start: step.split(": ")[0] === startStep };
    } else {
      if (!cur.to.includes(label)) cur.to.push(label);
      cur.agentOnly &&= !!e.agent;
    }
  }
  close(null, last);
  return { operator: op, takes };
}

/** The front app at time t (the last front change at or before t, else the operator's app at ready). */
export function frontAt(events: readonly WatchEvent[], t: number): FrontApp | null {
  const ready = events.find((e) => e.ev === "ready");
  const f = events.filter((e) => e.ev === "front" && e.t <= t).sort((a, b) => a.t - b.t).at(-1) ?? (ready?.front ? { ...ready.front, t: ready.t } : undefined);
  return f ? { pid: Number(f.pid), name: String(f.name) } : null;
}

export type SpaceChange = { t: number; via: string; space: unknown; step: string };

/** Each change of the active Space that the watcher saw after it got ready (NSWorkspace's news, or a new id). */
export function spaceChanges(events: readonly WatchEvent[], steps: readonly Step[]): SpaceChange[] {
  const ready = events.find((e) => e.ev === "ready");
  return events.filter((e) => e.ev === "space" && (!ready || e.t >= ready.t)).map((e) => ({ t: e.t, via: String(e.via), space: e.space, step: stepAt(steps, e.t) }));
}

/**
 * Why the operator's screen is not fit for the check, from the watcher's first lines (exit 2, before Chrome starts):
 * no front app, a locked screen, a display that sleeps, a session off the console, or a front app whose top window
 * fills a whole display (a full-screen app: a new Chrome window would open on another Space).
 */
export function screenProblem(events: readonly WatchEvent[]): string | null {
  const ready = events.find((e) => e.ev === "ready");
  if (!ready) return "the watcher never got ready";
  if (!ready.front?.pid) return "the watcher sees no front app";
  if (ready.locked) return "the screen is locked: unlock the Mac and leave it on its desktop";
  if (ready.asleep) return "the display sleeps: wake the Mac";
  if (ready.onConsole === false) return "this session is not on the console (another user is in front)";
  const top = windowsOf(events.find((e) => e.ev === "windows")).find((w) => w.pid === Number(ready.front.pid) && isOperatorWindow(w, -1));
  const full = top && ((ready.displays ?? []) as { x: number; y: number; w: number; h: number }[]).find((d) => top.x === d.x && top.y === d.y && top.w === d.w && top.h === d.h);
  if (full) return `the front app (${ready.front.name}) is full screen: a new agent window would open on another Space; leave the full-screen view first`;
  return null;
}

/** The longest silence of the watcher (it logs once a second) that still counts as a working watcher. */
export const MAX_WATCH_GAP_MS = 2000;

/**
 * Why the watcher's log cannot show that the check kept off the operator's focus and Space, in [from, to]: no ready
 * line, no front app, a silence of more than MAX_WATCH_GAP_MS, an end before `to`, a bad line, a locked screen, a
 * display that slept, a session off the console, or a pointer move (the check never moves it: a person used the Mac).
 */
export function watcherProblems(events: readonly WatchEvent[], bad: readonly number[], from: number, to: number): string[] {
  const p: string[] = [];
  const ready = events.find((e) => e.ev === "ready");
  if (!ready) return ["the watcher never got ready"];
  if (!ready.front?.pid) p.push("the watcher could not see the front app at its start");
  const times = [from, ...events.map((e) => e.t).filter((t) => t > from && t < to).sort((a, b) => a - b), to];
  const gap = Math.max(...times.slice(1).map((t, i) => t - times[i]));
  if (gap > MAX_WATCH_GAP_MS) p.push(`the watcher logged nothing for ${(gap / 1000).toFixed(1)} s (a hung or stopped watcher)`);
  const end = events.find((e) => e.ev === "end");
  if (end && end.t < to) p.push(`the watcher ended (${end.why}) ${((to - end.t) / 1000).toFixed(1)} s before the check did`);
  if (bad.length) p.push(`watcher line${bad.length > 1 ? "s" : ""} ${bad.join(", ")} ${bad.length > 1 ? "are" : "is"} not an event`);
  const states = events.filter((e) => e.ev === "ready" || e.ev === "alive");
  if (states.some((e) => e.locked)) p.push("the screen was locked during the run");
  if (states.some((e) => e.asleep)) p.push("the display slept during the run");
  if (states.some((e) => e.onConsole === false)) p.push("the session was not on the console during the run (another user's session was in front)");
  const moves = events.filter((e) => e.ev === "pointer" && e.t >= from && e.t <= to).length;
  if (moves) p.push(`the pointer moved (${moves} times): a person used the Mac, so a change of the front app can be theirs`);
  return p;
}

// ------------------------------------------------------------------------------------------------ windows

/** A window of layer 0 on the screen (CGWindowList; points, the origin at the top left of the main display). */
export type CgWin = { pid: number; n: number; x: number; y: number; w: number; h: number; a: number; owner: string };

/** The windows of a "windows" line, front to back. */
export function windowsOf(e: WatchEvent | undefined): CgWin[] {
  if (!e || !Array.isArray(e.list)) return [];
  const owners = (e.owners ?? {}) as Record<string, string>;
  return (e.list as number[][]).map(([pid, n, x, y, w, h, a]) => ({ pid, n, x, y, w, h, a, owner: owners[String(pid)] ?? "?" }));
}

/** The last "windows" line at or before t. */
export function windowsAt(events: readonly WatchEvent[], t: number): WatchEvent | undefined {
  return events.filter((e) => e.ev === "windows" && e.t <= t).sort((a, b) => a.t - b.t).at(-1);
}

/** The snap line with this label (the last one). */
export function snapOf(events: readonly WatchEvent[], label: string): WatchEvent | undefined {
  return events.filter((e) => e.ev === "windows" && e.why === "snap" && e.label === label).at(-1);
}

/** Owners of windows of layer 0 that are part of macOS, not the operator's work. */
export const SYSTEM_OWNERS: readonly string[] = ["Window Server", "Dock", "WindowManager", "Control Center", "SystemUIServer", "Notification Center", "Spotlight", "TextInputMenuAgent", "Wallpaper", "loginwindow"];

/** A window of the operator: not the agent Chrome's, not macOS's own, visible and at least 50x50 points. */
export function isOperatorWindow(w: CgWin, agentPid: number): boolean {
  return w.pid !== agentPid && !SYSTEM_OWNERS.includes(w.owner) && w.a > 0 && w.w >= 50 && w.h >= 50;
}

/** The part (0 to 1) of `target`'s area that lies under at least one of `others`, on a grid of n x n points. */
export function coveredFraction(target: Pick<CgWin, "x" | "y" | "w" | "h">, others: readonly Pick<CgWin, "x" | "y" | "w" | "h">[], n = 20): number {
  if (target.w <= 0 || target.h <= 0) return 0;
  let hit = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const x = target.x + (i + 0.5) * target.w / n, y = target.y + (j + 0.5) * target.h / n;
    if (others.some((o) => x >= o.x && x < o.x + o.w && y >= o.y && y < o.y + o.h)) hit++;
  }
  return Math.round((hit / (n * n)) * 100) / 100;
}

/**
 * Where an agent window is in the window order (front to back), against the operator's windows: how many are
 * above it and below it, whether it is above the top window of the operator's front app, how much of that window
 * it covers, and how much of it the operator's windows cover. Null when the window is not in the list (not on
 * screen: another Space, minimized, or not shown yet).
 */
export type Placement = {
  n: number; index: number; operatorAbove: number; operatorBelow: number;
  /** The top window of the operator's front app: its owner, and whether the agent window is above it (null: that app has no window on screen). */
  frontApp: string | null; aboveFrontWindow: boolean | null;
  /** The part of the front app's top window that the agent window covers (0 when it is below it). */
  coversFrontWindow: number;
  /** The part of the agent window that the operator's windows above it cover. */
  coveredByOperator: number;
  bounds: string;
};
export function placement(list: readonly CgWin[], agentPid: number, n: number, frontPid: number): Placement | null {
  const index = list.findIndex((w) => w.pid === agentPid && w.n === n);
  if (index < 0) return null;
  const me = list[index];
  const ops = list.map((w, i) => ({ w, i })).filter(({ w }) => isOperatorWindow(w, agentPid));
  const above = ops.filter(({ i }) => i < index), below = ops.filter(({ i }) => i > index);
  const front = ops.find(({ w }) => w.pid === frontPid);
  const aboveFront = front ? index < front.i : null;
  return {
    n, index, operatorAbove: above.length, operatorBelow: below.length,
    frontApp: front ? front.w.owner : null, aboveFrontWindow: aboveFront,
    coversFrontWindow: front && aboveFront ? coveredFraction(front.w, [me]) : 0,
    coveredByOperator: coveredFraction(me, above.map(({ w }) => w)),
    bounds: `${me.w}x${me.h} at ${me.x},${me.y}`,
  };
}

/** The agent Chrome's windows in a snap (every window of its pid, on or off screen; layer 0, at least 50x50 points). */
export type AgentWin = { n: number; layer: number; x: number; y: number; w: number; h: number; alpha: number; onscreen: boolean };
export function agentWindowsOf(snap: WatchEvent | undefined): AgentWin[] {
  return ((snap?.agentAll ?? []) as AgentWin[]).filter((w) => w.layer === 0 && w.w >= 50 && w.h >= 50);
}

/** The agent windows that a snap after a step has and the snap before it had not. */
export function newAgentWindows(before: WatchEvent | undefined, after: WatchEvent | undefined): AgentWin[] {
  const old = new Set(agentWindowsOf(before).map((w) => w.n));
  return agentWindowsOf(after).filter((w) => !old.has(w.n));
}

/** The agent window whose bounds match Chrome's own window bounds (Browser.getWindowForTarget; 2 points of play). */
export function matchWindow(wins: readonly AgentWin[], b: { left?: number; top?: number; width?: number; height?: number } | undefined): AgentWin | undefined {
  if (!b || b.left === undefined) return undefined;
  const near = (p: number, q: number | undefined) => q !== undefined && Math.abs(p - q) <= 2;
  return wins.find((w) => near(w.x, b.left) && near(w.y, b.top) && near(w.w, b.width) && near(w.h, b.height));
}

/** The order of the agent window `n` against the window `m` in a list (front to back): "above", "below", or null when one of them is not on screen. */
export function orderOf(list: readonly CgWin[], agentPid: number, n: number, m: number): "above" | "below" | null {
  const i = list.findIndex((w) => w.pid === agentPid && w.n === n), j = list.findIndex((w) => w.pid === agentPid && w.n === m);
  return i < 0 || j < 0 ? null : i < j ? "above" : "below";
}

// ------------------------------------------------------------------------------------------------ the real pointer

/** The real pointer at the watcher's start (the check never moves it; a move is a problem of its own). */
export function realPointer(events: readonly WatchEvent[]): { x: number; y: number } | null {
  const p = events.find((e) => e.ev === "ready")?.pointer;
  return Array.isArray(p) && p.length === 2 ? { x: Number(p[0]), y: Number(p[1]) } : null;
}

/**
 * The pointer events of each probe page at the real pointer's point (screenX and screenY within 1 point of it):
 * the events that macOS gave the page from the real pointer, not from the check's CDP input (CDP input goes
 * to the check's own points, away from the real pointer unless the check starts its path there).
 */
export type RealEvent = { t: number; type: string; cx: number; cy: number; step: string };
export function realPointerEvents(log: readonly Rec[], at: { x: number; y: number } | null, tabs: readonly string[], steps: readonly Step[]): Record<string, RealEvent[]> {
  const out: Record<string, RealEvent[]> = {};
  if (!at) return out;
  for (const tab of tabs) {
    const evs = inputs(log as Rec[], tab, 0, Number.MAX_SAFE_INTEGER).filter((e) => typeof e.sx === "number" && Math.abs(e.sx - at.x) <= 1 && Math.abs(e.sy - at.y) <= 1);
    if (evs.length) out[tab] = evs.map((e) => ({ t: e.t, type: e.type, cx: e.cx, cy: e.cy, step: stepAt(steps, e.t) }));
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ the pass rule

/**
 * The pass rule (exit 0 only when it holds): the start's take, if any, was given back by the rules of agent-
 * browser's launch (at most START_MAX_AWAY_MS away, to the agent Chrome only, and back); after the start the front
 * app never changed; the Space never changed; the watcher can show both (watcherProblems); every phase ran.
 */
export function verdict(p: { takes: readonly Take[]; spaces: readonly SpaceChange[]; watcher: readonly string[]; missing: readonly string[]; aborted?: string; error?: string }): { ok: boolean; problems: string[] } {
  const problems: string[] = [...p.watcher];
  for (const t of p.takes) {
    const where = `${t.step}: the front went to ${t.to.join(", then ")} for ${t.ms} ms${t.t1 === null ? " and did not come back" : ""}`;
    if (t.start) {
      if (t.t1 === null || !t.agentOnly || t.ms > START_MAX_AWAY_MS) problems.push(`the start took the front and broke the give-back rule (at most ${START_MAX_AWAY_MS} ms, to the agent Chrome only, and back): ${where}`);
    } else problems.push(`a step took the operator's front: ${where}`);
  }
  for (const s of p.spaces) problems.push(`the Space changed (${s.via}) in ${s.step}`);
  if (p.aborted) problems.push(`the check stopped early: ${p.aborted}`);
  if (p.error) problems.push(`the check failed: ${p.error}`);
  if (p.missing.length) problems.push(`not run: ${p.missing.join(", ")}`);
  return { ok: problems.length === 0, problems };
}

// ------------------------------------------------------------------------------------------------ the summary

/** One row of a drive table: the step, and what the driven page (and the other pages) showed. */
export type DriveRow = { step: string; ok: boolean; ms: number; error?: string; vis: string; focus: string; frames: string; others: string; front: string; order?: string };
export type RecordRow = { where: string; fps?: number; frames?: number; seconds?: number; maxFrameGapMs?: number; covered?: string; error?: string; skipped?: string };
export type WindowRow = { step: string; how: string; cg: string; placement: Placement | null; onscreen: string; space: string; front: string };
export type PopupRow = { kind: string; asked: string; where: string; outer: string; popup: string; opener: string; front: string; placement: Placement | null };

export type MacResult = {
  ok: boolean; problems: string[]; dryRun: boolean; run: string; startedAt: string; seconds: number;
  chrome: string; product: string; flags: string[]; operator: FrontApp | null; frontAtEnd: FrontApp | null;
  takes: Take[]; spaces: SpaceChange[]; startGiveBack: string[];
  windows: WindowRow[]; tabDrive: DriveRow[]; windowDrive: DriveRow[]; records: RecordRow[];
  focus: string[]; popups: PopupRow[]; pointer: { at: { x: number; y: number } | null; real: Record<string, RealEvent[]> };
  apis: string[]; look: string[]; notMeasured: string[];
};

const cell = (s: unknown) => String(s ?? "").replace(/\|/g, "/").replace(/\n/g, " ");
const table = (head: string[], rows: unknown[][]) => rows.length ? [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`)] : ["(none)"];
export const placementText = (p: Placement | null) => p
  ? `${p.aboveFrontWindow === null ? "no window of the front app on screen" : p.aboveFrontWindow ? `ABOVE the front app's window (covers ${Math.round(p.coversFrontWindow * 100)} % of it)` : "behind the front app's window"}; above ${p.operatorBelow} and below ${p.operatorAbove} of the operator's windows; ${Math.round(p.coveredByOperator * 100)} % of it covered`
  : "not on screen";

/** The summary (Markdown) of one run: the pass rule first, then each measurement. */
export function summary(r: MacResult): string {
  const lines = [
    `# macOS check of drive, record and one window per page${r.dryRun ? " (DRY RUN on Linux: not a Mac result)" : ""}`,
    "",
    `${r.startedAt}, ${r.seconds} s; ${r.product} (${r.chrome}); run folder ${r.run}`,
    `Agent flags: ${r.flags.join(" ")}`,
    "",
    `## Result: ${r.ok ? "exit 0: the check never took the operator's focus or Space" : "exit 1"}`,
    ...r.problems.map((p) => `- ${p}`),
    "",
    "## The front app and the Space",
    `- The operator's app at the start: ${r.operator ? `${r.operator.name} (pid ${r.operator.pid})` : "unknown"}; at the end: ${r.frontAtEnd ? `${r.frontAtEnd.name} (pid ${r.frontAtEnd.pid})` : "unknown"}.`,
    `- agent-browser's give-back at the start (launches.log): ${r.startGiveBack.join("; ") || "no line"}.`,
    ...table(["step", "away (ms)", "to", "give-back asks", "back"], r.takes.map((t) => [t.step, t.ms, t.to.join(", "), t.asks, t.t1 === null ? "no" : "yes"])),
    "",
    `Space changes: ${r.spaces.length ? r.spaces.map((s) => `${s.step} (${s.via})`).join("; ") : "none"}.`,
    "",
    "## Where each new agent window came (CGWindowList order, front to back)",
    ...table(["step", "how", "CG window", "place", "on screen", "Space", "front app after"], r.windows.map((w) => [w.step, w.how, w.cg, placementText(w.placement), w.onscreen, w.space, w.front])),
    "",
    "## Drive in a background tab (today's agent mode: default mode, focus emulation at attach)",
    ...table(["step", "ok", "ms", "page", "focus", "frames", "other pages", "front app"], r.tabDrive.map((d) => [d.step, d.ok ? "ok" : `FAIL ${d.error ?? ""}`, d.ms, d.vis, d.focus, d.frames, d.others, d.front])),
    "",
    "## Drive in a window of its own (the design: no focus emulation, no activation)",
    ...table(["step", "ok", "ms", "page", "focus", "frames", "other pages", "front app", "window order"], r.windowDrive.map((d) => [d.step, d.ok ? "ok" : `FAIL ${d.error ?? ""}`, d.ms, d.vis, d.focus, d.frames, d.others, d.front, d.order ?? ""])),
    "",
    "## Records (frames from Chrome; README, Recording, Measured)",
    ...table(["where", "fps", "frames", "s", "largest gap (ms)", "covered", "note"], r.records.map((x) => [x.where, x.fps ?? "", x.frames ?? "", x.seconds ?? "", x.maxFrameGapMs ?? "", x.covered ?? "", x.error ?? x.skipped ?? ""])),
    "",
    "## Focus between agent windows, and keys into an inactive window",
    ...(r.focus.length ? r.focus.map((f) => `- ${f}`) : ["(none)"]),
    "",
    "## Popups (from a page in a window of its own)",
    ...table(["kind", "asked", "opened in", "outer size", "popup page", "opener page", "front app", "place"], r.popups.map((p) => [p.kind, p.asked, p.where, p.outer, p.popup, p.opener, p.front, placementText(p.placement)])),
    "",
    "## The real pointer",
    `- At ${r.pointer.at ? `${r.pointer.at.x},${r.pointer.at.y}` : "unknown"} (the check never moves it).`,
    ...(Object.keys(r.pointer.real).length
      ? Object.entries(r.pointer.real).map(([tab, evs]) => `- ${tab}: ${evs.length} event(s) at the real pointer's point, first ${evs.slice(0, 4).map((e) => `${e.type} at ${e.cx},${e.cy} in ${e.step}`).join("; ")}`)
      : ["- No probe page got an event at the real pointer's point."]),
    "",
    "## Mission Control, App Expose, the Dock menu, Cmd-` (what an API gives)",
    ...r.apis.map((a) => `- ${a}`),
    "",
    "### For the operator: one short look (with --look SECONDS, after the measurement)",
    ...r.look.map((a) => `- ${a}`),
    "",
    "## Not measured",
    ...r.notMeasured.map((a) => `- ${a}`),
    "",
  ];
  return lines.join("\n");
}
