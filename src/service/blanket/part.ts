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
// - The start at a use: the scope's first use starts the blanket Chrome (on Linux the unit's Xvfb must run: board
//   ab-4wh.8 starts it alone, with no main Chrome), waits up to 30 s for the receiver's hello, then for the confirm and
//   the model's readiness.
// - The end: session_ended, or a set_sessions that leaves the scope out or drops its blanket: the blanket model's line
//   names it no more (its connections close), the Chrome stops, and the folder goes. The daemon's `stop` and `enabled:
//   false` stop the Chrome and delete the folder; a stop by use keeps the folder for the session's next use.
// - status: each item of `sessions` gets `blanket`, and the blanket scope's item `blanket_state` and `list` null. No event.
// - The Mac (board ab-4wh.16; C12, the blanket profile on the Mac; `template`): the op `blanket_setup` and the hello's
//   feature `blanket_setup`, status's `blanket_template` and its operator sentences (template.ts). A start whose receiver
//   says no hello reads the copy's receiver entry after the stop (the off read): Chrome turned it off, or the copy holds
//   none, so the template goes. The blanket Chrome stops for a newer version of the operator's Chrome (`newerVersion`)
//   at a moment with no use; its folder stays.

import type { Answer, Req } from "../control.ts";
import type { ServicePart } from "../part.ts";
import type { ReceiverPort } from "../receiver.ts";
import type { AllowlistLine, Root } from "../lists/scopes.ts";
import type { StopWhy } from "../unit/part.ts";
import { useFailed } from "../unit/part.ts";
import { BLANKET_NOT_READY } from "../../relay/endpoint.ts";
import type { BlanketChrome } from "./chrome.ts";
import type { BlanketTemplate } from "./template.ts";

/** The Mac's hello feature and op of the blanket template (C12, the blanket profile on the Mac). */
export const SETUP_FEATURE = "blanket_setup";

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
  /** The Mac's off read of the copy after a start with no hello (board ab-4wh.16). */
  macOff: "Chrome turned the agent extension off in the blanket profile; the Browser pane gives the steps to set it up again",
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
   * The stop by use of the blanket Chrome (C12), by the main Chrome's rule (board ab-v16.94.11): `ms()` is the unit's grace
   * time (idle_stop_minutes); `use()` the blanket model's use now: `inUse` while an agent's own connection is open or a
   * message of any of its connections runs, and `quietFor`, the ms since the last message of any of its connections (an
   * MCP's own ticket connection counts only by its traffic). After the grace time with no use, the Chrome stops; its
   * folder stays. The check runs every `everyMs` (BLANKET_IDLE_CHECK_MS).
   */
  idle?: { ms: () => number; use: () => { inUse: boolean; quietFor: number }; everyMs?: number };
  /** End the scope's MCP sessions (mcp/part.ts): at the blanket scope's end, as C12 says. */
  endMcp?: (scope: string) => void;
  /** The box's own names (box-names.ts): the set_scopes's `exclude`, which the "*" scope may not open (C4). */
  exclude?: () => readonly string[];
  /** The Mac (board ab-4wh.16): the blanket template (template.ts). Its presence gives the op and the feature `blanket_setup`. */
  template?: BlanketTemplate;
  /**
   * The Mac: why the blanket Chrome should stop for a newer version (the operator's running Chrome and the app on disk
   * are newer than it), or null. Read at most every `versionEveryMs` (MAC_VERSION_EVERY_MS), with no use of the scope.
   */
  newerVersion?: () => string | null;
  versionEveryMs?: number;
};

/** How often the Mac's version check of the blanket Chrome runs at most (as the agent Chrome's, MAC_VERSION_EVERY_MS). */
export const BLANKET_VERSION_EVERY_MS = 60_000;

/** How often the stop by use and the watch of the blanket Chrome look. */
export const BLANKET_IDLE_CHECK_MS = 15_000;
/** The watch (as the main Chrome's fail-closed watch): a blanket Chrome whose link stays down this long stops. */
export const BLANKET_WATCH_MS = 60_000;

type Item = { scope: string; roots?: { pid: number; start: number }[]; blanket?: unknown };

/** The operator's sentence of a blanket item whose launch name two live sessions have (C11's shared-name rule). */
export const SHARED_BLANKET_TEXT = (scope: string) => `The session ${scope} has a blanket approval, but two live sessions have its launch name, so neither gets the blanket Chrome.`;

export class BlanketPart implements ServicePart {
  readonly ops: Readonly<Record<string, (req: Req) => Answer>>;
  private readonly o: BlanketPartOptions;
  private readonly clock: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** The blanket scope: the one item that has the blanket Chrome, or null. */
  private holderNow: string | null = null;
  private roots: Root[] = [];
  /** The other blanket items, each with the holder (status's sentences); the remote items with `"blanket": true`. */
  private seconds: string[] = [];
  private remotes: string[] = [];
  /** The blanket items whose launch name two live sessions have: no blanket Chrome (C11's shared-name rule). */
  private sharedNames: string[] = [];
  private stateNow: BlanketState = "stopped";
  private failure = "";
  /** The scope whose set_scopes the current blanket link confirmed, or null. */
  private confirmedFor: string | null = null;
  private hello = 0;
  /** The start that runs, with its scope: a wake of another scope never takes it (it is the old holder's). */
  private starting: { scope: string; p: Promise<string | null> } | null = null;
  /**
   * Every act on the blanket Chrome (a start, a stop, an end) runs in this one queue, in the order of its call: an end
   * that the scope's end asks for during a start runs after that start, so it stops the Chrome that the start made.
   */
  private chain: Promise<unknown> = Promise.resolve();
  private stopped = false;
  /**
   * The count of the stops of the blanket Chrome that came (stopFor): a start during which one came starts nothing more,
   * and its use gets that moment's answer (board ab-4wh.8, the review's C1: a stop during the start is that stop).
   */
  private stopsAsked = 0;
  /** The object that the current blanket link confirmed (its line is this object), or null. */
  private confirmedBody: Record<string, unknown> | null = null;
  /** The refused count of the blanket link's last answer to set_scopes (0: none). */
  private refusedBy = 0;
  /** The last use of the blanket scope (a wake, or an open connection at a check). */
  private lastUse = 0;
  /** Since when the blanket link is down while the blanket Chrome runs (the watch), or null. */
  private linkDownAt: number | null = null;
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  /** The last version check of the blanket Chrome on the Mac. */
  private versionAt: number | null = null;

  constructor(o: BlanketPartOptions) {
    this.o = o;
    // The Mac's op (C12, the blanket profile on the Mac): the answer at once; the set-up runs after it.
    this.ops = o.template ? { [SETUP_FEATURE]: () => { this.setup(); return { data: {} }; } } : {};
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
    const u = idle.use();
    if (u.inUse) { this.lastUse = this.clock(); return; }
    // The Mac: a newer version of the operator's Chrome stops the blanket Chrome at a moment with no use (the folder stays).
    if (this.o.newerVersion && (this.versionAt === null || this.clock() - this.versionAt >= (this.o.versionEveryMs ?? BLANKET_VERSION_EVERY_MS))) {
      this.versionAt = this.clock();
      let why: string | null = null;
      try { why = this.o.newerVersion(); } catch {}
      if (why !== null) {
        this.o.log(`blanket: ${why}; the blanket Chrome stops (its folder stays), and the next use starts the new version`);
        this.stopFor("move");
        return;
      }
    }
    if (this.clock() - this.lastUse < idle.ms() || u.quietFor < idle.ms()) return;
    this.o.log(`blanket: no agent used the blanket Chrome for ${Math.round(idle.ms() / 60_000)} min; stopping it (its folder stays)`);
    this.stopFor("idle");
  }

  /** The blanket scope now (the routing, stage1c's main object, the endpoint's URL), or null. */
  holder(): string | null { return this.holderNow; }

  features(): readonly string[] { return this.o.template ? [BLANKET_FEATURE, SETUP_FEATURE] : [BLANKET_FEATURE]; }

  /** The Mac: status's `blanket_template` (C12, the blanket profile on the Mac). */
  status(): Record<string, unknown> { return this.o.template ? { blanket_template: this.o.template.state() } : {}; }

  /**
   * The op `blanket_setup` (the Mac): the blanket Chrome stops first, in the queue (its folder stays), then the template's
   * set-up runs; a start that comes during it fails with the set-up's reason.
   */
  private setup(): void {
    const t = this.o.template, chrome = this.o.chrome;
    if (!t) return;
    t.setup(async () => {
      this.confirmedFor = null;
      if (this.stateNow === "ready" || this.stateNow === "starting") this.stateNow = "stopped";
      await this.serial(() => chrome.stop().then(() => {})).catch((e) => this.o.log(`blanket: the stop before the set-up failed (${(e as Error).message})`));
    });
  }

  /** The roots of the blanket item (the session check of a use of the blanket scope). */
  rootsOf(scope: string): Root[] { return scope === this.holderNow ? this.roots.map((r) => ({ ...r })) : []; }

  /** Run `f` in the blanket Chrome's one queue (see `chain`). */
  private serial<T>(f: () => Promise<T>): Promise<T> {
    const p = this.chain.then(f, f);
    this.chain = p.catch(() => {});
    return p;
  }

  /** The blanket Chrome's state (status's `blanket_state`). */
  state(): BlanketState {
    if (this.starting && this.starting.scope === this.holderNow) return "starting";
    if (this.stateNow === "ready" && !this.o.chrome.running()) return "stopped";
    return this.stateNow;
  }

  // ------------------------------------------------------------------ the sessions

  setSessions(req: Req): void {
    const items = (req.sessions ?? []) as Item[];
    // C11's shared-name rule: a launch name that two live sessions have gets no list, so it gets no blanket Chrome either
    // (the control door refuses such a snapshot; the book holds the rule too). Status says why.
    const count = new Map<string, number>();
    for (const s of items) count.set(s.scope, (count.get(s.scope) ?? 0) + 1);
    this.sharedNames = [...new Set(items.filter((s) => s.blanket === true && (count.get(s.scope) ?? 0) > 1).map((s) => s.scope))];
    for (const s of this.sharedNames) this.o.log(`blanket: two live sessions have the launch name ${s}: neither gets the blanket Chrome`);
    const blanket = items.filter((s) => s.blanket === true && count.get(s.scope) === 1).map((s) => s.scope);
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
    // The roots of the blanket item itself.
    const roots = next === null ? [] : (items.find((s) => s.scope === next && s.blanket === true)?.roots ?? []).map((r) => ({ pid: r.pid, start: r.start }));
    const changed = JSON.stringify(roots) !== JSON.stringify(this.roots);
    this.roots = roots;
    // A root change: the confirmed object's line again, with the new roots (the peer check reads them).
    if (changed && next !== null && this.confirmedFor === next && this.confirmedBody && this.o.port.isUp()) this.o.port.allowlist(this.line(this.confirmedBody, next));
    // The relay's gate reads every session's roots again after the parts, with the blanket scope of now (the service's
    // Stage1a, sessionsChanged; boards ab-4wh.9 and ab-4wh.10).
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
   * A stop of the blanket Chrome: the daemon's `stop` and `enabled: false` (also through the main unit's stop, unit/part.ts
   * beforeStop), on Linux the main unit's fail-closed stop and move (board ab-4wh.8: not its stop by use, which keeps Xvfb
   * for the blanket Chrome), and the blanket Chrome's own stop by use and watch. The daemon's `stop` and `enabled: false`
   * delete its folder; the other stops keep it, so the session's next use reuses it.
   */
  stopFor(why: StopWhy): void {
    const del = why === "stop" || why === "off";
    this.stopsAsked++;
    this.confirmedFor = null;
    if (this.stateNow === "ready" || this.stateNow === "starting") this.stateNow = "stopped";
    const chrome = this.o.chrome;
    void this.serial(() => (del ? chrome.end() : chrome.stop().then(() => {}))).catch((e) => this.o.log(`blanket: the stop failed (${(e as Error).message})`));
  }

  stop(): void { this.stopped = true; if (this.idleTimer) clearInterval(this.idleTimer); this.idleTimer = null; }

  /**
   * The service's own stop (C12: the folder goes at the daemon's stop): after every act of the queue, the blanket Chrome
   * stops and `<state>/blanket` is deleted. The main Chrome stays for the next owner; the blanket Chrome is no one's.
   */
  shutdown(): Promise<void> {
    this.stop();
    const chrome = this.o.chrome, template = this.o.template;
    const end = this.serial(() => chrome.end()).catch((e) => this.o.log(`blanket: the end at the service's stop failed (${(e as Error).message})`));
    return template ? Promise.all([end, template.shutdown().catch(() => {})]).then(() => {}) : end;
  }

  /** The end of the blanket scope: its line goes from the blanket model (its connections close), then the Chrome and the folder. */
  private endOf(scope: string, why: string): void {
    this.o.log(`blanket: the blanket scope ${scope} ends (${why}): its blanket Chrome stops and its folder is deleted`);
    this.confirmedBody = null;
    this.o.port.allowlist(this.line(null, null));
    this.o.port.endScope(scope);
    // The scope's MCP sessions of the blanket Chrome end too (C12).
    try { this.o.endMcp?.(scope); } catch {}
    const chrome = this.o.chrome;
    void this.serial(() => chrome.end()).catch((e) => this.o.log(`blanket: the end failed (${(e as Error).message})`));
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

  /**
   * The blanket model's allowlist line: the SAME object that the receiver confirmed on the blanket link (`body`: its
   * scopes, lists, default, operator and exclude, field for field), with the scope's roots. The relay judges the blanket
   * shape on the line, so the line never differs from what the receiver judged (the pin's review). With no object
   * (the end), the empty object: no scope, so no "*".
   */
  private line(body: Record<string, unknown> | null, scope: string | null): AllowlistLine {
    const b = body ?? this.body(null);
    return { t: "allowlist", ...b, roots: scope === null ? {} : { [scope]: this.roots.map((r) => ({ ...r })) } } as unknown as AllowlistLine;
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
    const body = this.body(scope);
    try { data = await this.o.port.request("set_scopes", body, BLANKET_SCOPES_WAIT_MS); }
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
    this.confirmedBody = body;
    this.o.port.allowlist(this.line(body, scope));
  }

  // ------------------------------------------------------------------ the start at a use

  /** The blanket scope can take a connection now: the blanket Chrome runs, its object is confirmed, the model is ready and names it. */
  ready(scope: string): boolean {
    if (scope !== this.holderNow || this.confirmedFor !== scope || !this.o.port.isUp() || !this.o.chrome.running()) return false;
    const m = this.o.model();
    return m !== null && m.notReady() === null && m.named(scope);
  }

  /**
   * Board ab-4wh.8 (unit.ts, xvfbUser): the blanket Chrome runs or its start runs, so it uses the unit's Xvfb (Linux).
   */
  usesXvfb(): boolean { return this.starting !== null || this.o.chrome.running(); }

  /**
   * The start at a use of the blanket scope (C12): null when the caller's checks may run again, or the 503's text. `unit`
   * brings up the unit's Xvfb (board ab-4wh.8: alone, with no main Chrome; unit/part.ts, wakeForBlanket) and answers null
   * or a start's failure text.
   */
  wake(scope: string, unit: () => Promise<string | null>): Promise<string | null> {
    if (scope !== this.holderNow || this.stopped) return Promise.resolve(null);
    this.lastUse = this.clock();
    if (this.ready(scope)) return Promise.resolve(null);
    if (this.starting?.scope === scope) return this.starting.p;
    const run: { scope: string; p: Promise<string | null> } = { scope, p: Promise.resolve(null) };
    run.p = this.startOnce(scope, unit).finally(() => { if (this.starting === run) this.starting = null; });
    this.starting = run;
    return run.p;
  }

  private fail(scope: string, reason: string): string {
    this.stateNow = "failed";
    this.failure = reason;
    this.o.log(`blanket: the blanket Chrome of the session ${scope} could not start: ${reason}`);
    return useFailed(reason);
  }

  private async startOnce(scope: string, unit: () => Promise<string | null>): Promise<string | null> {
    this.stateNow = "starting"; this.failure = "";
    // A stop of the blanket Chrome during the start (the daemon's `stop`, `enabled: false`, the main unit's stops that
    // stop it: stopFor) ends the start: nothing more starts, and the use gets that moment's answer (the review's C1).
    const stops = this.stopsAsked;
    const still = () => scope === this.holderNow && !this.stopped && this.stopsAsked === stops;
    const chrome = this.o.chrome;
    const why = await unit().catch((e) => (e as Error).message);
    if (!still()) return null;
    if (why !== null) { this.stateNow = "failed"; this.failure = why; return why; }
    // The start runs in the queue, and only while the scope still holds the blanket Chrome: an end that the scope's end
    // or a new holder asked for runs before it (no start then) or after it (it stops what the start made).
    try { await this.serial(async () => { if (still()) await chrome.start(scope); }); }
    catch (e) { return still() ? this.fail(scope, (e as Error).message) : null; }
    if (!still()) return null;
    // The receiver's hello on the blanket link (at most 30 s), with the feature blanket.
    const helloEnd = this.clock() + (this.o.helloWaitMs ?? BLANKET_HELLO_WAIT_MS);
    while (still() && this.o.chrome.running() && !this.o.port.isUp() && this.clock() < helloEnd) await this.sleep(50);
    if (!still()) return null;
    const stopIt = () => this.serial(() => chrome.stop().then(() => {}));
    // The Mac: after the stop (Chrome writes its files at a clean exit), the off read of the copy (C12).
    const template = this.o.template;
    if (!this.o.port.isUp() && template) {
      const running = this.o.chrome.running();
      await stopIt();
      if (still() && template.offRead(chrome.paths.profile)) { template.markOff(); return this.fail(scope, BLANKET_TEXT.macOff); }
      return this.fail(scope, running ? BLANKET_TEXT.noHello : "Chrome exited");
    }
    if (!this.o.port.isUp()) { const t = this.fail(scope, this.o.chrome.running() ? BLANKET_TEXT.noHello : "Chrome exited"); await stopIt(); return t; }
    if (!this.o.port.features().has(RECEIVER_BLANKET)) {
      this.fail(scope, BLANKET_TEXT.tooOld);
      await stopIt();
      return BLANKET_NOT_READY.old;
    }
    // The object goes again unless this link confirmed it already; its answer (a confirm, or refused items) ends the wait.
    if (this.confirmedFor !== scope) { this.refusedBy = 0; void this.push(); }
    const readyEnd = this.clock() + (this.o.readyWaitMs ?? BLANKET_READY_WAIT_MS);
    while (still() && !this.ready(scope) && this.refusedBy === 0 && this.o.chrome.running() && this.clock() < readyEnd) await this.sleep(50);
    if (!still()) return null;
    if (this.refusedBy !== 0) { const t = this.fail(scope, BLANKET_TEXT.refused(this.refusedBy)); await stopIt(); return t; }
    // A blanket Chrome whose receiver does not confirm stops (the fail-closed rule of the main Chrome's watch): no Chrome
    // runs on the blanket profile without its "*" confirmed.
    if (!this.ready(scope)) { const t = this.fail(scope, this.o.chrome.running() ? BLANKET_TEXT.noConfirm : "Chrome exited"); await stopIt(); return t; }
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
    for (const s of this.sharedNames) operator.push(SHARED_BLANKET_TEXT(s));
    // The Mac: the template's sentences; `none` only while a local item has a blanket approval.
    if (this.o.template) operator.push(...this.o.template.notes(this.holderNow !== null || this.seconds.length > 0 || this.sharedNames.length > 0));
    return { agent: [], operator };
  }
}
