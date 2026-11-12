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
//   adoption from the unit record (or a start of a wanted Chrome at the first `config`: build note 8; a `config` that
//   came before applies at once), the boot sweep of orphans (never on a record that cannot be read), then the 5 s
//   supervisor (it reads the owner state at each tick),
//   the 1 s fail-closed watch (watch.ts) and the Chrome updater (updates.ts).
//
// When the owner rule says no, the part stops its loops at once and `lost` resolves: the service closes its doors and
// exits. Chrome and Xvfb stay (they run detached) for the next owner.
//
// The start and the stop by use (board ab-v16.94.11; the operator's answer Q5 on board item ab-1n8; the design, section
// 19): the service's doors run at all times, and Chrome and Xvfb run only while agents use them.
//
// - The use signal (`use`, which the service builds): an open client connection of the agent door, a bridge request that
//   runs, a send (an import) that runs, an MCP session, and each request that waits for the browser (`wake`). `quietFor`
//   gives the time since the last request or send, so a use between two checks counts too.
// - The start at a use (`wake`): a request that needs the browser while Chrome does not run starts Chrome and Xvfb (one
//   start for all the requests that wait), waits until its caller's check says ready, at most USE_WAIT_MS, then goes on.
//   The state is `starting` from its first moment, and the start sends `ready` with Chrome's pid. A start that fails
//   gives the waiting requests its error text and sends `stopped` with the reason `start_failed` once until a start works;
//   the requests of the next USE_RETRY_MS get the same error at once, with no new start.
// - The stop by use (each second, with the watch): when Chrome runs and nothing used it for the grace time (`config`'s
//   `idle_stop_minutes`, a whole number from 1 to 1440, default 10; `status` gives it), the service stops Chrome and Xvfb
//   (the owner rule first) and sends `stopped` with the reason `idle`. The profile stays on disk. It is no crash: the
//   record says `wanted: false`, so the supervisor starts nothing and the fail-closed watch counts no Chrome. A request
//   that comes during the stop waits for its end, then starts Chrome again. A newer Google Chrome that waits (`update`
//   `pending`) moves at this stop: the next start runs it.

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
  off: { agent_text: "The agent browser is not running; it gets ready when an agent uses it.", operator_text: "The agent browser is not running. It starts at the next use by an agent." },
  starting: { agent_text: "The agent browser is getting ready; try again in a few seconds.", operator_text: "The agent browser is starting." },
  ready: { agent_text: "The agent browser is ready.", operator_text: "The agent browser is ready." },
  "failed closed": {
    agent_text: "The agent browser is not running: its extension did not answer in time, so it closed for safety.",
    operator_text: "The agent browser stopped itself: its extension did not confirm the site lists in 60 s (no allowlist block without it). The next use by an agent starts it again.",
  },
} as const;
export type State = keyof typeof STATE_TEXTS;
/** The answer of an owner part that the owner rule refused. */
export const NOT_OWNER = "the agent-browser service does not own the agent browser now";
const FAIL_CLOSED = new Set(["receiver_missing", "sessions_unread"]);

/** The grace time of the stop by use (board ab-v16.94.11): `config`'s `idle_stop_minutes`, else this many minutes. */
export const IDLE_STOP_DEFAULT_MINUTES = 10;
export const IDLE_STOP_MAX_MINUTES = 1440;
/** How long a request that needs the browser waits for it at a use (the start, then its caller's check). */
export const USE_WAIT_MS = 60_000;
/** After a start at a use failed, the requests of this time get its error at once, with no new start. */
export const USE_RETRY_MS = 10_000;
const USE_POLL_MS = 100;
/** The text of a request whose start at a use failed: the start's error text is the reason (I2: it names no command). */
export const useFailed = (reason: string) => `The agent browser could not get ready: ${reason.replace(/[.\s]+$/, "")}.`;

/** `config`'s `idle_stop_minutes`: a whole number from 1 to IDLE_STOP_MAX_MINUTES, else null (the default applies). */
export function idleStopMinutes(v: unknown): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 1 && v <= IDLE_STOP_MAX_MINUTES ? v : null;
}

/** The use of the browser (board ab-v16.94.11), which the service builds from its doors, its link and its MCP path. */
export type UseSignal = {
  /** The sources that use the browser now, by name (`client`, `request`, `send`, `mcp`); empty when none does. */
  now(): string[];
  /** ms since the last request or send was read or answered (Infinity before one). */
  quietFor(): number;
};

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
  /** The agent extension's version (part 2: the receiver's hello, else the agent package that the start staged), or null. */
  extensionVersion?: () => string | null;
  /** After each `ready` (part 2: the end of the old owner's host, by note 7). */
  onReady?: () => void;
  /** Right before each stop of Chrome (part 2: the X pointer's playing path is killed). */
  beforeStop?: () => void;
  activity?: Partial<Activity>;
  /** The use signal (board ab-v16.94.11); with none, only the requests that wait (`wake`) are a use. */
  use?: UseSignal;
  /** Tests only: the wait of a request at a use, and its poll. */
  useWaitMs?: number;
  usePollMs?: number;
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
  /** The Chrome (pid and start time) of the last `ready`: each Chrome gets one `ready` (C12). */
  private lastReady = "";
  private lastChrome = "";
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private wakers = new Set<() => void>();
  private closed = false;
  private loops: Promise<void>[] = [];
  // The start and the stop by use (board ab-v16.94.11).
  /** The grace time in minutes (`config`'s `idle_stop_minutes`). */
  private idleMinutes = IDLE_STOP_DEFAULT_MINUTES;
  /** The last moment (the monotonic clock) at which something used the browser, or a Chrome started. */
  private lastUse: number;
  /** The requests that wait for the browser now (`wake`). */
  private waiters = 0;
  /** The one start at a use for all the requests that wait; null while none runs. */
  private useStart: Promise<string | null> | null = null;
  /** The last start at a use that failed, and its text, for USE_RETRY_MS; `useFailTold`: its `stopped` event went out. */
  private useFail: { at: number; text: string } | null = null;
  private useFailTold = false;
  /** The stop by use while it runs: a request that comes waits for its end. */
  private idleStop: Promise<void> | null = null;

  constructor(o: UnitPartOptions) {
    this.o = o;
    this.clock = o.clock ?? monotonicMs;
    this.wall = o.wall ?? Date.now;
    this.lastUse = this.clock();
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
    if (this.unit.starting || this.useStart !== null || this.pendingStart || (this.unit.wanted && this.unit.config?.enabled !== false)) return "starting";
    if (this.lastStop && FAIL_CLOSED.has(this.lastStop.reason)) return "failed closed";
    return "off";
  }

  status(): Record<string, unknown> {
    const state = this.state();
    const f = this.unit.chromeFacts();
    return {
      state, ...STATE_TEXTS[state],
      chrome_kind: f?.kind ?? null, chrome_version: f?.version || null, chrome_pid: f ? this.unit.chromePid() : null,
      extension_version: f ? this.extensionVersion() : null, update: this.mover.updateState(),
      last_stop: this.lastStop ? { ...this.lastStop, by: this.lastStop.by ? { ...this.lastStop.by } : null } : null,
      idle_stop_minutes: this.idleMinutes,
    };
  }

  /** The operator's sentence of a start at a use that failed (its error text), while it holds. */
  notes(): { agent: string[]; operator: string[] } {
    const f = this.useFail;
    return { agent: [], operator: f && !this.unit.running() ? [`The last start at an agent's use failed: ${f.text.replace(/[.\s]+$/, "")}.`] : [] };
  }

  private ready(): void {
    // A start that succeeded (or an adoption): no start waits for a config any more (review-106 B1).
    this.pendingStart = false;
    // Each start counts as a use: the grace time of the stop by use counts from it (board ab-v16.94.11).
    this.lastUse = this.clock();
    if (this.unit.running()) { this.useFail = null; this.useFailTold = false; }
    const f = this.unit.chromeFacts();
    const id = this.unit.chromeId();
    if (!f || !id) return;
    // One `ready` for each Chrome: a start op that meets the supervisor's restart sends none of its own.
    const key = `${id.pid}:${id.start}`;
    if (key === this.lastReady) return;
    this.lastReady = key;
    this.emit({ t: "ev", ev: "ready", chrome_pid: this.unit.chromePid(), chrome_version: f.version || null, extension_version: this.extensionVersion(), endpoint: this.o.endpoint() });
    this.chromeChanged();
    try { this.o.onReady?.(); } catch (e) { this.o.log(`unit: the step after ready failed (${(e as Error).name})`); }
  }

  private extensionVersion(): string | null {
    try { return this.o.extensionVersion?.() ?? null; } catch { return null; }
  }

  private beforeStop(): void { try { this.o.beforeStop?.(); } catch {} }

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
   * Start Chrome and Xvfb (the op `start`, and the start at a use of board ab-v16.94.11). `by` is the caller's
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
   * Stop Chrome and Xvfb (the op `stop`). A requested stop is a stop, not a crash: the record says `wanted: false`, so
   * neither the supervisor nor the fail-closed watch starts or counts a Chrome after it. `by` is the caller's provenance
   * (the `stopped` event's `by`), or null. A later use starts Chrome again (board ab-v16.94.11).
   */
  async stopBrowser(by: By | null): Promise<Answer> {
    if (!(await this.o.owner.check("a stop"))) return { error: NOT_OWNER };
    this.pendingStart = false;
    this.beforeStop();
    const ran = await this.unit.stop();
    if (ran) this.stopped("stop", by ? { ...by } : null);
    return { data: {} };
  }

  /** The watch's stop: the owner rule first; a Chrome on probation takes the way back instead. */
  private async failClosed(reason: WatchStop): Promise<boolean> {
    if (!(await this.o.owner.check("the watch's stop"))) return false;
    // After a fail-closed stop only a `start` starts Chrome again: no later `config` does (review-106 B1).
    this.pendingStart = false;
    const p = reason === "receiver_missing" ? this.mover.probationFor() : null;
    if (p) { this.mover.revert(p, "no receiver confirmed the lists in 60 s"); return true; }
    this.beforeStop();
    await this.unit.stop();
    this.stopped(reason, null);
    return true;
  }

  // ------------------------------------------------------------------ the start and the stop by use (board ab-v16.94.11)

  /** The names of the sources that use the browser now: the service's signal, and `waiting` for the requests that wait. */
  usedBy(): string[] {
    let now: string[] = [];
    try { now = this.o.use?.now() ?? []; } catch { now = []; }
    return this.waiters > 0 ? [...now, "waiting"] : now;
  }

  /** How long nothing has used the browser (ms): 0 while something does. */
  unusedFor(): number {
    const now = this.clock();
    if (this.usedBy().length) { this.lastUse = now; return 0; }
    let quiet = Infinity;
    try { quiet = this.o.use?.quietFor() ?? Infinity; } catch {}
    if (Number.isFinite(quiet)) this.lastUse = Math.max(this.lastUse, now - Math.max(0, quiet));
    return Math.max(0, now - this.lastUse);
  }

  /** The grace time of the stop by use, in ms. */
  get idleStopMs(): number { return this.idleMinutes * 60_000; }

  /** True while the stop by use runs: a new connection waits for its end (the agent door and the MCP path ask). */
  get idleStopping(): boolean { return this.idleStop !== null; }

  /**
   * A request that needs the browser (an upgrade of the agent door, a request of the MCP path, a send): it is a use while
   * it waits. With no config yet, or with `enabled: false`, it starts nothing and goes on at once. Else, when a stop by use
   * runs, it waits for its end; when Chrome does not run, it starts Chrome and Xvfb (the one start of all the requests that
   * wait); then it waits until `ready` says yes, Chrome stops, or USE_WAIT_MS has passed. The answer: null (the caller's
   * checks run again), or the text of a start that failed (`useFailed`), which the caller gives its client.
   */
  async wake(ready: () => boolean): Promise<string | null> {
    const cfg = this.unit.config;
    if (this.closed || !cfg || !cfg.enabled) return null;
    this.waiters++;
    this.lastUse = this.clock();
    const end = this.clock() + (this.o.useWaitMs ?? USE_WAIT_MS);
    const isReady = () => { try { return ready(); } catch { return false; } };
    try {
      if (this.idleStop) await this.idleStop;
      if (!this.unit.running() && !isReady()) {
        const failed = await this.startAtUse();
        if (failed !== null) return failed;
      }
      while (!this.closed && !isReady() && this.unit.running() && this.clock() < end) {
        await new Promise((r) => setTimeout(r, this.o.usePollMs ?? USE_POLL_MS));
      }
      return null;
    } finally {
      this.waiters--;
      this.lastUse = this.clock();
    }
  }

  /** The one start at a use: null when Chrome runs, else the text for the waiting requests. */
  private startAtUse(): Promise<string | null> {
    if (this.useStart) return this.useStart;
    const f = this.useFail;
    if (f && this.clock() - f.at < USE_RETRY_MS) return Promise.resolve(useFailed(f.text));
    const p = (async (): Promise<string | null> => {
      this.o.log("unit: an agent uses the agent browser; starting Chrome");
      const a = await this.startBrowser(null);
      if (!("error" in a)) return null;
      if (a.error === NOT_OWNER) return useFailed(a.error);
      this.useFail = { at: this.clock(), text: a.error };
      this.o.log(`unit: the start at an agent's use failed: ${a.error.slice(0, 300)}`);
      // One `stopped` event for a run of failed starts at a use, as the supervisor's report (C12: start_failed).
      if (!this.useFailTold) { this.useFailTold = true; this.stopped("start_failed", null); }
      return useFailed(a.error);
    })();
    this.useStart = p;
    void p.finally(() => { if (this.useStart === p) this.useStart = null; });
    return p;
  }

  /**
   * The stop by use, at each check of the watch: Chrome runs, no start, stop or move runs, and nothing used the browser for
   * the grace time. The owner rule first; then the same checks again, and the stop: Chrome and Xvfb end, the profile stays,
   * the record says `wanted: false`, and `stopped` goes out with the reason `idle`.
   */
  private async idleCheck(): Promise<void> {
    const idle = () => {
      if (this.closed || !this.unit.running()) return false;
      // Read first, so the time of the last use stays fresh at each check.
      const unused = this.unusedFor();
      return this.idleStop === null && this.useStart === null && this.unit.config?.enabled === true && !this.unit.starting
        && !this.unit.locked && !this.mover.working && unused >= this.idleStopMs;
    };
    if (!idle()) return;
    if (!(await this.o.owner.check("the stop of an unused browser"))) return;
    if (!idle()) return; // a use came during the owner check
    const pending = this.mover.updateState() === "pending" ? this.updater.readyVersion() : null;
    const run = (async () => {
      this.o.log(`unit: no agent used the agent browser for ${this.idleMinutes} min; stopping Chrome and Xvfb (the profile stays)`);
      this.pendingStart = false;
      this.beforeStop();
      const ran = await this.unit.stop();
      if (ran) this.stopped("idle", null);
      if (ran && pending) this.o.log(`update: the agent browser stopped with no use; its next start runs Google Chrome ${pending}`);
    })();
    const p = run.catch((e) => { this.o.log(`unit: the stop of an unused browser failed: ${(e as Error).name}`); });
    this.idleStop = p;
    try { await p; } finally { if (this.idleStop === p) this.idleStop = null; }
  }

  // ------------------------------------------------------------------ config and sessions

  onConfig(keys: Record<string, unknown>): void {
    const cfg = configFrom(keys);
    this.unit.config = cfg;
    // The grace time of the stop by use (board ab-v16.94.11): agentwatch's browser.idle_stop_minutes, as data.
    const minutes = idleStopMinutes(keys.idle_stop_minutes);
    if (minutes === null && keys.idle_stop_minutes != null) this.o.log(`unit: config's idle_stop_minutes is not a whole number from 1 to ${IDLE_STOP_MAX_MINUTES}; the grace time stays ${IDLE_STOP_DEFAULT_MINUTES} min`);
    this.idleMinutes = minutes ?? IDLE_STOP_DEFAULT_MINUTES;
    if (!cfg.enabled) {
      // browser.enabled false stops the browser (no event: turning it off is not a fault).
      this.pendingStart = false;
      if (this.unit.chromePid() !== null || this.unit.wanted) void this.turnOff();
      return;
    }
    if (this.pendingStart) {
      this.pendingStart = false;
      void this.startWanted();
    }
  }

  /** browser.enabled false: stop Chrome and Xvfb; the record says `wanted: false` (an owner part; no event). */
  private turnOff(): Promise<void> {
    return this.ownerPart("the stop of a browser that is turned off", async () => { this.beforeStop(); await this.unit.stop(); });
  }

  /** The start of a wanted Chrome with no `start` op (build note 8): at the first `config`, or in begin when that came first. */
  private startWanted(): Promise<void> {
    // A stop that comes during the owner check wins: the start reads the stop count before the check (review-106b F1).
    const stops = this.unit.stopCount;
    return this.ownerPart("the start of a wanted Chrome", async () => {
      if (this.unit.stopCount !== stops || !this.unit.wanted) return;
      try { await this.unit.start(); if (this.unit.running()) this.ready(); }
      catch (e) { if (e instanceof NotOwnerError) throw e; this.o.log(`unit: the start of the wanted Chrome failed: ${(e as Error).message.slice(0, 300)}`); }
    });
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
    // The grace time of an adopted Chrome counts from the service's start (board ab-v16.94.11).
    this.lastUse = this.clock();
    const a = this.unit.adopt();
    const stops = this.unit.stopCount;
    if (a.unreadable === null) await this.unit.stopOrphans();
    // A `config` can come before this point (the control door opens first: build note 8). It applies now, before the
    // loops start (review-106 B1): `enabled: false` stops what the record wanted, and a wanted Chrome that is gone
    // starts at once. With no `config` yet, a wanted Chrome starts at the first one.
    // A stop during the sweep wins (review-106b F1): it counts at once and clears the wish when it gets the lock.
    const cfg = this.unit.config;
    const wanted = this.unit.wanted && this.unit.stopCount === stops;
    if (cfg && !cfg.enabled) { if (a.adopted || wanted) await this.turnOff(); }
    else if (a.adopted) this.ready();
    else if (wanted && cfg) await this.startWanted();
    else if (wanted) { this.pendingStart = true; this.o.log("unit: the unit record wants the agent browser; it starts at the daemon's config"); }
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
      await this.idleCheck();
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
