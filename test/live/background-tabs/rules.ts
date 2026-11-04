// The pure parts of the live background-tab check (check.ts): the start guard, the agent Chrome's extra
// switches, the timer statistics and the failure rules. No Chrome, no I/O, so that
// test/background-tabs.test.ts runs them in `npm test`.

/** The two timer flags that AGENT_ARGS dropped in ab-v16.13. --before adds them back, to measure the launch before. */
export const TIMER_FLAGS: readonly string[] = ["--disable-renderer-backgrounding", "--disable-background-timer-throttling"];

/** The page's interval timer asks for this period. */
export const TIMER_MS = 50;

export type Mode = { chrome: string; display: number; before: boolean; hiddenMs: number };
export type Flags = { chrome?: string; display?: string; before?: boolean; hiddenMs?: string };

/** The start guard: the mode to run in, or the usage error (exit 2). */
export function startMode(platform: string, f: Flags): Mode | { error: string } {
  if (platform !== "linux")
    return { error: `the background-tab check runs on Linux only, in a private Xvfb, so that no window reaches a person's screen (this is ${platform})` };
  const display = Number(f.display ?? 98), hiddenMs = Number(f.hiddenMs ?? 6000);
  if (!Number.isInteger(display) || display < 1) return { error: `--display is a whole display number: ${f.display}` };
  if (!Number.isInteger(hiddenMs) || hiddenMs < 2000 || hiddenMs > 60_000) return { error: `--hidden-ms is a whole number of ms from 2000 to 60000: ${f.hiddenMs}` };
  return { chrome: f.chrome ?? "/usr/bin/chromium", display, before: !!f.before, hiddenMs };
}

/**
 * The agent Chrome's switches after agent-browser's own (the chromeArgs option): an X11 window in the
 * private Xvfb, no keyring, no network (every host but probe.localhost fails to resolve and goes to a
 * dead proxy), a fixed window. With `before`, also the two timer flags.
 */
export function chromeArgs(before: boolean): string[] {
  return [
    "--ozone-platform=x11", "--password-store=basic",
    "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-default-apps",
    "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE probe.localhost", "--proxy-server=http://127.0.0.1:9", "--proxy-bypass-list=probe.localhost",
    "--window-position=0,0", "--window-size=1100,700",
    ...(before ? TIMER_FLAGS : []),
  ];
}

/** A page's timer in a window of time: its ticks, the median and the longest gap between two ticks, and its animation frames. */
export type TimerStats = { ticks: number; medianMs: number | null; maxMs: number | null; frames: number };

/** The statistics of the ticks and animation frames (Date.now() times) from `from` to `to`. */
export function timerStats(ticks: readonly number[], frames: readonly number[], from: number, to: number): TimerStats {
  const inside = ticks.filter((t) => t >= from && t <= to);
  const gaps = inside.slice(1).map((t, i) => t - inside[i]).sort((a, b) => a - b);
  const median = gaps.length ? (gaps.length % 2 ? gaps[(gaps.length - 1) / 2] : (gaps[gaps.length / 2 - 1] + gaps[gaps.length / 2]) / 2) : null;
  return { ticks: inside.length, medianMs: median, maxMs: gaps.length ? gaps[gaps.length - 1] : null, frames: frames.filter((t) => t >= from && t <= to).length };
}

/** The page's visibility log: [Date.now(), document.visibilityState] at load and at each visibilitychange. */
export type VisibilityLog = readonly (readonly [number, string])[];

/**
 * The visibility states that the page had from `from` to `to`, in order and without repeats, joined
 * with ", ": "hidden" for a page that was hidden all that time. "unknown" before the log's first entry.
 */
export function visibilityIn(log: VisibilityLog, from: number, to: number): string {
  const at = log.filter(([t]) => t <= from).at(-1)?.[1] ?? "unknown";
  const states = [at, ...log.filter(([t]) => t > from && t <= to).map(([, v]) => v)];
  return states.filter((v, i) => i === 0 || v !== states[i - 1]).join(", ");
}

export type StepName = "click" | "type" | "eval" | "text" | "shot";
export type Step = { step: StepName; ok: boolean; ms: number; detail?: string };
/**
 * One tab driven in one phase; `front` names the tab in front. `visibility` is the page's own state
 * right before the drive's first command (its visibility log); `during` is document.visibilityState
 * as the eval step read it, while agent-browser's command was attached (information only).
 */
export type Drive = { phase: string; tab: string; front: string; visibility: string; during: string; expected: "visible" | "hidden"; steps: Step[] };
/** One tab's timer over a window with no command; `visibility` is the page's own (visibilityIn). */
export type Timer = { phase: string; tab: string; front: string; visibility: string; expected: "visible" | "hidden"; stats: TimerStats };
/** A recording of one tab; `visibility` is the page's own state right before it (as in Drive). */
export type Recording = { tab: string; front: string; visibility: string; frames: number; seconds: number; fps: number; maxFrameGapMs: number } | { tab: string; front: string; error: string } | { tab: string; front: string; skipped: string };
export type Run = { before: boolean; tabs: string[]; drives: Drive[]; timers: Timer[]; recordings: Recording[] };

/**
 * A hidden tab's 50 ms timer: a median of 1000 ms in plain Chrome, 50 ms with the timer flags (on
 * taylor; docs/research/2026-11-03-chrome-vs-chrome-beta.md, section 3 and the appendix).
 */
export const THROTTLED_MIN_MS = 500;
export const FULL_RATE_MAX_MS = 100;

/**
 * Why the run failed, or nothing. Every step of every drive must work, in a hidden tab too; each tab's
 * page must be visible or hidden as the phase expects (by its own log, right before the drive and all
 * through a timer's window); both tabs must be listed. A visible tab's timer runs at full rate. A
 * hidden tab's timer slows down as in plain Chrome (at least THROTTLED_MIN_MS), or with `before` (the
 * timer flags) runs at full rate. A recording must not fail; a skipped one (no ffmpeg) is no failure.
 */
export function failures(run: Run): string[] {
  const out: string[] = [];
  for (const name of ["a", "b"]) if (!run.tabs.includes(name)) out.push(`tabs: tab ${name} is not listed`);
  for (const d of run.drives) {
    for (const s of d.steps) if (!s.ok) out.push(`${d.phase}: tab ${d.tab} (front: ${d.front}) ${s.step}: ${s.detail ?? "failed"}`);
    if (d.visibility !== d.expected) out.push(`${d.phase}: tab ${d.tab} was ${d.visibility} before its drive, expected ${d.expected} (front: ${d.front})`);
  }
  for (const t of run.timers) {
    const where = `${t.phase}: tab ${t.tab}'s timer (front: ${t.front})`;
    if (t.visibility !== t.expected) { out.push(`${where}: the page is ${t.visibility}, expected ${t.expected}`); continue; }
    const m = t.stats.medianMs;
    if (m === null) { out.push(`${where}: fewer than two ticks`); continue; }
    const fullRate = t.expected === "visible" || run.before;
    if (fullRate && m > FULL_RATE_MAX_MS) out.push(`${where}: median ${m} ms, expected at most ${FULL_RATE_MAX_MS} ms (${t.expected === "visible" ? "a visible tab" : "the timer flags"})`);
    if (!fullRate && m < THROTTLED_MIN_MS) out.push(`${where}: median ${m} ms, expected at least ${THROTTLED_MIN_MS} ms (a hidden tab without the timer flags)`);
  }
  for (const r of run.recordings) if ("error" in r) out.push(`record: tab ${r.tab} (front: ${r.front}): ${r.error}`);
  return out;
}
