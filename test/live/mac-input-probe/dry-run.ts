// The Linux dry run of the Mac input probe (board ab-t30.32): probe.ts end to end against agent mode's endpoint of a test
// service of this checkout, so that its one run on the Mac has no surprise. The numbers are Linux's, not the Mac's: on
// Linux the stage rounds the client's point to a whole px and sends the wheel as notches of 120 px.
//
// It runs the real service with `--test` as service-use/check.ts does: the run's temp folders (state, tools, run, lists;
// the profile is in the state folder), the service's pinned agent package, and a copy of the box's Chromium (the tree of
// /usr/bin/chromium, /usr/lib/chromium) in the temp tools folder through the local stand-in of Google's index
// (test/chrome-fixture.ts; nothing is downloaded), on one free display (default 171), under the harness guard
// (test/live/README.md, the two rules). It is the service's "daemon" on the control door with one session (the scope
// probe-1, whose root is this process), asks the control door for the scope's endpoint, runs the probe once as its child
// (--cdp-url, and --out in the temp folder), and checks the probe's JSON: ok, the check of numbers only, the same
// document in the --out file, and each part's events. It prints the JSON, then stops Chrome, Xvfb and the service. The
// probe's connection is the use that starts Chrome.
//
// It never touches another Chrome, Xvfb, profile or folder: it signals only the pids that its run started, and its own
// code removes its temp folder at its end. Run it under the box's heavy lock:
//   flock <heavy.lock> timeout -k 60 600 node test/live/mac-input-probe/dry-run.ts --display 171

import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { GOOGLE_SOURCE, GoogleChromeTools } from "../../../src/service/unit/google-chrome.ts";
import { displayInUse, realDisplayFs } from "../../../src/service/unit/display.ts";
import { makeChromeRepo } from "../../chrome-fixture.ts";
import { harnessGuard, reservedDisplay } from "../guard.ts";
import { checkResult, WHEEL_DELTAS } from "./parts.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const BIN = join(ROOT, "bin", "agent-browser.js");
const PROBE = join(ROOT, "test", "live", "mac-input-probe", "probe.ts");
const CHROMIUM_TREE = "/usr/lib/chromium";
const SCOPE = "probe-1";
const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const display = Number(arg("--display") ?? "171");
const refused = Number.isSafeInteger(display) && display > 0 ? reservedDisplay(display, "--display") : "--display must be a positive whole number";
if (refused) { process.stderr.write(`mac-input-probe dry run: ${refused}\n`); process.exit(2); }
if (displayInUse(display, "/tmp", realDisplayFs(() => readFileSync("/proc/net/unix", "utf8")))) { process.stderr.write(`mac-input-probe dry run: :${display} is in use; the dry run takes a free display only\n`); process.exit(2); }

const t0 = Date.now();
const log = (s: string) => process.stdout.write(`[${((Date.now() - t0) / 1000).toFixed(1)} s] ${s}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: { step: string; ok: boolean }[] = [];
const check = (step: string, ok: boolean, note = "") => { results.push({ step, ok }); log(`${ok ? "PASS" : "FAIL"} ${step}${note ? `: ${note}` : ""}`); if (!ok) throw new Error(`${step} failed${note ? `: ${note}` : ""}`); };

/** The start time (field 22) of a pid, or null. */
function startOf(pid: number): number | null {
  try {
    const st = readFileSync(`/proc/${pid}/stat`, "latin1");
    const f = st.slice(st.lastIndexOf(")") + 2).split(" ");
    return ["Z", "X"].includes(f[0]) ? null : Number(f[19]);
  } catch { return null; }
}

const guard = await harnessGuard("mac-input-probe");
const dir = mkdtempSync(join(tmpdir(), "ab-mac-probe-dry-"));
const run = join(dir, "run"), state = join(dir, "state"), tools = join(dir, "tools"), lists = join(dir, "lists");
mkdirSync(run, { mode: 0o700 });
mkdirSync(lists, { mode: 0o700 });
const started = new Map<number, number>(); // pid -> start time: every process of this run that may need a signal
let service: ChildProcess | null = null;
let serviceErr = "";
let repo: ReturnType<typeof makeChromeRepo> | null = null;

function track(pid: number | null | undefined, name: string): void {
  if (!pid) return;
  const s = startOf(pid);
  if (s !== null) { started.set(pid, s); guard.track(pid, name); }
}

type Door = { s: Socket; lines: any[]; next: (want: (l: any) => boolean, ms?: number) => Promise<any>; send: (o: object) => void };
function door(): Promise<Door> {
  return new Promise((resolve, reject) => {
    const s = connect(join(run, "control.sock"));
    const lines: any[] = [];
    let buf = "";
    const waiters: { want: (l: any) => boolean; done: (l: any) => void }[] = [];
    s.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); lines.push(l); for (const w of [...waiters]) if (w.want(l)) { waiters.splice(waiters.indexOf(w), 1); w.done(l); } } });
    s.on("error", reject);
    s.once("connect", () => resolve({
      s, lines, send: (o) => s.write(JSON.stringify(o) + "\n"),
      next: (want, ms = 30_000) => { const hit = lines.find(want); if (hit) return Promise.resolve(hit); return new Promise((done, fail) => { const w = { want, done: (l: any) => { clearTimeout(t); done(l); } }; waiters.push(w); const t = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); fail(new Error(`no such line in ${ms} ms`)); }, ms); }); },
    }));
  });
}
let n = 0;
const req = async (d: Door, op: string, by: object, fields: object = {}, ms = 30_000) => { const id = `q${++n}`; d.send({ t: "req", id, op, by, ...fields }); return d.next((l) => l.t === "res" && l.id === id, ms); };
const TOKEN = { kind: "token", user: "live", via: "cli" }, DAEMON = { kind: "daemon", user: "live", via: "daemon" };
const SESSION = { scope: SCOPE, repo: "local/test", roots: [{ pid: process.pid, start: startOf(process.pid) }], cgroup: null, lifetime_id: "lt-probe", mcp_token: null };

async function startService(): Promise<Door> {
  service = spawn(process.execPath, [BIN, "service", "--test", "--test-display", String(display), "--agent-door", join(run, "cdp.sock"), "--control-door", join(run, "control.sock"),
    "--daemon-command", join(dir, "daemon-command.json"), "--lists-folder", lists, "--state-folder", state, "--tools-dir", tools, "--test-chrome-source", join(dir, "source.json")], { stdio: ["ignore", "ignore", "pipe"] });
  track(service.pid, "service");
  service.stderr!.on("data", (d) => { serviceErr += d; });
  for (let i = 0; i < 300 && !serviceErr.includes("service: ready"); i++) { if (service.exitCode !== null) break; await sleep(50); }
  if (!serviceErr.includes("service: ready")) throw new Error(`the service did not start: ${serviceErr.slice(-800)}`);
  const d = await door();
  const hello = await d.next((l) => l.t === "hello");
  if (hello.side !== "service") throw new Error("no hello of the service");
  d.send({ t: "hello", v: 1, side: "daemon", version: "live", features: [] });
  const cfg = await req(d, "config", { kind: "daemon", user: "live", via: "config" }, { enabled: true, control: true, chrome_bin: null, chrome_args: [], display_size: "1280x900", idle_stop_minutes: 10 });
  if (!cfg.ok) throw new Error(`config: ${JSON.stringify(cfg)}`);
  // The first complete set_sessions names no session; the session comes in the next one (review-120b F1).
  for (const sessions of [[], [SESSION]]) {
    const ss = await req(d, "set_sessions", DAEMON, { sessions, remote: [], box: { hosts: ["box.localhost"], cookie_names: [] } });
    if (!ss.ok) throw new Error(`set_sessions: ${JSON.stringify(ss)}`);
  }
  return d;
}
async function stopService(): Promise<number | null> {
  const s = service;
  if (!s || s.exitCode !== null) return s?.exitCode ?? null;
  const exited = new Promise<number | null>((r) => s.once("exit", (c) => r(c)));
  s.kill("SIGTERM");
  return Promise.race([exited, sleep(15_000).then(() => { s.kill("SIGKILL"); return -1; })]);
}
/** The Xvfb of the unit record now, or null. */
const recordXvfb = () => { try { return JSON.parse(readFileSync(join(state, "unit.json"), "utf8")).xvfb_pid as number | null; } catch { return null; } };

/** The probe, once, as this process's child (so the session's root admits it): its exit code, stdout and stderr. */
function runProbe(url: string, out: string): Promise<{ code: number | null; stdout: string; stderr: string; ms: number }> {
  return new Promise((resolve) => {
    const at = Date.now();
    const p = spawn(process.execPath, [PROBE, "--cdp-url", url, "--out", out], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    track(p.pid, "probe");
    let stdout = "", stderr = "";
    p.stdout!.on("data", (d) => { stdout += d; });
    p.stderr!.on("data", (d) => { stderr += d; });
    // The probe's own limit is 60 s; this one only catches a probe that does not keep it.
    const t = setTimeout(() => p.kill("SIGKILL"), 90_000);
    p.once("exit", (code) => { clearTimeout(t); resolve({ code, stdout, stderr, ms: Date.now() - at }); });
  });
}

let code = 0;
try {
  // The expected command of this "daemon": its resolved interpreter and its command line from argv[1] on.
  const argv = readFileSync("/proc/self/cmdline", "utf8").split("\0").filter((x, i, a) => i < a.length - 1 || x !== "");
  writeFileSync(join(dir, "daemon-command.json"), JSON.stringify({ v: 1, interpreter: realpathSync(process.execPath), args: argv.slice(1) }), { mode: 0o600 });
  // The stand-in of Google's index: its chrome answers --version and otherwise runs the Chromium binary next to it.
  repo = makeChromeRepo({ version: "158.0.7100.1-1", chrome: `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "Google Chrome 158.0.7100.1 "; exit 0; fi\nexec "$(dirname "$0")/chromium" "$@"\n` });
  writeFileSync(join(dir, "source.json"), JSON.stringify({ repo: repo.repo, key: repo.keyFile, fingerprints: [repo.fingerprint] }));
  chmodSync(dir, 0o700);
  const installer = new GoogleChromeTools({ tools, source: { ...GOOGLE_SOURCE, repo: repo.repo, keyFile: repo.keyFile, fingerprints: [repo.fingerprint] }, log: (l) => log(`installer: ${l}`) });
  const copy = await installer.ensure();
  for (const e of readdirSync(CHROMIUM_TREE)) cpSync(join(CHROMIUM_TREE, e), join(copy.binary, "..", e), { recursive: true, force: true });
  check("the copy of the stand-in Google Chrome in the temp tools folder holds the box's Chromium tree", existsSync(join(copy.binary, "..", "chromium")) && statSync(copy.binary).isFile());
  // The scope's list (the probe opens about:blank only, so no host of it is used).
  writeFileSync(join(lists, "local.test.json"), JSON.stringify({ allow: ["probe.localhost"], repo: "local/test" }), { mode: 0o600 });

  const d = await startService();
  const url = (await req(d, "endpoint", DAEMON, { scope: SCOPE })).data.url as string;
  check("the control door gives the scope's endpoint (agent mode's ws+unix form)", /^ws\+unix:\/\//.test(url));
  // Chrome starts at the probe's connection: its pid comes with ready.
  const ready = d.next((l) => l.t === "ev" && l.ev === "ready", 120_000).then((l) => { track(l.chrome_pid, "chrome"); track(recordXvfb(), "xvfb"); return l; }, () => null);
  const out = join(dir, "probe.json");
  const p = await runProbe(url, out);
  log(`the probe ran ${p.ms} ms, exit ${p.code}${p.stderr.trim() ? `; its stderr: ${p.stderr.trim().slice(0, 400)}` : ""}`);
  log(`the probe's JSON: ${p.stdout.trim()}`);
  check("Chrome started at the probe's use (ready)", !!(await ready));
  let r: any = null;
  try { r = JSON.parse(p.stdout); } catch {}
  check("the probe printed one JSON document with ok true and exit 0", !!r && r.ok === true && p.code === 0, r ? `stage ${r.stage}, reason ${r.reason}` : "no JSON");
  check("the JSON passes the check of numbers only", checkResult(r) === null, String(checkResult(r)));
  check("the --out file holds the same document, mode 0600", existsSync(out) && readFileSync(out, "utf8") === p.stdout && (statSync(out).mode & 0o777) === 0o600);
  check("the run stayed in the time limit of 60 s", r.ms <= 60_000 && p.ms <= 62_000, `${r.ms} ms`);
  check("the platform is the Linux server's, with Chrome's version", r.platform.os === "linux" && /^[0-9]+(\.[0-9]+)+$/.test(r.platform.chrome), r.platform.chrome);
  check("the page was visible and drew frames", r.page.visible === true && r.page.frames === true, JSON.stringify(r.page));
  check("Q1: the page saw trusted pointermoves of the move", r.q1.pointermoves > 0 && r.q1.trusted === r.q1.pointermoves, `${r.q1.pointermoves} pointermoves`);
  // Chrome gives getCoalescedEvents in a secure context only: the result says which page it had.
  check("Q1: the coalesced events are there on a secure page only, and then for each pointermove", r.q1.coalescedApi === (r.page.secure ? r.q1.pointermoves : 0) && (!r.page.secure || r.q1.samples >= r.q1.pointermoves), `secure ${r.page.secure}, ${r.q1.coalescedApi} pointermoves with the API, ${r.q1.samples} samples`);
  check("Q1 on Linux: the stage rounds, so the last point is the asked point rounded (a whole px)", !r.q1.reached && r.q1.last.clientX === Math.round(r.q1.asked.x) && r.q1.last.clientY === Math.round(r.q1.asked.y), JSON.stringify(r.q1.last));
  check("Q3: a path of about 600 px gave at least 30 sample gaps, and the page's frames during it", r.q3.chordPx >= 300 && r.q3.sampleGapsMs.count >= 30 && r.q3.frames > 10 && r.q3.fromCoalesced === r.page.secure,
    `${r.q3.chordPx} px, ${r.q3.sampleGapsMs.count} gaps (from the coalesced events: ${r.q3.fromCoalesced}), median ${r.q3.sampleGapsMs.median} ms; ${r.q3.frames} frames, median gap ${r.q3.framesMs.median} ms`);
  check("Q2: one entry for each wheel call", r.q2.calls.length === WHEEL_DELTAS.length && r.q2.calls.every((c: any, i: number) => c.deltaY === WHEEL_DELTAS[i]));
  // Linux's notches (src/human/wheel.ts): a call of a small delta with no residual gets one notch, and the residual of
  // that notch (-107 px) takes the next call's 120 px; so the two calls give one notch of 120 px in all, at the first.
  check("Q2 on Linux: the two calls give one notch of 120 px (deltaMode 0), at the first call", r.q2.calls[0].events === 1 && r.q2.calls[0].deltaYSum === 120 && r.q2.calls[0].deltaModes[0] === 0 && r.q2.calls[1].events === 0, JSON.stringify(r.q2.calls.map((c: any) => [c.deltaY, c.events, c.wheelDeltaYs])));
  check("the probe closed its tab", r.tabClosed === true);
  check("the probe's JSON names no path, socket or scope of the run", ![dir, run, ROOT, SCOPE, "cdp.sock", "about:blank"].some((x) => p.stdout.includes(x)));

  // The stops: a scope with no session (the endpoint's 503), and --out inside a git checkout (this one).
  const none = url.replace(/[^/]+$/, "probe-0");
  const s1 = await runProbe(none, join(dir, "stop.json"));
  let j1: any = null;
  try { j1 = JSON.parse(s1.stdout); } catch {}
  check("a scope with no session: the probe stops at once with ok false, stage connect and the endpoint's HTTP code, and exit 1",
    !!j1 && j1.ok === false && j1.stage === "connect" && j1.reason === "the endpoint is not ready" && typeof j1.code === "number" && s1.code === 1 && j1.tabClosed === null, s1.stdout.trim());
  check("its stop passes the check of numbers only, names no path or scope, and goes into the --out file too",
    checkResult(j1) === null && ![dir, run, ROOT, "probe-0", "cdp.sock"].some((x) => s1.stdout.includes(x)) && readFileSync(join(dir, "stop.json"), "utf8") === s1.stdout);
  const s2 = await runProbe(url, join(ROOT, "mac-input-probe-dry-run.json"));
  let j2: any = null;
  try { j2 = JSON.parse(s2.stdout); } catch {}
  check("--out inside a git checkout: refused before any connection, exit 2, and no file",
    !!j2 && j2.ok === false && j2.stage === "out" && s2.code === 2 && !existsSync(join(ROOT, "mac-input-probe-dry-run.json")) && checkResult(j2) === null, s2.stdout.trim());

  const b = await req(d, "stop", TOKEN, {}, 30_000);
  await d.next((l) => l.t === "ev" && l.ev === "stopped", 30_000);
  check("stop: Chrome and Xvfb end", b.ok === true);
  d.s.end();
  check("the service's stop", (await stopService()) === 0);
} catch (e) {
  code = 1;
  log(`FAIL: ${(e as Error).message}`);
  if (serviceErr) log(`the service's log (end):\n${serviceErr.slice(-3000)}`);
} finally {
  await stopService();
  // Only the pids that this run started, with their recorded start times: SIGTERM, then SIGKILL.
  for (const sig of ["SIGTERM", "SIGKILL"] as const) {
    for (const [pid, start] of started) if (startOf(pid) === start) { try { process.kill(pid, sig); } catch {} }
    await sleep(2000);
  }
  const leftover = [...started].filter(([pid, start]) => startOf(pid) === start).map(([pid]) => pid);
  repo?.close();
  rmSync(dir, { recursive: true, force: true });
  log(`cleanup: ${leftover.length ? `still running: ${leftover.join(", ")}` : "no process of this run runs"}; the temp folder is ${existsSync(dir) ? "still there" : "removed"}`);
  if (leftover.length) code = 1;
  process.stdout.write(`${JSON.stringify({ passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length + (code && results.every((r) => r.ok) ? 1 : 0), seconds: Math.round((Date.now() - t0) / 1000) })}\n`);
  process.exit(code);
}
