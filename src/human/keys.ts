// The keys (board ab-t30.4; the input design, docs/superpowers/specs/2026-11-10-vanilla-playwright-human-input-design.md,
// sections 4.5, 7.2, 10.2 and 11.1; C11 "The input stage", the answers and the keys): a person's key plan as a stream.
// A caller (the input stage, or agent-browser's own Hands) gives each key's press with next(key, at) and its release with
// release(key, at), at the time at which the call came; the stream gives the timed events of each (the Shift and
// modifier presses and releases of its own, the press, the release) and, for a release, the early-answer decision.
// end(at) ends a run (the release of Shift). Pure: the person, the random source and the times are arguments.
//
// The rules (design 10.2; each value is in the parameter file, src/human/params/linux.json and mac.json, "keys"):
// - The hold: a lognormal per key, mean 116 ms, SD 24 ms, from 50 to 250 ms [19]. A release goes at the later of its
//   arrival and its press plus its hold, so a client's delay gives a hold of at least that delay.
// - The time from one press to the next: a base part (a lognormal times the person's key speed and the drift) plus a
//   part for the letter pair (none for the two hands, more for one hand, more for one finger, a part for one key twice).
//   A press goes at the later of its arrival and its planned time.
// - Pauses: after a space 20 to 120 ms more, after a mark (.,;:!?) 80 to 250 ms more, after Enter (a line's end) 200 to
//   600 ms more. They depend on the key before, so they are a part of the base part.
// - The speed in a session: a slow drift of the speed from word to word, a factor from 0.85 to 1.15.
// - Rollover and the early answer (design 4.5): at a key's release the stream draws the next interval's base part. When
//   the next press can come before this key's release (the base part is shorter than the hold), the caller may answer the
//   release before it sends it ("early"); the release then goes at its planned time, and the next press at its own time,
//   which can come before it. The letter-pair part is never below 0, so a release that is not early is never passed by the
//   next press. The share of rollover comes from the letter-pair part (its fit: the parameter file's sources).
// - Shift: a key that needs Shift gets a Shift rawKeyDown 45 to 95 ms before it (the interval goes to the Shift press), and
//   the Shift release goes 15 to 60 ms after the release of the last key that it holds; a run of shifted keys keeps it
//   down. The left Shift (location 1) for a key of the right hand, the right Shift (location 2) for one of the left hand,
//   in about 70% of cases. A key with no Shift waits for that release.
// - A chord (a key that needs Control, Alt or Meta, as Hands' Control+Home): each modifier 40 to 120 ms before the key,
//   the releases 20 to 80 ms apart in reverse order after the key's. A client's own modifier key (Playwright's
//   keyboard.down('Control')) goes as it comes, the key 40 to 120 ms after it, and its release 20 to 80 ms after the key's.
// - No corrections (K5: a later build). NumLock and CapsLock are off: the stream never sends a lock key.
// - The run's time: the person's speed for the first `runSlowMs` (C11's STAGE_RUN_SLOW_MS, 12 s) of a run, then the fast
//   end of the person's spread (100 to 120 ms a key, with no pair part and no pause).
//
// An event's `modifiers` is the modifiers down at its time. An event that the caller has not sent yet can gain a modifier
// when a later call plans a modifier press before it (a Shift press during the hold of the key before, in rollover): the
// caller sends the event objects that it got.

import type { Person } from "./person.ts";
import { chance, draw, normal, uniform, type Random } from "./random.ts";

export const ALT = 1, CONTROL = 2, META = 4, SHIFT = 8;

/**
 * A key as the caller names it: what it types (`text`), and the modifiers that it needs (Shift for a shifted character of
 * the US layout, Control for Control+Home). `type`: the press's type when the caller names it (agent-browser's `press`
 * sends a keyDown with no text); else a keyDown with text, a rawKeyDown with none.
 */
export type Key = { key: string; code: string; keyCode: number; text?: string; modifiers: number; type?: "keyDown" | "rawKeyDown" };

/** One timed event of the plan. `t`: ms on the caller's clock. `own`: a Shift or modifier key of the stream's own (no client call asked for it). */
export type KeyEv = {
  t: number; type: "keyDown" | "rawKeyDown" | "keyUp"; key: string; code: string; keyCode: number; text?: string;
  /** 1 left, 2 right (a Shift or modifier key); 0 for every other key. */
  location: number;
  /** The modifiers down at the event (CDP's `modifiers`: 1 Alt, 2 Control, 4 Meta, 8 Shift). */
  modifiers: number;
  own: boolean;
};

export type Pace = "person" | "fast";
export type StreamOptions = {
  /** A caller's range for each hold in place of the file's bounds (agent-browser's inputTiming.holdMs). */
  holdMs?: readonly [number, number];
  /** A caller's range for each time from one press to the next: the interval is kept inside it (agent-browser's inputTiming.keyMs). */
  keyMs?: readonly [number, number];
  /** The pace at the run's start: the person's (default) or the fast end. */
  pace?: Pace;
  /** The person's speed for this long from the run's first press (ms), then the fast end; default the file's runSlowMs (12 s). */
  runSlowMs?: number;
};

// ---------------------------------------------------------------- the US layout (moved here from src/record.ts)

// The code, the key code and whether Shift is down for each printable character.
const PUNCTUATION: Record<string, [string, number, boolean]> = {
  " ": ["Space", 32, false], "-": ["Minus", 189, false], _: ["Minus", 189, true], "=": ["Equal", 187, false], "+": ["Equal", 187, true],
  "[": ["BracketLeft", 219, false], "{": ["BracketLeft", 219, true], "]": ["BracketRight", 221, false], "}": ["BracketRight", 221, true],
  "\\": ["Backslash", 220, false], "|": ["Backslash", 220, true], ";": ["Semicolon", 186, false], ":": ["Semicolon", 186, true],
  "'": ["Quote", 222, false], '"': ["Quote", 222, true], ",": ["Comma", 188, false], "<": ["Comma", 188, true],
  ".": ["Period", 190, false], ">": ["Period", 190, true], "/": ["Slash", 191, false], "?": ["Slash", 191, true],
  "`": ["Backquote", 192, false], "~": ["Backquote", 192, true],
};
const SHIFTED_DIGITS = ")!@#$%^&*(";

/** The US-layout key that types `ch`, or undefined (the character is then inserted as text). */
export function charKey(ch: string): Key | undefined {
  if (/^[a-z]$/.test(ch)) return { key: ch, code: `Key${ch.toUpperCase()}`, keyCode: ch.toUpperCase().charCodeAt(0), text: ch, modifiers: 0 };
  if (/^[A-Z]$/.test(ch)) return { key: ch, code: `Key${ch}`, keyCode: ch.charCodeAt(0), text: ch, modifiers: SHIFT };
  if (/^[0-9]$/.test(ch)) return { key: ch, code: `Digit${ch}`, keyCode: ch.charCodeAt(0), text: ch, modifiers: 0 };
  const d = SHIFTED_DIGITS.indexOf(ch);
  if (d >= 0) return { key: ch, code: `Digit${d}`, keyCode: 48 + d, text: ch, modifiers: SHIFT };
  const p = PUNCTUATION[ch];
  return p ? { key: ch, code: p[0], keyCode: p[1], text: ch, modifiers: p[2] ? SHIFT : 0 } : undefined;
}
const ENTER: Key = { key: "Enter", code: "Enter", keyCode: 13, text: "\r", modifiers: 0 };
const TAB: Key = { key: "Tab", code: "Tab", keyCode: 9, modifiers: 0 };

/** The hand and the finger of each key's code on the US layout (touch typing; 1 index to 4 little finger). */
const FINGERS: Record<string, [Hand, number]> = {};
type Hand = "left" | "right" | "thumb";
for (const [hand, finger, codes] of [
  ["left", 4, "Backquote Digit1 KeyQ KeyA KeyZ Tab"], ["left", 3, "Digit2 KeyW KeyS KeyX"], ["left", 2, "Digit3 KeyE KeyD KeyC"],
  ["left", 1, "Digit4 Digit5 KeyR KeyT KeyF KeyG KeyV KeyB"], ["right", 1, "Digit6 Digit7 KeyY KeyU KeyH KeyJ KeyN KeyM"],
  ["right", 2, "Digit8 KeyI KeyK Comma"], ["right", 3, "Digit9 KeyO KeyL Period"],
  ["right", 4, "Digit0 Minus Equal KeyP BracketLeft BracketRight Backslash Semicolon Quote Slash Enter Backspace"], ["thumb", 0, "Space"],
] as const) for (const c of codes.split(" ")) FINGERS[c] = [hand, finger];

/** The hand of a key's code: left, right, the thumb (the space bar), or undefined (a key off the main block). */
export function handOf(code: string): Hand | undefined { return FINGERS[code]?.[0]; }

export type PairClass = "twoHands" | "sameHand" | "sameFinger" | "sameKey";
/** The letter pair's class: the two hands (or the thumb's space), one hand, one finger, or one key twice. A key off the main block counts as one hand. */
export function pairClass(a: Key, b: Key): PairClass {
  if (a.code === b.code) return "sameKey";
  const fa = FINGERS[a.code], fb = FINGERS[b.code];
  if (fa?.[0] === "thumb" || fb?.[0] === "thumb" || (fa && fb && fa[0] !== fb[0])) return "twoHands";
  return fa && fb && fa[1] === fb[1] ? "sameFinger" : "sameHand";
}

// ---------------------------------------------------------------- the draws (design 10.2)

/** A key's hold (ms): a lognormal, mean 116 ms, SD 24 ms, from 50 to 250 ms; `bounds` a caller's range in place of the file's. */
export const keyHoldMs = (person: Person, random: Random, bounds?: readonly [number, number]) => draw(random, person.params.keys.holdMs, bounds);
/** The base part of the time from one press to the next (ms): a lognormal times the person's key speed (the stream multiplies it by the drift). */
export const baseMs = (person: Person, random: Random) => draw(random, person.params.keys.baseMs) * person.keySpeed;
/** The letter pair's part of the time from one press to the next (ms), times the person's key speed: never below 0. */
export const pairMs = (prev: Key, next: Key, person: Person) => person.params.keys.pairMs[pairClass(prev, next)] * person.keySpeed;

const MARKS = new Set([".", ",", ";", ":", "!", "?"]);
/** The pause after a key (ms): after a space 20 to 120 ms, after a mark 80 to 250 ms, after Enter (a line's end) 200 to 600 ms; else 0. */
export function pauseAfter(prev: Key, person: Person, random: Random): number {
  const p = person.params.keys.pauseMs;
  if (prev.key === "Enter") return draw(random, p.line);
  if (prev.text === " ") return draw(random, p.space);
  return prev.text !== undefined && MARKS.has(prev.text) ? draw(random, p.mark) : 0;
}

/** The drift's next word: a slow random walk of the log of the factor (it keeps `keep` of its last value), inside its range. */
export function nextDrift(d: number, person: Person, random: Random): number {
  const k = person.params.keys.drift;
  return Math.min(k.max, Math.max(k.min, Math.exp(k.keep * Math.log(d) + normal(random, 0, k.sd))));
}
/** A run's first factor: the walk's own spread (the stationary one). */
function firstDrift(person: Person, random: Random): number {
  const k = person.params.keys.drift;
  return Math.min(k.max, Math.max(k.min, Math.exp(normal(random, 0, k.sd / Math.sqrt(1 - k.keep * k.keep)))));
}

// ---------------------------------------------------------------- the modifier keys

const MODIFIER_OF: Record<string, number> = { Alt: ALT, Control: CONTROL, Meta: META, Shift: SHIFT };
/** The stream's own modifier keys (the left one; Shift's side is drawn). */
const OWN_KEYS: Record<number, { key: string; code: string; keyCode: number }> = {
  [CONTROL]: { key: "Control", code: "ControlLeft", keyCode: 17 }, [ALT]: { key: "Alt", code: "AltLeft", keyCode: 18 }, [META]: { key: "Meta", code: "MetaLeft", keyCode: 91 },
};
const CHORD_BITS = [CONTROL, ALT, META];
const locationOf = (code: string) => (/Left$/.test(code) ? 1 : /Right$/.test(code) ? 2 : 0);

type Down = { key: Key; press: number; hold: number; release?: KeyEv; shift: boolean; chord: number[] };
type Mod = { bit: number; key: string; code: string; keyCode: number; location: number; press: number; client: boolean };

// ---------------------------------------------------------------- the stream

export class KeyStream {
  readonly person: Person;
  private readonly random: Random;
  private readonly o: StreamOptions;
  pace: Pace;
  private drift_: number;
  private runStart: number | undefined;
  /** The last press of a key with a character or a name (not a modifier key): the start of the next interval. */
  private last: { t: number; key: Key | undefined } | undefined;
  /** The base part of the next interval, drawn at the last release (the early-answer decision). */
  private base: number | undefined;
  private readonly down = new Map<string, Down>();
  private readonly mods = new Map<number, Mod>();
  /** The latest planned release of a key that Shift holds (the Shift release goes after it). */
  private shiftHeldUntil = -Infinity;
  /** The release of a modifier of the stream's own that the next key must wait for (a chord's, Shift's). */
  private notBefore = -Infinity;
  private lastRelease = -Infinity;
  /** The planned releases of the keys (not sent yet, as far as the stream knows): a later modifier press can come before them. */
  private releases: KeyEv[] = [];

  constructor(person: Person, random: Random, o: StreamOptions = {}) {
    this.person = person;
    this.random = random;
    this.o = o;
    this.pace = o.pace ?? "person";
    this.drift_ = firstDrift(person, random);
  }

  /** The drift's factor of the word now. */
  get drift(): number { return this.drift_; }
  private get K() { return this.person.params.keys; }

  /** The modifiers down at time t (the stream's own and the client's). */
  private modsAt(t: number): number {
    let m = 0;
    for (const x of this.mods.values()) if (x.press <= t) m |= x.bit;
    return m;
  }
  private ev(t: number, type: KeyEv["type"], k: { key: string; code: string; keyCode: number; text?: string }, modifiers: number, own: boolean, location = 0): KeyEv {
    return { t, type, key: k.key, code: k.code, keyCode: k.keyCode, ...(k.text !== undefined && type !== "keyUp" ? { text: k.text } : {}), location, modifiers, own };
  }
  private clampInterval(ms: number): number {
    const b = this.o.keyMs;
    return b ? Math.min(b[1], Math.max(b[0], ms)) : ms;
  }

  /** The base part of the interval after `prev` (drawn at its release): the person's base with the drift and the pause, or the fast end. */
  private drawBase(prev: Key | undefined, from: number): number {
    if (this.pace === "person" && this.runStart !== undefined && from - this.runStart >= (this.o.runSlowMs ?? this.K.runSlowMs)) this.pace = "fast";
    if (this.pace === "fast") return this.clampInterval(draw(this.random, this.K.fastMs));
    // A new word: the drift's next value (after a space, Enter or Tab).
    if (prev && (prev.text === " " || prev.key === "Enter" || prev.key === "Tab")) this.drift_ = nextDrift(this.drift_, this.person, this.random);
    return this.clampInterval(baseMs(this.person, this.random) * this.drift_ + (prev ? pauseAfter(prev, this.person, this.random) : 0));
  }

  /** The release of Shift, when the stream holds it: 15 to 60 ms after the last key that it holds. */
  private releaseShift(at: number): KeyEv[] {
    const m = this.mods.get(SHIFT);
    if (!m || m.client) return [];
    let until = this.shiftHeldUntil;
    for (const d of this.down.values()) if (d.shift) until = Math.max(until, d.release?.t ?? d.press + d.hold);
    const t = Math.max(at, until + draw(this.random, this.K.shift.afterMs));
    this.mods.delete(SHIFT);
    this.shiftHeldUntil = -Infinity;
    this.notBefore = Math.max(this.notBefore, t + draw(this.random, this.K.afterReleaseMs));
    return [this.ev(t, "keyUp", m, this.modsAt(t) & ~SHIFT, true, m.location)];
  }

  /** The events of a key's press, at or after `at`. */
  next(k: Key, at: number): KeyEv[] {
    const bit = MODIFIER_OF[k.key];
    if (bit) {
      // A client's own modifier key: it goes as it comes (a Shift of the stream's own becomes the client's).
      const own = this.mods.get(bit);
      if (own && !own.client) { own.client = true; return []; }
      const t = Math.max(at, this.notBefore);
      this.mods.set(bit, { bit, key: k.key, code: k.code, keyCode: k.keyCode, location: locationOf(k.code), press: t, client: true });
      return [this.ev(t, "rawKeyDown", k, this.modsAt(t) | bit, false, locationOf(k.code))];
    }
    const out: KeyEv[] = [];
    // A key that does not need the stream's Shift waits for its release.
    if (!(k.modifiers & SHIFT)) out.push(...this.releaseShift(at));
    let t = at;
    if (this.last) {
      const base = this.base ?? this.drawBase(this.last.key, this.last.t);
      const pair = this.pace === "person" && this.last.key ? pairMs(this.last.key, k, this.person) * this.drift_ : 0;
      t = Math.max(at, this.last.t + Math.max(base, this.clampInterval(base + pair)));
    }
    t = Math.max(t, this.notBefore);
    // The same key again: after its own release (a key cannot go down twice).
    const same = this.down.get(k.code), sameUp = this.releases.filter((e) => e.code === k.code).at(-1);
    if (same || (sameUp && sameUp.t + 1 > t)) t = Math.max(t, (same ? same.press + same.hold : sameUp!.t) + draw(this.random, this.K.afterReleaseMs));
    // The modifiers that the key needs and that nobody holds: Shift by its rule, Control, Alt and Meta as a chord.
    const chord: number[] = [];
    for (const b of [...CHORD_BITS, SHIFT]) {
      if (!(k.modifiers & b) || this.mods.has(b)) continue;
      let mk: { key: string; code: string; keyCode: number }, loc: number, before: number;
      if (b === SHIFT) {
        const hand = handOf(k.code), other = hand === "left" ? 2 : 1;
        loc = chance(this.random, this.K.shift.otherHandShare) ? other : 3 - other;
        mk = { key: "Shift", code: loc === 1 ? "ShiftLeft" : "ShiftRight", keyCode: 16 };
        before = draw(this.random, this.K.shift.beforeMs);
      } else {
        mk = OWN_KEYS[b];
        loc = 1;
        before = draw(this.random, this.K.chord.beforeMs);
        chord.push(b);
      }
      this.mods.set(b, { bit: b, ...mk, location: loc, press: t, client: false });
      out.push(this.ev(t, "rawKeyDown", mk, this.modsAt(t) | b, true, loc));
      // A key whose release is planned after this press gains the modifier at its release (rollover into a Shift press).
      for (const e of this.releases) if (e.t > t) e.modifiers |= b;
      t += before;
    }
    // A key after a client's own modifier: 40 to 120 ms after it (a chord of the client's).
    for (const m of this.mods.values()) if (m.client && k.modifiers & m.bit) t = Math.max(t, m.press + draw(this.random, this.K.chord.beforeMs));
    const hold = keyHoldMs(this.person, this.random, this.o.holdMs);
    const type = k.type ?? (k.text ? "keyDown" : "rawKeyDown");
    out.push(this.ev(t, type, k, this.modsAt(t), false));
    this.down.set(k.code, { key: k, press: t, hold, shift: !!(k.modifiers & SHIFT) && !!this.mods.get(SHIFT) && !this.mods.get(SHIFT)!.client, chord });
    this.runStart ??= t;
    this.last = { t, key: k };
    this.base = undefined;
    return out;
  }

  /** A key's release at or after `at`, and whether the caller may answer it before it goes (the next key can overlap). */
  release(k: Key, at: number): { events: KeyEv[]; early: boolean } {
    const bit = MODIFIER_OF[k.key];
    if (bit) {
      const m = this.mods.get(bit);
      if (!m) return { events: [this.ev(at, "keyUp", k, this.modsAt(at), false, locationOf(k.code))], early: false };
      // A client's modifier: 20 to 80 ms after the release of the key that it held, in reverse order.
      const t = Math.max(at, this.lastRelease + draw(this.random, this.K.chord.releaseGapMs));
      this.mods.delete(bit);
      this.lastRelease = t;
      return { events: [this.ev(t, "keyUp", k, this.modsAt(t) & ~bit, false, m.location)], early: false };
    }
    const d = this.down.get(k.code);
    if (!d) return { events: [this.ev(at, "keyUp", k, this.modsAt(at), false)], early: false };
    const t = Math.max(at, d.press + d.hold), events: KeyEv[] = [this.ev(t, "keyUp", d.key, this.modsAt(t), false)];
    d.release = events[0];
    this.down.delete(k.code);
    this.releases = [...this.releases.filter((e) => e.t > d.press - 5000), events[0]];
    this.lastRelease = Math.max(this.lastRelease, t);
    if (d.shift) this.shiftHeldUntil = Math.max(this.shiftHeldUntil, t);
    // A chord's own modifiers go up after the key, 20 to 80 ms apart, in reverse order.
    if (d.chord.length) {
      let u = t;
      for (const b of [...d.chord].reverse()) {
        const m = this.mods.get(b)!;
        u += draw(this.random, this.K.chord.releaseGapMs);
        this.mods.delete(b);
        events.push(this.ev(u, "keyUp", m, this.modsAt(u) & ~b, true, m.location));
      }
      this.lastRelease = u;
      this.notBefore = Math.max(this.notBefore, u + draw(this.random, this.K.afterReleaseMs));
      return { events, early: false };
    }
    // The early answer: the base part of the next interval, drawn now, is shorter than the hold (the next press can come
    // first). Not for a release that goes at once, and not under a client's chord (its next call is a modifier's release).
    const chordHeld = [...this.mods.values()].some((m) => m.client && m.bit !== SHIFT);
    if (this.last && this.last.key === d.key && !chordHeld) {
      this.base = this.drawBase(d.key, d.press);
      return { events, early: t > at && d.press + this.base < t };
    }
    return { events, early: false };
  }

  /** The end of a run: the release of the stream's own Shift (15 to 60 ms after the last key that it holds). The next key starts a new run. */
  end(at: number): KeyEv[] {
    const out = this.releaseShift(at);
    this.last = undefined;
    this.base = undefined;
    this.runStart = undefined;
    this.pace = this.o.pace ?? "person";
    return out;
  }

  /**
   * An inserted text in a run (a character with no US key; a text that the typing rule refuses): the release of the
   * stream's own Shift first, and its time: after every planned release, one interval after the last press. The next key's
   * interval starts at it, with no letter-pair part.
   */
  insert(at: number): { events: KeyEv[]; t: number } {
    const events = this.releaseShift(at);
    let t = Math.max(at, this.notBefore, this.lastRelease);
    for (const d of this.down.values()) t = Math.max(t, d.release?.t ?? d.press + d.hold);
    if (this.last) t = Math.max(t, this.last.t + (this.base ?? this.drawBase(this.last.key, this.last.t)));
    this.last = { t, key: undefined };
    this.base = undefined;
    this.runStart ??= t;
    return { events, t };
  }
}

// ---------------------------------------------------------------- a whole text

/**
 * The plan of a text as Playwright's calls would give it (each call when the answer of the one before came: a press's after
 * its events, a release's at once when it is early, else after its events), from 0 ms: its events, its time from the first
 * event to the last, and the times of its inserted texts (characters with no US key). A line feed is Enter, a tab Tab.
 */
export function planText(text: string, person: Person, random: Random, o: StreamOptions = {}): { events: KeyEv[]; ms: number; inserts: number[] } {
  const s = new KeyStream(person, random, o), events: KeyEv[] = [], inserts: number[] = [];
  let at = 0;
  for (const ch of text) {
    const k = ch === "\n" ? ENTER : ch === "\t" ? TAB : charKey(ch);
    if (!k) {
      const r = s.insert(at);
      events.push(...r.events);
      inserts.push(r.t);
      at = r.t;
      continue;
    }
    const p = s.next(k, at);
    events.push(...p);
    at = Math.max(...p.map((e) => e.t));
    const r = s.release(k, at);
    events.push(...r.events);
    if (!r.early) at = Math.max(...r.events.map((e) => e.t));
  }
  events.push(...s.end(at));
  events.sort((a, b) => a.t - b.t);
  const times = [...events.map((e) => e.t), ...inserts];
  return { events, ms: times.length ? Math.max(...times) - Math.min(...times) : 0, inserts };
}

/**
 * The typing rule's pace (design 7.2, rule 3; C11's typing rule): the plan at the person's speed when it fits in `maxMs`
 * (STAGE_TYPE_MAX_MS, 10 s), else the plan at the fast end when that fits, else null (the text goes as one inserted text:
 * the answer Q2 a).
 */
export function typingPace(text: string, person: Person, random: Random, maxMs = person.params.keys.typeMaxMs, o: StreamOptions = {}): { pace: Pace; plan: ReturnType<typeof planText> } | null {
  for (const pace of ["person", "fast"] as const) {
    const plan = planText(text, person, random, { ...o, pace });
    if (plan.ms <= maxMs) return { pace, plan };
  }
  return null;
}
