// The live row of board ab-v16.81: a start moves the agent extension to the staged CRX (C12, the agent package). While
// an older receiver runs in the profile, Chrome installs a newer CRX of its external extensions file only at its next
// start (a delayed install), so the service starts Chrome once more when the first hello is older than its package.
//
//   1. the service of an older pin (a checkout at --old-root, for example the commit that pins the receiver 0.3.14)
//      starts Chrome on a new profile: its receiver installs and says its hello; then the stop op and the service's end;
//   2. this checkout's service runs on the same state and tools folders, and ONE start op answers ok: its one `ready`
//      event and `status` say AGENT_VERSION, the receiver's last hello says it, and the log shows the move (two Chrome
//      starts, no warning of a second older hello); then the stop op and the service's end.
//
// Like check.ts: the real pinned packages of both checkouts, a copy of the box's Chromium in the run's tools folder from
// the local stand-in of Google's index (nothing is downloaded), one display, the harness guard (test/live/README.md),
// and this process as the service's "daemon". Its state and tools folders are below --dir (its sockets in a short temp
// folder: a socket path holds at most 103 bytes); it signals only the pids of its run.
//   flock <heavy.lock> timeout -k 60 1800 node test/live/service-link/receiver-move.ts --display <n> --dir <folder> --old-root <checkout>

import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_VERSION } from "../../../src/service/package/pins.ts";
import { GOOGLE_SOURCE, GoogleChromeTools } from "../../../src/service/unit/google-chrome.ts";
import { makeChromeRepo } from "../../chrome-fixture.ts";
import { harnessGuard, reservedDisplay } from "../guard.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const display = Number(arg("--display")), parent = arg("--dir"), oldRoot = arg("--old-root"), OLD = arg("--old-version") ?? "0.3.14";
const why = !Number.isSafeInteger(display) ? "--display must be a number" : reservedDisplay(display, "--display") ?? (!parent || !oldRoot ? "--dir and --old-root are needed" : null)
  ?? (existsSync(`/tmp/.X11-unix/X${display}`) || existsSync(`/tmp/.X${display}-lock`) ? `:${display} is in use; this row runs on a free display only` : null);
if (why) { process.stderr.write(`receiver-move: ${why}\n`); process.exit(2); }

const t0 = Date.now();
const log = (s: string) => process.stdout.write(`[${((Date.now() - t0) / 1000).toFixed(1)} s] ${s}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: boolean[] = [];
const check = (step: string, ok: boolean, note = "") => { results.push(ok); log(`${ok ? "PASS" : "FAIL"} ${step}${note ? `: ${note}` : ""}`); if (!ok) throw new Error(`${step} failed`); };
const until = async (what: string, f: () => boolean, ms: number) => { const end = Date.now() + ms; while (!f()) { if (Date.now() > end) throw new Error(`${what}: not in ${ms / 1000} s`); await sleep(100); } };
const startOf = (pid: number): number | null => { try { const st = readFileSync(`/proc/${pid}/stat`, "latin1"); return Number(st.slice(st.lastIndexOf(")") + 2).split(" ")[19]); } catch { return null; } };

const guard = await harnessGuard("receiver-move");
const dir = mkdtempSync(join(resolve(parent!), "ab-move-live-"));
const run = mkdtempSync(join(tmpdir(), "ab-mv-")), state = join(dir, "state"), tools = join(dir, "tools"), lists = join(dir, "lists");
mkdirSync(lists, { mode: 0o700 });
const started = new Map<number, number>();
const track = (pid: number | null | undefined, name: string) => { const s = pid ? startOf(pid) : null; if (pid && s !== null && !started.has(pid)) { started.set(pid, s); guard.track(pid, name); } };
let service: ChildProcess | null = null, serviceErr = "";
let repo: ReturnType<typeof makeChromeRepo> | null = null;

type Door = { s: Socket; lines: any[]; send: (o: object) => void; next: (want: (l: any) => boolean, ms?: number) => Promise<any> };
function door(): Promise<Door> {
  return new Promise((done, fail) => {
    const s = connect(join(run, "control.sock")), lines: any[] = [];
    let buf = "";
    s.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
    s.on("error", fail);
    s.once("connect", () => done({ s, lines, send: (o) => s.write(JSON.stringify(o) + "\n"),
      next: async (want, ms = 30_000) => { await until("a control line", () => lines.some(want), ms); return lines.find(want); } }));
  });
}
let n = 0;
const req = async (d: Door, op: string, by: object, fields: object = {}, ms = 30_000) => { const id = `q${++n}`; d.send({ t: "req", id, op, by, ...fields }); return d.next((l) => l.t === "res" && l.id === id, ms); };
const TOKEN = { kind: "token", user: "live", via: "cli" }, DAEMON = { kind: "daemon", user: "live", via: "daemon" };
const SESSION = { scope: "live-1", repo: "local/test", roots: [{ pid: process.pid, start: startOf(process.pid) }], cgroup: null, lifetime_id: "lt-live", mcp_token: null };

/** The service of the checkout at `root` on the run's folders, with config and set_sessions. */
async function startService(root: string): Promise<Door> {
  serviceErr = "";
  service = spawn(process.execPath, [join(root, "bin", "agent-browser.js"), "service", "--test", "--test-display", String(display), "--agent-door", join(run, "cdp.sock"), "--control-door", join(run, "control.sock"),
    "--daemon-command", join(dir, "daemon-command.json"), "--lists-folder", lists, "--state-folder", state, "--tools-dir", tools, "--test-chrome-source", join(dir, "source.json")], { stdio: ["ignore", "ignore", "pipe"] });
  track(service.pid, "service");
  service.stderr!.on("data", (d) => { serviceErr += d; for (const m of serviceErr.matchAll(/(?:Xvfb up on :\d+|started on :\d+|host shim connected) \(pid (\d+)\)/g)) track(Number(m[1]), "unit"); });
  await until("the service's ready line", () => serviceErr.includes("service: ready") || service!.exitCode !== null, 15_000);
  if (!serviceErr.includes("service: ready")) throw new Error(`the service did not start: ${serviceErr.slice(-800)}`);
  const d = await door();
  await d.next((l) => l.t === "hello" && l.side === "service");
  d.send({ t: "hello", v: 1, side: "daemon", version: "live", features: [] });
  const cfg = await req(d, "config", { kind: "daemon", user: "live", via: "config" }, { enabled: true, control: true, chrome_bin: null, chrome_args: [], display_size: "1280x900" });
  const ss = await req(d, "set_sessions", DAEMON, { sessions: [SESSION], remote: [], box: { hosts: ["box.localhost"], cookie_names: [] } });
  if (!cfg.ok || !ss.ok) throw new Error(`config or set_sessions: ${JSON.stringify([cfg, ss])}`);
  return d;
}
async function stopService(): Promise<number | null> {
  const s = service;
  if (!s || s.exitCode !== null) return s?.exitCode ?? null;
  const exited = new Promise<number | null>((r) => s.once("exit", (c) => r(c)));
  s.kill("SIGTERM");
  return Promise.race([exited, sleep(15_000).then(() => { s.kill("SIGKILL"); return -1; })]);
}
/** The stop op, its stopped event, and the service's end. */
async function stopAll(d: Door, what: string): Promise<void> {
  const a = await req(d, "stop", TOKEN, {}, 60_000);
  await d.next((l) => l.t === "ev" && l.ev === "stopped" && l.reason === "stop");
  d.s.end();
  check(`${what}: the stop op, then the service's end (exit 0)`, a.ok === true && (await stopService()) === 0);
}
const said = (v: string) => serviceErr.includes(`link: the receiver ${v} said hello`);
const chromeStarts = () => [...serviceErr.matchAll(/unit: Google Chrome \S+ started on :\d+ \(pid \d+\)/g)].length;

let code = 0;
try {
  const argv = readFileSync("/proc/self/cmdline", "utf8").split("\0").filter((x, i, a) => i < a.length - 1 || x !== "");
  writeFileSync(join(dir, "daemon-command.json"), JSON.stringify({ v: 1, interpreter: realpathSync(process.execPath), args: argv.slice(1) }), { mode: 0o600 });
  repo = makeChromeRepo({ version: "158.0.7100.1-1", chrome: `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "Google Chrome 158.0.7100.1 "; exit 0; fi\nexec "$(dirname "$0")/chromium" "$@"\n` });
  writeFileSync(join(dir, "source.json"), JSON.stringify({ repo: repo.repo, key: repo.keyFile, fingerprints: [repo.fingerprint] }));
  chmodSync(dir, 0o700);
  const copy = await new GoogleChromeTools({ tools, source: { ...GOOGLE_SOURCE, repo: repo.repo, keyFile: repo.keyFile, fingerprints: [repo.fingerprint] }, log: (l) => log(`installer: ${l}`) }).ensure();
  for (const e of readdirSync("/usr/lib/chromium")) cpSync(join("/usr/lib/chromium", e), join(copy.binary, "..", e), { recursive: true, force: true });
  writeFileSync(join(lists, "local.test.json"), JSON.stringify({ allow: ["app.localhost"], repo: "local/test" }), { mode: 0o600 });

  // 1. The older pin's service installs its receiver into the new profile.
  let d = await startService(resolve(oldRoot!));
  check(`the older pin's service: start answers ok`, (await req(d, "start", TOKEN, {}, 120_000)).ok === true);
  await until(`the receiver ${OLD} says hello`, () => said(OLD), 60_000);
  check(`the older pin's receiver ${OLD} said its hello`, true);
  await stopAll(d, "the older pin's service");

  // 2. This checkout's service on the same folders: ONE start op.
  d = await startService(ROOT);
  const a = await req(d, "start", TOKEN, {}, 180_000);
  check("this pin's service: ONE start op answers ok", a.ok === true, JSON.stringify(a));
  await d.next((l) => l.t === "ev" && l.ev === "ready", 5000);
  await sleep(2000);
  const readies = d.lines.filter((l) => l.t === "ev" && l.ev === "ready");
  check(`its one ready event says the receiver ${AGENT_VERSION}`, readies.length === 1 && readies[0].extension_version === AGENT_VERSION, JSON.stringify(readies));
  check(`status says ${AGENT_VERSION}, and the receiver's last hello says it`, (await req(d, "status", DAEMON)).data.extension_version === AGENT_VERSION && said(AGENT_VERSION)
    && serviceErr.lastIndexOf(`link: the receiver ${AGENT_VERSION} said hello`) > serviceErr.lastIndexOf(`link: the receiver ${OLD} said hello`));
  check("the log shows the move: the first hello, one more start, no warning", serviceErr.includes(`unit: the agent extension ${OLD} waits for Chrome's next start (the staged package is ${AGENT_VERSION}); starting Chrome once more`)
    && chromeStarts() === 2 && !serviceErr.includes("did not move to"), serviceErr.match(/unit: the agent extension .*/)?.[0] ?? "no move line");
  check("no stopped event of the first Chrome", !d.lines.some((l) => l.t === "ev" && l.ev === "stopped"));
  await stopAll(d, "this pin's service");
  check("the display is free again", !existsSync(`/tmp/.X11-unix/X${display}`));
} catch (e) {
  code = 1;
  log(`FAIL: ${(e as Error).message}`);
  if (serviceErr) log(`the service's log (end):\n${serviceErr.slice(-3000)}`);
} finally {
  await stopService();
  for (const sig of ["SIGTERM", "SIGKILL"] as const) {
    for (const [pid, start] of started) if (startOf(pid) === start) { try { process.kill(pid, sig); } catch {} }
    await sleep(2000);
  }
  const left = [...started].filter(([pid, start]) => startOf(pid) === start).map(([pid]) => pid);
  repo?.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(run, { recursive: true, force: true });
  log(`cleanup: ${left.length ? `still running: ${left.join(", ")}` : "no process of this run runs"}; the run's folders are ${existsSync(dir) || existsSync(run) ? "still there" : "removed"}`);
  if (left.length) code = 1;
  process.stdout.write(`${JSON.stringify({ passed: results.filter(Boolean).length, failed: results.filter((r) => !r).length + (code && results.every(Boolean) ? 1 : 0), seconds: Math.round((Date.now() - t0) / 1000) })}\n`);
  process.exit(code);
}
