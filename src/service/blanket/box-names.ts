// The box's own names (board ab-4wh.3; C12 and C4, the blanket profile): the blanket link's set_scopes names them in
// `exclude`, and the "*" scope may not open them (the receiver and the relay's layer 1 refuse them). On a Linux box the
// FQDN often resolves to 127.0.1.1 through /etc/hosts, so a public-looking name can be the box itself.
//
// The names: os.hostname(), and each name of each /etc/hosts line that names it (the FQDN and its aliases), lowercase,
// with no trailing dot, each a name of labels of [a-z0-9_-] (the receiver's characters); every other spelling is dropped.

import { readFileSync } from "node:fs";
import { hostname } from "node:os";

const NAME = /^[a-z0-9_-]+(\.[a-z0-9_-]+)*$/;

const normal = (n: string): string | null => {
  const h = n.trim().toLowerCase().replace(/\.$/, "");
  return h.length > 0 && h.length <= 253 && NAME.test(h) ? h : null;
};

/** The box's own names, sorted, each once. `host` and `hostsFile` are seams for the tests. */
export function boxNames(o: { host?: string; hostsFile?: string } = {}): string[] {
  const own = normal(o.host ?? hostname());
  const out = new Set<string>(own ? [own] : []);
  let text = "";
  try { text = readFileSync(o.hostsFile ?? "/etc/hosts", "utf8"); } catch {}
  for (const raw of text.split("\n")) {
    const names = raw.replace(/#.*/, "").trim().split(/\s+/).slice(1).map(normal).filter((n): n is string => n !== null);
    // A line names the box when one of its names is the host name or its FQDN (`<host name>.<domain>`).
    if (own && names.some((n) => n === own || n.startsWith(`${own}.`))) for (const n of names) out.add(n);
  }
  return [...out].sort();
}
