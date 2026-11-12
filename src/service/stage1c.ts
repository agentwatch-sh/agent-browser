// Stage 1c of the self-contained agent browser (board ab-v16.94.4; the design
// docs/superpowers/specs/2026-11-09-self-contained-agent-browser-design.md, sections 5.1, 5.6, 7.4, 7.5 and 13.2;
// contract C12, docs/contracts/C12.md): the browser logic that moves from agentwatch's daemon into `agent-browser
// service`. The lists and their host rules (lists/), the scopes and the file of ended scopes (lists/scopes.ts), the set_scopes
// push and the model's allowlist line, the list copy of each scope (lists/copies.ts), the blocked-site prompts and their
// dismissals (prompts/), the sign-in import (signin/), launch_check, and the parts of the status texts that need them.
//
// It talks to the receiver and the model through the receiver port (receiver.ts): stage 1b part 2 (board ab-v16.94.9)
// puts the port on the real native link. Its ops are C12's `launch_check`, `list_set`, `prompt_allow`,
// `prompt_dismiss`, `import`, `lists_get` and `prompts_get`; it also takes `set_sessions` and `session_ended` after
// stage 1a, and adds `sessions`, `lists` and `prompts` to `status`.
//
// The push (C4): the newest object goes to the receiver at each link up, at each change of a list or of the sessions,
// and when a prune frees a name; one push at a time. Only an ok in time (the port's wait of 10 s) confirms it: then the
// book prunes, and the allowlist line goes to the model on the same link. With no ok, the push goes again every 10 s.
//
// The log rule (C12): no log line holds a page, a cookie, a URL path, a payload, an entry of a list change or a
// lifetime id. A line names a list, a host of a blocked report, a sign-in's domain and counts.

import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";
import { ERR, type Answer, type Req } from "./control.ts";
import type { ServicePart } from "./part.ts";
import { NO_RECEIVER, ReceiverError, type ReceiverPort } from "./receiver.ts";
import { errorKind, own } from "./lists/files.ts";
import { normalizeRepo, UNREAD_LIST } from "./lists/hosts.ts";
import { ListCopies } from "./lists/copies.ts";
import { ListDamagedError, ListFiles, type ListInfo } from "./lists/lists.ts";
import { EndedFile, ScopeBook, type ScopesBody, type SessionRow, type Ticket } from "./lists/scopes.ts";
import { PromptBook, type Blocked, type PromptEvent, type Recipient, type Target } from "./prompts/prompts.ts";
import { checkPayload, PayloadError, TooLargeError } from "./signin/payload.ts";
import { NOT_CONNECTED_TEXT, RECEIVER_MISSING_TEXT, RECEIVER_WAIT_MS, sendText, TIMEOUT } from "./signin/send-text.ts";

/** The ops that stage 1c adds (C12, "The ops of stage 1a"). */
export const STAGE_1C_OPS = ["launch_check", "list_set", "prompt_allow", "prompt_dismiss", "import", "lists_get", "prompts_get"] as const;
/** C4's waits: an ok to set_scopes counts only in 10 s; an import waits 120 s. */
export const SET_SCOPES_WAIT_MS = 10_000;
export const IMPORT_WAIT_MS = 120_000;
/** An object that the receiver did not confirm goes again this often while the link is up. */
export const PUSH_RETRY_MS = 10_000;

/** launch_check's refusal (today's launch_refusal): the caller is often an agent, so it names no stop or start (I2). */
export const LAUNCH_HELD_TEXT = "A session named {name} ended a moment ago, and the agent browser could not record it ({error}). Choose another name, or wait until the agent browser confirms its lists.";
export const SCOPES_ERROR_TEXT = "the agent extension did not confirm the lists: {error}";
export const LISTS_FOLDER_TEXT = "the folder of the lists cannot be read ({kind}); every list applies as empty";
export const UNREAD_TEXT = "the repo of the session's launch folder cannot be read yet; its list is empty until it can";
/** list_set's errors (C12, the part of stage 1c). */
export const UNREAD_LIST_ERROR = "the list unread-repo is always empty, so it takes no entry";
export const LIST_DAMAGED_ERROR = "the list file of {name} cannot be read, so the service does not change it";
export const LIST_WRITE_ERROR = "the list file of {name} cannot be written: {kind}";
/** prompt_dismiss's error when the dismissals file cannot be written: the prompt stays open. */
export const DISMISS_WRITE_ERROR = "the dismissal cannot be written: {kind}";
/** The agent's note while the receiver is up and has not confirmed the current object (I2: no stop, no start). */
export const AGENT_LISTS_WAIT = "The agent browser's extension has not confirmed the lists yet.";
const promptsNote = (n: number) => (n === 1 ? "1 blocked site waits for your answer on the Browser page." : `${n} blocked sites wait for your answer on the Browser page.`);
const sentence = (t: string) => { const s = t.trim(); return (s[0]?.toUpperCase() ?? "") + s.slice(1) + (/[.!?]$/.test(s) ? "" : "."); };

/** The timers of the part (tests give a fake). `now` is monotonic, in ms. */
export type Clock = { now(): number; setTimeout(f: () => void, ms: number): unknown; clearTimeout(h: unknown): void };
export const REAL_CLOCK: Clock = {
  now: () => performance.now(),
  setTimeout: (f, ms) => { const t = setTimeout(f, ms); t.unref(); return t; },
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

export type Stage1cOptions = {
  /** CONFIG_DIR/browser/lists (--lists-folder): today's lists; the old single list is allowlist.json next to it. */
  listsFolder: string;
  /** The agent browser's state folder (--state-folder): ended-scopes.json, session-lists/ and prompt-dismissals.json. */
  stateFolder: string;
  receiver?: ReceiverPort;
  log: (line: string) => void;
  clock?: Clock;
  /** The wall clock in seconds (the dismissals). */
  wall?: () => number;
  /** Tests only: the writer of the file of ended scopes (a disk that fails). */
  writeEnded?: (path: string, value: unknown) => void;
  /**
   * The start at a use (board ab-v16.94.11): an import needs the browser, so each one calls it before its wait for the
   * receiver (the service starts Chrome when it does not run). Its answer is null, or the text of a start that failed,
   * which the import answers at once.
   */
  wake?: () => Promise<string | null>;
};

type C12Session = { scope: string; repo: string | null; roots: { pid: number; start: number }[]; cgroup: string | null; lifetime_id: string | null; mcp_token?: string | null };
type ListView = { name: string; repo: string | null; allow: string[]; sessions: string[]; error: string };

export class Stage1c implements ServicePart {
  readonly ops: Readonly<Record<string, (req: Req) => Answer | Promise<Answer>>>;
  readonly files: ListFiles;
  readonly book: ScopeBook;
  readonly prompts: PromptBook;
  readonly copies: ListCopies;
  private readonly receiver: ReceiverPort;
  private readonly log: (line: string) => void;
  private readonly clock: Clock;
  private emitEv: (ev: Record<string, unknown>) => void = () => {};
  private sessions: C12Session[] = [];
  private box: { hosts: string[]; cookie_names: string[] } | null = null;
  private stopped = false;
  // The push (C4).
  private hello = 0;
  /** The object that the receiver of this link confirmed in time; a push on its way and a new link's push clear it. */
  private confirmedBody: ScopesBody | null = null;
  private sentBody: ScopesBody | null = null;
  private lineRoots: string | null = null;
  private wanted = false;
  private running: Promise<void> | null = null;
  private lastPushAt: number | null = null;
  private retry: unknown = null;
  private scopesError = "";
  private pruneRetrying = false;
  /** The last copy that this process wrote of each scope (its hosts as JSON). */
  private readonly written = new Map<string, string>();
  // The import.
  private imports: Promise<unknown> = Promise.resolve();
  private readonly upWaiters = new Set<() => void>();
  /** The start at a use of a send (board ab-v16.94.11). */
  private readonly startAtUse: () => Promise<string | null>;

  constructor(o: Stage1cOptions) {
    this.log = o.log;
    this.startAtUse = o.wake ?? (async () => null);
    this.clock = o.clock ?? REAL_CLOCK;
    this.receiver = o.receiver ?? NO_RECEIVER;
    this.files = new ListFiles(o.listsFolder);
    this.book = new ScopeBook(new EndedFile(join(o.stateFolder, "ended-scopes.json"), { write: o.writeEnded }), (name) => this.files.read(name), o.log);
    this.copies = new ListCopies(o.stateFolder, o.log);
    this.prompts = new PromptBook({ file: join(o.stateFolder, "prompt-dismissals.json"), now: () => this.clock.now(), wall: o.wall ?? (() => Date.now() / 1000), log: o.log });
    this.ops = {
      launch_check: (req) => this.launchCheck(req.scope as string),
      list_set: (req) => this.listSet(req.list as string, req.add as string[], req.remove as string[]),
      prompt_allow: (req) => this.promptAllow(req.prompt as string, req.host as string, req.list as string),
      prompt_dismiss: (req) => this.promptDismiss(req.prompt as string),
      import: (req) => this.importSignIn(req),
      lists_get: () => ({ data: { lists: this.listsView().lists, old_allow: this.files.oldAllow() } }),
      prompts_get: () => ({ data: { prompts: this.prompts.views() } }),
    };
    this.receiver.attach({ up: () => this.onUp(), down: () => this.onDown(), blocked: (b) => this.onBlocked(b) });
  }

  attach(emit: (ev: Record<string, unknown>) => void): void { this.emitEv = emit; }

  private emit(evs: PromptEvent[]): void { for (const ev of evs) this.emitEv(ev); }

  stop(): void {
    this.stopped = true;
    if (this.retry !== null) { this.clock.clearTimeout(this.retry); this.retry = null; }
    for (const w of [...this.upWaiters]) w();
  }

  // ------------------------------------------------------------------ the sessions

  setSessions(req: Req): void {
    const sessions = req.sessions as C12Session[];
    this.sessions = sessions.map((s) => ({ ...s, roots: s.roots.map((r) => ({ pid: r.pid, start: r.start })) }));
    const box = req.box as { hosts: string[]; cookie_names: string[] };
    this.box = { hosts: [...box.hosts], cookie_names: [...box.cookie_names] };
    this.book.setSessions(this.sessions.map(toRow));
    if (this.receiver.isUp()) {
      const t = this.book.ticket();
      if (t !== null && !isDeepStrictEqual(t.body, this.sentBody)) this.wake();
    }
    this.checkRoots();
    this.afterChange();
  }

  /**
   * The end of a scope: the file first (the book writes it), then end_scope to the model (unless another live session
   * holds the name), then the push without it; last the scope's list copy goes (not before the first complete read).
   */
  sessionEnded(scope: string): void {
    const held = this.book.shared().has(scope);
    this.book.sessionEnded(scope);
    if (!held) this.receiver.endScope(scope);
    this.sessions = this.sessions.filter((s) => s.scope !== scope);
    this.wake();
    if (!held && this.book.readDone()) { this.copies.remove(scope); this.written.delete(scope); }
    this.emit(this.prompts.revalidate(this.targets()));
  }

  private launchCheck(scope: string): Answer {
    if (!this.book.heldInMemory().has(scope)) return { data: { refusal: null } };
    const error = this.book.holdError() || "the file of ended scopes cannot be written: unknown";
    return { data: { refusal: LAUNCH_HELD_TEXT.replace("{name}", scope).replace("{error}", error) } };
  }

  // ------------------------------------------------------------------ the push of set_scopes and the model's line

  /** The receiver of the current link confirmed the current object in time (for the Chrome unit's fail-closed watch). */
  listsConfirmed(): boolean {
    if (!this.receiver.isUp() || this.confirmedBody === null) return false;
    const t = this.book.ticket();
    return t !== null && isDeepStrictEqual(t.body, this.confirmedBody);
  }

  /** The first complete set_sessions came (else the watch's reason is sessions_unread). */
  sessionsRead(): boolean { return this.book.readDone(); }

  private onUp(): void {
    if (this.stopped) return;
    // A new link: its own push (which starts now, and clears the confirmed object) must get an ok before any line.
    this.hello++;
    this.sentBody = null;
    this.lineRoots = null;
    for (const w of [...this.upWaiters]) w();
    this.wake();
  }

  private onDown(): void {
    if (this.retry !== null) { this.clock.clearTimeout(this.retry); this.retry = null; }
  }

  /** Have the push send the newest object; a wake while a push runs makes it go once more. */
  private wake(): void {
    if (this.stopped) return;
    this.wanted = true;
    if (this.running) return;
    this.running = (async () => {
      // `running` goes in the same step as the last check of `wanted`, so no wake comes between them and is lost.
      try {
        while (this.wanted && !this.stopped) {
          this.wanted = false;
          try { await this.pushOnce(); } catch (e) { this.log(`lists: the lists could not be sent (${(e as Error).name})`); }
        }
      } finally { this.running = null; }
      this.schedule();
    })();
  }

  /**
   * The check every PUSH_RETRY_MS while the link is up (the daemon's watch): it sends the current object again when the
   * receiver has not confirmed it (a refusal, no answer in time, or a list file that changed outside the service), or
   * when a prune waits; else it only looks again later.
   */
  private schedule(): void {
    if (this.retry !== null) { this.clock.clearTimeout(this.retry); this.retry = null; }
    if (this.stopped || !this.receiver.isUp() || !this.book.readDone()) return;
    const wait = Math.max(0, (this.lastPushAt ?? this.clock.now()) + PUSH_RETRY_MS - this.clock.now());
    this.retry = this.clock.setTimeout(() => {
      this.retry = null;
      const confirmed = this.listsConfirmed();
      if (confirmed && !this.book.pruneWaits()) { this.lastPushAt = this.clock.now(); this.schedule(); return; }
      if (confirmed && !this.pruneRetrying) {
        this.pruneRetrying = true;
        this.log(`lists: the prune of the ended names could not be written; the lists go to the receiver again every ${PUSH_RETRY_MS / 1000} s until it can`);
      }
      this.wake();
    }, wait);
  }

  private async pushOnce(): Promise<void> {
    if (!this.receiver.isUp()) return;
    const ticket: Ticket | null = this.book.ticket();
    if (ticket === null) return; // no complete set_sessions yet: no object goes (C4 rule 1)
    const hello = this.hello;
    const again = this.pruneRetrying && isDeepStrictEqual(ticket.body, this.confirmedBody);
    this.confirmedBody = null; // on its way: nothing confirmed
    this.sentBody = ticket.body;
    this.lastPushAt = this.clock.now();
    let data: Record<string, unknown>;
    try { data = await this.receiver.request("set_scopes", { ...ticket.body }, SET_SCOPES_WAIT_MS); }
    catch (e) {
      // ok:false or no answer in time: no line; the retry sends the current object again.
      const text = String((e as Error).message ?? e).slice(0, 300);
      this.scopesError = SCOPES_ERROR_TEXT.replace("{error}", text);
      this.log(`lists: the receiver did not confirm the lists: ${text}`);
      return;
    }
    if (hello !== this.hello || !this.receiver.isUp()) return; // an answer of an earlier link: that link's up pushes again
    this.confirmedBody = ticket.body;
    this.scopesError = "";
    const freed = this.book.confirmed(ticket);
    if (this.pruneRetrying && !this.book.pruneWaits()) { this.pruneRetrying = false; this.log("lists: the prune of the ended names is written"); }
    this.writeLine(ticket.body);
    const count = (k: string) => (Number.isSafeInteger(data?.[k]) ? (data[k] as number) : 0);
    if (!again) this.log(`lists: the receiver took the lists of ${Object.keys(ticket.body.scopes).length} scopes (${count("closed")} tabs closed)`);
    if (count("refused")) this.log(`lists: the receiver refused ${count("refused")} entries of the lists`);
    if (freed) this.wanted = true;
    else {
      const now = this.book.ticket();
      if (now !== null && !isDeepStrictEqual(now.body, ticket.body)) this.wanted = true;
    }
    this.afterChange();
  }

  /** The model's allowlist line of the confirmed body, with each session's roots (the service runs the peer check). */
  private writeLine(body: ScopesBody): void {
    const line = this.book.line(body, true);
    this.receiver.allowlist(line);
    this.lineRoots = JSON.stringify(line.roots);
  }

  /** A root change: write the last confirmed object with the new roots at once, but only after an ok in time on this link, and while it is up. */
  private checkRoots(): void {
    if (this.confirmedBody === null || !this.receiver.isUp()) return;
    if (JSON.stringify(this.book.line({ lists: {}, scopes: {}, default: null, operator: "*" }, true).roots) !== this.lineRoots) this.writeLine(this.confirmedBody);
  }

  // ------------------------------------------------------------------ the lists

  /** After a change of the lists or the sessions: each named scope's list copy, and each open prompt again. */
  private afterChange(): void {
    this.syncCopies();
    this.emit(this.prompts.revalidate(this.targets()));
  }

  /** Write the list copy of each scope that the current object names with a list that has a file, when it changed. */
  private syncCopies(): void {
    const t = this.book.ticket();
    if (t === null) return;
    // A copy that the service wrote goes when its scope leaves the object or its list has no file any more: the CLI
    // then refuses the session, as for a list with no site, and never reads an old list's hosts (review-102 note 5).
    for (const scope of [...this.written.keys()]) {
      const name = own(t.body.scopes, scope);
      if (name === undefined || name === null || name === UNREAD_LIST || !this.files.exists(name)) { this.copies.remove(scope); this.written.delete(scope); }
    }
    for (const [scope, name] of Object.entries(t.body.scopes)) {
      // A list with no file has no copy: agent-browser's CLI refuses a session whose list has no site yet.
      if (name === null || name === UNREAD_LIST || !this.files.exists(name)) continue;
      const info = this.files.read(name);
      const text = JSON.stringify(info.hosts);
      if (this.written.get(scope) === text) continue;
      if (this.copies.write(scope, info.hosts)) this.written.set(scope, text);
    }
  }

  private repoHint(name: string): string | null {
    for (const [scope, row] of this.book.rows()) if (this.book.listOf(scope) === name && row.repoKnown && row.repo !== null) return normalizeRepo(row.repo);
    return null;
  }

  private listSet(name: string, add: string[], remove: string[]): Answer {
    if (name === UNREAD_LIST) return { error: UNREAD_LIST_ERROR };
    let r: { allow: string[]; refused: { entry: string; reason: string }[] };
    try { r = this.files.change(name, add, remove, this.repoHint(name)); }
    catch (e) {
      if (e instanceof ListDamagedError) return { error: LIST_DAMAGED_ERROR.replace("{name}", name) };
      this.log(`lists: list ${name} cannot be written (${errorKind(e)})`);
      return { error: LIST_WRITE_ERROR.replace("{name}", name).replace("{kind}", errorKind(e)) };
    }
    this.log(`lists: list ${name} changed: ${r.allow.length} entries, ${r.refused.length} refused`);
    this.wake();
    this.afterChange();
    return { data: { allow: r.allow, refused: r.refused } };
  }

  /** The lists: each list that has a file and each list that a live session uses, and the folder's error (or ""). */
  private listsView(): { lists: ListView[]; folderError: string } {
    let infos = new Map<string, ListInfo>();
    let folderError = "";
    try { infos = new Map(this.files.loadAll().map((i) => [i.name, i])); }
    catch (e) { folderError = LISTS_FOLDER_TEXT.replace("{kind}", errorKind(e)); }
    const users = new Map<string, string[]>();
    const repos = new Map<string, string | null>();
    for (const [scope, row] of this.book.rows()) {
      const name = this.book.listOf(scope)!;
      users.set(name, [...(users.get(name) ?? []), scope]);
      if (!repos.has(name)) repos.set(name, row.repoKnown ? normalizeRepo(row.repo) : null);
    }
    const out: ListView[] = [];
    for (const name of [...new Set([...infos.keys(), ...users.keys()])].sort()) {
      if (name === UNREAD_LIST) {
        if (users.has(name)) out.push({ name, repo: null, allow: [], sessions: [...users.get(name)!].sort(), error: UNREAD_TEXT });
        continue;
      }
      const info = infos.get(name) ?? this.files.read(name);
      out.push({ name, repo: info.repo ?? repos.get(name) ?? null, allow: [...info.hosts], sessions: [...(users.get(name) ?? [])].sort(), error: info.error });
    }
    return { lists: out, folderError };
  }

  // ------------------------------------------------------------------ the prompts

  /** A scope's list now: the list that the current object gives it (null: none, also the always empty unread-repo). */
  private targets(): (scope: string) => Target | null {
    const t = this.book.ticket();
    const rows = this.book.rows();
    return (scope) => {
      if (t === null) return null;
      const name = own(t.body.scopes, scope);
      const row = rows.get(scope);
      if (typeof name !== "string" || name === UNREAD_LIST || row === undefined) return null;
      return { name, repo: row.repoKnown ? normalizeRepo(row.repo) : null, hosts: own(t.body.lists, name) ?? [] };
    };
  }

  /** The session of `scope` in the set_sessions in force now, with the lifetime id of that run (one session only). */
  private recipientOf = (scope: string): Recipient | null => {
    const ss = this.sessions.filter((s) => s.scope === scope);
    return ss.length === 1 ? { session: scope, lifetime_id: ss[0].lifetime_id } : null;
  };

  private onBlocked(b: Blocked): void {
    if (this.stopped || b === null || typeof b !== "object") return;
    this.emit(this.prompts.blocked({ host: b.host, scope: typeof b.scope === "string" ? b.scope : null, from: typeof b.from === "string" ? b.from : null }, this.targets(), this.recipientOf));
  }

  private promptAllow(id: string, host: string, list: string): Answer {
    this.emit(this.prompts.revalidate(this.targets()));
    const p = this.prompts.find(id);
    if (p === undefined || p.host !== host || p.list !== list) return { error: ERR.gone };
    const a = this.listSet(p.list, [p.host], []);
    if ("error" in a) return a;
    this.emit(this.prompts.close(id));
    return a;
  }

  private promptDismiss(id: string): Answer {
    this.emit(this.prompts.revalidate(this.targets()));
    if (this.prompts.find(id) === undefined) return { error: ERR.gone };
    try { this.emit(this.prompts.dismiss(id)); }
    catch (e) { return { error: DISMISS_WRITE_ERROR.replace("{kind}", errorKind(e)) }; }
    return { data: {} };
  }

  // ------------------------------------------------------------------ the sign-in import (C2 to C6)

  /** Wait at most `ms` for a receiver that is up; true when one is. */
  private waitUp(ms: number): Promise<boolean> {
    if (this.receiver.isUp()) return Promise.resolve(true);
    if (this.stopped) return Promise.resolve(false);
    return new Promise((resolve) => {
      const done = () => { this.upWaiters.delete(done); this.clock.clearTimeout(timer); resolve(this.receiver.isUp()); };
      const timer = this.clock.setTimeout(done, ms);
      this.upWaiters.add(done);
    });
  }

  /**
   * C12's import: the payload check (C2) and the box's own sign-in rule with set_sessions' box, then C4's import to the
   * receiver, one at a time. The payload stays in memory; no log line holds it. A failure after the domain is known
   * answers the Browser pane's text of the send.
   */
  private importSignIn(req: Req): Promise<Answer> | Answer {
    let checked;
    try { checked = checkPayload(req.payload, this.box?.hosts ?? null, this.box?.cookie_names ?? []); }
    catch (e) {
      if (e instanceof PayloadError || e instanceof TooLargeError) return { error: e.message };
      throw e;
    }
    const { state, dropped } = checked;
    const run = async (): Promise<Answer> => {
      // A send needs the browser: a use, which starts Chrome when it does not run (board ab-v16.94.11); a start that
      // failed gives the send its error at once.
      const failed = await this.startAtUse().catch(() => null);
      if (failed !== null) return { error: sendText(state.domain, failed).text };
      if (!(await this.waitUp(RECEIVER_WAIT_MS))) return { error: sendText(state.domain, this.stopped ? NOT_CONNECTED_TEXT : RECEIVER_MISSING_TEXT).text };
      let counts: Record<string, unknown>;
      try { counts = await this.receiver.request("import", { state }, IMPORT_WAIT_MS); }
      catch (e) {
        const why = e instanceof ReceiverError ? (e.kind === "refused" ? e.message : e.kind === "down" ? NOT_CONNECTED_TEXT : TIMEOUT) : TIMEOUT;
        this.log(`signin: the sign-in for ${state.domain} was not imported (${e instanceof ReceiverError ? e.kind : "error"})`);
        return { error: sendText(state.domain, why).text };
      }
      const n = (k: string) => (Number.isSafeInteger(counts?.[k]) ? (counts[k] as number) : 0);
      const errors = Array.isArray(counts?.errors) ? counts.errors.length : 0;
      this.log(`signin: imported a sign-in for ${state.domain}: ${n("cookies_set")} cookies set, ${dropped} box cookies dropped, ${n("local") + n("session")} storage keys, ${n("idb_databases")} databases, ${n("cache_entries")} cache entries, ${errors} problems`);
      if (errors) this.emitEv({ t: "ev", ev: "error", op: "import", user: (req.by as { user: string }).user, domain: state.domain, counts: { errors } });
      return { data: counts };
    };
    const p = this.imports.then(run, run);
    this.imports = p.catch(() => {});
    return p;
  }

  /**
   * What the start at a use (board ab-v16.94.11) checks while Chrome is down, from the current object (the one that the
   * receiver gets next): whether it names the scope, the scope's list (or null), and that list's number of sites.
   */
  useView(scope: string): { named: boolean; list: string | null; sites: number } {
    const t = this.book.ticket();
    if (t === null || !Object.hasOwn(t.body.scopes, scope)) return { named: false, list: null, sites: 0 };
    // A list that the object names but does not hold is no list (C11, step 7).
    const named = own(t.body.scopes, scope) ?? null;
    const list = named !== null && Object.hasOwn(t.body.lists, named) ? named : null;
    return { named: true, list, sites: list === null ? 0 : t.body.lists[list].length };
  }

  // ------------------------------------------------------------------ status

  status(): Record<string, unknown> {
    const t = this.book.ticket();
    return {
      // mcp_token: whether the session's item has a fingerprint (C12, the token design); never the fingerprint.
      sessions: this.sessions.map((s) => ({ scope: s.scope, repo: s.repo, list: (t !== null ? own(t.body.scopes, s.scope) : null) ?? null, mcp_token: (s.mcp_token ?? null) !== null })),
      lists: this.listsView().lists.map((l) => l.name),
      prompts: this.prompts.views(),
    };
  }

  notes(): { agent: string[]; operator: string[] } {
    const agent: string[] = [];
    if (this.receiver.isUp() && this.book.readDone() && !this.listsConfirmed()) agent.push(AGENT_LISTS_WAIT);
    const operator: string[] = [];
    const { folderError } = this.listsView();
    for (const e of [...this.book.errors(), folderError, this.scopesError]) if (e) operator.push(sentence(e));
    const n = this.prompts.views().length;
    if (n) operator.push(promptsNote(n));
    return { agent, operator };
  }
}

/** A session of C12's set_sessions as a row of the book: a repo string that is not an owner/repo is a repo not read yet. */
function toRow(s: C12Session): SessionRow {
  const repo = s.repo === null ? null : normalizeRepo(s.repo);
  return { scope: s.scope, repo, repoKnown: s.repo === null || repo !== null, roots: s.roots };
}
