// PageFetch's address rule (contract C11, "PageFetch"; the PageFetch design, docs/superpowers/specs/2026-11-15-page-fetch-
// design.md, section 5.4; board ab-v16.102). PageFetch has no allowlist, so it must never reach the box itself or a
// private network: only http(s) URLs; no loopback, private, link-local, carrier-grade NAT, unique local, multicast or
// unspecified address (also in an IPv4-mapped, IPv4-compatible or NAT64 form); no name that ends in .localhost, .local
// or .internal; and a name only when every address that the box's resolver gives for it passes.
//
// The URL's host comes from the WHATWG URL parser (the parser that Chrome uses), so each IPv4 spelling that Chrome takes
// (0x7f.1, 2130706433, 127.1) reaches this check as its dotted form, and an IPv6 literal as its bracketed short form.

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/** The box's resolver: every address of a name (getaddrinfo, as Chrome's own resolver on Linux). */
export type Resolve = (host: string) => Promise<string[]>;
export const systemResolve: Resolve = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

/** The refused IPv4 ranges: [first address, prefix length, the name in a refusal]. */
const V4: readonly (readonly [string, number, string])[] = [
  ["0.0.0.0", 8, "an unspecified address"],
  ["10.0.0.0", 8, "a private address"],
  ["100.64.0.0", 10, "a carrier-grade NAT address"],
  ["127.0.0.0", 8, "a loopback address"],
  ["169.254.0.0", 16, "a link-local address"],
  ["172.16.0.0", 12, "a private address"],
  ["192.168.0.0", 16, "a private address"],
  ["224.0.0.0", 4, "a multicast address"],
  ["240.0.0.0", 4, "a reserved address"],
];

function v4Number(ip: string): number {
  return ip.split(".").reduce((n, p) => n * 256 + Number(p), 0);
}

/** The 8 groups of an IPv6 address (with an embedded dotted IPv4 tail), or null. */
function v6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const pct = s.indexOf("%");
  if (pct >= 0) s = s.slice(0, pct);
  const tail = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail) {
    if (isIP(tail[2]) !== 4) return null;
    const n = v4Number(tail[2]);
    s = `${tail[1]}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const part = (h: string) => (h === "" ? [] : h.split(":").map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN)));
  const a = part(halves[0]), b = halves.length === 2 ? part(halves[1]) : [];
  if ([...a, ...b].some((g) => Number.isNaN(g))) return null;
  const fill = 8 - a.length - b.length;
  if (halves.length === 1 ? fill !== 0 : fill < 1) return null;
  return [...a, ...Array(halves.length === 2 ? fill : 0).fill(0), ...b];
}

/** Why an IPv4 address is refused, or null when it passes. */
function refusedV4(ip: string): string | null {
  const n = v4Number(ip);
  for (const [base, bits, why] of V4) {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if (((n & mask) >>> 0) === ((v4Number(base) & mask) >>> 0)) return why;
  }
  return null;
}

/** Why an IP address (no brackets) is refused, or null when it passes. Text that is no IP address is refused too. */
export function refusedIp(ip: string): string | null {
  const kind = isIP(ip.split("%")[0]);
  if (kind === 4) return refusedV4(ip);
  if (kind !== 6) return "no IP address";
  const g = v6Groups(ip);
  if (!g) return "no IP address";
  const zeros = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  const v4 = () => `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  if (zeros(0, 8)) return "an unspecified address";
  if (zeros(0, 7) && g[7] === 1) return "a loopback address";
  // ::ffff:a.b.c.d (IPv4-mapped), ::a.b.c.d (IPv4-compatible), 64:ff9b::a.b.c.d (NAT64) and ::ffff:0:a.b.c.d: the IPv4 address inside.
  if (zeros(0, 5) && (g[5] === 0xffff || g[5] === 0)) { const r = refusedV4(v4()); return r && `${r} in an IPv6 form`; }
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) { const r = refusedV4(v4()); return r && `${r} in an IPv6 form`; }
  if (zeros(0, 4) && g[4] === 0xffff && g[5] === 0) { const r = refusedV4(v4()); return r && `${r} in an IPv6 form`; }
  if ((g[0] & 0xfe00) === 0xfc00) return "a unique local address";
  if ((g[0] & 0xffc0) === 0xfe80) return "a link-local address";
  if ((g[0] & 0xffc0) === 0xfec0) return "a site-local address";
  if ((g[0] & 0xff00) === 0xff00) return "a multicast address";
  return null;
}

/** Why a host name (no IP address) is refused by its name alone, or null. */
export function refusedName(host: string): string | null {
  const h = host.toLowerCase().replace(/\.+$/, "");
  if (h === "") return "an empty host";
  if (h === "localhost" || h.endsWith(".localhost")) return "a name of the box itself";
  if (h === "local" || h.endsWith(".local")) return "a name of the local network";
  if (h === "internal" || h.endsWith(".internal")) return "a name of a private network";
  return null;
}

/** The host of a URL as the check reads it: an IPv6 literal without its brackets. */
export const hostOf = (u: URL) => (u.hostname.startsWith("[") ? u.hostname.slice(1, -1) : u.hostname);

/** A check's answer: the host passes, or the reason of its refusal (a plain phrase). */
export type HostCheck = { ok: true } | { ok: false; why: string };

/**
 * The check of one host: an IP literal by its range; a name by its name, then by every address that the resolver gives
 * (one refused address refuses the host; a name with no address is refused).
 */
export async function checkHost(host: string, resolve: Resolve): Promise<HostCheck> {
  if (isIP(host.split("%")[0]) !== 0) {
    const why = refusedIp(host);
    return why ? { ok: false, why: `${host} is ${why}` } : { ok: true };
  }
  const byName = refusedName(host);
  if (byName) return { ok: false, why: `${host} is ${byName}` };
  let all: string[];
  try { all = await resolve(host); } catch { all = []; }
  if (all.length === 0) return { ok: false, why: `the box's resolver gives no address for ${host}` };
  for (const a of all) {
    const why = refusedIp(a);
    if (why) return { ok: false, why: `${host} has ${why}` };
  }
  return { ok: true };
}

/** The schemes of a request that the check reads by its host; the schemes that make no network request pass. */
const NET_SCHEMES = new Set(["http:", "https:", "ws:", "wss:"]);
const LOCAL_SCHEMES = new Set(["data:", "blob:", "about:"]);

/**
 * The check of one URL. `main` (the URL that the agent gives) takes only http and https; a request of the page also
 * ws and wss by the same host rule, and data, blob and about with no check (they make no network request); every other
 * scheme is refused. `admit` (tests only: the live tests' one local server) passes a URL before the host check.
 */
export async function checkUrl(url: string, resolve: Resolve, o: { main?: boolean; admit?: (u: URL) => boolean } = {}): Promise<HostCheck> {
  let u: URL;
  try { u = new URL(url); } catch { return { ok: false, why: "the URL is not an absolute URL" }; }
  if (o.main ? u.protocol !== "http:" && u.protocol !== "https:" : !NET_SCHEMES.has(u.protocol) && !LOCAL_SCHEMES.has(u.protocol)) {
    return { ok: false, why: o.main ? "the URL must use http or https" : `the scheme ${u.protocol.slice(0, -1)} is not allowed` };
  }
  if (LOCAL_SCHEMES.has(u.protocol)) return { ok: true };
  if (o.admit?.(u)) return { ok: true };
  return checkHost(hostOf(u), resolve);
}
