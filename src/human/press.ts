// The press (board ab-t30.3; the input design, sections 6.2 and 10.1; C11 "The input stage", the pointer): the pause
// before a press, the hold, the gap of a double click, and the press point. Pure: the random source and the person are
// arguments, and the hit test is the caller's.
//
// - The pause before a press: a lognormal, median 140 ms (times the person's factor), from 80 to 400 ms.
// - The hold: a lognormal, median 100 ms (times the person's factor), from 60 to 180 ms; force 0.5.
// - A double click's gap, from the first release to the second press: 90 to 150 ms.
// - A click's modifier key (Playwright's ensureModifiers) goes up 60 to 200 ms after the mouse release.
// - The press point: a person's press spreads around the middle of a target, an offset with a standard deviation of 1/8
//   of the target's smaller side and at most 1/4 of it. For some targets the point is the client's result (a
//   `click({ position })`, a canvas, a range input, the caret in a text field, a double click on a word), so the spread
//   applies only when all four conditions of the design's section 6.2 hold; else the press is at the client's point,
//   rounded to a whole px.

import type { Person } from "./person.ts";
import { draw, normal, type Random } from "./random.ts";
import type { Pt } from "./path.ts";

/** A box of CSS px. */
export type Box = { x: number; y: number; w: number; h: number };

/** A lognormal value with its median times `factor`, inside the distribution's bounds, or inside `bounds` when given. */
function scaled(random: Random, dist: Person["params"]["press"]["pauseMs"], factor: number, bounds?: readonly [number, number]): number {
  if (!("lognormal" in dist)) return draw(random, dist, bounds);
  return draw(random, { ...dist, lognormal: [dist.lognormal[0] * factor, dist.lognormal[1]] }, bounds);
}

/** The pause before a press (ms). `bounds`: a caller's range in place of the file's (agent-browser's inputTiming.settleMs). */
export const pauseMs = (person: Person, random: Random, bounds?: readonly [number, number]) => scaled(random, person.params.press.pauseMs, person.pause, bounds);
/** The press's hold (ms). `bounds`: a caller's range in place of the file's (agent-browser's inputTiming.pressMs). */
export const holdMs = (person: Person, random: Random, bounds?: readonly [number, number]) => scaled(random, person.params.press.holdMs, person.hold, bounds);
/** The gap of a double click, from the first release to the second press (ms). */
export const doubleClickGapMs = (person: Person, random: Random) => draw(random, person.params.press.doubleGapMs);
/** The release of a click's modifier key after the mouse release (ms; C11 modifierAfterMs: Playwright's ensureModifiers). */
export const modifierAfterMs = (person: Person, random: Random) => draw(random, person.params.press.modifierAfterMs);
/** The press's force. */
export const force = (person: Person) => person.params.press.force;

/** What the stage reads of the element at the client's point (in its own world): condition 3 of the press point. */
export type ElementKind = { tag: string; type?: string; role?: string; href?: boolean; usemap?: boolean; editable?: boolean };

const POINT_FREE_TAGS = new Set(["button", "label", "summary"]);
const POINT_FREE_INPUTS = new Set(["button", "submit", "reset", "checkbox", "radio"]);
const POINT_FREE_ROLES = new Set(["button", "link", "checkbox", "radio", "tab", "menuitem", "switch"]);
const POINT_TAGS = new Set(["canvas", "svg", "video", "textarea"]);

/**
 * Condition 3: an element whose effect does not depend on the point: a `button`, an `a[href]`, an `input` of the type
 * `button`, `submit`, `reset`, `checkbox` or `radio`, a `label`, a `summary`, or an element with the role `button`,
 * `link`, `checkbox`, `radio`, `tab`, `menuitem` or `switch`; never a `canvas`, an `img` with a map, an `svg`, a `video`,
 * an `input` of another type, a `textarea` or a contenteditable.
 */
export function pointFree(el: ElementKind): boolean {
  const tag = el.tag.toLowerCase(), type = (el.type ?? "text").toLowerCase();
  if (el.editable || POINT_TAGS.has(tag) || (tag === "img" && el.usemap)) return false;
  if (tag === "input") return POINT_FREE_INPUTS.has(type);
  if (POINT_FREE_TAGS.has(tag) || (tag === "a" && el.href)) return true;
  return !!el.role && POINT_FREE_ROLES.has(el.role.toLowerCase());
}

/** Condition 2: no `position`: the client's point is within 1 px of the middle of the element's content quad. */
export const atMiddle = (p: Pt, quad: Box) => Math.abs(p.x - (quad.x + quad.w / 2)) <= 1 && Math.abs(p.y - (quad.y + quad.h / 2)) <= 1;

/** A spread point of a box: its middle plus a normal offset (sd 1/8 of the smaller side), at most 1/4 of that side from it, in whole px. */
export function spreadPoint(box: Box, person: Person, random: Random): Pt {
  const s = Math.min(box.w, box.h), { sdShare, maxShare } = person.params.press.spread, max = s * maxShare;
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  let dx = normal(random, 0, s * sdShare), dy = normal(random, 0, s * sdShare);
  const r = Math.hypot(dx, dy);
  if (r > max) { dx *= max / r; dy *= max / r; }
  // The rounding can take a point past the bound by up to 0.71 px: then the offset shrinks by that much first.
  for (const k of [1, Math.max(0, r > 0 ? (Math.min(r, max) - 0.75) / Math.min(r, max) : 0), 0]) {
    const p = { x: Math.round(cx + dx * k), y: Math.round(cy + dy * k) };
    if (Math.hypot(p.x - cx, p.y - cy) <= max + 1e-9) return p;
  }
  return { x: Math.round(cx), y: Math.round(cy) };
}

/** What the stage knows of a press (section 6.2's four conditions). */
export type PressCase = {
  /** The client's point (Playwright's). */
  point: Pt;
  /** Condition 1: a locator click: a hit-target setup of the action `mouse` before it. */
  locatorClick: boolean;
  /** Condition 1: the press's `clickCount`, and whether a press of the same action has `clickCount` 2 or 3 (a dblclick or a triple click). */
  clickCount: number;
  multiClick?: boolean;
  /** Condition 2: the element's content quad (the answer of the client's own DOM.getContentQuads). */
  quad: Box | null;
  /** Condition 3: the element at the client's point. */
  element: ElementKind | null;
  /** Condition 4: the stage's own hit test: the element at `p` is the one at the client's point. */
  sameElementAt: (p: Pt) => boolean | Promise<boolean>;
};

/**
 * The press point: the spread point when all four conditions hold (a locator click with clickCount 1 and no press of the
 * same action with clickCount 2 or 3; the client's point within 1 px of the quad's middle; an element whose effect does
 * not depend on the point; the hit test at the spread point gives the same element), else the client's point rounded.
 */
export async function pressPoint(c: PressCase, person: Person, random: Random): Promise<{ point: Pt; spread: boolean }> {
  const plain = { point: { x: Math.round(c.point.x), y: Math.round(c.point.y) }, spread: false };
  if (!c.locatorClick || c.clickCount !== 1 || c.multiClick) return plain;
  if (!c.quad || !atMiddle(c.point, c.quad)) return plain;
  if (!c.element || !pointFree(c.element)) return plain;
  const p = spreadPoint(c.quad, person, random);
  return (await c.sameElementAt(p)) ? { point: p, spread: true } : plain;
}
