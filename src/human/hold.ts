// The press and hold (board ab-t30.34; contract C11, the input stage's hold, and the service's own tool
// browser_press_hold): a person's long press on a button that fills while it is held (a press-and-hold check, as HUMAN
// Security's "Press & Hold"). Pure: the random source is an argument, and the stage (src/relay/stage.ts, Stage.hold) sends
// the events and reads the pixels.
//
// - The hand during the hold: a hand that holds a mouse button is not still. The stage sends a move of 1 px with the
//   button down at random gaps of 150 to 600 ms, never more than 2 px from the press point (Chrome starts a drag at the
//   first move more than 4 px from the press on one axis: C11, the drag), so no move starts a drag.
// - The end of the hold, the first of: the element's done state (the pixels of its box changed and then stayed the same
//   for 300 ms: PixelWatch), a navigation of the main frame, the element gone, or the time limit `maxMs` (default 15000,
//   at most 20000: under STAGE_ACTION_MAX_MS).
// - The release: 150 to 400 ms after the done state, as a person who sees the check mark; at once after a navigation, an
//   element that went away, or the time limit.
//
// These are first values (no recording of a person's long hold yet: a Mac recording on the local test page can calibrate
// the release delay; board ab-t30.34's notes).

import type { Pt } from "./path.ts";
import { uniform, type Random } from "./random.ts";

/** The hold's first values (C11, the input stage's hold). */
export const HOLD = {
  /** The time limit of a hold when the caller gives none (ms). */
  defaultMs: 15_000,
  /** The least and the most a caller may give (ms); the most stays under STAGE_ACTION_MAX_MS (25000). */
  minMs: 1_000,
  maxMs: 20_000,
  /** The gaps between the hand's moves with the button down (ms), and the farthest a move goes from the press point (px). */
  moveGapMs: [150, 600] as const,
  moveMaxPx: 2,
  /** The pixel reads of the element's box: one each readMs; done when they changed and then stayed the same for stableMs. */
  readMs: 100,
  stableMs: 300,
  /** The release after the done state (ms). */
  releaseAfterMs: [150, 400] as const,
} as const;

/** The gap before the hand's next move with the button down (ms). */
export const moveGapMs = (random: Random) => uniform(random, HOLD.moveGapMs[0], HOLD.moveGapMs[1]);
/** The release's delay after the done state (ms). */
export const releaseAfterMs = (random: Random) => uniform(random, HOLD.releaseAfterMs[0], HOLD.releaseAfterMs[1]);

/**
 * The hand's next point during a hold: a step of 1 px along one axis from `at`, to a point at most HOLD.moveMaxPx from
 * the press point `press` (whole px), chosen at random among the four steps that stay inside that bound.
 */
export function handStep(at: Pt, press: Pt, random: Random): Pt {
  const steps = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }]
    .map((d) => ({ x: at.x + d.x, y: at.y + d.y }))
    .filter((p) => Math.hypot(p.x - press.x, p.y - press.y) <= HOLD.moveMaxPx + 1e-9);
  return steps[Math.min(steps.length - 1, Math.floor(random() * steps.length))] ?? press;
}

/**
 * The hand's moves of a whole hold of `ms` from the press (the stage plays them one at a time; the tests read the plan):
 * each one's time from the press and its point.
 */
export function handMoves(press: Pt, ms: number, random: Random): { t: number; x: number; y: number }[] {
  const out: { t: number; x: number; y: number }[] = [];
  let at = press;
  for (let t = moveGapMs(random); t < ms; t += moveGapMs(random)) { at = handStep(at, press, random); out.push({ t, ...at }); }
  return out;
}

/**
 * The done state of the element by its pixels: each read gives the bytes of a screenshot of the element's box (null: no
 * read). The first read is the baseline. A read that differs from the one before it is a change; the done state is a
 * change, and then the same pixels for HOLD.stableMs (a fill that grows, then its check mark, then nothing moves).
 */
export class PixelWatch {
  private last: string | null = null;
  private changedAt: number | null = null;
  /** Whether a read differed from the one before it. */
  get changed(): boolean { return this.changedAt !== null; }
  /** Whether any read came. */
  get reads(): boolean { return this.last !== null; }
  private readonly stableMs: number;
  constructor(stableMs: number = HOLD.stableMs) { this.stableMs = stableMs; }
  /** One read at time `t` (ms): true at the done state. */
  read(t: number, shot: string | null): boolean {
    if (shot === null) return false;
    if (this.last === null) { this.last = shot; return false; }
    if (shot !== this.last) { this.last = shot; this.changedAt = t; return false; }
    return this.changedAt !== null && t - this.changedAt >= this.stableMs;
  }
}

/**
 * How a hold ended: the done state (its pixels), a navigation of the main frame, a new document of the target's
 * cross-origin frame, the element gone, the time limit, or "stopped" (the input stage ended its plan: a dialog, an event
 * with no answer, the action's limit, a refused move, the tab's end, an error of the stage).
 */
export type HoldEnd = "done" | "navigation" | "frame" | "gone" | "limit" | "stopped";
/**
 * A hold's outcome (Stage.hold): its end, the time from the press's send to the release's send, the hand's moves, the
 * limit, what the pixel reads saw (none: no read; still: no change; changing: a change), and for "stopped" why; or why
 * there was no press.
 */
export type HoldResult =
  | { ok: true; end: HoldEnd; heldMs: number; moves: number; maxMs: number; pixels: "none" | "still" | "changing"; why?: string }
  | { ok: false; why: string };

/** The argument maxMs of browser_press_hold: the hold's limit, or the refusal's reason. */
export function holdLimit(v: unknown): number | { why: string } {
  if (v === undefined) return HOLD.defaultMs;
  if (typeof v !== "number" || !Number.isInteger(v) || v < HOLD.minMs || v > HOLD.maxMs) return { why: `maxMs must be a whole number of ms from ${HOLD.minMs} to ${HOLD.maxMs}.` };
  return v;
}

/** A snapshot ref of the pinned MCP (its targetLocators: a ref, else a selector), the only form that `ref` takes. */
export const SNAPSHOT_REF = /^(f[0-9]+)?e[0-9]+$/;

/**
 * The answer's text of a hold (C11, browser_press_hold). "Done" says only that the element's pixels stopped changing (a
 * fill that is full, a check mark): it is no verdict of the page.
 */
export function holdText(r: HoldResult): string {
  if (!r.ok) return `Not held: ${r.why}`;
  const held = `the hold lasted ${r.heldMs} ms`;
  switch (r.end) {
    case "done": return `Done: ${held}; it ended when the element's pixels changed and then stayed the same. That is not the page's verdict: take a new snapshot to see the page.`;
    case "navigation": return `Navigated: ${held}; the page navigated, so the agent browser released the button at once.`;
    case "frame": return `Frame loaded: ${held}; the element's frame loaded a new document, so the agent browser released the button at once.`;
    case "gone": return `Element gone: ${held}; the element went away, so the agent browser released the button at once.`;
    case "limit": return `Time limit: ${held}, the limit of ${r.maxMs} ms; ${r.pixels === "none" ? "the agent browser could not read the element's pixels" : r.pixels === "still" ? "the element did not change" : "the element did not stop changing"}.`;
    case "stopped": return `Not held to the end: ${held}; ${r.why ?? "the input stage ended the hold"}.`;
  }
}
