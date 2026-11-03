// The probe's files, apart from probe.ts so that `npm test` can load them without a Chrome: what a
// profile's preference files say about developer mode and the probe extension, and the run folder's
// summary.json.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Developer mode and the probe extension's entries in a profile: the unpacked copies by their folder
 * (parity-ext), the packed one by its ID (`ids`). Both come from Preferences and Secure Preferences,
 * and Secure Preferences wins: on macOS Chrome keeps developer mode there, on Linux in Preferences.
 */
export function readPrefs(profile: string, ids: ReadonlySet<string> = new Set()) {
  const read = (f: string) => { try { return JSON.parse(readFileSync(join(profile, "Default", f), "utf8")); } catch { return undefined; } };
  const prefs = read("Preferences"), secure = read("Secure Preferences");
  const settings = { ...(prefs?.extensions?.settings ?? {}), ...(secure?.extensions?.settings ?? {}) };
  const ours = Object.fromEntries(Object.entries(settings).filter(([id, v]: [string, any]) => ids.has(id) || (typeof v?.path === "string" && v.path.includes("parity-ext"))).map(([id, v]: [string, any]) => [id, {
    location: v.location, state: v.state, disable_reasons: v.disable_reasons, creation_flags: v.creation_flags, from_webstore: v.from_webstore, path: v.path,
  }]));
  return { developerMode: secure?.extensions?.ui?.developer_mode ?? prefs?.extensions?.ui?.developer_mode, ours };
}

export type Summary = { started: string; platform: string; spki?: string; browsers: { [label: string]: unknown }; blockedEgress: { run: string; [k: string]: unknown }[] };

/**
 * Write a full run's summary.json. An earlier run into the same folder, for example a --serve run
 * (its operator column), keeps its browsers and their blocked hosts, unless this run has the same
 * label: this run's columns come first, then the kept ones.
 */
export function writeSummary(file: string, summary: Summary) {
  let out = summary;
  try {
    const old: Summary = JSON.parse(readFileSync(file, "utf8"));
    const kept = Object.keys(old.browsers ?? {}).filter((l) => !(l in summary.browsers));
    out = {
      ...summary,
      browsers: { ...summary.browsers, ...Object.fromEntries(kept.map((l) => [l, old.browsers[l]])) },
      blockedEgress: [...summary.blockedEgress, ...(old.blockedEgress ?? []).filter((e) => kept.includes(e.run.split("/")[0]))],
    };
  } catch { /* none yet, or not a summary: this run's alone */ }
  writeFileSync(file, JSON.stringify(out, null, 1));
}
