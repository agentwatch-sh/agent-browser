// The repository check of card numbers (the secure card checkout design, R4 and section 11; board ab-sta.5, the plan's
// Task 4). It reads each tracked file (git ls-files) and fails on each card-like number that is not a payment provider's
// published test number (test/pay-test-cards.ts, the one file that holds them): a run of 13 to 19 digits, alone or in
// groups that a space or a dash splits, with a valid check digit (Luhn). A binary file (a NUL byte in its first 8000
// bytes: agent.crx, a PDF) is skipped, and no regex runs over it.
//
// How the check reads a text: each run of digit groups (a space or a dash between two groups) gives each window of whole
// groups with 13 to 19 digits, so a number next to other digits (`<number> 12/34`, `<number> 123`, `1 <number>`) is
// found (review-226 B1). A window of two or more groups counts only when each of its groups has 3 or more digits, as the
// groups of card numbers have (4-4-4-4, 4-6-5, 4-4-4-4-3).
//
// What a card number is here, so that the check finds no number of another kind in the repository (each rule of the
// list is a measured case of this repository): its first digits are 2 to 7 or 9, 81 or 82 (RuPay), or 1 with exactly 15
// digits (UATP); its digits are not all one digit; and it is not the decimal part of a number (`200.61000061035156`).
// The limit (review-226 N6): a number that starts 80 or 83 to 89, or 1 with another length, is not checked. In this
// repository such runs are no card numbers: a process line of a probe's results starts 80, and times in milliseconds
// (13 digits) and microseconds (16 digits) start 1. Windows of groups of 1 or 2 digits give runs of other kinds too
// (the lines of /proc, a date with counts).
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
/** A run of digit groups: a space or a dash between two groups, not after `<digit>.` (a decimal part). */
const RUN = /(?<![0-9])(?<![0-9]\.)[0-9]+(?:[ -][0-9]+)*(?![0-9])/g;
/** The first digits of a card number that the check takes (the head of this file: the rule and its limit). */
const cardHead = (d: string) => /^[2-79]/.test(d) || /^8[12]/.test(d) || (d[0] === "1" && d.length === 15);
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
  for (const m of text.matchAll(RUN)) {
    const groups = m[0].split(/[ -]/);
    // Each window of whole groups with 13 to 19 digits (review-226 B1); two or more groups only of 3 or more digits each.
    for (let i = 0; i < groups.length; i++) {
      let d = "";
      for (let j = i; j < groups.length; j++) {
        if (j > i && (groups[j].length < 3 || groups[i].length < 3)) break;
        d += groups[j];
        if (d.length > 19) break;
        if (d.length < 13 || !cardHead(d) || /^(\d)\1+$/.test(d) || !luhn(d)) continue;
        if (!allowed.includes(d)) out.push(d);
      }
    }
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

/**
 * A made-up number with a valid check digit that is no published test number: made at run time, never written in the
 * repository. `head`: its first digits (a Visa's 4 by default); `length`: its digits (16 by default).
 */
function madeUpNumber(head = "4", length = 16): string {
  for (;;) {
    const body = `${head}${Array.from({ length: length - head.length - 1 }, () => Math.floor(Math.random() * 10)).join("")}`;
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
    // review-226 B1: the number next to other digits (an expiry, a security code, a count) is found too.
    const forms = [n, groups.join(" "), groups.join("-"), `card:${n}.`, `"${groups.join(" ")}"`, `${n} 12/34`, `${n} 123`, `1 ${n}`, `${groups.join(" ")} 123`, `7 ${groups.join("-")} 12`];
    forms.forEach((form, i) => writeFileSync(join(dir, `f${i}.txt`), `a line before\nthe value ${form}\n`));
    forms.forEach((form, i) => assert.ok(cardNumbersIn(readFileSync(join(dir, `f${i}.txt`), "utf8")).includes(n), `the form ${i}: ${form.replace(/\d/g, "#")}`));
    const hits = scan(forms.map((_, i) => `f${i}.txt`), dir);
    assert.ok(hits.length >= forms.length, "each form of the number is found");
    for (const h of hits) assert.ok(!h.includes(n.slice(2)), "the message never repeats the number");
    // A binary file is skipped: a NUL byte first, then the number.
    writeFileSync(join(dir, "bin.dat"), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(` ${n} `)]));
    assert.deepEqual(scan(["bin.dat"], dir), [], "a binary file is not read past its first bytes");
    // Numbers of other kinds are none: a time in milliseconds, zeros, a decimal part, a longer run.
    writeFileSync(join(dir, "other.txt"), `1763740800000 0000000000000000 200.61000061035156 ${n}${n} 9${n}\n`);
    assert.deepEqual(scan(["other.txt"], dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("review-226 N6: the first digits of a card number: 2 to 7 and 9, 81 and 82 (RuPay), and 1 with 15 digits (UATP); the limit: 80 and 83 to 89, and 1 with other lengths", () => {
  for (const [head, length] of [["2", 16], ["3", 15], ["5", 16], ["6", 19], ["7", 16], ["9", 16], ["81", 16], ["82", 16], ["1", 15]] as const) {
    const n = madeUpNumber(head, length);
    assert.deepEqual(cardNumbersIn(`x ${n} y`), [n], `a number of ${length} digits that starts ${head}`);
  }
  // The limit, stated in the head of this file: such runs in the repository are no card numbers (a process line, times in ms and in microseconds).
  for (const [head, length] of [["80", 16], ["85", 16], ["1", 13], ["1", 16]] as const) {
    assert.deepEqual(cardNumbersIn(`x ${madeUpNumber(head, length)} y`), [], `a run of ${length} digits that starts ${head}`);
  }
  // A run of two or more groups counts only with groups of 3 or more digits each (the groups of card numbers: 4-4-4-4, 4-6-5, 4-4-4-4-3).
  const n = madeUpNumber();
  assert.deepEqual(cardNumbersIn(n.match(/.{1,2}/g)!.join(" ")), [], "groups of two digits");
});

test("the repository check passes on each published test number, alone and in groups; each one has a valid check digit", () => {
  for (const n of PUBLISHED_TEST_NUMBERS) {
    assert.ok(/^\d{13,19}$/.test(n) && luhn(n), `${n.slice(0, 2)}..: a test number of the right form`);
    const groups = n.match(/.{1,4}/g)!;
    assert.deepEqual(cardNumbersIn(`${n}\n${groups.join(" ")}\n${groups.join("-")}\n${n} 12/34\n1 ${n}`), [], "allowed");
    assert.deepEqual(cardNumbersIn(n, []), [n], "found without the list");
  }
  for (const n of Object.values(TEST_CARDS)) assert.ok(PUBLISHED_TEST_NUMBERS.includes(n), "the named test cards are on the list");
  assert.equal(new Set(PUBLISHED_TEST_NUMBERS).size, PUBLISHED_TEST_NUMBERS.length, "each number once");
});
