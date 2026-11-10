// The generator's random source (board ab-t30.3; the input design,
// docs/superpowers/specs/2026-11-10-vanilla-playwright-human-input-design.md, section 11.1): a seeded source, and the
// draws of the models (uniform, normal, lognormal), each one bounded where the parameter file gives bounds. No I/O and no
// clock: every module of src/human/ takes its random source as an argument, so every test runs with a seed.

/** A source of numbers in [0, 1), as Math.random. */
export type Random = () => number;

/** mulberry32: a small seeded generator (from src/record.ts, where `record --seed` uses it). */
export function seededRandom(seed: number): Random {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A 32-bit seed of some parts (FNV-1a over the parts joined with NUL): one person for a scope's name and its seed. */
export function seedOf(...parts: (string | number)[]): number {
  let h = 0x811c9dc5;
  for (const ch of parts.map(String).join("\0")) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export const uniform = (random: Random, lo: number, hi: number) => lo + (hi - lo) * random();
/** True with the probability p. */
export const chance = (random: Random, p: number) => random() < p;

/** erf by Abramowitz and Stegun 7.1.26 (an error below 1.5e-7). */
function erf(x: number): number {
  const s = Math.sign(x), a = Math.abs(x), t = 1 / (1 + 0.3275911 * a);
  return s * (1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a));
}
export const normalCdf = (z: number) => 0.5 * (1 + erf(z / Math.SQRT2));

/** The standard normal's quantile (Acklam's rational approximation, a relative error below 1.2e-9), for p in (0, 1). */
export function normalQuantile(p: number): number {
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const lo = 0.02425;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - lo) return -normalQuantile(1 - p);
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/**
 * A standard normal value bounded to [za, zb], from one draw (the inverse of the CDF on the bounded part). When the
 * bounded part holds almost no probability (a test's short range far from the median), the value is uniform on [za, zb].
 */
function boundedZ(random: Random, za: number, zb: number): number {
  if (za > 0) return -boundedZ(random, -zb, -za); // the lower tail keeps the precision of the CDF
  const pa = normalCdf(za), pb = normalCdf(zb);
  if (!(pb - pa > 1e-12)) return uniform(random, Math.max(za, -40), Math.min(zb, 40));
  const z = normalQuantile(pa + (pb - pa) * random());
  return Math.min(zb, Math.max(za, z));
}

/** A distribution of the parameter files: its kind and values, with optional bounds (`min`, `max`). */
export type Dist =
  | { uniform: [number, number] }
  | { normal: [number, number]; min?: number; max?: number }
  | { lognormal: [number, number]; min?: number; max?: number };

/** The bounds of a draw: the caller's, else the distribution's own (a uniform's are its range). */
export function boundsOf(dist: Dist, bounds?: readonly [number, number]): [number, number] {
  if (bounds) return [bounds[0], bounds[1]];
  if ("uniform" in dist) return [dist.uniform[0], dist.uniform[1]];
  return [dist.min ?? -Infinity, dist.max ?? Infinity];
}

/**
 * One value of a distribution, inside its bounds: `bounds` (a caller's range, for example a test's short input times)
 * take the place of the distribution's own. A normal: mean and standard deviation. A lognormal: median and sigma (the
 * standard deviation of the log). A uniform drawn with other bounds is uniform on the bounds.
 */
export function draw(random: Random, dist: Dist, bounds?: readonly [number, number]): number {
  const [lo, hi] = boundsOf(dist, bounds);
  if (lo === hi) return lo;
  if ("uniform" in dist) return uniform(random, lo, hi);
  if ("normal" in dist) {
    const [m, sd] = dist.normal;
    return m + sd * boundedZ(random, (lo - m) / sd, (hi - m) / sd);
  }
  const [med, sigma] = dist.lognormal;
  const z = boundedZ(random, lo > 0 ? Math.log(lo / med) / sigma : -Infinity, hi > 0 ? Math.log(hi / med) / sigma : -Infinity);
  return Math.min(hi, Math.max(lo, med * Math.exp(sigma * z)));
}

/** A normal value (Box-Muller, two draws), with no bounds. */
export function normal(random: Random, mean: number, sd: number): number {
  const u = 1 - random(), v = random();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** A lognormal value by its median and sigma, with no bounds. */
export const lognormal = (random: Random, median: number, sigma: number) => median * Math.exp(normal(random, 0, sigma));
