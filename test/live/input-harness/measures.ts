// The input harness's measures of one step (board ab-t30.2; design 2026-11-10-vanilla-playwright-human-input-design.md,
// section 13.3): from the records that the recorder page (docs/research/2026-11-09-click-box-input-signals/recorder.html)
// logs to numbers. Pure; unit-tested in test/input-harness.test.ts. The record fields are the recorder's (its head
// comment): e the event, f the frame (top, box), t the event's time and h the handler's time (epoch ms), tr isTrusted,
// tg the target, x y the client point, sx sy the screen point, mx my the movement, bs the buttons, nc np the counts of
// coalesced and predicted points, co the coalesced points as [ms after t, x, y], k c the key and its code, r repeat,
// nl NumLock, m the modifiers, dx dy wdx wdy dm the wheel's deltas and mode, it dt the input's type and data.

import { fittsMs, median, mean, pathShape, wholeMsShare, isWholeMs, type PathShape, type Sample } from "./stats.ts";

export type Rec = Record<string, any> & { e: string; f?: string; t: number };
/** What a step does: the harness's scenarios tag each step, and the score reads the steps of each kind. */
export type StepKind = "idle" | "click" | "hover" | "move" | "box" | "dblclick" | "modclick" | "type" | "fill" | "wheel" | "far" | "drag";
/** `path`: the id of a planned path that two sources play (XTEST's M1 paths and the CDP form on them), for P1's same-path row. */
export type StepMark = { name: string; source: string; kind: StepKind; ok: boolean; t0: number; t1: number; width?: number; error?: string; path?: string };
/** A step's records: from 50 ms before its start to 650 ms after its end (the research's analyze.ts; a step's settle is 700 ms). */
export const WINDOW_BEFORE_MS = 50, WINDOW_AFTER_MS = 650;
/** The click-box stand-in's size (CSS px). */
export const BOX_SIZE = { w: 300, h: 65 };
/** The recorder's text fields. */
export const TEXT_FIELDS: readonly string[] = ["#f", "#ta"];
/** A text above this many characters may go with no key events (design section 7.2: a typing plan fits in 10 s, about 40 to 80 characters). */
export const TEXT_LIMIT = 40;
export const MODIFIER_KEYS: ReadonlySet<string> = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock"]);
const CLICK_MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta"]);
const SHIFTED = /^[A-Z~!@#$%^&*()_+{}|:"<>?]$/;
/** The characters of the left hand's keys on the US layout (touch typing); every other printable character but the space is the right hand's. */
const LEFT_HAND = new Set("`12345qwertasdfgzxcvb~!@#$%QWERTASDFGZXCVB");
const WORD_END = new Set([" ", ".", ",", ";", ":", "!", "?", "Enter"]);
/** A press or a Tab key this long before a focusin explains it. */
const FOCUS_CAUSE_MS = 1500;
/** A wheel or a key this long before a scroll explains it. */
const SCROLL_CAUSE_MS = 700;
/** R11: the window's focus records of one activation come within this many ms; a box's blur this close to the top's focus means the focus moved inside the page; the first pointer event after an activation comes within this many ms. */
const ACTIVATION_SAME_MS = 50, ACTIVATION_PAIRED_MS = 20, ACTIVATION_AFTER_MS = 2000;
/** The recorder's target name for a window (its tid() of a window: no id and no node name). */
const WINDOW = "[object Window]";

export type PathMeasures = PathShape & { fittsRatio: number | null };
/** `samplesEach`, `predictedEach`, `gapsMs`: P1's distributions (board ab-t30.3): each pointermove's nc and np, and each sample gap (ms). */
export type PointerMeasures = {
  moves: number; samplesPerMove: number | null; predictedPerMove: number | null; sampleGaps: number; wholeMsGaps: number; wholeMsShare: number | null;
  samplesEach: number[]; predictedEach: number[]; gapsMs: number[];
  eventsAfterHandler: number; handlerLagMs: number | null; fractional: number; jumps: number; movementMismatch: number;
  path: PathMeasures | null; pauseMs: number | null; pressMs: number | null; focusInPress: boolean | null;
  doubleClickGapMs: number | null; modifierLeadMs: number | null; modifierLagMs: number | null; heldMoves: number | null;
};
/**
 * `pairs`: the press-to-press times of each letter pair (two keys with a character each, in lower case; K2 per letter pair).
 * `holdsByKey`: the holds of each key with a character, by the character in lower case (K1 per key; board ab-t30.4).
 * K4's Shift (board ab-t30.4): `shiftDowns` and `shiftLocations` (each Shift keydown's location: 1 left, 2 right, 0 none);
 * `shiftUpAfter`: the shifted characters with a Shift down whose Shift goes up after their own keyup; `shiftSided`: the
 * Shift keydowns with a location whose first character is a shifted one, and `shiftOtherHand`: those on the side of the
 * other hand (a left Shift for a key of the right hand, a right Shift for one of the left hand).
 */
export type KeyMeasures = { keys: number; holds: number[]; downToDown: number[]; wordEndExtraMs: number | null; overlaps: number; overlapShare: number | null;
  shiftedChars: number; shiftedWithShiftDown: number; numLockOn: number; backspaces: number; pairs: Record<string, number[]>;
  holdsByKey: Record<string, number[]>; shiftDowns: number; shiftLocations: number[]; shiftUpAfter: number; shiftSided: number; shiftOtherHand: number };
export type TextMeasures = { inputs: number; chars: number; keyChars: number; keyEventsPerChar: number | null; textsWithNoKeys: number; longTextsWithNoKeys: number };
/** `deltaModes`: null for an event with no deltaMode (never read as mode 0). */
export type WheelMeasures = { events: number; absDeltaY: number[]; ratios: number[]; deltaModes: (number | null)[]; gapsMs: number[]; scrolls: number; scrollsWithNoWheelOrKey: number };
/** `straightness`: the box frame's samples from the entry to the press, chord / length (P4; board ab-t30.3); null with fewer than 3. */
export type BoxMeasures = { entryEdgePx: number; movesInside: number; entryToPressMs: number | null; straightness: number | null };
export type StepMeasures = {
  name: string; source: string; kind: StepKind; ok: boolean; ms: number;
  pointer: PointerMeasures | null; box: BoxMeasures | null; keys: KeyMeasures | null; text: TextMeasures | null; wheel: WheelMeasures | null;
  focusinWithNoPress: number; untrusted: number; touch: number; idleMovesPerS: number | null;
  /** P6 (board ab-t30.3): the time from the top page's load to its first trusted pointer move, on the step that holds that move; else null. */
  loadToFirstMoveMs: number | null;
  /** The step's event records (the recorder gives each event `tr`; its own records, such as layout, state, frames and seq, have none). */
  events: number;
  /** R11: the jump (px) at each activation of the page's window in the step. */
  activationJumps: number[];
  path?: string;
};

const byTime = (a: Rec, b: Rec) => a.t - b.t;
const frame = (r: Rec) => r.f ?? "top";
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const fractional = (v: unknown) => num(v) && Math.abs(v - Math.round(v)) > 1e-9;

/** The records of a step, in time order. */
export function stepRecords(all: readonly Rec[], m: Pick<StepMark, "t0" | "t1">): Rec[] {
  return all.filter((r) => num(r.t) && r.t >= m.t0 - WINDOW_BEFORE_MS && r.t <= m.t1 + WINDOW_AFTER_MS).sort(byTime);
}

/** The raw samples of the pointermoves: each one's coalesced points on the page's clock (its own point when it has none). */
export function samplesOf(moves: readonly Rec[]): (Sample & { f: string })[] {
  const out: (Sample & { f: string })[] = [];
  for (const r of moves) for (const c of (r.co ?? [[0, r.x, r.y]]) as number[][]) out.push({ t: r.t + c[0], x: c[1], y: c[2], f: frame(r) });
  return out.sort((a, b) => a.t - b.t);
}

/** The pointer's measures (P1, P2, P3, P5, P8, R1, R2, R8, R9, R13, and M1's moves that the movement does not explain), or null with no pointermove and no press. `width`: the target's smaller side (Fitts). */
export function pointerMeasures(recs: readonly Rec[], width?: number): PointerMeasures | null {
  const list = [...recs].sort(byTime);
  const moves = list.filter((r) => r.e === "pointermove"), downs = list.filter((r) => r.e === "pointerdown"), ups = list.filter((r) => r.e === "pointerup");
  if (!moves.length && !downs.length) return null;
  const nc = moves.map((r) => r.nc).filter((v): v is number => num(v) && v >= 0), np = moves.map((r) => r.np).filter((v): v is number => num(v) && v >= 0);
  const samples = samplesOf(moves), gaps: number[] = [];
  for (let i = 1; i < samples.length; i++) if (samples[i].f === samples[i - 1].f) gaps.push(samples[i].t - samples[i - 1].t);
  let jumps = 0, mismatch = 0;
  for (let i = 0; i < moves.length; i++) {
    const r = moves[i];
    if (Math.abs(r.mx ?? 0) > 100 || Math.abs(r.my ?? 0) > 100) jumps++;
    // The move before, in the same frame: a frame that the pointer left and enters again starts with movement 0.
    const prev = i > 0 && frame(moves[i - 1]) === frame(r) ? moves[i - 1] : undefined;
    if (prev && num(r.sx) && num(prev.sx) && (Math.round(r.sx - prev.sx) !== r.mx || Math.round(r.sy - prev.sy) !== r.my)) mismatch++;
  }
  const pointerEvents = list.filter((r) => /^(pointer|mouse)/.test(r.e) && (num(r.x) || num(r.y)));
  const d0 = downs[0], f0 = d0 ? frame(d0) : undefined;
  const pts = samples.filter((s) => !d0 || (s.t <= d0.t && s.f === f0));
  const shape = pathShape(pts);
  const path: PathMeasures | null = shape ? { ...shape, fittsRatio: width ? shape.ms / fittsMs(shape.chordPx, width) : null } : null;
  let pauseMs: number | null = null, pressMs: number | null = null, focusInPress: boolean | null = null, gapMs: number | null = null;
  let leadMs: number | null = null, lagMs: number | null = null, held: number | null = null;
  if (d0) {
    const last = moves.filter((r) => frame(r) === f0 && r.t <= d0.t).at(-1);
    pauseMs = last ? d0.t - last.t : null;
    const up = ups.find((r) => r.t >= d0.t && frame(r) === f0);
    pressMs = up ? up.t - d0.t : null;
    if (up) {
      const focus = list.find((r) => r.e === "focus" && frame(r) === f0 && /^#/.test(String(r.tg ?? "")) && r.t >= d0.t - 1 && r.t <= up.t + 300);
      focusInPress = focus ? focus.t <= up.t : null;
    }
    const d1 = downs.filter((r) => frame(r) === f0)[1];
    const firstUp = d1 ? ups.filter((r) => frame(r) === f0 && r.t >= d0.t && r.t <= d1.t).at(-1) : undefined;
    gapMs = d1 && firstUp ? d1.t - firstUp.t : null;
    const mod = list.filter((r) => r.e === "keydown" && CLICK_MODIFIERS.has(r.k) && r.t <= d0.t).at(-1);
    if (mod && !list.some((r) => r.e === "keyup" && r.k === mod.k && r.t > mod.t && r.t < d0.t)) {
      leadMs = d0.t - mod.t;
      const lastUp = ups.at(-1), modUp = list.find((r) => r.e === "keyup" && r.k === mod.k && r.t > mod.t);
      lagMs = lastUp && modUp ? modUp.t - lastUp.t : null;
    }
    // R8: the moves and the drag events (drag, dragover: Chromium sends no pointer event after dragstart) with the button
    // down, between the press and the drop. A real drag's drag events have buttons 1; a protocol drag's have buttons 0.
    const end = list.find((r) => r.t >= d0.t && r !== d0 && (r.e === "drop" || r.e === "dragend" || r.e === "pointerup"));
    held = list.filter((r) => r.t > d0.t && (!end || r.t < end.t) && (r.e === "pointermove" || r.e === "drag" || r.e === "dragover") && ((r.bs ?? 0) & 1) === 1).length;
  }
  return {
    moves: moves.length, samplesPerMove: mean(nc), predictedPerMove: mean(np), sampleGaps: gaps.length, wholeMsGaps: gaps.filter((g) => isWholeMs(g)).length,
    samplesEach: nc, predictedEach: np, gapsMs: gaps.map((g) => Math.round(g * 1000) / 1000),
    wholeMsShare: wholeMsShare(gaps), eventsAfterHandler: list.filter((r) => num(r.h) && r.t > r.h + 0.05).length,
    handlerLagMs: median(moves.filter((r) => num(r.h)).map((r) => r.h - r.t)),
    fractional: pointerEvents.filter((r) => fractional(r.x) || fractional(r.y)).length + samples.filter((s) => fractional(s.x) || fractional(s.y)).length,
    jumps, movementMismatch: mismatch, path, pauseMs, pressMs, focusInPress, doubleClickGapMs: gapMs, modifierLeadMs: leadMs, modifierLagMs: lagMs, heldMoves: held,
  };
}

/** The keys' measures (K1 to K6), or null with no keydown. */
export function keyMeasures(recs: readonly Rec[]): KeyMeasures | null {
  const kd = recs.filter((r) => r.e === "keydown" && !r.r).sort(byTime), ku = recs.filter((r) => r.e === "keyup").sort(byTime);
  if (!kd.length) return null;
  const isChar = (r: Rec) => !MODIFIER_KEYS.has(r.k);
  const holds: number[] = [], down = new Map<string, Rec>(), holdsByKey: Record<string, number[]> = {};
  let overlaps = 0;
  for (const r of [...kd, ...ku].sort(byTime)) {
    if (r.e === "keydown") {
      if (isChar(r) && [...down.values()].some(isChar)) overlaps++;
      down.set(r.c, r);
    } else {
      const d = down.get(r.c);
      if (d) {
        if (isChar(d)) {
          holds.push(r.t - d.t);
          if (typeof d.k === "string" && d.k.length === 1) (holdsByKey[d.k.toLowerCase()] ??= []).push(r.t - d.t);
        }
        down.delete(r.c);
      }
    }
  }
  const chars = kd.filter(isChar), dd: number[] = [], wordEnd: number[] = [], other: number[] = [], pairs: Record<string, number[]> = {};
  for (let i = 1; i < chars.length; i++) {
    const gap = chars[i].t - chars[i - 1].t, a = chars[i - 1].k, b = chars[i].k;
    dd.push(gap);
    (WORD_END.has(a) ? wordEnd : other).push(gap);
    if (typeof a === "string" && typeof b === "string" && a.length === 1 && b.length === 1) (pairs[`${a}${b}`.toLowerCase()] ??= []).push(gap);
  }
  const we = median(wordEnd), ot = median(other);
  const shifted = kd.filter((r) => SHIFTED.test(r.k));
  // K4: the Shift keydown that holds a key (the last one before it with no Shift keyup between), and the keyup of a keydown.
  const shiftOf = (r: Rec) => kd.filter((s) => s.k === "Shift" && s.t <= r.t && !ku.some((u) => u.k === "Shift" && u.t > s.t && u.t < r.t)).at(-1);
  const upOf = (r: Rec) => ku.find((u) => u.c === r.c && u.t >= r.t);
  const held = shifted.map((r) => [r, shiftOf(r)] as const).filter(([, s]) => s !== undefined);
  const shifts = kd.filter((r) => r.k === "Shift"), loc = (r: Rec) => (r.l === 1 || r.l === 2 ? r.l : 0);
  let sided = 0, otherHand = 0;
  for (const s of shifts) {
    const first = chars.find((r) => r.t >= s.t && shiftOf(r) === s);
    if (!first || !SHIFTED.test(first.k) || !loc(s)) continue;
    sided++;
    if ((LEFT_HAND.has(first.k) ? 2 : 1) === loc(s)) otherHand++;
  }
  return {
    keys: chars.length, holds, downToDown: dd, wordEndExtraMs: we !== null && ot !== null ? we - ot : null, overlaps, overlapShare: chars.length > 1 ? overlaps / (chars.length - 1) : null,
    shiftedChars: shifted.length, shiftedWithShiftDown: held.length,
    numLockOn: kd.filter((r) => r.nl === 1).length, backspaces: kd.filter((r) => r.k === "Backspace").length, pairs,
    holdsByKey, shiftDowns: shifts.length, shiftLocations: shifts.map(loc),
    shiftUpAfter: held.filter(([r, s]) => { const up = upOf(r), sup = ku.find((u) => u.k === "Shift" && u.t > s!.t); return !!up && !!sup && sup.t > up.t; }).length,
    shiftSided: sided, shiftOtherHand: otherHand,
  };
}

/** The text's measures (R4): typed characters and their key events, and texts that came with no key event; null with no inserted text. */
export function textMeasures(recs: readonly Rec[], limit = TEXT_LIMIT): TextMeasures | null {
  const inputs = recs.filter((r) => r.e === "input" && /^insert(Text|FromPaste|ReplacementText)$/.test(String(r.it ?? "")));
  if (!inputs.length) return null;
  const charDowns = recs.filter((r) => r.e === "keydown" && !r.r && typeof r.k === "string" && r.k.length === 1);
  let chars = 0, none = 0, long = 0;
  for (const r of inputs) {
    const n = String(r.dt ?? "").length;
    chars += n;
    const keyed = charDowns.some((k) => k.t <= r.t && r.t - k.t <= 100);
    if (n > 1 || !keyed) { if (n > limit) long++; else none++; }
  }
  return { inputs: inputs.length, chars, keyChars: charDowns.length, keyEventsPerChar: chars ? charDowns.length / chars : null, textsWithNoKeys: none, longTextsWithNoKeys: long };
}

/** Focusins on a text field with no press on it and no Tab key in the 1.5 s before (R3, R14). */
export function focusinWithNoPress(recs: readonly Rec[]): number {
  return recs.filter((r) => r.e === "focusin" && TEXT_FIELDS.includes(r.tg)).filter((r) =>
    !recs.some((x) => x.e === "pointerdown" && frame(x) === frame(r) && x.tg === r.tg && x.t <= r.t && r.t - x.t < FOCUS_CAUSE_MS)
    && !recs.some((x) => x.e === "keydown" && x.k === "Tab" && x.t <= r.t && r.t - x.t < FOCUS_CAUSE_MS)).length;
}

/** The wheel's measures (P7, R5, R6), or null with no wheel and no scroll. */
export function wheelMeasures(recs: readonly Rec[]): WheelMeasures | null {
  const wheels = recs.filter((r) => r.e === "wheel").sort(byTime), scrolls = recs.filter((r) => r.e === "scroll" && frame(r) === "top");
  if (!wheels.length && !scrolls.length) return null;
  const ratios: number[] = [], gaps: number[] = [];
  for (const w of wheels) {
    if (num(w.dy) && w.dy !== 0 && num(w.wdy)) ratios.push(w.wdy / w.dy);
    else if (num(w.dx) && w.dx !== 0 && num(w.wdx)) ratios.push(w.wdx / w.dx);
  }
  for (let i = 1; i < wheels.length; i++) gaps.push(wheels[i].t - wheels[i - 1].t);
  const caused = (s: Rec) => recs.some((r) => (r.e === "wheel" || r.e === "keydown") && r.t <= s.t && s.t - r.t < SCROLL_CAUSE_MS);
  return { events: wheels.length, absDeltaY: wheels.map((w) => Math.abs(w.dy || w.dx || 0)), ratios, deltaModes: wheels.map((w) => (num(w.dm) ? w.dm : null)), gapsMs: gaps,
    scrolls: scrolls.length, scrollsWithNoWheelOrKey: scrolls.filter((s) => !caused(s)).length };
}

/**
 * The click box's own view (P4): the entry point's distance to the box's nearest edge, its moves before the press, the
 * time from the entry to the press, and the straightness of its samples from the entry to the press (the entry's own
 * point first, then the coalesced samples of the box's pointermoves).
 */
export function boxMeasures(recs: readonly Rec[], size = BOX_SIZE): BoxMeasures | null {
  const box = recs.filter((r) => r.f === "box").sort(byTime);
  const first = box.find((r) => /^pointer(over|enter|move)$/.test(r.e) && num(r.x) && num(r.y));
  if (!first) return null;
  const down = box.find((r) => r.e === "pointerdown");
  const inside = box.filter((r) => r.e === "pointermove" && r.t >= first.t && (!down || r.t <= down.t));
  const pts = [{ t: first.t, x: first.x, y: first.y }, ...samplesOf(inside).filter((s) => s.t >= first.t)]
    .filter((p, i, a) => i === 0 || p.t > a[i - 1].t || p.x !== a[i - 1].x || p.y !== a[i - 1].y);
  return { entryEdgePx: Math.min(first.x, first.y, size.w - first.x, size.h - first.y),
    movesInside: box.filter((r) => r.e === "pointermove" && (!down || r.t <= down.t)).length, entryToPressMs: down ? down.t - first.t : null,
    straightness: pathShape(pts)?.straightness ?? null };
}

/**
 * P6's load to the first move: when the step holds the first trusted pointer move (a pointermove or pointerover, in any
 * frame) after a load of the top page (its state record "load"), the time from that load to that move; else null.
 */
export function loadToFirstMove(all: readonly Rec[], m: Pick<StepMark, "t0" | "t1">): number | null {
  const list = all.filter((r) => num(r.t)).sort(byTime);
  const loads = list.filter((r) => r.e === "state" && frame(r) === "top" && r.why === "load");
  for (let i = 0; i < loads.length; i++) {
    const next = loads[i + 1]?.t ?? Infinity;
    const move = list.find((r) => r.t > loads[i].t && r.t < next && r.tr === 1 && /^pointer(move|over)$/.test(r.e));
    if (move && move.t >= m.t0 - WINDOW_BEFORE_MS && move.t <= m.t1 + WINDOW_AFTER_MS) return Math.round((move.t - loads[i].t) * 10) / 10;
  }
  return null;
}

/**
 * R11: for each activation of the page's window in the step, the jump (px, on the screen) from the page's last pointer
 * position before it to the first pointer event after it. An activation is a focus of the top window that is not a move
 * of the focus inside the page (no blur of the box's window at the same moment); its records within 50 ms are one. When
 * Chrome brings a window forward, the page gets a real event at the X pointer (the research, section 6).
 */
export function activationJumps(all: readonly Rec[], m: Pick<StepMark, "t0" | "t1">): number[] {
  const list = all.filter((r) => num(r.t)).sort(byTime);
  const point = (r: Rec) => /^(pointer|mouse)(move|over|enter|down|up)$/.test(r.e) && num(r.sx) && num(r.sy);
  const out: number[] = [];
  let last = -Infinity;
  for (const f of list.filter((r) => r.e === "focus" && frame(r) === "top" && r.tg === WINDOW)) {
    if (f.t - last < ACTIVATION_SAME_MS) continue;
    if (list.some((r) => r.e === "blur" && frame(r) === "box" && r.tg === WINDOW && Math.abs(r.t - f.t) <= ACTIVATION_PAIRED_MS)) continue;
    last = f.t;
    if (f.t < m.t0 - WINDOW_BEFORE_MS || f.t > m.t1 + WINDOW_AFTER_MS) continue;
    const before = list.filter((r) => r.t < f.t && point(r)).at(-1), after = list.find((r) => r.t > f.t && r.t - f.t <= ACTIVATION_AFTER_MS && point(r));
    if (before && after) out.push(Math.round(Math.hypot(after.sx - before.sx, after.sy - before.sy) * 10) / 10);
  }
  return out;
}

/** The beacon batches that never came: the gaps in their sequence numbers (recorder.html gives each batch one, from 0). */
export function lostBatches(seqs: readonly number[]): number {
  const seen = new Set(seqs);
  return seen.size ? Math.max(...seen) + 1 - seen.size : 0;
}

/** All the measures of one step. */
export function measureStep(all: readonly Rec[], m: StepMark): StepMeasures {
  const recs = stepRecords(all, m), pointer = pointerMeasures(recs, m.width);
  return {
    name: m.name, source: m.source, kind: m.kind, ok: m.ok, ms: m.t1 - m.t0,
    pointer, box: boxMeasures(recs), keys: keyMeasures(recs), text: textMeasures(recs), wheel: wheelMeasures(recs),
    focusinWithNoPress: focusinWithNoPress(recs), untrusted: recs.filter((r) => r.tr === 0).length, touch: recs.filter((r) => r.e.startsWith("touch")).length,
    idleMovesPerS: m.kind === "idle" ? (pointer?.moves ?? 0) / Math.max(0.001, (m.t1 - m.t0) / 1000) : null, loadToFirstMoveMs: loadToFirstMove(all, m),
    events: recs.filter((r) => r.tr === 0 || r.tr === 1).length, activationJumps: activationJumps(all, m), ...(m.path ? { path: m.path } : {}),
  };
}
