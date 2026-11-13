// The live check of stage 1b part 2 of the self-contained agent browser (board ab-v16.94.9): the native link, the
// agent package and the model inside `agent-browser service`. It runs the real service with `--test` (the service owns
// with no systemd unit), in temp folders only (state, tools, run, lists; the profile is in the state folder), on one
// display, under the harness guard (test/live/README.md), and it is the service's "daemon" on the control door (the
// MainPID of `--test` is the service's parent: this process, with its own expected command file). No stand-in daemon
// runs: the service itself is the receiver's far side.
//
// The agent package is the REAL one: the service's pinned release/agent.crx of chrome-extension 443f968 (the receiver
// 0.3.8, with the merge guard's floor: board ab-v16.97.10). The check reads that commit's file with `git show` when the
// chrome-extension checkout is there, and checks that it is the same bytes as the service's copy. The Chrome is a copy
// of the box's Chromium in the temp tools folder, installed by the service's own installer from the local stand-in of
// Google's index (test/chrome-fixture.ts; nothing is downloaded), so Chrome reads the external extensions file next to
// its binary.
//
//   1. config, set_sessions, start: Chrome starts with the agent package from the external extensions file;
//   2. Chrome starts the host shim from the profile's host manifest; the shim connects to the link socket; the receiver
//      says hello; a peer that is not the service's Chrome is refused;
//   3. stage 1c's set_scopes passes the receiver port (an ok in time), and the model admits a CDP client on the agent
//      door; the client opens a local *.localhost page of its list and reads its title; the pinned receiver confirms
//      the merge guard's floor, so the client's Page.setBypassCSP with enabled true goes to Chrome (C11);
//   4. blocked reports pass the receiver port: an off-list Target.createTarget (the model's daemon.blocked) and an
//      off-list navigation in the page (the receiver's blocked notice) each make a `prompt` event;
//   5. a restart of the service: the shim connects to the new service again (its retry each second);
//   6. stop: Chrome, Xvfb and the shim end; then the service's stop removes its sockets.
//
// It never touches another Chrome, Xvfb, profile or folder: it signals only the pids that its run started, and its own
// code removes its temp folders at its end. Run it under the box's heavy lock:
//   flock <heavy.lock> timeout 1500 node test/live/service-link/check.ts --display 174

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CDPConnection } from "../../../src/cdp.ts";
import { AGENT_CRX, AGENT_CRX_SHA256, AGENT_VERSION, CHROME_EXTENSION_COMMIT, RECEIVER_ID } from "../../../src/service/package/pins.ts";
import { GOOGLE_SOURCE, GoogleChromeTools } from "../../../src/service/unit/google-chrome.ts";
import { makeChromeRepo } from "../../chrome-fixture.ts";
import { harnessGuard, reservedDisplay } from "../guard.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const BIN = join(ROOT, "bin", "agent-browser.js");
const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const display = Number(arg("--display") ?? "174");
const refused = reservedDisplay(display, "--display") ?? ([169, 173].includes(display) ? `--display names :${display}, another harness's display` : null);
if (!Number.isSafeInteger(display) || refused) { process.stderr.write(`service-link: ${refused ?? "--display must be a number"}\n`); process.exit(2); }
if (existsSync(`/tmp/.X11-unix/X${display}`) || existsSync(`/tmp/.X${display}-lock`)) { process.stderr.write(`service-link: :${display} is in use; this check runs on a free display only\n`); process.exit(2); }
const CHROMIUM_TREE = "/usr/lib/chromium";
const CE_CHECKOUT = arg("--chrome-extension");

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

const guard = await harnessGuard("service-link");
const dir = mkdtempSync(join(tmpdir(), "ab-link-live-"));
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
const SESSION = { scope: "live-1", repo: "local/test", roots: [{ pid: process.pid, start: me.start }], cgroup: null, lifetime_id: "lt-live", mcp_token: null };

async function startService(): Promise<Door> {
  serviceErr = "";
  service = spawn(process.execPath, [BIN, "service", "--test", "--test-display", String(display), "--agent-door", join(run, "cdp.sock"), "--control-door", join(run, "control.sock"),
    "--daemon-command", join(dir, "daemon-command.json"), "--lists-folder", lists, "--state-folder", state, "--tools-dir", tools, "--test-chrome-source", join(dir, "source.json")], { stdio: ["ignore", "ignore", "pipe"] });
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
  const ss = await req(d, "set_sessions", DAEMON, { sessions: [SESSION], remote: [], box: { hosts: ["box.localhost"], cookie_names: [] } });
  if (!ss.ok) throw new Error(`set_sessions: ${JSON.stringify(ss)}`);
  return d;
}
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
/** The pid of the host shim that the service's log names last. */
const shimPid = () => { const m = [...serviceErr.matchAll(/link: the host shim connected \(pid (\d+)\)/g)].at(-1); return m ? Number(m[1]) : null; };

let code = 0;
try {
  // The real agent package: the service's pinned CRX, the same bytes as chrome-extension's release/agent.crx at the pin.
  const crx = readFileSync(AGENT_CRX);
  check(`the service's agent package is the pinned CRX of receiver ${AGENT_VERSION} (SHA-256 ${AGENT_CRX_SHA256.slice(0, 8)}...)`, createHash("sha256").update(crx).digest("hex") === AGENT_CRX_SHA256 && AGENT_CRX_SHA256.startsWith("4b278926576641876d49") && AGENT_VERSION === "0.3.8");
  if (CE_CHECKOUT) {
    const fromGit = execFileSync("git", ["-C", CE_CHECKOUT, "show", `${CHROME_EXTENSION_COMMIT.slice(0, 7)}:release/agent.crx`], { maxBuffer: 1 << 24 });
    writeFileSync(join(dir, "agent.crx"), fromGit);
    check(`git show ${CHROME_EXTENSION_COMMIT.slice(0, 7)}:release/agent.crx gives the same bytes as the service's copy`, fromGit.equals(crx) && createHash("sha256").update(readFileSync(join(dir, "agent.crx"))).digest("hex") === AGENT_CRX_SHA256);
  }
  // The expected command of this "daemon": its resolved interpreter and its command line from argv[1] on.
  const argv = readFileSync("/proc/self/cmdline", "utf8").split("\0").filter((x, i, a) => i < a.length - 1 || x !== "");
  writeFileSync(join(dir, "daemon-command.json"), JSON.stringify({ v: 1, interpreter: realpathSync(process.execPath), args: argv.slice(1) }), { mode: 0o600 });
  // The stand-in of Google's index: its chrome answers --version and otherwise runs the Chromium binary next to it.
  repo = makeChromeRepo({ version: "158.0.7100.1-1", chrome: `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "Google Chrome 158.0.7100.1 "; exit 0; fi\nexec "$(dirname "$0")/chromium" "$@"\n` });
  writeFileSync(join(dir, "source.json"), JSON.stringify({ repo: repo.repo, key: repo.keyFile, fingerprints: [repo.fingerprint] }));
  chmodSync(dir, 0o700);
  // The service's own installer puts the copy into the temp tools folder; a copy of the box's Chromium goes next to its
  // binary, so Chrome's module folder (and its extensions folder) is the copy's.
  const installer = new GoogleChromeTools({ tools, source: { ...GOOGLE_SOURCE, repo: repo.repo, keyFile: repo.keyFile, fingerprints: [repo.fingerprint] }, log: (l) => log(`installer: ${l}`) });
  const copy = await installer.ensure();
  for (const e of readdirSync(CHROMIUM_TREE)) cpSync(join(CHROMIUM_TREE, e), join(copy.binary, "..", e), { recursive: true, force: true }); // over the stand-in resources.pak of the fixture
  check("the copy of Google Chrome 158.0.7100.1-1 in the temp tools folder holds the Chromium tree", existsSync(join(copy.binary, "..", "chromium")) && statSync(copy.binary).isFile());
  writeFileSync(join(lists, "local.test.json"), JSON.stringify({ allow: ["app.localhost"], repo: "local/test" }), { mode: 0o600 });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
  const port = (http.address() as { port: number }).port;

  // 1. config, set_sessions, start: Chrome with the agent package from the external extensions file.
  let d = await startService();
  check("the service starts in --test mode with the native link", /service: ready \(pid \d+; the Chrome unit runs, with the native link\)/.test(serviceErr));
  const a1 = await req(d, "start", TOKEN, {}, 120_000);
  check("start answers ok", a1.ok === true, JSON.stringify(a1));
  const ready1 = await d.next((l) => l.t === "ev" && l.ev === "ready");
  const p1 = ready1.chrome_pid as number;
  track(p1, "chrome");
  const rec1 = JSON.parse(readFileSync(join(state, "unit.json"), "utf8"));
  track(rec1.xvfb_pid, "xvfb");
  check("the ready event carries the staged agent package's version", ready1.extension_version === AGENT_VERSION, JSON.stringify(ready1));
  const extFile = join(copy.binary, "..", "extensions", `${RECEIVER_ID}.json`);
  const ext = JSON.parse(readFileSync(extFile, "utf8"));
  check("the external extensions file names the staged CRX and its version", ext.external_version === AGENT_VERSION && ext.external_crx === join(tools, "agent-crx", `${AGENT_VERSION}-${AGENT_CRX_SHA256.slice(0, 12)}.crx`) && createHash("sha256").update(readFileSync(ext.external_crx)).digest("hex") === AGENT_CRX_SHA256);
  const c1 = proc(p1)!;
  check("Chrome runs the copy's Chromium on the temp profile with no --load-extension, no remote debugging, automation or headless switch", realpathSync(`/proc/${p1}/exe`) === realpathSync(join(copy.binary, "..", "chromium")) && c1.argv.includes(`--user-data-dir=${join(state, "profile")}`) && !c1.argv.some((a) => /load-extension|remote-debugging|enable-automation|headless/.test(a)), c1.argv.slice(0, 3).join(" "));
  const manifest = JSON.parse(readFileSync(join(state, "profile", "NativeMessagingHosts", "sh.agentwatch.browser.json"), "utf8"));
  check("the host manifest in the profile names the service's wrapper and only the receiver", manifest.path === join(state, "agent-browser-host") && JSON.stringify(manifest.allowed_origins) === JSON.stringify([`chrome-extension://${RECEIVER_ID}/`]));

  // 2. the host shim, the link and the hello.
  await until("the host shim connects to the link", () => shimPid() !== null, 60_000);
  const sp = shimPid()!;
  track(sp, "shim");
  const shim = proc(sp)!;
  check("Chrome started the host shim, a direct child of its pid, with the receiver's origin", shim.ppid === p1 && shim.argv.includes("host") && shim.argv.at(-1) === `chrome-extension://${RECEIVER_ID}/` && shim.argv.includes("--disable-sigusr1"), shim.argv.join(" "));
  await until("the receiver says hello on the link", () => serviceErr.includes(`link: the receiver ${AGENT_VERSION} said hello (bridge, scopes)`), 30_000);
  check("the receiver of the real agent package says its hello with the bridge and scopes", true, serviceErr.match(/link: the receiver.*/)?.[0] ?? "");
  const exts = readdirSync(join(state, "profile", "Default", "Extensions"), { withFileTypes: true }).map((e) => e.name);
  check("Chrome installed the agent package from the external extensions file into the profile", exts.includes(RECEIVER_ID), exts.join(" "));
  const intruder = connect(join(run, "link.sock"));
  intruder.on("error", () => {});
  intruder.write('{"t":"hello","v":2,"version":"9.9.9","channels":["main","bridge"],"features":["scopes"]}\n');
  await until("the link refuses a peer that is not the service's Chrome", () => /link: refused 1 peer\(s\) since the last line \(its parent is not the service's Chrome\)/.test(serviceErr), 10_000);
  intruder.destroy();
  check("the link refuses this process (its parent is not the service's Chrome), and the receiver stays linked", (await req(d, "status", DAEMON)).data.extension_version === AGENT_VERSION);

  // 3. set_scopes through the receiver port, and a CDP client of the model on the agent door.
  await until("the receiver confirms the lists", () => /lists: the receiver took the lists of 1 scopes/.test(serviceErr), 30_000);
  const s3 = (await req(d, "status", DAEMON)).data;
  check("set_scopes passed the receiver port: an ok in time, so no agent's note of unconfirmed lists", s3.state === "ready" && !/not confirmed the lists/.test(s3.agent_text) && s3.sessions[0]?.list === "local.test", JSON.stringify({ state: s3.state, agent: s3.agent_text, sessions: s3.sessions }));
  const url = (await req(d, "endpoint", DAEMON, { scope: "live-1" })).data.url as string;
  let cdp: CDPConnection | null = null;
  for (let i = 0; i < 50 && !cdp; i++) { try { cdp = await CDPConnection.connect(url, 5000); } catch (e) { if (i === 49) throw e; await sleep(200); } }
  const version = await cdp!.send("Browser.getVersion");
  check("the model answers a CDP client on the agent door", typeof version.userAgent === "string" && /Chrome\//.test(version.userAgent), version.product);
  const page = `http://app.localhost:${port}/`;
  const { targetId } = await cdp!.send("Target.createTarget", { url: page });
  const { sessionId } = await cdp!.send("Target.attachToTarget", { targetId, flatten: true });
  let title = "";
  for (let i = 0; i < 50 && title !== "page of app.localhost"; i++) { title = (await cdp!.send("Runtime.evaluate", { expression: "document.title", returnByValue: true }, sessionId)).result.value; if (title !== "page of app.localhost") await sleep(200); }
  check("the client opens the local page of its list through the model and reads its title", title === "page of app.localhost", title);
  // The merge guard's floor (C11, the merge guard; board ab-v16.97.10): the pinned receiver answers
  // bridge.mergeGuard, so the model has a confirmed floor and lets the client's Page.setBypassCSP with enabled true
  // go to Chrome. The model sends the op at the link up and does not wait for its answer, so the client tries again
  // for at most 10 s.
  let csp = "", tries = 0;
  for (const end = Date.now() + 10_000; csp !== "answered" && Date.now() < end; tries++) {
    csp = await cdp!.send("Page.setBypassCSP", { enabled: true }, sessionId).then(() => "answered", (e: Error) => e.message);
    if (csp !== "answered") await sleep(250);
  }
  check("the pinned receiver has the merge guard's floor: no log line of a receiver with no floor or of a failed bridge.mergeGuard", !/merge guard: the receiver has no floor|merge guard: bridge\.mergeGuard failed/.test(serviceErr), serviceErr.match(/merge guard: .*/)?.[0] ?? "no merge guard line");
  check("with the confirmed floor, the client's Page.setBypassCSP with enabled true goes to Chrome (C11, the page's policy)", csp === "answered", `${csp} (${tries} tries)`);
  await cdp!.send("Page.setBypassCSP", { enabled: false }, sessionId);
  check("the X pointer of the service answers on the unit's own Xvfb (no 'no display' from its ops)", !/pointer: daemon\.(pointerAt|movePointer): no display/.test(serviceErr), serviceErr.match(/pointer: .*/)?.[0] ?? "no pointer error line");

  // 4. blocked reports through the receiver port.
  const off = await cdp!.send("Target.createTarget", { url: `http://other.localhost:${port}/` }).then(() => null, (e: Error) => e.message);
  const pr1 = await d.next((l) => l.t === "ev" && l.ev === "prompt" && l.host === "other.localhost", 15_000);
  check("an off-list Target.createTarget is refused and its daemon.blocked makes a prompt for the scope's list", off !== null && pr1.state === "open" && pr1.scope === "live-1" && pr1.list === "local.test", `${off}; ${JSON.stringify(pr1)}`);
  await cdp!.send("Runtime.evaluate", { expression: `location.href = "http://third.localhost:${port}/"; 1`, returnByValue: true }, sessionId).catch(() => {});
  const pr2 = await d.next((l) => l.t === "ev" && l.ev === "prompt" && l.host === "third.localhost", 20_000);
  check("an off-list navigation in the page is blocked by the receiver, and its blocked notice makes a prompt with its from host", pr2.state === "open" && pr2.scope === "live-1" && pr2.from === "app.localhost", JSON.stringify(pr2));
  await cdp!.close();

  // 5. a restart of the service: Chrome stays, the new service adopts it, and the same shim connects again.
  d.s.end();
  const exit1 = await stopService();
  check("the service stops at SIGTERM (exit 0); Chrome, Xvfb and the shim stay", exit1 === 0 && !!proc(p1) && !!proc(rec1.xvfb_pid) && proc(sp)?.start === shim.start, `exit ${exit1}`);
  await sleep(500);
  d = await startService();
  await until("the shim connects to the new service", () => shimPid() !== null, 15_000);
  check("the new service adopts Chrome and its own shim connects again (no old host is ended)", shimPid() === sp && !/ended the old host/.test(serviceErr) && (await req(d, "status", DAEMON)).data.chrome_pid === p1);
  await until("the receiver confirms the lists again", () => /lists: the receiver took the lists of 1 scopes/.test(serviceErr), 30_000);

  // 6. stop: everything ends.
  const b6 = await req(d, "stop", TOKEN, {}, 30_000);
  const st6 = await d.next((l) => l.t === "ev" && l.ev === "stopped" && l.reason === "stop");
  await until("Chrome, Xvfb and the shim end", () => !proc(p1) && !proc(rec1.xvfb_pid) && !proc(sp), 15_000);
  check("stop: Chrome, Xvfb and the host shim end; the stopped event with its by", b6.ok === true && st6.by?.kind === "token");
  d.s.end();
  const exit2 = await stopService();
  check("the service's stop removes its sockets", exit2 === 0 && !existsSync(join(run, "link.sock")) && !existsSync(join(run, "control.sock")) && !existsSync(join(run, "cdp.sock")));
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
  const left = [...started].filter(([pid, start]) => proc(pid)?.start === start).map(([pid]) => pid);
  repo?.close();
  rmSync(dir, { recursive: true, force: true });
  log(`cleanup: ${left.length ? `still running: ${left.join(", ")}` : "no process of this run runs"}; the temp folder is ${existsSync(dir) ? "still there" : "removed"}`);
  if (left.length) code = 1;
  process.stdout.write(`${JSON.stringify({ passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length + (code && results.every((r) => r.ok) ? 1 : 0), seconds: Math.round((Date.now() - t0) / 1000) })}\n`);
  process.exit(code);
}
