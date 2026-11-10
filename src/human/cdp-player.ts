// The CDP player (board ab-t30.3; the input design, sections 4.6 and 11.1; C11 "The input stage", the timestamps and the
// rate): it sends a plan's events over a `send` function, each one at its time with its timestamp, and it never waits
// for the answer of a move before it sends the next one, so Chromium puts the moves of one frame into one pointermove
// with their samples, as for a real mouse. Its I/O is the `send` function and the clock, both arguments.
//
// - The timestamp: a person's input latency before the send, `(now - latency) / 1000`, in whole ms on Linux (X11's event
//   times are whole ms) and with its fraction on the Mac. It comes from the send, never from the plan, so no event has a
//   time in the future. The latency is drawn once for each plan (a device's latency over one path; first value 3 to
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

export type Send = (method: string, params: Record<string, unknown>) => Promise<unknown>;

export type PlayerOptions = {
  clock?: Clock;
  /** The epoch time (ms) of the send: linuxStamp, macStamp, or a test's. */
  stamp?: () => number;
  /** The input latency (ms), drawn once for each plan. */
  latencyMs: readonly [number, number];
  /** Timestamps in whole ms (Linux). */
  wholeMs: boolean;
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

export type MovesResult = { sent: number; stopped: boolean };

export class CdpPlayer {
  private readonly clock: Clock;
  private readonly stamp: () => number;
  private readonly send: Send;
  private readonly o: PlayerOptions;
  constructor(send: Send, o: PlayerOptions) {
    this.send = send;
    this.o = o;
    this.clock = o.clock ?? systemClock;
    this.stamp = o.stamp ?? (o.wholeMs ? linuxStamp : macStamp);
  }

  /** The CDP timestamp of an event sent now (seconds): a latency before the send, in whole ms when wholeMs. */
  timestamp(latency = this.latency()): number {
    const ms = this.stamp() - latency;
    return (this.o.wholeMs ? Math.round(ms) : ms) / 1000;
  }
  private latency(): number { return uniform(this.o.random, this.o.latencyMs[0], this.o.latencyMs[1]); }

  /** One event, with its timestamp, after the `before` check; its answer awaited. */
  async event(method: string, params: Record<string, unknown>): Promise<unknown> {
    this.o.before?.();
    return this.send(method, { ...params, timestamp: this.timestamp() });
  }

  /**
   * The moves of a plan (mouseMoved, with `extra` fields such as buttons and modifiers), each at its time from now, none
   * awaited before the next; then the answers of all of them. `stopped`: a move was due while maxInFlight waited, and
   * the player sent no more (the caller sends its own last event).
   */
  async moves(samples: readonly Sample[], extra: Record<string, unknown> = {}): Promise<MovesResult> {
    const t0 = this.clock.now(), scale = this.o.scale ?? 1, gap = this.o.minGapMs ?? 0, pending: Promise<void>[] = [];
    let inFlight = 0, sent = 0, stopped = false, last = -Infinity, failed: { e: unknown } | undefined;
    const lat = this.o.latencyPerEvent ? undefined : this.latency();
    const settle = () => Promise.all(pending);
    for (const s of samples) {
      const due = Math.max(t0 + s.t * scale, last + gap), wait = due - this.clock.now();
      if (wait > 0) await this.clock.sleep(wait);
      if (failed) break;
      if (inFlight >= this.o.maxInFlight) { stopped = true; break; }
      try { this.o.before?.(); } catch (e) { await settle(); throw e; }
      const p = this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: s.x, y: s.y, button: "none", buttons: 0, ...extra, timestamp: this.timestamp(lat ?? this.latency()) });
      inFlight++;
      sent++;
      pending.push(p.then(() => { inFlight--; }, (e) => { inFlight--; failed ??= { e }; }));
      last = this.clock.now();
    }
    // A stopped path does not wait for answers that a page with an open dialog never gives (each one has its handler).
    if (stopped) return { sent, stopped };
    await settle();
    if (failed) throw failed.e;
    return { sent, stopped };
  }
}
