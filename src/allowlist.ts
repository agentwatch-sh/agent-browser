// The allowlist: the only hosts the tooling may open, attach to, read or click. A host matches itself
// and its subdomains; only http(s) URLs and about:blank pass. The package reads the consumer's file and
// never writes it, and no command or flag adds a host: an agent never widens the list on its own.
//
// The operator's list alone decides. There is no built-in denylist (the operator's decision O12): an
// entry may name a mail, account or admin host such as "gmail.com" or "accounts.google.com", and a
// broad entry such as "google.com" covers every one of its subdomains, mail.google.com included.

import { readFileSync } from "node:fs";
import { NotAllowedError, UsageError } from "./errors.ts";
import { ANY_HOST, publicHost } from "./host-class.ts";
import { covers, normalizeEntry } from "./relay/scopes.ts";

const HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Check a list of allowlist entries: lowercase host names with at least one dot (or "localhost"), no
 * scheme, port, path or wildcard. A single label such as "com" would allow a whole top-level domain.
 * The one exception is a blanket scope's list (board ab-4wh.3): agentwatch writes {"allow":["*"]} into the list copy
 * of the one session with a blanket approval. "*" stands alone: it is every http(s) host of the blanket host class
 * (host-class.ts: no IP literal, localhost, *.localhost, single-label name, .local, .internal or .home.arpa), never a
 * host pattern, and a list that holds "*" with any other entry is refused.
 */
export function validateAllowlist(entries: unknown, source = "allowlist"): string[] {
  if (!Array.isArray(entries)) throw new UsageError(`${source}: "allow" must be an array of host names`);
  if (entries.length === 1 && entries[0] === ANY_HOST) return [ANY_HOST];
  return entries.map((e) => {
    if (typeof e !== "string") throw new UsageError(`${source}: every entry must be a string`);
    const h = e.trim();
    if (h !== "localhost" && !HOST.test(h)) throw new UsageError(`${source}: ${JSON.stringify(e)} is not a lowercase host name with a dot (no scheme, port, path or wildcard)`);
    return h;
  });
}

/** Read `{ "allow": [...] }` from the consumer's file. */
export function loadAllowlist(file: string): string[] {
  let cfg: unknown;
  try { cfg = JSON.parse(readFileSync(file, "utf8")); }
  catch (e) { throw new UsageError(`cannot read the allowlist ${file}: ${(e as Error).message}`); }
  return validateAllowlist((cfg as { allow?: unknown } | null)?.allow, file);
}

export function isAllowedUrl(url: string, allow: readonly string[]): boolean {
  if (url === "about:blank") return true;
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  const host = u.hostname.toLowerCase();
  // A blanket scope's "*" (validateAllowlist): every host of the class, never a local or IP host.
  return allow.some((d) => (d === ANY_HOST ? publicHost(host) : host === d || host.endsWith("." + d)));
}

/**
 * Whether the extension that guards the agent browser covers `host` (a URL's hostname) for a tab of this list: the
 * receiver's rule (chrome-extension agent/guard.js covered, agent/scopes.js listCovers), not isAllowedUrl's. The
 * receiver keeps only the entries that C5 writes as they are; validateAllowlist also takes "localhost", an IPv4
 * address (test/vectors/chrome-extension-83fd4c3/scopes.json refuses both) and a name of more than 253 characters.
 * So the entries here are the ones that the relay's port of C5 keeps (relay/scopes.ts normalizeEntry, checked on
 * those vectors), and covers() judges as the receiver does: an entry covers itself and each name under it, "*" the
 * public host class (host-class.ts). The record of a blocked navigation judges so (Tab.watchNavigations; board
 * ab-81e, from the code of the pinned receiver). Two gaps stay, both of a blanket list: its copy here is
 * {"allow":["*"]}, without the box's own names (C4's exclude), which the guard refuses; and the receiver's public
 * class has no length limit of a name or a label, which publicHost has (only a name that DNS cannot resolve is that
 * long).
 */
export function guardCovers(host: string, allow: readonly string[]): boolean {
  return covers(allow.filter((d) => d === ANY_HOST || normalizeEntry(d) === d), host);
}

export function assertAllowedUrl(url: string, allow: readonly string[]): void {
  if (!isAllowedUrl(url, allow)) throw new NotAllowedError(url);
}

/**
 * Keep the scheme rules here. Behind agent mode's endpoint (relayNavigation: every caller since board ab-v16.9.3) an
 * http(s) navigation's host decision belongs to the relay, which enforces the scope's list and reports refusals to
 * agentwatch.
 */
export function assertNavigationUrl(url: string, allow: readonly string[], relayNavigation = false): void {
  if (relayNavigation) {
    let parsed: URL | undefined;
    try { parsed = new URL(url); } catch { /* The local refusal below keeps the existing code and text. */ }
    if (parsed && (["http:", "https:"].includes(parsed.protocol)
      || (parsed.protocol === "blob:" && /^https?:\/\//.test(parsed.origin)))) return;
  }
  assertAllowedUrl(url, allow);
}
