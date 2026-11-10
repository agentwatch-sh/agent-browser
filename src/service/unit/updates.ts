// Google Chrome follows Google's stable channel (the self-contained design, sections 5.1 and 5.6; board ab-v16.94.3; a
// port of agentwatch's daemon/browser/updates.py and of the move in daemon/browser/service.py).
//
// The updater checks Google's signed index 10 minutes after the service's start and then every 12 hours, and installs a
// newer Google Chrome stable beside the copies in the tools folder. A check runs only while browser.enabled is true,
// chrome_bin is empty, the box can run the copy and at least one copy is installed: a box that never ran the agent
// browser never reads the index.
//
// The move: a running older Google Chrome moves to the ready copy when `shouldMove` says so: no bridge request in
// flight, the bridge idle for an hour (UPDATE_IDLE_MS), no import running, no send in the last hour, and no client
// connected to the endpoint, until the update has waited 24 hours (FORCE_AFTER_MS): then only the clients rule goes, and
// the idle hour stays. A move restarts Chrome. Its new copy is on probation: when its receiver does not confirm the lists
// within 60 s, the move failed: the version is noted (chrome-update.json) and never started again, and the last good copy
// starts again. A confirm on the new Chrome makes it the last good copy, and the other copies are pruned. The state file
// also keeps since when an update waits, so the 24 h limit outlives a restart of the service.

import { readFileSync } from "node:fs";
import type { ChromeTools } from "./google-chrome.ts";
import { writeJsonDurable } from "./record.ts";
import { ConfigError, KIND_GOOGLE, NotOwnerError, StartError, type ChromeUnit } from "./unit.ts";
import { newer, versionKey, compareKeys } from "./versions.ts";
import { RECEIVER_MISSING_MS } from "./watch.ts";

export const FIRST_CHECK_MS = 600_000;
export const CHECK_EVERY_MS = 43_200_000;
/** While an update waits, a move needs the bridge idle (no request read or answered) this long. */
export const UPDATE_IDLE_MS = 3_600_000;
/** No move this soon after a sign-in send ended. */
export const SEND_QUIET_MS = 3_600_000;
/** After an update waited this long, a connected client no longer holds the move back; every other rule stays. */
export const FORCE_AFTER_MS = 86_400_000;
const FAILED_KEPT = 16;

/**
 * True when the unit may move from the Google Chrome `running` to `newest` now: `running` older than `newest`, no
 * bridge request in flight, the bridge idle for UPDATE_IDLE_MS, no import, the last send at least SEND_QUIET_MS ago, and
 * no client on the endpoint, until the update waited FORCE_AFTER_MS (then a connected client no longer counts).
 */
export function shouldMove(running: string | null, newest: string | null, o: { inFlight: number; idleFor: number; importing: boolean; clients: boolean; sinceSend?: number; waitingFor?: number }): boolean {
  if (!(newer(newest, running) && o.inFlight === 0 && o.idleFor >= UPDATE_IDLE_MS && !o.importing && (o.sinceSend ?? Infinity) >= SEND_QUIET_MS)) return false;
  return !o.clients || (o.waitingFor ?? 0) >= FORCE_AFTER_MS;
}

/** A move that shouldMove allows only because the update waited FORCE_AFTER_MS while a client held a connection. */
export const forcedMove = (o: { clients: boolean; waitingFor: number }) => o.clients && o.waitingFor >= FORCE_AFTER_MS;

type State = { last_good: string; failed: { version: string; reason: string }[]; update_since: number | null };

/**
 * The timed check of Google's stable channel, and the update's state across restarts (chrome-update.json): the last good
 * copy, the versions whose start failed (each with its reason), and since when (wall clock, seconds) an update waits. A
 * file that cannot be read is no state: nothing is refused, and nothing is written into it until it reads again.
 */
export class ChromeUpdater {
  private readonly tools: ChromeTools;
  private readonly file: string;
  private readonly wanted: () => boolean;
  private readonly log: (line: string) => void;
  private state: State | null = null;
  private broken = "";
  private ready: string | null = null;
  private mark = 0;
  private err = "";

  constructor(o: { tools: ChromeTools; file: string; wanted: () => boolean; log: (line: string) => void }) {
    this.tools = o.tools; this.file = o.file; this.wanted = o.wanted; this.log = o.log;
  }

  readyVersion(): string | null { return this.ready; }
  readyMark(): number { return this.mark; }
  error(): string { return this.err; }
  stateProblem(): string { this.load(); return this.broken; }

  private static clean(d: Record<string, unknown>): State {
    const failed = Array.isArray(d.failed) ? d.failed.filter((x): x is { version: string; reason?: unknown } => !!x && typeof x === "object" && typeof (x as any).version === "string" && versionKey((x as any).version) !== null)
      .map((x) => ({ version: x.version, reason: String(x.reason ?? "").slice(0, 300) })) : [];
    const lg = d.last_good;
    const since = d.update_since;
    return {
      last_good: typeof lg === "string" && versionKey(lg) ? lg : "",
      failed: failed.slice(-FAILED_KEPT),
      update_since: typeof since === "number" && Number.isFinite(since) ? since : null,
    };
  }

  private load(): State {
    if (this.state && !this.broken) return this.state;
    let data: unknown = {};
    try { data = JSON.parse(readFileSync(this.file, "utf8")); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        if (!this.broken) this.log(`update: the Chrome update state file cannot be read (${(e as Error).name}); no Chrome version is refused and nothing is written into it until it reads again`);
        this.broken = `the Chrome update state file ${this.file} cannot be read (${(e as Error).name})`;
        this.state ??= ChromeUpdater.clean({});
        return this.state;
      }
    }
    if (this.broken) this.log("update: the Chrome update state file reads again");
    this.broken = "";
    this.state = ChromeUpdater.clean(data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {});
    return this.state;
  }

  private save(): void {
    const s = this.load();
    if (this.broken) return; // never over a damaged file
    try { writeJsonDurable(this.file, s); } catch (e) { this.log(`update: could not write the Chrome update state: ${(e as Error).name}`); }
  }

  lastGood(): string | null { return this.load().last_good || null; }
  refused(): ReadonlySet<string> { return new Set(this.load().failed.map((f) => f.version)); }
  private newestFailure(): { version: string; reason: string } | null {
    const f = this.load().failed;
    return f.length ? f.reduce((a, b) => (compareKeys(versionKey(b.version)!, versionKey(a.version)!) > 0 ? b : a)) : null;
  }
  /** The newest failed version with its own reason; "" when none failed. */
  failedText(): string { const f = this.newestFailure(); return f ? `Google Chrome ${f.version} did not start: ${f.reason}` : ""; }

  /** The receiver of `version` confirmed the lists: it is the last good copy; one newer than every failed one ends them. */
  noteGood(version: string): void {
    const s = this.load();
    if (versionKey(version) === null || this.broken) return;
    let changed = s.last_good !== version;
    s.last_good = version;
    const f = this.newestFailure();
    if (f && newer(version, f.version)) { s.failed = []; changed = true; }
    if (changed) this.save();
  }

  /** The start of `version` failed: it is never started again, and a check installs only a newer release. */
  noteFailed(version: string, reason: string): void {
    const s = this.load();
    if (this.ready === version) this.ready = null;
    if (this.broken) return;
    s.failed = [...s.failed.filter((x) => x.version !== version), { version, reason: reason.slice(0, 300) }].slice(-FAILED_KEPT);
    this.save();
  }

  waitSince(): number | null { return this.load().update_since; }
  noteWait(since: number | null): void { const s = this.load(); if (!this.broken && s.update_since !== since) { s.update_since = since; this.save(); } }

  /** One check; the version that it newly installed, else null. Nothing runs while the browser is off or chrome_bin is set. */
  async checkOnce(): Promise<string | null> {
    if (!this.wanted()) { this.err = ""; return null; }
    const failure = this.newestFailure();
    const refused = this.refused(), keep = this.lastGood();
    const tools = this.tools;
    try {
      if (tools.unsupported() || !tools.newest()) { this.err = ""; return null; } // a box that never ran the agent browser never checks
      const before = tools.newest(refused);
      const entry = await tools.latestEntry();
      if (failure === null || newer(entry.version, failure.version)) await tools.ensure(entry); // no downgrade
      const newest = tools.newest(refused); // always the newest copy, never the install's return
      if (!newest) throw new Error("every Google Chrome copy in the tools folder failed to start; no newer release is out yet");
      await tools.prune(new Set([before?.version ?? "", newest.version, keep ?? ""].filter(Boolean)));
      this.err = "";
      this.ready = newest.version;
      this.mark++;
      if (newest.version === (before?.version ?? "")) return null;
      this.log(`update: Google Chrome ${newest.version} is installed beside ${before?.version || "the copies that failed"}; the agent browser moves to it when no agent uses it`);
      return newest.version;
    } catch (e) {
      this.err = (e as Error).message || (e as Error).name;
      this.log(`update: the Google Chrome update check failed: ${this.err.slice(0, 300)}; the next check is in ${CHECK_EVERY_MS / 3_600_000} h`);
      return null;
    }
  }

  /** The newest copy that did not fail (the copy that a start runs). */
  newestOnDisk(): string | null { try { return this.tools.newest(this.refused())?.version ?? null; } catch { return null; } }

  /** prune(keep) of the tools; the last good copy is always kept. Never throws. */
  async prune(keep: ReadonlySet<string>): Promise<string[]> {
    const lg = this.lastGood();
    try { return await this.tools.prune(new Set([...keep, ...(lg ? [lg] : [])])); } catch { return []; }
  }
}

/** What a move needs to know of the agents' use of the browser (part 2 and stage 1c give the bridge's and the sends' facts). */
export type Activity = {
  /** Bridge requests in flight. */
  inFlight(): number;
  /** ms since the bridge last read or answered a request. */
  idleFor(): number;
  /** An import (a sign-in send) runs. */
  importing(): boolean;
  /** A client holds a connection to the endpoint. */
  clients(): boolean;
  /** ms since the last send ended. */
  sinceSend(): number;
};

type Probation = { old: string; new: string; deadline: number; stops: number; pid: number | null };

/**
 * The move of a running Google Chrome to the ready copy, and its probation. The fail-closed watch calls `tick` each second
 * with `confirmed` (the receiver of the current Chrome confirmed the lists); a move starts only on a confirmed unit.
 */
export class ChromeMover {
  private readonly unit: ChromeUnit;
  private readonly updater: ChromeUpdater;
  private readonly activity: Activity;
  private readonly clock: () => number;
  private readonly wall: () => number;
  private readonly mayAct: (what: string) => Promise<boolean>;
  private readonly log: (line: string) => void;
  private readonly onChange: () => void;
  private readonly startedAt: number;
  private updateSince: number | null = null;
  private probation: Probation | null = null;
  private moveBlock: number | null = null;
  moving = false;
  private reverting = false;
  lastMoveFailed = false;

  constructor(o: { unit: ChromeUnit; updater: ChromeUpdater; activity: Activity; clock: () => number; wall?: () => number; mayAct: (what: string) => Promise<boolean>; log: (line: string) => void; onChange?: () => void }) {
    this.unit = o.unit; this.updater = o.updater; this.activity = o.activity; this.clock = o.clock; this.wall = o.wall ?? Date.now;
    this.mayAct = o.mayAct; this.log = o.log; this.onChange = o.onChange ?? (() => {});
    this.startedAt = o.clock();
  }

  private runningGoogle(): string | null {
    const f = this.unit.chromeFacts();
    return f && f.kind === KIND_GOOGLE && f.version ? f.version : null;
  }

  /** The update state of C12's status and chrome event: null with no Google Chrome, else current, waiting, moving or failed. */
  updateState(): string | null {
    const running = this.runningGoogle();
    if (running === null) return null;
    if (this.moving || this.reverting || this.probation) return "moving";
    const ready = this.updater.readyVersion();
    if (ready && newer(ready, running)) return "waiting";
    if (this.lastMoveFailed) return "failed";
    return "current";
  }

  /** How long the ready copy has waited (ms), 0 when none waits. */
  waitingFor(): number { return this.updateSince === null ? 0 : this.clock() - this.updateSince; }

  /** Each tick: note when the ready copy first became newer than the running one (in the state file too). */
  private trackWait(): void {
    const ready = this.updater.readyVersion();
    if (ready && newer(ready, this.runningGoogle())) {
      if (this.updateSince === null) {
        let wall = this.wall() / 1000;
        const kept = this.updater.waitSince();
        if (kept !== null && kept <= wall) wall = kept; else this.updater.noteWait(wall);
        this.updateSince = this.clock() - (this.wall() / 1000 - wall) * 1000;
        this.onChange();
      }
      return;
    }
    if (this.updateSince !== null || (ready && this.updater.waitSince())) this.updater.noteWait(null);
    if (this.updateSince !== null) { this.updateSince = null; this.onChange(); }
  }

  /** A Google Chrome newer than the last good copy that no move started gets its own probation. */
  private watchUnproven(): void {
    if (this.probation || this.moving || this.reverting) return;
    const lg = this.updater.lastGood();
    const running = lg ? this.runningGoogle() : null;
    if (!lg || !running || !newer(running, lg)) return;
    this.probation = { old: lg, new: running, deadline: this.clock() + RECEIVER_MISSING_MS, stops: this.unit.stopCount, pid: this.unit.chromePid() };
    this.log(`update: Google Chrome ${running} never had its receiver confirm the lists here; when it does not within ${RECEIVER_MISSING_MS / 1000} s, Google Chrome ${lg} starts again`);
  }

  private checkProbation(): void {
    const p = this.probation;
    if (!p) return;
    if (p.stops !== this.unit.stopCount || !this.unit.config?.enabled) { this.probation = null; return; }
    const running = this.runningGoogle();
    if (running && running !== p.new) { this.probation = null; return; }
    const pid = this.unit.chromePid();
    if (running && pid !== null && pid !== p.pid) p.pid = pid; // the supervisor started it again: the same deadline
    if (this.clock() >= p.deadline) this.revert(p, `no receiver confirmed the lists in ${RECEIVER_MISSING_MS / 1000} s`);
  }

  /** The probation of the running Chrome, if any (the watch's stop takes the way back instead). */
  probationFor(): Probation | null { return this.probation ?? this.unproven(); }
  private unproven(): Probation | null {
    const lg = this.updater.lastGood();
    const running = lg ? this.runningGoogle() : null;
    return lg && running && newer(running, lg) ? { old: lg, new: running, deadline: this.clock() + RECEIVER_MISSING_MS, stops: this.unit.stopCount, pid: this.unit.chromePid() } : null;
  }

  /** `(running, newest, forced)` when the unit may move now. */
  movePlan(o: { inMove?: boolean } = {}): { old: string; new: string; forced: boolean } | null {
    const newest = this.updater.readyVersion();
    if (!newest) return null;
    if (this.moveBlock !== null && this.moveBlock === this.updater.readyMark()) return null;
    if (this.updater.stateProblem() || this.probation || (this.moving && !o.inMove) || this.reverting) return null;
    const cfg = this.unit.config;
    if (!cfg || !cfg.enabled || cfg.chromeBin) return null;
    const running = this.runningGoogle();
    if (!running) return null;
    const now = this.clock();
    // The idle hour and the send-quiet hour count from the service's start too: a new service does not know what came before.
    const sinceStart = now - this.startedAt;
    const clients = this.activity.clients();
    const waitingFor = this.waitingFor();
    const facts = { inFlight: this.activity.inFlight(), idleFor: Math.min(this.activity.idleFor(), sinceStart), importing: this.activity.importing() || this.unit.locked, clients, sinceSend: Math.min(this.activity.sinceSend(), sinceStart), waitingFor };
    if (!shouldMove(running, newest, facts)) return null;
    return { old: running, new: newest, forced: forcedMove({ clients, waitingFor }) };
  }

  private blockMoves(why: string): void {
    this.moveBlock = this.updater.readyMark();
    this.log(`update: no Google Chrome move: ${why}; the next update check decides again`);
  }

  /** One tick of the watch. `confirmed`: the receiver of the current Chrome confirmed the lists. */
  tick(confirmed: boolean): void {
    try { this.trackWait(); this.watchUnproven(); this.checkProbation(); } catch (e) { this.log(`update: the Chrome update check failed: ${(e as Error).name}`); }
    if (!confirmed) return;
    this.noteGoodCopy();
    if (this.moving || this.reverting) return;
    const plan = this.movePlan();
    if (!plan) return;
    this.moving = true;
    this.onChange();
    void this.move(plan.old, plan.new, plan.forced).finally(() => { this.moving = false; this.onChange(); });
  }

  /** A confirm on the running Google Chrome: it is the last good copy; the Chrome of a probation is done (prune). */
  private noteGoodCopy(): void {
    const running = this.runningGoogle();
    const pid = this.unit.chromePid();
    if (!running || pid === null) return;
    const p = this.probation;
    if (p) {
      if (running !== p.new || p.pid !== pid) return;
      this.probation = null;
      this.lastMoveFailed = false;
      this.log(`update: the receiver of Google Chrome ${p.new} confirmed the lists; it is the last good copy`);
      void this.updater.prune(new Set([p.old, p.new]));
      this.onChange();
    }
    this.updater.noteGood(running);
  }

  /** Move from `old` to `new`: stop the unit and start it again (the newest copy that did not fail), then the probation. */
  async move(old: string, next: string, forced: boolean): Promise<void> {
    try {
      const plan = this.movePlan({ inMove: true });
      if (!plan || plan.old !== old || plan.new !== next) return;
      const disk = this.updater.newestOnDisk();
      if (disk !== next) { this.blockMoves(`Google Chrome ${next} is not the newest copy in the tools folder (${disk ?? "none"})`); return; }
      if (!(await this.mayAct("a Chrome move"))) return;
      if (forced) this.log(`update: Google Chrome ${next} waited ${Math.round(this.waitingFor() / 3_600_000)} h for the agents to leave the endpoint; it moves now although an agent holds a connection (the 24 h limit)`);
      const stops = this.unit.stopCount;
      await this.unit.stop();
      if (this.unit.stopCount !== stops + 1 || !this.unit.config?.enabled) { this.log(`update: the agent browser was stopped during its move to Google Chrome ${next}; it stays stopped`); return; }
      try { await this.unit.start(); }
      catch (e) {
        if (e instanceof NotOwnerError) throw e;
        if (e instanceof ConfigError) { this.log(`update: the agent browser could not start after its stop for the move to Google Chrome ${next}: ${(e as Error).message.slice(0, 300)}; it stays stopped`); return; }
        if (e instanceof StartError) { await this.takeWayBack({ old, new: next, deadline: 0, stops: this.unit.stopCount, pid: null }, e.message); return; }
        throw e;
      }
      const started = this.runningGoogle();
      if (started !== next) { this.blockMoves(`the start ran ${started ?? "no Google Chrome"}, not ${next}`); return; }
      this.log(`update: Google Chrome moved from ${old} to ${started}`);
      this.probation = { old, new: next, deadline: this.clock() + RECEIVER_MISSING_MS, stops: this.unit.stopCount, pid: this.unit.chromePid() };
    } catch (e) {
      if (e instanceof NotOwnerError) return;
      this.blockMoves(`the move to Google Chrome ${next} failed (${(e as Error).name})`);
    }
  }

  /** The way back of a failed probation, once. */
  revert(p: Probation, reason: string): void {
    if (this.probation === p) this.probation = null;
    if (this.reverting) return;
    this.reverting = true;
    this.onChange();
    void this.takeWayBack(p, reason).catch((e) => this.log(`update: the way back to Google Chrome ${p.old} failed: ${(e as Error).name}`)).finally(() => { this.reverting = false; this.onChange(); });
  }

  /** Note the failed version, stop the unit and start the last good copy exactly. A stop since the start is no failure. */
  private async takeWayBack(p: Probation, reason: string): Promise<void> {
    if (this.unit.stopCount !== p.stops || !this.unit.config?.enabled) { this.log(`update: the agent browser was stopped or turned off; no failed start of Google Chrome ${p.new} is noted, and nothing starts`); return; }
    const lg = this.updater.lastGood();
    this.updater.noteFailed(p.new, reason);
    this.lastMoveFailed = true;
    this.log(`update: Google Chrome ${p.new} did not start: ${reason.slice(0, 300)}; starting the last good copy (${lg ?? "none known"}) again`);
    if (!(await this.mayAct("the way back of a Chrome move"))) return;
    if (this.unit.chromePid() !== null) await this.unit.stop();
    try { await this.unit.start({ upto: lg }); }
    catch (e) {
      if (e instanceof NotOwnerError) throw e;
      this.log(`update: the agent browser could not start again after the failed start of Google Chrome ${p.new}: ${(e as Error).message.slice(0, 300)}`);
      return;
    }
    this.log(`update: Google Chrome ${this.runningGoogle() ?? "no Google Chrome"} runs after the failed start of ${p.new}`);
  }
}
