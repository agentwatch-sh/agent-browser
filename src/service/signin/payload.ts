// The sign-in payload (contract C2) and the box's own sign-in (stage 1c of the self-contained agent browser, board
// ab-v16.94.4; the design, section 5.1, "The sign-in import"): the port of agentwatch's daemon/browser/payload.py. The
// payload comes in the control door's `import` as an object (C12); the service checks it, takes out the box's own
// cookies, and gives the result to the receiver. Payloads stay in memory only: nothing here writes, and nothing here
// logs.
//
// A refusal names the field (`cookies[2].domain`), never a value: cookie values and page storage values are secrets.
// The box's own sign-in (agentwatch's Ruling 26): a payload whose `domain` covers a box host, or whose origin is on a
// box host, is refused (field `domain`). A cookie that a box host would receive, whose name is one of the box's cookie
// names, or whose name starts with BOX_COOKIE_PREFIX, is taken out and counted, never named. The box hosts and cookie
// names are the ones that agentwatch gives in set_sessions' `box` (C12).

import { isIP } from "node:net";
import { covers, hostOrNull } from "../lists/hosts.ts";

/** The largest payload, in bytes of compact JSON (32 MiB): C2's limit. */
export const MAX_SEND_BYTES = 33_554_432;
/** A cookie whose name starts with this is agentwatch's own: it never reaches the agent profile (today's rule). */
export const BOX_COOKIE_PREFIX = "agentwatch";
const SAME_SITE = new Set(["no_restriction", "lax", "strict", "unspecified"]);
const DEFAULT_PORTS: Readonly<Record<string, number>> = { http: 80, https: 443 };
// A host as a URL parser gives it: lowercase labels, two or more.
const HOST = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)+$/;
// A box host: one label or more ("localhost" is one).
const BOX_HOSTNAME = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/;
const BRACKETED = /^\[([0-9a-f:.]+)\](?::[0-9]{1,5})?$/;
const WITH_PORT = /^([^:]*):[0-9]{1,5}$/;
// What a browser's URL parser reads otherwise: a backslash (WHATWG takes it as "/"), and the ASCII control characters.
const URL_REFUSED = /[\\\x00-\x1f\x7f]/;

/** A payload that C2 or the box's rule refuses: the message names the field and never a value. */
export class PayloadError extends Error {
  readonly field: string;
  constructor(field: string) { super(`the sign-in send is not valid (field ${field})`); this.name = "PayloadError"; this.field = field; }
}
/** A payload over MAX_SEND_BYTES. */
export class TooLargeError extends Error {
  constructor() { super(`a sign-in send is at most ${MAX_SEND_BYTES} bytes`); this.name = "TooLargeError"; }
}

const refuse = (field: string): never => { throw new PayloadError(field); };
const isObj = (x: unknown): x is Record<string, any> => x !== null && typeof x === "object" && !Array.isArray(x);
const isNumber = (x: unknown) => typeof x === "number" && Number.isFinite(x);
const isInt = (x: unknown): x is number => Number.isSafeInteger(x);
const isKeyPath = (x: unknown) => x === null || typeof x === "string" || (Array.isArray(x) && x.every((s) => typeof s === "string"));
const isTextMap = (x: unknown) => isObj(x) && Object.values(x).every((v) => typeof v === "string");
const bare = (d: string) => (d.startsWith(".") ? d.slice(1) : d);

/** A box host as a bare hostname or IP address (lowercase; a port, the brackets of an IPv6 literal and one trailing dot removed), or null. */
function boxHost(item: unknown): string | null {
  if (typeof item !== "string") return null;
  let host = item.trim().toLowerCase();
  const b = BRACKETED.exec(host);
  if (b) return isIP(b[1]) === 6 ? b[1] : null;
  if (isIP(host) === 6) return host; // a bare IPv6 address: its colons are no port
  const p = WITH_PORT.exec(host);
  if (p) host = p[1];
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (isIP(host) === 4) return host;
  if (host.length > 253 || !BOX_HOSTNAME.test(host)) return null;
  return host;
}

/** The box hosts as bare hostnames or IP addresses, at least one; any other value is refused (field box_hosts). */
export function checkBoxHosts(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) refuse("box_hosts");
  return (value as unknown[]).map((item) => boxHost(item) ?? refuse("box_hosts"));
}

/**
 * The origin of an http or https URL as a browser writes it (lowercase host, no default port) and its host, or null. A
 * URL that a browser could read with another host is null: one with a backslash, an ASCII control character, or a user
 * name (`@`) in its authority. The parse follows Python's urlsplit, as agentwatch's check does.
 */
function originOf(value: unknown): [string, string] | null {
  if (typeof value !== "string" || URL_REFUSED.test(value)) return null;
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)/.exec(value);
  if (!m) return null;
  const scheme = m[1].toLowerCase(), netloc = m[2];
  if (!Object.hasOwn(DEFAULT_PORTS, scheme) || netloc.includes("@")) return null;
  const colon = netloc.indexOf(":");
  const host = (colon < 0 ? netloc : netloc.slice(0, colon)).toLowerCase();
  const portText = colon < 0 ? "" : netloc.slice(colon + 1);
  let port: number | null = null;
  if (portText !== "") {
    if (!/^[0-9]+$/.test(portText)) return null;
    port = Number(portText);
    if (port > 65535) return null;
  }
  if (!host || !HOST.test(host)) return null;
  if (port === DEFAULT_PORTS[scheme]) port = null;
  return [`${scheme}://${host}${port !== null ? `:${port}` : ""}`, host];
}

/** True when a box host would receive the cookie (cookie domain-match). */
function boxGets(c: Record<string, any>, hosts: readonly string[]): boolean {
  const domain = bare(c.domain).toLowerCase().replace(/\.+$/, "");
  return c.hostOnly ? hosts.includes(domain) : hosts.some((h) => covers(domain, h));
}

function checkCookie(c: unknown, at: string): Record<string, any> {
  if (!isObj(c)) refuse(at);
  const k = c as Record<string, any>;
  for (const key of ["name", "value", "domain", "path"]) if (typeof k[key] !== "string") refuse(`${at}.${key}`);
  for (const key of ["hostOnly", "secure", "httpOnly", "session"]) if (typeof k[key] !== "boolean") refuse(`${at}.${key}`);
  if (typeof k.sameSite !== "string" || !SAME_SITE.has(k.sameSite)) refuse(`${at}.sameSite`);
  if (!k.session && !isNumber(k.expirationDate)) refuse(`${at}.expirationDate`);
  if (Object.hasOwn(k, "partitionKey")) {
    const pk = k.partitionKey;
    if (!isObj(pk) || (Object.hasOwn(pk, "topLevelSite") && typeof pk.topLevelSite !== "string") || (Object.hasOwn(pk, "hasCrossSiteAncestor") && typeof pk.hasCrossSiteAncestor !== "boolean")) refuse(`${at}.partitionKey`);
  }
  return k;
}

function checkStore(s: unknown, at: string): void {
  if (!isObj(s)) refuse(at);
  const st = s as Record<string, any>;
  if (typeof st.name !== "string") refuse(`${at}.name`);
  if (!isKeyPath(st.keyPath)) refuse(`${at}.keyPath`);
  if (typeof st.autoIncrement !== "boolean") refuse(`${at}.autoIncrement`);
  if (!Array.isArray(st.indexes)) refuse(`${at}.indexes`);
  st.indexes.forEach((ix: unknown, i: number) => {
    const a = `${at}.indexes[${i}]`;
    if (!isObj(ix)) refuse(a);
    const x = ix as Record<string, any>;
    if (typeof x.name !== "string") refuse(`${a}.name`);
    if (!isKeyPath(x.keyPath)) refuse(`${a}.keyPath`);
    for (const key of ["unique", "multiEntry"]) if (typeof x[key] !== "boolean") refuse(`${a}.${key}`);
  });
  if (!Array.isArray(st.records)) refuse(`${at}.records`);
  st.records.forEach((r: unknown, i: number) => {
    const a = `${at}.records[${i}]`;
    if (!isObj(r)) refuse(a);
    for (const key of ["key", "value"]) {
      const v = (r as Record<string, any>)[key];
      if (!isObj(v) || typeof v.t !== "string") refuse(`${a}.${key}`);
    }
  });
}

function checkStorage(s: unknown): Record<string, any> {
  if (!isObj(s)) refuse("storage");
  const st = s as Record<string, any>;
  for (const area of ["local", "session"]) if (!isTextMap(st[area])) refuse(`storage.${area}`);
  if (!Array.isArray(st.idb)) refuse("storage.idb");
  st.idb.forEach((db: unknown, i: number) => {
    const at = `storage.idb[${i}]`;
    if (!isObj(db)) refuse(at);
    const d = db as Record<string, any>;
    if (typeof d.name !== "string") refuse(`${at}.name`);
    if (!isInt(d.version) || d.version < 1) refuse(`${at}.version`);
    if (!Array.isArray(d.stores)) refuse(`${at}.stores`);
    d.stores.forEach((s2: unknown, j: number) => checkStore(s2, `${at}.stores[${j}]`));
  });
  if (!Array.isArray(st.caches)) refuse("storage.caches");
  st.caches.forEach((c: unknown, i: number) => {
    const at = `storage.caches[${i}]`;
    if (!isObj(c)) refuse(at);
    const ca = c as Record<string, any>;
    if (typeof ca.name !== "string") refuse(`${at}.name`);
    if (!Array.isArray(ca.entries)) refuse(`${at}.entries`);
    ca.entries.forEach((e: unknown, j: number) => {
      const a = `${at}.entries[${j}]`;
      if (!isObj(e)) refuse(a);
      const en = e as Record<string, any>;
      if (typeof en.url !== "string") refuse(`${a}.url`);
      if (!isInt(en.status)) refuse(`${a}.status`);
      if (!Array.isArray(en.headers) || !en.headers.every((h: unknown) => Array.isArray(h) && h.length === 2 && h.every((x) => typeof x === "string"))) refuse(`${a}.headers`);
      if (typeof en.body !== "string") refuse(`${a}.body`);
    });
  });
  return st;
}

/** A number that is not finite anywhere in the payload (1e400 in the line parses as Infinity): JSON has none, so it is refused. */
function hasNonFinite(root: unknown): boolean {
  const todo: unknown[] = [root];
  while (todo.length) {
    const v = todo.pop();
    if (typeof v === "number" && !Number.isFinite(v)) return true;
    if (v !== null && typeof v === "object") for (const x of Array.isArray(v) ? v : Object.values(v)) todo.push(x);
  }
  return false;
}

export type SignInState = { v: 1; domain: string; url: string; origin: string; cookies: Record<string, any>[]; storage: Record<string, any> };

/**
 * Check a payload (C2) and the box's own sign-in: the payload without the box's cookies, and the count of those taken
 * out. Throws TooLargeError over MAX_SEND_BYTES and PayloadError (naming the field) for anything C2 or the box's rule
 * refuses. The input is not changed.
 */
export function checkPayload(payload: unknown, boxHosts: unknown, boxCookieNames: readonly string[]): { state: SignInState; dropped: number } {
  if (Buffer.byteLength(JSON.stringify(payload) ?? "") > MAX_SEND_BYTES) throw new TooLargeError();
  const hosts = checkBoxHosts(boxHosts);
  if (!isObj(payload) || hasNonFinite(payload)) refuse("body");
  const data = payload as Record<string, any>;
  if (!isInt(data.v) || data.v !== 1) refuse("v");
  const domain = data.domain;
  if (typeof domain !== "string") refuse("domain");
  if (hostOrNull(domain) !== domain || hosts.some((h) => covers(domain, h))) refuse("domain");
  const origin = originOf(data.origin);
  if (origin === null || origin[0] !== data.origin || !covers(domain, origin[1])) refuse("origin");
  if (hosts.includes(origin![1])) refuse("domain");
  const urlOrigin = originOf(data.url);
  if (urlOrigin === null || urlOrigin[0] !== data.origin) refuse("url");
  if (!Array.isArray(data.cookies)) refuse("cookies");
  const kept: Record<string, any>[] = [];
  let dropped = 0;
  (data.cookies as unknown[]).forEach((raw, i) => {
    const at = `cookies[${i}]`;
    const c = checkCookie(raw, at);
    if (boxCookieNames.includes(c.name) || c.name.startsWith(BOX_COOKIE_PREFIX) || boxGets(c, hosts)) { dropped++; return; }
    if (!covers(domain, bare(c.domain))) refuse(`${at}.domain`);
    kept.push(c);
  });
  const storage = checkStorage(data.storage);
  return { state: { v: 1, domain, url: data.url, origin: data.origin, cookies: kept, storage }, dropped };
}
