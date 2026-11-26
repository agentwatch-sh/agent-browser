// The live check of the press and hold (board ab-t30.34; C11, the press and hold): the real service in `--test` mode
// with its MCP port (as test/live/mcp-live/check.ts: temp folders only, one display, the harness guard of
// test/live/README.md, a copy of the box's Chromium in the temp tools folder, nothing downloaded), and the local test
// page of page.ts on two local sites of this process only (app.localhost, and hold-frame.test, which Chrome maps to
// 127.0.0.1). Never a public site. The MCP client is the MCP SDK's own Client from the pinned playwright-core's bundle,
// with a test token that this run makes (only in the requests' Authorization header).
//
// The rows:
//   1. tools/list of the MCP session holds browser_press_hold;
//   2. for each button (on the page, in the cross-origin frame, in the closed shadow root: the host's ref) the MCP's
//      browser_press_hold: its answer is the done state; the page's log: the fill completed, the release came after the
//      check mark, every event isTrusted, the press's pressure 0.5, the hand's moves happened and stayed within 2 px of
//      the press point with the button down, no dragstart, no early release;
//   3. a Playwright client of the scope holds with mouse.down(), a wait of 3.5 s and mouse.up() on a 3 s fill: the hold
//      lasts the client's time, the fill completes, no hand moves of the stage, every event isTrusted.
//
// Run it under the box's heavy lock, on a free test display (never :90):
//   flock <heavy.lock> timeout -k 60 1500 node test/live/press-hold/check.ts --display 173

import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { GOOGLE_SOURCE, GoogleChromeTools } from "../../../src/service/unit/google-chrome.ts";
import { makeChromeRepo } from "../../chrome-fixture.ts";
import { harnessGuard, reservedDisplay } from "../guard.ts";
import { refOf } from "../mcp-live/measure.ts";
import { FRAME_HOST, framePage, MAIN_HOST, mainPage, readHold, type HoldLog } from "./page.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const BIN = join(ROOT, "bin", "agent-browser.js");
const sdk = createRequire(import.meta.url)(join(ROOT, "node_modules", "playwright-core", "lib", "utilsBundle.js"));
const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const fail2 = (why: string): never => { process.stderr.write(`press-hold: ${why}\n`); process.exit(2); };
const display = Number(arg("--display") ?? "173");
const refused = reservedDisplay(display, "--display");
if (!Number.isSafeInteger(display) || refused) fail2(refused ?? "--display must be a number");
if (existsSync(`/tmp/.X11-unix/X${display}`) || existsSync(`/tmp/.X${display}-lock`)) fail2(`:${display} is in use; this check runs on a free display only`);
const CHROMIUM_TREE = "/usr/lib/chromium";
const SCOPE = "live-ph";

const t0 = Date.now();
const log = (s: string) => process.stdout.write(`[${((Date.now() - t0) / 1000).toFixed(1)} s] ${s}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: { step: string; ok: boolean; note: string }[] = [];
/** A row that the next rows need: a failure ends the run. */
const check = (step: string, ok: boolean, note = "") => { results.push({ step, ok, note }); log(`${ok ? "PASS" : "FAIL"} ${step}${note ? `: ${note}` : ""}`); if (!ok) throw new Error(`${step} failed${note ? `: ${note}` : ""}`); };
/** A row whose failure leaves the next rows as they are: the run goes on, and it exits 1 at its end. */
const soft = (step: string, ok: boolean, note = "") => { results.push({ step, ok, note }); log(`${ok ? "PASS" : "FAIL"} ${step}${note ? `: ${note}` : ""}`); };
const until = async (what: string, f: () => boolean, ms: number) => { const end = Date.now() + ms; while (!f()) { if (Date.now() > end) throw new Error(`${what}: not in ${ms / 1000} s`); await sleep(100); } };

function proc(pid: number): { start: number; ppid: number } | null {
  try {
    const st = readFileSync(`/proc/${pid}/stat`, "latin1");
    const f = st.slice(st.lastIndexOf(")") + 2).split(" ");
    if (["Z", "X"].includes(f[0])) return null;
    return { start: Number(f[19]), ppid: Number(f[1]) };
  } catch { return null; }
}
const me = proc(process.pid)!;

const guard = await harnessGuard("press-hold");
const dir = mkdtempSync(join(tmpdir(), "ab-press-hold-live-"));
const run = join(dir, "run"), state = join(dir, "state"), tools = join(dir, "tools"), lists = join(dir, "lists");
mkdirSync(run, { mode: 0o700 });
mkdirSync(lists, { mode: 0o700 });
const started = new Map<number, number>();
let service: ChildProcess | null = null;
let serviceErr = "";
let repo: ReturnType<typeof makeChromeRepo> | null = null;
function track(pid: number | null | undefined, name: string): void {
  if (!pid || started.has(pid)) return;
  const p = proc(pid);
  if (p) { started.set(pid, p.start); guard.track(pid, name); }
}
const recordXvfb = () => { try { return JSON.parse(readFileSync(join(state, "unit.json"), "utf8")).xvfb_pid as number | null; } catch { return null; } };

// ------------------------------------------------------------------ the test page (two local sites of this process)
const logs = new Map<string, HoldLog>();
let drags = 0;
const http = createServer((req, res) => {
  const host = String(req.headers.host ?? "").split(":")[0];
  const path = (req.url ?? "/").split("?")[0];
  const port = (http.address() as { port: number }).port;
  const page = (body: string) => res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }).end(body);
  if (req.method === "POST" && path.startsWith("/log/")) {
    let b = "";
    req.on("data", (d) => { b += d; });
    req.on("end", () => {
      const id = path.slice(5);
      if (id === "drag") drags++;
      else { try { logs.set(id, JSON.parse(b)); } catch {} }
      res.writeHead(204, { "Access-Control-Allow-Origin": "*" }).end();
    });
    return;
  }
  if (host === MAIN_HOST && path === "/hold") return page(mainPage(port));
  if (host === FRAME_HOST && path === "/frame") return page(framePage());
  if (path === "/favicon.ico") return res.writeHead(404).end();
  res.writeHead(404, { "Cache-Control": "no-store" }).end("no such page");
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
const TOKEN = { kind: "token", user: "live", via: "cli" }, DAEMON = { kind: "daemon", user: "live", via: "daemon" };
const TOKEN_MCP = `abt1_${randomBytes(32).toString("base64url")}`;
const SESSION = { scope: SCOPE, repo: "local/test", roots: [{ pid: process.pid, start: me.start }], cgroup: null, lifetime_id: "lt-live", mcp_token: createHash("sha256").update(TOKEN_MCP, "ascii").digest("hex") };

async function stopService(): Promise<number | null> {
  const s = service;
  if (!s || s.exitCode !== null) return s?.exitCode ?? null;
  const exited = new Promise<number | null>((r) => s.once("exit", (c) => r(c)));
  s.kill("SIGTERM");
  return Promise.race([exited, sleep(15_000).then(() => { s.kill("SIGKILL"); return -1; })]);
}

type Client = { client: any; transport: any; call: (name: string, a?: Record<string, unknown>) => Promise<{ text: string; isError: boolean }> };
async function mcpClient(url: string): Promise<Client> {
  const client = new sdk.Client({ name: "press-hold-live", version: "0" }, {});
  const transport = new sdk.StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${TOKEN_MCP}` } } });
  await client.connect(transport);
  return {
    client, transport,
    call: async (tool, a = {}) => {
      let r;
      try { r = await client.callTool({ name: tool, arguments: a }, undefined, { timeout: 120_000 }); }
      catch (e) { return { text: String((e as Error)?.message ?? e), isError: true }; }
      const text = (r.content as { type: string; text?: string }[]).filter((c) => c.type === "text").map((c) => c.text).join("\n");
      return { text, isError: r.isError === true || /^### Error/m.test(text) };
    },
  };
}

/** The log of widget `id` once it has the release (the page sends it at each release), at most `ms`. */
async function logOf(id: string, ms = 10_000): Promise<HoldLog | null> {
  const end = Date.now() + ms;
  while (Date.now() < end) { const l = logs.get(id); if (l && l.states.some((s) => s.s.startsWith("released"))) return l; await sleep(100); }
  return logs.get(id) ?? null;
}

let code = 0;
try {
  const argv = readFileSync("/proc/self/cmdline", "utf8").split("\0").filter((x, i, a) => i < a.length - 1 || x !== "");
  writeFileSync(join(dir, "daemon-command.json"), JSON.stringify({ v: 1, interpreter: realpathSync(process.execPath), args: argv.slice(1) }), { mode: 0o600 });
  repo = makeChromeRepo({ version: "158.0.7100.1-1", chrome: `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "Google Chrome 158.0.7100.1 "; exit 0; fi\nexec "$(dirname "$0")/chromium" "$@"\n` });
  writeFileSync(join(dir, "source.json"), JSON.stringify({ repo: repo.repo, key: repo.keyFile, fingerprints: [repo.fingerprint] }));
  chmodSync(dir, 0o700);
  const installer = new GoogleChromeTools({ tools, source: { ...GOOGLE_SOURCE, repo: repo.repo, keyFile: repo.keyFile, fingerprints: [repo.fingerprint] }, log: (l) => log(`installer: ${l}`) });
  const copy = await installer.ensure();
  for (const e of readdirSync(CHROMIUM_TREE)) cpSync(join(CHROMIUM_TREE, e), join(copy.binary, "..", e), { recursive: true, force: true });
  check("the copy of Google Chrome in the temp tools folder holds the Chromium tree", existsSync(join(copy.binary, "..", "chromium")) && statSync(copy.binary).isFile());
  writeFileSync(join(lists, "local.test.json"), JSON.stringify({ allow: [MAIN_HOST, FRAME_HOST], repo: "local/test" }), { mode: 0o600 });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
  const port = (http.address() as { port: number }).port;
  const pageUrl = (q = "") => `http://${MAIN_HOST}:${port}/hold${q}`;

  // The service with its MCP port; the daemon's config maps the frame's site to this server.
  service = spawn(process.execPath, [BIN, "service", "--test", "--test-display", String(display), "--agent-door", join(run, "cdp.sock"), "--control-door", join(run, "control.sock"),
    "--daemon-command", join(dir, "daemon-command.json"), "--lists-folder", lists, "--state-folder", state, "--tools-dir", tools, "--test-chrome-source", join(dir, "source.json"), "--test-mcp-port", "0"],
    { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, AGENT_BROWSER_POINTER_LOG: "1" } });
  track(service.pid, "service");
  service.stderr!.on("data", (x) => { serviceErr += x; });
  let d: Door | null = null;
  for (let i = 0; i < 600 && !d; i++) {
    if (service.exitCode !== null) break;
    if (existsSync(join(run, "control.sock"))) d = await door().catch(() => null);
    if (!d) await sleep(20);
  }
  if (!d) throw new Error(`the control door did not open: ${serviceErr.slice(-800)}`);
  const hello = await d.next((l) => l.t === "hello");
  if (hello.side !== "service") throw new Error(`no hello: ${JSON.stringify(d.lines)}`);
  d.send({ t: "hello", v: 1, side: "daemon", version: "live", features: [] });
  const cfg = await req(d, "config", { kind: "daemon", user: "live", via: "config" }, { enabled: true, control: true, chrome_bin: null, chrome_args: [`--host-resolver-rules=MAP ${FRAME_HOST} 127.0.0.1`], display_size: "1280x900", idle_stop_minutes: 10 });
  if (!cfg.ok) throw new Error(`config: ${JSON.stringify(cfg)}`);
  const ss = await req(d, "set_sessions", DAEMON, { sessions: [SESSION], remote: [], box: { hosts: ["box.localhost"], cookie_names: [] } });
  if (!ss.ok) throw new Error(`set_sessions: ${JSON.stringify(ss)}`);
  await until("the service's ready line", () => serviceErr.includes("service: ready"), 30_000);
  const st = (await req(d, "status", DAEMON)).data;
  const mcpUrl = `http://${st.mcp?.address}/mcp/${SCOPE}`;
  check("the service runs with its MCP port", st.mcp?.state === "ready", JSON.stringify(st.mcp));

  // 1. tools/list, and the page.
  const a = await mcpClient(mcpUrl);
  const nav = await a.call("browser_navigate", { url: pageUrl() });
  check("browser_navigate opens the local test page (Chrome starts at the first use)", !nav.isError && nav.text.includes(`press and hold of ${MAIN_HOST}`), nav.text.slice(0, 160).replace(/\n/g, " "));
  const names = ((await a.client.listTools()).tools as { name: string }[]).map((t) => t.name);
  check("1. tools/list holds browser_press_hold", names.includes("browser_press_hold"), `${names.length} tools; the last: ${names.slice(-3).join(", ")}`);
  let snap = "";
  for (let i = 0; i < 20; i++) { snap = (await a.call("browser_snapshot")).text; if (/Press & Hold \(frame\)/.test(snap)) break; await sleep(500); }
  const refs = { main: refOf(snap, "button", "Press & Hold (main)"), frame: refOf(snap, "button", "Press & Hold (frame)"), shadow: refOf(snap, "button", "Press & Hold (shadow)") };
  check("the snapshot gives a ref for each button (the frame's with its frame's mark, the closed shadow root's host)", !!refs.main && !!refs.frame && /^f\d+e\d+$/.test(refs.frame ?? "") && !!refs.shadow, JSON.stringify(refs));

  // 2. The MCP's hold of each button.
  for (const id of ["main", "frame", "shadow"] as const) {
    const n0 = serviceErr.length;
    const t1 = Date.now();
    const r = await a.call("browser_press_hold", { element: `Press & Hold (${id})`, ref: refs[id]! });
    const ms = Date.now() - t1;
    const l = await logOf(id);
    const line = serviceErr.slice(n0).split("\n").find((x) => x.includes("a press and hold")) ?? "";
    if (!l) { soft(`2. ${id}: the page's log came`, false, `the answer: ${r.text}`); continue; }
    const h = readHold(l);
    const held = h.down && h.up !== null ? Math.round(h.up - h.down.t) : null;
    const afterDone = h.done !== null && h.up !== null ? Math.round(h.up - h.done) : null;
    const pause = h.down && h.lastMoveBeforeDown !== null ? Math.round(h.down.t - h.lastMoveBeforeDown) : null;
    const note = `the answer: ${r.text}; ${ms} ms; the fill ${l.fillMs} ms; the page: held ${held} ms, the release ${afterDone} ms after the check mark, ${h.moves.length} moves (farthest ${h.farthest.toFixed(2)} px), the pause ${pause} ms, the press ${h.down ? Math.round(h.down.t) : "?"} ms after the load; ${l.events.length} events; log: ${line.replace(/^.*mcp: /, "")}`;
    soft(`2. ${id}: browser_press_hold answers the done state, and the page's fill completed before the release`, !r.isError && r.text.startsWith("Done: the hold lasted ") && r.text.endsWith("it ended when the element changed and then stayed the same.") && h.done !== null && h.afterDone && h.early === 0 && !h.drained, note);
    soft(`2. ${id}: every event isTrusted, and the press has the pressure 0.5`, h.allTrusted && h.downPressure === 0.5, `${l.events.filter((e) => !e.trusted).length} untrusted of ${l.events.length}; the press's pressure ${h.downPressure}`);
    soft(`2. ${id}: the hand moved with the button down, each move within 2 px of the press point; no drag started`, h.moves.length >= 1 && h.farthest <= 2 + 1e-9 && h.moves.every((m) => m.buttons === 1) && h.drags === 0 && drags === 0,
      `${h.moves.length} moves, farthest ${h.farthest.toFixed(2)} px, buttons ${[...new Set(h.moves.map((m) => m.buttons))].join("/")}, pressures ${[...new Set(h.moves.map((m) => m.pressure))].join("/")}; dragstart ${h.drags} (page) ${drags} (document)`);
    soft(`2. ${id}: the release came 150 to 400 ms after the done state (the done state: 300 ms of the same pixels after the check mark)`, afterDone !== null && afterDone >= 300 + 150 && afterDone <= 300 + 400 + 250, `${afterDone} ms after the check mark`);
  }

  // 3. A Playwright client's own hold: mouse.down(), a wait of 3.5 s, mouse.up() on a fill of 3 s.
  const url = (await req(d, "endpoint", DAEMON, { scope: SCOPE })).data.url as string;
  const pw = await chromium.connectOverCDP(url, { timeout: 30_000 });
  try {
    const page = await pw.contexts()[0].newPage();
    logs.delete("main");
    await page.goto(pageUrl("?fill=3000"));
    const box = await page.locator("#hold-main").boundingBox();
    if (!box) throw new Error("no box of the main button");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const tw = Date.now();
    await page.mouse.down();
    await page.waitForTimeout(3500);
    await page.mouse.up();
    const wall = Date.now() - tw;
    const l = await logOf("main");
    const h = l ? readHold(l) : null;
    const held = h?.down && h.up !== null ? Math.round(h.up - h.down.t) : null;
    soft("3. Playwright's mouse.down(), a wait of 3.5 s and mouse.up() hold for the client's time through the stage: the fill of 3 s completes, the release after the check mark",
      !!h && l!.fillMs === 3000 && h.done !== null && h.afterDone && held !== null && held >= 3400 && held <= 4500, `the page: held ${held} ms (the client's ${wall} ms from down() to up()'s end), done ${h?.done !== null}, early ${h?.early}`);
    soft("3. Playwright's hold: every event isTrusted, the pressure 0.5, no hand moves of the stage (a client's own hold), no drag", !!h && h.allTrusted && h.downPressure === 0.5 && h.moves.length === 0 && h.drags === 0, `${h?.moves.length} moves; ${l?.events.length} events`);
    await page.close();
  } finally { await pw.close().catch(() => {}); }

  await a.transport.terminateSession().catch(() => {});
  await a.client.close().catch(() => {});
  const e5 = await req(d, "session_ended", DAEMON, { scope: SCOPE });
  const b6 = await req(d, "stop", TOKEN, {}, 30_000);
  d.s.end();
  const exit = await stopService();
  soft("the session's end, the stop and the service's exit", e5.ok === true && b6.ok === true && exit === 0, `exit ${exit}`);
  soft("the display is free again", !existsSync(`/tmp/.X11-unix/X${display}`));
} catch (e) {
  code = 1;
  log(`FAIL: ${(e as Error).message}`);
  if (serviceErr) log(`the service's log (end):\n${serviceErr.slice(-3000)}`);
} finally {
  await stopService();
  http.close();
  for (const sig of ["SIGTERM", "SIGKILL"] as const) {
    for (const [pid, start] of started) if (proc(pid)?.start === start) { try { process.kill(pid, sig); } catch {} }
    await sleep(2000);
  }
  const leftover = [...started].filter(([pid, start]) => proc(pid)?.start === start).map(([pid]) => pid);
  repo?.close();
  rmSync(dir, { recursive: true, force: true });
  log(`cleanup: ${leftover.length ? `still running: ${leftover.join(", ")}` : "no process of this run runs"}; the temp folder is ${existsSync(dir) ? "still there" : "removed"}`);
  if (leftover.length) code = 1;
  const failedRows = results.filter((r) => !r.ok).length;
  if (failedRows) code = 1;
  process.stdout.write(`${JSON.stringify({ passed: results.filter((r) => r.ok).length, failed: failedRows + (code && failedRows === 0 ? 1 : 0), seconds: Math.round((Date.now() - t0) / 1000) })}\n`);
  process.exit(code);
}
