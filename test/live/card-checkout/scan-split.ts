// The split of the live check's file-walk hits in Chrome's encrypted session folder (PR #231's open point 10; review-232
// N5): the pure part of the secret scan that a unit test can import (test/card-scan-split.test.ts). It has no side effect
// at its import: only node:fs and constants. The live check (check.ts, step 7) and its helpers (agent.ts) import it.

import { lstatSync, readdirSync } from "node:fs";

/** The label of the security code's form: its Latin-1 hit is 4 bytes, the one form that ciphertext can match by chance. */
export const CSC_LABEL = "the security code";

/** Chrome's encrypted session folder, and its plain twin next to it. */
export const CIPHER_SESSIONS = "Sessions_Encrypted", PLAIN_SESSIONS = "Sessions";

/**
 * True when `path` is a folder (not a link) that holds at least one file of its own. An empty folder, or a file of that
 * name, is no plain twin. The assumption: Chrome writes the session records in the clear into the plain twin and only
 * `v10` ciphertext (7.99 bits a byte) into the encrypted folder, so a chance match of 4 bytes is possible only there;
 * the check does not prove that both folders hold the same records.
 */
export function plainTwin(path: string): boolean {
  try {
    if (!lstatSync(path).isDirectory()) return false;
    return readdirSync(path, { withFileTypes: true }).some((e) => e.isFile());
  } catch { return false; }
}

/**
 * One file's hits of the file walk, split: in Chrome's encrypted session folder (a whole path part of that name, not a
 * name that only starts so) whose plain twin is there (plainTwin), a hit of the security code's Latin-1 form is a note
 * (a chance match in ciphertext); every other hit stays a hit. So the numbers and the expiry count in every file, and the
 * security code in every plain file, in its UTF-16LE form everywhere, and in the plain twin.
 */
export function splitHits(path: string, labels: readonly string[]): { hits: string[]; notes: string[] } {
  const parts = path.split("/");
  const at = parts.lastIndexOf(CIPHER_SESSIONS);
  if (at <= 0 || !plainTwin([...parts.slice(0, at), PLAIN_SESSIONS].join("/"))) return { hits: [...labels], notes: [] };
  return { hits: labels.filter((l) => l !== CSC_LABEL), notes: labels.filter((l) => l === CSC_LABEL) };
}
