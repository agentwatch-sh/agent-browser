// The wheel (board ab-t30.3; the input design, section 8.2; C11 "The input stage", the scroll and the wheel): notches of
// the platform's size (120 px on X11), with a person's gaps, and the residual that keeps a series of wheel calls within
// one notch of the asked total. Pure: the random source and the person are arguments.
//
// The count (C11): a call gets n = max(0, round((|delta| + r) / notch)) notches (round half up), where r is the axis's
// residual in the direction of the call; when n is 0 and r is 0 or more, the call gets one notch, so a call whose delta
// is not 0 gets a wheel event unless earlier notches have already given it. The residual is what the page's wheel calls
// asked for, less what its notches gave.

import type { Person } from "./person.ts";
import { draw, type Random } from "./random.ts";

/** The notches of one call on one axis: their count with their sign (+ down or right), and the axis's new residual. */
export function notches(delta: number, residual: number, notchPx: number): { count: number; residual: number } {
  if (!delta) return { count: 0, residual };
  const dir = Math.sign(delta), r = residual * dir;
  let n = Math.max(0, Math.floor((Math.abs(delta) + r) / notchPx + 0.5));
  if (n === 0 && r >= 0) n = 1;
  return { count: dir * n, residual: residual + delta - dir * n * notchPx };
}

/** One page's residuals, an axis each. */
export class Wheel {
  x = 0;
  y = 0;
  readonly notchPx: number;
  constructor(notchPx: number) { this.notchPx = notchPx; }
  /** The signed notch counts of a call (deltaX, deltaY), with the residuals kept. */
  take(dx: number, dy: number): { x: number; y: number } {
    const a = notches(dx, this.x, this.notchPx), b = notches(dy, this.y, this.notchPx);
    this.x = a.residual;
    this.y = b.residual;
    return { x: a.count, y: b.count };
  }
}

/** The gap between two notches (ms). `bounds`: a caller's range in place of the file's (agent-browser's inputTiming.wheelMs). */
export const notchGapMs = (person: Person, random: Random, bounds?: readonly [number, number]) => draw(random, person.params.wheel.gapMs, bounds);

/** The notch events of a call: each one's deltas (px) and its time (ms after the first), the vertical axis first. */
export function wheelPlan(count: { x: number; y: number }, person: Person, random: Random, bounds?: readonly [number, number]): { dx: number; dy: number; t: number }[] {
  const px = person.params.wheel.notchPx, out: { dx: number; dy: number; t: number }[] = [];
  let t = 0;
  for (const [n, axis] of [[count.y, "y"], [count.x, "x"]] as const) {
    for (let i = 0; i < Math.abs(n); i++) {
      if (out.length) t += notchGapMs(person, random, bounds);
      out.push({ dx: axis === "x" ? Math.sign(n) * px : 0, dy: axis === "y" ? Math.sign(n) * px : 0, t });
    }
  }
  return out;
}
