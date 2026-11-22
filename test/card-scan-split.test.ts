// The live check's split of the file-walk hits in Chrome's encrypted session folder (PR #231's open point 10; review-232
// N5): test/live/card-checkout/scan-split.ts, the one live-check module with no side effect at its import. This test
// imports only that module (never agent.ts or check.ts), with temp folders of its own. The labels are the scan's labels
// only: no test value is in this file.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CIPHER_SESSIONS, CSC_LABEL, PLAIN_SESSIONS, plainTwin, splitHits } from "./live/card-checkout/scan-split.ts";

const NUMBER = "the success test number (digits)", EXPIRY = "the expiry (MM/YY)", MMYY = "the expiry (MMYY)", CSC16 = `${CSC_LABEL} (UTF-16LE)`;

/** A profile folder of its own: `<root>/<name>/Sessions_Encrypted/Session_1`, with the plain twin `Sessions` as `twin` says. */
function profile(root: string, name: string, twin: "none" | "empty" | "file" | "with a file", cipher = CIPHER_SESSIONS): string {
  const dir = join(root, name);
  mkdirSync(join(dir, cipher), { recursive: true });
  const file = join(dir, cipher, "Session_1");
  writeFileSync(file, "x");
  if (twin === "empty") mkdirSync(join(dir, PLAIN_SESSIONS));
  if (twin === "file") writeFileSync(join(dir, PLAIN_SESSIONS), "x");
  if (twin === "with a file") { mkdirSync(join(dir, PLAIN_SESSIONS)); writeFileSync(join(dir, PLAIN_SESSIONS, "Session_1"), "x"); }
  return file;
}

test("review-232 N5: the security code's Latin-1 hit in Chrome's encrypted session folder is a note only when the plain twin is a folder that holds a file; each other hit stays a hit", () => {
  const root = mkdtempSync(join(tmpdir(), "aw-scan-split-"));
  try {
    const labels = [NUMBER, CSC_LABEL, EXPIRY];
    // No twin, an empty twin folder, a file named like the twin: a hit.
    for (const twin of ["none", "empty", "file"] as const) {
      const f = profile(root, `p-${twin}`, twin);
      assert.deepEqual(splitHits(f, labels), { hits: labels, notes: [] }, `twin ${twin}: each label stays a hit`);
    }
    // A twin with a file: the security code's Latin-1 hit is a note; the number, the expiry (also MMYY) and the UTF-16LE form stay hits.
    const f = profile(root, "p-twin", "with a file");
    assert.equal(plainTwin(join(root, "p-twin", PLAIN_SESSIONS)), true);
    assert.deepEqual(splitHits(f, [NUMBER, CSC_LABEL, EXPIRY, MMYY, CSC16]), { hits: [NUMBER, EXPIRY, MMYY, CSC16], notes: [CSC_LABEL] });
    assert.deepEqual(splitHits(f, [NUMBER]), { hits: [NUMBER], notes: [] }, "a number is never a note");
    assert.deepEqual(splitHits(f, [EXPIRY, MMYY]), { hits: [EXPIRY, MMYY], notes: [] }, "an expiry is never a note");
    // A file deeper in the encrypted folder counts too; a file of the plain twin itself keeps each hit.
    mkdirSync(join(root, "p-twin", CIPHER_SESSIONS, "deeper"));
    assert.deepEqual(splitHits(join(root, "p-twin", CIPHER_SESSIONS, "deeper", "x"), [CSC_LABEL]), { hits: [], notes: [CSC_LABEL] });
    assert.deepEqual(splitHits(join(root, "p-twin", PLAIN_SESSIONS, "Session_1"), [CSC_LABEL]), { hits: [CSC_LABEL], notes: [] }, "the plain twin's own file");
    // A folder only named like it (Sessions_Encrypted_old), with a twin that holds a file next to it: a hit.
    const old = profile(root, "p-old", "with a file", `${CIPHER_SESSIONS}_old`);
    assert.deepEqual(splitHits(old, [CSC_LABEL]), { hits: [CSC_LABEL], notes: [] }, "Sessions_Encrypted_old is no encrypted session folder");
    // A path that starts with the folder's name (no parent) and a plain file elsewhere: a hit.
    assert.deepEqual(splitHits(`${CIPHER_SESSIONS}/Session_1`, [CSC_LABEL]), { hits: [CSC_LABEL], notes: [] });
    assert.deepEqual(splitHits(join(root, "p-twin", "Cookies"), [CSC_LABEL]), { hits: [CSC_LABEL], notes: [] }, "a file outside the encrypted folder");
    // The twin check alone: no folder, an empty folder, a file of that name.
    assert.equal(plainTwin(join(root, "p-none", PLAIN_SESSIONS)), false);
    assert.equal(plainTwin(join(root, "p-empty", PLAIN_SESSIONS)), false);
    assert.equal(plainTwin(join(root, "p-file", PLAIN_SESSIONS)), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
