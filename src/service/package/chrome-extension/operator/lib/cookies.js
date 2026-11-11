// Cookie conversions (contracts C2 and C6 step 1). ES module; never injected into a page.
import { covers } from "./domains.js";

function bareDomain(c) {
  return c.domain.replace(/^\./, "");
}

function cookieUrl(c) {
  return (c.secure ? "https://" : "http://") + bareDomain(c) + c.path;
}

function copyPartition(pk) {
  const out = { topLevelSite: pk.topLevelSite };
  if (pk.hasCrossSiteAncestor !== undefined) out.hasCrossSiteAncestor = pk.hasCrossSiteAncestor;
  return out;
}

// One cookie in Chrome's store: name, domain, path and the whole partition
// key. Two partitioned cookies that differ only in hasCrossSiteAncestor are
// two cookies.
export function cookieKey(c) {
  const pk = c.partitionKey;
  const ancestor = pk?.hasCrossSiteAncestor === undefined ? "" : String(pk.hasCrossSiteAncestor);
  return [c.name, c.domain.toLowerCase(), c.path, pk?.topLevelSite ?? "", ancestor].join("\u0000");
}

export function toSetDetails(c) {
  const d = {
    url: cookieUrl(c),
    name: c.name,
    value: c.value,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    sameSite: c.sameSite,
  };
  if (!c.hostOnly) d.domain = c.domain;
  if (!c.session) d.expirationDate = c.expirationDate;
  if (c.partitionKey) d.partitionKey = copyPartition(c.partitionKey);
  return d;
}

export function toRemoveDetails(c) {
  const d = { url: cookieUrl(c), name: c.name };
  if (c.partitionKey) d.partitionKey = copyPartition(c.partitionKey);
  return d;
}

export function inScope(c, domain) {
  return covers(domain, bareDomain(c).toLowerCase());
}

export function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const c of list) {
    const k = cookieKey(c);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}
