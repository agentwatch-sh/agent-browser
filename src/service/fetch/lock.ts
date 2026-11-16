// The one private window of the agent Chrome (contract C11, "PageFetch" and the sign-in act's check 7; the PageFetch
// design, section 5.3; board ab-v16.102). All incognito windows of a Chrome share one cookie jar, so the sign-in act and
// PageFetch never run at the same time: one lock in the service serves both. A waiting act gets the window before every
// waiting fetch. The daemon lead's rule: a sign-in act waits for a running fetch and never fails because of it. So an act
// waits at most its check 7 time, and, when a fetch holds the window at the act's request, also that fetch's longest
// hold; the lock ends a fetch's hold at that longest hold also when the fetch's own code has not ended; and a fetch whose
// window did not end (its fetch_end failed) leaves its end to the window's next holder, which runs it before its own
// window. A fetch waits behind at most 8 other waiting fetches (else `busy`), and at most its own wait.

type Kind = "act" | "fetch";
type Waiter = { kind: Kind; go: (release: Release) => void };
/** The end of a hold. A fetch whose window did not end gives the end that the next holder runs first. */
export type Release = (left?: () => Promise<void>) => void;

export const LOCK_LIMITS = {
  /** The most fetches that wait for the window; one more gets `busy`. */
  queue: 8,
  /** A fetch's longest hold of the window: its whole limit (60 s) and its end (20 s). */
  fetchHoldMs: 80_000,
  /** The longest run of a left window's end before the next holder's own window. */
  leftMs: 10_000,
} as const;

export class WindowLock {
  private holder: Kind | null = null;
  private readonly waiting: Waiter[] = [];
  private readonly limits: { queue: number; fetchHoldMs: number; leftMs: number };
  /** The end of a fetch window that did not end, for the next holder. */
  private left: (() => Promise<void>) | null = null;

  constructor(limits: Partial<typeof LOCK_LIMITS> = {}) { this.limits = { ...LOCK_LIMITS, ...limits }; }

  /** Who holds the window now (tests, the status). */
  held(): Kind | null { return this.holder; }
  /** The number of fetches that wait. */
  fetchesWaiting(): number { return this.waiting.filter((w) => w.kind === "fetch").length; }

  /**
   * An act's turn (C11's check 7): the release of the window, or null when the wait passes `waitMs` (plus a fetch's
   * longest hold when a fetch holds the window now). The act goes before every waiting fetch.
   */
  act(waitMs: number): Promise<Release | null> {
    const limit = waitMs + (this.holder === "fetch" ? this.limits.fetchHoldMs : 0);
    return this.wait("act", limit);
  }

  /** A fetch's turn: the release, `busy` when the queue is full, or `timeout` after `waitMs`. */
  async fetch(waitMs: number): Promise<Release | "busy" | "timeout"> {
    if (this.holder !== null && this.fetchesWaiting() >= this.limits.queue) return "busy";
    return (await this.wait("fetch", waitMs)) ?? "timeout";
  }

  private wait(kind: Kind, ms: number): Promise<Release | null> {
    if (this.holder === null && this.waiting.length === 0) return this.take(kind);
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      // The turn stops the wait's limit at once; the end of a left window then runs before the holder's own window.
      const w: Waiter = { kind, go: (release) => { clearTimeout(timer); resolve(release); } };
      // An act goes before every waiting fetch, after the acts that wait before it.
      if (kind === "act") {
        const at = this.waiting.findIndex((x) => x.kind === "fetch");
        if (at < 0) this.waiting.push(w); else this.waiting.splice(at, 0, w);
      } else this.waiting.push(w);
      timer = setTimeout(() => {
        const i = this.waiting.indexOf(w);
        if (i >= 0) { this.waiting.splice(i, 1); resolve(null); }
      }, ms);
    });
  }

  /** The hold of `kind`: the end of a left window first (at most leftMs), then the release. */
  private async take(kind: Kind): Promise<Release> {
    this.holder = kind;
    const left = this.left;
    this.left = null;
    if (left) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([left().catch(() => {}), new Promise<void>((r) => { timer = setTimeout(r, this.limits.leftMs); })]);
      clearTimeout(timer);
    }
    let done = false, hold: NodeJS.Timeout | undefined;
    const release: Release = (l) => {
      if (done) return;
      done = true;
      clearTimeout(hold);
      if (l) this.left = l;
      this.holder = null;
      const next = this.waiting.shift();
      if (next) void this.take(next.kind).then(next.go);
    };
    // A fetch never holds the window past its longest hold, also when its own code has not ended.
    if (kind === "fetch") { hold = setTimeout(() => release(), this.limits.fetchHoldMs); hold.unref?.(); }
    return release;
  }
}
