// The Mac memory probe (board ab-v16.97.8, part 1; section 5.5 and section 13 row 11 of
// docs/superpowers/specs/2026-11-10-stored-sign-in-credentials-design.md). The stored sign-ins hold the store's open key
// in the service's memory. On Linux the service starts non-dumpable (prctl through node:ffi), so another program of the
// same user cannot read its memory. On the Mac the store and the sign-in act stay off until this measure: ONE read-only
// run on the Mac answers whether a program of the same user can read the memory of a Node process, and which
// protection stops which reader.
//
//   Q1. The environment, by read-only commands: the Darwin release, the arch, Node's version; `DevToolsSecurity -status`;
//       whether the user is in the group _developer (`id -Gn`); `csrutil status`; whether developer tools are present
//       (`xcode-select -p` exits 0; its path is not read).
//   Q2. The code signatures of the probe's own Node and of the program of the service's launchd job (`launchctl print
//       gui/<uid>/com.agentwatch.agent-browser`; only read, never changed), with `codesign -d`: the kind (none, ad hoc,
//       Developer ID, Apple), the hardened runtime flag, and the entitlements get-task-allow, cs.debugger, cs.allow-jit,
//       cs.allow-unsigned-executable-memory and cs.disable-library-validation; and whether the job's program is the same
//       file as the probe's Node (device and inode).
//   Q3. Three throwaway targets, children of the probe (helper.ts), each with a random marker: T0 the probe's Node, plain;
//       T1 the probe's Node after ptrace(PT_DENY_ATTACH); T2 a copy of the probe's Node in the probe's temp folder, signed
//       ad hoc with the hardened runtime (parts.ts, TARGETS). For each target, in this order, each with its own time limit
//       (TOOL_MS): a. task_for_pid and task_read_for_pid through node:ffi, in a port reader (helper.ts, port: the probe's
//       own Node, so that a hang ends at its time limit); b. `vmmap --summary`; c. `leaks --outputGraph=<file>`, then a
//       byte search of the file for the marker (and, when the file is there and holds no marker, once more with
//       --fullContent: cFull); d. `lldb --batch --no-lldbinit -p <pid> -o "process status" -o "detach"`. Reads a and d
//       run only under their guards (parts.ts, guardsOf), so that no dialog asks for a password.
//
// On Linux the probe makes its folder, starts and ends T0 and T1 (T1 with prctl(PR_SET_DUMPABLE, 0) in place of
// PT_DENY_ATTACH), checks its tool runner (an exit, a time limit, a missing tool), cleans up, and answers ok false: not
// the Mac. Any other platform: ok false at once.
//
// It reads only, outside its own temp folder (mkdtemp in the temp folder of the system, 0700): no setting, no
// DevToolsSecurity change, no keychain, no sudo, no clock, no service or launchd change (only `launchctl print`), no
// browser, no input, no screen. It reads no process that is not its own child: the service's job only by `launchctl
// print` and `codesign -d` of its program file. Each tool runs in its own process group, with stdin from /dev/null, and
// is killed (the group) at its time limit. The probe ends each target after its reads, and at its end, after an error,
// at its time limit (TIME_LIMIT_MS) or at a SIGTERM, SIGINT or SIGHUP (test/temp-dirs.ts) it kills each target and tool
// that is left and removes its folder (the copy of Node, the memory graphs).
//
//   node test/live/mac-memory-probe/probe.ts
//
// Output: one JSON document on stdout (parts.ts, resultOf), with no path, no argv, no environment, no login name, no
// marker and no secret: no tool's text, only classes and exit codes; the result's check refuses every `/`, `\` and `@`,
// and its scrub takes out the home folder, the login name, the temp folders and the markers. Exit: 0 when the probe ran
// and printed (ok true or false inside); 1 at its time limit or an uncaught error (the JSON still prints), and when the
// result fails its own check (stage "output"); 2 for an argument (it takes none). The helpers need node:ffi: Node 26.1
// or later. `npm test` runs its pure parts and its Linux run (test/mac-memory-probe.test.ts).

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readSync, realpathSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { homedir, release, tmpdir, userInfo } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { atEnd, done } from "../../temp-dirs.ts";
import {
  CHUNK_BYTES, END_WAIT_MS, MARKER_BYTES, PROBE_VERSION, QUICK_MS, RESERVE_MS, SERVICE_LABEL, SIGN_MS, START_MS, TARGETS, TEXT_MAX,
  TIME_LIMIT_MS, TOOL_MS, checkResult, clean, entitlementsPlist, guardsOf, parseCsrutil, parseDeveloperGroup, parseDeveloperTools,
  parseDevToolsSecurity, parseLaunchctlJob, portJson, programForm, readerJson, resultOf, runClass, runJson, scrub, searchChunks, signatureJson, skipped, summaryOf,
  type Guards, type Meta, type Platform, type PortAnswer, type SignatureJson, type TargetName, type ToolRun, type Tri,
} from "./parts.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const HELPER = fileURLToPath(new URL("./helper.ts", import.meta.url));
const t0 = Date.now();
const elapsed = () => Date.now() - t0;
/** The time that a read may still take before the run's cleanup reserve. */
const timeLeft = () => TIME_LIMIT_MS - RESERVE_MS - elapsed();
const NEAR = "the run's time limit is near";

// The tools, by their place in macOS (constants of the code: never a value of the result).
const BIN = {
  devToolsSecurity: "/usr/sbin/DevToolsSecurity", id: "/usr/bin/id", csrutil: "/usr/bin/csrutil", xcodeSelect: "/usr/bin/xcode-select",
  codesign: "/usr/bin/codesign", launchctl: "/bin/launchctl", vmmap: "/usr/bin/vmmap", leaks: "/usr/bin/leaks", lldb: "/usr/bin/lldb",
};

// ------------------------------------------------------------------ the run's state (the stops of a crash read it)

let meta: Meta = { version: PROBE_VERSION, commit: "unknown", dirty: null };
let platform: Platform | null = null;
let stage = "args";
let dir: string | null = null;
const words: string[] = [];
/** The targets (helper.ts, target) and the port readers (helper.ts, port). */
const children: ChildProcess[] = [];
/** The tools that run now, each the leader of its own process group; and the count of every tool run. */
const tools = new Set<ChildProcess>();
let toolRuns = 0;
let q1: Record<string, unknown> | null = null;
let q2: Record<string, unknown> | null = null;
let q3: { guards: Guards | null; targets: Record<string, unknown>; [more: string]: unknown } | null = null;
let summary: Record<string, unknown> | null = null;
let printed = false;

/** Print the result once, after its scrub and check; exit with `code` when stdout has it. */
function finish(o: { ok: boolean; reason: string | null; detail?: string | null; cleanup?: unknown }, code: number): void {
  if (printed) return;
  printed = true;
  const r = resultOf({ meta, platform, ok: o.ok, stage, reason: o.reason, detail: o.detail ?? null, ms: elapsed(), q1, q2, q3, summary, cleanup: o.cleanup ?? null });
  const s = scrub(r, words);
  let out: Record<string, unknown> = { ...s.value, redacted: s.count };
  const bad = checkResult(out);
  if (bad) {
    out = { ...resultOf({ meta, platform, ok: false, stage: "output", reason: "the result failed its check", detail: `the value at ${bad}`.replace(/[^A-Za-z0-9 .<>\[\]]/g, ""), ms: elapsed(), q1: null, q2: null, q3: null, summary: null, cleanup: o.cleanup ?? null }), redacted: s.count };
    code = 1;
  }
  setTimeout(() => process.exit(code), 2000).unref();
  process.stdout.write(`${JSON.stringify(out)}\n`, () => process.exit(code));
}

const running = (c: ChildProcess) => c.exitCode === null && c.signalCode === null;
const killGroup = (c: ChildProcess) => {
  if (c.pid) { try { process.kill(-c.pid, "SIGKILL"); } catch {} }
  try { c.kill("SIGKILL"); } catch {}
};

/** The synchronous end (a crash, the time limit, a signal): kill each target, port reader and tool that is left, remove the folder. */
function cleanupSync(): { left: number; folderRemoved: boolean | null } {
  let left = 0;
  for (const c of children) if (running(c)) { left++; try { c.kill("SIGKILL"); } catch {} }
  for (const c of tools) { left++; killGroup(c); }
  let folderRemoved: boolean | null = null;
  if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch {} folderRemoved = !existsSync(dir); done(dir); }
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
  finish({ ok: false, reason: `the time limit of ${TIME_LIMIT_MS / 1000} s for the whole run`, cleanup: { atStop: true, leftAtStop: c.left, folderRemoved: c.folderRemoved } }, 1);
}, TIME_LIMIT_MS);
hardTimer.unref();

// ------------------------------------------------------------------ the runs of tools and helpers

/**
 * One run of a tool: its own process group (detached), stdin from /dev/null, the first TEXT_MAX characters of stdout and
 * stderr (for its class only: the text never leaves the probe), and SIGKILL of its group at `ms`. The answer comes at
 * the close of its output, or 1 s after its exit (a child of the tool can hold the output open).
 */
function runTool(cmd: string, args: readonly string[], ms: number): Promise<ToolRun> {
  const start = Date.now();
  return new Promise((resolve) => {
    let text = "", timedOut = false, settled = false;
    let exit: number | null = null, signal: string | null = null;
    let c: ChildProcess;
    const settle = (r: Omit<ToolRun, "ms" | "text" | "pid">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      tools.delete(c);
      resolve({ ...r, text, ms: Date.now() - start, pid: c?.pid ?? null });
    };
    const timer = setTimeout(() => { timedOut = true; killGroup(c); setTimeout(() => settle({ exit, signal, timedOut, spawnError: null }), 2000).unref(); }, ms);
    try { c = spawn(cmd, args, { cwd: dir ?? tmpdir(), detached: true, stdio: ["ignore", "pipe", "pipe"] }); }
    catch (e) { clearTimeout(timer); return resolve({ exit: null, signal: null, timedOut: false, spawnError: (e as { code?: string }).code ?? "error", text: "", ms: 0 }); }
    tools.add(c);
    toolRuns++;
    const take = (d: Buffer) => { if (text.length < TEXT_MAX) text += d.toString("latin1").slice(0, TEXT_MAX - text.length); };
    c.stdout!.on("data", take);
    c.stderr!.on("data", take);
    c.on("error", (e) => settle({ exit: null, signal: null, timedOut, spawnError: (e as { code?: string }).code ?? "error" }));
    c.on("exit", (code, sig) => { exit = code; signal = sig; setTimeout(() => settle({ exit, signal, timedOut, spawnError: null }), 1000).unref(); });
    c.on("close", (code, sig) => settle({ exit: code ?? exit, signal: sig ?? signal, timedOut, spawnError: null }));
  });
}

/** A helper of helper.ts on `node` (the probe's own, or T2's copy), with an IPC channel and no other output. */
function startHelper(node: string, args: string[]): ChildProcess {
  const c = spawn(node, ["--disable-sigusr1", HELPER, ...args], { cwd: dir ?? tmpdir(), stdio: ["ignore", "ignore", "ignore", "ipc"] });
  children.push(c);
  c.on("error", () => {});
  return c;
}

/** The first message of a helper, or why none came: "exited", "killed", "timeout", "spawn failed". */
function firstMessage<T>(c: ChildProcess, ms: number): Promise<{ msg: T } | { why: string }> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ why: "timeout" }), ms);
    c.once("message", (m: T) => { clearTimeout(timer); resolve({ msg: m }); });
    c.once("exit", (code, sig) => { clearTimeout(timer); resolve({ why: sig ? "killed" : `exited ${code}` }); });
    c.once("error", () => { clearTimeout(timer); resolve({ why: "spawn failed" }); });
  });
}

/** The end of a target: its end message and the end of its channel, a wait, then SIGKILL. "ended", "killed", or "gone" (it had ended). */
async function stopTarget(c: ChildProcess): Promise<string> {
  if (!running(c)) return "gone";
  try { if (c.connected) { c.send({ do: "end" }); c.disconnect(); } } catch {}
  const end = Date.now() + END_WAIT_MS;
  while (running(c) && Date.now() < end) await sleep(20);
  if (!running(c)) return "ended";
  try { c.kill("SIGKILL"); } catch {}
  return "killed";
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The probe's commit: its checkout's HEAD, and whether a tracked file differs from it. Read only: --no-optional-locks keeps git status from writing the index. */
function readMeta(): Meta {
  const git = (args: string[]) => {
    try { return execFileSync("git", ["--no-optional-locks", "-C", ROOT, ...args], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; }
  };
  const head = git(["rev-parse", "HEAD"]), status = git(["status", "--porcelain", "--untracked-files=no"]);
  return { version: PROBE_VERSION, commit: head && /^[0-9a-f]{40}$/.test(head) ? head : "unknown", dirty: status === null ? null : status.length > 0 };
}

/** The marker's byte search of a file, chunk by chunk (Buffer.indexOf only); null when the file cannot be read. */
function searchFile(file: string, needles: Buffer[]): { found: boolean[]; bytes: number } | null {
  let fd: number;
  try { fd = openSync(file, "r"); } catch { return null; }
  try { return searchChunks((into) => readSync(fd, into, 0, into.length, null), needles); }
  catch { return null; } finally { closeSync(fd); }
}

const sizeOf = (file: string): number | null => { try { return statSync(file).size; } catch { return null; } };
const mb = (bytes: number | null) => (bytes === null ? null : Math.round(bytes / 1e5) / 10);

// ------------------------------------------------------------------ the run

meta = readMeta();
words.push(homedir(), ROOT, ROOT.replace(/\/$/, ""), tmpdir());
try { words.push(userInfo().username); } catch {}
platform = { os: process.platform, arch: process.arch, node: process.versions.node, release: release() };
if (process.argv.length > 2) {
  process.stderr.write("mac-memory-probe: the probe takes no argument\nusage: node test/live/mac-memory-probe/probe.ts\n");
  finish({ ok: false, reason: "the probe takes no argument" }, 2);
} else await main().catch(crash);

async function main(): Promise<void> {
  stage = "platform";
  const mac = process.platform === "darwin";
  if (!mac && process.platform !== "linux") return finish({ ok: false, reason: `not the Mac: the probe has no reads for ${clean(process.platform)}` }, 0);
  const execReal = realpathSync(process.execPath);
  words.push(process.execPath, execReal);

  stage = "folder";
  dir = mkdtempSync(join(tmpdir(), "ab-mp-"));
  atEnd(dir, () => { cleanupSync(); });
  words.push(dir);
  try { words.push(realpathSync(dir)); } catch {}

  // Q1: the environment.
  stage = "q1";
  q1 = { release: release(), arch: process.arch, node: process.versions.node, devToolsSecurity: null, developerGroup: null, sip: null, developerTools: null, reads: null };
  let env: { devToolsSecurity: Tri; developerTools: boolean | null } = { devToolsSecurity: "unknown", developerTools: null };
  if (mac) {
    const dts = await runTool(BIN.devToolsSecurity, ["-status"], QUICK_MS);
    const ids = await runTool(BIN.id, ["-Gn"], QUICK_MS);
    const sip = await runTool(BIN.csrutil, ["status"], QUICK_MS);
    const xs = await runTool(BIN.xcodeSelect, ["-p"], QUICK_MS);
    env = { devToolsSecurity: parseDevToolsSecurity(dts), developerTools: parseDeveloperTools(xs) };
    Object.assign(q1, {
      devToolsSecurity: env.devToolsSecurity, developerGroup: parseDeveloperGroup(ids), sip: parseCsrutil(sip), developerTools: env.developerTools,
      reads: { devToolsSecurity: runJson(dts), id: runJson(ids), csrutil: runJson(sip), xcodeSelect: runJson(xs) },
    });
  }

  // Q2: the code signatures of the probe's Node and of the service's program.
  const signature = async (file: string): Promise<SignatureJson> =>
    signatureJson(await runTool(BIN.codesign, ["-d", "--verbose=4", file], QUICK_MS), await runTool(BIN.codesign, ["-d", "--entitlements", "-", "--xml", file], QUICK_MS));
  let probeNode: SignatureJson | null = null;
  if (mac) {
    stage = "q2";
    probeNode = await signature(execReal);
    const uid = process.getuid?.() ?? -1;
    const target = `gui/${uid}/${SERVICE_LABEL}`;
    const lp = await runTool(BIN.launchctl, ["print", target], QUICK_MS);
    const job = parseLaunchctlJob(lp, target);
    if (job.program) words.push(job.program);
    const form = programForm(job.program);
    let same: boolean | null = null, programSig: SignatureJson | null = null, exists: boolean | null = null;
    if (form === "absolute") {
      try {
        const a = statSync(job.program!), b = statSync(execReal);
        exists = true;
        same = a.dev === b.dev && a.ino === b.ino;
      } catch { exists = false; }
      if (exists) programSig = await signature(job.program!);
    }
    q2 = {
      probeNode,
      service: {
        label: SERVICE_LABEL, job: job.loaded === true ? "loaded" : job.loaded === false ? "not loaded" : "unknown", state: job.state,
        program: form, programIsNode: job.program === null ? null : basename(job.program) === "node", programExists: exists,
        sameFileAsProbeNode: same, signature: programSig, read: runJson(lp),
      },
    };
  }

  // Q3: the targets.
  const guards = mac ? guardsOf(env, probeNode?.entitlements.debugger ?? null) : null;
  q3 = { markerBytes: MARKER_BYTES, guards, targets: {} };
  if (!mac) q3.runnerCheck = await runnerCheck();
  let started = 0;
  const stops: string[] = [];
  const failedStarts: string[] = [];
  const summaries: Record<string, unknown> = {};

  for (const name of Object.keys(TARGETS) as TargetName[]) {
    stage = `q3-${name}`;
    const out: Record<string, unknown> = { how: TARGETS[name], started: false, start: null, pid: null, markerBytes: null, deny: null, reads: null, aliveAfterReads: null, stopped: null };
    q3.targets[name] = out;
    let node = process.execPath;
    if (name === "T2") {
      if (!mac) { out.start = "skipped: not the Mac"; continue; }
      const prep = await prepareCopy(execReal);
      out.prepare = prep.json;
      if (!prep.copy) { out.start = "skipped: the copy was not made or not signed"; continue; }
      node = prep.copy;
    }
    if (timeLeft() < START_MS + TOOL_MS) { out.start = `skipped: ${NEAR}`; if (name !== "T2") failedStarts.push(name); continue; }
    const c = startHelper(node, ["target", name]);
    const first = await firstMessage<{ ready?: boolean; markerBytes?: number; markerHex?: string; deny?: Record<string, unknown> | null }>(c, START_MS);
    if (!("msg" in first) || first.msg?.ready !== true || typeof first.msg.markerHex !== "string") {
      out.start = "msg" in first ? "no ready message" : first.why;
      out.stopped = await stopTarget(c);
      if (name !== "T2") failedStarts.push(name);
      continue;
    }
    started++;
    const hex = first.msg.markerHex;
    words.push(hex);
    Object.assign(out, { started: true, start: "ok", pid: c.pid ?? null, markerBytes: first.msg.markerBytes ?? null, deny: cleanDeny(first.msg.deny ?? null) });
    if (mac && c.pid) {
      // The reads fill out.reads as they go, so that a stop (the time limit, an error) prints what ran.
      const reads: Record<string, any> = (out.reads = { a: null, b: null, c: null, cFull: null, d: null });
      await readTarget(name, c.pid, [Buffer.from(hex, "hex"), Buffer.from(hex, "latin1")], guards!, reads);
      summaries[name] = summaryOf(reads);
    }
    out.aliveAfterReads = running(c);
    out.stopped = await stopTarget(c);
    stops.push(out.stopped as string);
  }
  if (mac) summary = summaries;

  // The end: each target and tool that is left, the folder.
  stage = "cleanup";
  await sleep(50);
  const leftAtEnd = children.filter(running).length + tools.size;
  for (const c of children) if (running(c)) { try { c.kill("SIGKILL"); } catch {} }
  for (const c of tools) killGroup(c);
  rmSync(dir, { recursive: true, force: true });
  const folderRemoved = !existsSync(dir);
  done(dir);
  const cleanup = { targets: started, helpers: children.length, tools: toolRuns, killedAtStop: stops.filter((s) => s === "killed").length, leftAtEnd, folderRemoved };

  if (leftAtEnd > 0 || !folderRemoved) return finish({ ok: false, reason: "a target, a helper, a tool or the folder was left at the end", cleanup }, 0);
  if (failedStarts.length) { stage = `q3-${failedStarts[0]}`; return finish({ ok: false, reason: `the target ${failedStarts[0]} did not start`, cleanup }, 0); }
  stage = "done";
  if (!mac) return finish({ ok: false, reason: "not the Mac (linux): the dry run started and ended T0 and T1 (T1 with prctl PR_SET_DUMPABLE 0) and checked the tool runner; Q1 to Q3 need the Mac", cleanup }, 0);
  finish({ ok: true, reason: null, cleanup }, 0);
}

/** T1's call as JSON: fixed words and numbers only. */
function cleanDeny(d: Record<string, unknown> | null) {
  if (!d) return null;
  if (typeof d.failed === "string") return { failed: clean(d.failed) };
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return { call: typeof d.call === "string" ? clean(d.call) : null, ret: num(d.ret), errno: num(d.errno), after: num(d.after) };
}

/**
 * A plain copy of a file's bytes into a new file of mode 0700: no clone and no copyfile(3), so that no extended attribute
 * of the source (com.apple.quarantine above all: Gatekeeper could then show a dialog at T2's start) comes with it.
 */
function copyBytes(from: string, to: string): void {
  const src = openSync(from, "r"), dst = openSync(to, "wx", 0o700);
  try {
    const buf = Buffer.alloc(CHUNK_BYTES);
    for (let n; (n = readSync(src, buf, 0, buf.length, null)) > 0;) for (let at = 0; at < n;) at += writeSync(dst, buf, at, n - at);
  } finally { closeSync(src); closeSync(dst); }
}

/** T2's copy: the probe's Node copied into the folder (copyBytes), signed ad hoc with the hardened runtime and T2's entitlements, then its signature read. */
async function prepareCopy(execReal: string): Promise<{ copy: string | null; json: Record<string, unknown> }> {
  const copy = join(dir!, "node-t2"), plist = join(dir!, "t2.entitlements.plist");
  const json: Record<string, unknown> = { copy: null, copyMB: null, sign: null, signature: null };
  try { copyBytes(execReal, copy); json.copy = "ok"; json.copyMB = mb(sizeOf(copy)); }
  catch (e) { json.copy = `failed: ${clean((e as { code?: string }).code ?? "error")}`; return { copy: null, json }; }
  writeFileSync(plist, entitlementsPlist(), { mode: 0o600 });
  if (timeLeft() < SIGN_MS) { json.sign = skipped(NEAR); return { copy: null, json }; }
  const sign = await runTool(BIN.codesign, ["--force", "--sign", "-", "--options", "runtime", "--entitlements", plist, copy], SIGN_MS);
  json.sign = runJson(sign);
  if (runClass(sign) !== "ok") return { copy: null, json };
  const sig = signatureJson(await runTool(BIN.codesign, ["-d", "--verbose=4", copy], QUICK_MS), await runTool(BIN.codesign, ["-d", "--entitlements", "-", "--xml", copy], QUICK_MS));
  json.signature = sig;
  return { copy, json };
}

/** The reads of one target, in their order: a, b, c (and cFull), d; each into `json` as soon as it ends. */
async function readTarget(name: TargetName, pid: number, needles: Buffer[], guards: Guards, json: Record<string, any>): Promise<void> {
  const fits = (ms: number) => timeLeft() >= ms;

  // a. task_for_pid and task_read_for_pid in a port reader on the probe's own Node.
  if (guards.a !== "run") json.a = skipped(guards.a.replace(/^skipped: /, ""));
  else if (!fits(TOOL_MS)) json.a = skipped(NEAR);
  else {
    const t = Date.now();
    const c = startHelper(process.execPath, ["port", String(pid)]);
    const m = await firstMessage<{ port?: PortAnswer }>(c, TOOL_MS);
    if (running(c)) { try { c.kill("SIGKILL"); } catch {} }
    json.a = "msg" in m && m.msg?.port ? portJson("ok", Date.now() - t, m.msg.port) : portJson("msg" in m ? "no answer" : m.why, Date.now() - t, null);
  }

  // b. vmmap --summary.
  if (!fits(TOOL_MS)) json.b = skipped(NEAR);
  else { json.b = readerJson("vmmap", await runTool(BIN.vmmap, ["--summary", String(pid)], TOOL_MS)); }

  // c. leaks --outputGraph, the marker's byte search, the file removed at once; cFull with --fullContent when the file held no marker.
  const leaks = async (file: string, extra: string[]) => {
    const r = await runTool(BIN.leaks, [`--outputGraph=${file}`, ...extra, String(pid)], TOOL_MS);
    const bytes = sizeOf(file);
    const found = bytes !== null && bytes > 0 ? searchFile(file, needles) : null;
    try { rmSync(file, { force: true }); } catch {}
    return {
      ...readerJson("leaks", r, bytes), graphMB: mb(bytes),
      markerFound: found ? found.found.some(Boolean) : null, forms: found ? { raw: found.found[0], hex: found.found[1] } : null,
      graphRemoved: !existsSync(file),
    };
  };
  if (!fits(TOOL_MS)) json.c = skipped(NEAR);
  else {
    json.c = await leaks(join(dir!, `${name}.memgraph`), []);
    if (json.c.markerFound === false) json.cFull = fits(TOOL_MS) ? await leaks(join(dir!, `${name}-full.memgraph`), ["--fullContent"]) : skipped(NEAR);
  }

  // d. lldb attach, under its guard; it detaches, and its group is killed at its time limit.
  if (guards.d !== "run") json.d = skipped(guards.d.replace(/^skipped: /, ""));
  else if (!fits(TOOL_MS)) json.d = skipped(NEAR);
  else { json.d = readerJson("lldb", await runTool(BIN.lldb, ["--batch", "--no-lldbinit", "-p", String(pid), "-o", "process status", "-o", "detach"], TOOL_MS)); }
}

/** The Linux dry run's check of the tool runner: an exit 0 with its text, a time limit (its group is killed: /proc has no such pid after it), a missing tool. */
async function runnerCheck() {
  const ok = await runTool(process.execPath, ["-e", "process.stdout.write('ok')"], QUICK_MS);
  const slow = await runTool(process.execPath, ["-e", "setInterval(() => {}, 1000)"], 500);
  const missing = await runTool(join(dir!, "no-such-tool"), [], QUICK_MS);
  return {
    ok: runClass(ok), okText: ok.text === "ok", timeout: runClass(slow), timeoutGone: slow.pid ? !existsSync(`/proc/${slow.pid}`) : null,
    missing: runClass(missing), left: tools.size,
  };
}

