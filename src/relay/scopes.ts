// The allowlist per scope (contract C4's set_scopes rules, C5's entries, applied to C10's allowlist line; C11, the
// scope's list; chrome-extension docs/protocol.md is the master). The daemon writes the object of each set_scopes that
// the receiver confirmed as one line: {"t":"allowlist","lists":{...},"scopes":{...},"default":...}. The relay applies
// the same rules to it as the receiver applies to set_scopes, so both sides have the same lists: the shared vector
// test/vectors/chrome-extension-<commit>/scopes.json checks both. The port follows chrome-extension's
// agent/scopes.js and shared/domains.js.

/** A scope and a list name: C11's scope pattern. Every agentwatch session name matches it. */
export const SCOPE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
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

/** An entry covers itself and every subdomain (C5, O10). */
export const covers = (entries: readonly string[], host: string) => entries.some((d) => host === d || host.endsWith(`.${d}`));

/** What applies of one allowlist line. A scope or list that applies as absent is not there. */
export class ScopeSet {
  readonly lists: ReadonlyMap<string, readonly string[]>;
  readonly scopes: ReadonlyMap<string, string | null>;
  readonly default: string | null;
  /** C4's count of what the rules refused (the receiver's answer carries it; the relay only logs it). */
  readonly refused: number;
  /** The line's `scopes` and `lists` are objects: only then does the relay drop the tabs of a scope with no list (C11). */
  readonly applied: boolean;

  constructor(o: { lists: Map<string, string[]>; scopes: Map<string, string | null>; default: string | null; refused: number; applied: boolean }) {
    this.lists = o.lists; this.scopes = o.scopes; this.default = o.default; this.refused = o.refused; this.applied = o.applied;
  }

  /** A scope's list: its `scopes` entry when it has one (no fall-back to `default`), else `default`; null when that list is not in `lists`. */
  listOf(scope: string): string | null {
    const name = this.scopes.has(scope) ? this.scopes.get(scope)! : this.default;
    return name !== null && this.lists.has(name) ? name : null;
  }

  /** The entries of a scope's list, or null for a scope with no list. */
  entriesOf(scope: string): readonly string[] | null {
    const name = this.listOf(scope);
    return name === null ? null : this.lists.get(name)!;
  }

  /** Every entry of every list: automatic downloads are allowed for each (C11). */
  union(): string[] {
    return [...new Set([...this.lists.values()].flat())];
  }
}

/**
 * C4's rules, applied to one allowlist line (or one set_scopes object). The relay ignores the line's `operator` field
 * (no connection sees a marked tab), and `roots` (the peer check, board ab-v16.51).
 */
export function parseScopes(msg: unknown): ScopeSet {
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
      if (!isName(scope)) refused += 1; // applies as absent: no connection can name it (C11's 404)
      else if (v === null || isName(v)) scopes.set(scope, v);
      else { refused += 1; scopes.set(scope, null); } // no list, and no fall-back to default
    }
  } else refused += 1;
  let def: string | null = null;
  if (isName(m.default)) def = m.default;
  else if (m.default !== null) refused += 1; // also a missing default
  // No scope gets the default list while the daemon's scopes are not known.
  if (!isObject(m.scopes)) def = null;
  if (Object.hasOwn(m, "operator") && m.operator !== null && m.operator !== "*" && !isName(m.operator)) refused += 1;
  return new ScopeSet({ lists, scopes, default: def, refused, applied: isObject(m.lists) && isObject(m.scopes) });
}
