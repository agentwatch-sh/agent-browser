// The stored sign-ins' store in the service (contract C12, "The stored sign-ins", the master; the design
// docs/superpowers/specs/2026-11-10-stored-sign-in-credentials-design.md, sections 5 and 6; board ab-v16.97.2, stage 1e
// part 1). The service holds the open store key and no file of the store: the daemon writes key.json and the record
// files from the service's answers, and sends them back in each `sign_ins` (a complete snapshot). No plain value
// reaches the daemon: the pane (and the offer command) seal each typed value to the pane key, which the service makes
// at each start.
//
// This file has the eight ops of C12 after the door's checks (the op, the shape, the kind), in C12's order: the rules
// of `record`; the snapshot; the state; the protections (`sign_ins_setup` and `sign_ins_unlock`); the pane's seal;
// then the op's own checks. It keeps its own file, sign-ins-state.json in the state folder: the highest `gen` of each
// id, the removed ids, and for each credential its failed results in a row, its stop and the times of its acts in the
// last hour (ids and numbers only). The sign-in act (stage 1e part 2, board ab-v16.97.4) uses `openForUse`, `limit`,
// `actStarted` and `actEnded`.
//
// The log rule (C12): no log line holds a username, a password, a passphrase, a wrapped key, a sealed record, a
// pane's seal or a form value. The store logs an op with the credential's id and name, and the kinds of file errors.
//
// The cards (C12, "The card payments"; board ab-sta.5): a card is a record of this store with `"kind":"card"`, whose
// seal binds `kind` in its additional data (cardAd), so neither a card nor a sign-in opens as the other. The op
// `card_seal` seals a new card (only with the feature `card_pay`: signins/part.ts); `namedCard` and `openCard` are the
// payment's lookup (C11, the card payment, check 4), which takes only a record of the kind `card`; `paySeal` opens the
// pane's seal of an approval (`pay_approve`: pay/request.ts). The sign-in act takes no record with a `kind` (recordFields).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SCOPE } from "../../relay/scopes.ts";
import { errorKind, parseJsonBytes, writeJson } from "../lists/files.ts";
import type { Answer, Req } from "../control.ts";
import {
  b64u, bindingInfo, cardAd, cardPlain, deriveKey, KDF, keyFits, newKdf, newKeyPair, openPaneSeal, openRecord, plainFits, privateKeyOf, publicRaw,
  recordAd, recordPlain, sealRecord, SIGN_IN_PURPOSE, unwrapKey, wrapKey, zero, type CardFields, type CardValues, type KeyFile, type RecordFields,
} from "./seal.ts";
import { randomBytes, timingSafeEqual, type KeyObject } from "node:crypto";
import { BRANDS, brandOf, luhn, refusesDigits } from "../pay/digits.ts";
import type { Unprotected } from "./protect.ts";

/** C12's texts of the stored sign-ins. */
export const TEXT = {
  noSnapshot: "the stored sign-ins have no snapshot yet",
  setUp: "the store is set up already",
  notSetUp: "the store is not set up",
  locked: "the store is locked",
  sealed: "the sealed value cannot be opened",
  wrongPassphrase: "the passphrase does not open the store",
  shortPassphrase: "the passphrase has fewer than 16 characters",
  keyFile: "the store's key file is not valid",
  removed: "the stored sign-in was removed",
  noSuchId: "there is no stored sign-in with this id",
  origin: "a change of the origin needs a new seal of the password",
  cannotOpen: "the stored sign-in cannot be opened",
  nameTaken: "another stored sign-in has this name",
  offerId: "an offer needs a new id",
  busy: "the store is busy; try again",
  record: (field: string) => `the stored sign-in is not valid (field ${field})`,
  card: (field: string) => `the card is not valid (field ${field})`,
  unprotected: (reason: Unprotected) => `the service's memory is not protected (${reason})`,
} as const;

/** The first values (C12; the design, section 15). */
export const SEAL_MS = 120_000;
export const WRONG_WAIT_MS = 2000;
export const MIN_PASSPHRASE = 16;
export const HOUR_MS = 3_600_000;
export const HOUR_LIMIT = 6;
export const IN_A_ROW = 3;
/** The results of C11's lockout guard that count in a row. */
const FAILED_RESULTS = new Set(["not_accepted", "timeout", "second_factor"]);
export const STATE_FILE = "sign-ins-state.json";
/** At most this many set-ups, unlocks or rekeys wait behind the one that runs (the daemon lead's condition of review-118b). */
export const QUEUE_WAITING = 2;

export type StoreState = "none" | "locked" | "open";
type Snapshot = { key: Record<string, unknown> | null; records: Record<string, unknown>[] };
type Credential = { fails: number; stopped: boolean; hour: number[] };
type Fields = { id: string; name: string; origin: string; path: string; send_to: string[] };
type Sealed = { text: string; sender: string; rid: string; at: string };

const isObj = (x: unknown): x is Record<string, any> => x !== null && typeof x === "object" && !Array.isArray(x);
/** A credential's id (C12, the rules of record): `c-` and 8 lowercase hex digits. Only such ids go into the service's file. */
const CRED_ID = /^c-[0-9a-f]{8}$/;
/** A card's id (C12, the rules of a card): `card-` and 8 lowercase hex digits, which the service makes at random. */
export const CARD_ID = /^card-[0-9a-f]{8}$/;
/** An id of the store: a credential's or a card's. The highest gens and the removed ids of the service's file are of both. */
const STORE_ID = /^(?:c|card)-[0-9a-f]{8}$/;
const RID = /^[A-Za-z0-9_-]{22,64}$/;
const AT = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{3})?Z$/;
/** An `at` of C12's form that is a real time in UTC: the calendar date and the time exist (no February 30, no hour 24). */
export function atFits(at: string): boolean {
  if (!AT.test(at)) return false;
  const t = Date.parse(at);
  return Number.isFinite(t) && new Date(t).toISOString() === (at.length === 20 ? `${at.slice(0, 19)}.000Z` : at);
}
const loopback = (h: string) => h === "localhost" || h.endsWith(".localhost") || h === "127.0.0.1";
/** `origin` (C12, the rules of record): a URL origin as the WHATWG URL parser gives it, https:, or http: with a loopback host. */
export function originFits(o: unknown): boolean {
  if (typeof o !== "string" || !URL.canParse(o)) return false;
  const u = new URL(o);
  return u.origin === o && (u.protocol === "https:" || (u.protocol === "http:" && loopback(u.hostname)));
}
/** The first field of `record` that breaks C12's rules of record, in their order, or null. */
export function recordBreaks(r: Fields): string | null {
  if (!/^c-[0-9a-f]{8}$/.test(r.id)) return "id";
  if (!SCOPE.test(r.name)) return "name";
  if (!originFits(r.origin)) return "origin";
  // review-118 note 8: printable ASCII only, as the binding of a pane's seal needs.
  if (!/^\/[\x20-\x7e]*$/.test(r.path) || /[?#]/.test(r.path)) return "path";
  if (!r.send_to.includes(r.origin) || !r.send_to.every(originFits) || new Set(r.send_to).size !== r.send_to.length) return "send_to";
  return null;
}
/**
 * A record file's ten plain fields with their shape (C12, the record), or null: a record that breaks it does not open. A
 * record with a `kind` (a card) is no stored sign-in (C12: the sign-in act's check 2 refuses it).
 */
export function recordFields(x: Record<string, unknown>): RecordFields | null {
  const r = x as Record<string, any>;
  if (Object.hasOwn(r, "kind")) return null;
  const fields = { id: r.id, name: r.name, origin: r.origin, path: r.path, send_to: r.send_to };
  if (r.v !== 1 || typeof r.id !== "string" || typeof r.name !== "string" || typeof r.origin !== "string" || typeof r.path !== "string"
    || !Array.isArray(r.send_to) || !r.send_to.every((s: unknown) => typeof s === "string") || recordBreaks(fields as Fields) !== null
    || !Number.isSafeInteger(r.gen) || r.gen < 1 || !(r.repos === null || (Array.isArray(r.repos) && r.repos.every((s: unknown) => typeof s === "string")))
    || (r.by !== "operator" && r.by !== "offer") || typeof r.approved !== "boolean" || !isObj(r.sealed)) return null;
  return { v: 1, id: r.id, gen: r.gen, name: r.name, origin: r.origin, path: r.path, send_to: [...r.send_to], repos: r.repos === null ? null : [...r.repos], by: r.by, approved: r.approved };
}

/** Printable text (C12, the rules of a card): no control, format, surrogate, private-use or line-separator character. */
const PRINTABLE = /^[^\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]*$/u;
const chars = (s: string) => [...s].length;
/**
 * The first value of the card form's seal that breaks C12's rules of a card, in their order (`name`, `number`, `expiry`,
 * the name's digits, `csc`, `holder`, `postal`), or null. The text names the field, never a value.
 */
export function cardBreaks(v: Record<string, unknown>): string | null {
  if (typeof v.name !== "string" || !SCOPE.test(v.name)) return "name";
  if (typeof v.number !== "string" || !/^\d{12,19}$/.test(v.number) || !luhn(v.number)) return "number";
  if (typeof v.expiry !== "string" || !/^(?:0[1-9]|1[0-2])\/\d\d$/.test(v.expiry)) return "expiry";
  // No plain field holds a digit of the number (C12): a name with the last four digits, a run of the number's digits or
  // the expiry breaks the name's rule (review-226 N3).
  const view = { number: Buffer.from(v.number, "latin1"), expiry: Buffer.from(v.expiry, "latin1") };
  try { if (refusesDigits(v.name, view)) return "name"; } finally { view.number.fill(0); view.expiry.fill(0); }
  if (typeof v.csc !== "string" || !/^\d{3,4}$/.test(v.csc)) return "csc";
  if (typeof v.holder !== "string" || chars(v.holder) > 100 || !PRINTABLE.test(v.holder)) return "holder";
  if (typeof v.postal !== "string" || chars(v.postal) > 16 || !PRINTABLE.test(v.postal)) return "postal";
  return null;
}
/** A card's record file's six plain fields with their shape (C12, the record kind `card`), or null. */
export function cardFields(x: Record<string, unknown>): CardFields | null {
  const r = x as Record<string, any>;
  if (r.v !== 1 || r.kind !== "card" || typeof r.id !== "string" || !CARD_ID.test(r.id) || !Number.isSafeInteger(r.gen) || r.gen < 1
    || typeof r.name !== "string" || !SCOPE.test(r.name) || !(BRANDS as readonly unknown[]).includes(r.brand) || !isObj(r.sealed)) return null;
  return { v: 1, kind: "card", id: r.id, gen: r.gen, name: r.name, brand: r.brand };
}

export type SignInStoreOptions = {
  /** The service's state folder (--state-folder): sign-ins-state.json is in it. */
  stateFolder: string;
  log: (line: string) => void;
  /** The reason of a protection of the service's memory that does not hold, or null (protect.ts). */
  protections: () => Unprotected | null;
  /**
   * The Mac (board ab-v16.97.15; C12, the protections): one fresh read of the background reader, after each read that
   * runs at the request; `sign_ins_setup` and `sign_ins_unlock` start it at their request and wait for it before their
   * turn. Linux has none.
   */
  fresh?: () => Promise<void>;
  /** The Mac: the reader calls `lost` at each reading that does not hold; the store's part then locks an open store (lockUnprotected). */
  watchProtections?: (lost: () => void) => void;
  /** The Mac: C12's two Mac keys of the status, `taskport_shared_s` (from the reader) and `act_window` ("on_screen"). */
  mac?: { taskportSharedS: () => number | null };
  /** The clock of the seals' 120 s and of the hour's acts. */
  now?: () => Date;
  /** Tests only: the pane key's 32 secret bytes (the vectors' test pane key); else a new one at each start. */
  paneSecret?: Buffer;
  /** Tests only: the wait after a passphrase that does not open the store (C12: 2 s). */
  wrongWaitMs?: number;
  /** Tests only: scrypt's N of a set-up and a new passphrase (C12: 2^17; within the bounds). */
  kdfN?: number;
  /** Tests only: called at a step of a key op ("rekey: the new passphrase's derivation"), so a test can lock there. */
  onStep?: (step: string) => void;
};

/** The service's part of the stored sign-ins: the open key, the pane key, the last snapshot and its own file. */
export class SignInStore {
  private readonly o: SignInStoreOptions;
  private readonly now: () => Date;
  private readonly pane: { secret: Buffer; key: KeyObject; pub: Buffer };
  private snap: Snapshot | null = null;
  private openKey: { secret: Buffer; key: KeyObject; pub: Buffer } | null = null;
  private readonly highest = new Map<string, number>();
  private readonly removed = new Set<string>();
  private readonly creds = new Map<string, Credential>();
  /**
   * Each rid of a pane's seal that the service took, and the time until which it keeps it: until the seal can no longer
   * open, its at more than 120 s in the past and at least 120 s after the rid was first seen (review-118 B2).
   */
  private readonly rids = new Map<string, number>();
  /** The number of locks since the start: an op that a lock came after opens nothing (review-118 note 3; review-118b). */
  private locks = 0;
  /** The set-ups, unlocks and rekeys that have not answered: the one that runs and those that wait. */
  private pending = 0;
  /** The highest time that the clock gave: the clock of the seals' checks never goes back (review-118b open point 4). */
  private highestTime = 0;
  private actCount = 0;
  /** The one set-up, unlock or rekey that runs (C12: one at a time). */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(o: SignInStoreOptions) {
    this.o = o;
    this.now = o.now ?? (() => new Date());
    const secret = o.paneSecret ? Buffer.from(o.paneSecret) : null;
    if (secret) { const key = privateKeyOf(secret); this.pane = { secret, key, pub: publicRaw(key) }; }
    else this.pane = newKeyPair();
    this.readFile();
  }

  // ---- the state, status and the file ----

  state(): StoreState { return this.openKey ? "open" : this.snap && this.snap.key !== null ? "locked" : "none"; }
  /** The pane key's public half, standard base64 (C12: in status and in the sign_ins event). */
  paneKey(): string { return this.pane.pub.toString("base64"); }
  private holds(id: string): boolean { return (this.snap?.records ?? []).some((r) => r.id === id); }
  /** C12's status key: the stopped credentials are ids of the last snapshot that are not removed (open point 9 of PR #112). */
  status(): { state: StoreState; records: number; acts: number; pane_key: string; stopped: string[]; unprotected: Unprotected | null; taskport_shared_s?: number | null; act_window?: "on_screen" } {
    const stopped = [...this.creds].filter(([id, c]) => c.stopped && this.holds(id) && !this.removed.has(id)).map(([id]) => id).sort();
    const mac = this.o.mac ? { taskport_shared_s: this.o.mac.taskportSharedS(), act_window: "on_screen" as const } : {};
    return { state: this.state(), records: this.snap?.records.length ?? 0, acts: this.actCount, pane_key: this.paneKey(), stopped, unprotected: this.o.protections(), ...mac };
  }
  /** Tests only: whether the service holds an open private half (C12: a lock drops it). */
  holdsOpenKey(): boolean { return this.openKey !== null; }

  private readFile(): void {
    let raw: Buffer;
    try { raw = readFileSync(join(this.o.stateFolder, STATE_FILE)); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") this.o.log(`sign-ins: the state file cannot be read (${errorKind(e)}); the service starts with no gen and no removed id`); return; }
    let f: any;
    try { f = parseJsonBytes(raw); if (!isObj(f) || f.v !== 1) throw new SyntaxError("not the state file"); }
    catch (e) { this.o.log(`sign-ins: the state file cannot be read (${errorKind(e)}); the service starts with no gen and no removed id`); return; }
    if (isObj(f.highest)) for (const [id, g] of Object.entries(f.highest)) if (STORE_ID.test(id) && Number.isSafeInteger(g) && (g as number) >= 1) this.highest.set(id, g as number);
    if (Array.isArray(f.removed)) for (const id of f.removed) if (typeof id === "string" && STORE_ID.test(id)) this.removed.add(id);
    if (isObj(f.credentials)) for (const [id, c] of Object.entries(f.credentials)) {
      if (!CRED_ID.test(id) || !isObj(c)) continue;
      const hour = Array.isArray(c.hour) ? c.hour.filter((t: unknown) => Number.isSafeInteger(t)) : [];
      this.creds.set(id, { fails: Number.isSafeInteger(c.fails) && c.fails >= 0 ? c.fails : 0, stopped: c.stopped === true, hour });
    }
  }
  private writeFile(): void {
    const t = this.now().getTime();
    const credentials: Record<string, Credential> = {};
    for (const [id, c] of this.creds) {
      c.hour = c.hour.filter((x) => t - x < HOUR_MS);
      if (c.fails || c.stopped || c.hour.length) credentials[id] = { fails: c.fails, stopped: c.stopped, hour: [...c.hour] };
    }
    try { writeJson(join(this.o.stateFolder, STATE_FILE), { v: 1, highest: Object.fromEntries(this.highest), removed: [...this.removed].sort(), credentials }); }
    catch (e) { this.o.log(`sign-ins: the state file cannot be written (${errorKind(e)}); the service keeps its state in memory`); }
  }

  private lock(): void {
    this.locks++;
    if (this.openKey) zero(this.openKey.secret);
    this.openKey = null;
  }
  /** Each stop of the service drops the open private half and the pane key's (C12, the state). */
  stop(): void { this.lock(); zero(this.pane.secret); }
  /**
   * The Mac's reader saw a reading that does not hold (C12, the protections): an open store locks at once, as the
   * operator's lock does (a set-up or an unlock that runs opens nothing after it). True when it locked an open store.
   */
  lockUnprotected(): boolean {
    const why = this.o.protections();
    if (why === null) return false;
    const open = this.openKey !== null;
    this.lock();
    if (open) this.o.log(`sign-ins: the service's memory is not protected (${why}), so the store is locked`);
    return open;
  }

  // ---- the pane's seal ----

  /**
   * C12's checks of a pane's seal: the form of rid and at, a real time, the age (120 s before or after the clock), a rid
   * that the service keeps, then the open. The service takes the rid of a seal that passed the age check, and keeps it
   * until that seal can no longer open (review-118 B2).
   */
  private openSeal(req: Req, fields: Record<string, string>): Record<string, unknown> | null {
    const r = this.sealOpen(req.sealed as Sealed, SIGN_IN_PURPOSE, { op: req.op, ...fields });
    return typeof r === "string" ? null : r;
  }
  /**
   * The checks of a pane's seal with a purpose and the binding's fields (`op` and the op's own; the seal's `rid` and `at`
   * join them): `rules` when its `rid` or `at` breaks the seal rules (the form, a real time, the 120 s, a kept rid), `open`
   * when it does not open with that binding (C12, the card payments: an approval that does not match), else its object.
   */
  private sealOpen(s: Sealed, purpose: string, fields: Record<string, string>): Record<string, unknown> | "rules" | "open" {
    if (!RID.test(s.rid) || !atFits(s.at)) return "rules";
    const t = (this.highestTime = Math.max(this.highestTime, this.now().getTime())), at = Date.parse(s.at);
    if (Math.abs(t - at) > SEAL_MS) return "rules";
    for (const [rid, until] of this.rids) if (t > until) this.rids.delete(rid);
    if (this.rids.has(s.rid)) return "rules";
    this.rids.set(s.rid, Math.max(t, at) + SEAL_MS);
    let info: Buffer;
    try { info = bindingInfo(purpose, { ...fields, rid: s.rid, at: s.at }); } catch { return "open"; }
    try { return openPaneSeal(s.text, s.sender, info, this.pane); } catch { return "open"; }
  }

  // ---- the ops ----

  /** An op of the stored sign-ins after the door's checks; the set-up, the unlock and the rekey answer later. */
  handle(req: Req): Answer | Promise<Answer> {
    // The rules of record, only for the ops that take a record: a side ignores a field that it does not know (review-118 note 7).
    const record = req.op === "sign_in_seal" || req.op === "sign_in_reseal" ? req.record as Fields : undefined;
    if (record) { const f = recordBreaks(record); if (f) return { error: TEXT.record(f) }; }
    switch (req.op) {
      case "sign_ins_lock": this.lock(); return { data: {} };
      case "sign_ins": return this.snapshot(req.key as Record<string, unknown> | null, req.records as Record<string, unknown>[]);
      case "sign_ins_setup": case "sign_ins_unlock": case "sign_ins_rekey": {
        // The bound of the queue: one runs and at most two wait; one more is busy at once (C12, the passphrase).
        if (this.pending > QUEUE_WAITING) return { error: TEXT.busy };
        // A lock that comes after this request and before its answer wins: read the count of locks now (review-118b).
        const locks = this.locks;
        // The Mac (C12, the protections and the passphrase): the set-up and the unlock wait for their fresh read first. It
        // starts at the request and runs while the op waits for its turn; the op keeps its place in the queue, and its
        // turn begins after the read (so the 2 s of a wrong passphrase count from the turn).
        const fresh = req.op !== "sign_ins_rekey" && this.o.fresh ? this.o.fresh().catch(() => {}) : null;
        // One at a time, each in the order that it came, with all its checks inside (C12).
        this.pending++;
        const run = this.queue.then(() => fresh).then(() => this.keyOp(req, locks));
        const done = () => { this.pending--; };
        run.then(done, done);
        this.queue = run.catch(() => {});
        return run;
      }
    }
    if (!this.snap) return { error: TEXT.noSnapshot };
    switch (req.op) {
      case "sign_in_seal": return this.seal(req, record!);
      case "sign_in_reseal": return this.reseal(record!);
      case "sign_in_start_again": return this.startAgain(req.credential as string);
      case "card_seal": return this.cardSeal(req);
    }
    return { error: "unsupported" };
  }

  private snapshot(key: Record<string, unknown> | null, records: Record<string, unknown>[]): Answer {
    // A record that breaks its shape still holds its id (a string), so a file that is bad for a short time removes nothing.
    const ids = new Set(records.map((r) => r.id).filter((id): id is string => typeof id === "string"));
    let changed = false;
    for (const r of this.snap?.records ?? []) {
      const id = r.id;
      if (typeof id !== "string" || !STORE_ID.test(id) || ids.has(id) || this.removed.has(id)) continue;
      this.removed.add(id);
      // A removed id is no credential: its stop, its count and its hour's acts go (open point 9 of PR #112).
      this.creds.delete(id);
      changed = true;
    }
    for (const r of records) {
      const id = r.id, gen = r.gen;
      if (typeof id === "string" && STORE_ID.test(id) && Number.isSafeInteger(gen) && (gen as number) >= 1 && (gen as number) > (this.highest.get(id) ?? 0)) { this.highest.set(id, gen as number); changed = true; }
    }
    // A key that is null, or whose public half is not the open key's, drops the open key (C12, the state).
    if (this.openKey && (key === null || key.public !== b64u(this.openKey.pub))) this.lock();
    this.snap = { key, records: records.map((r) => ({ ...r })) };
    if (changed) this.writeFile();
    return { data: { records: records.length } };
  }

  private async keyOp(req: Req, locks: number): Promise<Answer> {
    const started = Date.now();
    if (!this.snap) return { error: TEXT.noSnapshot };
    const snapKey = this.snap.key;
    // The state.
    if (req.op === "sign_ins_setup" && (snapKey !== null || this.openKey)) return { error: TEXT.setUp };
    if (req.op === "sign_ins_unlock") {
      if (this.openKey) return { data: {} };
      if (snapKey === null) return { error: TEXT.notSetUp };
    }
    if (req.op === "sign_ins_rekey") {
      if (snapKey === null || this.state() === "none") return { error: TEXT.notSetUp };
      if (!this.openKey) return { error: TEXT.locked };
    }
    // The protections (the set-up and the unlock), before the pane's seal; dumpable comes first.
    if (req.op !== "sign_ins_rekey") { const why = this.o.protections(); if (why) return { error: TEXT.unprotected(why) }; }
    const value = this.openSeal(req, {});
    if (!value) return { error: TEXT.sealed };
    const text = (k: string) => (typeof value[k] === "string" ? value[k] as string : null);
    // C12: the 2 s count from the start of the op's turn, and the next op begins only after this answer.
    const wrong = async (): Promise<Answer> => { await sleep(Math.max(0, (this.o.wrongWaitMs ?? WRONG_WAIT_MS) - (Date.now() - started))); return { error: TEXT.wrongPassphrase }; };
    // A lock since the request came wins: after each derivation the op checks the lock and the last snapshot again
    // (review-118 notes 3, 4; review-118b open point 2).
    const lockedSince = () => this.locks !== locks;
    if (req.op === "sign_ins_setup") {
      const pass = text("passphrase");
      if (pass === null) return { error: TEXT.sealed };
      if ([...pass].length < MIN_PASSPHRASE) return { error: TEXT.shortPassphrase };
      const pair = newKeyPair();
      const kdf = newKdf(this.o.kdfN ?? KDF.n);
      let kek: Buffer;
      try { kek = await deriveKey(pass, kdf); } catch (e) { zero(pair.secret); throw e; }
      try {
        if (this.snap.key !== null) {
          zero(pair.secret);
          this.o.log("sign-ins: a key.json came during the set-up, so it gives no key");
          return { error: TEXT.setUp };
        }
        const file = wrapKey(pair.secret, pair.pub, kdf, kek);
        if (lockedSince()) {
          zero(pair.secret);
          this.o.log("sign-ins: the store is set up; a lock came during the set-up, so it stays closed");
          return { data: { key: file } };
        }
        this.openKey = pair;
        this.o.log("sign-ins: the store is set up and open");
        return { data: { key: file } };
      } finally { zero(kek); }
    }
    if (req.op === "sign_ins_unlock") {
      const pass = text("passphrase");
      if (pass === null) return { error: TEXT.sealed };
      if (!keyFits(snapKey)) return { error: TEXT.keyFile };
      const secret = await this.unwrap(pass, snapKey);
      if (!secret) return wrong();
      // The last snapshot and the lock again: a key.json that went or changed during the derivation, or a lock, wins.
      const now = this.snap.key;
      const key = privateKeyOf(secret), pub = publicRaw(key);
      if (now === null) { zero(secret); this.o.log("sign-ins: the key.json went during the unlock, so the store is not set up"); return { error: TEXT.notSetUp }; }
      if (lockedSince() || now.public !== b64u(pub)) { zero(secret); this.o.log("sign-ins: a lock or another key.json came during the unlock, so the store stays locked"); return { error: TEXT.locked }; }
      this.openKey = { secret, key, pub };
      this.o.log("sign-ins: the store is open");
      return { data: {} };
    }
    // sign_ins_rekey: the new passphrase's length, the key, then the old passphrase.
    const old = text("old"), next = text("new");
    if (old === null || next === null) return { error: TEXT.sealed };
    if ([...next].length < MIN_PASSPHRASE) return { error: TEXT.shortPassphrase };
    if (!keyFits(snapKey)) return { error: TEXT.keyFile };
    const open = this.openKey!;
    const closed = (): Answer => { this.o.log("sign-ins: the store closed during the rekey's derivations, so it gives no key"); return { error: this.state() === "none" ? TEXT.notSetUp : TEXT.locked }; };
    const secret = await this.unwrap(old, snapKey);
    if (lockedSince() || this.openKey !== open) { zero(secret); return closed(); }
    // A constant-time compare of the two private halves (review-118 note 1); unwrapKey gives 32 bytes.
    const same = secret !== null && timingSafeEqual(secret, open.secret);
    zero(secret);
    if (!same) return wrong();
    // The check after the new derivation below is the one that keeps a zeroed private half out of a key file.
    this.o.onStep?.("rekey: the new passphrase's derivation");
    const kdf = newKdf(this.o.kdfN ?? KDF.n);
    const kek = await deriveKey(next, kdf);
    try {
      if (lockedSince() || this.openKey !== open) return closed();
      this.o.log("sign-ins: the store has a new passphrase");
      return { data: { key: wrapKey(open.secret, open.pub, kdf, kek) } };
    } finally { zero(kek); }
  }

  /** The private half of a key file with a passphrase, or null when it does not open. */
  private async unwrap(pass: string, key: KeyFile): Promise<Buffer | null> {
    let kek: Buffer | null = null;
    try { kek = await deriveKey(pass, key.kdf); return unwrapKey(key, kek); }
    catch { return null; }
    finally { zero(kek); }
  }

  /** Another approved record of the last snapshot has this name (C12, names and ids). */
  private nameTaken(id: string, name: string): boolean {
    return (this.snap?.records ?? []).some((x) => x.id !== id && x.name === name && x.approved === true);
  }

  private sealAnswer(r: Fields, by: "operator" | "offer", approved: boolean, plain: Buffer): Answer {
    const gen = (this.highest.get(r.id) ?? 0) + 1;
    const record: RecordFields = { v: 1, id: r.id, gen, name: r.name, origin: r.origin, path: r.path, send_to: by === "offer" && !approved ? [r.origin] : [...r.send_to], repos: null, by, approved };
    // The public half that the service derives from its open private half, never the `public` of a key file (C12).
    // The open store key seals (its private half too: review-118 B1); never the `public` of a key file.
    const sealed = sealRecord(this.openKey!, recordAd(record), plain);
    this.highest.set(r.id, gen);
    this.writeFile();
    return { data: { record, sealed } };
  }

  private seal(req: Req, r: Fields): Answer {
    if (this.state() === "none") return { error: TEXT.notSetUp };
    if (!this.openKey) return { error: TEXT.locked };
    const offer = req.offer === true;
    // The binding holds the credential's id too (review-118 note 6): a seal opens only for the id that it was made for.
    const value = this.openSeal(req, { id: r.id, name: r.name, origin: r.origin, path: r.path, send_to: r.send_to.join(" "), offer: String(offer) });
    if (!value || typeof value.username !== "string" || typeof value.password !== "string") return { error: TEXT.sealed };
    if (this.removed.has(r.id)) return { error: TEXT.removed };
    // An offer gets an id that the service never saw: not one of the last snapshot, and none that it sealed (open point 10).
    if (offer && (this.holds(r.id) || this.highest.has(r.id))) return { error: TEXT.offerId };
    if (!offer && this.nameTaken(r.id, r.name)) return { error: TEXT.nameTaken };
    const plain = recordPlain(value.username, value.password);
    try {
      const a = offer ? this.sealAnswer(r, "offer", false, plain) : this.sealAnswer(r, "operator", true, plain);
      this.o.log(`sign-ins: sealed ${r.id} ${r.name}${offer ? " (an offer)" : ""}`);
      return a;
    } finally { zero(plain); }
  }

  /** The plain JSON of a record of the last snapshot, or null when it does not open (its shape, gen, removed id, tag). */
  private openOf(x: Record<string, unknown>): { fields: RecordFields; plain: Buffer } | null {
    const f = recordFields(x);
    if (!f || !this.openKey || f.gen < (this.highest.get(f.id) ?? 0) || this.removed.has(f.id)) return null;
    let plain: Buffer;
    try { plain = openRecord(this.openKey, recordAd(f), x.sealed); } catch { return null; }
    if (!plainFits(plain)) { zero(plain); return null; }
    return { fields: f, plain };
  }

  private reseal(r: Fields): Answer {
    if (this.state() === "none") return { error: TEXT.notSetUp };
    if (!this.openKey) return { error: TEXT.locked };
    const old = this.snap!.records.find((x) => x.id === r.id);
    if (!old) return { error: TEXT.noSuchId };
    if (old.origin !== r.origin) return { error: TEXT.origin };
    const o = this.openOf(old);
    if (!o) return { error: TEXT.cannotOpen };
    try {
      if (this.nameTaken(r.id, r.name)) return { error: TEXT.nameTaken };
      const a = this.sealAnswer(r, o.fields.by === "offer" ? "offer" : "operator", true, o.plain);
      this.o.log(`sign-ins: sealed again ${r.id} ${r.name}`);
      return a;
    } finally { zero(o.plain); }
  }

  private startAgain(id: string): Answer {
    // A removed id is no credential, also when a later snapshot holds its file again (open point 9 of PR #112).
    if (!this.holds(id) || this.removed.has(id)) return { error: TEXT.noSuchId };
    const c = this.creds.get(id);
    if (c && (c.stopped || c.fails)) { c.stopped = false; c.fails = 0; this.writeFile(); }
    this.o.log(`sign-ins: start again ${id}`);
    return { data: {} };
  }

  // ---- for the sign-in act (C11; stage 1e part 2, board ab-v16.97.4) ----

  /**
   * The records that the act may use, from the last snapshot: each record whose plain fields have their shape, whose
   * `approved` is true, and whose id is no removed id; a name that two such records share breaks both (C12, names and
   * ids), so neither is here. Their plain fields only: whether a record opens is check 5's (openForUse).
   */
  private approved(): { fields: RecordFields; file: Record<string, unknown> }[] {
    const all = (this.snap?.records ?? []).map((file) => ({ fields: recordFields(file), file }))
      .filter((x): x is { fields: RecordFields; file: Record<string, unknown> } => x.fields !== null && x.fields.approved && !this.removed.has(x.fields.id));
    const count = new Map<string, number>();
    for (const x of all) count.set(x.fields.name, (count.get(x.fields.name) ?? 0) + 1);
    return all.filter((x) => count.get(x.fields.name) === 1);
  }
  /** C11's check 2: the one approved record of `name` in the last snapshot, or null (none, an offer that waits, or two of one name). */
  named(name: string): { fields: RecordFields; file: Record<string, unknown> } | null {
    return this.approved().find((x) => x.fields.name === name) ?? null;
  }
  /** AgentBrowser.signIns: the approved records' plain fields (C11: the names and the origins are no secrets). */
  usable(): RecordFields[] { return this.approved().map((x) => x.fields); }

  /**
   * C11's checks 4 and 5 for one record of the last snapshot: the store is open, and the record opens (its shape, its
   * seal's tag with its plain fields, `approved` true in the seal, a gen not lower than the highest, not a removed id).
   * The values come in buffers that the act fills with zeros after its use.
   */
  openForUse(x: Record<string, unknown>): { username: Buffer; password: Buffer } | { refused: "locked" | "cannot_open" } {
    if (!this.openKey) return { refused: "locked" };
    const o = this.openOf(x);
    if (!o || !o.fields.approved) { if (o) zero(o.plain); return { refused: "cannot_open" }; }
    try {
      const v = JSON.parse(o.plain.toString("utf8"));
      return { username: Buffer.from(v.username, "utf8"), password: Buffer.from(v.password, "utf8") };
    } finally { zero(o.plain); }
  }
  /** C11's check 6: the credential is stopped, or 6 of its acts started in the last hour; else null. */
  limit(id: string): "stopped" | "hour_limit" | null {
    const c = this.creds.get(id);
    if (!c) return null;
    if (c.stopped) return "stopped";
    const t = this.now().getTime();
    return c.hour.filter((x) => t - x < HOUR_MS).length >= HOUR_LIMIT ? "hour_limit" : null;
  }
  /** An act started (C12: status's acts; C11: the hour's limit). */
  actStarted(id: string): void {
    this.actCount++;
    const c = this.creds.get(id) ?? { fails: 0, stopped: false, hour: [] };
    c.hour.push(this.now().getTime());
    this.creds.set(id, c);
    this.writeFile();
  }
  /** An act ended with C11's result: the lockout guard. True when this result stopped the credential (stopped_now). */
  actEnded(id: string, result: string): boolean {
    const c = this.creds.get(id) ?? { fails: 0, stopped: false, hour: [] };
    this.creds.set(id, c);
    let now = false;
    if (result === "signed_in") c.fails = 0;
    else if (FAILED_RESULTS.has(result)) {
      c.fails++;
      if (c.fails >= IN_A_ROW && !c.stopped) { c.stopped = true; now = true; }
    }
    this.writeFile();
    return now;
  }

  // ---- the cards (C12, "The card payments"; board ab-sta.5) ----

  /** A new card id that the last snapshot, the removed ids and the service's gens do not hold. */
  private newCardId(): string {
    for (;;) {
      const id = `card-${randomBytes(4).toString("hex")}`;
      if (!this.holds(id) && !this.removed.has(id) && !this.highest.has(id)) return id;
    }
  }

  /**
   * `card_seal` (C12): the state, the pane's seal of the card form (the purpose `browser-sign-in` and only `op`, `rid` and
   * `at`: the binding's `op` keeps it apart from each seal of the stored sign-ins), the rules of a card, then a new card
   * record sealed with the open store key: `v` 1, `kind` `card`, a new id, `gen` 1, the name and the brand.
   */
  private cardSeal(req: Req): Answer {
    if (this.state() === "none") return { error: TEXT.notSetUp };
    if (!this.openKey) return { error: TEXT.locked };
    const value = this.openSeal(req, {});
    if (!value) return { error: TEXT.sealed };
    const field = cardBreaks(value);
    if (field) return { error: TEXT.card(field) };
    const v = value as Record<string, string>;
    const record: CardFields = { v: 1, kind: "card", id: this.newCardId(), gen: 1, name: v.name, brand: brandOf(v.number) };
    const plain = cardPlain({ holder: v.holder, number: v.number, expiry: v.expiry, csc: v.csc, postal: v.postal });
    try {
      const sealed = sealRecord(this.openKey, cardAd(record), plain);
      this.highest.set(record.id, record.gen);
      this.writeFile();
      this.o.log(`sign-ins: sealed card ${record.id} ${record.name}`);
      return { data: { record, sealed } };
    } finally { zero(plain); }
  }

  /**
   * C11's card payment, check 4: the one card of `name` in the last snapshot (a record of the kind `card` whose plain
   * fields have their shape, whose id is no removed id), or null. A sign-in is no card; two cards of one name give none.
   */
  namedCard(name: string): { fields: CardFields; file: Record<string, unknown> } | null {
    const cards = (this.snap?.records ?? []).map((file) => ({ fields: cardFields(file), file }))
      .filter((x): x is { fields: CardFields; file: Record<string, unknown> } => x.fields !== null && !this.removed.has(x.fields.id) && x.fields.name === name);
    return cards.length === 1 ? cards[0] : null;
  }

  /**
   * C11's checks 3 and 4 for one card of the last snapshot: the store is open, and the card opens (its shape, its seal's
   * tag with its plain fields and `kind`, a gen not lower than the highest, not a removed id, its values by the rules of a
   * card). The values come in buffers that the caller fills with zeros after its use.
   */
  openCard(x: Record<string, unknown>): { values: Record<keyof CardValues, Buffer> } | { refused: "locked" | "cannot_open" } {
    if (!this.openKey) return { refused: "locked" };
    const f = cardFields(x);
    if (!f || f.gen < (this.highest.get(f.id) ?? 0) || this.removed.has(f.id)) return { refused: "cannot_open" };
    let plain: Buffer;
    try { plain = openRecord(this.openKey, cardAd(f), x.sealed); } catch { return { refused: "cannot_open" }; }
    try {
      let v: Record<string, unknown>;
      try { v = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plain)); } catch { return { refused: "cannot_open" }; }
      if (!isObj(v) || cardBreaks({ ...v, name: f.name }) !== null) return { refused: "cannot_open" };
      const b = (k: keyof CardValues) => Buffer.from(v[k] as string, "utf8");
      return { values: { holder: b("holder"), number: b("number"), expiry: b("expiry"), csc: b("csc"), postal: b("postal") } };
    } finally { zero(plain); }
  }

  /** The snapshot and the state of `pay_approve` (C12, with the texts of the stored sign-ins), or null when the store is open. */
  payState(): string | null {
    if (!this.snap) return TEXT.noSnapshot;
    if (this.state() === "none") return TEXT.notSetUp;
    return this.openKey ? null : TEXT.locked;
  }

  /**
   * The pane's seal of an approval (`pay_approve`; C12): the purpose `browser-pay`, `op`, `rid` and `at`, and the binding
   * fields of the service's own request. `rules` and `open` as sealOpen.
   */
  paySeal(sealed: Sealed, purpose: string, fields: Record<string, string>): Record<string, unknown> | "rules" | "open" {
    return this.sealOpen(sealed, purpose, fields);
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
