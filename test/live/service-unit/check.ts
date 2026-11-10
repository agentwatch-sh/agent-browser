// The live check of the Chrome unit inside `agent-browser service` (board ab-v16.94.3, stage 1b part 1 of the
// self-contained agent browser). It runs the real service with `--test` (the service owns with no systemd unit), in temp
// folders only, on one display, under the harness guard (test/live/README.md), and it is the service's "daemon" on the
// control door (the MainPID of `--test` is the service's parent: this process, with its own expected command file):
//
//   1. config, then start: the service installs Google Chrome from a local stand-in of Google's signed index
//      (test/chrome-fixture.ts: a test key in a temp GNUPGHOME, the box's gpgv and xz; nothing is downloaded), and
//      starts Xvfb and Chrome on the display. The stand-in's chrome answers --version and runs the box's Chromium.
//   2. a crash of Chrome (SIGKILL to the pid that this run's service started, checked by its start time): the
//      supervisor starts it again;
//   3. a restart of the service: Chrome and Xvfb stay, and the new service adopts them;
//   4. the fail-closed watch: with no receiver (stage 1b part 1) it stops Chrome 60 s after its first check of this
//      Chrome, also across the restart (build note 5);
//   5. start and stop (with its `by`); then start, a stop of the service, and `service stop --all`.
//
// It never touches another Chrome, Xvfb, profile or folder: it signals only the pids that its service started, and
// its own code removes its temp folder at its end. Run it under the box's heavy lock:
//   flock <heavy.lock> timeout 1500 node test/live/service-unit/check.ts --display 173

import { spawn, type ChildProcess } from "node:child_process";
import { connect, type Socket } from "node:net";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { harnessGuard, reservedDisplay } from "../guard.ts";
import { makeChromeRepo } from "../../chrome-fixture.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const BIN = join(ROOT, "bin", "agent-browser.js");
const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const display = Number(arg("--display") ?? "173");
const refused = reservedDisplay(display, "--display") ?? (display === 169 ? "--display names :169, another harness's display" : null);
if (!Number.isSafeInteger(display) || refused) { process.stderr.write(`service-unit: ${refused ?? "--display must be a number"}\n`); process.exit(2); }
if (existsSync(`/tmp/.X11-unix/X${display}`) || existsSync(`/tmp/.X${display}-lock`)) { process.stderr.write(`service-unit: :${display} is in use; this check runs on a free display only\n`); process.exit(2); }

const t0 = Date.now();
const log = (s: string) => process.stdout.write(`[${((Date.now() - t0) / 1000).toFixed(1)} s] ${s}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: { step: string; ok: boolean; note: string }[] = [];
const check = (step: string, ok: boolean, note = "") => { results.push({ step, ok, note }); log(`${ok ? "PASS" : "FAIL"} ${step}${note ? `: ${note}` : ""}`); if (!ok) throw new Error(`${step} failed${note ? `: ${note}` : ""}`); };

/** The start time (field 22) and the command line of a pid, or null. */
function proc(pid: number): { start: number; argv: string[] } | null {
  try {
    const st = readFileSync(`/proc/${pid}/stat`, "latin1");
    const f = st.slice(st.lastIndexOf(")") + 2).split(" ");
    if (["Z", "X"].includes(f[0])) return null;
    return { start: Number(f[19]), argv: readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean) };
  } catch { return null; }
}

const guard = await harnessGuard("service-unit");
const dir = mkdtempSync(join(tmpdir(), "ab-svc-live-"));
const run = join(dir, "run"), state = join(dir, "state"), tools = join(dir, "tools");
mkdirSync(run, { mode: 0o700 });
const started = new Map<number, number>(); // pid -> start time: every process of this run that may need a signal
let service: ChildProcess | null = null;
let serviceErr = "";
let repo: ReturnType<typeof makeChromeRepo> | null = null;

/** The control door's client: this process is the MainPID of --test. */
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
      next: (want, ms = 30_000) => { const hit = lines.find(want); if (hit) return Promise.resolve(hit); return new Promise((done, fail) => { const w = { want, done: (l: any) => { clearTimeout(t); done(l); } }; waiters.push(w); const t = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); fail(new Error(`no such line in ${ms} ms: ${JSON.stringify(lines.slice(-5))}`)); }, ms); }); },
    }));
  });
}
let n = 0;
const req = async (d: Door, op: string, by: object, fields: object = {}, ms = 30_000) => { const id = `q${++n}`; d.send({ t: "req", id, op, by, ...fields }); return d.next((l) => l.t === "res" && l.id === id, ms); };
const TOKEN = { kind: "token", user: "live", via: "cli" }, WEB = { kind: "operator", user: "live", via: "web" }, DAEMON = { kind: "daemon", user: "live", via: "daemon" };

async function startService(): Promise<Door> {
  serviceErr = "";
  service = spawn(process.execPath, [BIN, "service", "--test", "--test-display", String(display), "--agent-door", join(run, "cdp.sock"), "--control-door", join(run, "control.sock"),
    "--daemon-command", join(dir, "daemon-command.json"), "--browser-state", state, "--tools-dir", tools, "--test-chrome-source", join(dir, "source.json")], { stdio: ["ignore", "ignore", "pipe"] });
  guard.track(service.pid, "service");
  started.set(service.pid!, proc(service.pid!)?.start ?? -1);
  service.stderr!.on("data", (d) => { serviceErr += d; });
  for (let i = 0; i < 300 && !serviceErr.includes("service: ready"); i++) { if (service.exitCode !== null) break; await sleep(50); }
  if (!serviceErr.includes("service: ready")) throw new Error(`the service did not start: ${serviceErr.slice(-800)}`);
  const d = await door();
  const hello = await d.next((l) => l.t === "hello");
  if (hello.side !== "service") throw new Error(`no hello: ${JSON.stringify(d.lines)}`);
  d.send({ t: "hello", v: 1, side: "daemon", version: "live", features: [] });
  const cfg = await req(d, "config", { kind: "daemon", user: "live", via: "config" }, { enabled: true, control: true, chrome_bin: null, chrome_args: [], display_size: "1280x900" });
  if (!cfg.ok) throw new Error(`config: ${JSON.stringify(cfg)}`);
  return d;
}
async function stopService(): Promise<number | null> {
  const s = service;
  if (!s || s.exitCode !== null) return s?.exitCode ?? null;
  const exited = new Promise<number | null>((r) => s.once("exit", (c) => r(c)));
  s.kill("SIGTERM");
  return Promise.race([exited, sleep(15_000).then(() => { s.kill("SIGKILL"); return -1; })]);
}
/** Track the Chrome and the Xvfb that the service runs now, for the guard and the cleanup. */
function trackUnit(pid: number | null): void {
  if (!pid) return;
  const p = proc(pid);
  if (p) { started.set(pid, p.start); guard.track(pid, "chrome"); }
  const rec = JSON.parse(readFileSync(join(state, "unit.json"), "utf8"));
  if (rec.xvfb_pid && proc(rec.xvfb_pid)) { started.set(rec.xvfb_pid, proc(rec.xvfb_pid)!.start); guard.track(rec.xvfb_pid, "xvfb"); }
}

let code = 0;
try {
  // The expected command of this "daemon": its resolved interpreter and its command line from argv[1] on.
  const argv = readFileSync("/proc/self/cmdline", "utf8").split("\0").filter((x, i, a) => i < a.length - 1 || x !== "");
  writeFileSync(join(dir, "daemon-command.json"), JSON.stringify({ v: 1, interpreter: realpathSync(process.execPath), args: argv.slice(1) }), { mode: 0o600 });
  // The stand-in of Google's index: its chrome answers --version and otherwise runs the box's Chromium.
  repo = makeChromeRepo({ version: "158.0.7100.1-1", chrome: `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "Google Chrome 158.0.7100.1 "; exit 0; fi\nexec /usr/bin/chromium "$@"\n` });
  writeFileSync(join(dir, "source.json"), JSON.stringify({ repo: repo.repo, key: repo.keyFile, fingerprints: [repo.fingerprint] }));
  chmodSync(dir, 0o700);

  // 1. config, set_sessions, start: the install from the stand-in, then Xvfb and Chrome.
  let d = await startService();
  check("the service starts in --test mode and admits this process on its control door", true, serviceErr.match(/control: connection 1 admitted.*/)?.[0] ?? "");
  await req(d, "set_sessions", DAEMON, { sessions: [], remote: [], box: { hosts: [], cookie_names: [] } });
  const a1 = await req(d, "start", TOKEN, {}, 120_000);
  check("start answers ok", a1.ok === true, JSON.stringify(a1));
  const ready1 = await d.next((l) => l.t === "ev" && l.ev === "ready");
  const s1 = (await req(d, "status", DAEMON)).data;
  check("status after the start: ready, google-chrome 158.0.7100.1-1 from the tools folder", s1.state === "ready" && s1.chrome_kind === "google-chrome" && s1.chrome_version === "158.0.7100.1-1" && s1.chrome_pid === ready1.chrome_pid, JSON.stringify({ state: s1.state, kind: s1.chrome_kind, version: s1.chrome_version, pid: s1.chrome_pid, update: s1.update }));
  const p1 = s1.chrome_pid as number;
  trackUnit(p1);
  const rec1 = JSON.parse(readFileSync(join(state, "unit.json"), "utf8"));
  const x1 = proc(rec1.xvfb_pid)!;
  check("Xvfb on the display with -nolisten tcp and the state folder's auth file", x1 && x1.argv.join(" ") === `/usr/bin/Xvfb :${display} -nolisten tcp -auth ${join(state, "xauth")} -screen 0 1280x900x24`, x1?.argv.join(" "));
  const c1 = proc(p1)!;
  check("Chrome on the temp profile, with no remote debugging, automation or headless switch", c1.argv.includes(`--user-data-dir=${join(state, "profile")}`) && !c1.argv.some((a) => /remote-debugging|enable-automation|headless/.test(a)), c1.argv.slice(0, 4).join(" "));
  check("the unit record: wanted, the pids and start times, the kind and version", rec1.wanted === true && rec1.chrome_pid === p1 && rec1.chrome_start === c1.start && rec1.xvfb_start === x1.start && rec1.display === display && rec1.chrome.kind === "google-chrome");
  const sess = Number(readFileSync(`/proc/${p1}/stat`, "latin1").split(") ")[1].split(" ")[3]);
  check("Chrome runs detached in its own session", sess === p1, `session ${sess}`);
  check("the tools copy is in the temp tools folder", existsSync(join(tools, "google-chrome", "158.0.7100.1-1", "opt", "google", "chrome", "chrome")));

  // 2. a crash of Chrome: the supervisor starts it again.
  const tCrash = Date.now();
  if (proc(p1)?.start !== started.get(p1)) throw new Error("the Chrome pid changed before the crash");
  process.kill(p1, "SIGKILL");
  const ready2 = await d.next((l) => l.t === "ev" && l.ev === "ready" && l.chrome_pid !== p1, 30_000);
  const p2 = ready2.chrome_pid as number;
  trackUnit(p2);
  const tRestarted = Date.now();
  check("the supervisor starts a crashed Chrome again (one 5 s check and the 1 s backoff)", !!proc(p2) && tRestarted - tCrash < 12_000, `pid ${p1} -> ${p2} in ${((tRestarted - tCrash) / 1000).toFixed(1)} s`);
  check("the same Xvfb", proc(rec1.xvfb_pid)?.start === x1.start);

  // 3. a restart of the service: Chrome and Xvfb stay, the new one adopts them.
  d.s.end();
  const exit1 = await stopService();
  check("the service stops at SIGTERM (exit 0) and Chrome and Xvfb stay", exit1 === 0 && !!proc(p2) && !!proc(rec1.xvfb_pid), `exit ${exit1}`);
  await sleep(1000);
  d = await startService();
  const s3 = (await req(d, "status", DAEMON)).data;
  check("the new service adopts the Chrome and the Xvfb of the unit record", s3.state === "ready" && s3.chrome_pid === p2 && /unit: adopted Xvfb :\d+ \(pid \d+\) and Google Chrome \(pid \d+\)/.test(serviceErr), serviceErr.match(/unit: adopted.*/)?.[0] ?? serviceErr.slice(-300));

  // 4. the fail-closed watch: no receiver in stage 1b part 1; its count of this Chrome goes on across the restart.
  const ev = await d.next((l) => l.t === "ev" && l.ev === "stopped", 75_000);
  const tStop = Date.now();
  const since = (tStop - tRestarted) / 1000;
  check("the watch stops Chrome with receiver_missing about 60 s after its first check of this Chrome, across the restart (build note 5)", ev.reason === "receiver_missing" && since >= 55 && since <= 68, `${since.toFixed(1)} s after the supervisor's restart; the service restarted ${((tStop - tRestarted) / 1000 - 60).toFixed(1)} s into the count`);
  const s4 = (await req(d, "status", DAEMON)).data;
  check("status: failed closed, last_stop receiver_missing with no by", s4.state === "failed closed" && s4.last_stop?.reason === "receiver_missing" && s4.last_stop.by === null && !proc(p2), JSON.stringify(s4.last_stop));

  // 5. start and stop with its by; start, the service's stop, then stop --all.
  const a5 = await req(d, "start", TOKEN, {}, 60_000);
  const p3 = (await d.next((l) => l.t === "ev" && l.ev === "ready" && ![p1, p2].includes(l.chrome_pid))).chrome_pid as number;
  trackUnit(p3);
  check("start again after the watch's stop", a5.ok === true && !!proc(p3), `pid ${p3}`);
  const rec5 = JSON.parse(readFileSync(join(state, "unit.json"), "utf8"));
  const b5 = await req(d, "stop", WEB, {}, 30_000);
  const st5 = await d.next((l) => l.t === "ev" && l.ev === "stopped" && l.reason === "stop");
  check("stop: Chrome and Xvfb gone, the stopped event with the stop's by, wanted false", b5.ok === true && JSON.stringify(st5.by) === JSON.stringify(WEB) && !proc(p3) && !proc(rec5.xvfb_pid) && JSON.parse(readFileSync(join(state, "unit.json"), "utf8")).wanted === false);
  await req(d, "start", TOKEN, {}, 60_000);
  const p4 = (await d.next((l) => l.t === "ev" && l.ev === "ready" && ![p1, p2, p3].includes(l.chrome_pid))).chrome_pid as number;
  trackUnit(p4);
  const rec6 = JSON.parse(readFileSync(join(state, "unit.json"), "utf8"));
  d.s.end();
  const exit2 = await stopService();
  check("a stop of the service leaves Chrome and Xvfb", exit2 === 0 && !!proc(p4) && !!proc(rec6.xvfb_pid));
  const all = await new Promise<{ code: number | null; out: string }>((r) => { const c = spawn(process.execPath, [BIN, "service", "stop", "--all", "--browser-state", state], { stdio: ["ignore", "pipe", "inherit"] }); let out = ""; c.stdout!.on("data", (x) => (out += x)); c.once("exit", (code) => r({ code, out })); });
  check("service stop --all stops this run's Chrome and Xvfb", all.code === 0 && !proc(p4) && !proc(rec6.xvfb_pid) && all.out.includes(`Chrome pid ${p4}`) && all.out.includes(`Xvfb pid ${rec6.xvfb_pid}`), all.out.trim());
  check("the display is free again", !existsSync(`/tmp/.X11-unix/X${display}`));
} catch (e) {
  code = 1;
  log(`FAIL: ${(e as Error).message}`);
  if (serviceErr) log(`the service's log (end):\n${serviceErr.slice(-2000)}`);
} finally {
  await stopService();
  // Only the pids that this run started, with their recorded start times: SIGTERM, then SIGKILL.
  for (const sig of ["SIGTERM", "SIGKILL"] as const) {
    for (const [pid, start] of started) if (proc(pid)?.start === start) { try { process.kill(pid, sig); } catch {} }
    await sleep(2000);
  }
  const left = [...started].filter(([pid, start]) => proc(pid)?.start === start).map(([pid]) => pid);
  repo?.close();
  rmSync(dir, { recursive: true, force: true });
  log(`cleanup: ${left.length ? `still running: ${left.join(", ")}` : "no process of this run runs"}; the temp folder is ${existsSync(dir) ? "still there" : "removed"}`);
  if (left.length) code = 1;
  process.stdout.write(`${JSON.stringify({ passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length + (code && results.every((r) => r.ok) ? 1 : 0), seconds: Math.round((Date.now() - t0) / 1000) })}\n`);
  process.exit(code);
}
