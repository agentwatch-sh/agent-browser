// The Chrome unit inside `agent-browser service`: stage 1b part 1 of the self-contained agent browser (the design,
// sections 5.1, 5.6 and 13.2; contract C12; board ab-v16.94.3). One part of the service (part.ts, ServicePart):
//
// - the ops `start` and `stop` of the control door (kind operator or token; the door logs each with its provenance),
//   which answer when Chrome runs or is gone; a stop's `stopped` event and `last_stop` carry its `by`;
// - the events `ready` (Chrome and Xvfb run after a start, a supervisor's restart, an adoption or a move), `chrome`
//   (its version and update state changed) and `stopped` (`stop`, `receiver_missing`, `sessions_unread`,
//   `start_failed`);
// - Chrome's facts in `status`: the state (off, starting, ready, failed closed) with an agent's text and an
//   operator's text, `chrome_kind`, `chrome_version`, `chrome_pid`, `update` and `last_stop`;
// - the owner parts of section 13.2, which run only while the owner rule says that the service owns: at its start the
//   adoption from the unit record (or a start of a wanted Chrome at the first `config`: build note 8), the boot sweep of
//   orphans (never on a record that cannot be read), then the 5 s supervisor (it reads the owner state at each tick),
//   the 1 s fail-closed watch (watch.ts) and the Chrome updater (updates.ts).
//
// When the owner rule says no, the part stops its loops at once and `lost` resolves: the service closes its doors and
// exits. Chrome and Xvfb stay (they run detached) for the next owner.

import { ERR, type Answer, type By, type Req } from "../control.ts";
import type { EndpointState } from "../agent-door.ts";
import type { ServicePart } from "../part.ts";
import type { ChromeTools } from "./google-chrome.ts";
import type { Owner } from "./owner.ts";
import type { UnitPaths } from "./paths.ts";
import type { Procs } from "./procs.ts";
import { ChromeUnit, configFrom, KIND_GOOGLE, NotOwnerError, SUPERVISE_MS, type UnitDeps, type UnitEvent } from "./unit.ts";
import { ChromeMover, ChromeUpdater, CHECK_EVERY_MS, FIRST_CHECK_MS, type Activity } from "./updates.ts";
import { FailClosedWatch, monotonicMs, NO_LINK, type LinkPort, type WatchStop } from "./watch.ts";

export const WATCH_MS = 1000;
/** The ops of stage 1b part 1 (C12, "The ops of stage 1b part 1"). */
export const STAGE_1B1_OPS = ["start", "stop"] as const;

/** The texts of each state (I2: no agent's text names a stop or a start; the gateway gives the operator's text to a password login only). */
export const STATE_TEXTS = {
  off: { agent_text: "The agent browser is not running.", operator_text: "The agent browser is not running. A start on the Browser page starts it." },
  starting: { agent_text: "The agent browser is getting ready; try again in a few seconds.", operator_text: "The agent browser is starting." },
  ready: { agent_text: "The agent browser is ready.", operator_text: "The agent browser is ready." },
  "failed closed": {
    agent_text: "The agent browser is not running: its extension did not answer in time, so it closed for safety.",
    operator_text: "The agent browser stopped itself: its extension did not confirm the site lists in 60 s (no allowlist block without it). A start on the Browser page starts it again.",
  },
} as const;
export type State = keyof typeof STATE_TEXTS;
/** The answer of an owner part that the owner rule refused. */
export const NOT_OWNER = "the agent-browser service does not own the agent browser now";
const FAIL_CLOSED = new Set(["receiver_missing", "sessions_unread"]);

export type UnitPartOptions = {
  paths: UnitPaths;
  procs: Procs;
  tools: ChromeTools;
  owner: Owner;
  log: (line: string) => void;
  /** The agent door's peer check state (the `ready` event's `endpoint`). */
  endpoint: () => EndpointState;
  /** A complete set_sessions came. */
  sessionsComplete: () => boolean;
  /** The native link (part 2); stage 1b part 1 has none. */
  link?: LinkPort;
  activity?: Partial<Activity>;
  /** The unit's displays and programs (tests: also its processes, clock and spawn). */
  unit: Partial<UnitDeps> & Pick<UnitDeps, "displayFs" | "which">;
  clock?: () => number;
  wall?: () => number;
  superviseMs?: number;
  watchMs?: number;
  watchLimitMs?: number;
  firstCheckMs?: number;
  checkEveryMs?: number;
};

export class UnitPart implements ServicePart {
  readonly ops: Readonly<Record<string, (req: Req) => Promise<Answer>>>;
  readonly unit: ChromeUnit;
  readonly watch: FailClosedWatch;
  readonly updater: ChromeUpdater;
  readonly mover: ChromeMover;
  private readonly o: UnitPartOptions;
  private readonly clock: () => number;
  private readonly wall: () => number;
  private emitFn: (ev: Record<string, unknown>) => void = () => {};
  private lastStop: { reason: string; at: string; by: By | null } | null = null;
  /** The record said `wanted` and no Chrome could be adopted: it starts at the first `config` (build note 8). */
  private pendingStart = false;
  private lastChrome = "";
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private wakers = new Set<() => void>();
  private closed = false;
  private loops: Promise<void>[] = [];

  constructor(o: UnitPartOptions) {
    this.o = o;
    this.clock = o.clock ?? monotonicMs;
    this.wall = o.wall ?? Date.now;
    const mayAct = (what: string) => o.owner.check(what);
    this.updater = new ChromeUpdater({ tools: o.tools, file: o.paths.updateFile, wanted: () => !!this.unit.config?.enabled && !this.unit.config.chromeBin, log: o.log });
    this.unit = new ChromeUnit({
      paths: o.paths, procs: o.procs, tools: o.tools, log: o.log, clock: this.clock, wall: this.wall,
      refused: () => this.updater.refused(), mayAct, nap: (ms) => this.nap(ms), ...o.unit,
    });
    const link = o.link ?? NO_LINK;
    this.watch = new FailClosedWatch({
      file: o.paths.watchFile, bootId: () => o.procs.bootId(), clock: this.clock, link, log: o.log, limitMs: o.watchLimitMs,
      sessionsComplete: o.sessionsComplete, chrome: () => this.unit.chromeId(), stop: (reason) => this.failClosed(reason),
    });
    const a = o.activity ?? {};
    this.mover = new ChromeMover({
      unit: this.unit, updater: this.updater, clock: this.clock, wall: this.wall, mayAct, log: o.log, onChange: () => this.chromeChanged(), onStarted: () => this.ready(),
      activity: { inFlight: a.inFlight ?? (() => 0), idleFor: a.idleFor ?? (() => Infinity), importing: a.importing ?? (() => false), clients: a.clients ?? (() => false), sinceSend: a.sinceSend ?? (() => Infinity) },
    });
    this.ops = { start: (req) => this.startBrowser(req.by), stop: (req) => this.stopBrowser(req.by) };
  }

  attach(emit: (ev: Record<string, unknown>) => void): void { this.emitFn = emit; }
  private emit(ev: Record<string, unknown>): void { if (!this.closed) this.emitFn(ev); }

  // ------------------------------------------------------------------ the status and the events

  state(): State {
    if (this.unit.running()) return "ready";
    if (this.unit.starting || this.pendingStart || (this.unit.wanted && this.unit.config?.enabled !== false)) return "starting";
    if (this.lastStop && FAIL_CLOSED.has(this.lastStop.reason)) return "failed closed";
    return "off";
  }

  status(): Record<string, unknown> {
    const state = this.state();
    const f = this.unit.chromeFacts();
    return {
      state, ...STATE_TEXTS[state],
      chrome_kind: f?.kind ?? null, chrome_version: f?.version || null, chrome_pid: f ? this.unit.chromePid() : null,
      extension_version: null, update: this.mover.updateState(),
      last_stop: this.lastStop ? { ...this.lastStop, by: this.lastStop.by ? { ...this.lastStop.by } : null } : null,
    };
  }

  private ready(): void {
    const f = this.unit.chromeFacts();
    if (!f) return;
    this.emit({ t: "ev", ev: "ready", chrome_pid: this.unit.chromePid(), chrome_version: f.version || null, extension_version: null, endpoint: this.o.endpoint() });
    this.chromeChanged();
  }

  /** One `chrome` event when the running Chrome's version or update state changed. */
  private chromeChanged(): void {
    const f = this.unit.chromeFacts();
    if (!f) { this.lastChrome = ""; return; }
    const ev = { t: "ev", ev: "chrome", version: f.version || null, update: this.mover.updateState() };
    const key = JSON.stringify(ev);
    if (key === this.lastChrome) return;
    this.lastChrome = key;
    this.emit(ev);
  }

  private stopped(reason: string, by: By | null): void {
    this.lastStop = { reason, at: new Date(this.wall()).toISOString().replace(/\.\d{3}Z$/, "Z"), by };
    this.lastChrome = "";
    this.emit(by ? { t: "ev", ev: "stopped", reason, by: { ...by } } : { t: "ev", ev: "stopped", reason });
  }

  private onUnitEvent = (e: UnitEvent) => {
    if (e.kind === "ready") this.ready();
    else this.stopped("start_failed", null);
  };

  // ------------------------------------------------------------------ the ops

  /**
   * Start Chrome and Xvfb (the op `start`; the later use rule of board ab-v16.94.11 calls it too). `by` is the caller's
   * provenance, or null for the service's own start. The answer of C12: `{}` when they run, else the error text.
   */
  async startBrowser(_by: By | null): Promise<Answer> {
    if (!(await this.o.owner.check("a start"))) return { error: NOT_OWNER };
    const wasRunning = this.unit.running();
    try {
      this.pendingStart = false;
      await this.unit.start();
      if (!wasRunning && this.unit.running()) this.ready();
      return { data: {} };
    } catch (e) {
      if (e instanceof NotOwnerError) return { error: NOT_OWNER };
      return { error: (e as Error).message || ERR.bad };
    }
  }

  /**
   * Stop Chrome and Xvfb (the op `stop`; the later use rule of board ab-v16.94.11 calls it too). A requested stop is a
   * stop, not a crash: the record says `wanted: false`, so neither the supervisor nor the fail-closed watch starts or
   * counts a Chrome after it. `by` is the caller's provenance (the `stopped` event's `by`), or null.
   */
  async stopBrowser(by: By | null): Promise<Answer> {
    if (!(await this.o.owner.check("a stop"))) return { error: NOT_OWNER };
    this.pendingStart = false;
    const ran = await this.unit.stop();
    if (ran) this.stopped("stop", by ? { ...by } : null);
    return { data: {} };
  }

  /** The watch's stop: the owner rule first; a Chrome on probation takes the way back instead. */
  private async failClosed(reason: WatchStop): Promise<boolean> {
    if (!(await this.o.owner.check("the watch's stop"))) return false;
    const p = reason === "receiver_missing" ? this.mover.probationFor() : null;
    if (p) { this.mover.revert(p, "no receiver confirmed the lists in 60 s"); return true; }
    await this.unit.stop();
    this.stopped(reason, null);
    return true;
  }

  // ------------------------------------------------------------------ config and sessions

  onConfig(keys: Record<string, unknown>): void {
    const cfg = configFrom(keys);
    this.unit.config = cfg;
    if (!cfg.enabled) {
      // browser.enabled false stops the browser (no event: turning it off is not a fault).
      this.pendingStart = false;
      if (this.unit.chromePid() !== null || this.unit.wanted) void this.ownerPart("the stop of a browser that is turned off", async () => { await this.unit.stop(); });
      return;
    }
    if (this.pendingStart) {
      this.pendingStart = false;
      void this.ownerPart("the start of a wanted Chrome", async () => {
        try { await this.unit.start(); if (this.unit.running()) this.ready(); }
        catch (e) { if (e instanceof NotOwnerError) throw e; this.o.log(`unit: the start of the wanted Chrome failed: ${(e as Error).message.slice(0, 300)}`); }
      });
    }
  }

  // ------------------------------------------------------------------ the owner parts and their loops

  private async ownerPart(what: string, f: () => Promise<void>): Promise<void> {
    if (this.closed || !(await this.o.owner.check(what))) return;
    try { await f(); } catch (e) { if (!(e instanceof NotOwnerError)) this.o.log(`unit: ${what} failed: ${(e as Error).name}`); }
  }

  /** A sleep that `stop` ends at once. */
  private nap(ms: number): Promise<void> {
    return new Promise((r) => {
      if (this.closed) return r();
      const done = () => { clearTimeout(t); this.timers.delete(t); this.wakers.delete(done); r(); };
      const t = setTimeout(done, ms);
      this.timers.add(t); this.wakers.add(done);
    });
  }

  private loop(ms: number, first: number, body: () => Promise<void>): void {
    this.loops.push((async () => {
      await this.nap(first);
      while (!this.closed) {
        try { await body(); } catch (e) { if (e instanceof NotOwnerError) break; this.o.log(`unit: a check failed: ${(e as Error).name}`); }
        await this.nap(ms);
      }
    })());
  }

  /**
   * The start of the part (the owner rule said yes): the adoption, the boot sweep (never on a record that cannot be
   * read), then the supervisor, the watch and the updater.
   */
  async begin(): Promise<void> {
    const a = this.unit.adopt();
    if (a.unreadable === null) await this.unit.stopOrphans();
    if (a.adopted) this.ready();
    else if (a.wanted) { this.pendingStart = true; this.o.log("unit: the unit record wants the agent browser; it starts at the daemon's config"); }
    const superviseMs = this.o.superviseMs ?? SUPERVISE_MS;
    this.loop(superviseMs, superviseMs, async () => {
      if (!(await this.o.owner.check("the supervisor's check"))) throw new NotOwnerError("not the owner");
      await this.unit.superviseOnce(this.onUnitEvent);
    });
    const watchMs = this.o.watchMs ?? 1000;
    this.loop(watchMs, 0, async () => {
      await this.watch.tick();
      const link = this.o.link ?? NO_LINK;
      this.mover.tick(this.unit.running() && link.ready() && link.confirmed());
      this.chromeChanged();
    });
    this.loop(this.o.checkEveryMs ?? CHECK_EVERY_MS, this.o.firstCheckMs ?? FIRST_CHECK_MS, async () => {
      if (await this.o.owner.check("the Chrome update check")) await this.updater.checkOnce();
      this.chromeChanged();
    });
  }

  /** Stop the loops (never Chrome: it runs detached for the next owner). */
  async stop(): Promise<void> {
    this.closed = true;
    this.unit.halt();
    for (const w of [...this.wakers]) w();
    await Promise.allSettled(this.loops);
  }
}

export { KIND_GOOGLE };
