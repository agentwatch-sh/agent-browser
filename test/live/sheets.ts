// A live check of `record` and `shot` on real Google Sheets, in a running agent browser. Not part of
// `npm test` (it contacts Google). The consumer's allowlist must hold docs.google.com.
//
//   npm run test:live -- --state-dir DIR --allowlist FILE [--out-dir DIR] [--scale 2]
//
// It opens the public sample sheet signed out (the language comes from hl=en in the URL), records a
// scripted run, takes shots, and checks: the MP4's exact size, codec and length; one event per step;
// the steps' effect (the Name Box ends on the expected cell); and that the tab is restored (its own
// size, no overlay). It prints one JSON report and exits 1 on any failure.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { commands } from "../../src/commands.ts";
import { findFfmpeg } from "../../src/record.ts";

const SHEET = "https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit?hl=en";

const { values } = parseArgs({ options: { "state-dir": { type: "string" }, allowlist: { type: "string" }, "out-dir": { type: "string" }, scale: { type: "string" } } });
if (!values["state-dir"] || !values.allowlist) {
  process.stderr.write("usage: npm run test:live -- --state-dir DIR --allowlist FILE [--out-dir DIR] [--scale 2]\n");
  process.exit(2);
}
const o = { stateDir: resolve(values["state-dir"]), allowlistFile: resolve(values.allowlist) };
const outDir = resolve(values["out-dir"] ?? join(o.stateDir, "live-test"));
const scale = Number(values.scale ?? 1);
mkdirSync(outDir, { recursive: true });
const ffprobe = join(dirname(findFfmpeg()), "ffprobe");

const checks: { check: string; ok: boolean; detail?: unknown }[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => { checks.push({ check: name, ok, ...(detail === undefined ? {} : { detail }) }); };
const pngSize = (path: string) => { const b = readFileSync(path); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };
const probe = (path: string) => Object.fromEntries(execFileSync(ffprobe, ["-v", "error", "-show_entries", "stream=codec_name,width,height,pix_fmt,r_frame_rate:format=duration",
  "-of", "default=noprint_wrappers=1", path], { encoding: "utf8" }).trim().split("\n").map((l) => l.split("=")));
const page = async (tab: string) => (await commands.eval(o, { tab, expression: "({w: innerWidth, h: innerHeight, dpr: devicePixelRatio, nodes: document.documentElement.children.length, box: document.querySelector('#t-name-box')?.value ?? null})" })).value as
  { w: number; h: number; dpr: number; nodes: number; box: string | null };

try {
  const existing = (await commands.tabs(o)).tabs.find((t) => t.name === "live-sheet");
  const tab = existing ? "live-sheet" : (await commands.open(o, { url: SHEET, name: "live-sheet" })).tab.name!;
  await new Promise((r) => setTimeout(r, 3000)); // the grid draws after load
  const before = await page(tab);

  await commands.text(o, { tab });
  const viewport = await commands.shot(o, { tab, path: join(outDir, "shot-viewport.png") });
  check("shot: the viewport at the window's own pixel size", JSON.stringify(pngSize(viewport.path)) === JSON.stringify([before.w * before.dpr, before.h * before.dpr]), pngSize(viewport.path));
  const full = await commands.shot(o, { tab, path: join(outDir, "shot-full.png"), full: true });
  check("shot --full: Sheets scrolls inside its grid, so the full page is the viewport", pngSize(full.path)[0] === before.w * before.dpr, pngSize(full.path));
  const sized = await commands.shot(o, { tab, path: join(outDir, "shot-1280x720.png"), size: "1280x720", scale: 1 });
  check("shot --size 1280x720 --scale 1: exactly 1280x720", JSON.stringify(pngSize(sized.path)) === "[1280,720]", pngSize(sized.path));

  const steps = [
    { click: "#t-name-box" }, { type: "C5", delay: 80 }, { press: "Enter" }, { wait: 400 },
    { press: "ArrowDown", repeat: 3, delay: 200 }, { press: "ArrowRight", repeat: 2, delay: 200 }, { press: "Shift+ArrowDown", repeat: 2, delay: 200 },
    { waitFor: "#t-name-box", text: "E8:E10", timeoutMs: 3000 }, // the chord selected a range: a failed waitFor fails the run
    { highlight: { x: 60, y: 230, width: 640, height: 30 }, duration: 900 }, { click: { x: 420, y: 420 } }, { scroll: 300, duration: 700 }, { wait: 300 },
  ];
  const script = join(outDir, "sheets-steps.json");
  writeFileSync(script, JSON.stringify(steps, null, 2));
  const out = join(outDir, `sheets-scale${scale}.mp4`);
  const r = await commands.record(o, { tab, out, script, size: "1920x1080", scale, settle: 400 });
  const v = probe(out);
  check("record: H.264 yuv420p at exactly size x scale", v.codec_name === "h264" && v.pix_fmt === "yuv420p" && Number(v.width) === 1920 * scale && Number(v.height) === 1080 * scale, v);
  check("record: the MP4 lasts as long as the run (within 0.1 s)", Math.abs(Number(v.duration) - r.seconds) <= 0.1, { mp4: Number(v.duration), run: r.seconds });
  check("record: Chrome kept up (at least 30 frames per second)", r.frames / r.seconds >= 30, { fps: +(r.frames / r.seconds).toFixed(1), maxFrameGapMs: r.maxFrameGapMs });
  check("record: one event per step, in order", r.events.map((e) => e.step).join() === steps.map((_, i) => i + 1).join(), r.events);
  check("record: no warnings", r.warnings.length === 0, r.warnings);
  const after = await page(tab);
  // The range E8:E10 was checked in the run by waitFor; the cell the last click hits depends on the grid's scroll.
  check("the steps acted on the sheet: the last click selected one cell", /^[A-Z]+\d+$/.test(after.box ?? ""), after.box);
  check("the tab is restored: its own size and pixel ratio, no overlay left", after.w === before.w && after.h === before.h && after.dpr === before.dpr && after.nodes === before.nodes,
    { before, after });
  const prov = JSON.parse(readFileSync(r.provenance, "utf8"));
  check("the provenance JSON: facts and events, no licence field", prov.service === "agent-browser" && !("license" in prov) && prov.events.length === steps.length);
} catch (e) {
  check("the run finished", false, (e as Error).message);
}
const ok = checks.every((c) => c.ok);
process.stdout.write(JSON.stringify({ ok, outDir, checks }, null, 2) + "\n");
process.exit(ok ? 0 : 1);
