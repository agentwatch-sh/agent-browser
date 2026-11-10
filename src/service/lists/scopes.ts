// The scope book (stage 1c of the self-contained agent browser, board ab-v16.94.4; the design, sections 5.1 and 7.4):
// the port of agentwatch's daemon/browser/scopes.py. The book turns the sessions of the last set_sessions (C12), the
// per-repo lists (lists.ts) and the ended names into the receiver's set_scopes object (C4) and the model's allowlist
// line with each session's roots (C10, C11). It keeps C4's rules 1 and 2 of "the tabs of a session that ended":
//
// - Rule 1: the first object waits for the first complete set_sessions; then it names every live session's launch
//   scope with its repo's list, also when that list is empty, except a scope that rule 2 keeps out. Zero sessions give
//   empty objects.
// - Rule 2: a scope that ended stays out of at least one set_scopes that the receiver answered ok in time before any
//   object names it again. The book keeps that with the file of ended scopes (written first, in one step; pruned only
//   by an ok in time of an object sent after the write, by the sequence number of each end) and the restart gate
//   (after a service start no launch's scope and no name of the file enters an object until the first object gets an
//   ok in time).
//
// The service sends `default` null (C4's choice 5 a), so rule 3 (the test browser's default list) is not here. Two live
// sessions with one launch scope both stay out, and a name that is no scope is never named. The book is pure: the list
// reader and the file's writer are given, nothing waits, and the state is memory plus the file.

import { readFileSync } from "node:fs";
import type { ListInfo } from "./lists.ts";
import { listNameFor, normalizeRepo, SCOPE, UNREAD_LIST } from "./hosts.ts";
import { errorKind, parseJsonBytes, writeJson } from "./files.ts";

/** set_scopes's `operator`: the operator's own tabs open any site (C4, choice 3). */
export const OPERATOR = "*";
/** The key of the names in the file of ended scopes. */
export const ENDED_KEY = "ended";
/** The largest integer that JavaScript holds exactly: the bound of a root's pid and start (C11). */
const MAX_SAFE = 2 ** 53 - 1;

export const READ_ERROR = "the file of ended scopes cannot be read ({kind}); the tabs of every live session close once";
export const WRITE_ERROR = "the file of ended scopes cannot be written: {kind}";
export const SHARED_ERROR = "two live sessions have the launch name {scope}: neither gets a list";

/** A session's pane process: its pid and its start time (C11). */
export type Root = { readonly pid: number; readonly start: number };
/** One live session: its launch scope, its repo (null: no-repo) and its roots; `repoKnown` false: its list is UNREAD_LIST. */
export type SessionRow = { readonly scope: string; readonly repo: string | null; readonly repoKnown: boolean; readonly roots: readonly Root[] };
/** The set_scopes object (C4). */
export type ScopesBody = { lists: Record<string, string[]>; scopes: Record<string, string | null>; default: null; operator: string };
/** The model's allowlist line (C10): the confirmed object with its tag, and with the peer check each session's roots. */
export type AllowlistLine = ScopesBody & { t: "allowlist"; roots?: Record<string, Root[]> };
/** A set_scopes object, and the sequence number of the last end that it knows. */
export type Ticket = { body: ScopesBody; seq: number };

const isScope = (name: unknown): name is string => typeof name === "string" && SCOPE.test(name);
const rootOk = (r: Root) => Number.isSafeInteger(r.pid) && Number.isSafeInteger(r.start) && r.pid >= 2 && r.pid <= MAX_SAFE && r.start >= 0 && r.start <= MAX_SAFE;
/** The list of the row's repo (lowercase; a repo of another shape counts as no repo), or UNREAD_LIST while its repo is not known. */
const listOfRow = (row: SessionRow) => (row.repoKnown ? listNameFor(normalizeRepo(row.repo)) : UNREAD_LIST);

/** The file of ended scopes (C4 rule 2): `{"ended":[<scope>...]}`, mode 0600, replaced in one step. */
export class EndedFile {
  readonly path: string;
  private readonly writer: (path: string, value: unknown) => void;

  constructor(path: string, o: { write?: (path: string, value: unknown) => void } = {}) {
    this.path = path;
    this.writer = o.write ?? writeJson;
  }

  /** The names of the file and "", or no names and the error text (a missing file holds no name). */
  read(): { names: Set<string>; error: string } {
    let bytes: Buffer;
    try { bytes = readFileSync(this.path); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return { names: new Set(), error: "" };
      return { names: new Set(), error: READ_ERROR.replace("{kind}", errorKind(e)) };
    }
    let data: any;
    try { data = parseJsonBytes(bytes); } catch { return { names: new Set(), error: READ_ERROR.replace("{kind}", "damaged") }; }
    const names = data !== null && typeof data === "object" && !Array.isArray(data) ? data[ENDED_KEY] : null;
    if (!Array.isArray(names) || !names.every(isScope)) return { names: new Set(), error: READ_ERROR.replace("{kind}", "damaged") };
    return { names: new Set(names), error: "" };
  }

  /** Replace the file with `names` (sorted, each once); "" or the error text. */
  write(names: Iterable<string>): string {
    try { this.writer(this.path, { [ENDED_KEY]: [...new Set(names)].sort() }); return ""; }
    catch (e) { return WRITE_ERROR.replace("{kind}", errorKind(e)); }
  }
}

export class ScopeBook {
  private readonly file: EndedFile;
  private readonly readList: (name: string) => ListInfo;
  private readonly log: (line: string) => void;
  private rowsNow: SessionRow[] = [];
  private readDoneNow = false;
  private gateOpen = false;
  private seen = new Set<string>();
  private launches = new Set<string>();
  private seq = 0;
  /** Each ended name with the sequence number of its last end; the names of the file at the start have 0. */
  private ended = new Map<string, number>();
  private writeError = "";
  private pruneWaitsNow = false;
  /** The file could not be read at the start: the first complete read counts every live scope as a name of the file. */
  readonly poisoned: boolean;
  private readError: string;
  /** The file does not hold the names of memory: the next set_sessions or confirmed writes it again. */
  private dirty: boolean;
  private onDisk: Set<string>;

  constructor(file: EndedFile, readList: (name: string) => ListInfo, log: (line: string) => void = () => {}) {
    this.file = file;
    this.readList = readList;
    this.log = log;
    const { names, error } = file.read();
    this.poisoned = error !== "";
    this.readError = error;
    this.dirty = error !== "";
    this.onDisk = names;
    for (const n of names) this.ended.set(n, 0);
    if (error) log(`lists: ${error}`);
  }

  private scopeCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const r of this.rowsNow) if (isScope(r.scope)) counts.set(r.scope, (counts.get(r.scope) ?? 0) + 1);
    return counts;
  }

  /** True after the first complete set_sessions (the first object waits for it). */
  readDone(): boolean { return this.readDoneNow; }

  /**
   * The live sessions; the first call is the first complete read. A scope first seen after that read is a launch: the
   * restart gate keeps it out until the first ok in time. With an unreadable file, the first call counts every live
   * scope as a name of the file and writes the file at once, before any object can go.
   */
  setSessions(rows: readonly SessionRow[]): void {
    this.rowsNow = [...rows];
    const scopes = new Set(rows.map((r) => r.scope));
    if (!this.readDoneNow) {
      this.readDoneNow = true;
      this.seen = new Set(scopes);
      if (this.poisoned) {
        for (const s of scopes) if (isScope(s) && !this.ended.has(s)) this.ended.set(s, this.seq);
        this.write(this.ended.keys());
      }
      return;
    }
    if (!this.gateOpen) {
      for (const s of scopes) if (!this.seen.has(s)) this.launches.add(s);
      for (const s of scopes) this.seen.add(s);
    }
    if (this.dirty) this.write(this.ended.keys());
  }

  /**
   * Record the end of `scope`: the next sequence number, then the file at once; "" or the write error. The name stays in
   * memory either way. The ended session's rows leave the book at once (the next set_sessions puts back the live ones).
   * With a damaged file before the first complete read, the name stays in memory only and the damaged file stays: the
   * first complete read writes every name.
   */
  sessionEnded(scope: string): string {
    if (!isScope(scope)) return "";
    this.seq++;
    this.ended.set(scope, this.seq);
    this.rowsNow = this.rowsNow.filter((r) => r.scope !== scope);
    if (this.poisoned && !this.readDoneNow) return "";
    return this.write(this.ended.keys());
  }

  /**
   * An ok in time for `ticket`: prune each ended name whose last end has a sequence number of at most `ticket.seq`, and
   * open the gate. A prune whose write fails keeps the names, and pruneWaits() is true until an ok in time prunes them.
   * A write that failed before is tried again here. True when a live scope that the book kept out can now be named.
   */
  confirmed(ticket: Ticket): boolean {
    const before = this.named0();
    this.gateOpen = true;
    this.launches.clear();
    const kept = new Map([...this.ended].filter(([, seq]) => seq > ticket.seq));
    const prunes = kept.size !== this.ended.size;
    const written = (prunes || this.dirty) && this.write(kept.keys()) === "";
    if (written) this.ended = kept;
    this.pruneWaitsNow = prunes && !written;
    for (const s of this.named0()) if (!before.has(s)) return true;
    return false;
  }

  /** True after an ok in time whose prune could not be written: only the next ok in time prunes them. */
  pruneWaits(): boolean { return this.pruneWaitsNow; }

  private write(names: Iterable<string>): string {
    const set = new Set(names);
    const error = this.file.write(set);
    if (error) {
      if (error !== this.writeError) this.log(`lists: ${error}`);
      this.writeError = error;
      this.dirty = true;
    } else {
      this.onDisk = set;
      this.writeError = "";
      this.readError = "";
      this.dirty = false;
    }
    return error;
  }

  private named0(): Set<string> {
    const out = new Set<string>();
    for (const [scope, count] of this.scopeCounts()) if (count === 1 && !this.ended.has(scope) && (this.gateOpen || !this.launches.has(scope))) out.add(scope);
    return out;
  }

  /** The set_scopes object of now, or null before the first complete read. Each list that it names is read now. */
  ticket(): Ticket | null {
    if (!this.readDoneNow) return null;
    const rows = this.rows();
    const scopes: Record<string, string | null> = {};
    for (const s of [...this.named0()].sort()) scopes[s] = listOfRow(rows.get(s)!);
    const lists: Record<string, string[]> = {};
    for (const name of [...new Set(Object.values(scopes).filter((v): v is string => v !== null))].sort()) lists[name] = name === UNREAD_LIST ? [] : [...this.readList(name).hosts];
    return { body: { lists, scopes, default: null, operator: OPERATOR }, seq: this.seq };
  }

  /**
   * The model's allowlist line of the confirmed `body` (C10). Every ended name leaves `scopes`, also when `body` is from
   * before the end: the model keeps its own ended set in memory only, so no line may name an ended scope with a list.
   * With `roots`, the line carries the roots of every live session (C11), except an ended scope, a name that is no
   * scope and a scope that two live sessions share; a launch that the gate holds has its roots and no list yet.
   */
  line(body: ScopesBody, roots: boolean): AllowlistLine {
    const scopes: Record<string, string | null> = body.scopes !== null && typeof body.scopes === "object" ? { ...body.scopes } : {};
    for (const name of this.ended.keys()) delete scopes[name];
    const lists: Record<string, string[]> = {};
    if (body.lists !== null && typeof body.lists === "object") for (const [n, h] of Object.entries(body.lists)) lists[n] = [...h];
    const out: AllowlistLine = { t: "allowlist", ...body, lists, scopes };
    if (roots) out.roots = this.roots();
    return out;
  }

  private roots(): Record<string, Root[]> {
    const counts = this.scopeCounts();
    const out: Record<string, Root[]> = {};
    for (const r of this.rowsNow) {
      if (counts.get(r.scope) !== 1 || this.ended.has(r.scope)) continue;
      const items: Root[] = [];
      for (const x of r.roots) if (rootOk(x) && !items.some((i) => i.pid === x.pid && i.start === x.start)) items.push({ pid: x.pid, start: x.start });
      if (items.length) out[r.scope] = items;
    }
    return out;
  }

  /** The scopes to which `body` (an object or a line) gives a list. */
  named(body: { scopes?: unknown }): Set<string> {
    const s = body?.scopes;
    if (s === null || typeof s !== "object" || Array.isArray(s)) return new Set();
    return new Set(Object.entries(s as Record<string, unknown>).filter(([, v]) => typeof v === "string").map(([k]) => k));
  }

  /** Ended names whose write failed: not in the file yet (no launch may take them). */
  heldInMemory(): Set<string> { return new Set([...this.ended.keys()].filter((n) => !this.onDisk.has(n))); }

  /** Why names are held in memory only: the last write's error, else the read error of the damaged file; else "". */
  holdError(): string { return this.writeError || this.readError; }

  /** Launch scopes that two or more live sessions hold: neither gets a list (a name that is no scope is not counted). */
  shared(): Set<string> { return new Set([...this.scopeCounts()].filter(([, c]) => c > 1).map(([s]) => s)); }

  /** The live sessions by launch scope; a scope that two rows share maps to the first. */
  rows(): Map<string, SessionRow> {
    const out = new Map<string, SessionRow>();
    for (const r of this.rowsNow) if (!out.has(r.scope)) out.set(r.scope, r);
    return out;
  }

  /** The list of the live session `scope` (also while it waits), else null. */
  listOf(scope: string): string | null {
    const r = this.rows().get(scope);
    return r === undefined ? null : listOfRow(r);
  }

  /** The texts for the Browser pane: the file's error, each list's, each shared name. */
  errors(): string[] {
    const out: string[] = [];
    if (this.readError) out.push(this.readError);
    if (this.writeError) out.push(this.writeError);
    for (const name of [...new Set(this.rowsNow.map(listOfRow))].filter((n) => n !== UNREAD_LIST).sort()) {
      const e = this.readList(name).error;
      if (e) out.push(`list ${name}: ${e}`);
    }
    for (const s of [...this.shared()].sort()) out.push(SHARED_ERROR.replace("{scope}", s));
    return out;
  }
}

