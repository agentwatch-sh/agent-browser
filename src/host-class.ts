// The host class of a blanket scope's "*" (board ab-4wh.3; C4's scope value "*" of a receiver whose hello has the feature
// `blanket`; C12's set_sessions item with "blanket": true). The operator gives ONE local session a blanket approval: its
// agent may open any public host, in a second agent Chrome with its own empty profile. "*" never means every host: it is
// every http(s) host of one class, the same class on each side (the receiver's guard at top level, the relay's layer 1,
// agent-browser's client). A host is in the class when it is a DNS name of at least two labels, and it is NOT:
//
// - an IP literal (IPv4 in any form that the URL parser turns into a dotted quad, IPv6 in brackets);
// - localhost or a name under it (*.localhost);
// - a single-label name (an intranet name, a top-level domain);
// - a name of .local, .localdomain, .internal or .home.arpa, or one of these names itself (`localhost.localdomain`
//   resolves to loopback on many Linux boxes).
//
// The host is one that the WHATWG URL parser made canonical (a URL's hostname): each IPv4 spelling is a dotted quad there
// (`0x7f.0x1` is 127.0.0.1), so this file never judges a raw string. A label has the receiver's characters, [a-z0-9_-].
// The blanket link's set_scopes also names the box's own names (`exclude`): the receiver and the relay refuse them too
// (scopes.ts). Chrome's own Local Network Access guards the subresources; the service's blanket model also checks the
// addresses of a navigation's host with DNS (PageFetch's address rule), before the bridge.

/** The one entry of a blanket scope's list: every host of the class (C4's "*"). */
export const ANY_HOST = "*";

/** The suffixes of local names: the name itself and each name under it are off the class. */
const LOCAL_SUFFIXES = ["localhost", "local", "localdomain", "internal", "home.arpa"] as const;

/** True when `host` (a URL's hostname) is in the blanket scope's host class (see above). */
export function publicHost(host: string): boolean {
  if (typeof host !== "string") return false;
  let h = host.toLowerCase();
  // A trailing dot names the same host for DNS: the class decides on the name without it ("localhost." stays local).
  if (h.endsWith(".")) h = h.slice(0, -1);
  if (h.length === 0 || h.length > 253) return false;
  // An IPv6 literal (with or without its brackets) and any name with a character that a DNS name never has.
  if (!/^[a-z0-9._-]+$/.test(h)) return false;
  const labels = h.split(".");
  if (labels.length < 2 || labels.some((l) => l.length === 0 || l.length > 63)) return false;
  // An IPv4 literal: the URL parser turns each IPv4 form into a dotted quad; a last label of digits (or 0x...) is a number.
  if (/^(?:\d+|0x[0-9a-f]*)$/.test(labels[labels.length - 1])) return false;
  for (const s of LOCAL_SUFFIXES) if (h === s || h.endsWith(`.${s}`)) return false;
  return true;
}

/** True when the URL is http(s) and its host is in the class (`blob:` takes its inner origin). */
export function publicUrl(url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol === "blob:") { try { u = new URL(url.slice("blob:".length)); } catch { return false; } }
  return (u.protocol === "http:" || u.protocol === "https:") && publicHost(u.hostname);
}
