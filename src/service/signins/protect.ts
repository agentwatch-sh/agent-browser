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
// operator's Mac 2026-11-25, at aacd9bd) measured that no program of the same user read the writable memory of a Node
// with no get-task-allow entitlement while DevToolsSecurity is disabled and SIP is enabled: task_for_pid KERN_FAILURE,
// task_read_for_pid EPERM, and vmmap and leaks only the regions and a graph with no contents. When DevToolsSecurity is
// enabled, a debugger of the same user (lldb's debugserver) can get the task port of a process with no hardened runtime
// with no password, and read its memory. So the Mac's protected start (macProtectedStart) holds when:
//   - ptrace(PT_DENY_ATTACH) returns 0 (no ptrace attach; xnu sends SIGSEGV to an attacher; a process that a debugger
//     traces already ends at the call), and setrlimit(RLIMIT_CORE, {0, 0}) returns 0 and getrlimit reads 0 (no core);
//   - the service's own Node has no get-task-allow entitlement (codesign), SIP is enabled (csrutil), and DevToolsSecurity
//     is disabled (DevToolsSecurity -status).
// On the Mac the reason `dumpable` means that this protection does not hold; the log line names the check. Each later
// check reads DevToolsSecurity again (one short run); after one read of enabled, the protection does not hold until the
// service starts again: a task port that a debugger took while it was enabled stays good after it is disabled. The
// other facts hold from the start: PT_DENY_ATTACH is never undone, the hard limit 0 cannot rise without root, and SIP
// and the Node's signature change only with a restart. The store stays off on the Mac until board ab-v16.97.14, so
// main.ts only logs the result there.

import { spawnSync } from "node:child_process";
import { url as inspectorUrl } from "node:inspector";
import { parseCsrutil, parseDevToolsSecurity, parseEntitlements, runClass, type ToolRun } from "./mac-tools.ts";

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
/** The time limit of the one tool run of each later check (it runs synchronously: the store's protections are synchronous). */
export const MAC_CHECK_MS = 1500;
/** The Mac's read-only tools, by their absolute paths (as the Mac memory probe runs them). */
export const MAC_TOOLS = { codesign: "/usr/bin/codesign", csrutil: "/usr/bin/csrutil", devToolsSecurity: "/usr/sbin/DevToolsSecurity" } as const;
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

/** node:ffi's dlopen of libSystem (a dynamic import, as the peer check loads it); why it failed, else the calls. */
export async function loadMacMemLib(platform: NodeJS.Platform = process.platform): Promise<MacMemLib | { failed: string }> {
  if (platform !== "darwin") return { failed: `no ptrace PT_DENY_ATTACH on ${platform}` };
  const m = await importFfi();
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

/**
 * The real runner: one synchronous run, stdin from /dev/null, SIGKILL at the time limit, the first TOOL_TEXT_MAX
 * characters of stdout and stderr. The runs of the start come before any door opens; a later check runs one tool.
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

/** Why a read gave no answer: its class, or "an unknown text" when the tool ran but its text says neither. */
const unread = (tool: string, r: ToolRun) => `${tool}: ${runClass(r) === "ok" ? "an unknown text" : runClass(r)}`;

/**
 * The Mac's protected start (the head of this file): the two calls, then the three checks, in this order; the first one
 * that fails gives the reason for the log, and a reader that always says "dumpable". Else a reader for each later check:
 * one run of DevToolsSecurity, and "dumpable" for good after one read of enabled.
 */
export async function macProtectedStart(o: { load?: () => Promise<MacMemLib | { failed: string }>; run?: MacToolRun; execPath?: string } = {}): Promise<{ dumpable: () => boolean; failed: string | null }> {
  const run = o.run ?? runToolSync;
  const fail = (failed: string) => ({ dumpable: () => true, failed });
  const lib = await (o.load ?? (() => loadMacMemLib()))();
  if ("failed" in lib) return fail(lib.failed);
  if (lib.ptrace(PT_DENY_ATTACH, 0, 0n, 0) !== 0) return fail(`ptrace(PT_DENY_ATTACH) failed (errno ${lib.errno()})`);
  if (lib.setrlimit(RLIMIT_CORE_MAC, Buffer.alloc(RLIMIT_SIZE)) !== 0) return fail(`setrlimit(RLIMIT_CORE, 0) failed (errno ${lib.errno()})`);
  const core = Buffer.alloc(RLIMIT_SIZE, 0xff);
  if (lib.getrlimit(RLIMIT_CORE_MAC, core) !== 0) return fail(`getrlimit(RLIMIT_CORE) failed (errno ${lib.errno()})`);
  if (core.readBigUInt64LE(0) !== 0n || core.readBigUInt64LE(8) !== 0n) return fail("RLIMIT_CORE is not 0 after setrlimit");
  const ents = run(MAC_TOOLS.codesign, ["-d", "--entitlements", "-", "--xml", o.execPath ?? process.execPath], MAC_START_MS);
  const gta = parseEntitlements(ents).getTaskAllow;
  if (gta === true) return fail("the service's Node has the get-task-allow entitlement");
  if (gta !== false) return fail(`the entitlements of the service's Node cannot be read (${unread("codesign", ents)})`);
  const sipRun = run(MAC_TOOLS.csrutil, ["status"], MAC_START_MS);
  const sip = parseCsrutil(sipRun);
  if (sip === "disabled") return fail("SIP is disabled");
  if (sip !== "enabled") return fail(`SIP's state cannot be read (${unread("csrutil", sipRun)})`);
  const dtsRun = run(MAC_TOOLS.devToolsSecurity, ["-status"], MAC_START_MS);
  const dts = parseDevToolsSecurity(dtsRun);
  if (dts === "enabled") return fail("DevToolsSecurity is enabled");
  if (dts !== "disabled") return fail(`DevToolsSecurity's state cannot be read (${unread("DevToolsSecurity", dtsRun)})`);
  let enabledOnce = false;
  return {
    dumpable: () => {
      if (enabledOnce) return true;
      const now = parseDevToolsSecurity(run(MAC_TOOLS.devToolsSecurity, ["-status"], MAC_CHECK_MS));
      if (now === "enabled") enabledOnce = true;
      return now !== "disabled";
    },
    failed: null,
  };
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
