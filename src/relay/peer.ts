// The relay's peer check (contract C11 of chrome-extension's docs/protocol.md, "The scope's session (the peer
// check)", the master; the design: docs/superpowers/specs/2026-11-05-peer-admission-design.md, sections 3 to 6 and 9;
// board ab-v16.51). With `agent-browser relay --peer-check` the relay admits a connection of a scope only when the
// process that connected belongs to the agentwatch session of that scope: at the accept it reads the peer from the
// kernel, and at the upgrade it walks from the peer through its parents to one of the scope's roots (a session's tmux
// pane process, by pid and start time). On Linux, when the walk reaches no root, the peer's cgroup may count: the
// pane's own systemd scope (the operator's ab-6gs answer). No key, no token file and no environment variable take part.
//
// One reader interface (PeerReader) stands behind the check: Linux (libc getsockopt SO_PEERCRED and SO_PEERPIDFD,
// poll and close through node:ffi; /proc with fs), the Mac (LOCAL_PEERPID, LOCAL_PEERCRED and proc_pidinfo through
// node:ffi; not run yet: board ab-v16.52), and the tests' fake. node:ffi is experimental in Node 26: the relay loads it
// only with --peer-check, by a dynamic import in its self-test, so no other agent-browser command loads it, prints its
// ExperimentalWarning or fails on a Node without it. A self-test that fails makes the endpoint fail closed (the 503
// `the relay cannot read the program of a connection`).

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import type { Root, Roots } from "./scopes.ts";

export type { Root, Roots };

/** The time limit of the whole self-test (C11). */
export const SELF_TEST_MS = 5000;
/** A root at most this many parents above the peer counts (C11, the session check, item 2). */
export const MAX_HOPS = 32;
/** The peer's 403 (C11, step 3): every read that fails at the accept. */
export const PEER_UNREAD = "The agent browser cannot tell which program connects, so it refuses the connection.";
/** The session's 403 (C11, step 6), with the peer's pid as the relay read it at the accept. */
export const sessionRefusal = (pid: number) =>
  `The agent browser admits a connection only from a program of the agentwatch session of its scope. This program (pid ${pid}) is not in it: it is in another session, it was started outside agentwatch, or it left the session. If this session started or restarted just now, connect again in a few seconds.`;

/** The form of every read after the self-test: a pidfd (Linux 6.5 and later), the stat form (an older Linux kernel), or the Mac. */
export type Form = "pidfd" | "stat" | "mac";
/** A process as /proc/<pid>/stat gives it (fields 3, 4 and 22), or proc_pidinfo on the Mac (state Z for SZOMB). */
export type Proc = { readonly ppid: number; readonly start: number; readonly state: string };
/** What a reader gives of an accepted socket: the pid and uid, and in the pidfd form a pidfd (null: SO_PEERPIDFD failed), in the stat form and on the Mac the peer's start time (null: not readable). */
export type RawPeer = { pid: number; uid: number; pidfd: number | null; start: number | null };

/** The one reader interface of the peer check: Linux, the Mac and the tests' fake implement it. */
export interface PeerReader {
  readonly form: Form;
  /** The peer of an accepted socket, read at the accept; null when the first read (SO_PEERCRED, LOCAL_PEERPID) fails. */
  peer(fd: number): RawPeer | null;
  /** A process's parent, start time and state; null when it cannot be read (it has gone). */
  proc(pid: number): Proc | null;
  /** A process's cgroup (the `0::` line of /proc/<pid>/cgroup); null on the Mac or when it cannot be read. */
  cgroup(pid: number): string | null;
  /** libc poll of a pidfd (POLLIN, a 0 ms timeout): 0 not readable, 1 readable (the process has exited), -1 an error. EINTR is tried again. */
  poll(pidfd: number): number;
  /** The `Pid:` line of /proc/self/fdinfo/<pidfd> (-1: reaped), or null. */
  fdinfoPid(pidfd: number): number | null;
  /** libc close of a pidfd. */
  close(pidfd: number): void;
}

const key = (pid: number, start: number) => `${pid}:${start}`;

/** A peer as the relay read it at the accept. Its pidfd (the pidfd form) is closed once, by release(). */
export class Peer {
  readonly pid: number;
  readonly uid: number;
  /** The start time at the accept (the stat form and the Mac), else null. */
  readonly start: number | null;
  private fd: number | null;
  constructor(raw: RawPeer) { this.pid = raw.pid; this.uid = raw.uid; this.start = raw.start; this.fd = raw.pidfd; }
  get pidfd(): number | null { return this.fd; }
  /** Close the pidfd, once: a second close could close a later fd that got the same number. */
  release(reader: PeerReader): void {
    if (this.fd === null) return;
    const fd = this.fd;
    this.fd = null;
    reader.close(fd);
  }
}

/**
 * The peer read (C11, step 3): null is the peer's 403. A read that fails, no pid (0), a uid other than the relay's,
 * and in the pidfd form a failed SO_PEERPIDFD (whatever its code), in the stat form and on the Mac a start time that
 * cannot be read, all give the one 403 (review-54b note 1).
 */
export function readPeer(reader: PeerReader, fd: number, uid: number): Peer | null {
  const raw = reader.peer(fd);
  if (!raw) return null;
  const ok = Number.isSafeInteger(raw.pid) && raw.pid > 0 && raw.uid === uid && (reader.form === "pidfd" ? raw.pidfd !== null : raw.start !== null);
  if (ok) return new Peer(raw);
  if (raw.pidfd !== null) reader.close(raw.pidfd);
  return null;
}

/** A root of the line as the relay read it at the line: whether it counts (for the walk), and its cgroup when that counts too. */
type RootInfo = { readonly root: Root; readonly counts: boolean; readonly cgroup: string | null };

/**
 * The defensive root rules (C11, the scope's session), applied at each line with the stat and the cgroup of every
 * root that applies, read then. A root counts only while it lives; a (pid, start) that two scopes name counts for
 * neither; a root that is an ancestor of another root counts for neither the walk nor the cgroup; a root's cgroup
 * counts only when it is not its parent's cgroup (a parent that cannot be read counts as the same), no live root of
 * another scope has the same cgroup, and no other live root's cgroup is under it. They catch the usual mistakes of a
 * line, not every wrong line.
 */
export class RootState {
  /** Every (pid, start) of the line, of any scope: the walk stops at each of them. */
  private readonly named: ReadonlySet<string>;
  private readonly byScope: ReadonlyMap<string, readonly RootInfo[]>;
  private constructor(named: Set<string>, byScope: Map<string, RootInfo[]>) { this.named = named; this.byScope = byScope; }

  static empty(): RootState { return new RootState(new Set(), new Map()); }

  static read(reader: PeerReader, roots: Roots): RootState {
    const scopesOf = new Map<string, Set<string>>();
    for (const [scope, list] of roots) for (const r of list) {
      const k = key(r.pid, r.start);
      let s = scopesOf.get(k);
      if (!s) scopesOf.set(k, (s = new Set()));
      s.add(scope);
    }
    // A root lives when the process with its pid has its start time.
    const live = new Map<string, { root: Root; proc: Proc; cgroup: string | null }>();
    for (const [, list] of roots) for (const r of list) {
      const k = key(r.pid, r.start);
      if (live.has(k)) continue;
      const proc = reader.proc(r.pid);
      if (proc && proc.start === r.start) live.set(k, { root: r, proc, cgroup: reader.cgroup(r.pid) });
    }
    // A root that the walk from another live root reaches is an ancestor: a pane is never under another pane.
    const ancestors = new Set<string>();
    for (const { root, proc } of live.values()) {
      let child = proc, pid = proc.ppid;
      for (let hop = 1; hop <= MAX_HOPS && pid > 1; hop++) {
        const p = reader.proc(pid);
        if (!p || p.start > child.start) break;
        const k = key(pid, p.start);
        if (scopesOf.has(k) && k !== key(root.pid, root.start)) ancestors.add(k);
        if (p.ppid === 0) break;
        child = p; pid = p.ppid;
      }
    }
    const byScope = new Map<string, RootInfo[]>();
    for (const [scope, list] of roots) {
      byScope.set(scope, list.map((root) => {
        const k = key(root.pid, root.start), l = live.get(k);
        const counts = !!l && scopesOf.get(k)!.size === 1 && !ancestors.has(k);
        if (!counts || l.cgroup === null) return { root, counts, cgroup: null };
        const cg = l.cgroup;
        const parent = reader.cgroup(l.proc.ppid);
        let cgroupCounts = parent !== null && parent !== cg;
        for (const [k2, other] of live) {
          if (k2 === k || other.cgroup === null) continue;
          const otherScope = [...scopesOf.get(k2)!].some((s) => s !== scope);
          if ((otherScope && other.cgroup === cg) || other.cgroup.startsWith(`${cg}/`)) cgroupCounts = false;
        }
        return { root, counts, cgroup: cgroupCounts ? cg : null };
      }));
    }
    return new RootState(new Set(scopesOf.keys()), byScope);
  }

  /** The first process of the walk that matches a root of the line, of any scope, or null (C11, the session check, item 2). */
  walk(reader: PeerReader, from: number): string | null {
    let pid = from, child: Proc | null = null;
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      const p = reader.proc(pid);
      if (!p) return null; // the pid has gone
      if (child && p.start > child.start) return null; // the parent's pid came back: it is not the child's parent
      const k = key(pid, p.start);
      if (this.named.has(k)) return k;
      if (pid === 1 || p.ppid === 0) return null;
      child = p; pid = p.ppid;
    }
    return null;
  }

  /**
   * C11's session check (step 6) for a connection of `scope`: the root that admits the peer, or null for the
   * session's 403. In order: the peer is alive; the walk, which admits only at a root of the scope that counts and
   * refuses at any other root; on Linux only when the walk stopped at no root, the peer's cgroup in the pane's scope
   * of a root of the scope whose cgroup counts (read again: the root's start and its cgroup of the line's read); the
   * peer is alive again, so the /proc files that the check read were the peer's.
   */
  check(reader: PeerReader, scope: string, peer: Peer): Root | null {
    if (!alive(reader, peer)) return null;
    const mine = this.byScope.get(scope) ?? [];
    let admitted: Root | null = null;
    const met = this.walk(reader, peer.pid);
    if (met !== null) admitted = mine.find((r) => r.counts && key(r.root.pid, r.root.start) === met)?.root ?? null;
    else if (reader.form !== "mac") {
      const cg = reader.cgroup(peer.pid);
      if (cg !== null) for (const r of mine) {
        if (r.cgroup === null || (cg !== r.cgroup && !cg.startsWith(`${r.cgroup}/`))) continue;
        // At a check the relay reads again only the scope's own roots: one stat and one cgroup read each.
        const now = reader.proc(r.root.pid);
        if (!now || now.start !== r.root.start || reader.cgroup(r.root.pid) !== r.cgroup) continue;
        admitted = r.root;
        break;
      }
    }
    return admitted && alive(reader, peer) ? admitted : null;
  }
}

/**
 * The peer is alive (C11, the session check, items 1 and 4). Pidfd form: poll of the pidfd returns 0, the pidfd's
 * fdinfo pid is the peer's own pid, and its stat can be read with a state other than Z; each counts alone (a Node peer
 * can show Z before its pidfd polls readable, and a pidfd can poll readable while the state still shows R). Stat form
 * and the Mac: the pid is still there with the start time of the accept, and its state is not Z (SZOMB).
 */
function alive(reader: PeerReader, peer: Peer): boolean {
  if (reader.form === "pidfd") {
    const fd = peer.pidfd;
    if (fd === null || reader.poll(fd) !== 0 || reader.fdinfoPid(fd) !== peer.pid) return false;
    const p = reader.proc(peer.pid);
    return p !== null && p.state !== "Z";
  }
  const p = reader.proc(peer.pid);
  return p !== null && p.start === peer.start && p.state !== "Z";
}

// ------------------------------------------------------------------ the gate of the endpoint

/**
 * The peer check of one relay: its self-test's result, the peer of each accepted socket, and the root state of the
 * last allowlist line. A gate whose self-test failed has no reader: every upgrade gets the 503 at step 3.
 */
export class PeerGate {
  readonly form: Form | null;
  /** Why the self-test failed, or null. */
  readonly failed: string | null;
  private readonly reader: PeerReader | null;
  private readonly uid: number;
  private state = RootState.empty();
  private readonly peers = new WeakMap<object, Peer | null>();

  constructor(o: { reader: PeerReader; uid?: number } | { failed: string }) {
    if ("failed" in o) { this.reader = null; this.form = null; this.failed = o.failed; this.uid = -1; }
    else { this.reader = o.reader; this.form = o.reader.form; this.failed = null; this.uid = o.uid ?? process.getuid!(); }
  }

  /** At each allowlist line: the defensive root rules, with a stat and a cgroup read of every root that applies. */
  setRoots(roots: Roots): void {
    this.state = this.reader ? RootState.read(this.reader, roots) : RootState.empty();
  }

  /** At each accept, before the relay reads the request: the peer read. Its pidfd closes with the socket at the latest. */
  accept(socket: Socket): void {
    if (!this.reader) return;
    const fd = (socket as unknown as { _handle?: { fd?: unknown } })._handle?.fd;
    this.peers.set(socket, typeof fd === "number" && fd >= 0 ? readPeer(this.reader, fd, this.uid) : null);
    socket.once("close", () => this.release(socket));
  }

  /** The peer that the relay read at the accept of `socket`, or null (the peer's 403). */
  peerOf(socket: object): Peer | null { return this.peers.get(socket) ?? null; }

  /** The session check of `peer` for `scope`: the root that admits it, or null (the session's 403). */
  check(scope: string, peer: Peer): Root | null { return this.reader ? this.state.check(this.reader, scope, peer) : null; }

  /** Close the pidfd of `socket`'s peer (after its upgrade's check, and at its close). */
  release(socket: object): void { if (this.reader) this.peers.get(socket)?.release(this.reader); }
}

// ------------------------------------------------------------------ Linux and the Mac, through node:ffi

/** The libc calls of the readers. `errno` reads the calling thread's errno right after a call that failed. */
export type Libc = {
  getsockopt(fd: number, level: number, name: number, value: Buffer, length: Buffer): number;
  poll(fds: Buffer, nfds: bigint, timeoutMs: number): number;
  close(fd: number): number;
  errno(): number;
  /** The Mac's libproc proc_pidinfo. */
  proc_pidinfo?(pid: number, flavor: number, arg: bigint, buffer: Buffer, size: number): number;
};

const SOL_SOCKET = 1, SO_PEERCRED = 17, SO_PEERPIDFD = 77;
const POLLIN = 1, EINTR = 4, ENOPROTOOPT = 92;
const SOL_LOCAL = 0, LOCAL_PEERCRED = 1, LOCAL_PEERPID = 2;
const PROC_PIDTBSDINFO = 3, PROC_BSDINFO_SIZE = 136, SZOMB = 5;
/** EINTR with a 0 ms timeout: poll is tried again, this many times at most; then it counts as an error. */
const POLL_TRIES = 100;

/** Fields 3 (state), 4 (ppid) and 22 (start) of /proc/<pid>/stat, after the last `)` (the name can hold one). */
export function parseStat(raw: string): Proc | null {
  const i = raw.lastIndexOf(")");
  if (i < 0) return null;
  const f = raw.slice(i + 2).split(" ");
  const ppid = Number(f[1]), start = Number(f[19]);
  if (!f[0] || !Number.isSafeInteger(ppid) || !Number.isSafeInteger(start)) return null;
  return { state: f[0], ppid, start };
}

/** The `0::` line of /proc/<pid>/cgroup (cgroup v2), or null. */
export function parseCgroup(raw: string): string | null {
  for (const line of raw.split("\n")) if (line.startsWith("0::")) return line.slice(3) || null;
  return null;
}

export class LinuxReader implements PeerReader {
  readonly form: "pidfd" | "stat";
  private readonly libc: Libc;
  constructor(libc: Libc, form: "pidfd" | "stat") { this.libc = libc; this.form = form; }

  /** SO_PEERCRED: the pid and uid of the process that called connect(), or null. */
  cred(fd: number): { pid: number; uid: number } | null {
    const value = Buffer.alloc(12), length = Buffer.alloc(4);
    length.writeUInt32LE(12);
    if (this.libc.getsockopt(fd, SOL_SOCKET, SO_PEERCRED, value, length) !== 0 || length.readUInt32LE(0) < 12) return null;
    return { pid: value.readInt32LE(0), uid: value.readUInt32LE(4) };
  }

  /** SO_PEERPIDFD: a pidfd of the same process, or the errno of the failure. */
  peerPidfd(fd: number): { pidfd: number } | { errno: number } {
    const value = Buffer.alloc(4), length = Buffer.alloc(4);
    length.writeUInt32LE(4);
    if (this.libc.getsockopt(fd, SOL_SOCKET, SO_PEERPIDFD, value, length) !== 0) return { errno: this.libc.errno() };
    const pidfd = value.readInt32LE(0);
    return pidfd >= 0 ? { pidfd } : { errno: 0 };
  }

  peer(fd: number): RawPeer | null {
    const c = this.cred(fd);
    if (!c) return null;
    if (this.form === "pidfd") {
      const p = this.peerPidfd(fd);
      return { ...c, pidfd: "pidfd" in p ? p.pidfd : null, start: null };
    }
    // The stat form reads the start time at the accept, so the window of a reused pid starts there (review-54b note 4).
    return { ...c, pidfd: null, start: c.pid > 0 ? this.proc(c.pid)?.start ?? null : null };
  }

  proc(pid: number): Proc | null {
    try { return parseStat(readFileSync(`/proc/${pid}/stat`, "latin1")); } catch { return null; }
  }

  cgroup(pid: number): string | null {
    try { return parseCgroup(readFileSync(`/proc/${pid}/cgroup`, "latin1")); } catch { return null; }
  }

  poll(pidfd: number): number {
    const fds = Buffer.alloc(8);
    for (let i = 0; i < POLL_TRIES; i++) {
      fds.writeInt32LE(pidfd, 0); fds.writeInt16LE(POLLIN, 4); fds.writeInt16LE(0, 6);
      const n = this.libc.poll(fds, 1n, 0);
      if (n >= 0) return n > 0 ? 1 : 0;
      // review-19b: a poll can fail with EINTR, also with a 0 ms timeout; only a real error counts as not alive.
      if (this.libc.errno() !== EINTR) return -1;
    }
    return -1;
  }

  fdinfoPid(pidfd: number): number | null {
    try {
      const m = /^Pid:\s*(-?\d+)\s*$/m.exec(readFileSync(`/proc/self/fdinfo/${pidfd}`, "latin1"));
      return m ? Number(m[1]) : null;
    } catch { return null; }
  }

  close(pidfd: number): void { this.libc.close(pidfd); }
}

/** The Mac (from the documentation and the xnu source; not run yet: board ab-v16.52 measures it). */
export class MacReader implements PeerReader {
  readonly form = "mac" as const;
  private readonly libc: Libc;
  constructor(libc: Libc) { this.libc = libc; }

  /** LOCAL_PEERPID (the last process that used the client's socket: at the accept, the connecter) and LOCAL_PEERCRED's cr_uid. */
  cred(fd: number): { pid: number; uid: number } | null {
    const pid = Buffer.alloc(4), pidLength = Buffer.alloc(4);
    pidLength.writeUInt32LE(4);
    if (this.libc.getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, pid, pidLength) !== 0) return null;
    // struct xucred: u_int cr_version; uid_t cr_uid; short cr_ngroups; gid_t cr_groups[16].
    const cred = Buffer.alloc(76), credLength = Buffer.alloc(4);
    credLength.writeUInt32LE(76);
    if (this.libc.getsockopt(fd, SOL_LOCAL, LOCAL_PEERCRED, cred, credLength) !== 0) return null;
    return { pid: pid.readInt32LE(0), uid: cred.readUInt32LE(4) };
  }

  peer(fd: number): RawPeer | null {
    const c = this.cred(fd);
    if (!c) return null;
    return { ...c, pidfd: null, start: c.pid > 0 ? this.proc(c.pid)?.start ?? null : null };
  }

  /** proc_pidinfo PROC_PIDTBSDINFO: struct proc_bsdinfo's pbi_status (offset 4), pbi_ppid (16), pbi_start_tvsec (120) and pbi_start_tvusec (128). */
  proc(pid: number): Proc | null {
    const info = Buffer.alloc(PROC_BSDINFO_SIZE);
    if (this.libc.proc_pidinfo?.(pid, PROC_PIDTBSDINFO, 0n, info, PROC_BSDINFO_SIZE) !== PROC_BSDINFO_SIZE) return null;
    const start = info.readBigUInt64LE(120) * 1_000_000n + info.readBigUInt64LE(128);
    if (start > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return { state: info.readUInt32LE(4) === SZOMB ? "Z" : "S", ppid: info.readUInt32LE(16), start: Number(start) };
  }

  cgroup(): string | null { return null; }
  poll(): number { return -1; }
  fdinfoPid(): number | null { return null; }
  close(): void {}
}

/** node:ffi's dlopen of libc (and libproc, which is in libSystem on the Mac). Every failure throws. */
function loadLibc(ffi: any, platform: NodeJS.Platform): Libc {
  if (platform === "darwin") {
    const { functions: f } = ffi.dlopen("/usr/lib/libSystem.B.dylib", {
      getsockopt: { return: "int32", arguments: ["int32", "int32", "int32", "buffer", "buffer"] },
      close: { return: "int32", arguments: ["int32"] },
      __error: { return: "pointer", arguments: [] },
      proc_pidinfo: { return: "int32", arguments: ["int32", "int32", "uint64", "buffer", "int32"] },
    });
    return { getsockopt: f.getsockopt, poll: () => -1, close: f.close, errno: () => ffi.getInt32(f.__error(), 0), proc_pidinfo: f.proc_pidinfo };
  }
  const { functions: f } = ffi.dlopen("libc.so.6", {
    getsockopt: { return: "int32", arguments: ["int32", "int32", "int32", "buffer", "buffer"] },
    poll: { return: "int32", arguments: ["buffer", "uint64", "int32"] },
    close: { return: "int32", arguments: ["int32"] },
    __errno_location: { return: "pointer", arguments: [] },
  });
  return { getsockopt: f.getsockopt, poll: f.poll, close: f.close, errno: () => ffi.getInt32(f.__errno_location(), 0) };
}

/** The child of the self-test: it connects and stays until the relay has read the connection (the relay ends it). */
const CHILD = `const s = require("node:net").connect(process.argv[1]); s.on("error", () => process.exit(1)); s.on("close", () => process.exit(0)); s.resume(); setTimeout(() => process.exit(3), 30000);`;

export type SelfTestOptions = {
  /** Tests only: the time limit (SELF_TEST_MS), the child's script, a wrapper of libc, the platform. */
  timeoutMs?: number;
  childScript?: string;
  wrapLibc?: (libc: Libc) => Libc;
  platform?: NodeJS.Platform;
  onChild?: (child: ChildProcess) => void;
  onFolder?: (dir: string) => void;
};

/**
 * The self-test (C11, the scope's session): load the reader (a dynamic import of node:ffi, then the dlopen of libc and
 * its symbols), listen on a socket in a 0700 folder of its own next to the endpoint socket, start a child process that
 * connects to it, and compare the peer of the accepted socket with the child's facts: its pid, the relay's uid, its
 * parent (the relay's pid) and a start time that can be read, and with a pidfd the pid that the pidfd names and a poll
 * of 0. SO_PEERPIDFD's answer selects the form: a pidfd the pidfd form, ENOPROTOOPT (a kernel before 6.5) the stat
 * form, any other error a failure. The whole test has SELF_TEST_MS; in every path the child stops and the folder goes.
 */
export async function selfTest(endpointSocket: string, o: SelfTestOptions = {}): Promise<{ reader: PeerReader } | { failed: string }> {
  const limit = o.timeoutMs ?? SELF_TEST_MS;
  const platform = o.platform ?? process.platform;
  let over = false, dir: string | undefined, child: ChildProcess | undefined, server: Server | undefined, timer: NodeJS.Timeout | undefined;
  const fail = (why: string): never => { throw new Error(why); };
  const check = () => { if (over) fail("the time limit passed"); };

  const run = async (): Promise<{ reader: PeerReader }> => {
    if (platform !== "linux" && platform !== "darwin") fail(`no peer reader for ${platform}`);
    let ffi: any;
    try { const mod: any = await import("node:ffi"); ffi = mod.default ?? mod; }
    catch (e) { fail(`node:ffi does not load (${(e as { code?: string }).code ?? (e as Error).message})`); }
    check();
    let libc: Libc;
    try { libc = loadLibc(ffi, platform); } catch (e) { fail(`dlopen of libc failed: ${(e as Error).message}`); }
    libc = o.wrapLibc ? o.wrapLibc(libc!) : libc!;
    dir = mkdtempSync(join(dirname(endpointSocket), ".peer-test-"));
    o.onFolder?.(dir);
    const path = join(dir, "t.sock");
    if (Buffer.byteLength(path) > 103) fail(`the self-test's socket path is longer than 103 bytes: ${path}`);
    const srv = (server = createServer());
    await new Promise<void>((resolve, reject) => { srv.once("error", reject); srv.listen(path, resolve); });
    check();
    const accepted = new Promise<Socket>((resolve) => srv.once("connection", resolve));
    const c = (child = spawn(process.execPath, ["-e", o.childScript ?? CHILD, path], { stdio: "ignore" }));
    o.onChild?.(c);
    const ended = new Promise<never>((_, reject) => {
      c.once("error", (e) => reject(new Error(`the self-test's child did not start: ${e.message}`)));
      c.once("exit", (code, sig) => reject(new Error(`the self-test's child ended before the read (${sig ?? code})`)));
    });
    const sock = await Promise.race([accepted, ended]);
    check();
    const fd = (sock as unknown as { _handle?: { fd?: unknown } })._handle?.fd;
    if (typeof fd !== "number" || fd < 0) fail("the accepted socket has no fd");
    const uid = process.getuid!();
    if (platform === "darwin") {
      const reader = new MacReader(libc);
      const cred = reader.cred(fd as number) ?? fail("LOCAL_PEERPID or LOCAL_PEERCRED failed");
      compare(cred, c.pid!, uid, reader.proc(cred.pid));
      sock.destroy();
      return { reader };
    }
    const probe = new LinuxReader(libc, "pidfd");
    const cred = probe.cred(fd as number) ?? fail("SO_PEERCRED failed");
    compare(cred, c.pid!, uid, probe.proc(cred.pid));
    const p = probe.peerPidfd(fd as number);
    let form: "pidfd" | "stat";
    if ("pidfd" in p) {
      try {
        const named = probe.fdinfoPid(p.pidfd);
        if (named !== c.pid) fail(`the pidfd names pid ${named}, not the child's ${c.pid}`);
        const polled = probe.poll(p.pidfd);
        if (polled !== 0) fail(`the poll of the child's pidfd returned ${polled}, not 0`);
      } finally { probe.close(p.pidfd); }
      form = "pidfd";
    } else if (p.errno === ENOPROTOOPT) form = "stat"; // a kernel before 6.5
    else fail(`SO_PEERPIDFD failed (errno ${p.errno})`);
    sock.destroy();
    return { reader: new LinuxReader(libc, form!) };
  };

  try {
    return await Promise.race([run(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`the self-test took more than ${limit} ms`)), limit); })]);
  } catch (e) {
    return { failed: (e as Error).message };
  } finally {
    over = true;
    clearTimeout(timer);
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    server?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }

  function compare(cred: { pid: number; uid: number }, childPid: number, uid: number, proc: Proc | null): void {
    if (cred.pid !== childPid) fail(`the peer's pid is ${cred.pid}, not the child's ${childPid}`);
    if (cred.uid !== uid) fail(`the peer's uid is ${cred.uid}, not the relay's ${uid}`);
    if (!proc) fail("the child's start time cannot be read");
    if (proc!.ppid !== process.pid) fail(`the child's parent is ${proc!.ppid}, not the relay's ${process.pid}`);
  }
}

/** The relay's peer check at its start: the self-test and its log line. A failure gives a gate that fails closed. */
export async function startPeerCheck(endpointSocket: string, log: (line: string) => void, o: SelfTestOptions = {}): Promise<PeerGate> {
  const r = await selfTest(endpointSocket, o);
  if ("failed" in r) {
    log(`relay: the peer check cannot run: ${r.failed}`);
    return new PeerGate({ failed: r.failed });
  }
  log(`relay: the peer check runs (${r.reader.form})`);
  return new PeerGate({ reader: r.reader });
}
