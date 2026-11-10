// Google Chrome versions and the copy that a start runs (the self-contained design, section 5.1, the row "Google
// Chrome stable"; board ab-v16.94.3; a port of agentwatch's daemon/browser/versions.py). Pure functions on the version
// texts of Google's index (`a.b.c.d-r`, ASCII digits only), so the unit, the updater and the tests share one choice.

/** A Google Chrome version of the signed index: `a.b.c.d-r`, ASCII digits only, each number at most 19 digits. */
export const VERSION_RE = /^[0-9]{1,19}(\.[0-9]{1,19}){3}-[0-9]{1,19}$/;

/** The numbers of `version` for an order (as the tools folder orders its copies), or null when it is not `a.b.c.d-r`. */
export function versionKey(version: unknown): bigint[] | null {
  if (typeof version !== "string" || !VERSION_RE.test(version)) return null;
  const [upstream, revision] = version.split("-");
  return [...upstream.split(".").map((n) => BigInt(n)), BigInt(revision)];
}

/** -1, 0 or 1: the order of two keys of the same length. */
export function compareKeys(a: readonly bigint[], b: readonly bigint[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? -1n, y = b[i] ?? -1n;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** True when both are versions and `version` is the newer one. */
export function newer(version: string | null | undefined, than: string | null | undefined): boolean {
  const a = versionKey(version ?? ""), b = versionKey(than ?? "");
  return a !== null && b !== null && compareKeys(a, b) > 0;
}

/**
 * The copy that a start runs: the newest of `versions` that is not in `skip` and, with `upto`, not newer than `upto`;
 * null when there is none. A text that is not a version is never picked.
 */
export function pickVersion(versions: Iterable<string>, skip: ReadonlySet<string> = new Set(), upto: string | null = null): string | null {
  let best: string | null = null;
  for (const v of versions) {
    if (versionKey(v) === null || skip.has(v) || (upto !== null && newer(v, upto))) continue;
    if (best === null || newer(v, best)) best = v;
  }
  return best;
}
