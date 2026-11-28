// The guard of the sent sign-ins' cookies (board ab-dbm; C12, the data of the reads, `cookie_loss`). On the Mac every
// cookie of the agent profile made before a time vanished from the profile's cookie file, the sent sign-ins with them,
// and nothing told the operator until an agent got a 401. The cause stays unknown, so this guard tells when it happens.
//
// - The record. The service keeps the domain of each import (the operator's send and the sign-in act's move), the count
//   of cookies that the receiver set, and the import's time in UTC, in sign-in-cookies.json of its state folder (mode
//   0600), so it outlives a restart of the service. It never holds a cookie's name or value.
// - The check. 60 s after each `ready` of the agent Chrome and after each import (Chrome writes cookie changes into the
//   profile's file in batches: on Linux 20 s to 40 s after the change, measured with Chromium 156), the service counts
//   the rows of each recorded domain and of its subdomains in the agent profile's cookie file (<profile>/Default/Cookies). It opens the file read-only and
//   immutable (SQLite takes no lock, so Chrome's writes never wait for it), selects only a count by host_key in SQL (no
//   row leaves SQLite), and never copies the file or its journal. One pending check at a time: a new trigger in the 60 s
//   moves it. One log line with the UTC time and the counts.
// - The drop. A domain whose count falls to 0 from above 0 gets one warning line, an item of the status key
//   `cookie_loss` and a sentence of the operator's text, until the next import of that domain. The baseline is an
//   earlier count of the file, never `cookies_set`: the file can hold fewer cookies (Chrome can keep session cookies in
//   memory only), so a domain whose first count after its import is 0 gets no warning.
// - A skip. A missing file, an SQLite error, a journal that is not empty, or a file that changed during the read gives
//   one plain line, and never a warning or an item.
// The log rule (C12): a line names a sign-in's domain, counts and times only.

import { statSync, type BigIntStats } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ServicePart } from "../part.ts";
import { readRecord, writeJsonDurable } from "../unit/record.ts";
import { errorKind } from "../lists/files.ts";

/** The record's file in the state folder. */
export const COOKIE_RECORD = "sign-in-cookies.json";
/** The wait from a trigger (a `ready`, an import) to its check: Chrome writes cookie changes in batches (20 s to 40 s on Linux). */
export const CHECK_DELAY_MS = 60_000;
/**
 * The most domains that the record keeps: over it the oldest entry whose first count ran and that has no open item goes.
 * An entry with an open item of `cookie_loss` stays until the next import of its domain (C12), so with more such entries
 * the record holds more.
 */
export const MAX_DOMAINS = 200;

/**
 * The record over MAX_DOMAINS (the review of ab-dbm, M1; board ab-2pz): only an entry whose first count ran and that has
 * no open item can go, the oldest first, and never `keep`; when no entry can go, each stays.
 */
export function capEntries(list: readonly CookieEntry[], keep: CookieEntry | null = null): CookieEntry[] {
  const out = [...list];
  while (out.length > MAX_DOMAINS) {
    const i = out.findIndex((e) => e.lost === null && e.count !== null && e !== keep);
    if (i < 0) break;
    out.splice(i, 1);
  }
  return out;
}

/**
 * One domain of the record: its last import (the count set and the time), its last count of the file (null before the
 * first count after the import), and the check that found it gone.
 */
export type CookieEntry = { domain: string; cookies_set: number; imported: string; count: number | null; lost: string | null };
/** An item of the status key `cookie_loss`. */
export type CookieLoss = { domain: string; at: string; imported: string };

/** The count of a read: the count of each domain, or why the read did not run (a skip). */
export type CookieCount = { ok: true; counts: Map<string, number> } | { ok: false; why: string };

const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;
const HOST = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?)*$/;
const count = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x >= 0;
/** A time in UTC, ISO 8601 with whole seconds (the form of `last_stop`'s `at`). */
export const isoAt = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const cookies = (n: number) => `${n} cookie${n === 1 ? "" : "s"}`;

/** The profile's cookie file (Linux and the Mac: Chrome keeps it in the profile's Default folder). */
export const cookieFile = (profile: string) => join(profile, "Default", "Cookies");

/** The operator's sentence of a domain whose cookies are gone. */
export const lossSentence = (l: CookieLoss) =>
  `The agent profile has no cookie of the sign-in for ${l.domain} any more (sent at ${l.imported}, found at ${l.at}): send that sign-in again.`;

type Sqlite = typeof import("node:sqlite");

/**
 * The count of the rows of each domain (and of its subdomains) in a cookie file, read in place: read-only and immutable
 * (no lock, no journal read), only `COUNT(*)` by host_key. A skip when the file is missing, when SQLite fails, when the
 * journal or the write-ahead log is not empty, or when the file changed during the read.
 */
export function countCookies(file: string, domains: readonly string[], sqlite: Sqlite | null = process.getBuiltinModule("node:sqlite") ?? null): CookieCount {
  if (!sqlite) return { ok: false, why: "this Node has no node:sqlite" };
  const stat = (p: string): BigIntStats | null | "error" => {
    try { return statSync(p, { bigint: true }); } catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? null : "error"; }
  };
  const quiet = () => [`${file}-journal`, `${file}-wal`].every((p) => { const s = stat(p); return s === null || (s !== "error" && s.size === 0n); });
  const before = stat(file);
  if (before === null) return { ok: false, why: "the agent profile has no cookie file" };
  if (before === "error") return { ok: false, why: "the cookie file cannot be read" };
  if (!quiet()) return { ok: false, why: "Chrome was writing the cookie file" };
  const url = pathToFileURL(file);
  url.searchParams.set("immutable", "1");
  const counts = new Map<string, number>();
  let db: InstanceType<Sqlite["DatabaseSync"]> | null = null;
  try {
    db = new sqlite.DatabaseSync(url, { readOnly: true });
    const q = db.prepare("SELECT COUNT(*) AS n FROM cookies WHERE host_key = ? OR substr(host_key, -length(?)) = ?");
    for (const d of domains) {
      const n = (q.get(d, `.${d}`, `.${d}`) as { n?: unknown } | undefined)?.n;
      counts.set(d, typeof n === "number" ? n : Number(n));
    }
  } catch (e) {
    return { ok: false, why: `SQLite cannot read the cookie file (${(e as { errstr?: string }).errstr ?? errorKind(e)})` };
  } finally {
    try { db?.close(); } catch {}
  }
  const after = stat(file);
  const same = after !== null && after !== "error" && after.size === before.size && after.mtimeNs === before.mtimeNs && after.ino === before.ino;
  if (!same || !quiet()) return { ok: false, why: "Chrome was writing the cookie file" };
  return { ok: true, counts };
}

export type CookieGuardOptions = {
  /** The service's state folder: the record's folder. */
  stateFolder: string;
  /** The agent profile of this service (the unit's own profile path), never another profile. */
  profile: string;
  log: (line: string) => void;
  /** An import runs now (the link's channel main): the check waits for its end. */
  busy?: () => boolean;
  /** The wall clock in ms. */
  wall?: () => number;
  /** Tests only: the wait from a trigger to its check, and the count. */
  delayMs?: number;
  count?: (file: string, domains: readonly string[]) => CookieCount;
};

/** The guard: the record, the coalesced check, the status key `cookie_loss` and its sentences. */
export class CookieGuard implements ServicePart {
  readonly ops = {};
  readonly file: string;
  private entries: CookieEntry[] = [];
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private readonly wall: () => number;
  private readonly delayMs: number;
  private readonly busy: () => boolean;
  private readonly count: (file: string, domains: readonly string[]) => CookieCount;
  private readonly o: CookieGuardOptions;

  constructor(o: CookieGuardOptions) {
    this.o = o;
    this.file = join(o.stateFolder, COOKIE_RECORD);
    this.wall = o.wall ?? Date.now;
    this.delayMs = o.delayMs ?? CHECK_DELAY_MS;
    this.busy = o.busy ?? (() => false);
    this.count = o.count ?? ((f, d) => countCookies(f, d));
    this.entries = this.load();
  }

  /** The record's domains, as the file holds them. */
  domains(): readonly CookieEntry[] { return this.entries.map((e) => ({ ...e })); }

  /**
   * An import of `domain` set `set` cookies: its entry is new (no loss, and no count of the file yet: the next count is
   * its baseline), the file is written, and a check is due.
   */
  imported(domain: string, set: number): void {
    if (this.stopped || !HOST.test(domain) || domain.length > 253) return;
    const e: CookieEntry = { domain, cookies_set: count(set) ? set : 0, imported: isoAt(this.wall()), count: null, lost: null };
    this.entries = capEntries([...this.entries.filter((x) => x.domain !== domain), e], e);
    this.save();
    this.schedule();
  }

  /** A `ready` of the agent Chrome: a check is due. */
  started(): void { this.schedule(); }

  /** One pending check at a time: a new trigger in the wait moves it, and gives no second check. */
  private schedule(): void {
    if (this.stopped || this.entries.length === 0) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; this.due(); }, this.delayMs);
    this.timer.unref();
  }

  /** The pending check's time: while an import runs it waits again (the receiver removes the domain's cookies first). */
  private due(): void {
    if (this.stopped) return;
    if (this.busy()) { this.schedule(); return; }
    this.check();
  }

  /** The check: the count of each recorded domain, one line, and one warning for each new drop to 0. */
  check(): void {
    if (this.entries.length === 0) return;
    const seen = this.entries;
    let r: CookieCount;
    try { r = this.count(cookieFile(this.o.profile), seen.map((e) => e.domain)); }
    catch (e) { r = { ok: false, why: `the count failed (${errorKind(e)})` }; }
    const at = isoAt(this.wall());
    if (!r.ok) { this.o.log(`signin: check ${at}: the cookies of the agent profile are not counted: ${r.why}; no warning from this check`); return; }
    const parts: string[] = [], warnings: string[] = [];
    const next = seen.map((e) => {
      const n = r.counts.get(e.domain);
      if (n === undefined || !count(n)) { parts.push(`${e.domain} not counted`); return e; }
      parts.push(n === 0 && e.cookies_set > 0 ? `${e.domain} 0 cookies (${e.cookies_set} set at the import of ${e.imported})` : `${e.domain} ${cookies(n)}`);
      // The baseline is an earlier count of the file (never cookies_set): a first count of 0 after an import is no drop.
      const lost = e.lost === null && e.count !== null && e.count > 0 && n === 0 ? at : e.lost;
      if (lost !== e.lost) warnings.push(`signin: WARNING ${at}: the agent profile has no cookie of the sign-in for ${e.domain} any more (${cookies(e.count ?? 0)} at the last count, ${e.cookies_set} set at the import of ${e.imported}); the operator sends that sign-in again`);
      return { ...e, count: n, lost };
    });
    this.o.log(`signin: check ${at}: ${parts.join(", ")}`);
    for (const w of warnings) this.o.log(w);
    this.entries = next;
    this.save();
  }

  /** The items of `cookie_loss`: each domain whose cookies a check found gone, until its next import. */
  losses(): CookieLoss[] {
    return this.entries.filter((e) => e.lost !== null).map((e) => ({ domain: e.domain, at: e.lost!, imported: e.imported }));
  }

  status(): Record<string, unknown> { return { cookie_loss: this.losses() }; }

  notes(): { agent: string[]; operator: string[] } { return { agent: [], operator: this.losses().map(lossSentence) }; }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private load(): CookieEntry[] {
    const r = readRecord(this.file);
    if (r.kind === "none") return [];
    if (r.kind === "unreadable") { this.o.log(`signin: the record of sent sign-ins cannot be read (${r.why}); it starts again with no domain`); return []; }
    const list = Array.isArray(r.record.domains) ? r.record.domains : [];
    const out: CookieEntry[] = [];
    for (const x of list) {
      if (x === null || typeof x !== "object") continue;
      const e = x as Record<string, unknown>;
      if (typeof e.domain !== "string" || !HOST.test(e.domain) || !count(e.cookies_set) || typeof e.imported !== "string" || !ISO.test(e.imported) || !(e.count === null || count(e.count))) continue;
      if (!(e.lost === null || (typeof e.lost === "string" && ISO.test(e.lost)))) continue;
      if (out.some((y) => y.domain === e.domain)) continue;
      out.push({ domain: e.domain, cookies_set: e.cookies_set, imported: e.imported, count: e.count as number | null, lost: e.lost as string | null });
    }
    // The last entry is the newest import, which the cap kept when it was written: a restart keeps the same record.
    return capEntries(out, out.at(-1) ?? null);
  }

  private save(): void {
    try { writeJsonDurable(this.file, { v: 1, domains: this.entries }); }
    catch (e) { this.o.log(`signin: the record of sent sign-ins cannot be written (${errorKind(e)})`); }
  }
}
