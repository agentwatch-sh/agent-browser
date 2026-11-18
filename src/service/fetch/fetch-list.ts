// The entries of a fetch list (board ab-v16.113): PageFetch's strict mode, which `agent-browser page-fetch` always uses
// (src/page-fetch-cli.ts; the README, "PageFetch without agentwatch"). The call's URL and each request of the fetch
// window must match an entry. An entry is `host` (that exact host, no subdomain) or `host/path` (a path
// prefix that ends at a segment boundary). The host follows the host rules of list_set (hosts.ts: lowercase, an IDN as
// punycode, no IP literal, no port, no user name, no wildcard). A URL matches by the WHATWG URL parser, Chrome's parser:
// https only, the default port only, no user name and no password, the exact host, and a prefix of the parsed path (so
// dot segments, also %2e%2e, are resolved first, and a %2F is no "/"); the path is case-sensitive, and the query does
// not count. A reason never echoes the input.

import { EntryError, normalizeHost } from "../lists/hosts.ts";

/** The longest path of an entry, in characters. */
export const FETCH_PATH_MAX = 1024;

/** The normalized fetch entry of `input` (`host` or `host/path`), or an EntryError with the reason. */
export function normalizeFetchEntry(input: unknown): string {
  if (typeof input !== "string") throw new EntryError("the entry must be text");
  const s = input.trim();
  if (s === "") throw new EntryError("the entry is empty");
  if (s.includes("://")) throw new EntryError("give the entry with no scheme");
  if (/\s/.test(s)) throw new EntryError("whitespace is not allowed");
  const at = s.indexOf("/");
  if (at === 0) throw new EntryError("the entry must start with its host");
  // The host part takes the host rules of list_set, with their reasons (it holds no "/").
  const host = normalizeHost(at < 0 ? s : s.slice(0, at));
  let path = at < 0 ? "" : s.slice(at);
  // "host/" is the whole host.
  if (path === "/") path = "";
  if (path === "") return host;
  if (/[?#]/.test(path)) throw new EntryError("a query or a fragment is not allowed");
  if (path.includes("\\")) throw new EntryError("use / in a path");
  if (/\p{C}/u.test(path)) throw new EntryError("a control or invisible character is not allowed");
  if (/[^\x00-\x7f]/.test(path)) throw new EntryError("use the percent-encoded form of the path");
  if (path.length > FETCH_PATH_MAX) throw new EntryError("the path is too long");
  // The path as the WHATWG URL parser gives it: an entry with a dot segment (also %2e), or with a character that the
  // parser encodes, is refused, so that each entry is the form that a URL's path is compared with.
  let parsed: string;
  try { parsed = new URL(`https://${host}${path}`).pathname; } catch { throw new EntryError("the path is not valid"); }
  if (parsed !== path) throw new EntryError("the path has a dot segment or a character that a browser encodes");
  return `${host}${path}`;
}

/** The normalized entry, or null when the rules refuse it. */
export function fetchEntryOrNull(input: unknown): string | null {
  try { return normalizeFetchEntry(input); } catch { return null; }
}

/** True when the path `path` (a URL's parsed pathname) starts with the entry's path `prefix` at a segment boundary. */
function underPrefix(path: string, prefix: string): boolean {
  return prefix.endsWith("/") ? path.startsWith(prefix) : path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * True when one of the normalized `entries` matches `url`: an https URL on its default port, with no user name and no
 * password, whose host is the entry's host and whose parsed path starts with the entry's path at a segment boundary.
 */
export function fetchListAllows(entries: readonly string[], url: string | URL): boolean {
  let u: URL;
  try { u = typeof url === "string" ? new URL(url) : url; } catch { return false; }
  if (u.protocol !== "https:" || u.port !== "" || u.username !== "" || u.password !== "") return false;
  return entries.some((e) => {
    const at = e.indexOf("/");
    if ((at < 0 ? e : e.slice(0, at)) !== u.hostname) return false;
    return at < 0 || underPrefix(u.pathname, e.slice(at));
  });
}

/** An allow file that the command refuses: `reason` is the text for the caller (it never holds an entry). */
export class AllowFileError extends Error {
  readonly reason: string;
  constructor(reason: string) { super(reason); this.name = "AllowFileError"; this.reason = reason; }
}

/**
 * The entries of an allow file's text, `{"allow":["host","host/path",...]}`: each one by the entry rules, sorted, each
 * once. A text that is not that object, an entry that the rules refuse (the whole file fails, as one bad entry of
 * agent-browser's --allowlist fails it) and a list with no entry throw AllowFileError.
 */
export function parseAllowFile(text: string): string[] {
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new AllowFileError("the allow file is not JSON"); }
  if (data === null || typeof data !== "object" || Array.isArray(data) || !Array.isArray((data as { allow?: unknown }).allow)) throw new AllowFileError('the allow file is not {"allow":[<entry>...]}');
  const out = new Set<string>();
  ((data as { allow: unknown[] }).allow).forEach((e, i) => {
    try { out.add(normalizeFetchEntry(e)); } catch (x) { throw new AllowFileError(`entry ${i + 1} of the allow file is refused: ${(x as EntryError).reason}`); }
  });
  if (out.size === 0) throw new AllowFileError("the allow file has no entry, so nothing can be fetched");
  return [...out].sort();
}

/** The hosts of normalized entries, each once (for Chrome's host resolver rules). */
export const hostsOf = (entries: readonly string[]): string[] => [...new Set(entries.map((e) => (e.includes("/") ? e.slice(0, e.indexOf("/")) : e)))].sort();
