// The box's own names (board ab-4wh.3; C12 and C4, the blanket profile): the blanket link's set_scopes names them in
// `exclude`, and the "*" scope may not open them (the receiver and the relay's layer 1 refuse them). On a Linux box the
// FQDN often resolves to 127.0.1.1 through /etc/hosts, so a public-looking name can be the box itself.
//
// The names: os.hostname(), then each name of each /etc/hosts line that names it or its FQDN, lowercase, with no trailing
// dot, in that order. Each follows C4's rules of `exclude` (host-class.ts, isExcludeName: labels of [a-z0-9_-], 1 to
// 63 characters, no "-" at a label's start or end, at most 253 characters, no IPv4 literal); a name that breaks them is
// dropped. At most MAX_EXCLUDE names, of at most MAX_EXCLUDE_CHARS characters in all, are kept: the receiver refuses
// the whole "*" of a longer `exclude`.

import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { isExcludeName, MAX_EXCLUDE, MAX_EXCLUDE_CHARS } from "../../host-class.ts";

const normal = (n: string): string | null => {
  const h = n.trim().toLowerCase().replace(/\.$/, "");
  return isExcludeName(h) ? h : null;
};

/** The box's own names, sorted, each once, within C4's limits. `host` and `hostsFile` are seams for the tests. */
export function boxNames(o: { host?: string; hostsFile?: string } = {}): string[] {
  const own = normal(o.host ?? hostname());
  const found: string[] = own ? [own] : [];
  let text = "";
  try { text = readFileSync(o.hostsFile ?? "/etc/hosts", "utf8"); } catch {}
  for (const raw of text.split("\n")) {
    const names = raw.replace(/#.*/, "").trim().split(/\s+/).slice(1).map(normal).filter((n): n is string => n !== null);
    // A line names the box when one of its names is the host name or its FQDN (`<host name>.<domain>`).
    if (own && names.some((n) => n === own || n.startsWith(`${own}.`))) found.push(...names);
  }
  const out: string[] = [];
  let chars = 0;
  for (const n of new Set(found)) {
    if (out.length >= MAX_EXCLUDE || chars + n.length > MAX_EXCLUDE_CHARS) continue;
    out.push(n);
    chars += n.length;
  }
  return out.sort();
}
