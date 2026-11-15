// The Mac's reads of processes, sockets and launchd jobs for `agent-browser service` (board ab-v16.94.6; the
// self-contained design, section 10; contracts C11 and C12, the Mac). Built from Apple's headers and the xnu source; not
// run on a Mac yet: the Mac check list of board ab-v16.94.6 measures each read.
//
// - MacProcs: the Chrome unit's reads (procs.ts) on the Mac: proc_pidinfo's PROC_PIDTBSDINFO (the parent, the process
//   group, the real uid, the start time, the zombie state), sysctl's KERN_PROCARGS2 (each argument exactly as the
//   process got it), proc_pidpath (the executable), proc_listallpids, and kern.bootsessionuuid (the boot's id). xnu
//   gives PROC_PIDTBSDINFO, PROC_PIDLISTFDS and KERN_PROCARGS2 of the service's own user's processes only (its
//   CHECK_SAME_USER): another user's process, launchd (pid 1) among them, reads as gone, and so is never the unit's.
// - macTcpReader: the MCP port's reads (mcp/proc.ts) on the Mac: each socket of each process that the service may read
//   (PROC_PIDLISTFDS, then proc_pidfdinfo's PROC_PIDFDSOCKETINFO): its IPv4 TCP addresses and its kernel handle (soi_so)
//   in place of Linux's inode. A line's uid is the real uid of the processes that hold the socket (board ab-v16.94.29):
//   the socket's own soi_stat.vst_uid reads 0 on the Mac.
// - launchdJob: one `launchctl print gui/<uid>/<label>`: the job's top-level `state` and `pid` lines (the owner rule of
//   the service's own job, and the control door's rule 1 for agentwatch's job).
//
// How the service calls macOS: libproc and sysctl through node:ffi, into /usr/lib/libSystem.B.dylib, as the relay's
// peer reader already does (src/relay/peer.ts, MacReader). No new dependency, no compiled helper (an npm package ships
// none, and a native addon is out), and the answers are the kernel's own: KERN_PROCARGS2 keeps each argument whole,
// where `ps` joins them with spaces. Only launchd's state comes from a command: launchd has no public C call for it.

import { execFile } from "node:child_process";
import type { McpReader, TcpLine } from "./mcp/proc.ts";
import type { Proc } from "../relay/peer.ts";
import { Procs, type Stat } from "./unit/procs.ts";
import type { UnitState, UnitStateReader } from "./unit/owner.ts";

/** The libSystem calls of the Mac's readers (the tests give a fake). */
export type MacLib = {
  proc_pidinfo(pid: number, flavor: number, arg: bigint, buffer: Buffer, size: number): number;
  proc_pidfdinfo(pid: number, fd: number, flavor: number, buffer: Buffer, size: number): number;
  proc_pidpath(pid: number, buffer: Buffer, size: number): number;
  /** The number of pids that it wrote, or -1. */
  proc_listallpids(buffer: Buffer, size: number): number;
  /** sysctl with no new value: `length` holds a size_t (8 bytes) in and out. */
  sysctl(mib: Buffer, count: number, old: Buffer, length: Buffer): number;
  sysctlbyname(name: Buffer, old: Buffer, length: Buffer): number;
};

export const PROC_PIDLISTFDS = 1, PROC_PIDTBSDINFO = 3, PROC_PIDFDSOCKETINFO = 3;
/** sizeof(struct proc_bsdinfo), sizeof(struct socket_fdinfo) and sizeof(struct proc_fdinfo) on 64-bit macOS. */
export const PROC_BSDINFO_SIZE = 136, SOCKET_FDINFO_SIZE = 792, PROC_FDINFO_SIZE = 8;
export const SZOMB = 5, PROX_FDTYPE_SOCKET = 2, AF_INET = 2, SOCKINFO_TCP = 2, INI_IPV4 = 1;
const CTL_KERN = 1, KERN_ARGMAX = 8, KERN_PROCARGS2 = 49, PATH_MAX = 4096;

/** node:ffi's dlopen of libSystem (a dynamic import, as the peer check's self-test loads it); why it failed, else the calls. */
export async function loadMacLib(): Promise<MacLib | { failed: string }> {
  let ffi: any;
  try { const mod: any = await import("node:ffi"); ffi = mod.default ?? mod; }
  catch (e) { return { failed: `node:ffi does not load (${(e as { code?: string }).code ?? (e as Error).message})` }; }
  try {
    const { functions: f } = ffi.dlopen("/usr/lib/libSystem.B.dylib", {
      proc_pidinfo: { return: "int32", arguments: ["int32", "int32", "uint64", "buffer", "int32"] },
      proc_pidfdinfo: { return: "int32", arguments: ["int32", "int32", "int32", "buffer", "int32"] },
      proc_pidpath: { return: "int32", arguments: ["int32", "buffer", "uint32"] },
      proc_listallpids: { return: "int32", arguments: ["buffer", "int32"] },
      sysctl: { return: "int32", arguments: ["buffer", "uint32", "buffer", "buffer", "pointer", "uint64"] },
      sysctlbyname: { return: "int32", arguments: ["buffer", "buffer", "buffer", "pointer", "uint64"] },
    });
    return {
      proc_pidinfo: f.proc_pidinfo, proc_pidfdinfo: f.proc_pidfdinfo, proc_pidpath: f.proc_pidpath, proc_listallpids: f.proc_listallpids,
      sysctl: (mib, count, old, length) => f.sysctl(mib, count, old, length, null, 0n),
      sysctlbyname: (name, old, length) => f.sysctlbyname(name, old, length, null, 0n),
    };
  } catch (e) { return { failed: `dlopen of libSystem failed: ${(e as Error).message}` }; }
}

// ------------------------------------------------------------------ the parsers (each a pure function of the kernel's bytes)

/** The fields of struct proc_bsdinfo that the service reads; `start` in µs (C11's start time of a root on the Mac). */
export type BsdInfo = { status: number; ppid: number; uid: number; ruid: number; pgid: number; start: number };

/** struct proc_bsdinfo: pbi_status (4), pbi_ppid (16), pbi_uid (20), pbi_ruid (28), pbi_pgid (100), pbi_start_tvsec (120), pbi_start_tvusec (128). */
export function parseBsdInfo(b: Buffer): BsdInfo | null {
  if (b.length < PROC_BSDINFO_SIZE) return null;
  const start = b.readBigUInt64LE(120) * 1_000_000n + b.readBigUInt64LE(128);
  if (start > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return { status: b.readUInt32LE(4), ppid: b.readUInt32LE(16), uid: b.readUInt32LE(20), ruid: b.readUInt32LE(28), pgid: b.readUInt32LE(100), start: Number(start) };
}

/** KERN_PROCARGS2: argc (int), the exec path, its NUL padding, then argc arguments, each ending with a NUL; null when it does not parse. */
export function parseProcArgs2(b: Buffer): { exec: string; argv: Buffer[] } | null {
  if (b.length < 4) return null;
  const argc = b.readInt32LE(0);
  if (argc < 1 || argc > 1 << 20) return null;
  const end = b.indexOf(0, 4);
  if (end < 0) return null;
  const exec = b.subarray(4, end).toString("utf8");
  let at = end;
  while (at < b.length && b[at] === 0) at++;
  const argv: Buffer[] = [];
  for (let i = 0; i < argc; i++) {
    const nul = b.indexOf(0, at);
    if (nul < 0) return null;
    argv.push(b.subarray(at, nul));
    at = nul + 1;
  }
  return { exec, argv };
}

/** The pids of a proc_listallpids buffer that holds `count` of them. */
export function parsePids(b: Buffer, count: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count && (i + 1) * 4 <= b.length; i++) { const pid = b.readInt32LE(i * 4); if (pid > 0) out.push(pid); }
  return out;
}

/** The socket fds of a PROC_PIDLISTFDS buffer of `bytes` bytes (struct proc_fdinfo: proc_fd, proc_fdtype). */
export function parseSocketFds(b: Buffer, bytes: number): number[] {
  const out: number[] = [];
  for (let at = 0; at + PROC_FDINFO_SIZE <= Math.min(bytes, b.length); at += PROC_FDINFO_SIZE) if (b.readUInt32LE(at + 4) === PROX_FDTYPE_SOCKET) out.push(b.readInt32LE(at));
  return out;
}

/** One IPv4 TCP socket as the Mac's MCP reader reads it: its addresses (`a.b.c.d:port`), its soi_stat.vst_uid (0 on the Mac: no line uses it), its kernel handle. */
export type MacSocket = { local: string; remote: string; uid: number; handle: bigint };

/**
 * struct socket_fdinfo (proc_fileinfo, 24 bytes, then socket_info): soi_stat.vst_uid (24+16), soi_so (24+136), soi_family
 * (24+160), soi_kind (24+232) and soi_proto (24+240): in_sockinfo's insi_fport (0), insi_lport (4), insi_vflag (24),
 * the foreign IPv4 address (44) and the local one (60). The ports are in the network byte order in the int's first two
 * bytes. Only an AF_INET socket of kind SOCKINFO_TCP with an IPv4 address gives a line, as /proc/net/tcp holds only those.
 */
export function parseSocketFdInfo(b: Buffer): MacSocket | null {
  if (b.length < SOCKET_FDINFO_SIZE) return null;
  const psi = 24, proto = psi + 240;
  if (b.readInt32LE(psi + 160) !== AF_INET || b.readInt32LE(psi + 232) !== SOCKINFO_TCP || (b[proto + 24] & INI_IPV4) === 0) return null;
  const addr = (o: number) => `${b[o]}.${b[o + 1]}.${b[o + 2]}.${b[o + 3]}:`;
  return { local: addr(proto + 60) + b.readUInt16BE(proto + 4), remote: addr(proto + 44) + b.readUInt16BE(proto), uid: b.readUInt32LE(psi + 16), handle: b.readBigUInt64LE(psi + 136) };
}

/** A socket's handle as the number that stands for Linux's inode (its low 48 bits: a permuted kernel address). */
export const handleNumber = (h: bigint) => Number(h & 0xffff_ffff_ffffn);

const mib = (...names: number[]) => { const b = Buffer.alloc(names.length * 4); names.forEach((n, i) => b.writeInt32LE(n, i * 4)); return b; };
const sizeT = (n: number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };

// ------------------------------------------------------------------ the processes

/** The Chrome unit's reads (procs.ts) on the Mac, through libSystem. */
export class MacProcs extends Procs {
  private readonly lib: MacLib;
  private args: Buffer | null = null;
  /** `pids()` throws when proc_listallpids fails, in place of no pids (`service stop --all`: review-145b N6). */
  private readonly strict: boolean;
  constructor(lib: MacLib, o: { uid?: number; self?: number; strict?: boolean } = {}) {
    super({ root: "/nonexistent", uid: o.uid, self: o.self });
    this.lib = lib;
    this.strict = o.strict ?? false;
  }

  /** proc_pidinfo PROC_PIDTBSDINFO, or null when the pid is gone or cannot be read. */
  bsd(pid: number): BsdInfo | null {
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    const b = Buffer.alloc(PROC_BSDINFO_SIZE);
    return this.lib.proc_pidinfo(pid, PROC_PIDTBSDINFO, 0n, b, PROC_BSDINFO_SIZE) === PROC_BSDINFO_SIZE ? parseBsdInfo(b) : null;
  }

  /** The walk's view of a process (C11's peer check): its parent, its start time, and Z for a zombie. */
  proc(pid: number): Proc | null {
    const i = this.bsd(pid);
    return i ? { ppid: i.ppid, start: i.start, state: i.status === SZOMB ? "Z" : "S" } : null;
  }

  override stat(pid: number): Stat | null {
    const i = this.bsd(pid);
    return !i || i.status === SZOMB ? null : { state: "S", ppid: i.ppid, pgrp: i.pgid, start: i.start };
  }

  /** KERN_PROCARGS2 of `pid`: the exec path and the exact bytes of each argument, or null (another user's process, a pid that is gone). */
  procArgs(pid: number): { exec: string; argv: Buffer[] } | null {
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    if (this.args === null) {
      const v = Buffer.alloc(4);
      if (this.lib.sysctl(mib(CTL_KERN, KERN_ARGMAX), 2, v, sizeT(4)) !== 0) return null;
      const max = v.readInt32LE(0);
      if (max < 4096 || max > 16 << 20) return null;
      this.args = Buffer.alloc(max);
    }
    const length = sizeT(this.args.length);
    if (this.lib.sysctl(mib(CTL_KERN, KERN_PROCARGS2, pid), 3, this.args, length) !== 0) return null;
    const n = Number(length.readBigUInt64LE(0));
    return n > 0 && n <= this.args.length ? parseProcArgs2(Buffer.from(this.args.subarray(0, n))) : null;
  }

  override cmdline(pid: number): string[] { return this.procArgs(pid)?.argv.map((a) => a.toString("utf8")) ?? []; }

  override realUid(pid: number): number | null { return this.bsd(pid)?.ruid ?? null; }

  /** proc_pidpath: the bytes of the executable's path (the kernel's resolved path), or null. */
  exeBytes(pid: number): Buffer | null {
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    const b = Buffer.alloc(PATH_MAX);
    const n = this.lib.proc_pidpath(pid, b, PATH_MAX);
    return n > 0 && n <= PATH_MAX ? Buffer.from(b.subarray(0, n)) : null;
  }

  override exe(pid: number): string | null { return this.exeBytes(pid)?.toString("utf8") ?? null; }

  /** Every pid of proc_listallpids, this process too; null when the call fails. */
  allPids(): number[] | null {
    for (let size = 4096; size <= 1 << 20; size *= 4) {
      const b = Buffer.alloc(size * 4);
      const n = this.lib.proc_listallpids(b, b.length);
      if (n < 0) return null;
      if (n < size) return parsePids(b, n);
    }
    return null;
  }

  override pids(): number[] {
    const all = this.allPids();
    if (all === null && this.strict) throw new Error("proc_listallpids failed: the processes cannot be listed");
    return (all ?? []).filter((p) => p > 1 && p !== this.self).sort((a, b) => a - b);
  }

  override bootId(): string | null {
    const b = Buffer.alloc(64), length = sizeT(64);
    if (this.lib.sysctlbyname(Buffer.from("kern.bootsessionuuid\0"), b, length) !== 0) return null;
    const text = b.subarray(0, Math.min(64, Number(length.readBigUInt64LE(0)))).toString("latin1").replace(/\0.*$/s, "").trim();
    return text || null;
  }

  override sys(): string | null { return null; }
  override netUnix(): string { return ""; }

  /** The socket fds of `pid` (PROC_PIDLISTFDS), or [] when they cannot be read (another user's process). */
  socketFds(pid: number): number[] {
    for (let n = 256; n <= 1 << 16; n *= 4) {
      const b = Buffer.alloc(n * PROC_FDINFO_SIZE);
      const got = this.lib.proc_pidinfo(pid, PROC_PIDLISTFDS, 0n, b, b.length);
      if (got <= 0) return [];
      if (got < b.length) return parseSocketFds(b, got);
    }
    return [];
  }

  /** proc_pidfdinfo PROC_PIDFDSOCKETINFO of one fd: its IPv4 TCP line, or null. */
  socket(pid: number, fd: number): MacSocket | null {
    const b = Buffer.alloc(SOCKET_FDINFO_SIZE);
    return this.lib.proc_pidfdinfo(pid, fd, PROC_PIDFDSOCKETINFO, b, SOCKET_FDINFO_SIZE) === SOCKET_FDINFO_SIZE ? parseSocketFdInfo(b) : null;
  }
}

// ------------------------------------------------------------------ the MCP port's reader

/** A line's uid that matches no user: its holders have different real uids, or a holder's uid cannot be read (fail closed). */
export const MAC_NO_UID = -1;

/**
 * The MCP admission's reads (C11, steps 1 and 2) on the Mac. `tcp()` scans each socket of each process that the service
 * can read, and keeps the holders of each socket for the `holders` call that follows; a socket's line names it by its
 * handle. The walk reads proc_pidinfo; the Mac has no cgroups.
 *
 * A line's uid (board ab-v16.94.29) is the real uid (PROC_PIDTBSDINFO's pbi_ruid) of the processes that hold the socket.
 * When two holders have different real uids, or a holder's uid cannot be read, the line's uid is MAC_NO_UID, which
 * matches no user, so the admission gives the peer's 403 (fail closed). The socket's own soi_stat.vst_uid is not used:
 * the Mac check (group A, 2026-11-15) read 0 there for each socket at the right offset (24+16), so it names no user, and
 * the admission would refuse each connection. Another user's connection still has no line: xnu gives PROC_PIDLISTFDS and
 * proc_pidfdinfo of the service's own user's processes only (CHECK_SAME_USER), so the scan reads no fd of another user's
 * process, and a socket that only such processes hold gives no line (the peer's 403 of step 1).
 */
export function macTcpReader(procs: MacProcs): McpReader {
  let held = new Map<number, number[]>();
  return {
    tcp: () => {
      const pids = procs.allPids();
      if (pids === null) return null;
      const lines = new Map<number, TcpLine>(), holders = new Map<number, number[]>(), ruids = new Map<number, number>();
      const ruidOf = (pid: number) => {
        let u = ruids.get(pid);
        if (u === undefined) ruids.set(pid, (u = procs.bsd(pid)?.ruid ?? MAC_NO_UID));
        return u;
      };
      for (const pid of pids) {
        for (const fd of procs.socketFds(pid)) {
          const s = procs.socket(pid, fd);
          if (!s) continue;
          const inode = handleNumber(s.handle), uid = ruidOf(pid), was = lines.get(inode);
          lines.set(inode, { local: s.local, remote: s.remote, uid: was === undefined || was.uid === uid ? uid : MAC_NO_UID, inode });
          const h = holders.get(inode) ?? [];
          if (!h.includes(pid)) h.push(pid);
          holders.set(inode, h);
        }
      }
      held = holders;
      return [...lines.values()];
    },
    holders: (inode) => [...(held.get(inode) ?? [])].sort((a, b) => a - b),
    proc: (pid) => procs.proc(pid),
    cgroup: () => null,
  };
}

// ------------------------------------------------------------------ launchd

export type LaunchdJob = { state: string; pid: number };

/** The launchd labels on the Mac: agentwatch's daemon job (its gateway's DAEMON_LAUNCHD_LABEL) and the service's own job, by default. */
export const MAC_DAEMON_LABEL = "com.agentwatch", MAC_SERVICE_LABEL = "com.agentwatch.agent-browser";

/** A launchd label as agentwatch's install writes it (letters, digits, dot, dash, underscore). */
export const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;

/**
 * The output of `launchctl print gui/<uid>/<label>`: its first line names the job, and its top-level lines (one tab
 * in) give `state = <state>` and, while the job runs, `pid = <pid>`. Nested blocks (two tabs or more) are not read.
 * A job with no pid line has pid 0. Null when the output is not one job's, or names a state or a pid twice.
 */
export function parseLaunchctlPrint(text: string, target: string): LaunchdJob | null {
  const lines = text.split("\n");
  if (lines[0]?.trimEnd() !== `${target} = {`) return null;
  let state: string | null = null, pid: number | null = null;
  for (const line of lines) {
    const s = /^\tstate = (.+)$/.exec(line), p = /^\tpid = ([0-9]{1,9})$/.exec(line);
    if (s) { if (state !== null) return null; state = s[1].trim(); }
    if (p) { if (pid !== null) return null; pid = Number(p[1]); }
  }
  return state === null || state === "" ? null : { state, pid: pid ?? 0 };
}

/** One `launchctl print gui/<uid>/<label>`; null when it fails (no such job, no answer in time, an output that does not parse). */
export function launchdJob(label: string, o: { uid?: number; launchctl?: string; timeoutMs?: number } = {}): Promise<LaunchdJob | null> {
  const uid = o.uid ?? process.getuid?.() ?? -1;
  if (!LABEL_RE.test(label) || uid < 0) return Promise.resolve(null);
  const target = `gui/${uid}/${label}`;
  return new Promise((resolve) => {
    execFile(o.launchctl ?? "/bin/launchctl", ["print", target], { timeout: o.timeoutMs ?? 2000, killSignal: "SIGKILL", encoding: "utf8", maxBuffer: 4 << 20 },
      (e, stdout) => resolve(e ? null : parseLaunchctlPrint(String(stdout), target)));
  });
}

/** The control door's rule 1 on the Mac: the pid of agentwatch's job (0 while it does not run), null when the read fails. */
export const launchdMainPid = (label: string, o: Parameters<typeof launchdJob>[1] = {}) => async (): Promise<number | null> => (await launchdJob(label, o))?.pid ?? null;

/** The owner rule's reader on the Mac: the service's own job; `running` stands for systemd's `active`. */
export function launchdUnitState(label: string, o: Parameters<typeof launchdJob>[1] = {}): UnitStateReader {
  return async (): Promise<UnitState | null> => {
    const j = await launchdJob(label, o);
    return j === null ? null : { active: j.state === "running" ? "active" : j.state, sub: j.state, mainPid: j.pid };
  };
}
