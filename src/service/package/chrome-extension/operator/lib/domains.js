// Allowlist entry rules (contract C5). ES module; never injected into a page.

const REFUSED = [
  ["://", "paste the host only"],
  ["/", "paste the host only"],
  ["[", "an IP address is not allowed"],
  ["]", "an IP address is not allowed"],
  [":", "a port is not allowed"],
  ["*", "a wildcard is not allowed"],
  ["@", "a user name is not allowed"],
];

function fail(reason) {
  return { ok: false, reason };
}

export function normalizeEntry(input) {
  if (typeof input !== "string") return fail("the entry must be text");
  let s = input.trim();
  if (s === "") return fail("the entry is empty");
  for (const [needle, reason] of REFUSED) {
    if (s.includes(needle)) return fail(reason);
  }
  if (/\s/.test(s)) return fail("whitespace is not allowed");
  if (s.endsWith(".")) s = s.slice(0, -1);
  if (s === "" || s.endsWith(".")) return fail("the host ends with extra dots");
  if (/[\u0000-\u007f]/.test(s.replace(/[A-Za-z0-9.-]/g, ""))) return fail("a character is not allowed");
  if (/\p{C}/u.test(s)) return fail("a control or invisible character is not allowed");
  if (/[\u3002\uff0e\uff61]/.test(s)) return fail("use a plain dot between labels");
  if (/[\u00df\u03c2]/.test(s)) return fail("use the punycode form");
  let host;
  try {
    host = new URL("http://" + s).hostname;
  } catch {
    return fail("the host is not valid");
  }
  host = host.toLowerCase();
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return fail("an IP address is not allowed");
  if (host.length === 0 || host.length > 253) return fail("the host is too long");
  if (!/^[a-z0-9.-]+$/.test(host)) return fail("the host is not valid");
  const labels = host.split(".");
  if (labels.some((l) => l === "")) return fail("a label is empty");
  if (labels.length < 2) return fail("the host needs at least two labels");
  for (const label of labels) {
    if (label.length < 1 || label.length > 63) return fail("a label must be 1 to 63 characters");
    if (!/^[a-z0-9-]+$/.test(label)) return fail("a label has a character that is not allowed");
    if (label.startsWith("-") || label.endsWith("-")) return fail("a label must not start or end with a hyphen");
  }
  return { ok: true, entry: host };
}

export function covers(entry, host) {
  return host === entry || host.endsWith("." + entry);
}

export function domainCandidates(host) {
  const labels = host.split(".");
  if (labels.length < 2) return [host];
  const out = [];
  for (let i = 0; i <= labels.length - 2; i++) out.push(labels.slice(i).join("."));
  return out;
}

export function fallbackDomain(host) {
  const labels = host.split(".");
  return labels.length <= 2 ? host : labels.slice(-2).join(".");
}
