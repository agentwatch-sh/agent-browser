// What protects the service's memory (the design docs/superpowers/specs/2026-11-10-stored-sign-in-credentials-design.md,
// section 5.5; contract C12, "The stored sign-ins", the protections; board ab-v16.97.2). The open store key lives only in
// the service's memory, so the service opens the store only in a process where both protections hold:
//
// - dumpable: the service calls prctl(PR_SET_DUMPABLE, 0) at its start, through node:ffi (as the peer check loads it).
//   A process of the user without CAP_SYS_PTRACE then cannot attach the service or read its memory, also with
//   ptrace_scope 0, and no crash writes a core of it. Each check reads the flag again (PR_GET_DUMPABLE).
// - signal: the protection of board ab-v16.96 (hold SIGUSR1 at start; disable the inspector signal): the bin installs a
//   listener before any other code, or Node runs with --disable-sigusr1; and no inspector is open.
//
// The reason of the first protection that does not hold: `dumpable` comes before `signal` (C12).
//
// The Mac (board ab-v16.97.8, part 2): macOS has no prctl and no ptrace_scope. The Mac memory probe (part 1, run on the
// operator's Mac 2026-11-25, at aacd9bd) read two Node processes of its own, of the same file as the service's Node (no
// get-task-allow), while DevToolsSecurity was disabled and SIP enabled: task_for_pid KERN_FAILURE and task_read_for_pid
// EPERM; Apple's vmmap and leaks got a read port, but no leaks graph held the probe's marker, and leaks --fullContent
// refused the writable contents ("restricted"). The probe skipped lldb (its guard), so lldb has no measured result.
// When DevToolsSecurity is enabled, a debugger of the same user can get the task port of a process with no hardened
// runtime with no password (not measured). The right system.privilege.taskport says whether a debugger needs the user's
// password: the probe's Mac run (2026-11-27, board ab-v16.97.15) read its default, "a password once, shared for its
// timeout" with a timeout of 36000 s. So the Mac's protected start (macProtectedStart) holds when:
//   - ptrace(PT_DENY_ATTACH) returns 0 (no ptrace attach; xnu sends SIGSEGV to an attacher; a process that a debugger
//     traces already ends at the call), and setrlimit(RLIMIT_CORE, {0, 0}) returns 0 and getrlimit reads 0 (no core);
//   - the service's own Node has no get-task-allow entitlement (codesign), SIP is enabled (csrutil), DevToolsSecurity
//     is disabled (DevToolsSecurity -status), and the taskport right holds (`security authorizationdb read
//     system.privilege.taskport`; the Mac design note, section 6.1: deny, a password at each request, or a password
//     once, shared for a timeout of at most TASKPORT_TIMEOUT_MAX).
// On the Mac the reason `dumpable` means that this protection does not hold; the log line names the check. A check of
// the start that does not hold gives "dumpable" until the service starts again.
//
// The background reader (board ab-v16.97.15; the Mac design note, section 6.2): after the start, every MAC_READ_EVERY_MS
// one asynchronous run of DevToolsSecurity and one of `security`, each killed after MAC_CHECK_MS. No op and no status
// read runs a tool: dumpable() reads the cached reading. `sign_ins_setup` and `sign_ins_unlock` wait for one fresh read
// (fresh). The reading holds while its last read of DevToolsSecurity is disabled, the right holds, and the read is at
// most MAC_READING_MAX_AGE_MS old. A read that fails or comes late (of either tool) does not hold for as long as it
// lasts, with no latch: the next read that holds clears it. A read of enabled, or a form of the right that does not
// hold, latches "dumpable" until the service starts again: a task port that a debugger took then stays good. Each
// reading that does not hold, and a reading that grows too old, tells the watchers (onLost): the store locks an open
// store at once. The other facts hold from the start: PT_DENY_ATTACH is never undone, the hard limit 0 cannot rise
// without root, and SIP and the Node's signature change only with a restart. Not seen: an enable, an attach and a
// disable within one period, and authd's shared credential after the operator typed the password at a debugger's prompt.

import { spawn, spawnSync } from "node:child_process";
import { url as inspectorUrl } from "node:inspector";
import { parseCsrutil, parseDevToolsSecurity, parseEntitlements, parseTaskport, runClass, SECURITY, TASKPORT_RIGHT, type TaskportMeaning, type ToolRun, type Tri } from "./mac-tools.ts";

export const PROTECTIONS = ["dumpable", "signal"] as const;
export type Unprotected = (typeof PROTECTIONS)[number];

const PR_GET_DUMPABLE = 3, PR_SET_DUMPABLE = 4;
type Prctl = (option: number, a: bigint, b: bigint, c: bigint, d: bigint) => number;

/** node:ffi by a dynamic import (only the real service loads it, at its start): the module, or why it does not load. */
async function importFfi(): Promise<{ ffi: any } | { failed: string }> {
  try { const mod: any = await import("node:ffi"); return { ffi: mod.default ?? mod }; }
  catch (e) { return { failed: `node:ffi does not load (${(e as { code?: string }).code ?? (e as Error).message})` }; }
}

/** prctl(2) through node:ffi; a failure gives its reason (node:ffi does not load, or the dlopen of libc fails). */
export async function loadPrctl(platform: NodeJS.Platform = process.platform): Promise<{ prctl: Prctl } | { failed: string }> {
  if (platform !== "linux") return { failed: `no prctl on ${platform}` };
  const m = await importFfi();
  if ("failed" in m) return m;
  const { ffi } = m;
  try {
    const { functions: f } = ffi.dlopen("libc.so.6", { prctl: { return: "int32", arguments: ["int32", "uint64", "uint64", "uint64", "uint64"] } });
    return { prctl: (o, a, b, c, d) => f.prctl(o, a, b, c, d) };
  } catch (e) { return { failed: `prctl does not load: ${(e as Error).message}` }; }
}

/**
 * The non-dumpable start: prctl(PR_SET_DUMPABLE, 0), then a reader of the flag for each later check. A failure leaves a
 * reader that always says "dumpable", with the reason for the log.
 */
export async function nonDumpableStart(load: () => Promise<{ prctl: Prctl } | { failed: string }> = () => loadPrctl()): Promise<{ dumpable: () => boolean; failed: string | null }> {
  const p = await load();
  if ("failed" in p) return { dumpable: () => true, failed: p.failed };
  if (p.prctl(PR_SET_DUMPABLE, 0n, 0n, 0n, 0n) !== 0) return { dumpable: () => true, failed: "prctl(PR_SET_DUMPABLE, 0) failed" };
  return { dumpable: () => p.prctl(PR_GET_DUMPABLE, 0n, 0n, 0n, 0n) !== 0, failed: null };
}

// ------------------------------------------------------------------ the Mac (board ab-v16.97.8, part 2)

/** sys/ptrace.h: PT_DENY_ATTACH. */
export const PT_DENY_ATTACH = 31;
/** macOS's sys/resource.h: RLIMIT_CORE (a Mac arm64 or x86_64 is little-endian, as the reads of struct rlimit below need). */
export const RLIMIT_CORE_MAC = 4;
/** struct rlimit on macOS: rlim_cur and rlim_max, each a uint64. */
const RLIMIT_SIZE = 16;
/** The time limit of each tool run of the Mac's start (the probe measured 6 to 10 ms for each). */
export const MAC_START_MS = 5000;
/** The time limit of each tool run of the background reader (asynchronous; a run killed at it is a read that came late). */
export const MAC_CHECK_MS = 1500;
/** The background reader's period. */
export const MAC_READ_EVERY_MS = 10_000;
/** A reading older than this does not hold (a reader that is stuck). */
export const MAC_READING_MAX_AGE_MS = 25_000;
/**
 * The longest shared timeout of the taskport right that holds (s): the right's default, which the probe's Mac run read
 * on 2026-11-27 (36000 s, 10 hours). So the bound refuses only a longer timeout, that is a change of the right; it is no
 * protection against the default's own limit (C12, the protections: not seen).
 */
export const TASKPORT_TIMEOUT_MAX = 36000;
/** The Mac's read-only tools, by their absolute paths (as the Mac memory probe runs them). */
export const MAC_TOOLS = { codesign: "/usr/bin/codesign", csrutil: "/usr/bin/csrutil", devToolsSecurity: "/usr/sbin/DevToolsSecurity", security: SECURITY } as const;
/** The arguments of each tool read that the start and the background reader repeat. */
const DTS_ARGS = ["-status"] as const;
const TASKPORT_ARGS = ["authorizationdb", "read", TASKPORT_RIGHT] as const;
/** The most text of a tool that the start keeps, of stdout and of stderr each. */
const TOOL_TEXT_MAX = 64 * 1024;

/** The libSystem calls of the Mac's protected start (the tests give a fake). */
export type MacMemLib = {
  /** ptrace(2): 0, or -1 and errno. */
  ptrace(request: number, pid: number, addr: bigint, data: number): number;
  /** setrlimit(2) and getrlimit(2) with a struct rlimit of RLIMIT_SIZE bytes: 0, or -1 and errno. */
  setrlimit(resource: number, rlim: Buffer): number;
  getrlimit(resource: number, rlim: Buffer): number;
  /** The errno of the last call (through __error). */
  errno(): number;
};

/**
 * node:ffi's dlopen of libSystem (a dynamic import, as the peer check loads it); why it failed, else the calls. The tests
 * give a stand-in of node:ffi (`ffiLoad`) and pin the declarations.
 */
export async function loadMacMemLib(platform: NodeJS.Platform = process.platform, ffiLoad: () => Promise<{ ffi: any } | { failed: string }> = importFfi): Promise<MacMemLib | { failed: string }> {
  if (platform !== "darwin") return { failed: `no ptrace PT_DENY_ATTACH on ${platform}` };
  const m = await ffiLoad();
  if ("failed" in m) return m;
  const { ffi } = m;
  try {
    // ptrace's signature is the Mac memory probe's (its T1 measured ret 0 on the Mac).
    const { functions: f } = ffi.dlopen("/usr/lib/libSystem.B.dylib", {
      ptrace: { return: "int32", arguments: ["int32", "int32", "pointer", "int32"] },
      setrlimit: { return: "int32", arguments: ["int32", "buffer"] },
      getrlimit: { return: "int32", arguments: ["int32", "buffer"] },
      __error: { return: "pointer", arguments: [] },
    });
    return { ptrace: f.ptrace, setrlimit: f.setrlimit, getrlimit: f.getrlimit, errno: () => ffi.getInt32(f.__error(), 0) };
  } catch (e) { return { failed: `dlopen of libSystem failed: ${(e as Error).message}` }; }
}

/** One run of a read-only tool with a time limit; never throws (a spawn error is the run's spawnError). */
export type MacToolRun = (cmd: string, args: readonly string[], ms: number) => ToolRun;
/** The same run, asynchronous: the background reader's (no op and no status read waits for it). */
export type MacToolRunAsync = (cmd: string, args: readonly string[], ms: number) => Promise<ToolRun>;

/**
 * The real runner: one synchronous run, stdin from /dev/null, SIGKILL at the time limit, the first TOOL_TEXT_MAX
 * characters of stdout and stderr. Only the start runs it, before any door opens.
 */
export const runToolSync: MacToolRun = (cmd, args, ms) => {
  const t0 = Date.now();
  const r = spawnSync(cmd, args, { timeout: ms, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", maxBuffer: TOOL_TEXT_MAX * 4 });
  const code = (r.error as NodeJS.ErrnoException | undefined)?.code ?? null;
  const timedOut = code === "ETIMEDOUT";
  return {
    exit: r.status, signal: r.signal, timedOut, stopped: null, spawnError: code !== null && !timedOut ? code : null,
    stdout: (r.stdout ?? "").slice(0, TOOL_TEXT_MAX), stderr: (r.stderr ?? "").slice(0, TOOL_TEXT_MAX), ms: Date.now() - t0,
  };
};

/**
 * The background reader's runner: one asynchronous run, stdin from /dev/null, SIGKILL at the time limit, the first
 * TOOL_TEXT_MAX characters of stdout and stderr. It answers at the child's close, or at most 500 ms after the kill (a
 * child that does not close then is a run that came late).
 */
export const runToolAsync: MacToolRunAsync = (cmd, args, ms) => new Promise((resolve) => {
  const t0 = Date.now();
  let stdout = "", stderr = "", timedOut = false, done = false;
  const finish = (r: Partial<ToolRun>) => {
    if (done) return;
    done = true;
    clearTimeout(kill); clearTimeout(late);
    resolve({ exit: null, signal: null, timedOut, stopped: null, spawnError: null, stdout, stderr, ms: Date.now() - t0, ...r });
  };
  let child: ReturnType<typeof spawn>;
  try { child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) { resolve({ exit: null, signal: null, timedOut: false, stopped: null, spawnError: (e as NodeJS.ErrnoException).code ?? "EUNKNOWN", stdout: "", stderr: "", ms: Date.now() - t0 }); return; }
  const kill = setTimeout(() => { timedOut = true; try { child.kill("SIGKILL"); } catch { /* gone */ } }, ms);
  const late = setTimeout(() => { timedOut = true; finish({}); }, ms + 500);
  child.stdout!.setEncoding("utf8").on("data", (d: string) => { if (stdout.length < TOOL_TEXT_MAX) stdout = (stdout + d).slice(0, TOOL_TEXT_MAX); });
  child.stderr!.setEncoding("utf8").on("data", (d: string) => { if (stderr.length < TOOL_TEXT_MAX) stderr = (stderr + d).slice(0, TOOL_TEXT_MAX); });
  child.once("error", (e: NodeJS.ErrnoException) => finish({ spawnError: e.code ?? "EUNKNOWN" }));
  child.once("close", (code, signal) => finish({ exit: code, signal }));
});

/** Why a read gave no answer: its class, or "an unknown text" when the tool ran but its text says neither. */
const unread = (tool: string, r: ToolRun) => `${tool}: ${runClass(r) === "ok" ? "an unknown text" : runClass(r)}`;

/** What a parsed taskport right means for the protection (the Mac design note, section 6.1): it holds, it is weak (a latch), or the read says nothing. */
export function taskportHolds(t: { meaning: TaskportMeaning; right: Record<string, unknown> | null }): "holds" | "weak" | "unknown" {
  switch (t.meaning) {
    case "deny": case "a password at each request": return "holds";
    case "a password once, shared for its timeout": {
      const timeout = t.right?.timeout;
      return typeof timeout === "number" && timeout > 0 && timeout <= TASKPORT_TIMEOUT_MAX ? "holds" : "weak";
    }
    case "unknown": return "unknown";
    default: return "weak";
  }
}

/**
 * The right's shared timeout in seconds (C12's `taskport_shared_s`), or null when the right is not shared. A shared right
 * with no timeout (or 0) has no number either: null; with no timeout the protection does not hold at all (6.1).
 */
export function taskportSharedS(t: { right: Record<string, unknown> | null }): number | null {
  const r = t.right;
  return r && r.shared === true && typeof r.timeout === "number" && r.timeout > 0 ? r.timeout : null;
}

/** One read of the two tools: a weak state (it latches), a read that says nothing (that reading only), or null when both hold. */
function readOf(dtsRun: ToolRun, tpRun: ToolRun): { weak: string | null; unknown: string | null; sharedS: number | null | undefined } {
  const dts: Tri = parseDevToolsSecurity(dtsRun);
  const tp = parseTaskport(tpRun);
  const tpHolds = taskportHolds(tp);
  const weak = dts === "enabled" ? "DevToolsSecurity is enabled" : tpHolds === "weak" ? `the taskport right does not hold (${tp.meaning})` : null;
  const unknown = dts === "unknown" ? `DevToolsSecurity's state cannot be read (${unread("DevToolsSecurity", dtsRun)})`
    : tpHolds === "unknown" ? `the taskport right cannot be read (${unread("security", tpRun)})` : null;
  // The shared timeout of a right that could be parsed; undefined keeps the last one (a read that says nothing).
  return { weak, unknown, sharedS: tp.right ? taskportSharedS(tp) : undefined };
}

/**
 * The Mac's part of the protection after the start (C12, the protections): the background reader's fresh read, the
 * watchers of a reading that does not hold, the right's shared timeout for the status, and the reader's stop.
 */
export type MacReaderPart = {
  /** One fresh read of both tools (sign_ins_setup and sign_ins_unlock wait for it). */
  fresh(): Promise<void>;
  /** `fn` runs at each reading that does not hold, and when the reading grows older than MAC_READING_MAX_AGE_MS. */
  onLost(fn: () => void): void;
  /** C12's `taskport_shared_s`. */
  taskportSharedS(): number | null;
  stop(): void;
};
/** The result of a start of the memory's protection: the reader for each later check, the failure for the log, and the Mac's part. */
export type MemoryProtection = { dumpable: () => boolean; failed: string | null; mac?: MacReaderPart };

/** The background reader (the head of this file): it starts with the start's reading, which held. */
export class MacProtectionReader implements MacReaderPart {
  private latched: string | null = null;
  /** The last reading: its read's start time, and why it does not hold (null: it holds). */
  private reading: { at: number; why: string | null };
  private sharedS: number | null;
  private seq = 0;
  private applied = 0;
  private stale = false;
  private readonly watchers: (() => void)[] = [];
  private timer: NodeJS.Timeout | null = null;
  private readonly o: { run: MacToolRunAsync; now: () => number; everyMs: number; maxAgeMs: number; log: (line: string) => void };

  constructor(o: { run?: MacToolRunAsync; now?: () => number; everyMs?: number; maxAgeMs?: number; log?: (line: string) => void; sharedS: number | null }) {
    this.o = { run: o.run ?? runToolAsync, now: o.now ?? Date.now, everyMs: o.everyMs ?? MAC_READ_EVERY_MS, maxAgeMs: o.maxAgeMs ?? MAC_READING_MAX_AGE_MS, log: o.log ?? (() => {}) };
    this.reading = { at: this.o.now(), why: null };
    this.sharedS = o.sharedS;
  }

  /** The timer of the reads (unref: it keeps no process alive). */
  start(): this {
    if (!this.timer) { this.timer = setInterval(() => this.tick(), this.o.everyMs); this.timer.unref(); }
    return this;
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /** No tool runs here: the latch, the last reading, and its age. */
  dumpable(): boolean { return this.latched !== null || this.reading.why !== null || this.tooOld(); }
  taskportSharedS(): number | null { return this.sharedS; }
  onLost(fn: () => void): void { this.watchers.push(fn); }
  fresh(): Promise<void> { return this.read(); }

  private tooOld(): boolean { return this.o.now() - this.reading.at > this.o.maxAgeMs; }

  /** Each period: a reading that grew too old tells the watchers once, then one read. */
  tick(): void {
    if (this.tooOld() && !this.stale) {
      this.stale = true;
      this.o.log(`service: the Mac's protection does not hold for now (its last read is older than ${Math.round(this.o.maxAgeMs / 1000)} s); the stored sign-ins lock`);
      this.tell();
    }
    void this.read();
  }

  /** One read of both tools at once; a read that ends after a later one changes nothing. */
  private async read(): Promise<void> {
    const n = ++this.seq, at = this.o.now();
    // A runner that throws (none of this file's does) is a read that failed: it never leaves a rejection unhandled.
    const failed = (e: unknown): ToolRun => ({ exit: null, signal: null, timedOut: false, stopped: null, spawnError: (e as NodeJS.ErrnoException)?.code ?? "EUNKNOWN", stdout: "", stderr: "", ms: 0 });
    const runOf = (cmd: string, args: readonly string[]) => { try { return this.o.run(cmd, args, MAC_CHECK_MS).catch(failed); } catch (e) { return Promise.resolve(failed(e)); } };
    const [d, t] = await Promise.all([runOf(MAC_TOOLS.devToolsSecurity, DTS_ARGS), runOf(MAC_TOOLS.security, TASKPORT_ARGS)]);
    if (n < this.applied) return;
    this.applied = n;
    const r = readOf(d, t);
    if (r.sharedS !== undefined) this.sharedS = r.sharedS;
    const before = this.reading.why;
    this.reading = { at, why: r.weak ?? r.unknown };
    this.stale = false;
    if (r.weak && this.latched === null) {
      this.latched = r.weak;
      this.o.log(`service: the Mac's protection does not hold until the service starts again (${r.weak}); the stored sign-ins lock`);
    } else if (!r.weak && r.unknown && before !== r.unknown) this.o.log(`service: the Mac's protection does not hold for now (${r.unknown}); the stored sign-ins lock`);
    else if (!r.weak && !r.unknown && before !== null && this.latched === null) this.o.log("service: the Mac's protection holds again");
    if (this.dumpable()) this.tell();
  }

  private tell(): void { for (const fn of this.watchers) { try { fn(); } catch { /* a watcher's own failure */ } } }
}

/** The Mac's part of a start that does not hold: no reader, no read; the shared timeout of the start's read, if any. */
const noReader = (sharedS: number | null): MacReaderPart => ({ fresh: () => Promise.resolve(), onLost: () => {}, taskportSharedS: () => sharedS, stop: () => {} });

/**
 * The Mac's protected start (the head of this file): the two calls, then the four checks, in this order; the first one
 * that fails gives the reason for the log, and a reader that always says "dumpable". Else the background reader, begun
 * with the start's reading.
 */
export async function macProtectedStart(o: { load?: () => Promise<MacMemLib | { failed: string }>; run?: MacToolRun; execPath?: string; reader?: { run?: MacToolRunAsync; now?: () => number; everyMs?: number; maxAgeMs?: number; log?: (line: string) => void } } = {}): Promise<MemoryProtection & { mac: MacReaderPart }> {
  const run = o.run ?? runToolSync;
  let sharedS: number | null = null;
  const fail = (failed: string) => ({ dumpable: () => true, failed, mac: noReader(sharedS) });
  const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
  let lib: MacMemLib | { failed: string };
  try { lib = await (o.load ?? (() => loadMacMemLib()))(); }
  catch (e) { return fail(`libSystem does not load (${message(e)})`); }
  if ("failed" in lib) return fail(lib.failed);
  // A throw of node:ffi (for example a later Node's change of its API) fails closed with its reason (review M2).
  try {
    if (lib.ptrace(PT_DENY_ATTACH, 0, 0n, 0) !== 0) return fail(`ptrace(PT_DENY_ATTACH) failed (errno ${lib.errno()})`);
    if (lib.setrlimit(RLIMIT_CORE_MAC, Buffer.alloc(RLIMIT_SIZE)) !== 0) return fail(`setrlimit(RLIMIT_CORE, 0) failed (errno ${lib.errno()})`);
    const core = Buffer.alloc(RLIMIT_SIZE, 0xff);
    if (lib.getrlimit(RLIMIT_CORE_MAC, core) !== 0) return fail(`getrlimit(RLIMIT_CORE) failed (errno ${lib.errno()})`);
    if (core.readBigUInt64LE(0) !== 0n || core.readBigUInt64LE(8) !== 0n) return fail("RLIMIT_CORE is not 0 after setrlimit");
  } catch (e) { return fail(`a libSystem call threw (${message(e)})`); }
  const ents = run(MAC_TOOLS.codesign, ["-d", "--entitlements", "-", "--xml", o.execPath ?? process.execPath], MAC_START_MS);
  const gta = parseEntitlements(ents).getTaskAllow;
  if (gta === true) return fail("the service's Node has the get-task-allow entitlement");
  if (gta !== false) return fail(`the entitlements of the service's Node cannot be read (${unread("codesign", ents)})`);
  const sipRun = run(MAC_TOOLS.csrutil, ["status"], MAC_START_MS);
  const sip = parseCsrutil(sipRun);
  if (sip === "disabled") return fail("SIP is disabled");
  if (sip !== "enabled") return fail(`SIP's state cannot be read (${unread("csrutil", sipRun)})`);
  const dtsRun = run(MAC_TOOLS.devToolsSecurity, DTS_ARGS, MAC_START_MS);
  const dts = parseDevToolsSecurity(dtsRun);
  if (dts === "enabled") return fail("DevToolsSecurity is enabled");
  if (dts !== "disabled") return fail(`DevToolsSecurity's state cannot be read (${unread("DevToolsSecurity", dtsRun)})`);
  const tpRun = run(MAC_TOOLS.security, TASKPORT_ARGS, MAC_START_MS);
  const tp = parseTaskport(tpRun);
  if (tp.right) sharedS = taskportSharedS(tp);
  const holds = taskportHolds(tp);
  if (holds === "weak") return fail(`the taskport right does not hold (${tp.meaning})`);
  if (holds !== "holds") return fail(`the taskport right cannot be read (${unread("security", tpRun)})`);
  const reader = new MacProtectionReader({ ...o.reader, sharedS }).start();
  return { dumpable: () => reader.dumpable(), failed: null, mac: reader };
}

// ------------------------------------------------------------------ the signal

/** The protection of board ab-v16.96 holds: a SIGUSR1 listener or --disable-sigusr1, and no open inspector. */
export function signalHeld(o: { listeners?: () => number; execArgv?: readonly string[]; inspector?: () => string | undefined } = {}): boolean {
  const listeners = o.listeners ? o.listeners() : process.listenerCount("SIGUSR1");
  const argv = o.execArgv ?? process.execArgv;
  const open = (o.inspector ?? inspectorUrl)();
  return (listeners > 0 || argv.includes("--disable-sigusr1")) && open === undefined;
}

/** The reason of the first protection that does not hold, or null while both hold (C12: dumpable comes first). */
export function protectionReason(dumpable: () => boolean, signal: () => boolean = () => signalHeld()): Unprotected | null {
  if (dumpable()) return "dumpable";
  if (!signal()) return "signal";
  return null;
}
