// The allowlist: the only hosts the tooling may open, attach to, read or click. A host matches itself
// and its subdomains; only http(s) URLs and about:blank pass. The package reads the consumer's file and
// never writes it, and no command or flag adds a host: an agent never widens the list on its own.
//
// The operator's list alone decides. There is no built-in denylist (the operator's decision O12): an
// entry may name a mail, account or admin host such as "gmail.com" or "accounts.google.com", and a
// broad entry such as "google.com" covers every one of its subdomains, mail.google.com included.

import { readFileSync } from "node:fs";
import { NotAllowedError, UsageError } from "./errors.ts";

const HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Check a list of allowlist entries: lowercase host names with at least one dot (or "localhost"), no
 * scheme, port, path or wildcard. A single label such as "com" would allow a whole top-level domain.
 */
export function validateAllowlist(entries: unknown, source = "allowlist"): string[] {
  if (!Array.isArray(entries)) throw new UsageError(`${source}: "allow" must be an array of host names`);
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
  return allow.some((d) => host === d || host.endsWith("." + d));
}

export function assertAllowedUrl(url: string, allow: readonly string[]): void {
  if (!isAllowedUrl(url, allow)) throw new NotAllowedError(url);
}
