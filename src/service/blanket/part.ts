// The blanket profile's part of the service (board ab-4wh.3; C12, the blanket profile; C11, the blanket profile; the
// design docs/superpowers/specs/2026-11-25-blanket-profile-design.md, sections 4 and 6). The operator gives ONE local
// session a blanket approval (set_sessions' item field `blanket`); its agent may open any public host, but only in the
// blanket Chrome (chrome.ts), through the blanket link and the relay's blanket model (src/relay/endpoint.ts).
//
// - The hello's feature `blanket_scope`.
// - One blanket scope per box: the holder of the last set_sessions keeps it while its item still has `"blanket": true`;
//   else the first such item in the order of `sessions` gets it. Each other blanket item runs as a normal scope with its
//   repo's list, and `operator_text` says why. A remote item's `blanket` is ignored, and `operator_text` says so.
// - The main link's set_scopes leaves the blanket scope out (stage1c.ts, with `blanketScope`), and the service writes no
//   list copy for it: agentwatch's CLI writes {"allow":["*"]} there. Its folder of the list copy goes at its end.
// - The blanket link: at each receiver hello with the feature `blanket` (C4) the part sends the set_scopes that gives the
//   blanket scope "*" and names no other scope; after its ok in time the blanket model gets the allowlist line of the
//   same object, with the scope's roots. No import, no act, no pay request and no PageFetch request goes there, and a
//   blocked report from there makes no prompt (no list exists to allow a host into).
// - The start at a use: the scope's first use starts the blanket Chrome (the unit's Xvfb must run: today's cut starts the
//   main unit first), waits up to 30 s for the receiver's hello, then for the confirm and the model's readiness.
// - The end: session_ended, or a set_sessions that leaves the scope out or drops its blanket: the blanket model's line
//   names it no more (its connections close), the Chrome stops, and the folder goes. The daemon's `stop` and `enabled:
//   false` stop the Chrome and delete the folder; a stop by use keeps the folder for the session's next use.
// - status: each item of `sessions` gets `blanket`, and the blanket scope's item `blanket_state` and `list` null. No event.

import type { Req } from "../control.ts";
import type { ServicePart } from "../part.ts";
import type { ReceiverPort } from "../receiver.ts";
import type { AllowlistLine, Root } from "../lists/scopes.ts";
import type { StopWhy } from "../unit/part.ts";
import { useFailed } from "../unit/part.ts";
import { BLANKET_NOT_READY } from "../../relay/endpoint.ts";
import type { BlanketChrome } from "./chrome.ts";

/** The hello's feature of this part (C12), and the receiver's feature that takes "*" (C4). */
export const BLANKET_FEATURE = "blanket_scope";
export const RECEIVER_BLANKET = "blanket";
/** The start's wait for the receiver's hello on the blanket link (C12: at most 30 s). */
export const BLANKET_HELLO_WAIT_MS = 30_000;
/** The wait for the confirm of the set_scopes and the model's readiness after the hello. */
export const BLANKET_READY_WAIT_MS = 30_000;
/** set_scopes' wait for an ok (C4). */
export const BLANKET_SCOPES_WAIT_MS = 10_000;

export type BlanketState = "starting" | "ready" | "stopped" | "failed";

/** The operator's sentences of status (C12, the blanket profile) and the reasons of a failed start. */
export const BLANKET_TEXT = {
  failed: (scope: string, reason: string) => `The blanket Chrome of the session ${scope} could not start: ${reason.replace(/[.\s]+$/, "")}.`,
  second: (scope: string, holder: string) => `The session ${scope} has a blanket approval, but the session ${holder} has the box's one blanket Chrome; ${scope} runs with its repo's list.`,
  remote: (scope: string) => `The session ${scope} of another box has a blanket approval, which works only for a session of this box; it runs with its own list.`,
  noHello: "the blanket profile's extension did not connect in 30 s",
  tooOld: "the blanket profile's extension is too old for the blanket profile",
  noConfirm: "the blanket profile's extension did not confirm the blanket scope",
  /** The receiver's answer counted refused items: it applies the "*" as null (C4), so the service does not confirm it. */
  refused: (n: number) => `the blanket profile's extension refused ${n} item(s) of the blanket scope's object, so the scope has no "*" there`,
} as const;

/** The blanket link's receiver port (link/link.ts, LinkReceiverPort): the main channel, the lines to the blanket model, the hello's features. */
export type BlanketPort = ReceiverPort & { features(): ReadonlySet<string> };
/** The blanket model's readiness (src/relay/model.ts). */
export type BlanketModelView = { notReady(): string | null; named(scope: string): boolean };

export type BlanketPartOptions = {
  chrome: BlanketChrome;
  port: BlanketPort;
  /** The relay's blanket model, once the agent door opens. */
  model: () => BlanketModelView | null;
  /** Remove the folder of `scope`'s list copy (stage1c.ts): at the blanket's end, the CLI's "*" copy goes. */
  removeCopy: (scope: string) => void;
  log: (line: string) => void;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  helloWaitMs?: number;
  readyWaitMs?: number;
  /**
   * The stop by use of the blanket Chrome (C12): `ms()` is the unit's grace time (idle_stop_minutes), `uses()` the blanket
   * model's open connections now. After that long with none (and no use since), the Chrome stops; its folder stays. The
   * check runs every `everyMs` (BLANKET_IDLE_CHECK_MS).
   */
  idle?: { ms: () => number; uses: () => number; everyMs?: number };
  /** The box's own names (box-names.ts): the set_scopes's `exclude`, which the "*" scope may not open (C4). */
  exclude?: () => readonly string[];
};

/** How often the stop by use and the watch of the blanket Chrome look. */
export const BLANKET_IDLE_CHECK_MS = 15_000;
/** The watch (as the main Chrome's fail-closed watch): a blanket Chrome whose link stays down this long stops. */
export const BLANKET_WATCH_MS = 60_000;

type Item = { scope: string; roots?: { pid: number; start: number }[]; blanket?: unknown };

export class BlanketPart implements ServicePart {
  readonly ops = {};
  private readonly o: BlanketPartOptions;
  private readonly clock: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** The blanket scope: the one item that has the blanket Chrome, or null. */
  private holderNow: string | null = null;
  private roots: Root[] = [];
  /** The other blanket items, each with the holder (status's sentences); the remote items with `"blanket": true`. */
  private seconds: string[] = [];
  private remotes: string[] = [];
  private stateNow: BlanketState = "stopped";
  private failure = "";
  /** The scope whose set_scopes the current blanket link confirmed, or null. */
  private confirmedFor: string | null = null;
  private hello = 0;
  private starting: Promise<string | null> | null = null;
  /** The ends that run (a stop of the Chrome and the folder's removal): a start waits for them. */
  private ending: Promise<void> = Promise.resolve();
  private stopped = false;
  /** The refused count of the blanket link's last answer to set_scopes (0: none). */
  private refusedBy = 0;
  /** The last use of the blanket scope (a wake, or an open connection at a check). */
  private lastUse = 0;
  /** Since when the blanket link is down while the blanket Chrome runs (the watch), or null. */
  private linkDownAt: number | null = null;
  private idleTimer: ReturnType<typeof setInterval> | null = null;

  constructor(o: BlanketPartOptions) {
    this.o = o;
    this.clock = o.clock ?? (() => performance.now());
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); }));
    o.port.attach({ up: () => this.onUp(), down: () => this.onDown(), blocked: () => {} });
    if (o.idle) { this.idleTimer = setInterval(() => this.idleCheck(), o.idle.everyMs ?? BLANKET_IDLE_CHECK_MS); this.idleTimer.unref?.(); }
  }

  /**
   * The stop by use (C12): the blanket Chrome runs, no start runs, the blanket model has no open connection, and the last
   * use is the grace time ago: the Chrome stops, and its folder stays for the session's next use.
   */
  idleCheck(): void {
    const idle = this.o.idle;
    if (!idle || this.stopped || this.starting || !this.o.chrome.running()) return;
    // The watch: a blanket Chrome whose receiver is not linked for BLANKET_WATCH_MS stops (fail closed); its folder stays.
    if (this.o.port.isUp()) this.linkDownAt = null;
    else {
      this.linkDownAt ??= this.clock();
      if (this.clock() - this.linkDownAt >= BLANKET_WATCH_MS) {
        this.o.log(`blanket: the blanket profile's extension has not been linked for ${BLANKET_WATCH_MS / 1000} s; stopping the blanket Chrome (its folder stays)`);
        this.linkDownAt = null;
        this.stopFor("watch");
        return;
      }
    }
    if (idle.uses() > 0) { this.lastUse = this.clock(); return; }
    if (this.clock() - this.lastUse < idle.ms()) return;
    this.o.log(`blanket: no agent used the blanket Chrome for ${Math.round(idle.ms() / 60_000)} min; stopping it (its folder stays)`);
    this.stopFor("idle");
  }

  /** The blanket scope now (the routing, stage1c's main object, the endpoint's URL), or null. */
  holder(): string | null { return this.holderNow; }

  features(): readonly string[] { return [BLANKET_FEATURE]; }

  /** The blanket Chrome's state (status's `blanket_state`). */
  state(): BlanketState {
    if (this.starting) return "starting";
    if (this.stateNow === "ready" && !this.o.chrome.running()) return "stopped";
    return this.stateNow;
  }

  // ------------------------------------------------------------------ the sessions

  setSessions(req: Req): void {
    const items = (req.sessions ?? []) as Item[];
    const blanket = items.filter((s) => s.blanket === true).map((s) => s.scope);
    const next = this.holderNow !== null && blanket.includes(this.holderNow) ? this.holderNow : blanket[0] ?? null;
    this.seconds = blanket.filter((s) => s !== next);
    this.remotes = ((req.remote ?? []) as Item[]).filter((x) => x.blanket === true).map((x) => x.scope);
    for (const s of this.seconds) this.o.log(`blanket: the session ${s} has a blanket approval, but the session ${next} has the box's one blanket Chrome; it runs with its repo's list`);
    for (const s of this.remotes) this.o.log(`blanket: the blanket approval of the session ${s} of another box is ignored`);
    if (next !== this.holderNow) {
      const old = this.holderNow;
      this.holderNow = next;
      this.confirmedFor = null;
      this.stateNow = "stopped"; this.failure = "";
      if (old !== null) this.endOf(old, "its blanket approval ended");
      if (next !== null) this.o.log(`blanket: the session ${next} has the box's blanket approval`);
    }
    const roots = next === null ? [] : (items.find((s) => s.scope === next)?.roots ?? []).map((r) => ({ pid: r.pid, start: r.start }));
    const changed = JSON.stringify(roots) !== JSON.stringify(this.roots);
    this.roots = roots;
    // A root change: the confirmed object's line again, with the new roots (the peer check reads them).
    if (changed && next !== null && this.confirmedFor === next && this.o.port.isUp()) this.o.port.allowlist(this.line(next));
  }

  sessionEnded(scope: string): void {
    if (scope !== this.holderNow) return;
    this.holderNow = null;
    this.confirmedFor = null;
    this.roots = [];
    this.stateNow = "stopped"; this.failure = "";
    this.endOf(scope, "its session ended");
  }

  /** `enabled: false` (C12): the blanket Chrome stops and its folder goes. */
  onConfig(keys: Record<string, unknown>): void {
    if (keys.enabled === false) this.stopFor("off");
  }

  /**
   * Each stop of the main unit (unit/part.ts, beforeStop): the blanket Chrome runs on the unit's Xvfb, so it stops too.
   * The daemon's `stop` and `enabled: false` delete its folder; a stop by use, the watch's stop and a move keep it, so the
   * session's next use reuses it.
   */
  stopFor(why: StopWhy): void {
    const del = why === "stop" || why === "off";
    this.confirmedFor = null;
    if (this.stateNow === "ready" || this.stateNow === "starting") this.stateNow = "stopped";
    const chrome = this.o.chrome;
    this.ending = this.ending.then(() => (del ? chrome.end() : chrome.stop().then(() => {}))).catch((e) => this.o.log(`blanket: the stop failed (${(e as Error).message})`));
  }

  stop(): void { this.stopped = true; if (this.idleTimer) clearInterval(this.idleTimer); this.idleTimer = null; }

  /** The end of the blanket scope: its line goes from the blanket model (its connections close), then the Chrome and the folder. */
  private endOf(scope: string, why: string): void {
    this.o.log(`blanket: the blanket scope ${scope} ends (${why}): its blanket Chrome stops and its folder is deleted`);
    this.o.port.allowlist(this.line(null));
    this.o.port.endScope(scope);
    const chrome = this.o.chrome;
    this.ending = this.ending.then(() => chrome.end()).catch((e) => this.o.log(`blanket: the end failed (${(e as Error).message})`));
    try { this.o.removeCopy(scope); } catch {}
  }

  // ------------------------------------------------------------------ the blanket link

  /**
   * The set_scopes object of the blanket link (C12, C4): exactly `scopes` with the scope's "*" alone (or no scope), `lists`
   * empty, `default` null, `operator` null, and `exclude`, the box's own names that the "*" scope may not open.
   */
  private body(scope: string | null): Record<string, unknown> {
    let exclude: string[] = [];
    try { exclude = [...(this.o.exclude?.() ?? [])]; } catch {}
    return { lists: {}, scopes: scope === null ? {} : { [scope]: "*" }, default: null, operator: null, exclude };
  }

  /** The blanket model's allowlist line of that object, with the scope's roots. */
  private line(scope: string | null): AllowlistLine {
    return { t: "allowlist", ...this.body(scope), roots: scope === null ? {} : { [scope]: this.roots.map((r) => ({ ...r })) } } as unknown as AllowlistLine;
  }

  private onUp(): void {
    this.linkDownAt = null;
    this.hello++;
    this.confirmedFor = null;
    void this.push();
  }

  private onDown(): void { this.confirmedFor = null; this.linkDownAt = this.clock(); }

  /** Send the blanket object on the current link; after its ok in time, the line to the blanket model. */
  private async push(): Promise<void> {
    const scope = this.holderNow, hello = this.hello;
    if (scope === null || this.stopped || !this.o.port.isUp()) return;
    if (!this.o.port.features().has(RECEIVER_BLANKET)) { this.o.log("blanket: the blanket profile's extension has no feature blanket; it gets no \"*\""); return; }
    let data: Record<string, unknown>;
    try { data = await this.o.port.request("set_scopes", this.body(scope), BLANKET_SCOPES_WAIT_MS); }
    catch (e) { this.o.log(`blanket: the blanket profile's extension did not confirm the blanket scope: ${String((e as Error).message ?? e).slice(0, 200)}`); return; }
    if (hello !== this.hello || scope !== this.holderNow || !this.o.port.isUp()) return;
    // An answer with refused items (C4: a "*" of another shape, or a bad `exclude`, applies as null): no confirm, and
    // blanket_state failed with the cause. The log line names the count, never a host name.
    const refused = Number.isSafeInteger(data?.refused) ? (data.refused as number) : 0;
    if (refused !== 0) {
      this.refusedBy = refused;
      this.stateNow = "failed";
      this.failure = BLANKET_TEXT.refused(refused);
      this.o.log(`blanket: the blanket profile's extension refused ${refused} item(s) of the blanket scope's object; the blanket scope is not confirmed`);
      return;
    }
    this.refusedBy = 0;
    this.confirmedFor = scope;
    this.o.port.allowlist(this.line(scope));
  }

  // ------------------------------------------------------------------ the start at a use

  /** The blanket scope can take a connection now: the blanket Chrome runs, its object is confirmed, the model is ready and names it. */
  ready(scope: string): boolean {
    if (scope !== this.holderNow || this.confirmedFor !== scope || !this.o.port.isUp() || !this.o.chrome.running()) return false;
    const m = this.o.model();
    return m !== null && m.notReady() === null && m.named(scope);
  }

  /**
   * The start at a use of the blanket scope (C12): null when the caller's checks may run again, or the 503's text. `unit`
   * brings the unit up (its Xvfb; today's cut: the main Chrome too) and answers null or a start's failure text.
   */
  wake(scope: string, unit: () => Promise<string | null>): Promise<string | null> {
    if (scope !== this.holderNow || this.stopped) return Promise.resolve(null);
    this.lastUse = this.clock();
    if (this.ready(scope)) return Promise.resolve(null);
    this.starting ??= this.startOnce(scope, unit).finally(() => { this.starting = null; });
    return this.starting;
  }

  private fail(scope: string, reason: string): string {
    this.stateNow = "failed";
    this.failure = reason;
    this.o.log(`blanket: the blanket Chrome of the session ${scope} could not start: ${reason}`);
    return useFailed(reason);
  }

  private async startOnce(scope: string, unit: () => Promise<string | null>): Promise<string | null> {
    this.stateNow = "starting"; this.failure = "";
    await this.ending;
    const still = () => scope === this.holderNow && !this.stopped;
    const why = await unit().catch((e) => (e as Error).message);
    if (!still()) return null;
    if (why !== null) { this.stateNow = "failed"; this.failure = why; return why; }
    try { await this.o.chrome.start(scope); }
    catch (e) { return still() ? this.fail(scope, (e as Error).message) : null; }
    // The receiver's hello on the blanket link (at most 30 s), with the feature blanket.
    const helloEnd = this.clock() + (this.o.helloWaitMs ?? BLANKET_HELLO_WAIT_MS);
    while (still() && this.o.chrome.running() && !this.o.port.isUp() && this.clock() < helloEnd) await this.sleep(50);
    if (!still()) return null;
    if (!this.o.port.isUp()) { const t = this.fail(scope, this.o.chrome.running() ? BLANKET_TEXT.noHello : "Chrome exited"); await this.o.chrome.stop(); return t; }
    if (!this.o.port.features().has(RECEIVER_BLANKET)) {
      this.fail(scope, BLANKET_TEXT.tooOld);
      await this.o.chrome.stop();
      return BLANKET_NOT_READY.old;
    }
    // The object goes again unless this link confirmed it already; its answer (a confirm, or refused items) ends the wait.
    if (this.confirmedFor !== scope) { this.refusedBy = 0; void this.push(); }
    const readyEnd = this.clock() + (this.o.readyWaitMs ?? BLANKET_READY_WAIT_MS);
    while (still() && !this.ready(scope) && this.refusedBy === 0 && this.o.chrome.running() && this.clock() < readyEnd) await this.sleep(50);
    if (!still()) return null;
    if (this.refusedBy !== 0) { const t = this.fail(scope, BLANKET_TEXT.refused(this.refusedBy)); await this.o.chrome.stop(); return t; }
    // A blanket Chrome whose receiver does not confirm stops (the fail-closed rule of the main Chrome's watch): no Chrome
    // runs on the blanket profile without its "*" confirmed.
    if (!this.ready(scope)) { const t = this.fail(scope, this.o.chrome.running() ? BLANKET_TEXT.noConfirm : "Chrome exited"); await this.o.chrome.stop(); return t; }
    this.stateNow = "ready";
    this.lastUse = this.clock();
    this.o.log(`blanket: the blanket Chrome of the session ${scope} is ready`);
    return null;
  }

  // ------------------------------------------------------------------ status

  /** Each item of status's `sessions`: `blanket`, and for the blanket scope `blanket_state` and `list` null (C12). */
  statusSessions(rows: Record<string, unknown>[]): Record<string, unknown>[] {
    return rows.map((r) => (r.scope === this.holderNow ? { ...r, list: null, blanket: true, blanket_state: this.state() } : { ...r, blanket: false }));
  }

  notes(): { agent: string[]; operator: string[] } {
    const operator: string[] = [];
    if (this.holderNow !== null && this.state() === "failed") operator.push(BLANKET_TEXT.failed(this.holderNow, this.failure || "unknown"));
    for (const s of this.seconds) if (this.holderNow !== null) operator.push(BLANKET_TEXT.second(s, this.holderNow));
    for (const s of this.remotes) operator.push(BLANKET_TEXT.remote(s));
    return { agent: [], operator };
  }
}
