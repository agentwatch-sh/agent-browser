// The Mac check's dry runs on Linux (mac.ts --dry-run), one after the other, each with its own run folder and display
// (review-69c N9: the procedures that a reviewer runs). Each case is one dry run; after it ends, ps must show no
// process whose command line names its run folder, and any that is left (an orphan Xvfb or Chromium) is stopped by its
// pid and named. The kill-9 case kills the check's node process with SIGKILL after KILL_AFTER_MS, then stops what it
// left, by recorded pids only: the agent Chromium (its pid from stop-chrome.txt, when ps shows it on the run's own
// profile), then it waits for agent-browser's give-back watcher to end with that Chromium, then the run's Xvfb (ps shows
// it with the run's own Xauthority). It never touches another program's process or display.
//
//   node test/live/anti-detect/mac-dry.ts --out-dir DIR [--display 211] [CASE ...]
//     (under the box's shared heavy-job lock, if it has one, around the whole job)
//
// CASE (default all, in this order): plain, key (a key 20 s in), gap (a key between the two parts: the stable part's
// stand-in gives a key at the middle of the gap, so it is shorter than the gap for any gap), refuse (a HID
// reading of 0), front-stop (a key while front reads ps: no front request after it), front-request-stop (a key while
// front's osascript starts: its request is out; the front step still asks for the front back, and front's hold goes:
// review-69d B1), popup-stop (a key 450 ms into
// the click on the target=_blank link: no press after it), kill9. Each case gets the display N, N+1 (its stable part).
// It prints one line per case and writes DIR/dry-runs.json.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const KILL_AFTER_MS = 25_000;
const CASES: Record<string, Record<string, string>> = {
  plain: {},
  key: { MAC_STANDIN_INPUT_MS: "20000" },
  gap: { MAC_STANDIN_STABLE_HID: "keyDown=in-gap" },
  refuse: { MAC_STANDIN_HID: "keyDown=0" },
  "front-stop": { MAC_DRY_STOP_IN: "front: " },
  "front-request-stop": { MAC_DRY_STOP_IN: "front-request" },
  "popup-stop": { MAC_DRY_STOP_IN: "popup: a link with target=_blank", MAC_DRY_STOP_AFTER_MS: "450" },
  kill9: {},
};
const { values, positionals } = parseArgs({ options: { "out-dir": { type: "string" }, display: { type: "string" } }, allowPositionals: true });
if (process.platform !== "linux" || !values["out-dir"]) { process.stderr.write("usage (Linux): node test/live/anti-detect/mac-dry.ts --out-dir DIR [--display N] [CASE ...]\n"); process.exit(2); }
const OUT = resolve(values["out-dir"]), first = Number(values.display ?? 211);
const names = positionals.length ? positionals : Object.keys(CASES);
for (const n of names) if (!(n in CASES)) { process.stderr.write(`unknown case ${n}: ${Object.keys(CASES).join(", ")}\n`); process.exit(2); }
mkdirSync(OUT, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The processes whose command line names `dir` (pid and command), from ps; never this process. */
const named = (dir: string) => execFileSync("ps", ["axww", "-o", "pid=,command="], { encoding: "utf8" }).split("\n").flatMap((l) => {
  const m = /^\s*(\d+) (.*)$/.exec(l);
  return m && m[2].includes(`${dir}/`) && Number(m[1]) !== process.pid ? [{ pid: Number(m[1]), command: m[2] }] : [];
});
const term = (pid: number) => { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } };
const results: Record<string, unknown>[] = [];
for (const [i, name] of names.entries()) {
  const dir = join(OUT, name), display = first + 2 * i;
  mkdirSync(dir, { recursive: true });
  const t0 = Date.now();
  const child = spawn(process.execPath, [join(HERE, "mac.ts"), "--dry-run", "--out-dir", dir, "--display", String(display)],
    { env: { ...process.env, ...CASES[name] }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  child.stdout!.on("data", (b) => { out += b; });
  child.stderr!.on("data", (b) => { err += b; });
  const ended = new Promise<number | null>((r) => child.once("exit", (c) => r(c)));
  const r: Record<string, unknown> = { case: name, display };
  if (name === "kill9") {
    await Promise.race([ended, sleep(KILL_AFTER_MS)]);
    child.kill("SIGKILL");
    await ended;
    await sleep(3000);
    r.leftAfterKill = named(dir).map((p) => p.command.slice(0, 80));
    const run = readdirSync(dir).filter((n) => n.startsWith("run-")).map((n) => join(dir, n))[0];
    const help = run && existsSync(join(run, "stop-chrome.txt")) ? readFileSync(join(run, "stop-chrome.txt"), "utf8") : "";
    const chrome = Number(/then run `kill (\d+)`/.exec(help)?.[1] ?? 0);
    let cmd = "";
    try { cmd = chrome ? execFileSync("ps", ["-ww", "-o", "command=", "-p", String(chrome)], { encoding: "utf8" }) : ""; } catch { cmd = ""; }
    if (chrome && cmd.includes(`--user-data-dir=${run}/state/profile`)) { term(chrome); r.chromeStopped = chrome; }
    const launches = run ? join(run, "state", "launches.log") : "";
    for (let k = 0; k < 40 && !(existsSync(launches) && /watch-back end=\S+ by=node/.test(readFileSync(launches, "utf8"))); k++) await sleep(100);
    r.watcher = existsSync(launches) ? readFileSync(launches, "utf8").split("\n").filter((l) => l.includes("watch-back")) : [];
    for (const p of named(dir)) if (p.command.startsWith(`Xvfb :${display} -auth ${run}/Xauthority`)) { term(p.pid); r.xvfbStopped = p.pid; }
    await sleep(1000);
  } else {
    const timer = setTimeout(() => child.kill("SIGTERM"), 600_000);
    r.exit = await ended;
    clearTimeout(timer);
    await sleep(2000);
  }
  r.seconds = Math.round((Date.now() - t0) / 1000);
  const left = named(dir);
  for (const p of left) term(p.pid);
  r.left = left.map((p) => `${p.pid} ${p.command.slice(0, 80)}`);
  r.result = /## Result: [^\n]*/.exec(out)?.[0] ?? null;
  r.stops = err.split("\n").filter((l) => / STOP |refusing|stopped/.test(l)).slice(0, 4);
  r.after = /after the stop: [^\n]*/.exec(out)?.[0] ?? null;
  r.watchEnds = [...out.matchAll(/Its end: [^\n]*/g)].map((m) => m[0]);
  writeFileSync(join(dir, "dry.out"), out);
  writeFileSync(join(dir, "dry.err"), err);
  results.push(r);
  process.stdout.write(`${JSON.stringify(r)}\n`);
}
writeFileSync(join(OUT, "dry-runs.json"), `${JSON.stringify(results, null, 1)}\n`);
