// The receiver's incognito access and access to local files in the agent Chrome's profile (board ab-v16.94.31; C12, the
// receiver's access check). The sign-in act and PageFetch open their windows in incognito, so the receiver needs
// `extensions.settings.<receiver ID>.incognito`; a file input needs `newAllowFileAccess` (board ab-t30.27). The service
// writes both before each start of Chrome (unit.ts, writeDownloadPrefs), so a Chrome that it adopts (one that runs from
// before the service's start) can lack them until the service's next start of Chrome. This file only reads: the
// service writes no file of a running Chrome's profile.

import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { RECEIVER_ID } from "../package/pins.ts";

/** The receiver's keys that the service needs: Chrome's key in the receiver's settings entry, and the texts' words. */
export const ACCESS_KEYS = {
  incognito: { key: "incognito", words: "incognito access" },
  file: { key: "newAllowFileAccess", words: "access to local files" },
} as const;
export type AccessKey = keyof typeof ACCESS_KEYS;
export type ReceiverAccess = { state: "ok" } | { state: "missing"; missing: AccessKey[] } | { state: "unknown"; why: string };

/** The operator's sentence while the access is unknown (a file of the profile cannot be read or is not a JSON object). */
export const ACCESS_UNKNOWN_NOTE = "The service cannot read the agent Chrome's Preferences, so it does not know whether the agent extension has incognito access and access to local files.";

const isObj = (x: unknown): x is Record<string, any> => x !== null && typeof x === "object" && !Array.isArray(x);
const wordsOf = (keys: readonly AccessKey[]) => keys.map((k) => ACCESS_KEYS[k].words).join(" and ");

/**
 * The receiver's access in the profile of `preferences` (`<profile>/Default/Preferences`), by a read of the files only.
 * The receiver's settings entry comes from `Secure Preferences` when that file holds one (Chrome keeps protected settings
 * there on some systems), else from `Preferences`; a missing `Secure Preferences` is no error. A key that is not `true`
 * is missing (also with no entry of the receiver: Chrome's own default is no access). A file that cannot be read, or
 * that is not a JSON object, makes the access unknown, never missing.
 */
export function receiverAccess(preferences: string): ReceiverAccess {
  let entry: Record<string, unknown> | null = null;
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
    if (isObj(e)) { entry = e; break; }
  }
  const missing = (Object.keys(ACCESS_KEYS) as AccessKey[]).filter((k) => entry?.[ACCESS_KEYS[k].key] !== true);
  return missing.length > 0 ? { state: "missing", missing } : { state: "ok" };
}

/** The operator's sentence of a result, or null (the access is there). */
export function accessNote(a: ReceiverAccess): string | null {
  if (a.state === "unknown") return ACCESS_UNKNOWN_NOTE;
  if (a.state === "ok") return null;
  return `The agent extension lacks ${wordsOf(a.missing)} in the agent Chrome (PageFetch and the sign-in act need incognito access; a file input needs access to local files). The service's next start of the agent Chrome gives this access: a stop and a start of the agent browser give it now.`;
}

/** The log line of a result: the profile's folder name only, no other part of its path. */
export function accessLine(when: "adoption" | "link-up", a: ReceiverAccess, profile: string, pid: number): string {
  const folder = basename(profile);
  if (a.state === "unknown") return `unit: at the ${when} the receiver's incognito access and access to local files are unknown (the profile "${folder}": ${a.why})`;
  if (a.state === "ok") return `unit: at the ${when} the receiver has incognito access and access to local files in the profile "${folder}" (Chrome pid ${pid})`;
  return `unit: at the ${when} the receiver lacks ${wordsOf(a.missing)} in the profile "${folder}" (Chrome pid ${pid}); the service's next Chrome start gives it`;
}

/** The key of a result: a new key for the same Chrome gets a new log line. */
export const accessKey = (a: ReceiverAccess): string => (a.state === "missing" ? `missing ${a.missing.join(" ")}` : a.state);
