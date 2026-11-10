// The input harness's statistics (board ab-t30.2; design 2026-11-10-vanilla-playwright-human-input-design.md, section
// 13.3): pure functions with no I/O, unit-tested in test/input-harness.test.ts.

export type Sample = { t: number; x: number; y: number };

export function median(a: readonly number[]): number | null {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function mean(a: readonly number[]): number | null {
  return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
}

/** The two-sample Kolmogorov-Smirnov statistic: the largest distance between the two empirical CDFs. */
export function ks2(a: readonly number[], b: readonly number[]): number | null {
  if (!a.length || !b.length) return null;
  const x = [...a].sort((p, q) => p - q), y = [...b].sort((p, q) => p - q);
  let i = 0, j = 0, d = 0;
  while (i < x.length && j < y.length) {
    const v = Math.min(x[i], y[j]);
    while (i < x.length && x[i] <= v) i++;
    while (j < y.length && y[j] <= v) j++;
    d = Math.max(d, Math.abs(i / x.length - j / y.length));
  }
  return d;
}

/** The one-sample Kolmogorov-Smirnov statistic against a model's CDF. */
export function ks1(a: readonly number[], cdf: (x: number) => number): number | null {
  if (!a.length) return null;
  const x = [...a].sort((p, q) => p - q), n = x.length;
  let d = 0;
  for (let i = 0; i < n; i++) {
    const f = cdf(x[i]);
    d = Math.max(d, (i + 1) / n - f, f - i / n);
  }
  return d;
}

/** c(alpha) of the Kolmogorov distribution at alpha = 0.05. */
export const KS_C_05 = 1.358;

/** One sample against a model: the exact bound for n up to this (the asymptotic bound is too lenient for a small n: 0.784 for n = 3, where the exact one is 0.708). */
export const KS_EXACT_MAX = 35;

function matMul(a: number[][], b: number[][]): number[][] {
  const m = a.length, out = a.map(() => new Array<number>(m).fill(0));
  for (let i = 0; i < m; i++) for (let k = 0; k < m; k++) { const v = a[i][k]; if (v) for (let j = 0; j < m; j++) out[i][j] += v * b[k][j]; }
  return out;
}

/**
 * P(D_n < d) of the one-sample KS statistic, exact: the method of Marsaglia, Tsang and Wang (2003), "Evaluating
 * Kolmogorov's distribution", J. Stat. Softw. 8(18), with no scaling (enough for n up to KS_EXACT_MAX).
 */
export function ksCdf(n: number, d: number): number {
  if (d <= 0) return 0;
  if (d >= 1) return 1;
  const k = Math.floor(n * d) + 1, m = 2 * k - 1, h = k - n * d;
  const H = Array.from({ length: m }, (_, i) => Array.from({ length: m }, (_, j) => (i - j + 1 >= 0 ? 1 : 0)));
  for (let i = 0; i < m; i++) { H[i][0] -= h ** (i + 1); H[m - 1][i] -= h ** (m - i); }
  H[m - 1][0] += 2 * h - 1 > 0 ? (2 * h - 1) ** m : 0;
  for (let i = 0; i < m; i++) for (let j = 0; j < m; j++) if (i - j + 1 > 0) for (let g = 1; g <= i - j + 1; g++) H[i][j] /= g;
  let q: number[][] | null = null, b = H, e = n;
  while (e > 0) { if (e & 1) q = q ? matMul(q, b) : b; e >>= 1; if (e) b = matMul(b, b); }
  let s = q![k - 1][k - 1];
  for (let i = 1; i <= n; i++) s = (s * i) / n;
  return s;
}

const critical = new Map<number, number>();

/** The exact critical value of the one-sample KS statistic at 5% (two-sided): the d with P(D_n >= d) = 0.05 (Miller's table, 1956). */
export function ksCritical(n: number): number {
  const kept = critical.get(n);
  if (kept !== undefined) return kept;
  let lo = 0, hi = 1;
  for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (ksCdf(n, mid) < 0.95) lo = mid; else hi = mid; }
  critical.set(n, hi);
  return hi;
}

/** The bound of a KS statistic at 5%. One sample against a model: exact for n up to KS_EXACT_MAX, else c / sqrt(n). Two samples: the asymptotic c sqrt((n + m) / (n m)). */
export function ksBound(n: number, m?: number): number {
  if (m !== undefined) return KS_C_05 * Math.sqrt((n + m) / (n * m));
  return n <= KS_EXACT_MAX ? ksCritical(n) : KS_C_05 / Math.sqrt(n);
}

/** erf by Abramowitz and Stegun 7.1.26 (error below 1.5e-7). */
function erf(x: number): number {
  const s = Math.sign(x), a = Math.abs(x), t = 1 / (1 + 0.3275911 * a);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return s * y;
}

export function normalCdf(x: number, mu: number, sd: number): number {
  return 0.5 * (1 + erf((x - mu) / (sd * Math.SQRT2)));
}

/** A lognormal by its median and its sigma (the standard deviation of the log). */
export function lognormalCdf(x: number, med: number, sigma: number): number {
  return x <= 0 ? 0 : normalCdf(Math.log(x / med), 0, sigma);
}

/** [median, sigma] of the lognormal with this mean and standard deviation. */
export function lognormalOf(mu: number, sd: number): [number, number] {
  const v = Math.log(1 + (sd / mu) ** 2);
  return [mu / Math.sqrt(1 + (sd / mu) ** 2), Math.sqrt(v)];
}

/** A gap counts as a whole millisecond within 0.15 ms of a whole number of 1 ms or more (the research's rule, section 2; a gap of 0 ms is two equal times, not a whole ms). */
export const WHOLE_MS_TOL = 0.15;
/** The step of the page's clock (performance.now() and event.timeStamp are coarsened to 0.1 ms). */
export const CLOCK_STEP_MS = 0.1;

export function isWholeMs(gap: number, tol = WHOLE_MS_TOL): boolean {
  return Math.round(gap) >= 1 && Math.abs(gap - Math.round(gap)) <= tol + 1e-9;
}

export function wholeMsShare(gaps: readonly number[], tol = WHOLE_MS_TOL): number | null {
  return gaps.length ? gaps.filter((g) => isWholeMs(g, tol)).length / gaps.length : null;
}

/** The share of random gaps on the clock's grid that pass isWholeMs by chance: 3 of 10 points (x.9, x.0, x.1) at 0.1 ms. */
export function wholeMsChance(step = CLOCK_STEP_MS, tol = WHOLE_MS_TOL): number {
  return Math.min(1, (2 * Math.floor(tol / step + 1e-9) + 1) * step);
}

/** How many standard deviations k of n lies above the chance p (the normal approximation of the binomial). */
export function binomialZ(k: number, n: number, p: number): number | null {
  return n > 0 ? (k - n * p) / Math.sqrt(n * p * (1 - p)) : null;
}

export type PathShape = { samples: number; ms: number; lengthPx: number; chordPx: number; straightness: number; maxDeviationPx: number; peakPxPerMs: number; meanPxPerMs: number; speedPeaks: number };

/** The shape of a path of 3 or more samples (the research's analyze.ts: straightness = chord / length; the peak over gaps above 0.5 ms). */
export function pathShape(pts: readonly Sample[]): PathShape | null {
  if (pts.length < 3) return null;
  const a = pts[0], b = pts[pts.length - 1], chord = Math.hypot(b.x - a.x, b.y - a.y);
  let len = 0, peak = 0, dev = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y), dt = pts[i].t - pts[i - 1].t;
    len += d;
    if (dt > 0.5) peak = Math.max(peak, d / dt);
    if (chord > 0) dev = Math.max(dev, Math.abs((b.x - a.x) * (a.y - pts[i].y) - (a.x - pts[i].x) * (b.y - a.y)) / chord);
  }
  const ms = b.t - a.t;
  return { samples: pts.length, ms, lengthPx: len, chordPx: chord, straightness: len > 0 ? chord / len : 1, maxDeviationPx: dev, peakPxPerMs: peak,
    meanPxPerMs: len / Math.max(1, ms), speedPeaks: speedPeaks(pts) };
}

/** The speed profile's smoothing (a centred mean over this many gaps), the least height of a peak against the highest, and the dip between two peaks. */
export const PEAK_SMOOTH = 5, PEAK_MIN_SHARE = 0.2, PEAK_DIP = 0.75;

/**
 * The number of speed peaks (sub-movements): the local maxima of the smoothed speed that reach 20% of its highest,
 * where the speed between two counted peaks falls to 75% of the lower one or below. 0 for fewer than 3 samples.
 */
export function speedPeaks(pts: readonly Sample[]): number {
  if (pts.length < 3) return 0;
  const v: number[] = [];
  for (let i = 1; i < pts.length; i++) {
    const dt = pts[i].t - pts[i - 1].t;
    if (dt > 0.5) v.push(Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y) / dt);
  }
  if (!v.length) return 0;
  const h = PEAK_SMOOTH >> 1;
  const s = v.map((_, i) => { const w = v.slice(Math.max(0, i - h), i + h + 1); return w.reduce((x, y) => x + y, 0) / w.length; });
  const top = Math.max(...s);
  if (top <= 0) return 0;
  const at = (i: number) => (i < 0 || i >= s.length ? -Infinity : s[i]);
  const cand = s.map((x, i) => i).filter((i) => at(i) >= at(i - 1) && at(i) > at(i + 1) && s[i] >= PEAK_MIN_SHARE * top);
  const peaks: number[] = [];
  for (const c of cand) {
    const last = peaks[peaks.length - 1];
    if (last === undefined) { peaks.push(c); continue; }
    const dip = Math.min(...s.slice(last, c + 1));
    if (dip <= PEAK_DIP * Math.min(s[last], s[c])) peaks.push(c);
    else if (s[c] > s[last]) peaks[peaks.length - 1] = c;
  }
  return peaks.length;
}

/** Fitts's law with the design's first values (section 10.1: a = 250 ms, b = 110 ms a bit), not clamped. */
export const FITTS_A_MS = 250, FITTS_B_MS = 110;

export function fittsMs(distance: number, width: number, a = FITTS_A_MS, b = FITTS_B_MS): number {
  return a + b * Math.log2(1 + distance / Math.max(1, width));
}
