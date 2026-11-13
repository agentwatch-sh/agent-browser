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
    // runSlowMs (12 s, then the fast end) is the rule of agent-browser's own commands (Hands); the input stage has none
    // since board ab-t30.19 (C11: the key run's time has STAGE_TYPE_MAX_MS), so C11's constants no longer name it.
    assert.deepEqual([K.runSlowMs, K.typeMaxMs], [12000, c.STAGE_TYPE_MAX_MS]);
    assert.ok(!("STAGE_RUN_SLOW_MS" in c), "C11's constants have no STAGE_RUN_SLOW_MS (board ab-t30.19)");
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
  // The pointer's values of a person stay as they were on main before the key model (the key speed is drawn after them;
  // review-111 note 9: the values are pinned, so a draw before them turns this red).
  const pointerOf = (p: Person) => ({ speed: p.speed, pause: p.pause, hold: p.hold, overshootShare: p.overshootShare, side: p.side, tremorPx: p.tremorPx, tremorHz: p.tremorHz });
  assert.deepEqual(pointerOf(drawPerson(LINUX, seededRandom(9))), { speed: 0.9213847532682187, pause: 1.1307971319325292, hold: 0.9019155780868358, overshootShare: 0.36433434346690774, side: 0.5895217602141201, tremorPx: 0.919975449121557, tremorHz: 9.05087373405695 });
  assert.deepEqual(pointerOf(personFor("s-a", 41, LINUX)), { speed: 0.933470560354481, pause: 1.1371460302353742, hold: 1.0922771343404636, overshootShare: 0.26115590590052307, side: 0.558064485155046, tremorPx: 1.1329974404303356, tremorHz: 8.295758288353682 });
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
  // The factor scales the times of its word: two letters' interval is longer in a word with a high factor than in one with a low one.
  const st = new KeyStream(MID, seededRandom(15), { runSlowMs: Infinity }), hi: number[] = [], lo: number[] = [];
  let t0 = 0, prev: { t: number; ch: string } | undefined;
  for (const ch of TEXT.repeat(4)) {
    const key = k(ch), press = st.next(key, t0).at(-1)!;
    if (prev && /[a-z]/.test(prev.ch) && /[a-z]/.test(ch)) (st.drift > 1.04 ? hi : st.drift < 0.96 ? lo : []).push(press.t - prev.t);
    prev = { t: press.t, ch };
    const r = st.release(key, press.t);
    t0 = r.early ? press.t : r.events.at(-1)!.t;
  }
  assert.ok(hi.length > 100 && lo.length > 100 && mean(hi) / mean(lo) > 1.08, `${hi.length} and ${lo.length} intervals: ${mean(hi)} against ${mean(lo)} ms`);
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
  // A key that comes long after its planned time (a client that waits 5 s) goes at its arrival, never before it.
  for (let seed = 0; seed < 20; seed++) {
    const w = new KeyStream(MID, seededRandom(seed)), x = w.next(k("j"), 0)[0];
    w.release(k("j"), x.t);
    const y = w.next(k("f"), x.t + 5000).at(-1)!;
    assert.ok(y.t >= x.t + 5000, `a press at its arrival when that comes after its planned time: ${y.t - x.t} ms (seed ${seed})`);
  }
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
  // Rollover into a capital: a key whose release comes after the next key's Shift press goes up with Shift down (modifiers 8).
  const roll = new KeyStream(MID, seededRandom(5), { holdMs: [200, 210], keyMs: [10, 12] });
  const pa = roll.next(k("a"), 0), ra = roll.release(k("a"), pa[0].t), pb = roll.next(k("B"), pa[0].t);
  assert.ok(ra.early && pb[0].key === "Shift" && pb[0].t < ra.events[0].t, "the Shift press comes in a's hold");
  assert.equal(ra.events[0].modifiers, SHIFT, "a's keyUp, planned before the Shift press, has Shift down at its time");
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
    // A key goes down only while it is up ("ll", "oo": the second press after the first's release).
    const down = new Set<string>();
    for (const e of ev) {
      if (e.type === "keyUp") { down.delete(e.code); continue; }
      assert.ok(!down.has(e.code), `${e.key} goes down twice (seed ${seed})`);
      down.add(e.code);
    }
  }
  // One key twice when the next press is planned inside the first's hold (holds of 200 ms, 10 to 12 ms from one press to the
  // next: the first release is answered early): the second press waits for the first release, 5 to 30 ms after it.
  for (let seed = 0; seed < 20; seed++) {
    const s = new KeyStream(MID, seededRandom(seed), { holdMs: [200, 210], keyMs: [10, 12] });
    const a = s.next(k("l"), 0)[0], r = s.release(k("l"), a.t), b = s.next(k("l"), a.t)[0];
    assert.ok(r.early, "the first release is answered early");
    assert.ok(b.t - r.events[0].t >= 5 - 1e-9 && b.t - r.events[0].t <= 30 + 1e-9, `the second l ${b.t - r.events[0].t} ms after the first's release (seed ${seed})`);
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

test("keys: the plan of a text, and the typing rule's pace: a text that fits in 10 s at the person's speed, else at the fast end, else none (the answer Q2 a); with no fast end (the input stage, board item ab-2qb) the person's speed or none", () => {
  const short = "see you at noon", mid = "Meet me at the old oak tree at noon, then we go home", long = "x".repeat(140);
  assert.equal(typingPace(short, MID, seededRandom(1))?.pace, "person");
  const m = typingPace(mid, MID, seededRandom(2));
  assert.equal(m?.pace, "fast", `${mid.length} characters`);
  assert.ok(m!.plan.ms <= 10000 && planText(mid, MID, seededRandom(2)).ms > 10000);
  assert.equal(typingPace(long, MID, seededRandom(3)), null);
  // The input stage (board item ab-2qb: no fast end): the person's speed only, else none.
  assert.equal(typingPace(short, MID, seededRandom(1), 10000, {}, false)?.pace, "person");
  assert.equal(typingPace(mid, MID, seededRandom(2), 10000, {}, false), null, `${mid.length} characters: none at the person's speed`);
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

test("keys: the stream fits C11's key vectors (test/vectors/stage.json) of the per-key path: press-chord, with its answers; type ('Hi') and type-delay are collected parts (board ab-t30.19), typed by the plan of a text", () => {
  const V = JSON.parse(readFileSync(new URL("./vectors/stage.json", import.meta.url), "utf8"));
  for (const id of ["type", "type-delay"]) assert.deepEqual(V.vectors.find((v: any) => v.id === id).out.map((o: any) => typeof o.typing), ["string"], `${id}: one typed part`);
  for (const id of ["press-chord"]) {
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

test("keys: no event shows a modifier that is up: a key that rolls over into the stream's Shift or Control press loses the bit when that modifier goes up first (review-111 B1)", () => {
  const BITS: [string, number][] = [["Alt", 1], ["Control", CONTROL], ["Meta", 4], ["Shift", SHIFT]];
  const firstBad = (events: KeyEv[]): string | null => {
    const held = new Map<string, number>();
    for (const e of [...events].sort((a, b) => a.t - b.t)) {
      if (BITS.some(([k]) => k === e.key)) { held.set(e.key, (held.get(e.key) ?? 0) + (e.type === "keyUp" ? -1 : 1)); continue; }
      for (const [k, b] of BITS) if (e.modifiers & b && !(held.get(k) ?? 0)) return `${e.type} ${e.key} at ${e.t} shows ${k} up`;
    }
    return null;
  };
  // The keys as planText plays them: each press when the answer before it came, an early release answered at once.
  const play = (keys: Key[], s: KeyStream): KeyEv[] => {
    const out: KeyEv[] = [];
    let at = 0;
    for (const k of keys) {
      const p = s.next(k, at);
      out.push(...p);
      at = Math.max(...p.map((e) => e.t));
      const r = s.release(k, at);
      out.push(...r.events);
      if (!r.early) at = Math.max(...r.events.map((e) => e.t));
    }
    return [...out, ...s.end(at)];
  };
  // Short intervals make the rollover into the modifier's press likely (with the first values it is rare, not impossible).
  // A case that needs the rule: a key's release planned after the modifier's press and after the modifier's release.
  const after = (events: KeyEv[], mod: string) => {
    const up = events.find((e) => e.key === mod && e.type === "keyUp"), down = events.find((e) => e.key === mod && e.type === "rawKeyDown");
    return !!up && !!down && events.some((e) => e.key === "a" && e.type === "keyUp" && e.t > up.t);
  };
  let shiftCases = 0, controlCases = 0;
  for (let seed = 1; seed <= 4000; seed++) {
    for (const text of ["aJ", "camelCase YouTube"]) {
      const events = planText(text, MID, seededRandom(seed), { runSlowMs: Infinity, keyMs: [20, 40] }).events;
      assert.equal(firstBad(events), null, `"${text}", seed ${seed}`);
      if (text === "aJ" && after(events, "Shift")) shiftCases++;
    }
  }
  for (let seed = 1; seed <= 40000; seed++) {
    const events = play([charKey("a")!, parseKey("Control+Home")], new KeyStream(MID, seededRandom(seed), { runSlowMs: Infinity, keyMs: [20, 25] }));
    assert.equal(firstBad(events), null, `a, Control+Home, seed ${seed}`);
    if (after(events, "Control")) controlCases++;
  }
  assert.ok(shiftCases > 0 && controlCases > 0, `the cases that need the rule happen (${shiftCases} Shift, ${controlCases} Control)`);
});

// ---- Board ab-t30.10 (the input stage's keys, the first caller that reaches these cases of KeyStream) ----

/** Each event's modifiers match the modifier keys down at its time: none shows a modifier that is up, none hides one that is down. */
function modifiersMatch(events: readonly KeyEv[]): string | null {
  const BITS: [string, number][] = [["Alt", 1], ["Control", CONTROL], ["Meta", 4], ["Shift", SHIFT]];
  const held = new Map<string, number>();
  for (const e of [...events].sort((a, b) => a.t - b.t)) {
    const b = BITS.find(([k]) => k === e.key)?.[1];
    if (b !== undefined) { held.set(e.key, (held.get(e.key) ?? 0) + (e.type === "keyUp" ? -1 : e.repeat ? 0 : 1)); continue; }
    let down = 0;
    for (const [k, bit] of BITS) if ((held.get(k) ?? 0) > 0) down |= bit;
    if (e.modifiers !== down) return `${e.type} ${e.key} at ${e.t.toFixed(1)}: modifiers ${e.modifiers}, down ${down}`;
  }
  return null;
}

test("keys (review-111b): the release of a client's modifier waits for the latest planned release, also when a key rolls over into a chord, and a planned keyUp after it loses its bit", () => {
  const SHIFTK: Key = { key: "Shift", code: "ShiftLeft", keyCode: 16, modifiers: SHIFT };
  let cases = 0;
  for (let seed = 1; seed <= 3000; seed++) {
    // The client holds Shift; A (with an early release); Control+Home (the stream's own chord); then the client's Shift release.
    // A person with a wide spread of holds (the first values' spread makes the case rare: a long hold of A, a short one of Home).
    const WIDE = { ...MID, params: { ...MID.params, keys: { ...MID.params.keys, holdMs: { lognormal: [113.6, 0.6] as [number, number], min: 50, max: 250 } } } };
    const s = new KeyStream(WIDE, seededRandom(seed), { runSlowMs: Infinity, keyMs: [20, 30] });
    const A: Key = { key: "A", code: "KeyA", keyCode: 65, text: "A", modifiers: SHIFT }, home = parseKey("Control+Home");
    const ev: KeyEv[] = [...s.next(SHIFTK, 0)];
    const pa = s.next(A, 1); ev.push(...pa);
    const ra = s.release(A, pa.at(-1)!.t); ev.push(...ra.events);
    const at = ra.early ? pa.at(-1)!.t + 1 : ra.events.at(-1)!.t;
    const ph = s.next({ ...home, modifiers: home.modifiers | SHIFT }, at); ev.push(...ph);
    const rh = s.release(home, ph.at(-1)!.t); ev.push(...rh.events);
    const chordEnd = rh.events.at(-1)!.t, aUp = ra.events[0].t;
    const rs = s.release(SHIFTK, chordEnd); ev.push(...rs.events);
    if (aUp > chordEnd) cases++;
    assert.ok(rs.events[0].t > aUp, `seed ${seed}: the client's Shift goes up after A's keyUp (${rs.events[0].t.toFixed(1)} after ${aUp.toFixed(1)})`);
    assert.equal(modifiersMatch(ev), null, `seed ${seed}`);
  }
  assert.ok(cases > 0, `the case of review-111b happens (A's keyUp after the chord's last release): ${cases}`);
});

test("keys (review-111b): a client's modifier press adds its bit to a keyUp planned after it; a Shift of the stream's own that the client takes keeps its side, and its release drops the bit", () => {
  // a's release is answered early (planned in the future); the client presses Control before it: a's keyUp shows Control.
  let early = 0;
  for (let seed = 1; seed <= 400; seed++) {
    const s = new KeyStream(MID, seededRandom(seed), { holdMs: [200, 220], keyMs: [20, 25] });
    const pa = s.next(k("a"), 0), ra = s.release(k("a"), pa[0].t);
    if (!ra.early) continue;
    early++;
    const pc = s.next({ key: "Control", code: "ControlLeft", keyCode: 17, modifiers: CONTROL }, pa[0].t + 1);
    assert.ok(pc[0].t < ra.events[0].t, "the Control press comes before a's planned release");
    assert.equal(ra.events[0].modifiers, CONTROL, `seed ${seed}: a's keyUp has Control down at its time`);
    const rc = s.release({ key: "Control", code: "ControlLeft", keyCode: 17, modifiers: CONTROL }, pc[0].t + 1);
    assert.ok(rc.events[0].t > ra.events[0].t, "the client's Control release waits for a's planned release");
    assert.equal(modifiersMatch([...pa, ...ra.events, ...pc, ...rc.events]), null, `seed ${seed}`);
  }
  assert.ok(early > 50, `${early} early releases`);
  // The stream's own Shift (for B) that the client then presses: no second press; the client's release is that Shift's keyUp.
  for (let seed = 1; seed <= 200; seed++) {
    const s = new KeyStream(MID, seededRandom(seed));
    const pb = s.next(k("B"), 0), own = pb.find((e) => e.key === "Shift")!;
    const rb = s.release(k("B"), pb.at(-1)!.t);
    const ps = s.next({ key: "Shift", code: "ShiftLeft", keyCode: 16, modifiers: SHIFT }, rb.events.at(-1)!.t);
    assert.deepEqual(ps, [], "Shift is down already: no event");
    assert.equal(s.plannedShiftUp(), null, "the client holds it now: the stream plans no release of its own");
    const pc = s.next(k("C"), rb.events.at(-1)!.t + 1), rc = s.release(k("C"), pc.at(-1)!.t);
    assert.ok(!pc.some((e) => e.key === "Shift"), "C needs no Shift press: the client's Shift is down");
    const rs = s.release({ key: "Shift", code: "ShiftLeft", keyCode: 16, modifiers: SHIFT }, rc.events.at(-1)!.t);
    assert.deepEqual([rs.events[0].code, rs.events[0].location], [own.code, own.location], "the Shift that goes up is the one that is down");
    assert.equal(modifiersMatch([...pb, ...rb.events, ...pc, ...rc.events, ...rs.events]), null, `seed ${seed}`);
  }
});

test("keys (review-111 point 2): a press of a key that is down already is a keyboard's auto-repeat: no new hold, no lost release", () => {
  for (let seed = 1; seed <= 100; seed++) {
    const s = new KeyStream(MID, seededRandom(seed));
    const p1 = s.next(k("a"), 0), p2 = s.next(k("a"), p1[0].t + 500), p3 = s.next(k("a"), p1[0].t + 533);
    assert.deepEqual([p2.length, p2[0].repeat, p2[0].t, p3[0].repeat, p3[0].t], [1, true, p1[0].t + 500, true, p1[0].t + 533]);
    const r = s.release(k("a"), p1[0].t + 600);
    assert.deepEqual([r.events.length, r.events[0].type, r.events[0].t], [1, "keyUp", p1[0].t + 600], "one release, of the first press, at its arrival");
    const ctl = { key: "Control", code: "ControlLeft", keyCode: 17, modifiers: CONTROL };
    const c1 = s.next(ctl, 1000), c2 = s.next(ctl, 1400);
    assert.deepEqual([c2.length, c2[0].repeat, c2[0].type, c2[0].modifiers], [1, true, "rawKeyDown", CONTROL], "a held modifier repeats too");
    assert.equal(s.release(ctl, 1500).events.length, 1);
    void c1;
  }
});

test("keys (review-111 point 3): a client's chord of two modifiers: the second 20 to 80 ms after the first, and the key 40 to 120 ms after each", () => {
  const ctl: Key = { key: "Control", code: "ControlLeft", keyCode: 17, modifiers: CONTROL }, sh: Key = { key: "Shift", code: "ShiftLeft", keyCode: 16, modifiers: SHIFT };
  for (let seed = 1; seed <= 300; seed++) {
    const s = new KeyStream(MID, seededRandom(seed));
    const c = s.next(ctl, 0), h = s.next(sh, 1), left = s.next({ key: "ArrowLeft", code: "ArrowLeft", keyCode: 37, modifiers: CONTROL | SHIFT }, h[0].t + 1);
    const gap = h[0].t - c[0].t, k1 = left[0].t - c[0].t, k2 = left[0].t - h[0].t;
    assert.ok(gap >= 20 && gap <= 80, `the second modifier ${gap} ms after the first`);
    assert.ok(k1 >= 40 && k1 <= 120 + 1e-9 && k2 >= 40 - 1e-9 && k2 <= 120, `the key ${k1} and ${k2} ms after the modifiers`);
    assert.deepEqual([left.length, left[0].modifiers], [1, CONTROL | SHIFT], "no press of the stream's own: the client holds both");
    // A modifier pressed long before (a held Shift for a selection) does not hold the key back.
    const s2 = new KeyStream(MID, seededRandom(seed)), held = s2.next(sh, 0), r1 = s2.next({ key: "ArrowRight", code: "ArrowRight", keyCode: 39, modifiers: SHIFT }, 5000);
    assert.ok(r1[0].t >= 5000 && r1[0].t < 5000 + 1e-9, "the key at its arrival"); void held;
  }
});

test("keys (board ab-t30.10): the stream's own Shift goes up at its planned time with no next key (idle), with the time that plannedShiftUp named; after() starts the next key's interval at a text's end", () => {
  for (let seed = 1; seed <= 200; seed++) {
    const s = new KeyStream(MID, seededRandom(seed));
    const p = s.next(k("H"), 0), r = s.release(k("H"), p.at(-1)!.t);
    const at = s.plannedShiftUp()!;
    const up = r.events.at(-1)!.t;
    assert.ok(at - up >= 15 - 1e-9 && at - up <= 60 + 1e-9, `Shift up ${at - up} ms after H's release`);
    assert.equal(s.plannedShiftUp(), at, "the same time when asked again");
    const ev = s.idle(at);
    assert.deepEqual(ev.map((e) => [e.type, e.key, e.t, e.modifiers]), [["keyUp", "Shift", at, 0]]);
    assert.equal(s.plannedShiftUp(), null);
    // The next capital presses Shift again; an earlier next capital keeps it (the run of capitals).
    const s2 = new KeyStream(MID, seededRandom(seed)), q = s2.next(k("H"), 0), q2 = s2.release(k("H"), q.at(-1)!.t);
    const planned = s2.plannedShiftUp()!, i = s2.next(k("I"), q2.events.at(-1)!.t + 1);
    assert.ok(!i.some((e) => e.key === "Shift") && planned > q2.events.at(-1)!.t, "I comes before the planned Shift release: Shift stays down");
    const s3 = new KeyStream(MID, seededRandom(seed)), x = s3.next(k("a"), 0);
    s3.release(k("a"), x[0].t);
    s3.after(x[0].t + 2000);
    const y = s3.next(k("b"), x[0].t + 2000)[0];
    assert.ok(y.t >= x[0].t + 2000 && y.t < x[0].t + 2000 + 1600, "the next key's interval counts from the text's end");
  }
});

test("keys (review-119 N9): a client's chord of three modifiers: all of them within 80 ms of the first, so the key comes 40 to 120 ms after each", () => {
  const ctl: Key = { key: "Control", code: "ControlLeft", keyCode: 17, modifiers: CONTROL }, sh: Key = { key: "Shift", code: "ShiftLeft", keyCode: 16, modifiers: SHIFT }, alt: Key = { key: "Alt", code: "AltLeft", keyCode: 18, modifiers: 1 };
  for (let seed = 1; seed <= 400; seed++) {
    const s = new KeyStream(MID, seededRandom(seed));
    const c = s.next(ctl, 0), h = s.next(sh, 1), a = s.next(alt, h[0].t);
    const k = s.next({ key: "ArrowLeft", code: "ArrowLeft", keyCode: 37, modifiers: CONTROL | SHIFT | 1 }, a[0].t + 1)[0];
    assert.ok(a[0].t - c[0].t <= 80 + 1e-9, `seed ${seed}: the third modifier ${a[0].t - c[0].t} ms after the first`);
    for (const m of [c[0], h[0], a[0]]) assert.ok(k.t - m.t >= 40 - 1e-9 && k.t - m.t <= 120 + 1e-9, `seed ${seed}: the key ${k.t - m.t} ms after ${m.key}`);
  }
});
