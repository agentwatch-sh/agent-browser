// The allowlist per scope (contract C4's set_scopes rules, C5's entries, applied to C10's allowlist line; C11, the
// scope's list; chrome-extension docs/protocol.md is the master). The daemon writes the object of each set_scopes that
// the receiver confirmed as one line: {"t":"allowlist","lists":{...},"scopes":{...},"default":...}. The relay applies
// the same rules to it as the receiver applies to set_scopes, so both sides have the same lists: the shared vector
// test/vectors/chrome-extension-<commit>/scopes.json checks both. The port follows chrome-extension's
// agent/scopes.js and shared/domains.js. With the peer check (board ab-v16.51) the line also carries each session's
// roots: parseRoots applies C11's rules for them (the scope's session, the roots in the line).
//
// The blanket scope (board ab-4wh.3): only the model of the service's blanket Chrome (the second agent Chrome, with its
// own empty profile) parses its lines with `blanket`; there a scope value "*" (C4's value of a blanket receiver) gives
// the scope the one-entry list ["*"], which covers every host of the blanket host class (../host-class.ts). Every other
// parse refuses "*" as before: a list name never matches it, and normalizeEntry refuses it as an entry.

import { ANY_HOST, publicHost } from "../host-class.ts";

/** A scope and a list name: C11's scope pattern. Every agentwatch session name matches it. */
export const SCOPE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/**
 * C11's remote scope (stage 5; board ab-v16.94.7.1): `<box>/<session>`, two names of the scope pattern with one `/`. A
 * local scope has no `/`, so the two never meet. SCOPE stays local: each list, sign-in or file name keeps it. Only the
 * scope and control code take this pattern (C12's shape step of set_sessions' `remote` items).
 */
export const REMOTE_SCOPE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** A local scope or a remote scope (C11). */
export const isAnyScope = (v: unknown): v is string => typeof v === "string" && (SCOPE.test(v) || REMOTE_SCOPE.test(v));
const isName = (v: unknown): v is string => typeof v === "string" && SCOPE.test(v);
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

const REFUSED = ["://", "/", "[", "]", ":", "*", "@"];

/** C5: the normalized form of an allowlist entry, or null when the entry is refused. */
export function normalizeEntry(input: unknown): string | null {
  if (typeof input !== "string") return null;
  let s = input.trim();
  if (s === "" || REFUSED.some((n) => s.includes(n)) || /\s/.test(s)) return null;
  if (s.endsWith(".")) s = s.slice(0, -1);
  if (s === "" || s.endsWith(".")) return null;
  if (/[\u0000-\u007f]/.test(s.replace(/[A-Za-z0-9.-]/g, ""))) return null;
  if (/\p{C}/u.test(s) || /[。．｡]/.test(s) || /[ßς]/.test(s)) return null;
  let host: string;
  try { host = new URL(`http://${s}`).hostname.toLowerCase(); } catch { return null; }
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.length === 0 || host.length > 253 || !/^[a-z0-9.-]+$/.test(host)) return null;
  const labels = host.split(".");
  if (labels.length < 2) return null;
  for (const l of labels) if (l.length < 1 || l.length > 63 || l.startsWith("-") || l.endsWith("-")) return null;
  return host;
}

/**
 * An entry covers itself and every subdomain (C5, O10). A blanket scope's "*" (only a `blanket` parse gives it) covers
 * each host of the blanket host class, and nothing else; an entry "!<name>" of its list (the line's `exclude`: the box's
 * own names) takes that name and each name under it out. normalizeEntry refuses "*" and "!", so no other list has them.
 */
export const covers = (entries: readonly string[], host: string) => {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (entries.some((d) => d.startsWith(EXCLUDE) && (h === d.slice(1) || h.endsWith(`.${d.slice(1)}`)))) return false;
  return entries.some((d) => (d === ANY_HOST ? publicHost(host) : host === d || host.endsWith(`.${d}`)));
};
/** The mark of an excluded name in a blanket scope's list ("!<name>"). */
export const EXCLUDE = "!";
/**
 * C4's `exclude` (the receiver 0.3.16, agent/scopes.js): at most MAX_EXCLUDE names of at most MAX_EXCLUDE_CHARS characters
 * in all (the names joined, dots counted); each name at most 253 characters, each label 1 to 63 of [a-z0-9_-] that does
 * not start or end with "-", and no IPv4 literal (digits and dots only). The service's names follow the same rules
 * (src/service/blanket/box-names.ts).
 */
export const MAX_EXCLUDE = 8;
export const MAX_EXCLUDE_CHARS = 512;
const EXCLUDE_LABEL = /^[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?$/;
export const isExcludeName = (v: unknown): v is string => typeof v === "string" && v.length <= 253 && v.split(".").every((l) => EXCLUDE_LABEL.test(l)) && !/^[0-9.]+$/.test(v);
export const goodExclude = (x: unknown): x is string[] => Array.isArray(x) && x.length <= MAX_EXCLUDE && x.join("").length <= MAX_EXCLUDE_CHARS && x.every(isExcludeName);
/**
 * A blanket-shaped object (C4; the receiver's review M6): `lists` an empty object, `default` null, `operator` absent or
 * null, `scopes` with one scope, and `exclude` absent or good. Only there does a local scope's "*" apply.
 */
const blanketShaped = (m: Record<string, unknown>) => isObject(m.lists) && Object.keys(m.lists).length === 0 && m.default === null
  && (!Object.hasOwn(m, "operator") || m.operator === null) && isObject(m.scopes) && Object.keys(m.scopes).length === 1
  && (!Object.hasOwn(m, "exclude") || goodExclude(m.exclude));
/** The list name and the one entry of a blanket scope's list in a `blanket` parse (never a name of the line's `lists`). */
export const BLANKET_LIST = ANY_HOST;

/** What applies of one allowlist line. A scope or list that applies as absent is not there. */
export class ScopeSet {
  readonly lists: ReadonlyMap<string, readonly string[]>;
  readonly scopes: ReadonlyMap<string, string | null>;
  readonly default: string | null;
  /** C4's count of what the rules refused (the receiver's answer carries it; the relay only logs it). */
  readonly refused: number;
  /** The line's `scopes` and `lists` are objects: only then does the relay drop the tabs of a scope with no list (C11). */
  readonly applied: boolean;
  /** With the peer check, a scope that `scopes` does not name has no list, whatever `default` says (C11, the scope's list). */
  readonly namedOnly: boolean;

  constructor(o: { lists: Map<string, string[]>; scopes: Map<string, string | null>; default: string | null; refused: number; applied: boolean; namedOnly?: boolean }) {
    this.lists = o.lists; this.scopes = o.scopes; this.default = o.default; this.refused = o.refused; this.applied = o.applied; this.namedOnly = o.namedOnly ?? false;
  }

  /**
   * A scope's list: its `scopes` entry when it has one (no fall-back to `default`), else `default` (with the peer check:
   * none); null when that list is not in `lists`. A remote scope that `scopes` does not name has no list: `default`
   * applies only to a local scope (C4, chrome-extension's C1; stage 5 T2, board ab-v16.94.7.3).
   */
  listOf(scope: string): string | null {
    const name = this.scopes.has(scope) ? this.scopes.get(scope)! : this.namedOnly || REMOTE_SCOPE.test(scope) ? null : this.default;
    return name !== null && this.lists.has(name) ? name : null;
  }

  /** The entries of a scope's list, or null for a scope with no list. */
  entriesOf(scope: string): readonly string[] | null {
    const name = this.listOf(scope);
    return name === null ? null : this.lists.get(name)!;
  }

  /** Every entry of every list: automatic downloads are allowed for each (C11). A blanket "*" is no host, so it is not one. */
  union(): string[] {
    return [...new Set([...this.lists.values()].flat())].filter((d) => d !== ANY_HOST && !d.startsWith(EXCLUDE));
  }
}

/**
 * C4's rules, applied to one allowlist line (or one set_scopes object). The relay ignores the line's `operator` field
 * (no connection sees a marked tab); `roots` is parseRoots's. `namedOnly`: the relay runs with the peer check, so a
 * scope that the line does not name gets no list (C11, the scope's list). `remote`: the model inside the service (stage 5
 * T2, board ab-v16.94.7.3) also applies the entry of a remote scope, `<box>/<session>`, whose list is the one that its
 * item names (C11); a list name keeps the local pattern, as C4's shared vector says since the receiver 0.3.10 (board
 * ab-v16.94.7.7). Without it (agentwatch's relay, which serves no remote scope: C11's 403) a remote scope applies as
 * absent and counts 1 (fail closed).
 */
export function parseScopes(msg: unknown, opts: { namedOnly?: boolean; remote?: boolean; blanket?: boolean } = {}): ScopeSet {
  const isScopeName = opts.remote ? isAnyScope : isName;
  const m = isObject(msg) ? msg : {};
  let refused = 0;
  const lists = new Map<string, string[]>();
  if (isObject(m.lists)) {
    for (const [name, v] of Object.entries(m.lists)) {
      // A list whose name does not match, or whose value is not an array, applies as absent: 1, and 1 more per entry.
      if (!isName(name) || !Array.isArray(v)) { refused += 1 + (Array.isArray(v) ? v.length : 0); continue; }
      // An entry that is not normalized is refused, and the other entries apply: so a bad entry never keeps a wider rule.
      const ok = v.filter((e): e is string => typeof e === "string" && normalizeEntry(e) === e);
      refused += v.length - ok.length;
      lists.set(name, ok);
    }
  } else refused += 1;
  const scopes = new Map<string, string | null>();
  if (isObject(m.scopes)) {
    for (const [scope, v] of Object.entries(m.scopes)) {
      if (!isScopeName(scope)) refused += 1; // applies as absent: no connection can name it (C11's 404)
      else if (v === null || isName(v)) scopes.set(scope, v);
      // The blanket Chrome's model only (board ab-4wh.3), as the receiver 0.3.16: "*" is the public host class of a local
      // scope of a blanket-shaped object, and its list is "*" with each name of `exclude` as "!<name>". Any other "*" (an
      // object of another shape, a bad `exclude`) counts 1 and applies as null: the scope has no list (fail closed).
      else if (opts.blanket && v === ANY_HOST && SCOPE.test(scope) && blanketShaped(m)) {
        const ex = Array.isArray(m.exclude) ? (m.exclude as string[]) : [];
        scopes.set(scope, BLANKET_LIST);
        lists.set(BLANKET_LIST, [ANY_HOST, ...new Set(ex.map((x) => `${EXCLUDE}${x}`))]);
      }
      else { refused += 1; scopes.set(scope, null); } // no list, and no fall-back to default
    }
  } else refused += 1;
  let def: string | null = null;
  if (isName(m.default)) def = m.default;
  else if (m.default !== null) refused += 1; // also a missing default
  // No scope gets the default list while the daemon's scopes are not known.
  if (!isObject(m.scopes)) def = null;
  if (Object.hasOwn(m, "operator") && m.operator !== null && m.operator !== "*" && !isName(m.operator)) refused += 1;
  return new ScopeSet({ lists, scopes, default: def, refused, applied: isObject(m.lists) && isObject(m.scopes), namedOnly: opts.namedOnly });
}

/** A session's root (C11, the scope's session): the pid of its tmux pane's process and that process's start time. */
export type Root = { readonly pid: number; readonly start: number };
/** The roots of one allowlist line that apply, by scope (also of a scope that `scopes` does not name). */
export type Roots = ReadonlyMap<string, readonly Root[]>;

/**
 * C11's rules for the line's `roots` (the scope's session, the roots in the line): a `roots` that is not an object
 * applies as an empty object; an entry whose scope does not match the scope pattern, or whose value is not a list,
 * applies as absent; an item that is not an object with an integer `pid` from 2 to 2^53 - 1 and an integer `start`
 * from 0 to 2^53 - 1 is dropped, and the other items of its list apply; the other fields of an item are ignored. A
 * root that one scope names twice is one root. A line with no `roots` field gives every scope no root.
 */
export function parseRoots(msg: unknown): Map<string, Root[]> {
  const out = new Map<string, Root[]>();
  const roots = isObject(msg) ? msg.roots : undefined;
  if (!isObject(roots)) return out;
  for (const [scope, v] of Object.entries(roots)) {
    if (!isName(scope) || !Array.isArray(v)) continue;
    const list: Root[] = [];
    for (const item of v) {
      if (!isObject(item)) continue;
      const { pid, start } = item;
      if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid < 2) continue;
      if (typeof start !== "number" || !Number.isSafeInteger(start) || start < 0) continue;
      if (!list.some((r) => r.pid === pid && r.start === start)) list.push({ pid, start });
    }
    out.set(scope, list);
  }
  return out;
}
