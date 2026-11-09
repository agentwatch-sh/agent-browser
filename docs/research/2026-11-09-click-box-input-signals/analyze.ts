// The analysis of the input probe (probe.ts) and of a person's recording (recorder.html, "Save JSON") for board task
// ab-t30.1 (docs/research/2026-11-09-click-box-input-signals.md). Not part of `npm test`.
//
//   node analyze.ts RESULTS.json [--summary OUT.json] [--traces OUT.json]
//
// RESULTS.json is probe.ts's results.json, or a person's recording (then each task trial is a step). It prints one
// markdown table per scenario and writes the metrics of each step (--summary) and the CDP calls of each step (--traces).

import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { summary: { type: "string" }, traces: { type: "string" } } });
if (!positionals[0]) { process.stderr.write("usage: node analyze.ts RESULTS.json [--summary OUT.json] [--traces OUT.json]\n"); process.exit(2); }

type R = Record<string, any> & { e: string; f?: string; t: number };
type Mark = { name: string; t0: number; t1: number; ok: boolean; error?: string; note?: unknown };
type Trace = { t: number; d: ">" | "<" | "e"; id?: number; m?: string; s?: string; p?: any; err?: string };
type Scenario = { notes?: unknown; error?: string; marks: Mark[]; recs: R[]; trace: Trace[] };

const raw = JSON.parse(readFileSync(positionals[0], "utf8"));
let scenarios: Record<string, Scenario>;
let meta: Record<string, unknown>;
if (raw.scenarios) { scenarios = raw.scenarios; meta = { chrome: raw.chrome, playwright: raw.playwright, screen: raw.screen }; }
else {
  // A person's recording: each trial (task mark "trial" to the next trial or task end) is a step.
  const recs = raw.records as R[];
  const marks: Mark[] = [];
  const tm = recs.filter((r) => r.e === "task");
  for (let i = 0; i < tm.length; i++) {
    const m = tm[i];
    if (m.what !== "trial" && m.what !== "begin") continue;
    if (m.what === "begin" && tm[i + 1]?.what === "trial") continue;
    const next = tm.slice(i + 1).find((x) => x.what === "trial" || x.what === "end" || x.what === "begin");
    marks.push({ name: `${m.task ?? tm.slice(0, i).reverse().find((x) => x.what === "begin")?.task}${m.n !== undefined ? ` #${m.n}${m.leg ? ` ${m.leg}` : ""}` : ""}`, t0: m.t, t1: next ? next.t : m.t + 60_000, ok: true });
  }
  scenarios = { [`person-${raw.device || "device"}`]: { marks, recs: recs.concat((raw.frames ?? []).length ? [{ f: "top", e: "frames", t: 0, list: raw.frames }] : []), trace: [] } };
  meta = { saved: raw.saved, device: raw.device };
}

// ---------- small statistics ----------
const median = (a: number[]) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const r1 = (v: number | null | undefined) => v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 10) / 10;
const r2 = (v: number | null | undefined) => v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 100) / 100;
const range = (a: number[]) => a.length ? [r2(Math.min(...a)), r2(Math.max(...a))] : null;
const uniq = <T>(a: T[]) => [...new Set(a.map((x) => JSON.stringify(x ?? null)))].map((x) => JSON.parse(x) as T);
const isInt = (v: unknown) => typeof v === "number" && Math.abs(v - Math.round(v)) < 1e-9;
const MODKEYS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock"]);

/** The metrics of the records of one step. */
function metrics(list: R[]) {
  const by = (e: string, f?: string) => list.filter((r) => r.e === e && (!f || r.f === f));
  const out: Record<string, unknown> = {};
  out.untrusted = list.filter((r) => r.tr === 0).length;
  // ---- pointer ----
  const moves = by("pointermove");
  const downs = by("pointerdown"), ups = by("pointerup");
  const d0 = downs[0];
  if (moves.length || downs.length) {
    const before = d0 ? moves.filter((r) => r.t <= d0.t) : moves;
    const P: Record<string, unknown> = {};
    P.moves = moves.length;
    P.movesBeforePress = before.length;
    P.withMovement = moves.filter((r) => r.mx || r.my).length;
    P.frames = uniq(moves.map((r) => r.f));
    // Each frame's own view: its moves, and the first point where it saw the pointer (the box: its entry point).
    P.perFrame = Object.fromEntries(["top", "box"].map((f) => { const m = moves.filter((r) => r.f === f); return [f, { moves: m.length, first: m[0] ? [m[0].x, m[0].y] : null }]; }));
    const nc = moves.map((r) => r.nc as number).filter((v) => v >= 0), np = moves.map((r) => r.np as number).filter((v) => v >= 0);
    P.coalesced = { mean: r2(nc.reduce((a, b) => a + b, 0) / (nc.length || 1)), max: nc.length ? Math.max(...nc) : null, over1: nc.filter((v) => v > 1).length };
    P.predicted = { mean: r2(np.reduce((a, b) => a + b, 0) / (np.length || 1)), max: np.length ? Math.max(...np) : null, over0: np.filter((v) => v > 0).length };
    P.rawupdates = moves.reduce((a, r) => a + (r.ru ?? 0), 0);
    // The raw samples: the coalesced points of each pointermove, on the page's clock.
    const samples: { t: number; x: number; y: number; f: string }[] = [];
    for (const r of moves) for (const c of (r.co ?? [[0, r.x, r.y]]) as number[][]) samples.push({ t: r.t + c[0], x: c[1], y: c[2], f: r.f! });
    samples.sort((a, b) => a.t - b.t);
    const gaps: number[] = [];
    for (let i = 1; i < samples.length; i++) if (samples[i].f === samples[i - 1].f) gaps.push(samples[i].t - samples[i - 1].t);
    P.sampleGapMs = { median: r2(median(gaps)), range: range(gaps), wholeMs: gaps.length ? r2(gaps.filter((g) => Math.abs(g - Math.round(g)) <= 0.15).length / gaps.length) : null };
    const mg: number[] = [];
    for (let i = 1; i < moves.length; i++) if (moves[i].f === moves[i - 1].f) mg.push(moves[i].t - moves[i - 1].t);
    P.moveGapMs = { median: r2(median(mg)), range: range(mg) };
    P.fractional = { pointer: moves.filter((r) => !isInt(r.x) || !isInt(r.y)).length, mouse: by("mousemove").filter((r) => !isInt(r.x) || !isInt(r.y)).length,
      samples: samples.filter((s) => !isInt(s.x) || !isInt(s.y)).length };
    // movementX/Y against the change of the point (the first move of each frame has no earlier point).
    let mism = 0, jumps = 0;
    for (let i = 0; i < moves.length; i++) {
      const r = moves[i];
      if (Math.abs(r.mx) > 100 || Math.abs(r.my) > 100) jumps++;
      const prev = moves.slice(0, i).reverse().find((x) => x.f === r.f);
      if (prev && (Math.round(r.sx - prev.sx) !== r.mx || Math.round(r.sy - prev.sy) !== r.my)) mism++;
    }
    P.movementMismatch = mism;
    P.jumpsOver100 = jumps;
    P.pressureOnMoves = uniq(moves.map((r) => r.pr));
    P.handlerLagMs = { move: r2(median(moves.map((r) => r.h - r.t))), down: d0 ? r2(d0.h - d0.t) : null };
    // The path before the press (the frame of the press only: the box sees its own part).
    const pf = d0 ? before.filter((r) => r.f === d0.f) : moves;
    const pts = samples.filter((s) => (!d0 || (s.t <= d0.t && s.f === d0.f)));
    if (pts.length > 1) {
      let len = 0, peak = 0, dev = 0;
      const a = pts[0], b = pts[pts.length - 1], chord = Math.hypot(b.x - a.x, b.y - a.y);
      for (let i = 1; i < pts.length; i++) {
        const d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y), dt = pts[i].t - pts[i - 1].t;
        len += d;
        if (dt > 0.5) peak = Math.max(peak, d / dt);
        if (chord > 0) dev = Math.max(dev, Math.abs((b.x - a.x) * (a.y - pts[i].y) - (a.x - pts[i].x) * (b.y - a.y)) / chord);
      }
      P.path = { samples: pts.length, ms: r1(pts[pts.length - 1].t - pts[0].t), lengthPx: r1(len), straightness: r2(chord / (len || 1)), maxDeviationPx: r1(dev), peakPxPerMs: r2(peak),
        meanPxPerMs: r2(len / Math.max(1, pts[pts.length - 1].t - pts[0].t)) };
    }
    if (d0) {
      const last = pf.filter((r) => r.t <= d0.t).at(-1);
      P.pauseBeforePressMs = last ? r1(d0.t - last.t) : null;
      const up = ups.find((r) => r.t >= d0.t && r.f === d0.f);
      const md = by("mousedown").find((r) => r.t >= d0.t - 1 && r.f === d0.f), mu = by("mouseup").find((r) => md && r.t >= md.t && r.f === d0.f);
      const ck = by("click").find((r) => up && r.t >= up.t && r.f === d0.f);
      P.pressMs = up ? r1(up.t - d0.t) : null;
      P.mousePressMs = md && mu ? r1(mu.t - md.t) : null;
      P.upToClickMs = up && ck ? r1(ck.t - up.t) : null;
      P.down = { frame: d0.f, target: d0.tg, pointerType: d0.pt, pointerId: d0.id, isPrimary: d0.ip, pressure: d0.pr, tangentialPressure: d0.tp, width: d0.w, height: d0.ht,
        tiltX: d0.tx, tiltY: d0.ty, twist: d0.tw, altitudeAngle: d0.al, azimuthAngle: d0.az, button: d0.b, buttons: d0.bs, detail: d0.d, firesTouchEvents: d0.sc,
        screenMinusClient: [r2(d0.sx - d0.x), r2(d0.sy - d0.y)], at: [d0.x, d0.y], userActivation: d0.ua };
      P.upPressure = up ? up.pr : null;
      // The events around the press, in order (the press's frame).
      const near = list.filter((r) => r.f === d0.f && r.t >= d0.t - 30 && r.t <= (ck?.t ?? d0.t + 200) + 1 && !/move|rawupdate/.test(r.e));
      P.order = near.map((r) => r.e).join(" ");
    }
    P.presses = downs.length;
    P.boundary = Object.fromEntries(["pointerover", "pointerenter", "pointerout", "pointerleave"].map((e) => [e, `${by(e, "top").length}/${by(e, "box").length}`]));
    out.pointer = P;
  }
  // ---- keys ----
  const kd = by("keydown"), ku = by("keyup");
  if (kd.length) {
    const K: Record<string, unknown> = {};
    const holds: number[] = [], downAt = new Map<string, R>();
    let overlaps = 0;
    const seq = [...kd, ...ku].sort((a, b) => a.t - b.t);
    for (const r of seq) {
      if (r.e === "keydown") {
        if (r.r) continue;
        if (!MODKEYS.has(r.k) && [...downAt.values()].some((x) => !MODKEYS.has(x.k))) overlaps++;
        downAt.set(r.c, r);
      } else {
        const d = downAt.get(r.c);
        if (d) { if (!MODKEYS.has(r.k)) holds.push(r.t - d.t); downAt.delete(r.c); }
      }
    }
    const chars = kd.filter((r) => !r.r && !MODKEYS.has(r.k));
    const iki: number[] = [];
    for (let i = 1; i < chars.length; i++) iki.push(chars[i].t - chars[i - 1].t);
    K.keydowns = kd.length;
    K.keyups = ku.length;
    K.keypress = by("keypress").length;
    K.holdMs = { median: r1(median(holds)), range: range(holds) };
    K.downToDownMs = { median: r1(median(iki)), range: range(iki) };
    K.overlaps = overlaps;
    K.shiftDowns = kd.filter((r) => r.k === "Shift").length;
    const caps = kd.filter((r) => /^[A-Z!@#$%^&*()_+{}|:"<>?~]$/.test(r.k));
    K.shiftedChars = caps.length;
    K.shiftedWithShiftFlag = caps.filter((r) => r.m & 8).length;
    K.shiftedWithShiftKeyDown = caps.filter((r) => kd.some((s) => s.k === "Shift" && s.t <= r.t && !ku.some((u) => u.k === "Shift" && u.t > s.t && u.t < r.t))).length;
    K.locations = uniq(kd.map((r) => `${r.k.length === 1 ? "char" : r.k}:${r.l}`)).slice(0, 12);
    K.repeats = kd.filter((r) => r.r).length;
    K.composing = kd.filter((r) => r.ic).length;
    K.numLock = uniq(kd.map((r) => r.nl));
    K.keyCodes = uniq(kd.map((r) => `${r.k}:${r.kc}/${r.wh}`)).slice(0, 8);
    K.handlerLagMs = r2(median(kd.map((r) => r.h - r.t)));
    K.gapsWholeMs = iki.length ? r2(iki.filter((g) => Math.abs(g - Math.round(g)) <= 0.15).length / iki.length) : null;
    out.keys = K;
  }
  const inputs = by("input");
  if (inputs.length || by("beforeinput").length) {
    out.text = { input: inputs.length, beforeinput: by("beforeinput").length, types: uniq(inputs.map((r) => r.it)), longestData: Math.max(0, ...inputs.map((r) => (r.dt ?? "").length)) };
  }
  // ---- wheel and scroll ----
  const wheels = by("wheel"), scrolls = by("scroll", "top");
  if (wheels.length || scrolls.length) {
    const wg: number[] = [];
    for (let i = 1; i < wheels.length; i++) wg.push(wheels[i].t - wheels[i - 1].t);
    const cause = (s: R) => list.some((r) => (r.e === "wheel" || r.e === "keydown") && r.t <= s.t && s.t - r.t < 700);
    out.wheel = { wheels: wheels.length, deltaY: uniq(wheels.map((r) => r.dy)).slice(0, 8), deltaX: uniq(wheels.map((r) => r.dx)).slice(0, 4), deltaMode: uniq(wheels.map((r) => r.dm)),
      wheelDeltaY: uniq(wheels.map((r) => r.wdy)).slice(0, 8), gapMs: { median: r1(median(wg)), range: range(wg) }, scrolls: scrolls.length,
      scrollsWithNoWheelOrKey: scrolls.filter((s) => !cause(s)).length, fractionalDelta: wheels.filter((r) => !isInt(r.dy) || !isInt(r.dx)).length };
  }
  // ---- focus ----
  const fins = by("focusin").filter((r) => /^#(f|ta|cb|chk|sel|file|b)$/.test(r.tg));
  if (fins.length) {
    out.focus = { focusin: fins.map((r) => `${r.f}:${r.tg}`), withNoPress: fins.filter((r) => !list.some((x) => x.e === "pointerdown" && x.f === r.f && x.t <= r.t && r.t - x.t < 1500)
      && !list.some((x) => x.e === "keydown" && x.k === "Tab" && x.t <= r.t && r.t - x.t < 1500)).length };
  }
  const drags = list.filter((r) => /^drag|^drop$/.test(r.e));
  if (drags.length) out.drag = drags.map((r) => r.e).join(" ");
  const ch = by("change");
  if (ch.length) out.change = ch.map((r) => `${r.tg}=${r.v}`);
  const touches = list.filter((r) => r.e.startsWith("touch"));
  if (touches.length) out.touch = touches.length;
  return out;
}

/** The CDP calls of one step (the client's requests, in order), with each call's answer time. */
function traceOf(trace: Trace[], m: Mark) {
  const answers = new Map<number, number>();
  for (const x of trace) if (x.d === "<" && x.id !== undefined) answers.set(x.id, x.t);
  return trace.filter((x) => x.d === ">" && x.t >= m.t0 - 1 && x.t <= m.t1 + 1).map((x) => ({ dt: r1(x.t - m.t0), ms: answers.has(x.id!) ? r1(answers.get(x.id!)! - x.t) : null, m: x.m, s: x.s, p: x.p }));
}
/** The calls as one line: runs of the same call collapsed (Input calls keep their type). */
function callLine(calls: { m?: string; p?: any }[]) {
  const names = calls.map((c) => c.m === "Input.dispatchMouseEvent" || c.m === "Input.dispatchKeyEvent" || c.m === "Input.dispatchDragEvent" ? `${c.m.slice(6)}(${c.p?.type})` : c.m ?? "?");
  const out: string[] = [];
  for (let i = 0; i < names.length;) { let j = i; while (j < names.length && names[j] === names[i]) j++; out.push(j - i > 1 ? `${names[i]} x${j - i}` : names[i]); i = j; }
  return out.join(", ");
}

const summary: Record<string, unknown> = { ...meta, scenarios: {} };
const traces: Record<string, unknown> = {};
for (const [name, sc] of Object.entries(scenarios)) {
  const recs = sc.recs.filter((r) => r.e !== "frames");
  const states = recs.filter((r) => r.e === "state");
  const st = { top: states.find((r) => r.f === "top") ?? null, box: states.find((r) => r.f === "box") ?? null };
  const steps = sc.marks.map((m) => {
    const list = recs.filter((r) => typeof r.t === "number" && r.t >= m.t0 - 50 && r.t <= m.t1 + 650).sort((a, b) => a.t - b.t);
    const calls = traceOf(sc.trace ?? [], m);
    return { name: m.name, ok: m.ok, error: m.error, ms: r1(m.t1 - m.t0), note: m.note, metrics: metrics(list), cdp: calls.length ? callLine(calls) : undefined, calls };
  });
  const frameTimes = sc.recs.filter((r) => r.e === "frames").flatMap((r) => r.list as number[]).sort((a, b) => a - b);
  const fg: number[] = [];
  for (let i = 1; i < frameTimes.length; i++) fg.push(frameTimes[i] - frameTimes[i - 1]);
  (summary.scenarios as Record<string, unknown>)[name] = {
    notes: sc.notes, error: sc.error, frameGapMs: r2(median(fg)),
    state: st, kbdmap: recs.filter((r) => r.e === "kbdmap").map((r) => ({ f: r.f, ok: r.ok, err: r.err, KeyQ: r.KeyQ })),
    io: uniq(recs.filter((r) => r.e === "io").map((r) => ({ hit: r.hit, vis: r.vis, rb: r.rb, err: r.err }))),
    steps: steps.map(({ calls, ...s }) => s),
  };
  traces[name] = steps.filter((s) => s.calls.length).map((s) => ({ name: s.name, calls: s.calls.map((c) => [c.dt, c.ms, c.m, c.s, c.p]) }));
  // ---- the printed table ----
  console.log(`\n### ${name}\n`);
  console.log("| step | ok | moves (before press) | coalesced mean/max | predicted >0 | sample gap ms (whole-ms share) | fractional | press ms | pressure | screen-client | keys: hold / down-to-down ms, overlaps, Shift downs | wheel | CDP calls |");
  console.log("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const s of steps) {
    const P = s.metrics.pointer as any, K = s.metrics.keys as any, W = s.metrics.wheel as any;
    const cells = [s.name, s.ok ? "ok" : `FAIL ${s.error ?? ""}`,
      P ? `${P.moves} (${P.movesBeforePress})` : "", P ? `${P.coalesced.mean}/${P.coalesced.max}` : "", P ? `${P.predicted.over0}` : "",
      P ? `${P.sampleGapMs.median} (${P.sampleGapMs.wholeMs})` : "", P ? `${P.fractional.pointer}/${P.fractional.mouse}` : "",
      P?.pressMs ?? "", P?.down ? `${P.down.pressure}/${P.upPressure}` : "", P?.down ? JSON.stringify(P.down.screenMinusClient) : "",
      K ? `${K.holdMs.median} / ${K.downToDownMs.median}, ${K.overlaps}, ${K.shiftDowns}` : "",
      W ? `${W.wheels} dy ${JSON.stringify(W.deltaY)} dm ${JSON.stringify(W.deltaMode)}; scrolls ${W.scrolls}, no wheel ${W.scrollsWithNoWheelOrKey}` : "",
      s.cdp ? s.cdp.slice(0, 160) : ""];
    console.log(`| ${cells.map((c) => String(c).replace(/\|/g, "\\|")).join(" | ")} |`);
  }
}
if (values.summary) writeFileSync(values.summary, JSON.stringify(summary, null, 1) + "\n");
if (values.traces) writeFileSync(values.traces, JSON.stringify(traces, null, 1) + "\n");
