// The repository check of card numbers (the secure card checkout design, R4 and section 11; board ab-sta.5, the plan's
// Task 4). It reads each tracked file (git ls-files) and fails on each card-like number that is not a payment provider's
// published test number (test/pay-test-cards.ts, the one file that holds them): a run of 13 to 19 digits, alone or in
// groups that a space or a dash splits, with a valid check digit (Luhn). A binary file (a NUL byte in its first 8000
// bytes: agent.crx, a PDF) is skipped, and no regex runs over it.
//
// What a card number is here, so that the check finds no number of another kind in the repository (each rule of the
// list is a measured case of this repository): its first digit is 2 to 6 (the major industry identifiers of payment
// cards: Mastercard, American Express, Diners, JCB, Visa, Discover, UnionPay), so no time in milliseconds (a 1) and no run
// of zeros is one; its digits are not all one digit; and it is not the decimal part of a number (`200.61000061035156`).
//
// The negative test makes a card-like number at run time, in a temp file outside the repository: such a number is never
// written into the repository, or the check would fail on itself.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { closeSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { luhn } from "../src/service/pay/digits.ts";
import { PUBLISHED_TEST_NUMBERS, TEST_CARDS } from "./pay-test-cards.ts";
import { tempDir } from "./temp-dirs.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
/** Digits that may be a card number: 13 to 19 digits, a space or a dash between two of them, not in a longer run, not after `<digit>.`. */
const CANDIDATE = /(?<![0-9])(?<![0-9]\.)[0-9](?:[ -]?[0-9]){12,18}(?![0-9])/g;
const SNIFF = 8000;

/** True when the file is a binary: a NUL byte in its first 8000 bytes (read alone; the rest is never read). */
function binary(path: string): boolean {
  const fd = openSync(path, "r");
  try {
    const b = Buffer.alloc(SNIFF);
    const n = readSync(fd, b, 0, SNIFF, 0);
    return b.subarray(0, n).includes(0);
  } finally { closeSync(fd); }
}

/** The card-like numbers of a text that are not on the published list: each as `<digits>` with no separator. */
export function cardNumbersIn(text: string, allowed: readonly string[] = PUBLISHED_TEST_NUMBERS): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(CANDIDATE)) {
    const d = m[0].replace(/[ -]/g, "");
    if (d.length < 13 || d.length > 19 || !/^[2-6]/.test(d) || /^(\d)\1+$/.test(d) || !luhn(d)) continue;
    if (!allowed.includes(d)) out.push(d);
  }
  return out;
}

/** Each hit of the files: `<file>: <the number's first two digits and its length>` (the message never repeats a number). */
function scan(files: readonly string[], root: string): string[] {
  const hits: string[] = [];
  for (const f of files) {
    const p = join(root, f);
    const st = statSync(p, { throwIfNoEntry: false });
    if (!st?.isFile() || binary(p)) continue;
    for (const d of cardNumbersIn(readFileSync(p, "utf8"))) hits.push(`${f}: a number of ${d.length} digits that starts ${d.slice(0, 2)}`);
  }
  return hits;
}

/** A made-up number with a valid check digit that is no published test number: made at run time, never written in the repository. */
function madeUpNumber(): string {
  for (;;) {
    const body = `4${Array.from({ length: 14 }, () => Math.floor(Math.random() * 10)).join("")}`;
    for (let d = 0; d <= 9; d++) {
      const n = `${body}${d}`;
      if (luhn(n) && !PUBLISHED_TEST_NUMBERS.includes(n) && !/^(\d)\1+$/.test(n)) return n;
    }
  }
}

test("the repository check: no tracked file holds a card-like number that is not a provider's published test number", () => {
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }).toString("utf8").split("\0").filter(Boolean);
  assert.ok(files.length > 100, "git ls-files gives the tracked files");
  assert.deepEqual(scan(files, ROOT), []);
});

test("the repository check fails on a made-up card-like number in a temp file outside the repository, alone and in groups", () => {
  const dir = tempDir("ab-card-numbers-");
  try {
    const n = madeUpNumber();
    assert.ok(!dir.startsWith(ROOT), "the temp file is outside the repository");
    const groups = n.match(/.{1,4}/g)!;
    const forms = [n, groups.join(" "), groups.join("-"), `card:${n}.`, `"${groups.join(" ")}"`];
    forms.forEach((form, i) => writeFileSync(join(dir, `f${i}.txt`), `a line before\nthe value ${form}\n`));
    const hits = scan(forms.map((_, i) => `f${i}.txt`), dir);
    assert.equal(hits.length, forms.length, "each form of the number is found");
    for (const h of hits) assert.ok(!h.includes(n.slice(2)), "the message never repeats the number");
    // A binary file is skipped: a NUL byte first, then the number.
    writeFileSync(join(dir, "bin.dat"), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(` ${n} `)]));
    assert.deepEqual(scan(["bin.dat"], dir), [], "a binary file is not read past its first bytes");
    // Numbers of other kinds are none: a time in milliseconds, zeros, a decimal part, a longer run.
    writeFileSync(join(dir, "other.txt"), `1763740800000 0000000000000000 200.61000061035156 ${n}${n} 9${n}\n`);
    assert.deepEqual(scan(["other.txt"], dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the repository check passes on each published test number, alone and in groups; each one has a valid check digit", () => {
  for (const n of PUBLISHED_TEST_NUMBERS) {
    assert.ok(/^\d{13,19}$/.test(n) && luhn(n), `${n.slice(0, 2)}..: a test number of the right form`);
    const groups = n.match(/.{1,4}/g)!;
    assert.deepEqual(cardNumbersIn(`${n} ${groups.join(" ")} ${groups.join("-")}`), [], "allowed");
    assert.deepEqual(cardNumbersIn(n, []), [n], "found without the list");
  }
  for (const n of Object.values(TEST_CARDS)) assert.ok(PUBLISHED_TEST_NUMBERS.includes(n), "the named test cards are on the list");
  assert.equal(new Set(PUBLISHED_TEST_NUMBERS).size, PUBLISHED_TEST_NUMBERS.length, "each number once");
});
