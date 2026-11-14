// The CDP player (board ab-t30.3; the input design, sections 4.6 and 11.1; C11 "The input stage", the timestamps and the
// rate): it sends a plan's events over a `send` function, each one at its time with its timestamp, and it never waits
// for the answer of a move before it sends the next one, so Chromium puts the moves of one frame into one pointermove
// with their samples, as for a real mouse. Its I/O is the `send` function and the clock, both arguments.
//
// - The timestamp: a person's input latency before the send, `(now - latency) / 1000`, on a whole ms of the X server's
//   clock on Linux (X11's event times are whole ms of the monotonic clock; board ab-t30.15: `xGridMs`) and with its
//   fraction on the Mac. It comes from the send, never from the plan, so no event has a time in the future. The latency is drawn once for each plan (a device's latency over one path; first value 3 to
//   5 ms), and for each single event: measured on taylor (the harness, ab-t30.3), one latency for each event gave a
//   wider spread of sample gaps and fewer samples per pointermove (1.66 against 1.83 on XTEST's paths).
// - The rate: each move at its planned time (one each 8 ms at 125 Hz), times `scale` (agent-browser's moveScale).
// - The bound: at most `maxInFlight` (STAGE_MOVES_IN_FLIGHT, 8) moves without an answer. When a move is due while that
//   many wait (a page with an open dialog, a busy renderer), the player stops the path and says so; the caller sends
//   its own last event.
// - An error of an event stops the plan: no later event of it goes, and the error is the plan's.

import type { Sample } from "./path.ts";
import { uniform, type Random } from "./random.ts";

/** The player's clock: `now` in ms for the schedule, `sleep` to wait. A test gives a fake one. */
export type Clock = { now(): number; sleep(ms: number): Promise<void> };
export const systemClock: Clock = { now: () => performance.now(), sleep: (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms))) };
/** The epoch time (ms) of a timestamp: the wall clock on Linux (its event times are whole ms), the fine clock on the Mac. */
export const linuxStamp = () => Date.now();
export const macStamp = () => performance.timeOrigin + performance.now();

/** The monotonic clock (ms): on Linux the clock of the X server's event times and of Chrome's TimeTicks. */
const monoMs = () => Number(process.hrtime.bigint()) / 1e6;
/** The reads of clockOffsetMs: the median of this many edges of Date.now() whose two monotonic reads are this close (ms). */
const OFFSET_READS = 5, OFFSET_BRACKET_MS = 0.005;

/**
 * The offset (ms) of the monotonic clock to the wall clock (board ab-t30.15): the monotonic time at a change of `now()`
 * (Date.now(), whole ms), less that ms. The median of OFFSET_READS changes whose monotonic reads before and after are
 * at most OFFSET_BRACKET_MS apart (a read that the box cuts with a delay is left out); of all of them when too few are.
 * About 5 ms of reads.
 */
export function clockOffsetMs(now: () => number = Date.now, mono: () => number = monoMs): number {
  const narrow: number[] = [], all: number[] = [];
  for (let i = 0; i < OFFSET_READS * 4 && narrow.length < OFFSET_READS; i++) {
    // `m` is read before the last read of d0, `after` after the first read of the next ms: the change is between them.
    let m = mono();
    const d0 = now();
    for (;;) {
      const next = mono(), d = now();
      if (d !== d0) {
        const after = mono(), v = (m + after) / 2 - d;
        all.push(v);
        if (after - m <= OFFSET_BRACKET_MS) narrow.push(v);
        break;
      }
      m = next;
    }
  }
  const list = (narrow.length >= OFFSET_READS ? narrow : all).sort((a, b) => a - b);
  return list[Math.floor(list.length / 2)];
}

let xGrid: number | undefined;
/**
 * The grid of the timestamps on Linux (board ab-t30.15; C11, the timestamps): the offset of the monotonic clock to the
 * wall clock, read once. Chrome maps a CDP timestamp to its TimeTicks by the same offset, which it reads once
 * (`TimeTicks::UnixEpoch()`), and Chrome's X11 events have whole ms of the monotonic clock. So a timestamp on a whole ms
 * of this grid gives the page whole-ms gaps also to the X server's own events (the event at an activation).
 */
export function xGridMs(): number { return (xGrid ??= clockOffsetMs()); }

export type Send = (method: string, params: Record<string, unknown>) => Promise<unknown>;

export type PlayerOptions = {
  clock?: Clock;
  /** The epoch time (ms) of the send: linuxStamp, macStamp, or a test's. */
  stamp?: () => number;
  /** The input latency (ms), drawn once for each plan. */
  latencyMs: readonly [number, number];
  /** Timestamps in whole ms (Linux). */
  wholeMs: boolean;
  /**
   * With wholeMs: the timestamps are whole ms of a clock this many ms ahead of the wall clock. By default the X server's
   * clock (xGridMs) with the system's stamp, and 0 (the epoch's whole ms) with a test's stamp.
   */
  gridMs?: number;
  random: Random;
  /** STAGE_MOVES_IN_FLIGHT. */
  maxInFlight: number;
  /** A factor on the plan's times (agent-browser's inputTiming.moveScale; 1 for a person's rate). */
  scale?: number;
  /** The least time between two sends (ms), whatever the scale: a page's event (a navigation) is read between two moves. */
  minGapMs?: number;
  /** Runs before each send (agent-browser's guard); a throw stops the plan. */
  before?: () => void;
  /** One latency for each move, not one for all the moves of a plan (only for a measurement). */
  latencyPerEvent?: boolean;
};

/**
 * `stopped`: a move was due while maxInFlight waited, or `stop` said so, or `until` ended the wait for the answers; then
 * the player sent no more (the caller sends its own last event). `ended`: the caller's `stop` or `until` ended it.
 */
export type MovesResult = { sent: number; stopped: boolean; ended?: boolean };
/**
 * The input stage's options of one path (C11 "The input stage"): `latency`, the plan's own input latency; `inFlight`,
 * the moves of the tab without an answer, shared by its paths (STAGE_MOVES_IN_FLIGHT is a bound for each tab); `stop`,
 * checked before each send (the plan ended); `until`, which ends the wait for the next move's time and for the answers.
 */
export type MovesOptions = { latency?: number; inFlight?: { n: number }; stop?: () => boolean; until?: Promise<unknown> };

export class CdpPlayer {
  private readonly clock: Clock;
  private readonly stamp: () => number;
  private readonly send: Send;
  private readonly o: PlayerOptions;
  private readonly grid: number;
  constructor(send: Send, o: PlayerOptions) {
    this.send = send;
    this.o = o;
    this.clock = o.clock ?? systemClock;
    this.stamp = o.stamp ?? (o.wholeMs ? linuxStamp : macStamp);
    this.grid = o.wholeMs ? o.gridMs ?? (o.stamp ? 0 : xGridMs()) : 0;
  }

  /** The CDP timestamp of an event sent now (seconds): a latency before the send, on a whole ms of the grid when wholeMs. */
  timestamp(latency = this.latency()): number {
    const ms = this.stamp() - latency;
    return (this.o.wholeMs ? Math.round(ms + this.grid) - this.grid : ms) / 1000;
  }
  private latency(): number { return uniform(this.o.random, this.o.latencyMs[0], this.o.latencyMs[1]); }

  /** One event, with its timestamp (a plan's latency when given), after the `before` check; its answer awaited. */
  async event(method: string, params: Record<string, unknown>, latency?: number): Promise<unknown> {
    this.o.before?.();
    return this.send(method, { ...params, timestamp: this.timestamp(latency) });
  }

  /**
   * The moves of a plan (mouseMoved, with `extra` fields such as buttons and modifiers), each at its time from now, none
   * awaited before the next; then the answers of all of them. `stopped`: a move was due while maxInFlight waited, and
   * the player sent no more (the caller sends its own last event).
   */
  async moves(samples: readonly Sample[], extra: Record<string, unknown> = {}, o: MovesOptions = {}): Promise<MovesResult> {
    const t0 = this.clock.now(), scale = this.o.scale ?? 1, gap = this.o.minGapMs ?? 0, pending: Promise<void>[] = [];
    const flight = o.inFlight ?? { n: 0 };
    let sent = 0, stopped = false, ended = false, last = -Infinity, failed: { e: unknown } | undefined;
    const lat = this.o.latencyPerEvent ? undefined : o.latency ?? this.latency();
    const settle = () => Promise.all(pending);
    for (const s of samples) {
      const due = Math.max(t0 + s.t * scale, last + gap), wait = due - this.clock.now();
      if (wait > 0) await (o.until ? Promise.race([this.clock.sleep(wait), o.until]) : this.clock.sleep(wait));
      if (failed) break;
      if (o.stop?.()) { stopped = true; ended = true; break; }
      if (flight.n >= this.o.maxInFlight) { stopped = true; break; }
      try { this.o.before?.(); } catch (e) { await settle(); throw e; }
      const p = this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: s.x, y: s.y, button: "none", buttons: 0, ...extra, timestamp: this.timestamp(lat ?? this.latency()) });
      flight.n++;
      sent++;
      pending.push(p.then(() => { flight.n--; }, (e) => { flight.n--; failed ??= { e }; }));
      last = this.clock.now();
    }
    // A stopped path does not wait for answers that a page with an open dialog never gives (each one has its handler).
    if (stopped) return { sent, stopped, ...(ended ? { ended } : {}) };
    // The caller's end (a dialog, a limit) also ends the wait for the answers.
    if (o.until) {
      const done = await Promise.race([settle().then(() => true), o.until.then(() => false)]);
      if (!done) return { sent, stopped: true, ended: true };
    } else await settle();
    if (failed) throw failed.e;
    return { sent, stopped };
  }
}
