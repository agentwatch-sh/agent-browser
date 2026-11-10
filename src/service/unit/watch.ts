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

import { readFileSync } from "node:fs";
import { writeJsonDurable } from "./record.ts";

export const RECEIVER_MISSING_MS = 60_000;
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
};

type Count = { v: 1; boot: string | null; pid: number; start: number | null; since: number };

/** The monotonic clock of the box in ms: CLOCK_MONOTONIC through libuv's hrtime. */
export const monotonicMs = () => Number(process.hrtime.bigint() / 1_000_000n);

export class FailClosedWatch {
  private readonly d: WatchDeps;
  private count: Count | null = null;
  private lastCheck: number | null = null;
  private lastWrite = 0;
  private stopping = false;

  constructor(d: WatchDeps) { this.d = d; }

  private read(): Count | null {
    try {
      const o = JSON.parse(readFileSync(this.d.file, "utf8"));
      if (o && o.v === 1 && Number.isSafeInteger(o.pid) && (o.start === null || Number.isSafeInteger(o.start)) && Number.isFinite(o.since) && (o.boot === null || typeof o.boot === "string")) return o as Count;
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
    if (link.ready() && link.confirmed()) {
      c.since = now;
      if (now - this.lastWrite >= RENEW_MS) this.write(c, now);
      return;
    }
    // A request runs on a live link: the time since the last check does not count.
    if (link.ready() && link.busy() && last !== null) { c.since = Math.min(now, c.since + (now - last)); return; }
    if (now - c.since < (this.d.limitMs ?? RECEIVER_MISSING_MS) || this.stopping) return;
    const reason: WatchStop = link.ready() && link.scopesReady() && !this.d.sessionsComplete() ? "sessions_unread" : "receiver_missing";
    this.stopping = true;
    try {
      this.d.log(reason === "sessions_unread"
        ? `watch: Chrome ran ${Math.round((now - c.since) / 1000)} s and the sessions could not be read, so no list could go to the receiver; stopping it (no confirmed list means no allowlist block)`
        : `watch: Chrome ran ${Math.round((now - c.since) / 1000)} s with no receiver that confirmed the lists; stopping it (no receiver means no allowlist block)`);
      if (await this.d.stop(reason)) this.count = null;
    } finally { this.stopping = false; }
  }
}
