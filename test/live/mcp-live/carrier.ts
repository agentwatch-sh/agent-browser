// The live check of the remote MCP path on the Linux server (stage 5 T4, board ab-v16.94.7.5; the plan
// docs/superpowers/plans/2026-11-16-stage-5-remote-scopes.md, task T4's Done-when; C11, "The remote MCP path (stage
// 5)"; C12, the hello's remote_scopes). It runs the real service as test/live/mcp-live/check.ts does: `agent-browser
// service --test`, in temp folders only, on one display, under the harness guard (test/live/README.md, rules 1 and 2),
// and it is the service's "daemon" on the control door. One change to the plan (the lead's brief): no systemd unit and
// no user service. The fake gateway (fake-gateway.ts, a small reverse proxy onto the agent door's socket) runs as this
// harness's own child process, and the service gets its pid with the test-only `--test-gateway-pid` and its command
// file with `--gateway-command`. Pages are app.localhost pages of a local server of this process only. The MCP client is
// the MCP SDK's own Client and StreamableHTTPClientTransport from the pinned playwright-core's bundle, which connects to
// the fake gateway with a made-up remote token that this run makes (only in the Authorization header, never in argv or
// a log line).
//
// The rows:
//   1. the hello lists mcp_token and remote_scopes; status.remote names the remote item;
//   2. initialize through the fake gateway (the carrier);
//   3. tools/list: no browser_sign_in, no browser_sign_ins and no PageFetch (a remote admission), and browser_navigate;
//   4. a navigation to a local page of the remote scope's list;
//   5. a path argument is refused (browser_take_screenshot's filename: the -32602 of a remote admission);
//   6. a wrong token's 401 through the fake gateway (the third 401 of step 7, with WWW-Authenticate).
//
// Usage: flock <heavy.lock> timeout 1800 node test/live/mcp-live/carrier.ts [--display N] (default 171)

import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { GOOGLE_SOURCE, GoogleChromeTools } from "../../../src/service/unit/google-chrome.ts";
import { makeChromeRepo } from "../../chrome-fixture.ts";
import { harnessGuard, reservedDisplay } from "../guard.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const BIN = join(ROOT, "bin", "agent-browser.js");
const GATEWAY = fileURLToPath(new URL("./fake-gateway.ts", import.meta.url));
const sdk = createRequire(import.meta.url)(join(ROOT, "node_modules", "playwright-core", "lib", "utilsBundle.js"));
const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const fail2 = (why: string): never => { process.stderr.write(`mcp-carrier: ${why}\n`); process.exit(2); };
const display = Number(arg("--display") ?? "171");
if (!Number.isInteger(display) || display < 1) fail2("--display must be a display number");
const refused = reservedDisplay(display, "--display") ?? ([169, 172, 173, 174, 175].includes(display) ? `--display names :${display}, another job's display` : null);
if (refused) fail2(refused);
if (existsSync(`/tmp/.X11-unix/X${display}`) || existsSync(`/tmp/.X${display}-lock`)) fail2(`display :${display} is in use`);
const CHROMIUM_TREE = "/usr/lib/chromium";
const BOX = "testbox", SCOPE = `${BOX}/live-9`, LIST = "carrier.test";
const NA = "Not available in the agent browser";
const UNKNOWN_TOKEN = "The agent browser does not know this connection token for this session.";

const t0 = Date.now();
const log = (s: string) => process.stdout.write(`[${((Date.now() - t0) / 1000).toFixed(1)} s] ${s}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: { step: string; ok: boolean; note: string }[] = [];
const check = (step: string, ok: boolean, note = "") => { results.push({ step, ok, note }); log(`${ok ? "PASS" : "FAIL"} ${step}${note ? `: ${note}` : ""}`); if (!ok) throw new Error(`${step} failed${note ? `: ${note}` : ""}`); };
/** A row that the later rows do not need: a failure is recorded, and the run goes on (it still fails the run). */
const soft = (step: string, ok: boolean, note = "") => { results.push({ step, ok, note }); log(`${ok ? "PASS" : "FAIL"} ${step}${note ? `: ${note}` : ""}`); };
const until = async (what: string, f: () => boolean, ms: number) => { const end = Date.now() + ms; while (!f()) { if (Date.now() > end) throw new Error(`${what}: not in ${ms / 1000} s`); await sleep(100); } };

/** The start time (field 22) of a pid, or null. */
function startOf(pid: number): number | null {
  try {
    const st = readFileSync(`/proc/${pid}/stat`, "latin1");
    const f = st.slice(st.lastIndexOf(")") + 2).split(" ");
    return ["Z", "X"].includes(f[0]) ? null : Number(f[19]);
  } catch { return null; }
}

const guard = await harnessGuard("mcp-carrier");
const dir = mkdtempSync(join(tmpdir(), "ab-mcp-carrier-"));
const run = join(dir, "run"), state = join(dir, "state"), tools = join(dir, "tools"), lists = join(dir, "lists");
mkdirSync(run, { mode: 0o700 });
mkdirSync(lists, { mode: 0o700 });
const started = new Map<number, number>(); // pid -> start time: every process of this run that may need a signal
let service: ChildProcess | null = null, gateway: ChildProcess | null = null;
let serviceErr = "";
let repo: ReturnType<typeof makeChromeRepo> | null = null;
function track(pid: number | null | undefined, name: string): void {
  if (!pid || started.has(pid)) return;
  const s = startOf(pid);
  if (s !== null) { started.set(pid, s); guard.track(pid, name); }
}
const recordXvfb = () => { try { return JSON.parse(readFileSync(join(state, "unit.json"), "utf8")).xvfb_pid as number | null; } catch { return null; } };

// ------------------------------------------------------------------ the local pages (app.localhost only)
const served = new Set<string>();
const http = createServer((req, res) => {
  const host = String(req.headers.host ?? "").split(":")[0];
  served.add(host);
  if ((req.url ?? "/").startsWith("/favicon.ico")) { res.writeHead(404).end(); return; }
  res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" }).end(`<!doctype html><title>page of ${host}</title><p>${host}</p>`);
});

// ------------------------------------------------------------------ the control door (this process is the daemon)
type Door = { s: Socket; lines: any[]; next: (want: (l: any) => boolean, ms?: number) => Promise<any>; send: (o: object) => void };
function door(): Promise<Door> {
  return new Promise((resolve, reject) => {
    const s = connect(join(run, "control.sock"));
    const lines: any[] = [];
    let buf = "";
    const waiters: { want: (l: any) => boolean; done: (l: any) => void }[] = [];
    s.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const l = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); lines.push(l);
        // Every Chrome and Xvfb that a start at a use makes is this run's: the guard and the cleanup get them at once.
        if (l.t === "ev" && l.ev === "ready") { track(l.chrome_pid, "chrome"); track(recordXvfb(), "xvfb"); }
        for (const w of [...waiters]) if (w.want(l)) { waiters.splice(waiters.indexOf(w), 1); w.done(l); }
      }
    });
    s.on("error", reject);
    s.once("connect", () => resolve({
      s, lines, send: (o) => s.write(JSON.stringify(o) + "\n"),
      next: (want, ms = 30_000) => { const hit = lines.find(want); if (hit) return Promise.resolve(hit); return new Promise((done, fail) => { const w = { want, done: (l: any) => { clearTimeout(t); done(l); } }; waiters.push(w); const t = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); fail(new Error(`no such line in ${ms} ms: ${JSON.stringify(lines.slice(-5))}`)); }, ms); }); },
    }));
  });
}
let n = 0;
const req = async (d: Door, op: string, by: object, fields: object = {}, ms = 30_000) => { const id = `q${++n}`; d.send({ t: "req", id, op, by, ...fields }); return d.next((l) => l.t === "res" && l.id === id, ms); };
const DAEMON = { kind: "daemon", user: "live", via: "daemon" }, TOKEN = { kind: "token", user: "live", via: "cli" };
// The run's own made-up remote token, and its fingerprint (C12: set_sessions carries only that).
const REMOTE_TOKEN = `abt1_${randomBytes(32).toString("base64url")}`;
const REMOTE_ITEM = { scope: SCOPE, box: BOX, list: LIST, mcp_token: createHash("sha256").update(REMOTE_TOKEN, "ascii").digest("hex") };
const BOX_FIELD = { hosts: ["box.localhost"], cookie_names: [] };

let code = 0;
try {
  // The expected command of this "daemon" (the service's parent in --test), and the fake gateway's.
  const argv = readFileSync("/proc/self/cmdline", "utf8").split("\0").filter((x, i, a) => i < a.length - 1 || x !== "");
  const node = realpathSync(process.execPath);
  writeFileSync(join(dir, "daemon-command.json"), JSON.stringify({ v: 1, interpreter: node, args: argv.slice(1) }), { mode: 0o600 });
  writeFileSync(join(dir, "gateway-command.json"), JSON.stringify({ v: 1, interpreter: node, args: [GATEWAY, join(run, "cdp.sock")] }), { mode: 0o600 });
  // The stand-in of Google's index: its chrome answers --version and otherwise runs the Chromium binary next to it.
  repo = makeChromeRepo({ version: "158.0.7100.1-1", chrome: `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "Google Chrome 158.0.7100.1 "; exit 0; fi\nexec "$(dirname "$0")/chromium" "$@"\n` });
  writeFileSync(join(dir, "source.json"), JSON.stringify({ repo: repo.repo, key: repo.keyFile, fingerprints: [repo.fingerprint] }));
  chmodSync(dir, 0o700);
  const installer = new GoogleChromeTools({ tools, source: { ...GOOGLE_SOURCE, repo: repo.repo, keyFile: repo.keyFile, fingerprints: [repo.fingerprint] }, log: (l) => log(`installer: ${l}`) });
  const copy = await installer.ensure();
  for (const e of readdirSync(CHROMIUM_TREE)) cpSync(join(CHROMIUM_TREE, e), join(copy.binary, "..", e), { recursive: true, force: true });
  if (!existsSync(join(copy.binary, "..", "chromium")) || !statSync(copy.binary).isFile()) throw new Error("the copy of Google Chrome holds no Chromium tree");
  // The remote scope's list: the grant's one list (Q3), app.localhost only.
  writeFileSync(join(lists, `${LIST}.json`), JSON.stringify({ allow: ["app.localhost"], repo: null }), { mode: 0o600 });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
  const port = (http.address() as { port: number }).port;

  // The fake gateway: this harness's own child process (no unit, no job).
  gateway = spawn(node, [GATEWAY, join(run, "cdp.sock")], { stdio: ["ignore", "pipe", "inherit"] });
  track(gateway.pid, "fake gateway");
  const gwPort = await new Promise<number>((resolve, reject) => {
    createInterface({ input: gateway!.stdout! }).once("line", (l) => { try { resolve(JSON.parse(l).port); } catch (e) { reject(e); } });
    gateway!.once("exit", () => reject(new Error("the fake gateway ended")));
  });
  const gwUrl = `http://127.0.0.1:${gwPort}/mcp/${SCOPE}`;
  log(`the fake gateway (pid ${gateway.pid}) listens on 127.0.0.1:${gwPort}`);

  // The service, with the carrier's switch: --gateway-command and the test-only --test-gateway-pid.
  service = spawn(process.execPath, [BIN, "service", "--test", "--test-display", String(display), "--agent-door", join(run, "cdp.sock"), "--control-door", join(run, "control.sock"),
    "--daemon-command", join(dir, "daemon-command.json"), "--lists-folder", lists, "--state-folder", state, "--tools-dir", tools, "--test-chrome-source", join(dir, "source.json"), "--test-mcp-port", "0",
    "--gateway-command", join(dir, "gateway-command.json"), "--test-gateway-pid", String(gateway.pid)], { stdio: ["ignore", "ignore", "pipe"] });
  track(service.pid, "service");
  service.stderr!.on("data", (d) => { serviceErr += d; });
  let d: Door | null = null;
  for (let i = 0; i < 600 && !d; i++) {
    if (service.exitCode !== null) break;
    if (existsSync(join(run, "control.sock"))) d = await door().catch(() => null);
    if (!d) await sleep(20);
  }
  if (!d) throw new Error(`the control door did not open: ${serviceErr.slice(-800)}`);
  const hello = await d.next((l) => l.t === "hello");
  d.send({ t: "hello", v: 1, side: "daemon", version: "live", features: [] });
  const cfg = await req(d, "config", { kind: "daemon", user: "live", via: "config" }, { enabled: true, control: true, chrome_bin: null, chrome_args: [], display_size: "1280x900", idle_stop_minutes: 10 });
  if (!cfg.ok) throw new Error(`config: ${JSON.stringify(cfg)}`);
  const ss = await req(d, "set_sessions", DAEMON, { sessions: [], remote: [REMOTE_ITEM], box: BOX_FIELD });
  if (!ss.ok) throw new Error(`set_sessions: ${JSON.stringify(ss)}`);
  await until("the service's ready line", () => serviceErr.includes("service: ready"), 15_000);
  const st = (await req(d, "status", DAEMON)).data;
  check("1. the hello lists mcp_token and remote_scopes; status.remote names the remote item; the agent door has the carrier rule",
    hello.features.includes("mcp_token") && hello.features.includes("remote_scopes") && JSON.stringify(st.remote) === JSON.stringify([{ scope: SCOPE, box: BOX, list: LIST, mcp_token: true }]) && serviceErr.includes("the agent door has the carrier rule"),
    `features ${JSON.stringify(hello.features)}; status.remote ${JSON.stringify(st.remote)}; mcp ${st.mcp?.state}`);

  // ---------------------------------------------------------------- 2. initialize through the fake gateway
  const client = new sdk.Client({ name: "carrier-live", version: "0" }, {});
  const transport = new sdk.StreamableHTTPClientTransport(new URL(gwUrl), { requestInit: { headers: { Authorization: `Bearer ${REMOTE_TOKEN}` } } });
  await client.connect(transport);
  check("2. initialize through the fake gateway (the carrier's connection to the agent door)", typeof transport.sessionId === "string" && /^[0-9a-f]{32}$/.test(transport.sessionId), `Mcp-Session-Id ${transport.sessionId ? "given" : "missing"}`);

  // ---------------------------------------------------------------- 3. tools/list of a remote admission
  const names: string[] = (await client.listTools()).tools.map((t: any) => t.name);
  check("3. tools/list: no browser_sign_in, no browser_sign_ins, no PageFetch; browser_navigate is there",
    !names.includes("browser_sign_in") && !names.includes("browser_sign_ins") && !names.includes("PageFetch") && names.includes("browser_navigate"), `${names.length} tools`);

  // ---------------------------------------------------------------- 4. a navigation to a local page of the list
  const nav = await client.callTool({ name: "browser_navigate", arguments: { url: `http://app.localhost:${port}/` } }, undefined, { timeout: 180_000 });
  const navText = (nav.content ?? []).map((c: any) => c.text ?? "").join("\n");
  track(recordXvfb(), "xvfb");
  // The receiver must know the remote scope <box>/<session> (chrome-extension's C1, receiver 0.3.10): the note names the receiver's version.
  const ext = (await req(d, "status", DAEMON)).data.extension_version;
  soft("4. browser_navigate to a local page of the remote scope's list: the page loads", !nav.isError && navText.includes("page of app.localhost") && served.has("app.localhost"), `receiver ${ext}; ${navText.slice(0, 200).replace(/\s+/g, " ")}`);

  // ---------------------------------------------------------------- 5. a path argument is refused
  let refusal = "";
  try {
    const r = await client.callTool({ name: "browser_take_screenshot", arguments: { filename: "shot.png" } }, undefined, { timeout: 60_000 });
    refusal = `no refusal: ${JSON.stringify(r).slice(0, 200)}`;
  } catch (e) { refusal = String((e as Error).message); }
  soft("5. a path argument is refused (the -32602 of a remote admission)", refusal.includes("-32602") && refusal.includes(`${NA}: filename names a file, and a session of another box cannot name a file of this box.`), refusal.slice(0, 220));

  // ---------------------------------------------------------------- 6. a wrong token's 401 through the fake gateway
  const wrong = await fetch(gwUrl, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer abt1_${randomBytes(32).toString("base64url")}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "wrong", version: "0" } } }) });
  const wrongBody = await wrong.text();
  soft("6. a wrong token gets the third 401 of step 7 through the fake gateway, with WWW-Authenticate", wrong.status === 401 && wrongBody === UNKNOWN_TOKEN && wrong.headers.get("www-authenticate") === 'Bearer realm="agent-browser"', `${wrong.status} ${wrongBody}`);

  await transport.terminateSession().catch(() => {});
  await client.close();
  const leak = serviceErr.includes(REMOTE_TOKEN) || serviceErr.includes(REMOTE_ITEM.mcp_token);
  soft("no log line of the service holds the remote token or its fingerprint", !leak);
  const b = await req(d, "stop", TOKEN, {}, 30_000);
  d.s.end();
  log(`stop: ${b.ok ? "ok" : JSON.stringify(b)}`);
} catch (e) {
  code = 1;
  log(`FAIL: ${(e as Error).message}`);
  if (serviceErr) log(`the service's log (end):\n${serviceErr.slice(-3000)}`);
} finally {
  if (service && service.exitCode === null) {
    const s = service;
    const exited = new Promise<void>((r) => s.once("exit", () => r()));
    s.kill("SIGTERM");
    await Promise.race([exited, sleep(15_000)]);
  }
  gateway?.kill("SIGTERM");
  http.close();
  // Only the pids that this run started, with their recorded start times: SIGTERM, then SIGKILL.
  for (const sig of ["SIGTERM", "SIGKILL"] as const) {
    for (const [pid, start] of started) if (startOf(pid) === start) { try { process.kill(pid, sig); } catch {} }
    await sleep(2000);
  }
  const leftover = [...started].filter(([pid, start]) => startOf(pid) === start).map(([pid]) => pid);
  repo?.close();
  rmSync(dir, { recursive: true, force: true });
  log(`cleanup: ${leftover.length ? `still running: ${leftover.join(", ")}` : "no process of this run runs"}; the temp folder is ${existsSync(dir) ? "still there" : "removed"}; the display is ${existsSync(`/tmp/.X11-unix/X${display}`) ? "still held" : "free"}`);
  if (leftover.length) code = 1;
  if (results.some((r) => !r.ok)) code = 1;
  process.stdout.write(`${JSON.stringify({ passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length + (code && results.every((r) => r.ok) ? 1 : 0), seconds: Math.round((Date.now() - t0) / 1000) })}\n`);
  process.exit(code);
}
