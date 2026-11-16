// The fail-closed watch of the Chrome unit (the self-contained design, section 13.2 and build note 5 of section 13.5;
// board ab-v16.94.3; the rule of agentwatch's daemon/browser/service.py, check_receiver, RECEIVER_MISSING_S). While
// Chrome runs, its receiver must hold a linked connection and must have confirmed the current lists. A Chrome that
// runs RECEIVER_MISSING_MS without both is stopped, and one `stopped` event goes out: `receiver_missing`, or
// `sessions_unread` when a receiver is there but no complete set_sessions came, so no list could go.
//
// Build note 5: a crash loop slower than the start limit never ends `failed`, and each instance would start a new
// count. So the count runs from the last confirm on this Chrome (its pid and start time), kept on disk (watch.json in
// the state folder), with the kernel's boot id: a new instance of the service goes on with the count of the one before.
// A Chrome that no confirm reached counts from the first time that a watch saw it. The time between two checks does
// not count while a request runs on a live link (the link says `busy`).
//
// Stage 1b part 1 has no native link (part 2, board ab-v16.94.9): its link port is never ready, so the watch stops a
// Chrome 60 s after the last confirm on it, with the reason receiver_missing.
//
// The Mac (board ab-v16.94.19; the design, section 10; PR #145's Mac check 7), with `hold`: the operator loads the agent
// package by hand ("Load unpacked", once for each agent profile), which can take more than 60 s. So a Chrome on which no
// receiver held a linked connection yet is stopped only after `hold.ms` (LOAD_HOLD_MS), and after LOAD_NOTE_MS with no
// receiver the watch logs what the operator does (`hold.note`). Once a receiver linked on that Chrome, the 60 s rule
// holds again, counted from no earlier than that first link (review-151 note 1). It holds also after a restart of the
// service: the first confirm on that Chrome writes `linked` into the count on disk, with that confirm's time (review-147
// note 1, review-151 B1, board ab-v16.94.21); a restart before that first confirm keeps the hold. With no receiver no
// agent's request reaches that Chrome: the model's only way in is
// the link, and the Chrome has no debugging port.

import { readFileSync } from "node:fs";
import { writeJsonDurable } from "./record.ts";

export const RECEIVER_MISSING_MS = 60_000;
/** The Mac: the longest wait for the first receiver of a Chrome (the operator's one-time "Load unpacked"). */
export const LOAD_HOLD_MS = 5 * 60_000;
/** The Mac: no receiver for this long on a Chrome gives the operator's note (a loaded receiver links within a few seconds). */
export const LOAD_NOTE_MS = 15_000;
/** While confirmed, the count on disk is renewed at most this often (a lost renewal only shortens the next count). */
export const RENEW_MS = 10_000;

/** What the watch needs of the native link (part 2 gives the real one). */
export type LinkPort = {
  /** A receiver holds a linked connection (its hello came). */
  ready(): boolean;
  /** The receiver of the current connection confirmed the current set_scopes object in time. */
  confirmed(): boolean;
  /** A request runs on a live link: the time does not count. */
  busy(): boolean;
  /** The receiver takes set_scopes. */
  scopesReady(): boolean;
};
/** Stage 1b part 1: no native link. */
export const NO_LINK: LinkPort = { ready: () => false, confirmed: () => false, busy: () => false, scopesReady: () => false };

export type WatchStop = "receiver_missing" | "sessions_unread";

export type WatchDeps = {
  file: string;
  bootId: () => string | null;
  /** The monotonic clock in ms (CLOCK_MONOTONIC: the same clock for each instance of the service until a reboot). */
  clock: () => number;
  link: LinkPort;
  /** A complete set_sessions came. */
  sessionsComplete: () => boolean;
  /** The Chrome that runs now, by pid and start time, or null. */
  chrome: () => { pid: number; start: number | null } | null;
  /** Stop Chrome for `reason` (the owner rule is asked first); true when it stopped. */
  stop: (reason: WatchStop) => Promise<boolean>;
  log: (line: string) => void;
  limitMs?: number;
  /** The Mac: the wait for a Chrome's first receiver (`ms`, LOAD_HOLD_MS) and the operator's note (what to load, and where). */
  hold?: { ms: number; note: () => string };
};

/** `linked`: a receiver confirmed the lists on this Chrome (written at its first confirm, with that confirm's `since`). */
type Count = { v: 1; boot: string | null; pid: number; start: number | null; since: number; linked?: true };

/** The monotonic clock of the box in ms: CLOCK_MONOTONIC through libuv's hrtime. */
export const monotonicMs = () => Number(process.hrtime.bigint() / 1_000_000n);

export class FailClosedWatch {
  private readonly d: WatchDeps;
  private count: Count | null = null;
  private lastCheck: number | null = null;
  private lastWrite = 0;
  private stopping = false;
  /** The Chrome (pid:start) on which a receiver held a linked connection, the Chrome whose note went to the log, and the last watch stop's Chrome had none. */
  private linked = "";
  /** The moment of the first link on `linked`'s Chrome in this run (the Mac's 60 s count starts no earlier); 0 when `linked` came from disk. */
  private linkedAt = 0;
  private noted = "";
  private stoppedUnlinked = false;

  constructor(d: WatchDeps) { this.d = d; }

  /** The limit of `chrome` now: the hold while no receiver linked on it (the Mac), else the 60 s rule. */
  private limitOf(chrome: { pid: number; start: number | null }): number {
    const limit = this.d.limitMs ?? RECEIVER_MISSING_MS;
    return this.d.hold && this.linked !== `${chrome.pid}:${chrome.start}` ? Math.max(limit, this.d.hold.ms) : limit;
  }

  /** The Mac: the watch's last stop was of a Chrome on which no receiver ever linked, so the hold applied (board ab-v16.94.33). */
  stoppedBeforeLink(): boolean { return this.stoppedUnlinked; }

  /**
   * The Mac: the operator's note applies: the Chrome that runs now had no receiver for LOAD_NOTE_MS (and none linked on
   * it yet), or no Chrome runs and the watch's last stop was of a Chrome on which no receiver ever linked.
   */
  awaitsLoad(): boolean {
    if (!this.d.hold) return false;
    const chrome = this.d.chrome();
    if (!chrome) return this.stoppedUnlinked;
    const missing = this.missingFor();
    return this.linked !== `${chrome.pid}:${chrome.start}` && missing !== null && missing >= LOAD_NOTE_MS;
  }

  private read(): Count | null {
    try {
      const o = JSON.parse(readFileSync(this.d.file, "utf8"));
      if (o && o.v === 1 && Number.isSafeInteger(o.pid) && (o.start === null || Number.isSafeInteger(o.start)) && Number.isFinite(o.since) && (o.boot === null || typeof o.boot === "string") && (o.linked === undefined || o.linked === true)) return o as Count;
    } catch {}
    return null;
  }

  private write(c: Count, now: number): void {
    this.lastWrite = now;
    try { writeJsonDurable(this.d.file, c); } catch (e) { this.d.log(`watch: could not write its count: ${(e as NodeJS.ErrnoException).code ?? (e as Error).name}`); }
  }

  /** The count of `chrome`: the one in memory, else the one on disk when it names this Chrome on this boot, else a new one from now. */
  private countFor(chrome: { pid: number; start: number | null }, now: number): Count {
    const c = this.count;
    if (c && c.pid === chrome.pid && c.start === chrome.start) return c;
    const boot = this.d.bootId();
    const disk = this.read();
    if (disk && disk.pid === chrome.pid && disk.start === chrome.start && disk.boot === boot && boot !== null && disk.since <= now) {
      this.count = disk;
      // A receiver linked on this Chrome before the restart: the 60 s rule, and no operator's note (review-147 note 1).
      if (disk.linked) { this.linked = `${chrome.pid}:${chrome.start}`; this.linkedAt = 0; }
      this.d.log(`watch: goes on with the count of Chrome pid ${chrome.pid} from ${Math.round((now - disk.since) / 1000)} s ago`);
      return disk;
    }
    const fresh: Count = { v: 1, boot, pid: chrome.pid, start: chrome.start, since: now };
    this.count = fresh;
    this.write(fresh, now);
    return fresh;
  }

  /** How long the current Chrome has run with no confirm (ms), or null while none runs. */
  missingFor(): number | null {
    const chrome = this.d.chrome();
    if (!chrome || !this.count || this.count.pid !== chrome.pid) return null;
    return Math.max(0, this.d.clock() - this.count.since);
  }

  /** One check (each second). */
  async tick(): Promise<void> {
    const now = this.d.clock();
    const chrome = this.d.chrome();
    const last = this.lastCheck;
    this.lastCheck = now;
    if (!chrome) return;
    const c = this.countFor(chrome, now);
    const link = this.d.link;
    const key = `${chrome.pid}:${chrome.start}`;
    if (link.ready()) {
      if (this.linked !== key) { this.linked = key; this.linkedAt = now; }
      this.stoppedUnlinked = false;
    }
    const hold = this.d.hold;
    if (hold && this.linked !== key && this.noted !== key && now - c.since >= LOAD_NOTE_MS) {
      this.noted = key;
      this.d.log(`watch: no agent extension connected to Chrome pid ${chrome.pid} in ${Math.round((now - c.since) / 1000)} s; ${hold.note()}; the watch waits up to ${Math.round(this.limitOf(chrome) / 1000)} s for it`);
    }
    if (link.ready() && link.confirmed()) {
      c.since = now;
      // The first confirm writes `linked` at once, with this `since`: a restart then keeps the 60 s rule from here, never
      // from the first time that a watch saw this Chrome (review-151 B1).
      if (!c.linked || now - this.lastWrite >= RENEW_MS) { c.linked = true; this.write(c, now); }
      return;
    }
    // A request runs on a live link: the time since the last check does not count.
    if (link.ready() && link.busy() && last !== null) { c.since = Math.min(now, c.since + (now - last)); return; }
    // With the hold, the 60 s of a Chrome whose first link came late count from that link, not from before it (review-151 note 1).
    const from = hold && this.linked === key ? Math.max(c.since, this.linkedAt) : c.since;
    if (now - from < this.limitOf(chrome) || this.stopping) return;
    const reason: WatchStop = link.ready() && link.scopesReady() && !this.d.sessionsComplete() ? "sessions_unread" : "receiver_missing";
    this.stopping = true;
    try {
      this.d.log(reason === "sessions_unread"
        ? `watch: Chrome ran ${Math.round((now - c.since) / 1000)} s and the sessions could not be read, so no list could go to the receiver; stopping it (no confirmed list means no allowlist block)`
        : `watch: Chrome ran ${Math.round((now - c.since) / 1000)} s with no receiver that confirmed the lists; stopping it (no receiver means no allowlist block)`);
      if (await this.d.stop(reason)) { this.count = null; this.stoppedUnlinked = !!hold && this.linked !== key; }
    } finally { this.stopping = false; }
  }
}
