// The allowlist: the only hosts the tooling may open, attach to, read or click. A host matches itself
// and its subdomains; only http(s) URLs and about:blank pass. The package reads the consumer's file and
// never writes it, and no command or flag adds a host: an agent never widens the list on its own.
//
// A short denylist backs it up: mail, account and admin hosts are refused even when a broad entry
// (for example "google.com") would cover them, and an allowlist that names one is rejected.

import { readFileSync } from "node:fs";
import { NotAllowedError, UsageError } from "./errors.ts";

/** Mail, account and admin consoles that no allowlist entry can open. Each matches itself and its subdomains. */
export const DENIED_HOSTS: readonly string[] = [
  "gmail.com", "mail.google.com", "inbox.google.com", "accounts.google.com", "myaccount.google.com", "admin.google.com",
  "console.cloud.google.com", "outlook.live.com", "outlook.office.com", "outlook.office365.com", "mail.yahoo.com",
  "mail.proton.me", "account.proton.me", "console.aws.amazon.com", "signin.aws.amazon.com", "portal.azure.com",
  "dash.cloudflare.com",
];

/** A host whose first label is one of these (mail.example.com, admin.example.com) is refused. */
export const DENIED_FIRST_LABELS: readonly string[] = ["mail", "webmail", "admin", "bank", "banking", "onlinebanking", "netbanking"];

export function isDeniedHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (DENIED_FIRST_LABELS.includes(h.split(".")[0])) return true;
  return DENIED_HOSTS.some((d) => h === d || h.endsWith("." + d));
}

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
    if (isDeniedHost(h)) throw new UsageError(`${source}: ${h} is a mail, account or admin host and can never be allowlisted`);
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
  if (isDeniedHost(host)) return false;
  return allow.some((d) => host === d || host.endsWith("." + d));
}

export function assertAllowedUrl(url: string, allow: readonly string[]): void {
  if (!isAllowedUrl(url, allow)) throw new NotAllowedError(url);
}
