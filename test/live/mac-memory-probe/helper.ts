// The helper processes of the Mac memory probe (probe.ts; board ab-v16.97.8, part 1). The probe starts each one with a
// Node (its own, or T2's copy), an argv of fixed words (and a target's pid), and an IPC channel. A helper prints nothing
// and writes no file. It talks to the probe only on its IPC channel.
//
//   target <T0|T1|T2>   a throwaway target: it holds a random marker of MARKER_BYTES bytes until the probe ends it, in
//                       three places: the Buffer of crypto.randomBytes (32 bytes: V8 can keep so small a typed array on
//                       its own heap), a Buffer.alloc of BIG_MARKER_BYTES (64 KiB) that holds the marker repeated (an
//                       ArrayBuffer of that size is off V8's heap: a malloc block of Node's allocator), and the marker's
//                       hex form in a JS string (on V8's heap). T1 first calls ptrace(PT_DENY_ATTACH, 0, 0, 0) through
//                       node:ffi (on Linux prctl(PR_SET_DUMPABLE, 0), the service's non-dumpable start). It sends one
//                       ready message with the marker's hex form (the probe's byte search needs it; it never goes into
//                       a log or the JSON) and T1's call. It ends at the probe's {do: "end"}, at the end of its channel
//                       (the probe's end), or after HELPER_LIMIT_MS.
//   port <pid>          read a (the Mac only): task_for_pid(mach_task_self(), pid, &port) (a Mach trap: a
//                       kern_return_t) and task_read_for_pid (a BSD system call: 0, or -1 and errno, read through
//                       __error) through node:ffi into libSystem; a port counts only when its name is not 0;
//                       mach_port_deallocate of each port that the kernel gives. It never reads the target's memory
//                       with the port. It sends one message and ends.

import { randomBytes } from "node:crypto";
import { BIG_MARKER_BYTES, HELPER_LIMIT_MS, MARKER_BYTES, PR_GET_DUMPABLE, PR_SET_DUMPABLE, PT_DENY_ATTACH, type PortAnswer, type PortCall } from "./parts.ts";

const LIBSYSTEM = "/usr/lib/libSystem.B.dylib";
const [mode, arg] = process.argv.slice(2);
const end = (code: number): never => process.exit(code);
if (!process.send || !((mode === "target" && /^T[012]$/.test(arg ?? "")) || (mode === "port" && /^[1-9][0-9]{0,9}$/.test(arg ?? "")))) end(2);
const send = (m: unknown) => new Promise<void>((r) => process.send!(m, () => r()));

async function loadFfi(): Promise<any> {
  const mod: any = await import("node:ffi");
  return mod.default ?? mod;
}

/** T1's call: on the Mac ptrace(PT_DENY_ATTACH, 0, 0, 0); on Linux prctl(PR_SET_DUMPABLE, 0) and PR_GET_DUMPABLE after it. */
async function denyAttach(): Promise<Record<string, unknown>> {
  let ffi: any;
  try { ffi = await loadFfi(); } catch (e) { return { failed: `node:ffi does not load (${(e as { code?: string }).code ?? "error"})` }; }
  try {
    if (process.platform === "darwin") {
      const f = ffi.dlopen(LIBSYSTEM, { ptrace: { return: "int32", arguments: ["int32", "int32", "pointer", "int32"] }, __error: { return: "pointer", arguments: [] } }).functions;
      const ret = f.ptrace(PT_DENY_ATTACH, 0, 0n, 0);
      return { call: "ptrace PT_DENY_ATTACH", ret, errno: ret === 0 ? 0 : ffi.getInt32(f.__error(), 0), after: null };
    }
    const f = ffi.dlopen("libc.so.6", { prctl: { return: "int32", arguments: ["int32", "uint64", "uint64", "uint64", "uint64"] }, __errno_location: { return: "pointer", arguments: [] } }).functions;
    const ret = f.prctl(PR_SET_DUMPABLE, 0n, 0n, 0n, 0n);
    const errno = ret === 0 ? 0 : ffi.getInt32(f.__errno_location(), 0);
    return { call: "prctl PR_SET_DUMPABLE 0", ret, errno, after: f.prctl(PR_GET_DUMPABLE, 0n, 0n, 0n, 0n) };
  } catch (e) { return { failed: `the call does not load (${(e as { code?: string }).code ?? "error"})` }; }
}

/** Read a: each call by its own dlopen, so that a missing symbol (task_read_for_pid before macOS 11) gives "missing". */
async function readPorts(pid: number): Promise<PortAnswer> {
  if (process.platform !== "darwin") return { failed: "not the Mac" };
  const ffi = await loadFfi();
  /** A function of libSystem, or the code of its dlopen error. */
  const load = (name: string, def: { return: string; arguments: string[] }): { f: any } | { code: string } => {
    try { return { f: ffi.dlopen(LIBSYSTEM, { [name]: def }).functions[name] }; } catch (e) { return { code: String((e as { code?: string }).code ?? "error") }; }
  };
  const fn = (name: string, def: { return: string; arguments: string[] }) => { const l = load(name, def); return "f" in l ? l.f : null; };
  // mach_task_self() is a macro for the variable mach_task_self_ (mach/mach_init.h); task_self_trap() is the trap behind it.
  let self = 0, from = "none";
  try { self = ffi.getUint32(ffi.dlopen(LIBSYSTEM, {}).lib.getSymbol("mach_task_self_"), 0); from = "mach_task_self_"; } catch {}
  if (!self) {
    const trap = fn("task_self_trap", { return: "uint32", arguments: [] });
    if (trap) { self = trap(); from = "task_self_trap"; }
  }
  if (!self) return { failed: "no task port of its own" };
  const dealloc = fn("mach_port_deallocate", { return: "int32", arguments: ["uint32", "uint32"] });
  const errnoAt = fn("__error", { return: "pointer", arguments: [] });
  const call = (name: string): PortCall => {
    const l = load(name, { return: "int32", arguments: ["uint32", "int32", "buffer"] });
    if (!("f" in l)) return { symbol: "missing", code: l.code };
    const out = Buffer.alloc(4);
    if (errnoAt) ffi.setInt32(errnoAt(), 0, 0);
    const ret = l.f(self, pid, out);
    const errno = ret === -1 && errnoAt ? ffi.getInt32(errnoAt(), 0) : null;
    const port = out.readUInt32LE(0);
    return { ret, errno, port: port !== 0, deallocated: port !== 0 && dealloc ? dealloc(self, port) === 0 : null };
  };
  return { self: from, taskForPid: call("task_for_pid"), taskReadForPid: call("task_read_for_pid") };
}

/** What a target holds until its end: the marker, its copies in the 64 KiB block off V8's heap, and its hex form. */
const held: unknown[] = [];

if (mode === "target") {
  setTimeout(() => end(3), HELPER_LIMIT_MS);
  process.on("disconnect", () => end(0));
  process.on("message", (m: { do?: string }) => { if (m?.do === "end") end(0); });
  const marker = randomBytes(MARKER_BYTES);
  const big = Buffer.alloc(BIG_MARKER_BYTES);
  for (let at = 0; at < big.length; at += marker.length) marker.copy(big, at);
  const hex = marker.toString("hex");
  held.push(marker, big, hex);
  const deny = arg === "T1" ? await denyAttach() : null;
  await send({ ready: true, markerBytes: marker.length, markerHex: hex, deny });
} else {
  let answer: PortAnswer;
  try { answer = await readPorts(Number(arg)); } catch (e) { answer = { failed: `an error (${e instanceof Error ? e.name : "value"})` }; }
  await send({ port: answer });
  process.disconnect?.();
  end(0);
}
