// The receiver's incognito access and access to local files in the agent Chrome's profile (board ab-v16.94.31; C12, the
// receiver's access check). The sign-in act and PageFetch open their windows in incognito, so the receiver needs
// `extensions.settings.<receiver ID>.incognito`; a file input needs `newAllowFileAccess` (board ab-t30.27). The service
// writes both into `Default/Preferences` before each start of Chrome (unit.ts, writeDownloadPrefs), so a Chrome that it
// adopts (one that runs from before the service's start) can lack them until the service's next start of Chrome. Where
// Chrome keeps the receiver's entry in `Default/Secure Preferences` (the Mac; board ab-v16.94.34: a protected file, with a
// MAC), Chrome drops that write, and only the operator's switch 'Allow in Incognito' in chrome://extensions gives the
// incognito access; Chrome gives an unpacked extension (the Mac's) access to local files by itself (the daemon lead's
// Mac measurement). It also reads whether Chrome turned the receiver off in the profile (board ab-v16.116: receiverOff).
// This file only reads: the service writes no file of a running Chrome's profile, and never `Secure Preferences`.

import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { RECEIVER_ID } from "../package/pins.ts";

/** The receiver's keys that the service needs: Chrome's key in the receiver's settings entry, and the texts' words. */
export const ACCESS_KEYS = {
  incognito: { key: "incognito", words: "incognito access" },
  file: { key: "newAllowFileAccess", words: "access to local files" },
} as const;
export type AccessKey = keyof typeof ACCESS_KEYS;
/**
 * Who can give a missing incognito access (board ab-v16.94.34): `service` when its write of `Default/Preferences`
 * before its next start of Chrome gives it (the receiver's entry comes from `Preferences`; Linux, the packed CRX),
 * `operator` when only the operator's switch 'Allow in Incognito' in chrome://extensions gives it (the entry comes from
 * `Secure Preferences`, or no file holds it on the Mac, where Chrome keeps it in `Secure Preferences`). The access to
 * local files gets the service's step on every system, and a result that lacks only it is `service`.
 */
export type AccessGiver = "service" | "operator";
export type ReceiverAccess = { state: "ok" } | { state: "missing"; missing: AccessKey[]; gives: AccessGiver } | { state: "unknown"; why: string };

/** The operator's sentence while the access is unknown (a file of the profile cannot be read or is not a JSON object). */
export const ACCESS_UNKNOWN_NOTE = "The service cannot read the agent Chrome's Preferences, so it does not know whether the agent extension has incognito access and access to local files.";
/** The step of a missing access that the service gives: its next start of Chrome writes the keys. */
export const SERVICE_GIVES_STEP = "The service's next start of the agent Chrome gives this access: a stop and a start of the agent browser give it now.";
/**
 * What needs each access, in the operator's sentence (board ab-v16.105; the daemon lead's note of 2026-11-20): on Linux
 * PageFetch and the sign-in act use the incognito access now; on the Mac neither runs yet (PageFetch comes with stage 6,
 * and the stored sign-ins and the act stay off there), so the Mac's text says that they need it when they come.
 */
export const ACCESS_NEEDS = {
  linux: "PageFetch and the sign-in act need incognito access; a file input needs access to local files",
  mac: "PageFetch and the sign-in act need incognito access when they come to the Mac; a file input needs access to local files",
} as const;
/** The operator's step of a missing incognito access that only the operator gives (board ab-v16.94.34). */
export const OPERATOR_INCOGNITO_STEP = "In the agent Chrome, open chrome://extensions, click Details of the agent extension and turn on 'Allow in Incognito'.";
/** After OPERATOR_INCOGNITO_STEP, when the access to local files is missing too: the service's step for that access. */
export const SERVICE_FILES_STEP = "The service's next start of the agent Chrome gives the access to local files: a stop and a start of the agent browser give it now.";

const isObj = (x: unknown): x is Record<string, any> => x !== null && typeof x === "object" && !Array.isArray(x);
const wordsOf = (keys: readonly AccessKey[]) => keys.map((k) => ACCESS_KEYS[k].words).join(" and ");

/**
 * The receiver's settings entry in the profile of `preferences` and the file that holds it, by a read only: `Secure
 * Preferences` first (a missing one is no error), then `Preferences`; `entry` is null when neither holds one. `why`: a
 * file cannot be read, or is not a JSON object.
 */
function entryOf(preferences: string): { entry: Record<string, unknown> | null; from: "Secure Preferences" | "Preferences" | null } | { why: string } {
  for (const [name, path] of [["Secure Preferences", join(dirname(preferences), "Secure Preferences")], ["Preferences", preferences]] as const) {
    let text: string;
    try { text = readFileSync(path, "utf8"); }
    catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT" && name === "Secure Preferences") continue;
      return { why: code === "ENOENT" ? "no Preferences file" : `${name} cannot be read (${code ?? "an error"})` };
    }
    let o: unknown = null;
    try { o = JSON.parse(text); } catch {}
    if (!isObj(o)) return { why: `${name} is not a JSON object` };
    const e = isObj(o.extensions) && isObj(o.extensions.settings) ? o.extensions.settings[RECEIVER_ID] : undefined;
    if (isObj(e)) return { entry: e, from: name };
  }
  return { entry: null, from: null };
}

/**
 * The receiver's access in the profile of `preferences` (`<profile>/Default/Preferences`), by a read of the files only.
 * The receiver's settings entry comes from `Secure Preferences` when that file holds one (Chrome keeps protected settings
 * there on some systems), else from `Preferences`; a missing `Secure Preferences` is no error. A key that is not `true`
 * is missing (also with no entry of the receiver: Chrome's own default is no access). A file that cannot be read, or
 * that is not a JSON object, makes the access unknown, never missing. `mac`: the profile is the Mac's, where Chrome
 * keeps the entry in `Secure Preferences`, so a missing incognito access with no entry in either file is the
 * operator's to give.
 */
export function receiverAccess(preferences: string, opts: { mac?: boolean } = {}): ReceiverAccess {
  const found = entryOf(preferences);
  if ("why" in found) return { state: "unknown", why: found.why };
  const { entry, from } = found;
  const missing = (Object.keys(ACCESS_KEYS) as AccessKey[]).filter((k) => entry?.[ACCESS_KEYS[k].key] !== true);
  if (missing.length === 0) return { state: "ok" };
  const operator = missing.includes("incognito") && (from === "Secure Preferences" || (from === null && opts.mac === true));
  return { state: "missing", missing, gives: operator ? "operator" : "service" };
}

/** The operator's sentence of a result, or null (the access is there); `mac`: the service runs on the Mac (ACCESS_NEEDS). */
export function accessNote(a: ReceiverAccess, opts: { mac?: boolean } = {}): string | null {
  if (a.state === "unknown") return ACCESS_UNKNOWN_NOTE;
  if (a.state === "ok") return null;
  const step = a.gives === "service" ? SERVICE_GIVES_STEP : a.missing.includes("file") ? `${OPERATOR_INCOGNITO_STEP} ${SERVICE_FILES_STEP}` : OPERATOR_INCOGNITO_STEP;
  return `The agent extension lacks ${wordsOf(a.missing)} in the agent Chrome (${opts.mac === true ? ACCESS_NEEDS.mac : ACCESS_NEEDS.linux}). ${step}`;
}

/** The moments of a read: the adoption of a running Chrome, a receiver's link-up, and the timed read while the access is not there. */
export type AccessWhen = "adoption" | "link-up" | "re-read";

/** The log line of a result: the profile's folder name only, no other part of its path. */
export function accessLine(when: AccessWhen, a: ReceiverAccess, profile: string, pid: number): string {
  const folder = basename(profile);
  if (a.state === "unknown") return `unit: at the ${when} the receiver's incognito access and access to local files are unknown (the profile "${folder}": ${a.why})`;
  if (a.state === "ok") return `unit: at the ${when} the receiver has incognito access and access to local files in the profile "${folder}" (Chrome pid ${pid})`;
  const gives = a.gives === "service" ? "the service's next Chrome start gives it"
    : a.missing.includes("file") ? "only the operator's switch in chrome://extensions gives the incognito access, and the service's next Chrome start gives the access to local files"
    : "only the operator's switch in chrome://extensions gives it";
  return `unit: at the ${when} the receiver lacks ${wordsOf(a.missing)} in the profile "${folder}" (Chrome pid ${pid}); ${gives}`;
}

/** The key of a result: a new key for the same Chrome gets a new log line. */
export const accessKey = (a: ReceiverAccess): string => (a.state === "missing" ? `missing ${a.missing.join(" ")} by the ${a.gives}` : a.state);

// ------------------------------------------------------------------ board ab-v16.116: a receiver that Chrome turned off

/**
 * Whether Chrome turned the receiver off in the agent profile (board ab-v16.116). On the Mac, Chrome 158 kept the
 * receiver's entry in `Secure Preferences` after an update from 157 as a stub: `disable_reasons` [16777216] (1 << 24,
 * Chrome's reason for an unpacked extension while developer mode is off; docs/research/2026-11-03-chrome-vs-chrome-beta.md,
 * section 5) and no `path`, `location`, `state` or `manifest`. No receiver ran, and the send said only that the agent
 * extension did not connect. `off`: `reasons` are the values of the entry's `disable_reasons` that are not 0, and
 * `noPath` (a detail for the log line only) says that the entry has no `path`, as the stub. `entry` (not off): Chrome
 * holds an entry of the receiver. `unknown`: a file cannot be read, or is not a JSON object.
 */
export type ReceiverOff = { off: true; reasons: number[]; noPath: boolean } | { off: false; entry: boolean } | { unknown: string };

/** Chrome's disable reason of an unpacked extension while developer mode is off (1 << 24; board ab-v16.116). */
export const DEVELOPER_MODE_REASON = 16777216;

/** The keys of the service's own write of the receiver's entry in `Preferences` before each start of Chrome (unit.ts, writeDownloadPrefs). */
const SERVICE_KEYS: readonly string[] = Object.values(ACCESS_KEYS).map((k) => k.key);

/**
 * The receiver's off check (board ab-v16.116), by a read of the same files in the same order as receiverAccess, never a
 * write. Off: the entry's `disable_reasons` holds a value that is not 0 (Chrome's list; an older Chrome kept one number).
 * An entry with no `path` and no such reason is not off (review of board ab-v16.116, M3: Chrome can add a key such as
 * `content_settings` to the entry of an extension that was never loaded). No entry is not off; `entry` is false also
 * for an entry that holds only the keys of the service's own write (`incognito`, `newAllowFileAccess`), which a new Mac
 * profile has before the operator's first Load unpacked. A file that cannot be read or is not a JSON object gives
 * `unknown`, never off.
 */
export function receiverOff(preferences: string): ReceiverOff {
  const found = entryOf(preferences);
  if ("why" in found) return { unknown: found.why };
  const e = found.entry;
  if (e === null) return { off: false, entry: false };
  const d = e.disable_reasons;
  const reasons = Array.isArray(d) ? d.filter((x): x is number => typeof x === "number" && x !== 0) : typeof d === "number" && d !== 0 ? [d] : [];
  if (reasons.length === 0) return { off: false, entry: Object.keys(e).some((k) => !SERVICE_KEYS.includes(k)) };
  return { off: true, reasons, noPath: typeof e.path !== "string" || e.path === "" };
}

/** True when the result says that Chrome turned the receiver off. */
export const isOff = (r: ReceiverOff | null | undefined): r is { off: true; reasons: number[]; noPath: boolean } => !!r && "off" in r && r.off;

/** The moments of an off check (board ab-v16.116). */
export type OffWhen = "note" | "use" | "send" | "stop" | "status";
const OFF_WHEN: Record<OffWhen, string> = {
  note: "watch's 15 s note", use: "end of a use's wait with no receiver", send: "end of a send's wait with no receiver",
  stop: "watch's stop", status: "status read",
};

/** The key of an off result: a new key for the same Chrome gets a new log line. */
export const offKey = (r: ReceiverOff): string => ("unknown" in r ? "unknown" : r.off ? `off ${r.reasons.join(" ")}${r.noPath ? " no path" : ""}` : r.entry ? "on" : "no entry");

/** The log line of an off result: the profile's folder name only, no other part of its path; `pid` null: no Chrome is known. */
export function offLine(when: OffWhen, r: ReceiverOff, profile: string, pid: number | null): string {
  const folder = basename(profile), at = `unit: at the ${OFF_WHEN[when]}`, chrome = pid === null ? "" : ` (Chrome pid ${pid})`;
  if ("unknown" in r) return `${at} it is unknown whether Chrome turned the receiver off (the profile "${folder}": ${r.unknown})`;
  if (!r.off) return r.entry ? `${at} the receiver's entry in the profile "${folder}" is not turned off${chrome}` : `${at} the profile "${folder}" holds no entry of the receiver${chrome}`;
  const why = [...(r.reasons.length ? [`disable_reasons ${r.reasons.join(" ")}`] : []), ...(r.noPath ? ["its entry has no path"] : [])].join("; ");
  return `${at} Chrome has turned the receiver off in the profile "${folder}"${chrome}: ${why}`;
}
