// The receiver's incognito access and access to local files in the agent Chrome's profile (board ab-v16.94.31; C12, the
// receiver's access check). The sign-in act and PageFetch open their windows in incognito, so the receiver needs
// `extensions.settings.<receiver ID>.incognito`; a file input needs `newAllowFileAccess` (board ab-t30.27). The service
// writes both into `Default/Preferences` before each start of Chrome (unit.ts, writeDownloadPrefs), so a Chrome that it
// adopts (one that runs from before the service's start) can lack them until the service's next start of Chrome. Where
// Chrome keeps the receiver's entry in `Default/Secure Preferences` (the Mac; board ab-v16.94.34: a protected file, with a
// MAC), Chrome drops that write, and only the operator's switch 'Allow in Incognito' in chrome://extensions gives the
// incognito access; Chrome gives an unpacked extension (the Mac's) access to local files by itself (the daemon lead's
// Mac measurement). This file only reads: the service writes no file of a running Chrome's profile, and never
// `Secure Preferences`.

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
 * The receiver's access in the profile of `preferences` (`<profile>/Default/Preferences`), by a read of the files only.
 * The receiver's settings entry comes from `Secure Preferences` when that file holds one (Chrome keeps protected settings
 * there on some systems), else from `Preferences`; a missing `Secure Preferences` is no error. A key that is not `true`
 * is missing (also with no entry of the receiver: Chrome's own default is no access). A file that cannot be read, or
 * that is not a JSON object, makes the access unknown, never missing. `mac`: the profile is the Mac's, where Chrome
 * keeps the entry in `Secure Preferences`, so a missing incognito access with no entry in either file is the
 * operator's to give.
 */
export function receiverAccess(preferences: string, opts: { mac?: boolean } = {}): ReceiverAccess {
  let entry: Record<string, unknown> | null = null;
  let from: "Secure Preferences" | "Preferences" | null = null;
  for (const [name, path] of [["Secure Preferences", join(dirname(preferences), "Secure Preferences")], ["Preferences", preferences]] as const) {
    let text: string;
    try { text = readFileSync(path, "utf8"); }
    catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT" && name === "Secure Preferences") continue;
      return { state: "unknown", why: code === "ENOENT" ? "no Preferences file" : `${name} cannot be read (${code ?? "an error"})` };
    }
    let o: unknown = null;
    try { o = JSON.parse(text); } catch {}
    if (!isObj(o)) return { state: "unknown", why: `${name} is not a JSON object` };
    const e = isObj(o.extensions) && isObj(o.extensions.settings) ? o.extensions.settings[RECEIVER_ID] : undefined;
    if (isObj(e)) { entry = e; from = name; break; }
  }
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
