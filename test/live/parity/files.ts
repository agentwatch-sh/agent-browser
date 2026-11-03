// The probe's files, apart from probe.ts so that `npm test` can load them without a Chrome: what a
// profile's preference files say about developer mode and the probe extension, and the run folder's
// summary.json.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Developer mode and the probe extension's entries in a profile: the unpacked copies by their folder
 * (parity-ext), the packed one by its ID (`ids`). Developer mode on Linux comes from Preferences; on
 * macOS Chrome keeps it in Secure Preferences, which wins there. The extension settings come from
 * both files, and Secure Preferences wins.
 */
export function readPrefs(profile: string, ids: ReadonlySet<string> = new Set(), platform: string = process.platform) {
  const read = (f: string) => { try { return JSON.parse(readFileSync(join(profile, "Default", f), "utf8")); } catch { return undefined; } };
  const prefs = read("Preferences"), secure = read("Secure Preferences");
  const settings = { ...(prefs?.extensions?.settings ?? {}), ...(secure?.extensions?.settings ?? {}) };
  const ours = Object.fromEntries(Object.entries(settings).filter(([id, v]: [string, any]) => ids.has(id) || (typeof v?.path === "string" && v.path.includes("parity-ext"))).map(([id, v]: [string, any]) => [id, {
    location: v.location, state: v.state, disable_reasons: v.disable_reasons, creation_flags: v.creation_flags, from_webstore: v.from_webstore, path: v.path,
  }]));
  const devMode = (p: any) => p?.extensions?.ui?.developer_mode;
  return { developerMode: platform === "linux" ? devMode(prefs) : devMode(secure) ?? devMode(prefs), ours };
}

export type Summary = { started: string; platform: string; spki?: string; browsers: { [label: string]: unknown }; blockedEgress: { run: string; [k: string]: unknown }[] };

/** A column of summary.json; one from another run than the summary's names that run. */
type Column = { started?: string; platform?: string; [k: string]: unknown };

/**
 * Write a full run's summary.json. An earlier run into the same folder, for example a --serve run
 * (its operator column), keeps its browsers and their blocked hosts, unless this run has the same
 * label: this run's columns come first, then the kept ones. A kept column without its own run gets
 * the start and platform of the summary it was in.
 */
export function writeSummary(file: string, summary: Summary) {
  let out = summary;
  try {
    const old: Summary = JSON.parse(readFileSync(file, "utf8"));
    const kept = Object.keys(old.browsers ?? {}).filter((l) => !Object.hasOwn(summary.browsers, l));
    const column = (l: string) => { const c = old.browsers[l] as Column; return { ...c, started: c.started ?? old.started, platform: c.platform ?? old.platform }; };
    out = {
      ...summary,
      browsers: { ...summary.browsers, ...Object.fromEntries(kept.map((l) => [l, column(l)])) },
      blockedEgress: [...summary.blockedEgress, ...(old.blockedEgress ?? []).filter((e) => typeof e?.run === "string" && kept.includes(e.run.split("/")[0]))],
    };
  } catch { /* none yet, or not a summary: this run's alone */ }
  writeFileSync(file, JSON.stringify(out, null, 1));
}

/** Add a --serve run's column to summary.json, with that run's start and platform. */
export function writeServeColumn(file: string, label: string, started: string, platform: string = process.platform) {
  let summary: Summary | undefined;
  try { summary = JSON.parse(readFileSync(file, "utf8")); } catch { /* none yet */ }
  summary ??= { started, platform, browsers: {}, blockedEgress: [] };
  summary.browsers[label] = { bin: `(${label}: a browser that a person opened)`, version: "the browser's own", started, platform, runs: {} };
  writeFileSync(file, JSON.stringify(summary, null, 1));
}

/**
 * For compare.ts: the run of a column from another run than the summary's (a stale column of an
 * older probe or of another platform must not read as a difference between the browsers).
 */
export function otherRun(summary: Summary, label: string): string | undefined {
  const c = (summary.browsers[label] ?? {}) as Column;
  const started = c.started ?? summary.started, platform = c.platform ?? summary.platform;
  if (started === summary.started && platform === summary.platform) return undefined;
  const when = started < summary.started ? "an earlier" : started > summary.started ? "a later" : "another";
  return `from ${when} run: ${platform} ${started}`;
}
