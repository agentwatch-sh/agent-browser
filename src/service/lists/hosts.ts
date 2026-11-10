// The host rules and the list names of the service (stage 1c of the self-contained agent browser, board ab-v16.94.4;
// the design docs/superpowers/specs/2026-11-09-self-contained-agent-browser-design.md, sections 5.1 and 7.4). The port
// of agentwatch's browser_hosts.py (`normalize_entry`, `covers`) and browser_lists.py (the repo rule and the list
// names): the service is the one checker of hosts, lists and scopes, and the pane shows its answers.
//
// `normalizeHost` is the twin of chrome-extension's `normalizeEntry` (shared/domains.js) with the same reason texts, as
// agentwatch's is. One difference is on purpose (agentwatch's Ruling 20): it takes ASCII entries only and refuses any
// other character with "use the punycode form", because the web viewer converts a pasted Unicode host with the
// browser's own URL parser before it sends the entry. A reason never echoes the input.

import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { SCOPE } from "../../relay/scopes.ts";

export { SCOPE };

/** An entry that the host rules refuse; `reason` is the text for the operator (it never holds the entry). */
export class EntryError extends Error {
  readonly reason: string;
  constructor(reason: string) { super(reason); this.name = "EntryError"; this.reason = reason; }
}

const REFUSED: readonly (readonly [string, string])[] = [
  ["://", "paste the host only"], ["/", "paste the host only"], ["[", "an IP address is not allowed"],
  ["]", "an IP address is not allowed"], [":", "a port is not allowed"], ["*", "a wildcard is not allowed"],
  ["@", "a user name is not allowed"],
];
const ALLOWED_ASCII = /^[A-Za-z0-9.-]$/;
const NUMERIC_LABEL = /^(?:[0-9]+|0x[0-9a-f]*)$/;
const IPV4_LOOK = /^\d{1,3}(\.\d{1,3}){3}$/;
const HOST_OK = /^[a-z0-9.-]+$/;
const LABEL_OK = /^[a-z0-9-]+$/;

/** One part of a WHATWG IPv4 address (decimal, 0octal or 0xhex), or null. */
function ipv4Number(part: string): number | null {
  if (part === "") return null;
  let base = 10;
  if (part.length >= 2 && part.startsWith("0x")) { part = part.slice(2); base = 16; }
  else if (part.length >= 2 && part[0] === "0") { part = part.slice(1); base = 8; }
  if (part === "") return 0;
  const digits = base === 16 ? /^[0-9a-f]+$/ : base === 8 ? /^[0-7]+$/ : /^[0-9]+$/;
  return digits.test(part) ? parseInt(part, base) : null;
}

/** Whether the WHATWG IPv4 parser takes these labels. */
function ipv4Parses(parts: string[]): boolean {
  if (parts.length > 4) return false;
  const nums = parts.map(ipv4Number);
  if (nums.some((n) => n === null)) return false;
  const values = nums as number[];
  if (values.slice(0, -1).some((n) => n > 255)) return false;
  return values[values.length - 1] < 256 ** (5 - values.length);
}

/** The normalized host of an allowlist entry (C5), or an EntryError with the reason. */
export function normalizeHost(input: unknown): string {
  if (typeof input !== "string") throw new EntryError("the entry must be text");
  // JavaScript's trim and \s are the set of the reference (ECMAScript WhiteSpace and LineTerminator).
  let s = input.trim();
  if (s === "") throw new EntryError("the entry is empty");
  for (const [needle, reason] of REFUSED) if (s.includes(needle)) throw new EntryError(reason);
  if (/\s/.test(s)) throw new EntryError("whitespace is not allowed");
  if (s.endsWith(".")) s = s.slice(0, -1);
  if (s === "" || s.endsWith(".")) throw new EntryError("the host ends with extra dots");
  for (const c of s) if (c.charCodeAt(0) < 128 && !ALLOWED_ASCII.test(c)) throw new EntryError("a character is not allowed");
  if (/\p{C}/u.test(s)) throw new EntryError("a control or invisible character is not allowed");
  if (/[。．｡]/.test(s)) throw new EntryError("use a plain dot between labels");
  if (/[^\x00-\x7f]/.test(s)) throw new EntryError("use the punycode form");
  const labels = s.toLowerCase().split(".");
  const host = labels.join(".");
  if (NUMERIC_LABEL.test(labels[labels.length - 1])) {
    // As the WHATWG URL parser: a last label of digits or 0x hex is an IPv4 address, or the URL does not parse.
    if (ipv4Parses(labels)) throw new EntryError("an IP address is not allowed");
    throw new EntryError("the host is not valid");
  }
  if (IPV4_LOOK.test(host) || isIP(host) !== 0) throw new EntryError("an IP address is not allowed");
  if (labels.some((l) => l === "")) throw new EntryError("a label is empty");
  if (host.length === 0 || host.length > 253) throw new EntryError("the host is too long");
  if (!HOST_OK.test(host)) throw new EntryError("the host is not valid");
  if (labels.length < 2) throw new EntryError("the host needs at least two labels");
  for (const l of labels) {
    if (l.length < 1 || l.length > 63) throw new EntryError("a label must be 1 to 63 characters");
    if (!LABEL_OK.test(l)) throw new EntryError("a label has a character that is not allowed");
    if (l.startsWith("-") || l.endsWith("-")) throw new EntryError("a label must not start or end with a hyphen");
  }
  return host;
}

/** The normalized host, or null when the host rules refuse it. */
export function hostOrNull(input: unknown): string | null {
  try { return normalizeHost(input); } catch { return null; }
}

/** An entry covers itself and every subdomain. */
export const covers = (entry: string, host: string) => host === entry || host.endsWith(`.${entry}`);
/** One entry of `entries` covers `host`. */
export const coveredBy = (entries: readonly string[], host: string) => entries.some((e) => covers(e, host));

/** The list of every session outside a GitHub repo. */
export const NO_REPO = "no-repo";
/**
 * The list of a session whose repo the daemon cannot read yet: always empty (it fails closed), and no file of that name
 * is read. No repo's list has this name: a repo's list holds a "." or is "r-" and 16 hex digits.
 */
export const UNREAD_LIST = "unread-repo";
/** A GitHub `owner/repo`, lowercase. */
export const REPO = /^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9._-]{1,100}$/;

/** `text` as a lowercase `owner/repo`, or null when it has another shape. */
export function normalizeRepo(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const repo = text.trim().toLowerCase();
  return REPO.test(repo) ? repo : null;
}

/**
 * The name of the list of `repo` (`no-repo` for null): `o.r` when that is a scope name (GitHub owners hold no ".", so the
 * first "." splits the name), else `r-` and the first 16 hex digits of the SHA-256 of `o/r`. `repo` must be normalized:
 * two spellings of one repo never name two lists.
 */
export function listNameFor(repo: string | null): string {
  if (repo === null) return NO_REPO;
  if (normalizeRepo(repo) !== repo) throw new Error("the repo must be a normalized owner/repo");
  const at = repo.indexOf("/");
  const dotted = `${repo.slice(0, at)}.${repo.slice(at + 1)}`;
  return SCOPE.test(dotted) ? dotted : `r-${createHash("sha256").update(repo).digest("hex").slice(0, 16)}`;
}
