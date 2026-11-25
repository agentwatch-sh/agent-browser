// The Mac peer probe (board ab-v16.52, part 1; the T4 row of section 12 of
// docs/superpowers/specs/2026-11-05-peer-admission-design.md). ONE read-only run on the Mac measures the Mac side of the
// relay's peer check (src/relay/peer.ts, MacReader), with node:ffi into libSystem as the relay calls it:
//
//   Q1. LOCAL_PEERPID and LOCAL_PEERCRED's cr_uid of an accepted socket, at the accept and after each step, for four
//       connecters (parts.ts, CASES): a. a child that connects; b. a child that connects and starts a grandchild with the
//       socket, then exits, and the orphan grandchild sends a byte; c. a child that passes the socket with SCM_RIGHTS
//       (Node's IPC channel: no helper program) to its own child, which sends; d. a child that starts a sender with the
//       socket as its stdout, which sends. Case a also runs the relay's own check (readPeer, RootState.walk and check)
//       with the pane of the probe's chain as the root (the probe itself when no tmux is in the chain). Each case names
//       the calls that its new holder makes on the socket before the read between the accept and the byte
//       (holderCalls, from the Node and libuv source).
//   Q2. LOCAL_PEERTOKEN (audit_token_t) at each read of Q1: its pid (val[5]) and pid version (val[7]), against
//       LOCAL_PEERPID, against the p_idversion that proc_uniqidentifierinfo gives for that pid right after (a layout
//       check of val[7]), and against the p_idversion of the role's process as the probe read it at its start (the
//       connecter right after its spawn: a pid that came back gives another version).
//   Q3. node:ffi on the Mac's Node: the symbols (getsockopt, proc_pidinfo, proc_pid_rusage, mach_absolute_time,
//       mach_timebase_info), the relay's own self-test (selfTest of src/relay/peer.ts), the clock (the timebase and
//       mach_absolute_time beside the wall clock), and for the probe and each helper: PROC_PIDTBSDINFO (pbi_start),
//       PROC_PIDT_SHORTBSDINFO, PROC_PIDUNIQIDENTIFIERINFO (p_uniqueid, p_puniqueid, p_idversion) and proc_pid_rusage's
//       ri_proc_start_abstime, with clocksAgree (the two starts of a process of the run agree within 1 s: a coarse
//       check of their offsets and of the timebase; wallMinusAbsMs gives the exact difference) and its count in q3.clocks.
//   Q4. The walk from the probe's process up to launchd (pid 1): each ancestor's pid, ppid, name (pbi_comm, else
//       pbsi_comm), uid, start by each clock, p_uniqueid; whether each child starts at or after its parent by each clock;
//       whether a tmux server is in the chain and its parent is launchd. It reads no argv and no environment.
//
// On Linux the probe runs Q1 only, as its Linux twin (SO_PEERCRED, which names the connecter for the socket's life),
// with the relay's self-test and check, and answers ok false: not the Mac. Any other platform: ok false at once.
//
// It changes no clock, no setting and no file outside its own temp folder (mkdtemp in the temp folder of the system,
// 0700, with the socket in it). It opens no browser and takes no input or screen. Its helpers (helper.ts) end
// themselves after 20 s; the probe ends each case's helpers at the case's end, removes its folder and every helper that
// is left at its end, also after an error, at its time limit (30 s), or at a SIGTERM, SIGINT or SIGHUP (test/temp-dirs.ts).
//
//   node test/live/mac-peer-probe/probe.ts
//
// Output: one JSON document on stdout (parts.ts, resultOf), with no path, no argv, no environment and no secret: the
// result's check refuses every `/`, and its scrub takes out the home folder, the login name and the temp folders.
// Exit: 0 when the probe ran and printed (ok true or false inside); 1 at its time limit or an uncaught error (the JSON
// still prints), and when the result fails its own check (stage "output": the JSON then holds the stop and the cleanup,
// and no part); 2 for an argument (it takes none). It needs node:ffi: Node 26.1 or later. `npm test` runs its pure
// parts (test/mac-peer-probe.test.ts) and its Linux run.

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { homedir, release, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LinuxReader, MacReader, RootState, readPeer, readProc, selfTest, type Libc, type PeerReader, type Proc } from "../../../src/relay/peer.ts";
import { atEnd, done } from "../../temp-dirs.ts";
import {
  AUDIT_TOKEN_SIZE, CASES, END_WAIT_MS, LOCAL_PEERCRED, LOCAL_PEERPID, LOCAL_PEERTOKEN, MAX_SOCKET_PATH, MAX_WALK, PROBE_VERSION, PROC_BSDINFO_SIZE,
  PROC_PIDTBSDINFO, PROC_PIDT_SHORTBSDINFO, PROC_PIDUNIQIDENTIFIERINFO, PROC_SHORTBSDINFO_SIZE, PROC_UNIQIDENTIFIERINFO_SIZE, RUSAGE_INFO_V2,
  RUSAGE_INFO_V2_SIZE, SOL_LOCAL, SOL_SOCKET_LINUX, SO_PEERCRED_LINUX, STEP_MS, TIME_LIMIT_MS, UCRED_SIZE_LINUX, XUCRED_SIZE,
  HOLDER_CALLS, checkResult, clean, clockSummary, clocksAgree, edgesOf, factsJson, factsOf, parseTimebase, parseToken, q2Of, readOut, resultOf, roleOf,
  scrub, uniqRole, walkSummary,
  type CaseName, type Facts, type Got, type Meta, type Now, type Platform, type RawRead, type ReadOut, type Timebase,
} from "./parts.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const HELPER = fileURLToPath(new URL("./helper.ts", import.meta.url));
const t0 = Date.now();
const elapsed = () => Date.now() - t0;
const ownUid = process.getuid?.() ?? -1;

/** A stop of a step: its fixed reason. */
class Stop extends Error {}

// ------------------------------------------------------------------ the run's state (the stops of a crash read it)

let meta: Meta = { version: PROBE_VERSION, commit: "unknown", dirty: null };
let platform: Platform | null = null;
let stage = "args";
let dir: string | null = null;
let server: Server | null = null;
const words: string[] = [];
const sockets: Socket[] = [];
const children: ChildProcess[] = [];
/** The helpers that the probe did not start itself (the grandchild, the receiver, the sender): pid and start time at their start. */
const tracked: { case: string; role: string; pid: number; start: number | null }[] = [];
let q1: { reader: string; cases: Record<string, unknown> } | null = null;
let q3: Record<string, unknown> | null = null;
let q4: Record<string, unknown> | null = null;
let printed = false;
/** A process's parent, start time and state: /proc on Linux; on the Mac MacReader.proc once node:ffi loads (before that, null). */
let procOf: (pid: number) => Proc | null = (pid) => (process.platform === "linux" ? readProc(pid) : null);

/** Print the result once, after its scrub and check; exit with `code` when stdout has it. */
function finish(o: { ok: boolean; reason: string | null; detail?: string | null; cleanup?: unknown; q2?: unknown }, code: number): void {
  if (printed) return;
  printed = true;
  const r = resultOf({ meta, platform, ok: o.ok, stage, reason: o.reason, detail: o.detail ?? null, ms: elapsed(), ownUid, q1, q2: o.q2 ?? null, q3, q4, cleanup: o.cleanup ?? null });
  const s = scrub(r, words);
  let out: Record<string, unknown> = { ...s.value, redacted: s.count };
  const bad = checkResult(out);
  if (bad) {
    out = { ...resultOf({ meta, platform, ok: false, stage: "output", reason: "the result failed its check", detail: `the value at ${bad}`.replace(/[^A-Za-z0-9 .<>\[\]]/g, ""), ms: elapsed(), ownUid, q1: null, q2: null, q3: null, q4: null, cleanup: o.cleanup ?? null }), redacted: s.count };
    code = 1;
  }
  setTimeout(() => process.exit(code), 2000).unref();
  process.stdout.write(`${JSON.stringify(out)}\n`, () => process.exit(code));
}

const running = (c: ChildProcess) => c.exitCode === null && c.signalCode === null;

/** The synchronous end (a crash, the time limit, a signal): kill every helper that is left, close the server, remove the folder. */
function cleanupSync(): void {
  for (const c of children) if (running(c)) { try { c.kill("SIGKILL"); } catch {} }
  killLeft();
  try { server?.close(); } catch {}
  if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch {} done(dir); }
}

process.on("uncaughtException", (e) => crash(e));
process.on("unhandledRejection", (e) => crash(e));
function crash(e: unknown): void {
  if (printed) return;
  cleanupSync();
  const kind = e instanceof Error && /^[A-Za-z]{1,40}$/.test(e.name) ? e.name : "Value";
  finish({ ok: false, reason: "an uncaught error stopped the probe", detail: `an uncaught ${kind}` }, 1);
}
const hardTimer = setTimeout(() => {
  cleanupSync();
  finish({ ok: false, reason: `the time limit of ${TIME_LIMIT_MS / 1000} s for the whole run` }, 1);
}, TIME_LIMIT_MS);
hardTimer.unref();

// ------------------------------------------------------------------ node:ffi

type Lib = {
  getsockopt?: Libc["getsockopt"];
  close?: Libc["close"];
  poll?: Libc["poll"];
  proc_pidinfo?: NonNullable<Libc["proc_pidinfo"]>;
  proc_pid_rusage?: (pid: number, flavor: number, buffer: Buffer) => number;
  mach_absolute_time?: () => bigint;
  mach_timebase_info?: (info: Buffer) => number;
  errno: () => number;
  symbols: Record<string, string>;
};

const I32 = "int32";
const MAC_SYMBOLS: Record<string, { return: string; arguments: string[] }> = {
  getsockopt: { return: I32, arguments: [I32, I32, I32, "buffer", "buffer"] },
  close: { return: I32, arguments: [I32] },
  __error: { return: "pointer", arguments: [] },
  proc_pidinfo: { return: I32, arguments: [I32, I32, "uint64", "buffer", I32] },
  proc_pid_rusage: { return: I32, arguments: [I32, I32, "buffer"] },
  mach_absolute_time: { return: "uint64", arguments: [] },
  mach_timebase_info: { return: I32, arguments: ["buffer"] },
};
const LINUX_SYMBOLS: Record<string, { return: string; arguments: string[] }> = {
  getsockopt: MAC_SYMBOLS.getsockopt,
  close: MAC_SYMBOLS.close,
  poll: { return: I32, arguments: ["buffer", "uint64", I32] },
  __errno_location: { return: "pointer", arguments: [] },
};

/** Each symbol by its own dlopen, so that the result names each one that does not load. */
function loadLib(ffi: any, mac: boolean): Lib {
  const path = mac ? "/usr/lib/libSystem.B.dylib" : "libc.so.6";
  const fns: Record<string, any> = {}, symbols: Record<string, string> = {};
  for (const [name, def] of Object.entries(mac ? MAC_SYMBOLS : LINUX_SYMBOLS)) {
    try { fns[name] = ffi.dlopen(path, { [name]: def }).functions[name]; symbols[name] = "ok"; }
    catch (e) { symbols[name] = clean((e as Error).message) || "failed"; }
  }
  const errnoAt = fns.__error ?? fns.__errno_location;
  return { ...fns, errno: () => (errnoAt ? ffi.getInt32(errnoAt(), 0) : -1), symbols } as Lib;
}

// ------------------------------------------------------------------ the run

/** The probe's commit: its checkout's HEAD, and whether a tracked file differs from it. Read only: --no-optional-locks keeps git status from writing the index. */
function readMeta(): Meta {
  const git = (args: string[]) => {
    try { return execFileSync("git", ["--no-optional-locks", "-C", ROOT, ...args], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; }
  };
  const head = git(["rev-parse", "HEAD"]), status = git(["status", "--porcelain", "--untracked-files=no"]);
  return { version: PROBE_VERSION, commit: head && /^[0-9a-f]{40}$/.test(head) ? head : "unknown", dirty: status === null ? null : status.length > 0 };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(test: () => boolean, ms: number, why: string): Promise<void> {
  const end = Date.now() + ms;
  while (!test()) {
    if (Date.now() > end) throw new Stop(why);
    await sleep(5);
  }
}

meta = readMeta();
words.push(homedir(), ROOT, ROOT.replace(/\/$/, ""), tmpdir());
try { words.push(userInfo().username); } catch {}
platform = { os: process.platform, arch: process.arch, node: process.versions.node, release: release() };
if (process.argv.length > 2) {
  process.stderr.write("mac-peer-probe: the probe takes no argument\nusage: node test/live/mac-peer-probe/probe.ts\n");
  finish({ ok: false, reason: "the probe takes no argument" }, 2);
} else await main().catch(crash);

async function main(): Promise<void> {
  stage = "platform";
  const mac = process.platform === "darwin";
  if (!mac && process.platform !== "linux") return finish({ ok: false, reason: `not the Mac: the probe has no reader for ${clean(process.platform)}` }, 0);

  stage = "ffi";
  let ffi: any;
  try { const mod: any = await import("node:ffi"); ffi = mod.default ?? mod; }
  catch (e) { return finish({ ok: false, reason: "node:ffi does not load", detail: clean((e as { code?: string }).code ?? (e as Error).message) }, 0); }
  const lib = loadLib(ffi, mac);
  q3 = { ffi: { loaded: true, symbols: lib.symbols } };
  if (!lib.getsockopt) return finish({ ok: false, reason: "getsockopt does not load" }, 0);
  const libc: Libc = { getsockopt: lib.getsockopt, poll: lib.poll ?? (() => -1), close: lib.close ?? (() => 0), errno: lib.errno, proc_pidinfo: lib.proc_pidinfo };
  const macReader = new MacReader(libc);
  const linuxReader = new LinuxReader(libc, "stat");
  if (mac) procOf = (pid) => macReader.proc(pid);

  // The calls of the probe's own reads (each failure is a value of the result, not a stop).
  const gso = (fd: number, level: number, name: number, size: number): Got => {
    const value = Buffer.alloc(size), length = Buffer.alloc(4);
    length.writeUInt32LE(size);
    if (lib.getsockopt!(fd, level, name, value, length) !== 0) return { err: `errno ${lib.errno()}` };
    const n = length.readUInt32LE(0);
    return n > 0 ? { b: value.subarray(0, Math.min(n, size)) } : { err: "0 bytes" };
  };
  const pidinfo = (pid: number, flavor: number, size: number): Got => {
    if (!lib.proc_pidinfo) return { err: "no symbol" };
    const b = Buffer.alloc(size);
    const n = lib.proc_pidinfo(pid, flavor, 0n, b, size);
    return n > 0 ? { b: b.subarray(0, n) } : { err: `errno ${lib.errno()}` };
  };
  const rusage = (pid: number): Got => {
    if (!lib.proc_pid_rusage) return { err: "no symbol" };
    const b = Buffer.alloc(RUSAGE_INFO_V2_SIZE);
    return lib.proc_pid_rusage(pid, RUSAGE_INFO_V2, b) === 0 ? { b } : { err: `errno ${lib.errno()}` };
  };
  const macFacts = (pid: number): Facts => factsOf(pid, {
    bsd: pidinfo(pid, PROC_PIDTBSDINFO, PROC_BSDINFO_SIZE),
    short: pidinfo(pid, PROC_PIDT_SHORTBSDINFO, PROC_SHORTBSDINFO_SIZE),
    uniq: pidinfo(pid, PROC_PIDUNIQIDENTIFIERINFO, PROC_UNIQIDENTIFIERINFO_SIZE),
    rusage: rusage(pid),
  });
  let tb: Timebase | null = null;
  if (lib.mach_timebase_info) { const b = Buffer.alloc(8); if (lib.mach_timebase_info(b) === 0) tb = parseTimebase(b); }
  const nowOf = (): Now => ({ abs: lib.mach_absolute_time ? lib.mach_absolute_time() : null, wallUs: Date.now() * 1000 });

  // Q3: the clock and the probe's own process (the helpers' rows come with Q1).
  const procs: Record<string, unknown>[] = [];
  const factsBy = new Map<string, Facts>();
  const row = (kase: string, role: string, pid: number, at = "start") => {
    if (!mac) return;
    const f = macFacts(pid);
    factsBy.set(`${kase}:${role}:${at}`, f);
    const j = factsJson(f, nowOf(), tb);
    procs.push({ case: kase, role, at, ...j, clocksAgree: clocksAgree(j) });
    q3!.clocks = clockSummary(procs as { clocksAgree: boolean | null }[]);
  };
  if (mac) {
    const now = nowOf();
    q3.clock = { timebase: tb, abs: now.abs === null ? null : now.abs.toString(), absMs: now.abs !== null && tb ? Number((now.abs * BigInt(tb.numer)) / BigInt(tb.denom) / 1_000_000n) : null, wallUs: now.wallUs };
    q3.procs = procs;
    row("-", "probe", process.pid);
  }

  stage = "folder";
  dir = mkdtempSync(join(tmpdir(), "ab-pp-"));
  atEnd(dir, cleanupSync);
  words.push(dir);
  try { words.push(realpathSync(dir)); } catch {}
  const sockPath = join(dir, "p.sock");
  if (Buffer.byteLength(sockPath) > MAX_SOCKET_PATH) { cleanupSync(); return finish({ ok: false, reason: `the socket path is longer than ${MAX_SOCKET_PATH} bytes: set TMPDIR to a shorter folder` }, 0); }

  // Q3: the relay's own self-test, next to the probe's socket; its reader runs case a's relay check.
  stage = "selftest";
  const st = await selfTest(join(dir, "relay.sock"));
  q3.selfTest = "reader" in st ? { ok: true, form: st.reader.form } : { ok: false, failed: clean(st.failed) };
  const relayReader: PeerReader | null = "reader" in st ? st.reader : mac ? macReader : null;

  // Q4: the walk from the probe's process to launchd.
  let pane: { pid: number } | null = null;
  if (mac) {
    stage = "q4";
    const now = nowOf();
    const chain: Facts[] = [];
    for (let pid = process.pid, i = 0; i <= MAX_WALK; i++) {
      const f = macFacts(pid);
      chain.push(f);
      if (pid === 1 || f.ppid === null || f.ppid === 0 || f.ppid === pid) break;
      pid = f.ppid;
    }
    const edges = edgesOf(chain), summary = walkSummary(chain, edges);
    pane = summary.pane;
    q4 = { chain: chain.map((f) => factsJson(f, now, tb)), edges, summary };
  }

  stage = "listen";
  const srv = (server = createServer());
  const pending: Socket[] = [];
  srv.on("connection", (s) => { sockets.push(s); s.on("error", () => {}); pending.push(s); });
  try { await new Promise<void>((resolve, reject) => { srv.once("error", reject); srv.listen(sockPath, resolve); }); }
  catch (e) { cleanupSync(); return finish({ ok: false, reason: "the probe's socket does not listen", detail: clean((e as Error).message, words) }, 0); }

  const fdOf = (s: Socket) => { const fd = (s as unknown as { _handle?: { fd?: unknown } })._handle?.fd; if (typeof fd !== "number" || fd < 0) throw new Stop("the accepted socket has no fd"); return fd; };
  const readAt = (fd: number): RawRead => {
    if (!mac) return { form: "linux", ucred: gso(fd, SOL_SOCKET_LINUX, SO_PEERCRED_LINUX, UCRED_SIZE_LINUX), relay: linuxReader.cred(fd) };
    const peerPid = gso(fd, SOL_LOCAL, LOCAL_PEERPID, 4);
    const cred = gso(fd, SOL_LOCAL, LOCAL_PEERCRED, XUCRED_SIZE);
    const token = gso(fd, SOL_LOCAL, LOCAL_PEERTOKEN, AUDIT_TOKEN_SIZE);
    const tp = "b" in token ? parseToken(token.b)?.pid ?? 0 : 0;
    return { form: "mac", peerPid, cred, token, tokenProc: tp > 0 ? pidinfo(tp, PROC_PIDUNIQIDENTIFIERINFO, PROC_UNIQIDENTIFIERINFO_SIZE) : null, relay: macReader.cred(fd) };
  };
  const touch = (name: string) => { if (dir) writeFileSync(join(dir, name), ""); };
  const alive = (t: { pid: number; start: number | null }) => { const p = procOf(t.pid); return p !== null && p.state !== "Z" && (t.start === null || p.start === t.start); };

  /** The relay's own check of case a's connecter (C11 steps 3 and 6), with one root: the pane of the probe's chain, else the probe. */
  const relayCheck = (fd: number, connecter: number) => {
    if (!relayReader) return { ran: false, why: "no reader" };
    const rootPid = pane?.pid ?? process.pid;
    const rp = relayReader.proc(rootPid);
    if (!rp) return { ran: false, why: "the root's start cannot be read" };
    const state = RootState.read(relayReader, new Map([["probe", [{ pid: rootPid, start: rp.start }]]]));
    let hops: number | null = null;
    for (let pid = connecter, n = 0; n <= MAX_WALK; n++) {
      if (pid === rootPid) { hops = n; break; }
      const p = relayReader.proc(pid);
      if (!p || p.ppid === 0) break;
      pid = p.ppid;
    }
    const peer = readPeer(relayReader, fd, ownUid);
    try {
      return {
        ran: true, reader: relayReader.form, root: pane ? "pane" : "probe", hops, peerRead: peer !== null,
        walkMet: peer ? state.walk(relayReader, peer.pid) !== null : null, admitted: peer ? state.check(relayReader, "probe", peer) !== null : null,
      };
    } finally { peer?.release(relayReader); }
  };

  /** The end of a case: its end file, the probe's side of its socket, the connecter's channel; then the wait, then SIGKILL of what is left. */
  const endCase = async (k: CaseName, c: ChildProcess | null, sock: Socket | null) => {
    try { touch(`end-${k}`); } catch {}
    sock?.destroy();
    if (c && running(c) && c.connected) { try { c.disconnect(); } catch {} }
    const mine = tracked.filter((t) => t.case === k);
    await until(() => (!c || !running(c)) && mine.every((t) => !alive(t)), END_WAIT_MS, "").catch(() => {});
    const left = (c && running(c) ? 1 : 0) + mine.filter(alive).length;
    if (c && running(c)) { try { c.kill("SIGKILL"); } catch {} }
    killLeft(mine);
    return left;
  };

  stage = "q1";
  q1 = { reader: mac ? "LOCAL_PEERPID, LOCAL_PEERCRED and LOCAL_PEERTOKEN (getsockopt through node:ffi)" : "SO_PEERCRED, the Linux twin (getsockopt through node:ffi)", cases: {} };
  let leftAtCaseEnds = 0;
  let firstStop: { stage: string; reason: string } | null = null;
  for (const k of Object.keys(CASES) as CaseName[]) {
    stage = `q1-${k}`;
    const out: { how: string; holderCalls: string | null; pids: Record<string, number>; reads: ReadOut[]; stopped: string | null; [more: string]: unknown } = { how: CASES[k], holderCalls: HOLDER_CALLS[k], pids: {}, reads: [], stopped: null };
    q1.cases[k] = out;
    const known: Record<string, number> = { probe: process.pid };
    let c: ChildProcess | null = null, sock: Socket | null = null;
    try {
      c = spawn(process.execPath, ["--disable-sigusr1", HELPER, "connect", k, sockPath, dir], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
      children.push(c);
      c.on("error", () => {});
      const cp = c.pid;
      if (!cp) throw new Stop("the connecter did not start");
      known.connecter = out.pids.connecter = cp;
      // The connecter's own read at its start, before its connect: the token at the accept must give its p_idversion.
      row(k, "connecter", cp);
      await until(() => pending.length > 0 || !running(c!), STEP_MS, "the connecter did not connect");
      if (!pending.length) throw new Stop("the connecter ended before its connect");
      sock = pending.shift()!;
      const fd = fdOf(sock);
      let bytes = 0;
      sock.on("data", (d: Buffer) => { bytes += d.length; });
      const started = () => Object.fromEntries(Object.keys(known).filter((r) => r !== "probe").map((r) => [r, factsBy.get(`${k}:${r}:start`)?.pidVersion ?? null]));
      const read = (at: string) => { out.reads.push(readOut(at, readAt(fd), known, ownUid, started())); };
      read("accept");
      if (k === "a") out.relayCheck = relayCheck(fd, cp);
      const helper = async (role: string) => {
        const file = join(dir!, `ready-${k}`);
        await until(() => existsSync(file), STEP_MS, `the ${role} did not start`);
        const pid = Number(readFileSync(file, "latin1"));
        if (!Number.isSafeInteger(pid) || pid <= 1) throw new Stop(`the ${role}'s ready file holds no pid`);
        tracked.push({ case: k, role, pid, start: procOf(pid)?.start ?? null });
        known[role] = out.pids[role] = pid;
        row(k, role, pid);
        return pid;
      };
      const byte = async (role: string) => {
        touch(`go-${k}`);
        await until(() => bytes >= 1, STEP_MS, `the ${role}'s byte did not come`);
      };
      const uniqs = () => ({ connecter: factsBy.get(`${k}:connecter:start`)?.uniqueid ?? null, probe: factsBy.get("-:probe:start")?.uniqueid ?? null, launchd: mac ? macFacts(1).uniqueid : null });
      const parentOf = (pid: number) => {
        const p = procOf(pid);
        const f = mac ? macFacts(pid) : null;
        return { ppid: p?.ppid ?? null, ppidIs: p ? roleOf(p.ppid, known) : null, puniqueidIs: f ? uniqRole(f.puniqueid, uniqs()) : null };
      };
      if (k === "b") {
        c.send({ do: "fork" });
        const g = await helper("grandchild");
        const before = parentOf(g);
        read("afterFork");
        c.disconnect();
        await until(() => !running(c!), STEP_MS, "the connecter did not end");
        await until(() => { const p = procOf(g); return p !== null && p.ppid !== cp; }, STEP_MS, "the grandchild's parent did not change");
        const after = parentOf(g);
        row(k, "grandchild", g, "afterExit");
        read("afterExit");
        await byte("grandchild");
        read("afterSend");
        out.reparent = { before, after };
      } else if (k === "c") {
        c.send({ do: "pass" });
        await helper("receiver");
        read("afterPass");
        await byte("receiver");
        read("afterSend");
      } else if (k === "d") {
        c.send({ do: "spawn" });
        await helper("sender");
        read("afterSpawn");
        await byte("sender");
        read("afterSend");
      }
    } catch (e) {
      out.stopped = e instanceof Stop ? e.message : `an error stopped the case: ${clean(e instanceof Error ? e.message : String(e), words)}`;
      firstStop ??= { stage, reason: out.stopped };
    } finally {
      leftAtCaseEnds += await endCase(k, c, sock);
    }
  }

  // The end: every helper that is left, the server, the folder.
  stage = "cleanup";
  for (const k of Object.keys(CASES)) { try { touch(`end-${k}`); } catch {} }
  await until(() => children.every((c) => !running(c)) && tracked.every((t) => !alive(t)), END_WAIT_MS, "").catch(() => {});
  const leftAtEnd = children.filter(running).length + tracked.filter(alive).length;
  for (const c of children) if (running(c)) { try { c.kill("SIGKILL"); } catch {} }
  const killed = killLeft();
  await new Promise<void>((r) => srv.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
  const folderRemoved = !existsSync(dir);
  done(dir);
  const cleanup = { helpers: children.length + tracked.length, leftAtCaseEnds, leftAtEnd, killedAtEnd: killed, folderRemoved };

  const q2 = mac ? q2Of(q1.cases as Record<string, { reads?: ReadOut[] }>) : null;
  if (firstStop) { stage = firstStop.stage; return finish({ ok: false, reason: firstStop.reason, cleanup, q2 }, 0); }
  if (leftAtEnd > 0 || !folderRemoved) return finish({ ok: false, reason: "a helper or the folder was left at the end", cleanup, q2 }, 0);
  stage = "done";
  if (!mac) return finish({ ok: false, reason: "not the Mac (linux): Q1 ran as its Linux twin (SO_PEERCRED) with the relay's self-test and check; Q2, the Mac reads of Q3, and Q4 need the Mac", cleanup }, 0);
  finish({ ok: true, reason: null, cleanup, q2 }, 0);
}

/**
 * SIGKILL of each tracked helper that still runs with the start time of its start: a pid that came back is left alone,
 * and so is a helper whose start time the probe could not read.
 */
function killLeft(list = tracked): number {
  let n = 0;
  for (const t of list) {
    if (t.start === null) continue;
    const p = procOf(t.pid);
    if (!p || p.start !== t.start || p.state === "Z") continue;
    try { process.kill(t.pid, "SIGKILL"); n++; } catch {}
  }
  return n;
}
