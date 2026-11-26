// The Mac sign-in window probe (board ab-v16.97.14, part 1; the companion design note
// docs/superpowers/specs/2026-11-26-stored-sign-ins-mac-design.md, D1, D2 and D4; section 13 row 11 of
// docs/superpowers/specs/2026-11-10-stored-sign-in-credentials-design.md). On Linux the sign-in act moves its window
// outside the screen at the X level. The Mac has no X, and the receiver cannot place a window outside the screen (the
// 50% rule). ONE on-screen run on the Mac measures what the design cannot read from the code:
//
//   taskport  `security authorizationdb read system.privilege.taskport` (read only): the right's class, rule, group,
//             authenticate-user, shared and timeout, and what they mean for a debugger of the same user (parts.ts,
//             parseTaskport). No comment, date, path or name goes into the JSON.
//   rights    whether a program that an agent's shell runs holds the Screen Recording and the Accessibility rights
//             (helper.ts: CGPreflightScreenCaptureAccess and AXIsProcessTrusted, the two reads that Apple documents as
//             reads with no prompt; the calls that can prompt are never made).
//   runs A, B the probe's OWN Google Chrome (the app's binary, a second instance on a NEW temp profile: never the
//             operator's Chrome, the agent profile or the service), with the agent's flags (run A) and with them but
//             --disable-backgrounding-occluded-windows (run B, the sensor: its page's visibility gives macOS's own
//             occlusion), the CDP pipe (--remote-debugging-pipe), a mock keychain and no crash reporter
//             (--disable-breakpad). Run A measures the options of parts.ts (RUN_OPTIONS.A: on the screen, minimized by
//             CDP, behind a cover window, half outside the edge; and by a test extension with chrome.windows, the
//             receiver's own call: created minimized, and created with focused false while a cover window is in front),
//             run B the ones whose sensor facts the summary reads (RUN_OPTIONS.B), on a LOCAL page of its own
//             (127.0.0.1): the window's state and bounds, and its own incognito flag (windows.get); the page's
//             visibility, focus, rAF and 10 ms timer counts and an IntersectionObserver; then the act's input path (CDP
//             Input: a click on the field, the plain test text "probe text 42" as key events, and " xyz" by
//             Input.insertText) and what the page got, with the keys that came while the page was hidden; and for the
//             extension's options whether the window's creation took the front from another app. The test extension
//             comes by CDP's Extensions.loadUnpacked (Chrome's documented path for an unpacked extension with
//             --enable-unsafe-extension-debugging and the pipe), after the probe turns developer mode on in its own
//             temp profile (chrome://extensions' own call). Run A's profile holds the Linux service's write of the
//             incognito allow before the start (D3: does it hold?), run B's none; with no allow at the load the probe
//             gives it as the operator's switch does (chrome://extensions' developerPrivate.updateExtensionConfiguration
//             with incognitoAccess true), so that the act window's own form, an incognito window, is what it measures.
//             When the extension does not load, its options are skipped and the CDP options still run. The extension's
//             rule check: windows.create with half the window outside the screen, with three quarters outside, and
//             minimized with bounds.
//   summary   the verdicts of each option and the pick of the design's rule (parts.ts, summaryOf): a fact that is not
//             measured gives "not measured", never a pass.
//
// The front app: before its Chrome starts the probe reads the app in front (its pid only), and after the start and after
// each window's create, when its Chrome took the front, it asks macOS to activate that app again: the service's give-back
// calls (src/giveback.ts: NSWorkspace's frontmostApplication and NSRunningApplication's activateWithOptions, through
// osascript's JavaScript bridge; no Apple Event, no input, no System Events, measured with no prompt on 2026-11-04), at
// most GIVE_BACK_MAX asks in each run. The JSON names no app: only "chrome" (the probe's), "other" or "none".
//
// It writes no file outside its temp folder (mkdtemp in the temp folder of the system, mode 0700), and it changes no
// setting: no DevToolsSecurity change, no sudo, no keychain, no TCC change and no prompt. What Chrome itself can write
// outside the profile is not the probe's (assumed, not measured): its macOS defaults (com.google.Chrome, shared with the
// operator's Chrome), and a crash database under the default user-data folder when its crash reporter runs in spite of
// --disable-breakpad. A crash handler of the probe's Chrome calls setsid, so the group kill does not reach it: the probe
// looks for one by ps (its parent is the probe's Chrome, and it is not older than it) and stops it after its Chrome when
// it is still the same process. On the Mac, Crashpad starts its handler through a second fork (its parent is launchd), so
// that find sees none there: with --disable-breakpad none is expected, and one that runs anyway is left (a stated limit). It opens no public site: the pages are its own, on 127.0.0.1 only. It types no secret: only the
// plain test text. At its end, after an error, at its time limit (TIME_LIMIT_MS) and at a SIGTERM, SIGINT or SIGHUP
// (test/temp-dirs.ts) it stops its Chrome (Browser.close, then SIGTERM and SIGKILL of its process group), its crash
// handler and every tool, closes its page server and removes its folder.
//
//   node test/live/mac-signin-window-probe/probe.ts
//
// On Linux the probe makes its folder, the extension and its page server, checks the server (the pages, a wrong Host,
// a missing path), runs its pipe client against a stand-in browser (a Node script on the pipe's fds) and stops it both
// ways (Browser.close, and the kill of one that stays), cleans up, and answers ok false: not the Mac. Two seams, on Linux
// only: AB_SIGNIN_PROBE_TWIN_DISPLAY=<n> runs the Mac's Chrome flow with /usr/bin/chromium on a private Xvfb of display
// <n> under the harness guard (test/live/README.md, rule 1 and 2): never a measure of the Mac; it checks the flow.
// AB_SIGNIN_PROBE_DRY_HOLD=<ms> (the cleanup test) sets the time limit to <ms> and holds the dry run with a stand-in that
// stays, so that the time limit or a signal ends the run through its synchronous cleanup.
//
// Output: one JSON document on stdout (parts.ts, resultOf), with no path, no argv, no environment, no login name, no URL
// and no title of another app's window: only classes, numbers and fixed words; the result's check refuses every `/`,
// `\` and `@`, and its scrub takes out the home folder, the login name and the temp folders. A value that still fails the
// check is masked, and `detail` names its place (maskResult). Exit: 0 when the probe ran and printed (ok true or false
// inside); 1 at its time limit or an uncaught error (the JSON still prints), and when the result fails its own check; 2
// for an argument (it takes none) or a refused seam. The helper needs node:ffi: Node 26.1 or later. `npm test` runs its
// pure parts, its Linux dry run and its cleanup at the time limit and at a signal (test/mac-signin-window-probe.test.ts).

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { homedir, release, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { atEnd, done } from "../../temp-dirs.ts";
import { harnessGuard, reservedDisplay, type HarnessGuard } from "../guard.ts";
import {
  ACT_BOUNDS, CALL_MS, CHROME_START_MS, CLOSE_WAIT_MS, EXPECTED_TEXT, EXTENSION_SW, FIELD_CENTRE, FRONT_JXA, GIVE_BACK_JXA, GIVE_BACK_MAX, HANGS_MAX,
  INPUT_CALL_MS, INSERT_TEXT, KEY_GAP_MS, KEY_HOLD_MS, LINUX_CHROMIUM, MAC_CHROME, MEASURE_MS, OPTION_MIN_MS, OSASCRIPT, PAGE_WAIT_MS,
  PROBE_VERSION, QUICK_MS, RESERVE_MS, RUN_MIN_MS, RUN_OPTIONS, SECURITY, SETTLE_MS, STANDIN_BROWSER, TASKPORT_RIGHT, TEST_TEXT, TEXT_MAX, TIME_LIMIT_MS, TWIN_ENV,
  HOLD_ENV, crashpadOf, holdMs, maskResult, parsePs, sameHandler, type PsRow,
  boundsJson, callErrorClass, checkResult, chromeArgs, chromeVersionOf, clean, entryFacts, extensionIdOf, extensionManifest, extWindowJson, frontOf, frontPid,
  giveBackOf, jxaArgs, keyEvents, measureJson, pageFor, parseRights, parseTaskport, prefsBefore, resultOf, runClass, scrub, splitFrames, summaryOf, tookFront,
  typedJson, windowErrorClass,
  type Meta, type OptionJson, type OptionName, type Platform, type RunName, type ToolRun,
} from "./parts.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const HELPER = fileURLToPath(new URL("./helper.ts", import.meta.url));
const t0 = Date.now();
const elapsed = () => Date.now() - t0;
/** The cleanup test's seam (Linux only, never with the twin): its text, and its time limit when the text is valid. */
const HOLD = process.platform === "linux" && process.env[HOLD_ENV] !== undefined ? process.env[HOLD_ENV]! : null;
const HOLD_MS = HOLD !== null ? holdMs(HOLD) : null;
/** The run's time limit: TIME_LIMIT_MS, or the hold seam's. */
const LIMIT_MS = HOLD_MS ?? TIME_LIMIT_MS;
/** The time that a step may still take before the run's cleanup reserve. */
const timeLeft = () => LIMIT_MS - RESERVE_MS - elapsed();
const NEAR = "the run's time limit is near";
const MAC = process.platform === "darwin";
/** The Linux twin's display (the seam), or null. */
const TWIN = process.platform === "linux" && process.env[TWIN_ENV] !== undefined ? process.env[TWIN_ENV]! : null;

// ------------------------------------------------------------------ the run's state (the stops of a crash read it)

let meta: Meta = { version: PROBE_VERSION, commit: "unknown", dirty: null };
let platform: Platform | null = null;
let stage = "args";
let dir: string | null = null;
let server: Server | null = null;
let port = 0;
const words: string[] = [];
/** The probe's Chromes (and the dry run's stand-ins), each the leader of its own process group; the tools that run now. */
const chromes = new Set<ChildProcess>();
const tools = new Set<ChildProcess>();
let chromeStarts = 0, toolRuns = 0, killedGroups = 0;
let xvfb: ChildProcess | null = null;
let guard: HarnessGuard | null = null;
let taskport: Record<string, unknown> | null = null;
let rights: Record<string, unknown> | null = null;
let chrome: Record<string, unknown> | null = null;
const runs: Partial<Record<RunName, Record<string, any>>> = {};
let summary: Record<string, unknown> | null = null;
let dry: Record<string, unknown> | null = null;
let printed = false;
/** The crash handlers of the probe's Chromes (parts.ts, crashpadOf): each pid and its age at its find. */
const handlers = new Map<number, number>();
const PS = "/bin/ps", PS_ARGS = ["-A", "-o", "pid=,ppid=,etime=,comm="], PS_MAX = 4 << 20;
let extId = "";
let extDir = "";

/** Print the result once, after its scrub and check; exit with `code` when stdout has it. */
function finish(o: { ok: boolean; reason: string | null; detail?: string | null; cleanup?: unknown }, code: number): void {
  if (printed) return;
  printed = true;
  const r = resultOf({ meta, platform, ok: o.ok, stage, reason: o.reason, detail: o.detail ?? null, ms: elapsed(), taskport, rights, chrome, runs: Object.keys(runs).length ? runs : null, summary, dry, cleanup: o.cleanup ?? null });
  const s = scrub(r, words);
  let out: Record<string, unknown> = { ...s.value, redacted: s.count };
  const bad = checkResult(out);
  if (bad) {
    // One bad value costs only that value (m7): the check's mask, and the places that it masked; a result that still
    // fails (its keys, its size) is replaced by the short form.
    const m = maskResult(out);
    const places = m.masked.join(", ").replace(/[^A-Za-z0-9 _.,<>\[\]]/g, "").slice(0, 240);
    const masked = { ...m.value, ok: false, detail: `the check masked: ${places}` };
    out = checkResult(masked) === null ? masked
      : { ...resultOf({ meta, platform, ok: false, stage: "output", reason: "the result failed its check", detail: `the value at ${bad}`.replace(/[^A-Za-z0-9 .<>\[\]]/g, ""), ms: elapsed(), cleanup: o.cleanup ?? null }), redacted: s.count };
    code = 1;
  }
  setTimeout(() => process.exit(code), 2000).unref();
  process.stdout.write(`${JSON.stringify(out)}\n`, () => process.exit(code));
}

const running = (c: ChildProcess) => c.exitCode === null && c.signalCode === null;
/** A signal to the process group of `c` (a leader: detached), then to `c` itself; true when the group still had a process. */
function signalGroup(c: ChildProcess, sig: NodeJS.Signals): boolean {
  let had = false;
  if (c.pid) { try { process.kill(-c.pid, sig); had = true; } catch {} }
  try { c.kill(sig); } catch {}
  return had;
}

/** The synchronous end (a crash, the time limit, a signal): kill each Chrome, tool and Xvfb that is left, close the server, remove the folder. */
function cleanupSync(): { left: number; folderRemoved: boolean | null } {
  let left = 0;
  for (const c of chromes) { if (running(c)) left++; if (signalGroup(c, "SIGKILL")) killedGroups++; }
  for (const c of tools) { left++; signalGroup(c, "SIGKILL"); }
  if (xvfb && running(xvfb)) { left++; try { xvfb.kill("SIGKILL"); } catch {} }
  // A crash handler of the probe's Chrome (it calls setsid: the group kill does not reach it), only while it is the same process.
  if (handlers.size) {
    let rows: PsRow[] = [];
    try { rows = parsePs(execFileSync(PS, PS_ARGS, { encoding: "utf8", timeout: 2000, maxBuffer: PS_MAX, stdio: ["ignore", "pipe", "ignore"] })); } catch {}
    for (const [pid, age] of handlers) if (sameHandler(rows, pid, age)) { left++; try { process.kill(pid, "SIGKILL"); } catch {} }
  }
  try { server?.close(); server?.closeAllConnections(); } catch {}
  let folderRemoved: boolean | null = null;
  if (dir) { try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch {} folderRemoved = !existsSync(dir); done(dir); }
  return { left, folderRemoved };
}

process.on("uncaughtException", (e) => crash(e));
process.on("unhandledRejection", (e) => crash(e));
function crash(e: unknown): void {
  if (printed) return;
  const c = cleanupSync();
  const kind = e instanceof Error && /^[A-Za-z]{1,40}$/.test(e.name) ? e.name : "Value";
  finish({ ok: false, reason: "an uncaught error stopped the probe", detail: `an uncaught ${kind}`, cleanup: { atStop: true, leftAtStop: c.left, folderRemoved: c.folderRemoved } }, 1);
}
const hardTimer = setTimeout(() => {
  const c = cleanupSync();
  finish({ ok: false, reason: `the time limit of ${LIMIT_MS / 1000} s for the whole run`, cleanup: { atStop: true, leftAtStop: c.left, folderRemoved: c.folderRemoved } }, 1);
}, LIMIT_MS);
hardTimer.unref();

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ------------------------------------------------------------------ the tools

/**
 * One run of a tool: its own process group (detached), stdin from /dev/null, the first TEXT_MAX characters of its stdout
 * and of its stderr (for its parse only: the text never leaves the probe), and SIGKILL of its group at `ms`.
 */
function runTool(cmd: string, args: readonly string[], ms: number, textMax = TEXT_MAX): Promise<ToolRun> {
  const start = Date.now();
  return new Promise((resolve) => {
    let stdout = "", stderr = "", timedOut = false, settled = false;
    let exit: number | null = null, signal: string | null = null;
    let c: ChildProcess;
    const settle = (r: { exit: number | null; signal: string | null; spawnError: string | null }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      tools.delete(c);
      resolve({ ...r, timedOut, stopped: null, stdout, stderr, ms: Date.now() - start });
    };
    const timer = setTimeout(() => { timedOut = true; signalGroup(c, "SIGKILL"); setTimeout(() => settle({ exit, signal, spawnError: null }), 1000).unref(); }, ms);
    try { c = spawn(cmd, args, { cwd: dir ?? tmpdir(), detached: true, stdio: ["ignore", "pipe", "pipe"] }); }
    catch (e) { clearTimeout(timer); return resolve({ exit: null, signal: null, timedOut: false, stopped: null, spawnError: (e as { code?: string }).code ?? "error", stdout: "", stderr: "", ms: 0 }); }
    tools.add(c);
    toolRuns++;
    c.stdout!.on("data", (d: Buffer) => { if (stdout.length < textMax) stdout += d.toString("utf8").slice(0, textMax - stdout.length); });
    c.stderr!.on("data", (d: Buffer) => { if (stderr.length < TEXT_MAX) stderr += d.toString("utf8").slice(0, TEXT_MAX - stderr.length); });
    c.on("error", (e) => settle({ exit: null, signal: null, spawnError: (e as { code?: string }).code ?? "error" }));
    c.on("exit", (code, sig) => { exit = code; signal = sig; setTimeout(() => settle({ exit, signal, spawnError: null }), 1000).unref(); });
    c.on("close", (code, sig) => settle({ exit: code ?? exit, signal: sig ?? signal, spawnError: null }));
  });
}

/** A short read as JSON: its class, exit code and time, never its text. */
const runJson = (r: ToolRun) => ({ class: runClass(r), exit: r.exit, ms: r.ms });

/** The probe's commit: its checkout's HEAD, and whether a tracked file differs from it. Read only. */
function readMeta(): Meta {
  const git = (args: string[]) => {
    try { return execFileSync("git", ["--no-optional-locks", "-C", ROOT, ...args], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; }
  };
  const head = git(["rev-parse", "HEAD"]), status = git(["status", "--porcelain", "--untracked-files=no"]);
  return { version: PROBE_VERSION, commit: head && /^[0-9a-f]{40}$/.test(head) ? head : "unknown", dirty: status === null ? null : status.length > 0 };
}

// ------------------------------------------------------------------ the CDP pipe

class CallError extends Error {}

/** A CDP client on Chrome's pipe (--remote-debugging-pipe: fd 3 to Chrome, fd 4 from it; each message JSON and a NUL). */
class Pipe {
  private next = 1;
  private readonly waits = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private rest: Buffer = Buffer.alloc(0);
  closed = false;
  private readonly w: Writable;
  constructor(w: Writable, r: Readable) {
    this.w = w;
    w.on("error", () => this.close());
    r.on("error", () => this.close());
    r.on("close", () => this.close());
    r.on("data", (d: Buffer) => {
      let s: { frames: string[]; rest: Buffer };
      try { s = splitFrames(this.rest, d); } catch { this.close(); return; }
      this.rest = s.rest;
      for (const f of s.frames) this.frame(f);
    });
  }
  private frame(text: string): void {
    let m: any;
    try { m = JSON.parse(text); } catch { return; }
    if (typeof m?.id !== "number") return; // an event: the probe reads none
    const w = this.waits.get(m.id);
    if (!w) return;
    this.waits.delete(m.id);
    clearTimeout(w.timer);
    if (m.error) w.reject(new CallError(String(m.error?.message ?? "error")));
    else w.resolve(m.result ?? {});
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const w of this.waits.values()) { clearTimeout(w.timer); w.reject(new CallError("the pipe closed")); }
    this.waits.clear();
  }
  send(method: string, params: object = {}, sessionId?: string, ms = CALL_MS): Promise<any> {
    if (this.closed) return Promise.reject(new CallError("the pipe closed"));
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waits.delete(id); reject(new CallError("timeout")); }, ms);
      this.waits.set(id, { resolve, reject, timer });
      try { this.w.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`); }
      catch { this.waits.delete(id); clearTimeout(timer); reject(new CallError("the pipe closed")); }
    });
  }
}

/** Start a program on the pipe's fds 3 and 4, as the leader of its own process group. */
function startOnPipe(bin: string, args: string[], env: NodeJS.ProcessEnv): { c: ChildProcess; pipe: Pipe } {
  const c = spawn(bin, args, { cwd: dir!, detached: true, stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"], env });
  chromes.add(c);
  chromeStarts++;
  c.on("error", () => {});
  guard?.track(c.pid, "chromium");
  return { c, pipe: new Pipe(c.stdio[3] as Writable, c.stdio[4] as Readable) };
}

/**
 * The end of a Chrome (or a stand-in): Browser.close and a wait of `waitMs` for its exit; else SIGTERM of its group, a
 * wait of 2 s, SIGKILL. Then a SIGKILL of the group for a helper that is left. "closed", "terminated", "killed" or "gone".
 */
async function stopChrome(c: ChildProcess, pipe: Pipe, waitMs = CLOSE_WAIT_MS): Promise<{ how: string; groupLeft: boolean }> {
  let how = "gone";
  if (running(c)) {
    await pipe.send("Browser.close", {}, undefined, Math.min(3000, waitMs)).catch(() => {});
    const end = Date.now() + waitMs;
    while (running(c) && Date.now() < end) await sleep(50);
    how = "closed";
    if (running(c)) {
      signalGroup(c, "SIGTERM");
      const end2 = Date.now() + 2000;
      while (running(c) && Date.now() < end2) await sleep(50);
      how = "terminated";
      if (running(c)) { signalGroup(c, "SIGKILL"); how = "killed"; const end3 = Date.now() + 2000; while (running(c) && Date.now() < end3) await sleep(50); }
    }
  }
  pipe.close();
  let groupLeft = false;
  if (c.pid) { try { process.kill(-c.pid, 0); groupLeft = true; process.kill(-c.pid, "SIGKILL"); killedGroups++; } catch {} }
  if (!running(c)) chromes.delete(c);
  return { how, groupLeft };
}

// ------------------------------------------------------------------ the page server

/** The page server on 127.0.0.1 (port 0): the act page and the cover page, by parts.ts's pageFor. */
function startServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    server = createServer((req, res) => {
      const remote = req.socket.remoteAddress ?? "";
      const page = remote === "127.0.0.1" || remote === "::ffff:127.0.0.1" ? pageFor(req.url ?? "/", req.headers.host, port) : { status: 403, body: "" };
      res.writeHead(page.status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(page.body);
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { port = (server!.address() as { port: number }).port; resolve(); });
  });
}
const pageUrl = (kind: "act" | "cover", tag: string) => `http://127.0.0.1:${port}/${kind}?w=${tag}`;

// ------------------------------------------------------------------ the run

meta = readMeta();
words.push(homedir(), ROOT, ROOT.replace(/\/$/, ""), tmpdir(), process.execPath);
try { words.push(userInfo().username); } catch {}
platform = { os: process.platform, arch: process.arch, node: process.versions.node, release: release() };
if (process.argv.length > 2) {
  process.stderr.write("mac-signin-window-probe: the probe takes no argument\nusage: node test/live/mac-signin-window-probe/probe.ts\n");
  finish({ ok: false, reason: "the probe takes no argument" }, 2);
} else if (TWIN !== null && (!/^[0-9]{1,4}$/.test(TWIN) || reservedDisplay(Number(TWIN), TWIN_ENV) !== null)) {
  process.stderr.write(`mac-signin-window-probe: ${TWIN_ENV} must name a free display that is not reserved\n`);
  finish({ ok: false, reason: `${TWIN_ENV} names no display that the twin may take` }, 2);
} else if (HOLD !== null && (HOLD_MS === null || TWIN !== null)) {
  process.stderr.write(`mac-signin-window-probe: ${HOLD_ENV} must be a whole number of ms from 1000 to 30000, without ${TWIN_ENV}\n`);
  finish({ ok: false, reason: `${HOLD_ENV} names no time limit that the seam may take` }, 2);
} else await main().catch(crash);

async function main(): Promise<void> {
  stage = "platform";
  if (!MAC && process.platform !== "linux") return finish({ ok: false, reason: `not the Mac: the probe has no run for ${clean(process.platform)}` }, 0);

  stage = "folder";
  dir = mkdtempSync(join(tmpdir(), "ab-sw-"));
  atEnd(dir, () => { cleanupSync(); });
  words.push(dir);
  try { words.push(realpathSync(dir)); } catch {}

  // The test extension: a key of its own, so its id is known before the load.
  stage = "extension";
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const der = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  extId = extensionIdOf(der);
  extDir = join(dir, "ext");
  mkdirSync(extDir, { mode: 0o700 });
  writeFileSync(join(extDir, "manifest.json"), extensionManifest(der.toString("base64")), { mode: 0o600 });
  writeFileSync(join(extDir, "sw.js"), EXTENSION_SW, { mode: 0o600 });

  stage = "page";
  await startServer();

  if (MAC) {
    stage = "taskport";
    taskport = parseTaskport(await runTool(SECURITY, ["authorizationdb", "read", TASKPORT_RIGHT], QUICK_MS));
    stage = "rights";
    const r = await runTool(process.execPath, ["--disable-sigusr1", "--no-warnings", HELPER, "rights"], QUICK_MS);
    rights = { read: runJson(r), ...(parseRights(r.stdout) ?? { screenRecording: null, accessibility: null, failed: "no answer" }) };
  }

  if (!MAC && TWIN === null) {
    stage = "dry";
    dry = await dryRun();
    return end("not the Mac (linux): the dry run made the folder, the extension and the page server, checked the server, ran the pipe client against a stand-in browser and stopped it both ways; the Chrome runs need the Mac");
  }

  const bin = MAC ? MAC_CHROME : LINUX_CHROMIUM;
  const env = TWIN !== null ? await twinSetup() : macEnv();
  if (env === null) return end("the Linux twin's display is in use or its Xvfb did not start");
  stage = "chrome";
  chrome = { found: existsSync(bin), version: null, twin: TWIN !== null };
  if (!chrome.found) return end(MAC ? "Google Chrome is not in the Applications folder" : "Chromium is not installed");
  for (const run of ["A", "B"] as RunName[]) {
    if (timeLeft() < RUN_MIN_MS) { runs[run] = { started: false, start: `skipped: ${NEAR}` }; continue; }
    await chromeRun(run, bin, env);
    if (run === "A") chrome.version = runs.A?.version ?? null;
    summary = summaryOf(runs as any);
  }
  return end(null);
}

/** The end of the run: each Chrome, tool and Xvfb that is left, the server, the folder; then the result. */
async function end(notMac: string | null): Promise<void> {
  stage = "cleanup";
  await sleep(50);
  const leftAtEnd = [...chromes].filter(running).length + tools.size;
  for (const c of chromes) signalGroup(c, "SIGKILL");
  for (const c of tools) signalGroup(c, "SIGKILL");
  // The twin's Xvfb runs until here by design: it stops now, and only an Xvfb that does not stop counts as left.
  let xvfbLeft = 0;
  if (xvfb && running(xvfb)) { xvfb.kill("SIGTERM"); const e = Date.now() + 3000; while (running(xvfb) && Date.now() < e) await sleep(50); if (running(xvfb)) { xvfb.kill("SIGKILL"); xvfbLeft = 1; } }
  await new Promise<void>((r) => { if (!server) return r(); server.close(() => r()); server.closeAllConnections(); });
  server = null;
  rmSync(dir!, { recursive: true, force: true, maxRetries: 3 });
  const folderRemoved = !existsSync(dir!);
  done(dir!);
  const cleanup = { chromes: chromeStarts, tools: toolRuns, killedGroups, leftAtEnd: leftAtEnd + xvfbLeft, folderRemoved };
  if (leftAtEnd + xvfbLeft > 0 || !folderRemoved) return finish({ ok: false, reason: "a Chrome, a tool, the Xvfb or the folder was left at the end", cleanup }, 0);
  if (notMac) { stage = "done"; return finish({ ok: false, reason: notMac, cleanup }, 0); }
  if (TWIN !== null) { stage = "done"; return finish({ ok: false, reason: `the Linux twin (Chromium on a private Xvfb, the seam ${TWIN_ENV}): the Mac's flow ran; never a measure of the Mac`, cleanup }, 0); }
  const failed = (["A", "B"] as RunName[]).find((r) => runs[r]?.started !== true);
  if (failed) { stage = `chrome-${failed}`; return finish({ ok: false, reason: `run ${failed}: the probe's Chrome did not start or answer`, cleanup }, 0); }
  stage = "done";
  finish({ ok: true, reason: null, cleanup }, 0);
}

/** The Mac's environment of the probe's Chrome: no variable of the probe's (a token among them) goes to it. */
function macEnv(): NodeJS.ProcessEnv {
  return { HOME: homedir(), PATH: "/usr/bin:/bin:/usr/sbin:/sbin", TMPDIR: tmpdir() };
}

/** The Linux twin: the harness guard, the X authority, a private Xvfb; the environment of its Chromium, or null when the display is in use. */
async function twinSetup(): Promise<NodeJS.ProcessEnv | null> {
  stage = "twin";
  const n = Number(TWIN);
  guard = await harnessGuard("mac-signin-window-probe-twin");
  const socket = `/tmp/.X11-unix/X${n}`;
  if (existsSync(socket)) return null;
  const field = (b: Buffer) => { const l = Buffer.alloc(2); l.writeUInt16BE(b.length); return Buffer.concat([l, b]); };
  const xauth = join(dir!, "Xauthority");
  writeFileSync(xauth, Buffer.concat([Buffer.from([0xff, 0xff]), field(Buffer.alloc(0)), field(Buffer.from(String(n))), field(Buffer.from("MIT-MAGIC-COOKIE-1")), field(randomBytes(16))]), { mode: 0o600 });
  xvfb = spawn("Xvfb", [`:${n}`, "-auth", xauth, "-nolisten", "tcp", "-screen", "0", "1280x800x24"], { stdio: "ignore" });
  xvfb.on("error", () => {});
  guard.track(xvfb.pid, "Xvfb");
  for (let i = 0; i < 50 && !existsSync(socket) && running(xvfb); i++) await sleep(100);
  await sleep(200);
  if (!existsSync(socket) || !running(xvfb)) return null;
  const home = join(dir!, "home");
  mkdirSync(home, { mode: 0o700 });
  return { HOME: home, PATH: "/usr/bin:/bin", DISPLAY: `:${n}`, XAUTHORITY: xauth };
}

// ------------------------------------------------------------------ the front app (the Mac)

async function readFront(): Promise<number | null> {
  if (!MAC) return null;
  return frontPid(await runTool(OSASCRIPT, jxaArgs(FRONT_JXA), QUICK_MS));
}
async function askBack(pid: number): Promise<string> {
  return giveBackOf(await runTool(OSASCRIPT, jxaArgs(GIVE_BACK_JXA, [String(pid)]), QUICK_MS));
}

/** One Chrome run's state. */
type Ctx = {
  run: RunName; pipe: Pipe; chromePid: number | null; front0: number | null; asks: number;
  screen: { sw: number; sh: number; aw: number; ah: number; al: number; at: number; extended: boolean } | null;
  ext: { session: string } | null; incognito: boolean; bctx: string | null;
};
/** A window of an option: its page's target and session, and its extension window id when the extension made it. */
type Win = { targetId: string | null; session: string | null; extId: number | null };

/** When the probe's Chrome is in front and another app was in front at the run's start: one ask to give the front back. */
async function ensureBack(x: Ctx): Promise<void> {
  if (!MAC || !x.front0 || x.front0 === x.chromePid || x.asks >= GIVE_BACK_MAX) return;
  if ((await readFront()) !== x.chromePid) return;
  x.asks++;
  await askBack(x.front0);
  await sleep(300);
}

// ------------------------------------------------------------------ one Chrome run

async function chromeRun(run: RunName, bin: string, env: NodeJS.ProcessEnv): Promise<void> {
  stage = `chrome-${run}`;
  const out: Record<string, any> = { flags: run === "A" ? "agent" : "sensor", started: false, start: null, version: null, ms: null, front0: null, giveBack: null, crashpad: null, screen: null, extension: null, context: null, options: {}, apiRule: null, stopped: null, profile: null };
  runs[run] = out;
  const profile = join(dir!, `profile-${run}`);
  mkdirSync(join(profile, "Default"), { recursive: true, mode: 0o700 });
  // Run A's profile holds the Linux service's write of the allow before the start (D3: does it hold?); run B's holds none,
  // so its extension needs the operator's switch (the extension's `switch`).
  if (run === "A") writeFileSync(join(profile, "Default", "Preferences"), prefsBefore(extId), { mode: 0o600 });
  const front0 = await readFront();
  out.front0 = frontOf(front0, null);
  const started = Date.now();
  let launched: { c: ChildProcess; pipe: Pipe };
  try { launched = startOnPipe(bin, chromeArgs(run, profile), env); }
  catch (e) { out.start = `spawn failed: ${clean((e as { code?: string }).code ?? "error")}`; return; }
  const { c, pipe } = launched;
  const x: Ctx = { run, pipe, chromePid: c.pid ?? null, front0, asks: 0, screen: null, ext: null, incognito: false, bctx: null };
  try {
    const v = await pipe.send("Browser.getVersion", {}, undefined, CHROME_START_MS);
    Object.assign(out, { started: true, start: "ok", version: chromeVersionOf(v?.product), ms: Date.now() - started });
    out.crashpad = { found: await findHandlers(c.pid ?? 0, (Date.now() - started) / 1000), endedWithChrome: null, stopped: 0 };
  } catch (e) {
    out.start = callErrorClass(message(e));
    out.stopped = await stopChrome(c, pipe);
    return;
  }
  // The front back to the app that was in front at the start: Chrome activates itself at its first window.
  if (MAC && front0 && front0 !== x.chromePid) {
    let took = false;
    for (const e = Date.now() + 3000; Date.now() < e;) { if ((await readFront()) === x.chromePid) { took = true; break; } await sleep(150); }
    let asked: string | null = null;
    if (took) { x.asks++; asked = await askBack(front0); await sleep(300); }
    out.giveBack = { took, asked, back: frontOf(await readFront(), x.chromePid) };
  }
  out.screen = x.screen = await screenOf(x);
  stage = `extension-${run}`;
  out.extension = await loadExtension(x);
  try { x.bctx = (await pipe.send("Target.createBrowserContext", {})).browserContextId ?? null; out.context = x.bctx ? "ok" : "no id"; }
  catch (e) { out.context = callErrorClass(message(e)); }
  for (const name of RUN_OPTIONS[run]) {
    stage = `${run}-${name}`;
    if (timeLeft() < OPTION_MIN_MS) { out.options[name] = { made: `skipped: ${NEAR}` }; continue; }
    out.options[name] = await option(x, name);
    summary = summaryOf(runs as any);
  }
  if (x.ext && x.screen && timeLeft() >= 4000) { stage = `${run}-apiRule`; out.apiRule = await apiRule(x); }
  stage = `stop-${run}`;
  const mine = [...handlers.keys()].filter((pid) => !seenHandlers.has(pid));
  for (const pid of mine) seenHandlers.add(pid);
  out.stopped = await stopChrome(c, pipe);
  if (out.crashpad) Object.assign(out.crashpad, await stopHandlers(mine));
  const read = (f: string) => { try { return readFileSync(join(profile, "Default", f), "utf8"); } catch { return null; } };
  out.profile = entryFacts(read("Secure Preferences"), read("Preferences"), extId);
}

/** The crash handlers that each run already took (a later run's find leaves them to that run's stop). */
const seenHandlers = new Set<number>();

/** The rows of ps (all processes of the box, read only; their names stay in the probe), or null when ps did not run. */
async function readPs(): Promise<PsRow[] | null> {
  const r = await runTool(PS, PS_ARGS, QUICK_MS, PS_MAX);
  return runClass(r) === "ok" ? parsePs(r.stdout) : null;
}

/** Find the crash handlers of the Chrome of `pid` (its child, not older than it: parts.ts crashpadOf); their count, or null when ps did not run. */
async function findHandlers(pid: number, ageS: number): Promise<number | null> {
  const rows = await readPs();
  if (!rows || !pid) return null;
  const found = crashpadOf(rows, pid, ageS);
  for (const h of found) handlers.set(h, rows.find((r) => r.pid === h)!.ageS);
  return found.length;
}

/** After its Chrome ended: each of its crash handlers that is still the same process gets SIGTERM, then SIGKILL after 2 s. */
async function stopHandlers(pids: readonly number[]): Promise<{ endedWithChrome: number | null; stopped: number }> {
  if (!pids.length) return { endedWithChrome: 0, stopped: 0 };
  await sleep(500);
  const rows = await readPs();
  if (!rows) return { endedWithChrome: null, stopped: 0 };
  const left = pids.filter((pid) => sameHandler(rows, pid, handlers.get(pid)!));
  for (const pid of left) { try { process.kill(pid, "SIGTERM"); } catch {} }
  for (const e = Date.now() + 2000; Date.now() < e && left.some((pid) => alive(pid));) await sleep(100);
  for (const pid of left) if (alive(pid)) { try { process.kill(pid, "SIGKILL"); } catch {} }
  for (const pid of pids) handlers.delete(pid);
  return { endedWithChrome: pids.length - left.length, stopped: left.length };
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** The screen's numbers, from the first page of the run (the start's about:blank tab). */
async function screenOf(x: Ctx): Promise<Ctx["screen"]> {
  try {
    const t = await x.pipe.send("Target.getTargets", {});
    const page = (t?.targetInfos ?? []).find((i: any) => i?.type === "page");
    if (!page) return null;
    const s = (await x.pipe.send("Target.attachToTarget", { targetId: page.targetId, flatten: true })).sessionId;
    const v = await x.pipe.send("Runtime.evaluate", { expression: "({ sw: screen.width, sh: screen.height, aw: screen.availWidth, ah: screen.availHeight, al: screen.availLeft, at: screen.availTop, ext: screen.isExtended === true })", returnByValue: true }, s);
    await x.pipe.send("Target.detachFromTarget", { sessionId: s }).catch(() => {});
    const o = v?.result?.value;
    const ok = o && ["sw", "sh", "aw", "ah", "al", "at"].every((k) => Number.isFinite(o[k]));
    return ok ? { sw: o.sw, sh: o.sh, aw: o.aw, ah: o.ah, al: o.al, at: o.at, extended: o.ext === true } : null;
  } catch { return null; }
}

/** An evaluation in a session's page or worker, by value; a script error throws. */
async function evaluate(x: Ctx, session: string, expression: string, awaitPromise = false): Promise<any> {
  const r = await x.pipe.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise }, session, CALL_MS + (awaitPromise ? 3 * MEASURE_MS + 2000 : 0));
  if (r?.exceptionDetails) throw new CallError("a script of the probe failed");
  return r?.result?.value;
}

/**
 * The test extension (parts.ts, EXTENSION_SW): developer mode in the probe's own temp profile (chrome://extensions' own
 * call), Extensions.loadUnpacked, its worker, and whether it has the incognito allow at its load (run A: the allow that
 * the Preferences file held before the start, the Linux service's write; run B: no write). With no allow at the load,
 * the operator's switch 'Allow in Incognito' through chrome://extensions' own call (developerPrivate's
 * updateExtensionConfiguration with incognitoAccess true: the schema in Chromium 156's own binary; its effect in Chrome
 * stable 158 is assumed), then the reloaded extension's worker and the allow read again. The extension's options run
 * only when its worker answers.
 */
async function loadExtension(x: Ctx): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { devMode: null, load: null, idMatch: null, worker: null, prefsWrite: x.run === "A", allowedAtLoad: null, switch: null, allowedAfterSwitch: null, allowedIncognito: null };
  let page: { t: string; s: string | null } | null = null;
  try {
    const t = (await x.pipe.send("Target.createTarget", { url: "chrome://extensions/" })).targetId;
    page = { t, s: null };
    const s = (await x.pipe.send("Target.attachToTarget", { targetId: t, flatten: true })).sessionId;
    let ready = false;
    for (const e = Date.now() + 4000; !ready && Date.now() < e;) { ready = (await evaluate(x, s, "typeof chrome === 'object' && !!chrome.developerPrivate").catch(() => false)) === true; if (!ready) await sleep(150); }
    if (ready) page.s = s;
    out.devMode = ready ? await evaluate(x, s, "(async () => { try { await chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }); return 'ok'; } catch (e) { return 'refused'; } })()", true) : "no developerPrivate";
  } catch (e) { out.devMode = `failed: ${callErrorClass(message(e))}`; }
  const close = async () => { if (page) await x.pipe.send("Target.closeTarget", { targetId: page.t }).catch(() => {}); };
  try {
    const r = await x.pipe.send("Extensions.loadUnpacked", { path: extDir }, undefined, 10_000);
    out.load = "ok";
    out.idMatch = r?.id === extId;
  } catch (e) { out.load = callErrorClass(message(e)); await close(); return out; }
  const w = await worker(x, null);
  if (!w) { out.worker = "no worker"; await close(); return out; }
  out.worker = "ok";
  out.allowedAtLoad = w.allowed;
  let session = w.session, allowed = w.allowed;
  if (allowed !== true) {
    if (!page?.s) out.switch = "no developerPrivate";
    else {
      out.switch = await evaluate(x, page.s, `(async () => { try { await chrome.developerPrivate.updateExtensionConfiguration({ extensionId: ${JSON.stringify(extId)}, incognitoAccess: true }); return 'ok'; } catch (e) { return 'refused'; } })()`, true).catch((e) => `failed: ${callErrorClass(message(e))}`);
      // Chrome reloads an extension at a change of its incognito access: its new worker, with the allow.
      const again = out.switch === "ok" ? await worker(x, true) : null;
      if (again) { session = again.session; allowed = again.allowed; }
      out.allowedAfterSwitch = again ? again.allowed : null;
    }
  } else out.switch = "not needed";
  await close();
  out.allowedIncognito = allowed;
  x.ext = { session };
  x.incognito = allowed === true;
  return out;
}

/**
 * The extension's worker: its service worker target, attached, with `self.probe` up, and its allow
 * (isAllowedIncognitoAccess). With `want`, it waits (6 s) for a worker whose allow is `want` (the reloaded one).
 */
async function worker(x: Ctx, want: boolean | null): Promise<{ session: string; allowed: boolean | null } | null> {
  const tried = new Set<string>();
  for (const e = Date.now() + (want === null ? 5000 : 6000); Date.now() < e;) {
    const t = await x.pipe.send("Target.getTargets", {}).catch(() => null);
    const sws = (t?.targetInfos ?? []).filter((i: any) => i?.type === "service_worker" && i.url === `chrome-extension://${extId}/sw.js`);
    for (const sw of sws) {
      const session = (await x.pipe.send("Target.attachToTarget", { targetId: sw.targetId, flatten: true }).catch(() => null))?.sessionId ?? null;
      if (!session) continue;
      let up = false;
      for (const e2 = Date.now() + 2000; !up && Date.now() < e2;) { up = (await evaluate(x, session, "typeof self.probe === 'object'").catch(() => false)) === true; if (!up) await sleep(100); }
      if (!up) { tried.add(sw.targetId); continue; }
      const a = await evaluate(x, session, "self.probe.allowed()", true).catch(() => null);
      const allowed = a?.ok === true && typeof a.value === "boolean" ? a.value : null;
      if (want === null || allowed === want) return { session, allowed };
      await x.pipe.send("Target.detachFromTarget", { sessionId: session }).catch(() => {});
    }
    await sleep(250);
  }
  return null;
}

/** One call of the test extension's worker (parts.ts, EXTENSION_SW): its {ok, value} or {ok: false, error}. */
async function ext(x: Ctx, fn: "create" | "get" | "remove", arg: unknown): Promise<{ ok: boolean; value?: any; error?: string }> {
  const r = await evaluate(x, x.ext!.session, `self.probe.${fn}(${JSON.stringify(arg)})`, true);
  return r && typeof r === "object" ? r : { ok: false, error: "no answer" };
}

/** The page target of `url` (the probe's own, unique for each option), attached; null when it does not come. */
async function attachUrl(x: Ctx, url: string): Promise<string | null> {
  for (const e = Date.now() + PAGE_WAIT_MS; Date.now() < e;) {
    const t = await x.pipe.send("Target.getTargets", {}).catch(() => null);
    const p = (t?.targetInfos ?? []).find((i: any) => i?.type === "page" && i.url === url);
    if (p) return p.targetId;
    await sleep(100);
  }
  return null;
}

/** A window of the probe's browser context (or the default context: `ctx` null) at ACT_BOUNDS, made by browser-level CDP. */
async function cdpWindow(x: Ctx, url: string, ctx: string | null): Promise<Win> {
  const targetId = (await x.pipe.send("Target.createTarget", { url, newWindow: true, background: true, ...(ctx ? { browserContextId: ctx } : {}) })).targetId;
  await setBounds(x, targetId, { ...ACT_BOUNDS });
  // Chrome's Show() activates Chrome: the front goes back to the operator's app after each window's create (m1).
  await ensureBack(x);
  return { targetId, session: null, extId: null };
}

async function setBounds(x: Ctx, targetId: string, bounds: Record<string, unknown>): Promise<void> {
  const w = await x.pipe.send("Browser.getWindowForTarget", { targetId });
  await x.pipe.send("Browser.setWindowBounds", { windowId: w.windowId, bounds });
}

async function closeWin(x: Ctx, w: Win): Promise<void> {
  if (w.extId !== null && x.ext) { await ext(x, "remove", w.extId).catch(() => {}); return; }
  if (w.targetId) await x.pipe.send("Target.closeTarget", { targetId: w.targetId }).catch(() => {});
}

/** One option of OPTIONS in this run: the window made, the reads, the typing, the close of each window that it made. */
async function option(x: Ctx, name: OptionName): Promise<OptionJson> {
  const o: OptionJson = { made: "ok", ms: null, window: null, ext: null, front: null, measure: null, typed: null, hangs: 0, after: null };
  const t = Date.now();
  const made: Win[] = [];
  const url = pageUrl("act", `${x.run}-${name}`);
  const s = x.screen;
  try {
    let w: Win;
    if (name === "apiMinimized" || name === "apiOverCover") {
      if (!x.ext) { o.made = "skipped: the extension did not load"; return o; }
      if (name === "apiOverCover") {
        if (!s) { o.made = "skipped: the screen did not read"; return o; }
        const cover = await ext(x, "create", { url: pageUrl("cover", `${x.run}-${name}`), focused: true, left: s.al, top: s.at, width: s.aw, height: s.ah });
        if (!cover.ok) { o.made = `the cover failed: ${windowErrorClass(cover.error ?? "")}`; return o; }
        made.push({ targetId: null, session: null, extId: cover.value.id });
        await sleep(300);
      }
      await ensureBack(x);
      const before = frontOf(await readFront(), x.chromePid);
      const data = name === "apiMinimized"
        ? { url, focused: false, state: "minimized", ...(x.incognito ? { incognito: true } : {}) }
        : { url, focused: false, ...ACT_BOUNDS, ...(x.incognito ? { incognito: true } : {}) };
      const r = await ext(x, "create", data);
      if (!r.ok) { o.made = `windows.create failed: ${windowErrorClass(r.error ?? "")}`; return o; }
      w = { targetId: null, session: null, extId: r.value.id };
      made.push(w);
      await sleep(300);
      const after = frontOf(await readFront(), x.chromePid);
      o.front = { before, after, took: tookFront(before, after) };
      await ensureBack(x);
      w.targetId = await attachUrl(x, url);
      if (!w.targetId) { o.made = "the window's page did not come"; return o; }
    } else {
      if (!x.bctx) { o.made = "skipped: no browser context"; return o; }
      if (name !== "front" && !s) { o.made = "skipped: the screen did not read"; return o; }
      w = await cdpWindow(x, url, x.bctx);
      made.push(w);
      if (name === "edge") await setBounds(x, w.targetId!, { left: s!.sw - ACT_BOUNDS.width / 2, top: ACT_BOUNDS.top, width: ACT_BOUNDS.width, height: ACT_BOUNDS.height });
      if (name === "minimized") await setBounds(x, w.targetId!, { windowState: "minimized" });
      if (name === "behind") {
        const cover = await cdpWindow(x, pageUrl("cover", `${x.run}-${name}`), null);
        made.push(cover);
        await setBounds(x, cover.targetId!, { left: s!.al, top: s!.at, width: s!.aw, height: s!.ah });
      }
    }
    w.session = (await x.pipe.send("Target.attachToTarget", { targetId: w.targetId, flatten: true })).sessionId;
    let ready = false;
    for (const e = Date.now() + PAGE_WAIT_MS; !ready && Date.now() < e;) { ready = (await evaluate(x, w.session!, "typeof window.__abProbe === 'object'").catch(() => false)) === true; if (!ready) await sleep(100); }
    if (!ready) { o.made = "the page's recorder did not come"; return o; }
    await sleep(SETTLE_MS);
    o.window = boundsJson(await x.pipe.send("Browser.getWindowForTarget", { targetId: w.targetId }).catch(() => null));
    if (w.extId !== null) { const g = await ext(x, "get", w.extId).catch(() => null); o.ext = g?.ok ? extWindowJson(g.value) : null; }
    o.measure = measureJson(await evaluate(x, w.session!, `__abProbe.measure(${MEASURE_MS})`, true));
    await typeInto(x, w.session!, o);
    o.after = boundsJson(await x.pipe.send("Browser.getWindowForTarget", { targetId: w.targetId }).catch(() => null));
  } catch (e) {
    o.made = `failed: ${callErrorClass(message(e))}`;
  } finally {
    for (const m of made.reverse()) await closeWin(x, m);
    o.ms = Date.now() - t;
  }
  return o;
}

/** The act's input path on the option's page: a click on the field, the test text as key events, the insert; then the page's record. */
async function typeInto(x: Ctx, session: string, o: OptionJson): Promise<void> {
  await evaluate(x, session, "__abProbe.start()");
  const input = async (method: string, params: Record<string, unknown>) => {
    if (o.hangs >= HANGS_MAX) return;
    try { await x.pipe.send(method, params, session, INPUT_CALL_MS); }
    catch (e) { if (message(e) === "timeout") o.hangs++; else throw e; }
  };
  const at = { x: FIELD_CENTRE.x, y: FIELD_CENTRE.y, modifiers: 0 };
  await input("Input.dispatchMouseEvent", { type: "mouseMoved", ...at, button: "none", buttons: 0 });
  await input("Input.dispatchMouseEvent", { type: "mousePressed", ...at, button: "left", buttons: 1, clickCount: 1 });
  await sleep(60);
  await input("Input.dispatchMouseEvent", { type: "mouseReleased", ...at, button: "left", buttons: 0, clickCount: 1 });
  for (const ev of keyEvents(TEST_TEXT)) {
    await input("Input.dispatchKeyEvent", ev);
    await sleep(ev.type === "keyDown" ? KEY_HOLD_MS : KEY_GAP_MS);
  }
  await input("Input.insertText", { text: INSERT_TEXT });
  await sleep(150);
  o.typed = typedJson(await evaluate(x, session, `__abProbe.typed(${JSON.stringify(EXPECTED_TEXT)})`));
}

/** The extension's rule check: windows.create with half of the window outside the screen's right edge, three quarters, and minimized with bounds; each its class and, when made, the window's place. */
async function apiRule(x: Ctx): Promise<Record<string, unknown>> {
  const s = x.screen!;
  // The class of each create, and for a window that Chrome made, where Chrome put it (its own flags can override the bounds).
  const one = async (data: Record<string, unknown>) => {
    const r: { ok: boolean; value?: any; error?: string } = await ext(x, "create", { url: "about:blank", focused: false, ...data }).catch(() => ({ ok: false, error: "no answer" }));
    if (r.ok && Number.isInteger(r.value?.id)) await ext(x, "remove", r.value.id).catch(() => {});
    return r.ok ? { class: "ok", window: extWindowJson(r.value) } : { class: windowErrorClass(r.error ?? ""), window: null };
  };
  return {
    half: await one({ left: s.sw - ACT_BOUNDS.width / 2, top: ACT_BOUNDS.top, width: ACT_BOUNDS.width, height: ACT_BOUNDS.height }),
    threeQuarters: await one({ left: s.sw - ACT_BOUNDS.width / 4, top: ACT_BOUNDS.top, width: ACT_BOUNDS.width, height: ACT_BOUNDS.height }),
    minimizedWithBounds: await one({ state: "minimized", ...ACT_BOUNDS }),
  };
}

// ------------------------------------------------------------------ the Linux dry run

/** One GET of the page server with a Host header of its own: the status, and whether the body holds the recorder. */
function get(path: string, host: string): Promise<{ status: number; recorder: boolean } | { failed: string }> {
  return new Promise((resolve) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET", headers: { host }, timeout: 3000 }, (res) => {
      let body = "";
      res.on("data", (d) => { body += d; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, recorder: body.includes("window.__abProbe") }));
    });
    req.on("error", (e) => resolve({ failed: clean((e as { code?: string }).code ?? "error") }));
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.end();
  });
}

/** The dry run (Linux): the extension's files and id, the page server, and the pipe client with two stand-in browsers. */
async function dryRun(): Promise<Record<string, unknown>> {
  let manifestKey: string | null = null;
  try { manifestKey = JSON.parse(readFileSync(join(extDir, "manifest.json"), "utf8")).key ?? null; } catch {}
  const extension = { idFromKey: manifestKey !== null && extensionIdOf(Buffer.from(manifestKey, "base64")) === extId, worker: readFileSync(join(extDir, "sw.js"), "utf8") === EXTENSION_SW };
  const host = `127.0.0.1:${port}`;
  const page = { act: await get("/act?w=dry", host), cover: await get("/cover", host), missing: await get("/x", host), wrongHost: await get("/act", `localhost:${port}`) };
  stage = "dry-pipe";
  const env = { PATH: "/usr/bin:/bin" };
  const a = startOnPipe(process.execPath, ["-e", STANDIN_BROWSER], env);
  const version = chromeVersionOf((await a.pipe.send("Browser.getVersion")).product);
  const unknown = await a.pipe.send("Target.getTargets").then(() => "answered", (e) => callErrorClass(message(e)));
  const closes = await stopChrome(a.c, a.pipe, 1000);
  const b = startOnPipe(process.execPath, ["-e", STANDIN_BROWSER, "stay"], env);
  await b.pipe.send("Browser.getVersion");
  const stays = await stopChrome(b.c, b.pipe, 300);
  const late = await b.pipe.send("Browser.getVersion").then(() => "answered", (e) => callErrorClass(message(e)));
  if (HOLD_MS !== null) {
    // The cleanup test's seam: a stand-in that stays, its pid on stderr, and a wait that only the time limit or a signal ends.
    stage = "dry-hold";
    const h = startOnPipe(process.execPath, ["-e", STANDIN_BROWSER, "stay"], env);
    await h.pipe.send("Browser.getVersion");
    process.stderr.write(`dry-hold: stand-in pid ${h.c.pid}\n`);
    setInterval(() => {}, 1000);
    await new Promise<never>(() => {});
  }
  return { extension, page, pipe: { version, unknown, closes, stays, late } };
}
