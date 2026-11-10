// The per-repo lists of hosts (stage 1c of the self-contained agent browser, board ab-v16.94.4; the design, sections 5.1
// and 7.5): the port of agentwatch's daemon/browser/lists.py and the read-only part of allowlist.py. The service reads
// and writes today's list files in today's folder, CONFIG_DIR/browser/lists/, in the same format: one file per list,
// `<list>.json`, `{"allow":[<host>...],"repo":"<owner>/<repo>"|null}` (agent-browser's own --allowlist format plus the
// key `repo`). The folder comes from the service's arguments (the unit gives it). A list with no file is empty.
//
// A list file that cannot be read applies as empty for its list only, with an error for the Browser pane; it never
// stops the other lists. An entry is never echoed or logged: the operator's own input comes back only in `change`'s
// refused list, to the operator. Only the owner of the Chrome unit writes the lists (the design, section 13.2), and Node
// runs one write at a time, so the service takes no lock.
//
// The old single list (Decision 4), CONFIG_DIR/browser/allowlist.json next to the lists folder, stays read only:
// nothing copies it, and no scope uses it. The service reads it only to show it.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { listNameFor, normalizeHost, normalizeRepo, SCOPE, EntryError } from "./hosts.ts";
import { parseJsonBytes, writeJson } from "./files.ts";

/** The error of a list file that is not JSON, not an object, or whose `allow` is not a list. */
export const DAMAGED_TEXT = "the list file cannot be read; it applies as empty";
/** The error of a list file whose `repo` is not the repo of the list's name. */
export const OTHER_REPO_TEXT = "the list file names another repo; that repo is left out";
/** The error of a list with entries that are not host names: one entry, and more. */
export const SKIPPED_ONE_TEXT = "1 entry of the list is not a valid host name and is left out";
export const SKIPPED_MANY_TEXT = "{count} entries of the list are not valid host names and are left out";
export const skippedText = (count: number) => (count === 1 ? SKIPPED_ONE_TEXT : SKIPPED_MANY_TEXT.replace("{count}", String(count)));

/** One list as it applies: its name, its repo, its normalized hosts and its error ("" when it has none). */
export type ListInfo = { name: string; repo: string | null; hosts: string[]; error: string };
/** An entry of `add` that the host rules refused, with the operator's own input and the reason. */
export type Refused = { entry: string; reason: string };

/** A list file that `change` cannot read: it stays as it is. */
export class ListDamagedError extends Error {
  constructor() { super("the list file cannot be read"); this.name = "ListDamagedError"; }
}

const isObj = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x);

/** The normalized hosts of `entries` (sorted, each once) and the count of refused entries. */
function hostsOf(entries: unknown[]): { hosts: string[]; skipped: number } {
  const hosts = new Set<string>();
  let skipped = 0;
  for (const e of entries) {
    try { hosts.add(normalizeHost(e)); } catch { skipped++; }
  }
  return { hosts: [...hosts].sort(), skipped };
}

/** The repo of the list `name` from the file's stored `repo`, and "" or the error (the file's name decides the list). */
function repoOf(name: string, stored: unknown): { repo: string | null; error: string } {
  if (stored === null || stored === undefined) return { repo: null, error: "" };
  const repo = normalizeRepo(stored);
  if (repo === null || listNameFor(repo) !== name) return { repo: null, error: OTHER_REPO_TEXT };
  return { repo, error: "" };
}

const joined = (...texts: string[]) => texts.filter((t) => t).join("; ");

type Loaded = { kind: "absent" } | { kind: "ok"; stored: unknown; allow: unknown[] } | { kind: "damaged"; stored?: unknown };

export class ListFiles {
  /** CONFIG_DIR/browser/lists, from the service's arguments. */
  readonly folder: string;
  /** The old single list, CONFIG_DIR/browser/allowlist.json (read only). */
  readonly oldFile: string;

  constructor(folder: string) {
    this.folder = folder;
    this.oldFile = join(dirname(folder), "allowlist.json");
  }

  /** The file of the list `name`; a name that is no scope name throws. */
  file(name: string): string {
    if (typeof name !== "string" || !SCOPE.test(name)) throw new Error("a list name must be a scope name");
    return join(this.folder, `${name}.json`);
  }

  /** The list `name` has a file (a regular file). */
  exists(name: string): boolean {
    try { return statSync(this.file(name)).isFile(); } catch { return false; }
  }

  private load(path: string): Loaded {
    let bytes: Buffer;
    try { bytes = readFileSync(path); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" }; return { kind: "damaged" }; }
    let data: unknown;
    try { data = parseJsonBytes(bytes); } catch { return { kind: "damaged" }; }
    if (!isObj(data)) return { kind: "damaged" };
    const stored = Object.hasOwn(data, "repo") ? data.repo : null;
    if (!Array.isArray(data.allow)) return { kind: "damaged", stored };
    return { kind: "ok", stored, allow: data.allow };
  }

  /**
   * The list `name` as it applies; never throws for the file's content. An absent file is an empty list; a file that
   * cannot be read is an empty list with DAMAGED_TEXT; an entry that the host rules refuse is left out and counted,
   * never echoed; a `repo` that is not the repo of `name` is left out (OTHER_REPO_TEXT). Errors join with "; ".
   */
  read(name: string): ListInfo {
    const l = this.load(this.file(name));
    if (l.kind === "absent") return { name, repo: null, hosts: [], error: "" };
    if (l.kind === "damaged") {
      const r = Object.hasOwn(l, "stored") ? repoOf(name, l.stored) : { repo: null, error: "" };
      return { name, repo: r.repo, hosts: [], error: joined(DAMAGED_TEXT, r.error) };
    }
    const r = repoOf(name, l.stored);
    const { hosts, skipped } = hostsOf(l.allow);
    return { name, repo: r.repo, hosts, error: joined(r.error, skipped ? skippedText(skipped) : "") };
  }

  /** Every list that has a file, sorted by name; [] with no lists folder. A folder that cannot be read throws. */
  loadAll(): ListInfo[] {
    let names: string[];
    try { names = readdirSync(this.folder); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
    return names.filter((f) => f.endsWith(".json") && SCOPE.test(f.slice(0, -5))).map((f) => f.slice(0, -5)).sort().map((n) => this.read(n));
  }

  /**
   * Add and remove hosts of the list `name`: the new sorted hosts and the refused additions (the operator's input as
   * given, with its reason; never log it). A removal that is invalid or not on the list is ignored. The file keeps only
   * the hosts that apply (agent-browser refuses a whole file for one bad entry). Its `repo` is the file's own repo when
   * it is the repo of `name`, else `repo` when that is the repo of `name`, else null. A file that cannot be read throws
   * ListDamagedError and stays as it is; a write that fails throws its error.
   */
  change(name: string, add: readonly string[], remove: readonly string[], repo: string | null = null): { allow: string[]; refused: Refused[] } {
    const path = this.file(name);
    const l = this.load(path);
    if (l.kind === "damaged") throw new ListDamagedError();
    const stored = l.kind === "ok" ? repoOf(name, l.stored).repo : null;
    const given = repo !== null && normalizeRepo(repo) === repo && listNameFor(repo) === name ? repo : null;
    const allow = new Set(l.kind === "ok" ? hostsOf(l.allow).hosts : []);
    const refused: Refused[] = [];
    for (const e of add) {
      try { allow.add(normalizeHost(e)); } catch (x) { refused.push({ entry: e, reason: (x as EntryError).reason }); }
    }
    for (const e of remove) {
      try { allow.delete(normalizeHost(e)); } catch {}
    }
    const result = [...allow].sort();
    writeJson(path, { allow: result, repo: stored ?? given });
    return { allow: result, refused };
  }

  /** The old single list, read only: its entries as stored, [] when its file is absent or damaged. */
  oldAllow(): string[] {
    try {
      const data = parseJsonBytes(readFileSync(this.oldFile));
      const allow = isObj(data) ? data.allow : null;
      return Array.isArray(allow) && allow.every((x) => typeof x === "string") ? [...allow] : [];
    } catch { return []; }
  }
}
