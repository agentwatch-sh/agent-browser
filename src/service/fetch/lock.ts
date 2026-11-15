// The one private window of the agent Chrome (contract C11, "PageFetch" and the sign-in act's check 7; the PageFetch
// design, section 5.3; board ab-v16.102). All incognito windows of a Chrome share one cookie jar, so the sign-in act and
// PageFetch never run at the same time: one lock in the service serves both. A waiting act gets the window before every
// waiting fetch. An act waits at most its check 7 time, and, when a fetch holds the window at the act's request, also
// that fetch's longest hold, so an act never fails behind one fetch. A fetch waits behind at most 8 other waiting
// fetches (else `busy`), and at most `fetchWaitMs`.

type Waiter = { kind: "act" | "fetch"; go: (release: () => void) => void };

export const LOCK_LIMITS = {
  /** The most fetches that wait for the window; one more gets `busy`. */
  queue: 8,
  /** A fetch's longest hold of the window: its whole limit (60 s) and its end (20 s). */
  fetchHoldMs: 80_000,
} as const;

export class WindowLock {
  private holder: "act" | "fetch" | null = null;
  private readonly waiting: Waiter[] = [];
  private readonly limits: { queue: number; fetchHoldMs: number };

  constructor(limits: Partial<typeof LOCK_LIMITS> = {}) { this.limits = { ...LOCK_LIMITS, ...limits }; }

  /** Who holds the window now (tests, the status). */
  held(): "act" | "fetch" | null { return this.holder; }
  /** The number of fetches that wait. */
  fetchesWaiting(): number { return this.waiting.filter((w) => w.kind === "fetch").length; }

  /**
   * An act's turn (C11's check 7): the release of the window, or null when the wait passes `waitMs` (plus a fetch's
   * longest hold when a fetch holds the window now). The act goes before every waiting fetch.
   */
  act(waitMs: number): Promise<(() => void) | null> {
    const limit = waitMs + (this.holder === "fetch" ? this.limits.fetchHoldMs : 0);
    return this.wait("act", limit);
  }

  /** A fetch's turn: the release, `busy` when the queue is full, or `timeout` after `waitMs`. */
  async fetch(waitMs: number): Promise<(() => void) | "busy" | "timeout"> {
    if (this.holder !== null && this.fetchesWaiting() >= this.limits.queue) return "busy";
    return (await this.wait("fetch", waitMs)) ?? "timeout";
  }

  private wait(kind: "act" | "fetch", ms: number): Promise<(() => void) | null> {
    if (this.holder === null && this.waiting.length === 0) return Promise.resolve(this.take(kind));
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined;
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

  private take(kind: "act" | "fetch"): () => void {
    this.holder = kind;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.holder = null;
      const next = this.waiting.shift();
      if (next) next.go(this.take(next.kind));
    };
  }
}
