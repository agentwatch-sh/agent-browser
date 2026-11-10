// The generator of a person's keys (board ab-t30.4; the input design,
// docs/superpowers/specs/2026-11-10-vanilla-playwright-human-input-design.md, sections 4.5, 7.2, 10.2, 11.1 and 13.1; C11
// "The input stage", the answers and the keys): the hold, the time from one press to the next with its letter-pair part,
// the pauses, the drift, rollover with the early answer of a release, the Shift key and its side, the chords, no
// corrections, no lock key, the fast end of a long run, and the plan of a text for the typing rule. Each with a seed; each
// rule of section 10.2 has a test here, and the pull request's mutation table names them. The overlap share is the
// harness's own measure (test/live/input-harness/measures.ts, K3) on the plan's events.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  charKey, handOf, KeyStream, keyHoldMs, baseMs, pairMs, pairClass, pauseAfter, nextDrift, planText, typingPace, CONTROL, SHIFT,
  type Key, type KeyEv,
} from "../src/human/keys.ts";
import { drawPerson, middlePerson, paramsFor, personFor, type Person } from "../src/human/person.ts";
import { normalCdf, normalQuantile, seededRandom } from "../src/human/random.ts";
import { parseKey } from "../src/record.ts";
import { keyMeasures, type Rec } from "./live/input-harness/measures.ts";

const LINUX = paramsFor("linux"), MAC = paramsFor("darwin");
const MID = middlePerson(LINUX);
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a: number[]) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const k = (ch: string): Key => { const x = charKey(ch); assert.ok(x, `a US key for ${JSON.stringify(ch)}`); return x; };

/** English text: the fit's corpus (design 10.2: the share of rollover is fitted on text such as this). */
const CORPUS = [
  "the quick brown fox jumps over the lazy dog and then it runs into the woods to find something to eat",
  "she said that they would meet at the station at noon, but the train was late and nobody knew why",
  "please send me the report before the end of the week so that i can read it over the weekend",
  "we have been working on this project for a long time and we think it is almost ready for the next step",
  "there is a small house at the end of the road where an old man lives with his two cats and a dog",
];
const TEXT = CORPUS.join(" ");

/** A plan's events as the recorder logs them, for the harness's own key measures (K1 to K4). */
const recs = (events: readonly KeyEv[]): Rec[] =>
  events.map((e) => ({ e: e.type === "keyUp" ? "keyup" : "keydown", f: "top", t: e.t, h: e.t + 1, tr: 1, k: e.key, c: e.code, l: e.location, m: e.modifiers, nl: 0, r: 0 }));
const measure = (events: readonly KeyEv[]) => keyMeasures(recs(events))!;
/** The presses of the plan's characters (not its own Shift or modifier keys), in time order. */
const presses = (events: readonly KeyEv[]) => events.filter((e) => e.type !== "keyUp" && !e.own).sort((a, b) => a.t - b.t);
/** Press-to-press times of the characters (ms). */
const gaps = (events: readonly KeyEv[]) => { const p = presses(events); return p.slice(1).map((e, i) => e.t - p[i].t); };
/** A text's events at the person's speed (no fast end after 12 s: the fit and the rules are the person's own). */
const plan = (text: string, seed: number, person: Person = MID) => planText(text, person, seededRandom(seed), { runSlowMs: Infinity }).events;

// ================================================================ the parameter files

test("keys: the parameter files hold the first values of design 10.2 and agree with C11's vectors (test/vectors/stage.json); the Mac's keys are Linux's", () => {
  const V = JSON.parse(readFileSync(new URL("./vectors/stage.json", import.meta.url), "utf8")), c = V.constants, f = V.firstValues;
  for (const p of [LINUX, MAC]) {
    const K = p.keys;
    const hold = K.holdMs as { lognormal: [number, number]; min: number; max: number };
    assert.deepEqual([hold.min, hold.max], f.keyHoldMs);
    // A lognormal of mean 116 ms and SD 24 ms [19]: median = mean / sqrt(1 + cv^2), sigma = sqrt(ln(1 + cv^2)).
    const cv = 24 / 116;
    assert.ok(Math.abs(hold.lognormal[0] - 116 / Math.sqrt(1 + cv * cv)) < 0.1 && Math.abs(hold.lognormal[1] - Math.sqrt(Math.log(1 + cv * cv))) < 0.001, JSON.stringify(hold));
    assert.deepEqual([K.shift.beforeMs, K.shift.afterMs, K.chord.beforeMs, K.chord.releaseGapMs, K.fastMs],
      [{ uniform: f.shiftBeforeMs }, { uniform: f.shiftAfterMs }, { uniform: f.chordBeforeMs }, { uniform: f.chordReleaseGapMs }, { uniform: f.fastKeyMs }]);
    assert.deepEqual([K.runSlowMs, K.typeMaxMs], [c.STAGE_RUN_SLOW_MS, c.STAGE_TYPE_MAX_MS]);
    assert.deepEqual([K.pauseMs.space, K.pauseMs.mark, K.pauseMs.line], [{ uniform: [20, 120] }, { uniform: [80, 250] }, { uniform: [200, 600] }]);
    assert.deepEqual([K.drift.min, K.drift.max, K.shift.otherHandShare], [0.85, 1.15, 0.7]);
    assert.equal(K.pairMs.twoHands, 0, "the pairs of two hands are the fastest: no part of their own");
    for (const s of ["keys.holdMs", "keys.baseMs", "keys.pairMs", "keys.pauseMs", "keys.drift", "keys.shift", "keys.chord", "keys.fastMs", "keys.runSlowMs", "population.keySpeed"])
      assert.ok(typeof (p as any).sources[s] === "string" && (p as any).sources[s].length > 10, `${p.platform}: the source of ${s}`);
  }
  assert.deepEqual(MAC.keys, LINUX.keys);
});

test("keys: one person for each scope also types as one: the key speed is drawn once for the scope, inside the population's bounds; the middle person's is 1", () => {
  const a = personFor("s-a", 41, LINUX);
  assert.equal(personFor("s-a", 41, LINUX).keySpeed, a.keySpeed);
  const people = Array.from({ length: 300 }, (_, i) => personFor(`scope-${i}`, 1, LINUX)), pop = LINUX.population.keySpeed as { min: number; max: number };
  assert.ok(people.every((p) => p.keySpeed >= pop.min && p.keySpeed <= pop.max));
  assert.ok(new Set(people.map((p) => p.keySpeed.toFixed(6))).size > 290, "the people differ");
  assert.ok(Math.abs(median(people.map((p) => p.keySpeed)) - 1) < 0.03);
  assert.equal(MID.keySpeed, 1);
  // The pointer's values of a person stay as they were (the key speed is drawn after them).
  const r1 = seededRandom(9), r2 = seededRandom(9), p1 = drawPerson(LINUX, r1), p2 = drawPerson(LINUX, r2);
  assert.deepEqual(p1, p2);
});

// ================================================================ the rules of design 10.2

test("keys rule the hold: a lognormal per key, mean 116 ms, SD 24 ms, from 50 to 250 ms; a caller's range takes the place of the bounds", () => {
  const r = seededRandom(21), v = Array.from({ length: 4000 }, () => keyHoldMs(MID, r));
  assert.ok(v.every((x) => x >= 50 && x <= 250));
  assert.ok(Math.abs(mean(v) - 116) < 3 && Math.abs(sd(v) - 24) < 3, `mean ${mean(v)}, sd ${sd(v)}`);
  assert.ok(Array.from({ length: 50 }, () => keyHoldMs(MID, r, [1, 2])).every((x) => x >= 1 && x <= 2));
  // In a plan: each key's hold is its own draw (a release at its press plus its hold), per key.
  const ev = plan(TEXT, 3), m = measure(ev);
  assert.ok(Math.abs(mean(m.holds) - 116) < 6 && Math.abs(sd(m.holds) - 24) < 6, `plan: mean ${mean(m.holds)}, sd ${sd(m.holds)}`);
  for (const [key, h] of Object.entries(m.holdsByKey)) if (h.length >= 30) assert.ok(Math.abs(mean(h) - 116) < 15, `key ${JSON.stringify(key)}: ${mean(h)}`);
});

test("keys rule the time from one press to the next: a lognormal with the person's mean, with a part for each letter pair: the pairs of two hands fastest, then one hand, one finger", () => {
  const r = seededRandom(5), base = LINUX.keys.baseMs as { lognormal: [number, number]; min: number; max: number };
  const b1 = Array.from({ length: 4000 }, () => baseMs(MID, r)), slow = { ...MID, keySpeed: 1.2 }, b2 = Array.from({ length: 4000 }, () => baseMs(slow, r));
  // The median of the lognormal inside its bounds (the draw is the inverse of the CDF on the bounded part).
  const [m0, s0] = base.lognormal, z = (x: number) => normalCdf(Math.log(x / m0) / s0), want = m0 * Math.exp(s0 * normalQuantile((z(base.min) + z(base.max)) / 2));
  assert.ok(Math.abs(median(b1) / want - 1) < 0.05 && b1.every((x) => x >= base.min && x <= base.max), `the median of the base part: ${median(b1)}, not ${want}`);
  assert.ok(Math.abs(median(b2) / median(b1) - 1.2) < 0.06, "times the person's speed");
  assert.deepEqual([pairClass(k("t"), k("h")), pairClass(k("e"), k("r")), pairClass(k("e"), k("d")), pairClass(k("l"), k("l")), pairClass(k(" "), k("t")), pairClass(k("a"), k(" "))],
    ["twoHands", "sameHand", "sameFinger", "sameKey", "twoHands", "twoHands"]);
  assert.deepEqual([handOf("KeyT"), handOf("KeyH"), handOf("Space"), handOf("Digit6"), handOf("Backquote")], ["left", "right", "thumb", "right", "left"]);
  const P = LINUX.keys.pairMs;
  assert.ok(P.twoHands === 0 && P.sameHand > 0 && P.sameFinger > P.sameHand && P.sameKey > 0, JSON.stringify(P));
  assert.equal(pairMs(k("t"), k("h"), MID), 0);
  assert.equal(pairMs(k("e"), k("d"), slow), P.sameFinger * 1.2, "the pair's part follows the person's speed");
  // Pooled over English text, an average typist: a mean of about 239 ms [19] (the harness's K2 reference). The SD: the literature's
  // 112 ms with a heavier tail of the fit (about 150 ms): a lognormal with that mean and SD gives only 8% of the intervals below
  // the mean hold, so 25% of rollover needs more short intervals and a longer tail (the parameter file's sources).
  const all = Array.from({ length: 12 }, (_, i) => gaps(plan(CORPUS[i % CORPUS.length], 100 + i))).flat();
  assert.ok(Math.abs(mean(all) - 239) < 25 && sd(all) > 100 && sd(all) < 170, `mean ${mean(all)}, sd ${sd(all)}`);
  // Per pair: two hands faster than one finger.
  const byClass = (cls: string) => { const out: number[] = []; for (let i = 0; i < 8; i++) { const ev = presses(plan(TEXT, 200 + i)); for (let j = 1; j < ev.length; j++) {
    const a = charKey(ev[j - 1].text ?? ""), b = charKey(ev[j].text ?? ""); if (a && b && a.key !== " " && b.key !== " " && pairClass(a, b) === cls && !(a.modifiers || b.modifiers) && !/[.,]/.test(a.key)) out.push(ev[j].t - ev[j - 1].t); } } return out; };
  assert.ok(median(byClass("twoHands")) + 40 < median(byClass("sameFinger")), `two hands ${median(byClass("twoHands"))}, one finger ${median(byClass("sameFinger"))}`);
});

test("keys rule the pauses: after a space 20 to 120 ms more, after a mark (.,;:!?) 80 to 250 ms more, at a line's end (Enter) 200 to 600 ms more", () => {
  const r = seededRandom(8), enter = parseKey("Enter");
  for (const [prev, lo, hi] of [[k(" "), 20, 120], [k("."), 80, 250], [k(","), 80, 250], [k("?"), 80, 250], [k(";"), 80, 250], [enter, 200, 600]] as const) {
    const v = Array.from({ length: 2000 }, () => pauseAfter(prev, MID, r));
    assert.ok(v.every((x) => x >= lo && x <= hi), `${prev.key}: ${Math.min(...v)} to ${Math.max(...v)}`);
    assert.ok(Math.min(...v) < lo + 0.05 * (hi - lo) && Math.max(...v) > hi - 0.05 * (hi - lo), `${prev.key}: over the whole range`);
  }
  for (const ch of ["a", "Z", "1", "-", "'"]) assert.equal(pauseAfter(k(ch), MID, r), 0, ch);
  // In a plan: the press after a space comes about 70 ms later than after a letter of the other hand (two hands: no pair part).
  const after = (prev: string) => { const v: number[] = []; for (let i = 0; i < 1500; i++) { const ev = presses(plan(`a${prev}j`, 1000 + i)); v.push(ev[2].t - ev[1].t); } return mean(v); };
  const d = after(" ") - after("a");
  assert.ok(d > 45 && d < 95, `the pause after a space: ${d} ms more`);
});

test("keys rule the speed in a session: a slow drift from word to word, a factor from 0.85 to 1.15", () => {
  const r = seededRandom(13), d = [1];
  for (let i = 0; i < 3000; i++) d.push(nextDrift(d[i], MID, r));
  assert.ok(d.every((x) => x >= 0.85 && x <= 1.15));
  assert.ok(Math.min(...d) < 0.9 && Math.max(...d) > 1.1, `it varies: ${Math.min(...d)} to ${Math.max(...d)}`);
  const lag1 = (() => { const a = d.slice(0, -1), b = d.slice(1), ma = mean(a), mb = mean(b); let n = 0, x = 0, y = 0;
    for (let i = 0; i < a.length; i++) { n += (a[i] - ma) * (b[i] - mb); x += (a[i] - ma) ** 2; y += (b[i] - mb) ** 2; } return n / Math.sqrt(x * y); })();
  assert.ok(lag1 > 0.5, `slow: the next word's factor follows this one's (lag-1 correlation ${lag1.toFixed(2)})`);
  // In a stream it changes only at a word's start: the keys of one word share one factor.
  const s = new KeyStream(MID, seededRandom(14)), seen: { ch: string; drift: number }[] = [];
  let at = 0;
  for (const ch of "one two three four five six seven eight nine ten") {
    const key = k(ch), p = s.next(key, at);
    at = p.at(-1)!.t;
    seen.push({ ch, drift: s.drift });
    const rel = s.release(key, at);
    at = rel.early ? at : rel.events.at(-1)!.t;
  }
  const words = "one two three four five six seven eight nine ten".split(" ");
  let i = 0;
  const per: number[] = [];
  for (const w of words) {
    const own = seen.slice(i, i + w.length).map((x) => x.drift);
    assert.ok(own.every((x) => x === own[0]), `one factor in "${w}": ${own.join(", ")}`);
    per.push(own[0]);
    i += w.length + 1;
  }
  assert.ok(new Set(per).size > 5, `the factor changes from word to word: ${per.join(", ")}`);
});

test("keys rule rollover: the next press before this key's release in about 25% of keys for an average typist (the letter-pair part's fit), and 15% to 50% for every person of the population (K3)", () => {
  const shares = CORPUS.map((t, i) => measure(plan(t, 300 + i)).overlapShare!);
  const all = Array.from({ length: 10 }, (_, i) => measure(plan(TEXT, 400 + i)));
  const pooled = all.reduce((a, m) => a + m.overlaps, 0) / all.reduce((a, m) => a + m.keys - 1, 0);
  assert.ok(pooled >= 0.22 && pooled <= 0.28, `the middle person's share: ${pooled.toFixed(3)} (texts: ${shares.map((x) => x.toFixed(2)).join(", ")})`);
  for (let i = 0; i < 60; i++) {
    const p = personFor(`scope-${i}`, 7, LINUX), m = measure(plan(TEXT, 500 + i, p));
    assert.ok(m.overlapShare! >= 0.15 && m.overlapShare! <= 0.5, `person ${i} (key speed ${p.keySpeed.toFixed(2)}): ${m.overlapShare}`);
  }
  // With the hold and the base interval alone (no letter-pair part: every pair at the pooled mean), the share falls to about 10%
  // (review-96, N5): the letter-pair part gives it.
  const flat = { ...MID, params: { ...LINUX, keys: { ...LINUX.keys, baseMs: { lognormal: [216.4, 0.446] as [number, number], min: 40, max: 1500 }, pairMs: { twoHands: 0, sameHand: 0, sameFinger: 0, sameKey: 0 } } } } as Person;
  const fm = Array.from({ length: 6 }, (_, i) => measure(plan(TEXT, 600 + i, flat)));
  const fs = fm.reduce((a, m) => a + m.overlaps, 0) / fm.reduce((a, m) => a + m.keys - 1, 0);
  assert.ok(fs < 0.16, `no letter-pair part: ${fs.toFixed(3)}`);
});

test("keys rule the early answer: a release is answered early only when the next interval's base part is shorter than the hold; the next press then can come before it; a release that is not early is never passed", () => {
  let early = 0, overlaps = 0, notEarly = 0;
  for (let seed = 0; seed < 40; seed++) {
    const s = new KeyStream(MID, seededRandom(700 + seed));
    let at = 0, last: { t: number; early: boolean } | undefined;
    for (const ch of "the lazy dog jumps over three hills") {
      const key = k(ch), p = s.next(key, at), press = p.find((e) => !e.own && e.type !== "keyUp")!;
      if (last && press.t < last.t) { overlaps++; assert.ok(last.early, `a press before an earlier release: only after an early answer (seed ${seed})`); }
      if (last && !last.early) assert.ok(press.t >= last.t, "a release that is not early is never passed by the next press");
      at = press.t;
      const r = s.release(key, at), up = r.events.find((e) => !e.own)!;
      assert.ok(up.t >= press.t + 50 - 1e-9, "the stream never sends a release before its planned hold");
      if (r.early) early++; else notEarly++;
      last = { t: up.t, early: r.early };
      at = r.early ? at : r.events.at(-1)!.t; // an early answer: the client's next key comes at once
    }
  }
  assert.ok(overlaps > 0 && early >= overlaps && notEarly > early, `${early} early answers, ${overlaps} overlaps, ${notEarly} not early`);
  // An early answer only for a release in the future: a client's delay (the release arrives after the hold) is not early.
  const s = new KeyStream(MID, seededRandom(1));
  const p = s.next(k("a"), 0)[0];
  const late = s.release(k("a"), p.t + 300);
  assert.deepEqual([late.early, late.events[0].t], [false, p.t + 300], "a release at the later of its arrival and its planned hold");
  const b = s.next(k("b"), p.t + 300)[0];
  assert.ok(b.t >= p.t + 300, "a press at the later of its arrival and its planned time");
});

test("keys rule Shift: a Shift rawKeyDown 45 to 95 ms before a shifted character (modifiers 8 on it), its release 15 to 60 ms after the last held key's release; a run of capitals keeps Shift down; a key with no Shift waits for that release", () => {
  for (let seed = 0; seed < 200; seed++) {
    const ev = plan("Hi there OK! A Test of SHIFT.", 900 + seed);
    const shiftDowns = ev.filter((e) => e.key === "Shift" && e.type === "rawKeyDown"), shiftUps = ev.filter((e) => e.key === "Shift" && e.type === "keyUp");
    assert.equal(shiftDowns.length, 5, "one Shift press for H, for OK!, for A, for T, for SHIFT, none for the rest");
    assert.equal(shiftUps.length, 5);
    for (const sd0 of shiftDowns) {
      assert.ok(sd0.own && sd0.modifiers === SHIFT && sd0.keyCode === 16 && (sd0.location === 1 || sd0.location === 2), JSON.stringify(sd0));
      const first = ev.filter((e) => !e.own && e.type === "keyDown" && e.t >= sd0.t).sort((a, b) => a.t - b.t)[0];
      assert.ok(first.t - sd0.t >= 45 - 1e-9 && first.t - sd0.t <= 95 + 1e-9, `the Shift press ${first.t - sd0.t} ms before ${first.key}`);
    }
    for (const c of ev.filter((e) => !e.own && e.type === "keyDown")) assert.equal(c.modifiers & SHIFT ? 1 : 0, /^[A-Z!?]$/.test(c.text ?? "") ? 1 : 0, `${c.text}: modifiers ${c.modifiers}`);
    for (const up of shiftUps) {
      const held = ev.filter((e) => !e.own && e.type === "keyUp" && e.t <= up.t).sort((a, b) => a.t - b.t).at(-1)!;
      assert.ok(up.t - held.t >= 15 - 1e-9 && up.t - held.t <= 60 + 1e-9, `the Shift release ${up.t - held.t} ms after ${held.key}'s`);
      assert.equal(up.modifiers, 0);
      const next = ev.filter((e) => !e.own && e.type === "keyDown" && e.t > held.t).sort((a, b) => a.t - b.t)[0];
      if (next) assert.ok(next.t > up.t, `${next.key} waits for the Shift release`);
    }
  }
  // Hands' chords keep the rule: a run of Shift+ArrowRight keeps Shift down.
  const s = new KeyStream(MID, seededRandom(2)), right = parseKey("Shift+ArrowRight"), all: KeyEv[] = [];
  let at = 0;
  for (let i = 0; i < 3; i++) { const p = s.next(right, at); all.push(...p); at = p.at(-1)!.t; const r = s.release(right, at); all.push(...r.events); at = r.early ? at : r.events.at(-1)!.t; }
  all.push(...s.end(at));
  assert.deepEqual(all.filter((e) => e.key === "Shift").map((e) => e.type), ["rawKeyDown", "keyUp"]);
});

test("keys rule Shift's side: the left Shift (location 1) for a key of the right hand, the right Shift (location 2) for a key of the left hand, in about 70% of cases", () => {
  let other = 0, n = 0;
  for (let seed = 0; seed < 3000; seed++) {
    const ch = "QWERTASDFGZXCVBYUIOPHJKLNM"[seed % 26], ev = plan(ch, 3000 + seed), shift = ev.find((e) => e.key === "Shift")!;
    assert.equal(shift.code, shift.location === 1 ? "ShiftLeft" : "ShiftRight");
    n++;
    if ((handOf(k(ch).code) === "left" ? 2 : 1) === shift.location) other++;
  }
  assert.ok(Math.abs(other / n - 0.7) < 0.03, `${other} of ${n}`);
  const m = measure(plan("Hello World, OK! The Day After Tomorrow Is Here.", 4));
  assert.ok(m.shiftDowns > 0 && m.shiftLocations.every((l) => l === 1 || l === 2) && m.shiftUpAfter === m.shiftedWithShiftDown && m.shiftedWithShiftDown === m.shiftedChars,
    "the harness's K4 measures on a plan: every shifted character under a Shift with a location, released after it");
});

test("keys rule a chord: each modifier 40 to 120 ms before the key, the releases 20 to 80 ms apart in reverse order; a key with no modifier waits for them", () => {
  for (let seed = 0; seed < 100; seed++) {
    const s = new KeyStream(MID, seededRandom(seed)), home = parseKey("Control+Home");
    const p = s.next(home, 0), r = s.release(home, p.at(-1)!.t), after = s.next(k("a"), r.events.at(-1)!.t);
    assert.deepEqual(p.map((e) => [e.type, e.key, e.modifiers, e.own]), [["rawKeyDown", "Control", CONTROL, true], ["rawKeyDown", "Home", CONTROL, false]]);
    assert.ok(p[1].t - p[0].t >= 40 && p[1].t - p[0].t <= 120, `${p[1].t - p[0].t}`);
    assert.deepEqual(r.events.map((e) => [e.type, e.key, e.modifiers]), [["keyUp", "Home", CONTROL], ["keyUp", "Control", 0]]);
    assert.ok(r.events[1].t - r.events[0].t >= 20 && r.events[1].t - r.events[0].t <= 80);
    assert.equal(r.early, false, "a chord's release is never answered early");
    assert.ok(after[0].t > r.events[1].t && after[0].modifiers === 0);
  }
  // A client's own modifiers (Playwright's keyboard.press('Control+A')): the key 40 to 120 ms after the client's Control, its release
  // 20 to 80 ms before the client's Control release.
  const s = new KeyStream(MID, seededRandom(3)), ctrl: Key = { key: "Control", code: "ControlLeft", keyCode: 17, modifiers: CONTROL }, a: Key = { key: "A", code: "KeyA", keyCode: 65, text: "", modifiers: CONTROL };
  const c = s.next(ctrl, 0), ka = s.next(a, c[0].t), ra = s.release(a, ka[0].t), rc = s.release(ctrl, ra.events[0].t);
  assert.deepEqual([c[0].type, c[0].t, c[0].location, ka.length, ka[0].type, ka[0].modifiers], ["rawKeyDown", 0, 1, 1, "rawKeyDown", CONTROL]);
  assert.ok(ka[0].t >= 40 && ka[0].t <= 120 && rc.events[0].t - ra.events[0].t >= 20 && rc.events[0].t - ra.events[0].t <= 80);
  assert.equal(rc.events[0].modifiers, 0);
});

test("keys rule no corrections: the plan types exactly its text, with no Backspace and no key that the text does not have", () => {
  for (let seed = 0; seed < 20; seed++) {
    const text = CORPUS[seed % CORPUS.length] + " Hello, World!\nNew line.", ev = plan(text, 50 + seed);
    const typed = presses(ev).map((e) => (e.key === "Enter" ? "\n" : e.text)).join("");
    assert.equal(typed, text);
    assert.ok(!ev.some((e) => /^(Backspace|Delete)$/.test(e.key)));
    assert.ok(ev.filter((e) => e.own).every((e) => e.key === "Shift"), "the plan's own keys are Shift only");
    assert.equal(ev.filter((e) => e.type !== "keyUp").length, ev.filter((e) => e.type === "keyUp").length, "each press has its release");
  }
});

test("keys rule NumLock and CapsLock off: no lock key, and no modifier beyond Alt, Control, Meta and Shift", () => {
  const ev = plan(TEXT + " ALL CAPS HERE, and 123 numbers 456!", 77);
  assert.ok(!ev.some((e) => /^(NumLock|CapsLock|ScrollLock)$/.test(e.key) || /^(NumLock|CapsLock)$/.test(e.code)));
  assert.ok(ev.every((e) => Number.isInteger(e.modifiers) && e.modifiers >= 0 && e.modifiers <= 15));
  assert.ok(ev.every((e) => !/^Numpad/.test(e.code)), "digits from the row, not the number pad");
});

test("keys rule the run's time: a person's speed for the first 12 s of a run, then the fast end (100 to 120 ms a key)", () => {
  const text = `${CORPUS[0]} ${CORPUS[3]}`, ev = planText(text, MID, seededRandom(11)).events, p = presses(ev);
  const start = p[0].t, slow = p.filter((e) => e.t - start < 12000), fast = p.filter((e) => e.t - start >= 12000 + 300);
  assert.ok(slow.length > 30 && fast.length > 30, `${slow.length} slow, ${fast.length} fast`);
  // One key twice ("oo") waits for its own release: those pairs are left out.
  const g = fast.slice(1).map((e, i) => (e.code === fast[i].code ? undefined : e.t - fast[i].t)).filter((x) => x !== undefined);
  assert.ok(g.length > 30 && g.every((x) => x >= 100 - 1e-9 && x <= 120 + 1e-9), `fast: ${Math.min(...g)} to ${Math.max(...g)}`);
  const gs = slow.slice(1).map((e, i) => e.t - slow[i].t);
  assert.ok(mean(gs) > 150, `the person's speed first: ${mean(gs)}`);
  assert.equal(presses(ev).map((e) => e.text).join(""), text);
  const f = new KeyStream(MID, seededRandom(4), { pace: "fast" }), a = f.next(k("a"), 0)[0];
  f.release(k("a"), a.t);
  const b = f.next(k("j"), a.t)[0];
  assert.ok(b.t - a.t >= 100 && b.t - a.t <= 120, "a stream at the fast end from its start");
});

test("keys: the plan of a text, and the typing rule's pace: a text that fits in 10 s at the person's speed, else at the fast end, else none (the answer Q2 a)", () => {
  const short = "see you at noon", mid = "Meet me at the old oak tree at noon, then we go home", long = "x".repeat(140);
  assert.equal(typingPace(short, MID, seededRandom(1))?.pace, "person");
  const m = typingPace(mid, MID, seededRandom(2));
  assert.equal(m?.pace, "fast", `${mid.length} characters`);
  assert.ok(m!.plan.ms <= 10000 && planText(mid, MID, seededRandom(2)).ms > 10000);
  assert.equal(typingPace(long, MID, seededRandom(3)), null);
  const ev = planText("Hello", MID, seededRandom(44)).events;
  assert.deepEqual(ev.filter((e) => e.type !== "keyUp").map((e) => e.key), ["Shift", "H", "e", "l", "l", "o"]);
  for (const c of ev.filter((e) => !e.own && e.type === "keyDown")) {
    const up = ev.find((e) => e.type === "keyUp" && e.code === c.code && e.t >= c.t)!;
    assert.ok(up.t - c.t >= 50 && up.t - c.t <= 250, "each hold in keyHoldMs (C11's vector insert-text)");
  }
});

test("keys: an inserted text (a character with no US key) goes after every planned release and the Shift release, one interval after the last press", () => {
  const s = new KeyStream(MID, seededRandom(6)), p = s.next(k("A"), 0), r = s.release(k("A"), p.at(-1)!.t);
  const ins = s.insert(p.at(-1)!.t);
  const shiftUp = ins.events.find((e) => e.key === "Shift" && e.type === "keyUp")!;
  assert.ok(shiftUp && ins.t > shiftUp.t && ins.t > r.events[0].t, JSON.stringify({ ins, r }));
  const plan2 = planText("aéb", MID, seededRandom(7));
  assert.equal(plan2.inserts.length, 1);
  const [a, b] = presses(plan2.events);
  assert.ok(plan2.inserts[0] > a.t && b.t > plan2.inserts[0]);
});

// ================================================================ C11's vectors of the keys

test("keys: the stream fits C11's key vectors (test/vectors/stage.json): type ('Hi'), type-delay and press-chord, with their answers", () => {
  const V = JSON.parse(readFileSync(new URL("./vectors/stage.json", import.meta.url), "utf8"));
  for (const id of ["type", "type-delay", "press-chord"]) {
    const vec = V.vectors.find((v: any) => v.id === id);
    for (let seed = 0; seed < 50; seed++) {
      const s = new KeyStream(MID, seededRandom(seed * 31 + vec.seed)), out: KeyEv[] = [], answer = new Map<number, number>(), arrive = new Map<number, number>();
      for (const call of vec.in) {
        const at = call.at ?? answer.get(call.after)! + (call.waitMs ?? 0);
        arrive.set(call.id, at);
        const p = call.params, ch = p.text ? charKey(p.text) : undefined;
        // The stage's key: what the client's key types (a capital needs Shift on the US layout), with the client's modifiers.
        const key: Key = { key: p.key, code: p.code, keyCode: p.windowsVirtualKeyCode, ...(p.text !== undefined ? { text: p.text } : {}), modifiers: (p.modifiers ?? 0) | (ch?.modifiers ?? 0) };
        if (p.type === "keyUp") {
          const r = s.release(key, at);
          out.push(...r.events);
          answer.set(call.id, r.early ? at : Math.max(...r.events.map((e) => e.t)));
        } else {
          const ev = s.next(key, at);
          out.push(...ev);
          answer.set(call.id, Math.max(...ev.map((e) => e.t)));
        }
      }
      out.push(...s.end(Math.max(...answer.values())));
      out.sort((a, b) => a.t - b.t);
      assert.equal(out.length, vec.out.length, `${id}: ${out.map((e) => `${e.type} ${e.key}`).join(", ")}`);
      vec.out.forEach((o: any, i: number) => {
        const e = out[i], from = o.from.startsWith("in:") ? arrive.get(Number(o.from.slice(3)))! : out[Number(o.from.slice(4))].t;
        assert.equal(e.type, o.type, `${id} out:${i}`);
        assert.ok(e.t - from >= o.at[0] - 1e-9 && e.t - from <= o.at[1] + 1e-9, `${id} out:${i} (${o.type} ${o.fields.key}): ${e.t - from} ms after ${o.from}, not in ${o.at}`);
        for (const [f, want] of Object.entries(o.fields)) {
          const got = f === "windowsVirtualKeyCode" ? e.keyCode : (e as any)[f];
          assert.deepEqual(got, want, `${id} out:${i} ${f}`);
        }
      });
    }
  }
});
