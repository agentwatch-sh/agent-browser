// The tables of the anti-detect drive measurement, from run.ts's results.json (ab-v16.21). Not part of `npm test`.
//
//   node test/live/anti-detect/report.ts DIR/run-XXXXXX/results.json [more results.json ...]
//
// With several files (several runs), each cell lists the values of every run, separated by "/".

import { readFileSync } from "node:fs";

type StepOut = Record<string, any> & { name: string; ok: boolean; ms: number };
type ScOut = Record<string, any> & { name: string; steps: StepOut[] };

const fmtFocus = (v: unknown) => (v === true ? "yes" : v === false ? "no" : "?");
const find = (sc: ScOut, prefix: string) => sc.steps.find((s) => s.name.startsWith(prefix));
const input = ["click", "type", "library", "press End"];

/** One row of the state table: what the page T showed while idle and while it was driven. */
function stateRow(sc: ScOut): Record<string, string> {
  if (!sc.steps.length) return { scenario: sc.name, note: sc.notes.join("; ") };
  const ib = sc.idleBefore ?? {}, ia = sc.idleAfter ?? {};
  const driven = sc.steps.filter((s) => !s.name.startsWith("idle") && !s.name.startsWith("disconnect"));
  // "all": the page was visible before the step and stayed so (a window); else its visible ms in the step and the 200 ms after.
  const spans = (names: string[]) => names.map((n) => { const s = find(sc, n); return !s ? "-" : s.visBefore === "visible" && !s.visChanges.length ? "all" : `${s.visibleMs}`; }).join(", ");
  const focusEv = driven.flatMap((s) => s.focusEvents as string[]).map((e) => e.split("@")[0]);
  const count = (k: string) => focusEv.filter((e) => e === k).length;
  return {
    scenario: sc.name,
    idle: `${ib.vis ?? "?"} ${ib.fps ?? "?"} fps ${ib.tps ?? "?"} tps, focus ${fmtFocus(ib.focus)}`,
    "visible ms (text, click, type, library, End, shot, record)": spans(["text", "click", "type", "library", "press End", "shot", "record"]),
    "T: vis changes / focus / blur": `${driven.reduce((n, s) => n + s.visChanges.length, 0)} / ${count("focus")} / ${count("blur")}`,
    "actions while hidden / unfocused": `${driven.reduce((n, s) => n + s.inputHidden, 0)} / ${driven.reduce((n, s) => n + s.inputUnfocused, 0)}`,
    "after: vis, focus, fps, tps": `${ia.vis ?? "?"}, ${fmtFocus(ia.focus)}, ${ia.fps ?? "?"}, ${ia.tps ?? "?"}`,
    "F saw": (sc.fEvents as string[]).length ? summarize(sc.fEvents as string[]) : "nothing",
    "F and T focused, before record (ms)": String(sc.bothFocusedMs),
  };
}

/** One row of the breakage table: what worked. */
function workRow(sc: ScOut): Record<string, string> {
  if (!sc.steps.length) return { scenario: sc.name };
  const cell = (prefix: string) => { const s = find(sc, prefix); return !s ? "-" : s.ok ? `ok ${s.ms} ms` : `FAIL (${String(s.error).slice(0, 60)})`; };
  return {
    scenario: sc.name,
    text: cell("text"), click: cell("click"), type: cell("type"), "library (frame content)": cell("library") + (sc.rafContent ? "" : ", no frame content"),
    "End: lazy image": sc.lazyRequestMs === null ? "not loaded" : `${sc.lazyRequestMs} ms`,
    "End: IntersectionObserver": ((sc.io as string[]).find((e) => e.startsWith("in@")) ?? "no callback").replace("in@", "") + ((sc.io as string[]).some((e) => e.startsWith("in@")) ? " ms" : ""),
    shot: cell("shot"), record: cell("record"),
  };
}

/** One row of the input table: the click's and the typing's events. */
function inputRow(sc: ScOut): Record<string, string> {
  const c = find(sc, "click"), t = find(sc, "type");
  if (!c) return { scenario: sc.name };
  return {
    scenario: sc.name,
    "moves before the press (with movement)": `${c.moves} (${c.movesWithMovement})`,
    "screen - client at the press": JSON.stringify(c.screenMinusClient ?? null),
    pressure: String(c.pressure ?? "-"), "press ms": String(c.downUpMs ?? "-"),
    "type: keydowns for 5 chars, inputType": t ? `${t.keydowns}, ${t.inputTypes || "-"}` : "-",
    untrusted: String(sc.steps.reduce((n, s) => n + s.untrusted, 0)),
  };
}

function summarize(events: string[]): string {
  const out: string[] = [];
  let last = "", n = 0;
  const flush = () => { if (last) out.push(n > 1 ? `${last} x${n}` : last); };
  for (const e of events) { if (e === last) { n++; continue; } flush(); last = e; n = 1; }
  flush();
  return out.join(", ");
}

function merge(rows: Record<string, string>[][]): Record<string, string>[] {
  const first = rows[0];
  return first.map((r, i) => Object.fromEntries(Object.keys(r).map((k) => [k, k === "scenario" ? r[k] : [...new Set(rows.map((rs) => rs[i]?.[k] ?? "?"))].join(" / ")])));
}

function table(rows: Record<string, string>[]): string {
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return [`| ${keys.join(" | ")} |`, `| ${keys.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${keys.map((k) => (r[k] ?? "").replace(/\|/g, "/")).join(" | ")} |`)].join("\n");
}

export function report(runs: { summary: ScOut[] }[]): string {
  const names = runs[0].summary.map((s) => s.name);
  const pick = (f: (sc: ScOut) => Record<string, string>) => merge(runs.map((r) => names.map((n) => { const sc = r.summary.find((s) => s.name === n); return sc ? f(sc) : { scenario: n }; })));
  return [`### What the driven page T showed`, table(pick(stateRow)), "", `### What worked`, table(pick(workRow)), "", `### The input events of the click and the typing`, table(pick(inputRow)), ""].join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = process.argv.slice(2);
  if (!files.length) { process.stderr.write("usage: node test/live/anti-detect/report.ts results.json [...]\n"); process.exit(2); }
  process.stdout.write(report(files.map((f) => JSON.parse(readFileSync(f, "utf8")))));
}
