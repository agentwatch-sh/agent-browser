// The live check of the start and the stop by use (board ab-v16.94.11; C12, the start and the stop by use; C11, the start
// at a use). It runs the real service with `--test` (the service owns with no systemd unit), in temp folders only (state,
// tools, run, lists; the profile is in the state folder), on one display, under the harness guard (test/live/README.md),
// and it is the service's "daemon" on the control door (the MainPID of `--test` is the service's parent: this process,
// with its own expected command file). The agent package is the service's pinned CRX; the Chrome is a copy of the box's
// Chromium in the temp tools folder, installed by the service's own installer from the local stand-in of Google's index
// (test/chrome-fixture.ts; nothing is downloaded). Pages are *.localhost pages of a local server only.
//
//   1. config (idle_stop_minutes 1) and set_sessions, and no start op: no Chrome runs (no use);
//   2. a first use: a CDP client of the session's scope connects to the agent door; its upgrade waits while the service
//      starts Chrome and Xvfb, then it connects; ready comes with Chrome's pid; the client opens a local page; it stays
//      connected past the grace time, and Chrome stays (review-120 note 9);
//   3. the client leaves; after the grace time with no use the service stops Chrome and Xvfb (stopped idle, last_stop
//      idle, state off); the profile stays on disk; a new client that comes as the stop begins waits, and Chrome starts
//      again for it (review-120 note 9);
//   4. the MCP path (--test-mcp-port 0): an MCP session's tool call opens the local page; the session stays open, and
//      the stop by use comes; the next tool call starts Chrome again, the MCP connects again, and the page loads;
//   5. a failed start at a use: with a chrome_bin that is not there, the client gets the 503 with the reason and
//      stopped start_failed goes out; a changed config ends the hold-off, and the next use starts Chrome;
//   6. stop, then the service's stop removes its sockets.
//
// It never touches another Chrome, Xvfb, profile or folder: it signals only the pids that its run started, and its own
// code removes its temp folders at its end. Run it under the box's heavy lock:
//   flock <heavy.lock> timeout 1500 node test/live/service-use/check.ts --display 171

import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CDPConnection } from "../../../src/cdp.ts";
import { GOOGLE_SOURCE, GoogleChromeTools } from "../../../src/service/unit/google-chrome.ts";
import { makeChromeRepo } from "../../chrome-fixture.ts";
import { harnessGuard, reservedDisplay } from "../guard.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const BIN = join(ROOT, "bin", "agent-browser.js");
const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const display = Number(arg("--display") ?? "171");
// The harnesses' displays on taylor (169, 173 to 175) are other checks', so this check takes none of them either.
const refused = reservedDisplay(display, "--display") ?? ([169, 173, 174, 175].includes(display) ? `--display names :${display}, another harness's display` : null);
if (!Number.isSafeInteger(display) || refused) { process.stderr.write(`service-use: ${refused ?? "--display must be a number"}\n`); process.exit(2); }
if (existsSync(`/tmp/.X11-unix/X${display}`) || existsSync(`/tmp/.X${display}-lock`)) { process.stderr.write(`service-use: :${display} is in use; this check runs on a free display only\n`); process.exit(2); }
const CHROMIUM_TREE = "/usr/lib/chromium";
/** The grace time of the check: the shortest that config takes (1 min). */
const GRACE_MIN = 1;

const t0 = Date.now();
const log = (s: string) => process.stdout.write(`[${((Date.now() - t0) / 1000).toFixed(1)} s] ${s}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: { step: string; ok: boolean; note: string }[] = [];
const check = (step: string, ok: boolean, note = "") => { results.push({ step, ok, note }); log(`${ok ? "PASS" : "FAIL"} ${step}${note ? `: ${note}` : ""}`); if (!ok) throw new Error(`${step} failed${note ? `: ${note}` : ""}`); };
const until = async (what: string, f: () => boolean, ms: number) => { const end = Date.now() + ms; while (!f()) { if (Date.now() > end) throw new Error(`${what}: not in ${ms / 1000} s`); await sleep(100); } };

/** The start time (field 22), the parent and the command line of a pid, or null. */
function proc(pid: number): { start: number; ppid: number; argv: string[] } | null {
  try {
    const st = readFileSync(`/proc/${pid}/stat`, "latin1");
    const f = st.slice(st.lastIndexOf(")") + 2).split(" ");
    if (["Z", "X"].includes(f[0])) return null;
    return { start: Number(f[19]), ppid: Number(f[1]), argv: readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean) };
  } catch { return null; }
}

const guard = await harnessGuard("service-use");
const dir = mkdtempSync(join(tmpdir(), "ab-use-live-"));
const run = join(dir, "run"), state = join(dir, "state"), tools = join(dir, "tools"), lists = join(dir, "lists");
mkdirSync(run, { mode: 0o700 });
mkdirSync(lists, { mode: 0o700 });
const started = new Map<number, number>(); // pid -> start time: every process of this run that may need a signal
let service: ChildProcess | null = null;
let serviceErr = "";
let repo: ReturnType<typeof makeChromeRepo> | null = null;
const http = createServer((req, res) => {
  const host = String(req.headers.host ?? "").split(":")[0];
  res.writeHead(200, { "Content-Type": "text/html" }).end(`<!doctype html><title>page of ${host}</title><p>${host}</p>`);
});

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
const TOKEN = { kind: "token", user: "live", via: "cli" }, DAEMON = { kind: "daemon", user: "live", via: "daemon" };
const me = proc(process.pid)!;
// A made-up connection token of this run for the MCP path, and its fingerprint (C12: set_sessions carries only that).
const TOKEN_MCP = `abt1_${randomBytes(32).toString("base64url")}`;
const SESSION = { scope: "live-1", repo: "local/test", roots: [{ pid: process.pid, start: me.start }], cgroup: null, lifetime_id: "lt-live", mcp_token: createHash("sha256").update(TOKEN_MCP, "ascii").digest("hex") };

async function startService(): Promise<Door> {
  serviceErr = "";
  service = spawn(process.execPath, [BIN, "service", "--test", "--test-display", String(display), "--agent-door", join(run, "cdp.sock"), "--control-door", join(run, "control.sock"),
    "--daemon-command", join(dir, "daemon-command.json"), "--lists-folder", lists, "--state-folder", state, "--tools-dir", tools, "--test-chrome-source", join(dir, "source.json"), "--test-mcp-port", "0"], { stdio: ["ignore", "ignore", "pipe"] });
  guard.track(service.pid, "service");
  started.set(service.pid!, proc(service.pid!)?.start ?? -1);
  service.stderr!.on("data", (d) => { serviceErr += d; });
  for (let i = 0; i < 300 && !serviceErr.includes("service: ready"); i++) { if (service.exitCode !== null) break; await sleep(50); }
  if (!serviceErr.includes("service: ready")) throw new Error(`the service did not start: ${serviceErr.slice(-800)}`);
  const d = await door();
  const hello = await d.next((l) => l.t === "hello");
  if (hello.side !== "service") throw new Error(`no hello: ${JSON.stringify(d.lines)}`);
  d.send({ t: "hello", v: 1, side: "daemon", version: "live", features: [] });
  const cfg = await config(d);
  if (!cfg.ok) throw new Error(`config: ${JSON.stringify(cfg)}`);
  const ss = await req(d, "set_sessions", DAEMON, { sessions: [SESSION], remote: [], box: { hosts: ["box.localhost"], cookie_names: [] } });
  if (!ss.ok) throw new Error(`set_sessions: ${JSON.stringify(ss)}`);
  return d;
}
const config = (d: Door, chromeBin: string | null = null) => req(d, "config", { kind: "daemon", user: "live", via: "config" }, { enabled: true, control: true, chrome_bin: chromeBin, chrome_args: [], display_size: "1280x900", idle_stop_minutes: GRACE_MIN });
async function stopService(): Promise<number | null> {
  const s = service;
  if (!s || s.exitCode !== null) return s?.exitCode ?? null;
  const exited = new Promise<number | null>((r) => s.once("exit", (c) => r(c)));
  s.kill("SIGTERM");
  return Promise.race([exited, sleep(15_000).then(() => { s.kill("SIGKILL"); return -1; })]);
}
function track(pid: number | null | undefined, name: string): void {
  if (!pid) return;
  const p = proc(pid);
  if (p) { started.set(pid, p.start); guard.track(pid, name); }
}
/** The Xvfb of the unit record now, or null. */
const recordXvfb = () => { try { return JSON.parse(readFileSync(join(state, "unit.json"), "utf8")).xvfb_pid as number | null; } catch { return null; } };

/** A use: a CDP client of the session's scope, its time to connect, and the page of its list. */
async function use(url: string, port: number, what: string): Promise<{ cdp: CDPConnection; ms: number }> {
  const at = Date.now();
  const cdp = await CDPConnection.connect(url, 90_000);
  const ms = Date.now() - at;
  const { targetId } = await cdp.send("Target.createTarget", { url: `http://app.localhost:${port}/` });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  let title = "";
  for (let i = 0; i < 50 && title !== "page of app.localhost"; i++) { title = (await cdp.send("Runtime.evaluate", { expression: "document.title", returnByValue: true }, sessionId)).result.value; if (title !== "page of app.localhost") await sleep(200); }
  check(`${what}: the client opens the local page of its list and reads its title`, title === "page of app.localhost", title);
  return { cdp, ms };
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
  check("the copy of Google Chrome 158.0.7100.1-1 in the temp tools folder holds the Chromium tree", existsSync(join(copy.binary, "..", "chromium")) && statSync(copy.binary).isFile());
  writeFileSync(join(lists, "local.test.json"), JSON.stringify({ allow: ["app.localhost"], repo: "local/test" }), { mode: 0o600 });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
  const port = (http.address() as { port: number }).port;

  // 1. No use: no Chrome.
  const d = await startService();
  await sleep(3000);
  const s1 = (await req(d, "status", DAEMON)).data;
  check("with config and set_sessions and no use, no Chrome runs (no start op is sent)", s1.state === "off" && s1.chrome_pid === null && !existsSync(`/tmp/.X11-unix/X${display}`) && !d.lines.some((l) => l.ev === "ready"), JSON.stringify({ state: s1.state, pid: s1.chrome_pid }));
  check("status gives the grace time of config (idle_stop_minutes)", s1.idle_stop_minutes === GRACE_MIN, String(s1.idle_stop_minutes));
  const url = (await req(d, "endpoint", DAEMON, { scope: "live-1" })).data.url as string;

  // 2. The first use starts Chrome and Xvfb.
  const u1 = await use(url, port, "the first use");
  const ready1 = await d.next((l) => l.t === "ev" && l.ev === "ready");
  const p1 = ready1.chrome_pid as number;
  track(p1, "chrome");
  const x1 = recordXvfb();
  track(x1, "xvfb");
  check("the first use started Chrome and Xvfb; the client's upgrade waited, then connected; ready came with Chrome's pid", !!proc(p1) && !!x1 && !!proc(x1) && /unit: an agent uses the agent browser; starting Chrome/.test(serviceErr), `pid ${p1}, xvfb ${x1}, the connect took ${u1.ms} ms`);
  check("status: ready with that pid while the client is connected", (await req(d, "status", DAEMON)).data.chrome_pid === p1);
  await sleep(GRACE_MIN * 60_000 + 5000);
  check("a client that stays connected past the grace time holds Chrome: no stop", !!proc(p1) && !d.lines.some((l) => l.t === "ev" && l.ev === "stopped") && (await req(d, "status", DAEMON)).data.chrome_pid === p1, `${GRACE_MIN * 60 + 5} s connected`);

  // 3. The client leaves; after the grace time with no use, Chrome and Xvfb stop; a client that comes as the stop
  //    begins waits for its end, and Chrome starts again for it.
  await u1.cdp.close();
  const left = Date.now();
  await until("the stop by use to begin", () => /unit: no agent used the agent browser for 1 min; stopping Chrome and Xvfb/.test(serviceErr), GRACE_MIN * 60_000 + 30_000);
  const begun = Date.now();
  const during = use(url, port, "a use during the stop");
  const st = await d.next((l) => l.t === "ev" && l.ev === "stopped", 30_000);
  const stoppedAt = Date.now();
  const after = Math.round((begun - left) / 1000);
  check("after the grace time with no use, the service stops Chrome: stopped with the reason idle and no by", st.reason === "idle" && st.by === undefined && after >= GRACE_MIN * 60 - 2, `the stop began ${after} s after the client left`);
  await until("Chrome and Xvfb end", () => !proc(p1) && !proc(x1!), 15_000);
  check("Chrome and Xvfb of the stop are gone; the profile stays on disk", !proc(p1) && !proc(x1!) && existsSync(join(state, "profile", "Default")));
  const u2 = await during;
  const ready2 = await d.next((l) => l.t === "ev" && l.ev === "ready" && l.chrome_pid !== p1);
  const p2 = ready2.chrome_pid as number;
  track(p2, "chrome");
  const x2 = recordXvfb();
  track(x2, "xvfb");
  check("the client that came during the stop waited and got a new Chrome: a new pid and a new ready", p2 !== p1 && !!proc(p2) && /unit: an agent uses the agent browser; starting Chrome[\s\S]*unit: no agent used[\s\S]*unit: an agent uses the agent browser; starting Chrome/.test(serviceErr), `the client came ${stoppedAt - begun} ms before the stopped event; the connect took ${u2.ms} ms; pid ${p2}`);
  await u2.cdp.close();

  // 4. The MCP path: a tool call, the stop by use with the session open, then a tool call that starts Chrome again.
  const mcpAddress = (await req(d, "status", DAEMON)).data.mcp.address as string;
  const mcpUrl = `http://${mcpAddress}/mcp/live-1`;
  const mcp = async (body: object, sid?: string) => {
    const r = await fetch(mcpUrl, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${TOKEN_MCP}`, ...(sid ? { "Mcp-Session-Id": sid } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
    const text = await r.text();
    return { status: r.status, sid: r.headers.get("mcp-session-id"), text };
  };
  const init = await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "live", version: "0" } } });
  check("the MCP path: initialize opens an MCP session", init.status === 200 && !!init.sid, init.text.slice(0, 200));
  const sid = init.sid!;
  await mcp({ jsonrpc: "2.0", method: "notifications/initialized" }, sid);
  const nav = (id: number) => mcp({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "browser_navigate", arguments: { url: `http://app.localhost:${port}/` } } }, sid);
  const n1 = await nav(2);
  check("the MCP's tool call opens the local page", n1.status === 200 && n1.text.includes("page of app.localhost"), n1.text.slice(0, 160));
  const callEnd = Date.now();
  const st4 = await d.next((l) => l.t === "ev" && l.ev === "stopped" && l.reason === "idle" && d.lines.indexOf(l) > d.lines.indexOf(st), GRACE_MIN * 60_000 + 30_000);
  check("with the MCP session open and no call, the stop by use comes", st4.reason === "idle" && !proc(p2), `${Math.round((Date.now() - callEnd) / 1000)} s after the last tool call`);
  const n2 = await nav(3);
  const ready3 = await d.next((l) => l.t === "ev" && l.ev === "ready" && l.chrome_pid !== p2);
  const p3 = ready3.chrome_pid as number;
  track(p3, "chrome");
  track(recordXvfb(), "xvfb");
  check("the next tool call of the open MCP session starts Chrome again, the MCP connects again, and the page loads", n2.status === 200 && n2.text.includes("page of app.localhost") && !!proc(p3), `pid ${p3}`);

  // 5. A failed start at a use, then a changed config ends the hold-off.
  const b5 = await req(d, "stop", TOKEN, {}, 30_000);
  await d.next((l) => l.t === "ev" && l.ev === "stopped" && l.reason === "stop");
  await until("Chrome and Xvfb end", () => !proc(p3), 15_000);
  check("stop: Chrome and Xvfb end", b5.ok === true);
  await config(d, "/nonexistent/chromium");
  const bad = await CDPConnection.connect(url, 30_000).then(() => "connected", (e: Error) => e.message);
  const sf = await d.next((l) => l.t === "ev" && l.ev === "stopped" && l.reason === "start_failed", 10_000);
  check("a failed start at a use: the client gets the 503 with the reason, and stopped start_failed goes out", /HTTP 503: The agent browser could not get ready: Chromium not found: \/nonexistent\/chromium\./.test(bad) && !!sf, bad.slice(0, 200));
  await config(d);
  const u5 = await use(url, port, "the use after the changed config");
  const ready5 = await d.next((l) => l.t === "ev" && l.ev === "ready" && l.chrome_pid !== p3);
  track(ready5.chrome_pid, "chrome");
  track(recordXvfb(), "xvfb");
  check("a changed config ends the hold-off: the next use starts Chrome at once", !!proc(ready5.chrome_pid), `the connect took ${u5.ms} ms`);
  await u5.cdp.close();
  const p5 = ready5.chrome_pid as number;

  // 6. Stop, then the service's stop.
  const b6 = await req(d, "stop", TOKEN, {}, 30_000);
  await d.next((l) => l.t === "ev" && l.ev === "stopped" && l.reason === "stop" && l !== d.lines.find((x) => x.ev === "stopped" && x.reason === "stop"));
  await until("Chrome and Xvfb end", () => !proc(p5), 15_000);
  check("stop: Chrome and Xvfb end", b6.ok === true);
  d.s.end();
  const exit = await stopService();
  check("the service's stop removes its sockets", exit === 0 && !existsSync(join(run, "link.sock")) && !existsSync(join(run, "control.sock")) && !existsSync(join(run, "cdp.sock")));
  check("the display is free again", !existsSync(`/tmp/.X11-unix/X${display}`));
} catch (e) {
  code = 1;
  log(`FAIL: ${(e as Error).message}`);
  if (serviceErr) log(`the service's log (end):\n${serviceErr.slice(-3000)}`);
} finally {
  await stopService();
  http.close();
  // Only the pids that this run started, with their recorded start times: SIGTERM, then SIGKILL.
  for (const sig of ["SIGTERM", "SIGKILL"] as const) {
    for (const [pid, start] of started) if (proc(pid)?.start === start) { try { process.kill(pid, sig); } catch {} }
    await sleep(2000);
  }
  const leftover = [...started].filter(([pid, start]) => proc(pid)?.start === start).map(([pid]) => pid);
  repo?.close();
  rmSync(dir, { recursive: true, force: true });
  log(`cleanup: ${leftover.length ? `still running: ${leftover.join(", ")}` : "no process of this run runs"}; the temp folder is ${existsSync(dir) ? "still there" : "removed"}`);
  if (leftover.length) code = 1;
  process.stdout.write(`${JSON.stringify({ passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length + (code && results.every((r) => r.ok) ? 1 : 0), seconds: Math.round((Date.now() - t0) / 1000) })}\n`);
  process.exit(code);
}
