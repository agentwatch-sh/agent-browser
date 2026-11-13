// The sign-in act in the service's model (contract C11, "The sign-in act", the master; C12's `sign_in` event; the stored
// sign-ins design, docs/superpowers/specs/2026-11-10-stored-sign-in-credentials-design.md, section 7; board ab-v16.97.4,
// stage 1e part 2). An agent asks for a sign-in by the name of a credential that the operator stored. The service types
// the credential's username and password into a tab of its own, in an incognito window that the receiver opens for the
// act (C10, the act window), and that no client sees: the model hides the act tab and its window (model.ts). After a
// sign-in it moves the site's cookies and localStorage into the default context through stage 1c's import path.
//
// The order (C11): checks 1 to 7 (the local admission first); the act window (receiver op windows.create with the mark
// act, focused false), its tab hidden, the service's own session on it, the move outside the screen at the X level and
// the read of its place; the navigation and the form rules 1 to 5; the act's rules (C4's act_rules) and their
// confirmation, the guard (Fetch), the type watch (rule 7) and the open connections (rule 6) before the first key; the
// fill with the person's input (src/human/: the generator's keys, else Input.insertText) under the input lock; the
// submit; the outcome and the lockout guard; the clean end (the inputs, the leak check and the move, the history,
// Fetch off, act_end: the service never closes the act window itself, and act_end also follows an act_rules that failed
// or came late); the answers, the log line and the events.
//
// The log rule (C11, C12): no log line, answer or event holds a username, a password, a form value, a page's text, a URL
// path, a query, or the host of a request that the block or the guard stopped. A refusal by check 1 or 2 names no
// credential.

import { randomBytes } from "node:crypto";
import { userInfo } from "node:os";
import { CdpPlayer } from "../../human/cdp-player.ts";
import { charKey, typingPace, type KeyEv } from "../../human/keys.ts";
import { planPath, startPoint, type Pt } from "../../human/path.ts";
import type { Person } from "../../human/person.ts";
import { holdMs, pauseMs, spreadPoint, type Box } from "../../human/press.ts";
import type { Random } from "../../human/random.ts";
import { SCOPE } from "../../relay/scopes.ts";
import { coveredBy } from "../lists/hosts.ts";
import {
  ACT_TEXT, formPlan, guardDecision, leaks, movePayload, openOutside, outcomeOf, outsideScreen, RefusalRate,
  type ActResult, type C2Cookie, type FieldRead, type PageRead,
} from "./act-rules.ts";
import { call, EMPTY_INPUTS, FIELD_BOX, MARK_TITLE, READ_LOCAL, READ_PAGE, SUBMIT_BOX, TYPE_WATCH, WATCH_HIT } from "./act-page.ts";
import type { RecordFields } from "./seal.ts";
import type { StoreState } from "./store.ts";

/** The first values (C11; the design, section 15). */
export const ACT_LIMITS = {
  /** Check 7: an act waits for the act before it at most this long. */
  busyMs: 60_000,
  /** The outcome: the act watches the act tab this long after the submit; the page's load and a two-step's next page too. */
  outcomeMs: 30_000,
  /** The settle: this long with no navigation before the outcome's read. */
  settleMs: 1_000,
  /** C4: the act's caller waits this long for act_rules, act_cookies and act_end, from the send. */
  receiverMs: 10_000,
  /** The act's own bound of a request of channel main: its wait from the send, and an import that it may wait behind (C4: at most 115 s). */
  queueMs: 120_000,
  /** A popup's window must be outside the screen in this time. */
  popupMs: 2_000,
  /** Each CDP command of the act's own session waits at most this long (C10's wait of the request): a page that stalls ends the act. */
  cdpMs: 30_000,
} as const;
/** The receiver's hello feature of the act (C4): the service tests for membership in the hello's list. */
export const ACT_FEATURE = "act";
/** The bridge errors of the act window (C10). */
const PRIVATE_WINDOW = "another private window is open";

/** The caller of the act: the connection's scope (the walk's) and how it was admitted (C11, check 1). */
export type ActCaller = { scope: string; admission: "local" | "remote" };

/** What the model gives the act (model.ts, actPort): its bridge, the hiding of the act's tabs, their events, the input lock and the scope's person. */
export interface ActModelPort {
  /** C11's readiness text, or null when ready. */
  notReady(): string | null;
  /** The entries of the scope's list in the last allowlist line, or null for a scope with no list. */
  entries(scope: string): readonly string[] | null;
  /** One bridge op (C10): windows.create, windows.get, debugger.attach, debugger.sendCommand, debugger.detach. */
  call<T = any>(op: string, args?: unknown[], o?: { wait?: number }): Promise<T>;
  /** Mark a tab as an act tab: no client sees it, attaches it or gets an event of it. */
  hide(tabId: number): void;
  /** The receiver's events of hidden tabs (the act tab's debugger.onEvent stream among them), and of every incognito tab. */
  listen(fn: (ev: Record<string, any>) => void): () => void;
  /** The browser's input lock (the input design, section 4.4): a client's input calls wait for it. */
  inputLock<T>(fn: () => Promise<T>): Promise<T>;
  /** The scope's person (C11: one person for each scope) and the model's random source. */
  person(scope: string): Person;
  random: Random;
}
/** The receiver's channel main (C4) for the act, and its hello's features. */
export interface ActReceiver {
  features(): ReadonlySet<string>;
  request(op: "act_rules" | "act_cookies" | "act_end", body: Record<string, unknown>, waitMs: number): Promise<Record<string, unknown>>;
}
/** The store's part of the act (store.ts). */
export interface ActStore {
  state(): StoreState;
  /** Check 2's record: the one record of that name with `approved` true, or null. */
  named(name: string): { fields: RecordFields; file: Record<string, unknown> } | null;
  /** The records that a scope may use, for AgentBrowser.signIns. */
  usable(): RecordFields[];
  openForUse(x: Record<string, unknown>): { username: Buffer; password: Buffer } | { refused: "locked" | "cannot_open" };
  limit(id: string): "stopped" | "hour_limit" | null;
  actStarted(id: string): void;
  actEnded(id: string, result: string): boolean;
}
/** The X level: the screen's size, and the move of the act window and of an act popup's window to the right of the screen. */
export interface ActScreen {
  size(): { width: number; height: number } | null;
  /** Move each X window whose name holds `marker` (a title of the act's own); the number moved. */
  moveOff(marker: string): Promise<number>;
}
/** Stage 1c's import path (stage1c.ts, moveSignIn): the C2 check, the box's rule and the receiver's import. */
export interface ActMove { move(payload: Record<string, unknown>): Promise<boolean> }

export type SignInActOptions = {
  model: ActModelPort; receiver: ActReceiver; store: ActStore; screen: ActScreen; move: ActMove;
  /** C12's `sign_in` event. */
  emit: (ev: Record<string, unknown>) => void;
  log: (line: string) => void;
  /** The repo of the scope's session in the last set_sessions, or null. */
  repoOf: (scope: string) => string | null;
  /** Tests only: shorter waits. */
  limits?: Partial<typeof ACT_LIMITS>;
  /** Tests only: the clock of the events (ISO 8601) and of the refusal rate. */
  now?: () => number;
};

/** A refusal: its result, and the text that the agent sees (C11, what the agent sees). */
export class ActRefusal extends Error {
  readonly result: ActResult;
  constructor(result: ActResult, text: string) { super(`Not signed in: ${text}`); this.result = result; }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));
/** `<name>` of C11's text: the asked name, as a JSON string when it does not match the scope pattern, null with none. */
export const nameText = (name: unknown) => (typeof name === "string" && SCOPE.test(name) ? name : name === undefined ? "null" : JSON.stringify(name) ?? "null");
const hostsOf = (origins: readonly string[]) => origins.map((o) => new URL(o).hostname);
/** The key fields of one planned key event (as the input design's players send them). */
function keyParams(ev: KeyEv): Record<string, unknown> {
  return { type: ev.type, key: ev.key, code: ev.code, windowsVirtualKeyCode: ev.keyCode, nativeVirtualKeyCode: ev.keyCode, modifiers: ev.modifiers,
    ...(ev.location ? { location: ev.location } : {}), ...(ev.type !== "keyUp" && ev.text ? { text: ev.text, unmodifiedText: ev.text } : {}) };
}

/** The act's state while it runs: its counts, the act tab's open connections, its navigations and its end. */
type Run = {
  scope: string; record: RecordFields; values: { username: Buffer; password: Buffer }; password: string;
  window: number | null; tab: number | null; world: number | null; frame: string | null;
  blocked: number; guarded: number; guardedIds: Set<string>;
  sockets: Map<string, string>; navAt: number | null; loads: number; lost: boolean; popupFailed: boolean; watching: boolean; watchCtx: number | null;
  /** The act's tabs (the act tab and each act popup), and each act popup's window (null until the service knows it). */
  actTabs: Set<number>; popups: Map<number, { window: number | null }>;
  /** An act popup opened before the password's last key, or one whose session or guard failed (the act ends `popup`); the last key went. */
  popupEarly: boolean; popupUnguarded: boolean; lastKey: boolean;
  last: Pt | null; viewport: { width: number; height: number };
};

export class SignInAct {
  private readonly o: SignInActOptions;
  private readonly limits: typeof ACT_LIMITS;
  private readonly rate = new RefusalRate();
  private readonly now: () => number;
  /** Check 7: one act at a time, each waiting for the act before it. */
  private tail: Promise<void> = Promise.resolve();
  private readonly user: string;

  constructor(o: SignInActOptions) {
    this.o = o;
    this.limits = { ...ACT_LIMITS, ...o.limits };
    this.now = o.now ?? Date.now;
    let user = "unknown";
    try { user = userInfo().username; } catch { /* no passwd entry */ }
    this.user = user;
  }

  // ---------------------------------------------------------------- AgentBrowser.signIns

  /** C11: the store's state and the names and origins that the caller's scope may use (checks 2 and 3); it refuses only by check 1. */
  signIns(c: ActCaller): { state: StoreState; signIns: { name: string; origin: string }[] } {
    if (c.admission !== "local") throw new ActRefusal("remote", ACT_TEXT.remote);
    const entries = this.o.model.entries(c.scope) ?? [];
    const out = this.o.store.usable().filter((r) => coveredBy(entries, new URL(r.origin).hostname) && hostsOf(r.send_to).every((h) => coveredBy(entries, h)))
      .map((r) => ({ name: r.name, origin: r.origin })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return { state: this.o.store.state(), signIns: out };
  }

  // ---------------------------------------------------------------- AgentBrowser.signIn

  /** C11's act for one request: the answer on success; an ActRefusal with C11's text otherwise. */
  async signIn(c: ActCaller, params: Record<string, unknown>): Promise<{ signedIn: true; name: string; origin: string }> {
    const act = randomBytes(8).toString("hex"), t0 = performance.now();
    const repo = this.o.repoOf(c.scope);
    const refuse = (result: ActResult, text: string, record: RecordFields | null): never => {
      this.end({ act, scope: c.scope, repo, record, result, ms: Math.round(performance.now() - t0), blocked: 0, guarded: 0, stoppedNow: false, started: false });
      throw new ActRefusal(result, text);
    };
    // Check 1: a local admission, and the agent browser is ready.
    if (c.admission !== "local") refuse("remote", ACT_TEXT.remote, null);
    const notReady = this.o.model.notReady();
    if (notReady !== null) refuse("not_ready", notReady, null);
    // Check 2: an approved record of the name whose host the scope's list covers (the answer Q2 b: no repos). One text for
    // no such name, another scope's name and an offer that waits.
    const name = params.name;
    const entries = this.o.model.entries(c.scope) ?? [];
    const found = typeof name === "string" ? this.o.store.named(name) : null;
    if (!found || !coveredBy(entries, new URL(found.fields.origin).hostname)) refuse("no_such_name", ACT_TEXT.no_such_name.replace("<name>", nameText(name)), null);
    const record = found!.fields;
    // Check 3: the list covers each host of send_to.
    const offList = hostsOf(record.send_to).find((h) => !coveredBy(entries, h));
    if (offList !== undefined) refuse("not_allowed", ACT_TEXT.not_allowed.replace("<host>", offList), record);
    // Checks 4 to 6, then check 7's wait; a request that waited is checked again at its turn (checks 4 to 6), and the
    // record's values open only then (review-124 B1, N2): an act before it can have stopped the credential, used the
    // hour's last act, or the operator can have locked the store meanwhile.
    const checks = (): void => {
      // Check 4: the store is open. Check 5: the record opens (its values go to zeros at once here).
      if (this.o.store.state() !== "open") refuse("locked", ACT_TEXT.locked, record);
      const probe = this.o.store.openForUse(found!.file);
      if ("refused" in probe) refuse(probe.refused, ACT_TEXT[probe.refused], record);
      const pv = probe as { username: Buffer; password: Buffer };
      pv.username.fill(0); pv.password.fill(0);
      // Check 6: not stopped, and fewer than 6 acts in the last hour.
      const limit = this.o.store.limit(record.id);
      if (limit) refuse(limit, ACT_TEXT[limit], record);
    };
    checks();
    // Check 7: no other act runs; this one waits at most 60 s.
    const release = await this.turn();
    if (!release) refuse("busy", ACT_TEXT.busy, record);
    let values: { username: Buffer; password: Buffer } | null = null;
    try {
      checks();
      const opened = this.o.store.openForUse(found!.file);
      if ("refused" in opened) refuse(opened.refused, ACT_TEXT[opened.refused], record);
      values = opened as { username: Buffer; password: Buffer };
      // The act starts: it counts for the hour, the status's acts, and the lockout guard.
      this.o.store.actStarted(record.id);
      this.o.emit({ t: "ev", ev: "sign_in", phase: "start", act, scope: c.scope, repo, id: record.id, name: record.name, origin: record.origin, at: this.at() });
      const run: Run = { scope: c.scope, record, values, password: values.password.toString("utf8"), window: null, tab: null, world: null, frame: null,
        blocked: 0, guarded: 0, guardedIds: new Set(), sockets: new Map(), navAt: null, loads: 0, lost: false, popupFailed: false, watching: false, watchCtx: null, last: null, viewport: { width: 1280, height: 800 },
        actTabs: new Set(), popups: new Map(), popupEarly: false, popupUnguarded: false, lastKey: false };
      let result: ActResult;
      try { result = await this.run(run); }
      catch { result = this.o.model.notReady() !== null ? "not_ready" : "lost"; }
      const stoppedNow = this.o.store.actEnded(record.id, result);
      this.end({ act, scope: c.scope, repo, record, result, ms: Math.round(performance.now() - t0), blocked: run.blocked, guarded: run.guarded, stoppedNow, started: true });
      if (result === "signed_in") return { signedIn: true, name: record.name, origin: record.origin };
      throw new ActRefusal(result, result === "not_ready" ? this.o.model.notReady() ?? ACT_TEXT.lost : ACT_TEXT[result as keyof typeof ACT_TEXT]);
    } finally {
      release!();
      // The clean end's last step: the buffers of the values are zeros (a copy in a JavaScript string stays until the next collection).
      if (values) { values.username.fill(0); values.password.fill(0); }
    }
  }

  /** Check 7's turn: the release of this act's turn, or null after 60 s (its place then passes at once). */
  private async turn(): Promise<(() => void) | null> {
    const prev = this.tail;
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    this.tail = prev.then(() => mine);
    let timer: NodeJS.Timeout | undefined;
    const got = await Promise.race([prev.then(() => true), new Promise<boolean>((r) => { timer = setTimeout(() => r(false), this.limits.busyMs); })]);
    clearTimeout(timer);
    if (!got) { release(); return null; }
    return release;
  }

  private at(): string { return new Date(this.now()).toISOString().replace(/\.\d{3}Z$/, "Z"); }

  /** The end of a request: the `end` event (a refusal's end within the rate of refusal ends) and the one log line. */
  private end(e: { act: string; scope: string; repo: string | null; record: RecordFields | null; result: ActResult; ms: number; blocked: number; guarded: number; stoppedNow: boolean; started: boolean }): void {
    // A refusal by check 1 or 2 names no credential; an act that started names its credential at its end too (a link
    // that went down during it ends it `not_ready`, with the credential of its start).
    const cred = !e.started && (e.result === "remote" || e.result === "not_ready" || e.result === "no_such_name") ? null : e.record;
    const ev: Record<string, unknown> = { t: "ev", ev: "sign_in", phase: "end", act: e.act, scope: e.scope, repo: e.repo, id: cred?.id ?? null, name: cred?.name ?? null,
      origin: cred?.origin ?? null, at: this.at(), result: e.result, ms: e.ms, blocked: e.blocked, guarded: e.guarded, stopped_now: e.stoppedNow };
    let sent = true;
    if (!e.started) {
      const r = this.rate.take(e.scope, this.now());
      sent = r.send;
      if (r.dropped > 0) ev.dropped = r.dropped;
    }
    if (sent) this.o.emit(ev);
    this.o.log(`sign-in: act ${e.act}: user ${this.user}, scope ${e.scope}, repo ${e.repo ?? "none"}, ${cred ? `credential ${cred.id} ${cred.name}, origin ${cred.origin}` : "no credential"}, result ${e.result}, ${e.ms} ms, ${e.blocked} blocked, ${e.guarded} guarded${e.started ? "" : sent ? "" : " (its event was over the rate)"}`);
  }

  // ---------------------------------------------------------------- the act

  /** The act after the checks: its result. The clean end runs in every case. */
  private async run(r: Run): Promise<ActResult> {
    const off = this.o.model.listen((ev) => this.onEvent(r, ev));
    let result: ActResult = "lost", opened = false;
    try {
      result = await this.act(r, () => { opened = true; });
    } catch (e) {
      result = this.o.model.notReady() !== null ? "not_ready" : "lost";
    } finally {
      if (opened) result = await this.cleanEnd(r, result);
      off();
    }
    return result;
  }

  private send(r: Run, method: string, params: Record<string, unknown> = {}): Promise<any> {
    if (r.lost) return Promise.reject(new Error("the act tab is gone"));
    return this.sendTo(r.tab!, method, params);
  }

  /** An evaluation in the act's own isolated world of the current document, made again at each call (a navigation drops it). */
  private async evaluate<T>(r: Run, expression: string): Promise<T> {
    const w = await this.send(r, "Page.createIsolatedWorld", { frameId: r.frame, worldName: `aw-act-${randomBytes(4).toString("hex")}-${r.tab}`, grantUniversalAccess: false });
    r.world = w?.executionContextId ?? null;
    const v = await this.send(r, "Runtime.evaluate", { expression, contextId: r.world, returnByValue: true, awaitPromise: false });
    if (v?.exceptionDetails) throw new Error("the act's read failed");
    return v?.result?.value as T;
  }

  /** The type watch's own world: made once, and its reads go to its context (a new document has none: the read then fails). */
  private async watchEval<T>(r: Run, expression: string): Promise<T | null> {
    if (r.watchCtx === null) {
      const w = await this.send(r, "Page.createIsolatedWorld", { frameId: r.frame, worldName: `aw-act-watch-${randomBytes(6).toString("hex")}`, grantUniversalAccess: false });
      r.watchCtx = Number.isInteger(w?.executionContextId) ? w.executionContextId : null;
      if (r.watchCtx === null) return null;
    }
    const v = await this.send(r, "Runtime.evaluate", { expression, contextId: r.watchCtx, returnByValue: true, awaitPromise: false }).catch(() => null);
    return v && !v.exceptionDetails ? (v.result?.value as T) : null;
  }

  private async act(r: Run, opened: () => void): Promise<ActResult> {
    const m = this.o.model, rec = r.record;
    // The receiver must have the act (C4: membership in the hello's features), and the service its X display.
    if (!this.o.receiver.features().has(ACT_FEATURE)) return "no_window";
    const screen = this.o.screen.size();
    if (!screen) return "window";
    // The act window: incognito, the mark act, the caller's scope, at about:blank, with no focus (C10).
    let w: any;
    try { w = await m.call("windows.create", [{ url: "about:blank", focused: false, incognito: true }, r.scope, "act"]); }
    catch (e) {
      const why = (e as Error).message;
      if (why === "timeout") opened();
      return why === PRIVATE_WINDOW ? "private_window" : "no_window";
    }
    opened();
    const tab = w?.tabs?.[0]?.id;
    if (!Number.isInteger(w?.id) || !Number.isInteger(tab) || w.incognito !== true) return "no_window";
    r.window = w.id; r.tab = tab;
    m.hide(tab);
    r.actTabs.add(tab);
    // The service's own session on the act tab, inside its process.
    await m.call("debugger.attach", [tab]);
    await this.send(r, "Page.enable");
    await this.send(r, "Network.enable");
    await this.send(r, "Network.setBypassServiceWorker", { bypass: true });
    const tree = await this.send(r, "Page.getFrameTree");
    r.frame = tree?.frameTree?.frame?.id ?? null;
    if (!r.frame) return "lost";
    // Outside the screen before the page loads: the X move by the window's title marker, then the window's place.
    const marker = `aw-act-${randomBytes(8).toString("hex")}`;
    await this.evaluate(r, call(MARK_TITLE, marker));
    // Chrome gives the X window the page's title a moment later: the move tries again until the place is outside.
    let outside = false;
    for (const end = performance.now() + this.limits.popupMs + 1000; !outside && performance.now() < end;) {
      if ((await this.o.screen.moveOff(marker).catch(() => 0)) === 0) { await sleep(100); continue; }
      const placed = await m.call("windows.get", [r.window]).catch(() => null);
      outside = !!placed && outsideScreen(placed, screen);
      if (!outside) await sleep(100);
    }
    if (!outside) return "window";
    // Form rule 1: the record's page, on its exact origin.
    // Page.navigate answers when the navigation commits: the load's own wait bounds it (a server that never answers).
    const loaded = this.navigated(r);
    void this.send(r, "Page.navigate", { url: `${rec.origin}${rec.path}` }).catch(() => {});
    if (!(await loaded)) return "timeout";
    let read = await this.evaluate<PageRead & { viewport: { width: number; height: number } }>(r, call(READ_PAGE));
    r.viewport = read.viewport ?? r.viewport;
    let plan = formPlan(read, rec, { username: r.values.username.length > 0, stepDone: false });
    if ("refused" in plan) return plan.refused;
    // The act's rules (C4, C5), confirmed before the first key; after a failed or late answer the clean end sends act_end.
    try {
      const a = await this.ask("act_rules", { tab, origin: rec.origin, send_to: [...rec.send_to] });
      if (!Array.isArray(a?.rules) || a.rules.length === 0) return "rules";
    } catch { return "rules"; }
    // The guard: Fetch on the act tab, every URL, at the request stage.
    await this.send(r, "Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
    if ("step" in plan) {
      // A two-step sign-in (form rule 5): the username, the submit, the next page, and the rules 1 to 4 again (once).
      const step = plan.step;
      const first = await this.inputs(r, async () => {
        const open = this.openConnection(r);
        if (open) return open;
        const typed = await this.fill(r, step, r.values.username.toString("utf8"), false);
        if (typed) return typed;
        await this.pressEnter(r);
        return null;
      });
      if (first) return first;
      const next = await this.nextPage(r);
      if (!next) return "timeout";
      read = next;
      plan = formPlan(read, rec, { username: false, stepDone: true });
      if ("refused" in plan) return plan.refused;
      if ("step" in plan) return "no_form";
    }
    const p = plan as { user: FieldRead | null; password: FieldRead; form: number | null };
    // Form rule 7: the type watch, before the first key of the password.
    const watched = await this.watchEval<boolean>(r, call(TYPE_WATCH, p.password.i));
    if (watched !== true) return "no_form";
    r.watching = true;
    const filled = await this.inputs(r, async () => {
      // Form rule 6 at the first key: no open WebSocket or WebTransport to a host outside send_to.
      const open = this.openConnection(r);
      if (open) return open;
      const user = p.user ? await this.fill(r, p.user, r.values.username.toString("utf8"), false) : null;
      if (user) return user;
      const typed = await this.fill(r, p.password, r.password, true);
      if (typed) return typed;
      r.lastKey = true;
      // The submit as a person does it: the form's visible submit button, else Enter in the password field.
      const box = p.form !== null ? await this.evaluate<Box | null>(r, call(SUBMIT_BOX, p.form)) : null;
      r.navAt = null;
      if (box) await this.click(r, box); else await this.pressEnter(r);
      return null;
    });
    if (filled) return filled;
    return this.outcome(r);
  }

  /**
   * One request of C4's channel main for the act. The link waits 10 s from the send (a late answer is a failure); the act's
   * own bound adds the time that a request may wait behind an import of channel main, so a link that never answers ends it.
   */
  private ask(op: "act_rules" | "act_cookies" | "act_end", body: Record<string, unknown>): Promise<Record<string, unknown>> {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), this.limits.receiverMs + this.limits.queueMs); });
    return Promise.race([this.o.receiver.request(op, body, this.limits.receiverMs), late]).finally(() => clearTimeout(timer));
  }

  /** The fill and the submit under the browser's input lock (a client's input calls wait for it). */
  private inputs(r: Run, fn: () => Promise<ActResult | null>): Promise<ActResult | null> {
    return this.o.model.inputLock(fn);
  }

  private openConnection(r: Run): ActResult | null {
    return openOutside(r.sockets.values(), r.record.send_to).length ? "open_connection" : r.popupEarly || r.popupUnguarded ? "popup" : r.popupFailed ? "window" : null;
  }

  /** The page's load after a navigation of the main frame, in the outcome's time. */
  private navigated(r: Run): Promise<boolean> {
    const before = r.loads;
    return this.until(() => r.loads > before || r.lost, this.limits.outcomeMs).then(() => r.loads > before && !r.lost);
  }

  private async until(fn: () => boolean, ms: number): Promise<boolean> {
    const end = performance.now() + ms;
    while (!fn()) { if (performance.now() >= end) return false; await sleep(25); }
    return true;
  }

  /** A two-step's next page: a navigation and its load, or a password field that the page shows, in the outcome's time. */
  private async nextPage(r: Run): Promise<PageRead | null> {
    const end = performance.now() + this.limits.outcomeMs;
    while (performance.now() < end && !r.lost) {
      await sleep(250);
      if (r.navAt !== null && performance.now() - r.navAt < this.limits.settleMs) continue;
      const read = await this.evaluate<PageRead>(r, call(READ_PAGE)).catch(() => null);
      if (read && read.fields.some((f) => f.type === "password" && f.visible && f.enabled)) return read;
    }
    return null;
  }

  /**
   * One field: a click on it with the person's press, then its value with the person's input of the input design: the
   * generator's keys when each character has a key on the US layout and the plan fits in 10 s, else Input.insertText.
   * The type watch's flag is read before each key of the password; a change of the type ends the fill.
   */
  private async fill(r: Run, f: FieldRead, value: string, password: boolean): Promise<ActResult | null> {
    const box = await this.evaluate<Box | null>(r, call(FIELD_BOX, f.i));
    if (!box) return "no_form";
    await this.click(r, box);
    const person = this.o.model.person(r.scope), random = this.o.model.random;
    // An act popup before the password's last key ends the act: no key goes after the service learns of it (review-124
    // B2, B3). The flags are read again after the type watch's read, at once before the key (review-124b F1): a popup's
    // event can come during that read.
    const flags = (): ActResult | null => (r.lost ? "lost" : r.popupEarly || r.popupUnguarded ? "popup" : r.popupFailed ? "window" : null);
    const check = async (): Promise<ActResult | null> => {
      const before = flags();
      if (before) return before;
      if (password && r.watching) {
        const hit = await this.watchEval<boolean | null>(r, call(WATCH_HIT));
        if (hit !== false) return hit === true ? "type_watch" : "lost";
      }
      return flags();
    };
    const keyed = [...value].every((ch) => charKey(ch) !== undefined);
    const pace = keyed ? typingPace(value, person, random) : null;
    if (!pace) {
      const stop = await check();
      if (stop) return stop;
      await this.send(r, "Input.insertText", { text: value });
      return check();
    }
    const player = this.player(r);
    const t0 = performance.now();
    for (const ev of pace.plan.events) {
      await sleep(t0 + ev.t - performance.now());
      if (ev.type !== "keyUp") { const stop = await check(); if (stop) return stop; }
      await player.event("Input.dispatchKeyEvent", keyParams(ev));
    }
    return check();
  }

  private player(r: Run): CdpPlayer {
    return new CdpPlayer((method, params) => this.send(r, method, params), { latencyMs: [3, 5], wholeMs: process.platform !== "darwin", random: this.o.model.random, maxInFlight: 8 });
  }

  /** A person's click on a box: a path from the last point (or a start point), a pause, then a press and its hold. */
  private async click(r: Run, box: Box): Promise<void> {
    const person = this.o.model.person(r.scope), random = this.o.model.random, player = this.player(r);
    const to = spreadPoint(box, person, random);
    const from = r.last ?? startPoint(r.viewport.width, r.viewport.height, random);
    const plan = planPath(from, to, Math.max(1, box.w), person, random);
    await player.moves(plan.samples);
    await sleep(pauseMs(person, random));
    const at = { x: to.x, y: to.y, button: "left", clickCount: 1 };
    await player.event("Input.dispatchMouseEvent", { type: "mousePressed", ...at, buttons: 1, force: 0.5 });
    await sleep(holdMs(person, random));
    await player.event("Input.dispatchMouseEvent", { type: "mouseReleased", ...at, buttons: 0 });
    r.last = to;
  }

  private async pressEnter(r: Run): Promise<void> {
    const person = this.o.model.person(r.scope), random = this.o.model.random, player = this.player(r);
    const k = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers: 0 };
    r.navAt = null;
    await player.event("Input.dispatchKeyEvent", { type: "keyDown", ...k, text: "\r", unmodifiedText: "\r" });
    await sleep(holdMs(person, random));
    await player.event("Input.dispatchKeyEvent", { type: "keyUp", ...k });
  }

  /**
   * The outcome (C11): at most 30 s after the submit. Signed in: the main frame commits a new page or its URL changes, and
   * after 1 s with no navigation it has no visible password field (and its host is on the scope's list). Not accepted, a
   * second factor, a host on no list, else a timeout.
   */
  private async outcome(r: Run): Promise<ActResult> {
    const end = performance.now() + this.limits.outcomeMs;
    while (performance.now() < end) {
      if (r.lost) return "lost";
      if (r.popupUnguarded) return "popup";
      if (r.popupFailed) return "window";
      if (r.navAt !== null && performance.now() - r.navAt >= this.limits.settleMs) {
        const read = await this.evaluate<PageRead>(r, call(READ_PAGE)).catch(() => null);
        if (read && r.navAt !== null && performance.now() - r.navAt >= this.limits.settleMs) return outcomeOf(read, this.o.model.entries(r.scope) ?? []);
      }
      await sleep(50);
    }
    return "timeout";
  }

  /**
   * The clean end, in C11's order, also after a refusal in the middle of the act: (1) the inputs of the main frame are
   * empty; (2) only after a sign-in, the leak check and then the move; (3) the tab's history is cleared; (4) Fetch is off,
   * and act_end closes each tab of the act and then removes the act's rules (the service never closes the act window
   * itself). The values' buffers are zeros after it (signIn). It answers the act's result, `leak` or `move` after a sign-in.
   */
  private async cleanEnd(r: Run, result: ActResult): Promise<ActResult> {
    if (r.tab !== null && r.frame !== null && !r.lost) {
      await this.evaluate(r, call(EMPTY_INPUTS)).catch(() => {});
      if (result === "signed_in") result = await this.leakAndMove(r).catch(() => "move" as const);
      await this.send(r, "Page.resetNavigationHistory").catch(() => {});
      await this.send(r, "Fetch.disable").catch(() => {});
    }
    // act_end, once more after 500 ms when it fails (review-124 N3); then the next act window or the receiver's start ends the act.
    for (let tryNo = 1; tryNo <= 2; tryNo++) {
      try { await this.ask("act_end", {}); break; } catch (e) {
        if (tryNo === 1) { await sleep(500); continue; }
        this.o.log(`sign-in: act_end failed twice (${(e as Error).message === "timeout" ? "timeout" : "the receiver's answer"}); the next act window or the receiver's start ends the act`);
      }
    }
    return result;
  }

  /** The leak check, then the move through stage 1c's import path (C2, the box's rule, C4's import). */
  private async leakAndMove(r: Run): Promise<ActResult> {
    const host = new URL(r.record.origin).hostname;
    const a = await this.ask("act_cookies", { tab: r.tab, domain: host });
    const cookies = Array.isArray(a?.cookies) ? (a.cookies as C2Cookie[]) : [];
    const ls = await this.evaluate<{ origin: string; items: Record<string, string> | null }>(r, call(READ_LOCAL)).catch(() => null);
    // The origin's localStorage, read only when the page is on the credential's origin (else the move holds none of it).
    const local = ls && ls.origin === r.record.origin && ls.items ? ls.items : {};
    if (leaks(cookies, local, r.password)) return "leak";
    return (await this.o.move.move(movePayload(r.record.origin, cookies, local))) ? "signed_in" : "move";
  }

  // ---------------------------------------------------------------- the act tab's events

  private onEvent(r: Run, ev: Record<string, any>): void {
    switch (ev.ev) {
      case "debugger.onEvent": {
        const tab = ev.source?.tabId;
        if (ev.source?.sessionId || !(tab === r.tab || r.popups.has(tab))) return;
        this.onCdp(r, tab, String(ev.method), ev.params ?? {});
        return;
      }
      case "debugger.onDetach": if (ev.source?.tabId === r.tab) r.lost = true; return;
      case "tabs.onRemoved": if (ev.tabId === r.tab) r.lost = true; r.popups.delete(ev.tabId); r.actTabs.delete(ev.tabId); return;
      case "tabs.onReplaced":
        if (ev.removedTabId === r.tab) r.lost = true;
        // The added tab of an act popup is an act popup (C10).
        else if (r.popups.has(ev.removedTabId)) this.onPopup(r, ev.addedTabId, null);
        return;
      case "webNavigation.onCreatedNavigationTarget":
        // A popup of a tab of the act (C10: the receiver's own rule for an act popup).
        if (r.actTabs.has(ev.details?.sourceTabId)) this.onPopup(r, ev.details?.tabId, null);
        return;
      case "tabs.onCreated": {
        // An incognito tab whose opener is a tab of the act. Another incognito tab (the operator's private window) is no
        // act popup: the act moves nothing of it (review-124 B4).
        const t = ev.tab;
        if (t?.incognito === true && Number.isInteger(t.openerTabId) && r.actTabs.has(t.openerTabId)) this.onPopup(r, t.id, Number.isInteger(t.windowId) ? t.windowId : null);
        return;
      }
      case "bridge.tooLarge": {
        // A paused request too large for the link: the guard cannot read it, so it fails (never continued unread).
        const tab = ev.tabId;
        if ((tab === r.tab || r.popups.has(tab)) && ev.of === "debugger.onEvent" && ev.method === "Fetch.requestPaused" && typeof ev.requestId === "string") {
          r.guarded++;
          void this.sendTo(tab, "Fetch.failRequest", { requestId: ev.requestId, errorReason: "BlockedByClient" }).catch(() => {});
        }
        return;
      }
    }
  }

  private sendTo(tabId: number, method: string, params: Record<string, unknown> = {}): Promise<any> {
    return this.o.model.call("debugger.sendCommand", [{ tabId }, method, params], { wait: this.limits.cdpMs });
  }

  private onCdp(r: Run, tab: number, method: string, p: any): void {
    const own = tab === r.tab;
    switch (method) {
      case "Page.frameNavigated": if (own && !p.frame?.parentId) r.navAt = performance.now(); return;
      case "Page.navigatedWithinDocument": if (own && p.frameId === r.frame) r.navAt = performance.now(); return;
      case "Page.loadEventFired": if (own) r.loads++; return;
      case "Network.webSocketCreated": if (own && typeof p.requestId === "string" && typeof p.url === "string") r.sockets.set(`ws ${p.requestId}`, p.url); return;
      case "Network.webSocketClosed": if (own) r.sockets.delete(`ws ${p.requestId}`); return;
      case "Network.webTransportCreated": if (own && typeof p.transportId === "string" && typeof p.url === "string") r.sockets.set(`wt ${p.transportId}`, p.url); return;
      case "Network.webTransportClosed": if (own) r.sockets.delete(`wt ${p.transportId}`); return;
      case "Network.loadingFailed":
        // The block's stops and the list rules' (in the act tab and in each act popup that the act's session holds): a
        // request that Chrome blocked for an extension and that the guard did not fail (review-124 N9).
        if (/ERR_BLOCKED_BY_CLIENT/.test(String(p.errorText)) && !r.guardedIds.has(`${tab} ${p.requestId}`)) r.blocked++;
        return;
      case "Fetch.requestPaused": {
        const id = p.requestId;
        if (typeof id !== "string") return;
        const decision = guardDecision(p.request ?? { url: "" }, r.record.send_to, r.password);
        if (decision === "fail") {
          r.guarded++;
          if (typeof p.networkId === "string") r.guardedIds.add(`${tab} ${p.networkId}`);
          void this.sendTo(tab, "Fetch.failRequest", { requestId: id, errorReason: "BlockedByClient" }).catch(() => {});
        } else void this.sendTo(tab, "Fetch.continueRequest", { requestId: id }).catch(() => {});
        return;
      }
    }
  }

  /**
   * An act popup (review-124 B2 to B4): the act's own session on it with the guard (Fetch for every URL at the request
   * stage, as in the act tab) and Network (its blocked requests count); before the act's last key it ends the act
   * (`popup`), so no key goes after the service learns of it; in a window of its own, its X window moves outside the
   * screen by a title marker of its own, and a window whose place is not outside within 2 s ends the act (`window`).
   */
  private onPopup(r: Run, tabId: unknown, windowId: number | null): void {
    if (!Number.isInteger(tabId) || r.popups.has(tabId as number) || tabId === r.tab) {
      if (Number.isInteger(tabId) && windowId !== null && r.popups.get(tabId as number)?.window === null) this.popupWindow(r, tabId as number, windowId);
      return;
    }
    const id = tabId as number;
    this.o.model.hide(id);
    r.actTabs.add(id);
    r.popups.set(id, { window: null });
    if (!r.lastKey) r.popupEarly = true;
    void (async () => {
      try {
        await this.o.model.call("debugger.attach", [id]);
        await this.sendTo(id, "Network.enable");
        await this.sendTo(id, "Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
      } catch {
        // A popup with no guard ends the act, also after the password's last key (review-124b note d: fail closed). A popup
        // that closed meanwhile ends nothing.
        if (r.popups.has(id)) r.popupUnguarded = true;
      }
    })();
    if (windowId !== null) this.popupWindow(r, id, windowId);
    else void this.o.model.call("tabs.get", [id]).then((t: any) => { if (Number.isInteger(t?.windowId)) this.popupWindow(r, id, t.windowId); }, () => {});
  }

  private popupWindow(r: Run, tabId: number, windowId: number): void {
    const p = r.popups.get(tabId);
    if (!p) return;
    p.window = windowId;
    if (windowId === r.window) return;
    void this.movePopup(r, tabId, windowId);
  }

  /** An act popup's window: its own title marker, the X move by it, and the place read back within 2 s, else the act ends (`window`). */
  private async movePopup(r: Run, tabId: number, windowId: number): Promise<void> {
    const screen = this.o.screen.size();
    const marker = `aw-act-${randomBytes(8).toString("hex")}`;
    const end = performance.now() + this.limits.popupMs;
    while (performance.now() < end && r.popups.has(tabId)) {
      // A read that fails is no proof of a close: only tabs.onRemoved takes the popup out (review-124b note b).
      const w = await this.o.model.call("windows.get", [windowId]).catch(() => null);
      if (w && screen && outsideScreen(w, screen)) return;
      // The marker in the popup's current document (a new document of the popup takes it again at the next turn).
      const tree = await this.sendTo(tabId, "Page.getFrameTree").catch(() => null);
      const frame = tree?.frameTree?.frame?.id;
      if (w && frame) {
        const world = await this.sendTo(tabId, "Page.createIsolatedWorld", { frameId: frame, worldName: `aw-act-${randomBytes(4).toString("hex")}`, grantUniversalAccess: false }).catch(() => null);
        if (Number.isInteger(world?.executionContextId)) await this.sendTo(tabId, "Runtime.evaluate", { expression: call(MARK_TITLE, marker), contextId: world.executionContextId, returnByValue: true }).catch(() => null);
        await this.o.screen.moveOff(marker).catch(() => 0);
      }
      await sleep(100);
    }
    if (r.popups.has(tabId)) r.popupFailed = true;
  }

}
