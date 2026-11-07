// The live check's counts of the pointer design (board ab-v16.71; the agent pointer design, section 7): from the
// anti-detect probe's page log (test/live/anti-detect/probe.ts), the stand-in daemon's played paths (pointer-ops.ts)
// and the relay's step lines (AGENT_BROWSER_POINTER_LOG=1). Not part of `npm test`; test/pointer-measure.test.ts checks
// the matching on a small log.

import { inputs, pointerSignals, type Rec } from "../anti-detect/probe.ts";
import type { Played } from "./pointer-ops.ts";

/** A relay step line: `relay: step <kind> of tab <id>: <what>; <ms> ms`, with the time that the harness read it. */
export type StepLine = { t: number; kind: string; tab: number; what: string; ms: number };
export function stepLine(t: number, line: string): StepLine | null {
  const m = /^relay: step (\w+) of tab (\d+): (.*); (\d+) ms$/.exec(line);
  return m ? { t, kind: m[1], tab: Number(m[2]), what: m[3], ms: Number(m[4]) } : null;
}
export const played = (s: StepLine) => /^a path of \d+ points, ok/.test(s.what);
export const noPath = (s: StepLine) => !played(s);

type Move = Record<string, any> & { at: number };
/** A page's mousemove events in [from, to], by their event time (te), in order. */
export function movesOf(log: Rec[], tab: string, from: number, to: number): Move[] {
  return inputs(log, tab, from, to).filter((e) => e.type === "mousemove").map((e) => ({ ...e, at: typeof e.te === "number" ? e.te : e.t })).sort((a, b) => a.at - b.at);
}

/**
 * The moves that a played path gave a page: in the play's time, at a point of the path (the event's screen point), in
 * the path's order. Chrome merges the moves of one frame (fact 3), so a page can see fewer moves than the path has.
 */
export function pathMoves(log: Rec[], tab: string, p: Played): { m: Move; i: number }[] {
  const out: { m: Move; i: number }[] = [];
  let j = 0;
  for (const m of movesOf(log, tab, p.startedAt - 1000, p.endedAt + 1000)) {
    if (m.at < p.startedAt - 5 || m.at > p.endedAt + 5) continue;
    let k = j;
    while (k < p.path.length && !(p.path[k].x === m.sx && p.path[k].y === m.sy)) k++;
    if (k === p.path.length) continue;
    out.push({ m, i: k });
    j = k + 1;
  }
  return out;
}

/** The dt that the page saw against the planned dt: each pair of consecutive matched moves (seen ms, planned ms). */
export function dtPairs(matches: { m: Move; i: number }[], p: Played): { seen: number; planned: number }[] {
  const out: { seen: number; planned: number }[] = [];
  for (let k = 1; k < matches.length; k++) {
    let planned = 0;
    for (let i = matches[k - 1].i + 1; i <= matches[k].i; i++) planned += p.path[i].dt;
    out.push({ seen: matches[k].m.at - matches[k - 1].m.at, planned });
  }
  return out;
}

/** Presses away from the last move: a mousedown more than 2 px from the page's last mousemove before it. */
export function pressesAway(log: Rec[], tab: string, from: number, to: number): number {
  const evs = inputs(log, tab, from, to).map((e) => ({ ...e, at: typeof e.te === "number" ? e.te : e.t })).sort((a, b) => a.at - b.at);
  let last: Record<string, any> | null = null, n = 0;
  for (const e of evs) {
    if (e.type === "mousemove") last = e;
    else if (e.type === "mousedown" && last && Math.hypot(e.cx - last.cx, e.cy - last.cy) > 2) n++;
  }
  return n;
}

/** Real moves between a page's mousedown and its mouseup (a path must not play under a page that holds a button). */
export function movesWhileHeld(log: Rec[], tab: string, from: number, to: number): number {
  const evs = inputs(log, tab, from, to).map((e) => ({ ...e, at: typeof e.te === "number" ? e.te : e.t })).sort((a, b) => a.at - b.at);
  let held = false, n = 0;
  for (const e of evs) {
    if (e.type === "mousedown") held = true;
    else if (e.type === "mouseup") held = false;
    else if (e.type === "mousemove" && held && !e.b) n++;
  }
  return n;
}

const quantile = (xs: number[], q: number) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
export const stats = (xs: number[]) => ({ n: xs.length, median: quantile(xs, 0.5), p90: quantile(xs, 0.9), max: xs.length ? Math.max(...xs) : null });

/**
 * The counts of one page over [from, to] (section 7): jumps over 100 px and position changes that the movement does not
 * explain (as probe.ts's pointerSignals counts them), entries at an earlier entry's point (`activations`: the times of
 * its activations), and, for each played path that the page saw as the leaving page (`plays`), its moves (zero-movement
 * moves, the largest movement: Chrome merges the moves of one frame, so up to 100 px; the speed; the dt seen). A jump or
 * an unexplained change at one of the client's own raw-move points (`own`: Playwright's one move to each target) is
 * counted apart.
 */
export function pageCounts(log: Rec[], tab: string, from: number, to: number, activations: number[], plays: Played[], own: { x: number; y: number }[] = []) {
  const sig = pointerSignals(log, tab, from, to, activations);
  const moves = movesOf(log, tab, from, to);
  let jumps = 0, unexplained = 0, ownRaw = 0;
  const detail: string[] = [];
  for (let i = 0; i < moves.length; i++) {
    const m = moves[i], jump = Math.hypot(m.mx ?? 0, m.my ?? 0) > 100;
    const p = i ? moves[i - 1] : null, un = !!p && Math.hypot(m.cx - p.cx - (m.mx ?? 0), m.cy - p.cy - (m.my ?? 0)) > 20;
    if (!jump && !un) continue;
    const at = `(${p ? `${p.cx},${p.cy}` : "?"})->(${m.cx},${m.cy}) mv(${m.mx},${m.my}) t=${m.at}`;
    if (own.some((q) => Math.abs(q.x - m.cx) <= 1 && Math.abs(q.y - m.cy) <= 1)) { ownRaw++; detail.push(`own raw move ${at}`); continue; }
    if (jump) jumps++;
    if (un) unexplained++;
    detail.push(`${jump ? "jump" : "unexplained"} ${at}`);
  }
  const paths = plays.map((p) => ({ p, matches: pathMoves(log, tab, p) })).filter((x) => x.matches.length);
  const pathMovesAll = paths.flatMap((x) => x.matches.map((y) => y.m));
  // The speed of each move after the first of its path: its movement over the time since the move before it (px/ms).
  const speeds = paths.flatMap((x) => x.matches.slice(1).map((y, k) => { const dt = y.m.at - x.matches[k].m.at; return dt > 0 ? Math.hypot(y.m.mx ?? 0, y.m.my ?? 0) / dt : null; }))
    .filter((v): v is number => v !== null);
  return {
    moves: moves.length, jumps, unexplained, ownRaw, sameEntries: sig.sameEntries, detail: detail.slice(0, 16),
    paths: paths.length,
    pathMoves: pathMovesAll.length,
    zeroMovement: pathMovesAll.filter((m) => !m.mx && !m.my).length,
    maxPathMovement: pathMovesAll.length ? Math.max(...pathMovesAll.map((m) => Math.round(Math.hypot(m.mx ?? 0, m.my ?? 0)))) : 0,
    movesPerPath: stats(paths.map((x) => x.matches.length)),
    speedPxPerMs: stats(speeds.map((v) => Math.round(v * 100) / 100)),
    dt: paths.flatMap((x) => dtPairs(x.matches, x.p)),
  };
}

/** The leaving page of each played path: the page that saw the most of its moves (the entering page sees at most its entry). */
export function leavingPages(log: Rec[], tabs: string[], plays: Played[]): Map<Played, string> {
  const out = new Map<Played, string>();
  for (const p of plays) {
    let best = "", n = 0;
    for (const tab of tabs) { const k = pathMoves(log, tab, p).length; if (k > n) { n = k; best = tab; } }
    if (best) out.set(p, best);
  }
  return out;
}
