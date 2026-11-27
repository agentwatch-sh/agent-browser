// The service on the Mac (board ab-v16.94.6; the self-contained design, section 10; C11 and C12, the Mac), on fakes: this
// box runs no macOS call. A fake libSystem gives the kernel's bytes in Apple's struct layouts (src/service/mac.ts), a
// stand-in launchctl prints a job, the unit's fake world (fake-unit-world.ts) stands for the process table, and a fake
// `open` adds the new Chrome as launchd's child. No test starts `open`, osascript, plutil or a Chrome.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Socket } from "node:net";
import { AGENT_ARGS, CHROME_STABLE_BIN } from "../src/agent.ts";
import { daemonAdmission, REFUSED_NO_MAINPID, refusedCannotRead, refusedRule } from "../src/service/admission.ts";
import {
  handleNumber, launchdJob, launchdMainPid, launchdUnitState, macTcpReader, MacProcs, parseBsdInfo, parseLaunchctlPrint, parsePids, parseProcArgs2, parseSocketFdInfo,
  parseSocketFds, PROC_BSDINFO_SIZE, SOCKET_FDINFO_SIZE, type MacLib,
} from "../src/service/mac.ts";
import { admitConnection, McpSnapshot } from "../src/service/mcp/admission.ts";
import { macPortClosed, MAC_TCP_READER_MEASURED, walkReader } from "../src/service/mcp/proc.ts";
import { appVersion, bundleVersion, chromeVersions, defaultFolderOf, GiveBackWatcher, macNewer, macStart, type MacStart } from "../src/service/unit/mac-chrome.ts";
import { folderExtensionId } from "../src/service/package/crx.ts";
import { AGENT_VERSION, RECEIVER_ID } from "../src/service/package/pins.ts";
import { LOAD_HOLD_MS, LOAD_NOTE_MS } from "../src/service/unit/watch.ts";
import { stopAllProcs } from "../src/service/main.ts";
import { unitPaths } from "../src/service/unit/paths.ts";
import { stopAll } from "../src/service/unit/stop-all.ts";
import { Owner, type UnitState } from "../src/service/unit/owner.ts";
import * as PartNs from "../src/service/unit/part.ts";
import { ACCESS_REREAD_MS, loadNote, RECEIVER_OFF_TEXT, receiverOffNote, UnitPart } from "../src/service/unit/part.ts";
import { receiverOff } from "../src/service/unit/access.ts";
import { RECEIVER_OFF_SEND_TEXT } from "../src/service/signin/send-text.ts";
import { ChromeUnit, HEALTHY_MS, MAC_FIND_MS, StartError, type UnitEvent } from "../src/service/unit/unit.ts";
import { readRecord } from "../src/service/unit/record.ts";
import { MacReader, PEER_UNREAD, readPeer, sessionRefusal, type Libc, type PeerReader, type Proc, type RawPeer } from "../src/relay/peer.ts";
import { FakeTools, World } from "./fake-unit-world.ts";
import { tempDir } from "./temp-dirs.ts";

const UID = 501;

// ------------------------------------------------------------------ a fake libSystem

/**
 * `uid` is the effective uid and `ruid` the real one (`uid` by default); `noBsd`: PROC_PIDTBSDINFO fails (a process that
 * ends between the reads, or launchd for another user); `uniq` and `version`: p_uniqueid (the start by default, so the
 * walk's order is the start's) and p_idversion (the pid by default).
 */
type FP = { pid: number; ppid: number; start: number; argv: string[]; uid?: number; ruid?: number; noBsd?: boolean; pgid?: number; zombie?: boolean; path?: string; other?: boolean; fds?: Map<number, Buffer>; uniq?: number; version?: number };

/** struct proc_bsdinfo with the fields that the service reads; `start` in µs. */
function bsdBuf(p: FP): Buffer {
  const b = Buffer.alloc(PROC_BSDINFO_SIZE);
  b.writeUInt32LE(p.zombie ? 5 : 2, 4); b.writeUInt32LE(p.pid, 12); b.writeUInt32LE(p.ppid, 16);
  b.writeUInt32LE(p.uid ?? UID, 20); b.writeUInt32LE(p.ruid ?? p.uid ?? UID, 28); b.writeUInt32LE(p.pgid ?? p.pid, 100);
  b.writeBigUInt64LE(BigInt(Math.floor(p.start / 1e6)), 120); b.writeBigUInt64LE(BigInt(p.start % 1e6), 128);
  return b;
}
/** struct proc_uniqidentifierinfo (56 bytes; board ab-v16.52, measured): p_uniqueid (16) and p_idversion (32). */
function uniqBuf(p: FP): Buffer {
  const b = Buffer.alloc(56);
  b.writeBigUInt64LE(BigInt(p.uniq ?? p.start), 16); b.writeInt32LE(p.version ?? p.pid, 32);
  return b;
}
/** KERN_PROCARGS2: argc, the exec path, its NUL padding, the arguments, then the environment. */
function procArgs(p: FP): Buffer {
  const argc = Buffer.alloc(4); argc.writeInt32LE(p.argv.length);
  return Buffer.concat([argc, Buffer.from(`${p.path ?? p.argv[0]}\0\0\0\0`), ...p.argv.map((a) => Buffer.from(`${a}\0`)), Buffer.from("HOME=/Users/user\0\0")]);
}
/** struct socket_fdinfo of an IPv4 TCP socket. */
function sockBuf(o: { local: string; remote: string; uid?: number; handle: bigint; family?: number; kind?: number; vflag?: number }): Buffer {
  const b = Buffer.alloc(SOCKET_FDINFO_SIZE), psi = 24, proto = 264;
  b.writeUInt32LE(o.uid ?? UID, psi + 16); b.writeBigUInt64LE(o.handle, psi + 136); b.writeInt32LE(o.family ?? 2, psi + 160); b.writeInt32LE(o.kind ?? 2, psi + 232);
  b[proto + 24] = o.vflag ?? 1;
  const put = (addr: string, ipAt: number, portAt: number) => { const [ip, port] = addr.split(":"); ip.split(".").forEach((x, i) => { b[ipAt + i] = Number(x); }); b.writeUInt16BE(Number(port), portAt); };
  put(o.remote, proto + 44, proto); put(o.local, proto + 60, proto + 4);
  return b;
}

class FakeLib implements MacLib {
  readonly procs = new Map<number, FP>();
  add(p: FP): FP { this.procs.set(p.pid, p); return p; }
  proc_pidinfo(pid: number, flavor: number, _arg: bigint, buf: Buffer, size: number): number {
    const p = this.procs.get(pid);
    if (!p) return -1;
    if (flavor === 3) { if (p.noBsd) return -1; bsdBuf(p).copy(buf); return PROC_BSDINFO_SIZE; }
    if (flavor === 17) { uniqBuf(p).copy(buf); return 56; } // PROC_PIDUNIQIDENTIFIERINFO reads every process (measured)
    if (flavor !== 1 || p.other) return -1;
    let at = 0;
    for (const [fd, kind] of [[0, 1], ...[...(p.fds ?? new Map()).keys()].map((fd) => [fd, 2])]) { if (at + 8 > size) break; buf.writeInt32LE(fd, at); buf.writeUInt32LE(kind, at + 4); at += 8; }
    return at;
  }
  proc_pidfdinfo(pid: number, fd: number, _flavor: number, buf: Buffer): number {
    const s = this.procs.get(pid)?.fds?.get(fd);
    if (!s) return -1;
    s.copy(buf);
    return SOCKET_FDINFO_SIZE;
  }
  proc_pidpath(pid: number, buf: Buffer): number { const p = this.procs.get(pid); if (!p?.path) return 0; return Buffer.from(p.path).copy(buf); }
  proc_listallpids(buf: Buffer, size: number): number {
    let i = 0;
    for (const pid of this.procs.keys()) { if ((i + 1) * 4 > size) break; buf.writeInt32LE(pid, i * 4); i++; }
    return i;
  }
  sysctl(mib: Buffer, _count: number, old: Buffer, length: Buffer): number {
    if (mib.readInt32LE(4) === 8) { old.writeInt32LE(65536); return 0; }
    const p = this.procs.get(mib.readInt32LE(8));
    if (!p || p.other) return -1;
    const a = procArgs(p);
    if (a.length > Number(length.readBigUInt64LE(0))) return -1;
    a.copy(old); length.writeBigUInt64LE(BigInt(a.length));
    return 0;
  }
  sysctlbyname(name: Buffer, old: Buffer, length: Buffer): number {
    if (name.toString() !== "kern.bootsessionuuid\0") return -1;
    const v = Buffer.from("6F1C-BOOT\0"); v.copy(old); length.writeBigUInt64LE(BigInt(v.length));
    return 0;
  }
}

/**
 * The relay's Mac reader over the fake libSystem (board ab-v16.52): LOCAL_PEERTOKEN (audit_token_t: the pid at 20, the pid
 * version at 28) of `tok.peer`'s process, or EINVAL when there is none (a connecter that has gone); LOCAL_PEERCRED's cr_uid
 * (at 4); proc_pidinfo from the fake. `tok.afterToken` runs right after the token's read.
 */
function macLibcOf(lib: FakeLib, tok: { peer: number | null; afterToken?: () => void }): Libc {
  let errno = 0;
  return {
    getsockopt: (_fd, level, name, value, length) => {
      if (level === 0 && name === 1) { value.writeUInt32LE(process.getuid!(), 4); return 0; }
      const p = tok.peer === null ? undefined : lib.procs.get(tok.peer);
      if (level !== 0 || name !== 6 || !p) { errno = 22; return -1; }
      value.writeUInt32LE(p.pid, 20); value.writeUInt32LE(p.version ?? p.pid, 28); length.writeUInt32LE(32);
      tok.afterToken?.();
      return 0;
    },
    poll: () => -1, close: () => 0, errno: () => errno,
    proc_pidinfo: (pid, flavor, arg, buf, size) => lib.proc_pidinfo(pid, flavor, arg, buf, size),
  };
}

// ------------------------------------------------------------------ the parsers and the reads

test("the Mac's parsers read Apple's struct layouts: proc_bsdinfo, KERN_PROCARGS2, proc_listallpids, PROC_PIDLISTFDS and socket_fdinfo", () => {
  assert.deepEqual(parseBsdInfo(bsdBuf({ pid: 9, ppid: 4, start: 1_700_000_123_456_789, argv: ["x"], pgid: 9 })), { status: 2, ppid: 4, uid: UID, ruid: UID, pgid: 9, start: 1_700_000_123_456_789 });
  assert.equal(parseBsdInfo(Buffer.alloc(100)), null, "a short buffer");
  const args = parseProcArgs2(procArgs({ pid: 1, ppid: 0, start: 1, argv: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "--user-data-dir=/Users/user/My Profile", ""] }))!;
  assert.deepEqual(args.argv.map(String), ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "--user-data-dir=/Users/user/My Profile", ""], "each argument whole, with its spaces, and an empty one");
  assert.equal(args.exec, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  assert.equal(parseProcArgs2(Buffer.from([0, 0, 0, 0])), null, "argc 0");
  assert.equal(parseProcArgs2(Buffer.concat([Buffer.from([2, 0, 0, 0]), Buffer.from("/bin/x\0\0a\0")])), null, "fewer arguments than argc");
  const pids = Buffer.alloc(16); [7, 1, 0, 33].forEach((p, i) => pids.writeInt32LE(p, i * 4));
  assert.deepEqual(parsePids(pids, 4), [7, 1, 33]);
  const fds = Buffer.alloc(24); [[0, 1], [5, 2], [6, 2]].forEach(([fd, t], i) => { fds.writeInt32LE(fd, i * 8); fds.writeUInt32LE(t, i * 8 + 4); });
  assert.deepEqual(parseSocketFds(fds, 24), [5, 6], "only sockets (PROX_FDTYPE_SOCKET)");
  assert.deepEqual(parseSocketFds(fds, 16), [5], "only the bytes that the call filled");
  const s = sockBuf({ local: "127.0.0.1:50123", remote: "127.0.0.1:8080", uid: 502, handle: 0xffffff80_1234_5678n });
  assert.deepEqual(parseSocketFdInfo(s), { local: "127.0.0.1:50123", remote: "127.0.0.1:8080", uid: 502, handle: 0xffffff80_1234_5678n }, "ports in the network byte order");
  assert.equal(handleNumber(0xffffff80_1234_5678n), 0xff80_1234_5678);
  assert.equal(parseSocketFdInfo(sockBuf({ local: "127.0.0.1:1", remote: "127.0.0.1:2", handle: 1n, family: 30 })), null, "AF_INET6: /proc/net/tcp has no such line either");
  assert.equal(parseSocketFdInfo(sockBuf({ local: "127.0.0.1:1", remote: "127.0.0.1:2", handle: 1n, kind: 1 })), null, "not SOCKINFO_TCP");
  assert.equal(parseSocketFdInfo(sockBuf({ local: "127.0.0.1:1", remote: "127.0.0.1:2", handle: 1n, vflag: 2 })), null, "an IPv6 address");
  assert.equal(parseSocketFdInfo(Buffer.alloc(100)), null);
});

test("launchctl print: the job's top-level state and pid lines only; a stand-in launchctl gives the owner rule's state and the control door's MainPID", async () => {
  const t = "gui/501/com.agentwatch";
  const job = (body: string) => `${t} = {\n\tactive count = 1\n${body}\tendpoints = {\n\t\tpid = 9\n\t\tstate = active\n\t}\n}\n`;
  assert.deepEqual(parseLaunchctlPrint(job("\tstate = running\n\tpid = 4242\n"), t), { state: "running", pid: 4242 });
  assert.deepEqual(parseLaunchctlPrint(job("\tstate = not running\n"), t), { state: "not running", pid: 0 }, "no pid line: pid 0; a nested pid is not read");
  assert.equal(parseLaunchctlPrint(job("\tstate = running\n\tpid = 1\n"), "gui/501/com.other"), null, "another job's output");
  assert.equal(parseLaunchctlPrint(job("\tstate = running\n\tstate = running\n"), t), null, "a state twice");
  assert.equal(parseLaunchctlPrint(job("\tpid = 4\n"), t), null, "no state");
  const dir = tempDir("ab-mac-launchctl-");
  try {
    const bin = join(dir, "launchctl");
    writeFileSync(bin, `#!/bin/sh\n[ "$1" = print ] || exit 64\ncase "$2" in\n  gui/501/com.agentwatch) printf '${t} = {\\n\\tstate = running\\n\\tpid = 4242\\n}\\n' ;;\n  gui/501/com.agentwatch.agent-browser) printf 'gui/501/com.agentwatch.agent-browser = {\\n\\tstate = waiting\\n}\\n' ;;\n  *) echo "Could not find service" >&2; exit 113 ;;\nesac\n`);
    chmodSync(bin, 0o700);
    const o = { uid: 501, launchctl: bin };
    assert.deepEqual(await launchdJob("com.agentwatch", o), { state: "running", pid: 4242 });
    assert.equal(await launchdMainPid("com.agentwatch", o)(), 4242);
    assert.equal(await launchdMainPid("com.nothing", o)(), null, "no such job: the read fails (m1: the door refuses)");
    assert.equal(await launchdMainPid("com.agentwatch.agent-browser", o)(), 0, "a job that does not run");
    assert.deepEqual(await launchdUnitState("com.agentwatch", o)(), { active: "active", sub: "running", mainPid: 4242 } satisfies UnitState);
    assert.deepEqual(await launchdUnitState("com.agentwatch.agent-browser", o)(), { active: "waiting", sub: "waiting", mainPid: 0 });
    assert.equal(await launchdJob("../evil label", o), null, "a label that is not one is never asked");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("MacProcs: the unit's reads through libSystem: stat, the exact argv, the real uid, the executable, the pids, the boot's id; another user's process gives no argv", () => {
  const lib = new FakeLib();
  lib.add({ pid: 1, ppid: 0, start: 10, argv: ["/sbin/launchd"] });
  lib.add({ pid: 700, ppid: 1, start: 5_000_000, pgid: 700, argv: [CHROME_STABLE_BIN, "--user-data-dir=/Users/user/agent state/profile"] });
  lib.add({ pid: 701, ppid: 1, start: 6, argv: ["/bin/zsh"], zombie: true });
  lib.add({ pid: 702, ppid: 1, start: 7, argv: ["/usr/bin/other"], uid: 0, other: true });
  lib.add({ pid: 999, ppid: 1, start: 8, argv: ["node"] });
  const p = new MacProcs(lib, { uid: UID, self: 999 });
  assert.deepEqual(p.stat(700), { state: "S", ppid: 1, pgrp: 700, start: 5_000_000 });
  assert.equal(p.stat(701), null, "a zombie is gone, as on Linux");
  assert.deepEqual(p.proc(701), { ppid: 1, start: 6, state: "Z", order: 6 }, "the walk sees the zombie state; its order is p_uniqueid (board ab-v16.52)");
  assert.deepEqual(p.cmdline(700), [CHROME_STABLE_BIN, "--user-data-dir=/Users/user/agent state/profile"]);
  assert.ok(p.holds(700, ["--user-data-dir=/Users/user/agent state/profile"]), "a marker with a space is one whole argument");
  assert.ok(!p.holds(700, ["--user-data-dir=/Users/user/agent"]));
  assert.deepEqual(p.cmdline(702), [], "another user's argv cannot be read");
  assert.ok(!p.mine(702));
  assert.deepEqual(p.pids(), [700, 701, 702], "no pid 1 and not the service itself");
  assert.deepEqual(p.allPids(), [1, 700, 701, 702, 999]);
  lib.procs.get(700)!.path = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  assert.equal(p.exe(700), CHROME_STABLE_BIN);
  assert.equal(p.exe(701), null);
  assert.equal(p.bootId(), "6F1C-BOOT");
  assert.equal(p.sys(), null);
});

// ------------------------------------------------------------------ part 3: the MCP port's reader

test("the Mac's TCP peer reader under the MCP admission (steps 1 and 2): the client's socket by the full tuple with its holders' real uid, its holders, the walk to the session's root; the Mac check measured it, so the port's gate is open (board ab-v16.94.32)", () => {
  const lib = new FakeLib(), SERVICE = "127.0.0.1:7777", CLIENT = "127.0.0.1:50000";
  lib.add({ pid: 1, ppid: 0, start: 1, argv: ["/sbin/launchd"] });
  lib.add({ pid: 200, ppid: 1, start: 2000, argv: ["-zsh"] });
  const client = lib.add({ pid: 300, ppid: 200, start: 3000, argv: ["node", "mcp-client"], fds: new Map([[12, sockBuf({ local: CLIENT, remote: SERVICE, handle: 0xaa01n })]]) });
  lib.add({ pid: 999, ppid: 1, start: 900, argv: ["node", "agent-browser", "service"], fds: new Map([[30, sockBuf({ local: SERVICE, remote: CLIENT, handle: 0xbb02n })]]) });
  lib.add({ pid: 400, ppid: 1, start: 4000, argv: ["/usr/bin/x"], uid: 0, other: true, fds: new Map([[3, sockBuf({ local: CLIENT, remote: SERVICE, handle: 0xaa01n })]]) });
  const procs = new MacProcs(lib, { uid: UID, self: 999 });
  const reader = macTcpReader(procs);
  const snapshot = McpSnapshot.read(walkReader(reader), [{ scope: "md-lead", roots: [{ pid: 200, start: 2000 }], mcp_token: null }]);
  const admit = () => admitConnection({ reader, snapshot, client: CLIENT, service: SERVICE, uid: UID });
  assert.deepEqual(admit(), { scope: "md-lead", roots: [{ pid: 200, start: 2000 }], byCgroup: [], pid: 300, admission: "local" }, "the reverse tuple (the service's own socket) is no match; another user's process is no holder");
  assert.deepEqual(reader.holders(handleNumber(0xaa01n)), [300]);
  client.ruid = 502;
  assert.deepEqual(admit(), { step: 1, status: 403, body: PEER_UNREAD }, "a holder whose real uid is another user's");
  delete client.ruid;
  // Board ab-v16.52: the walk orders by p_uniqueid. A holder whose pbi_start is before its parent's (the clock stepped back
  // between the forks) and whose p_uniqueid is later passes; a parent whose p_uniqueid is later (its pid came back) stops it.
  client.start = 1500; client.uniq = 3000;
  assert.deepEqual(admit(), { scope: "md-lead", roots: [{ pid: 200, start: 2000 }], byCgroup: [], pid: 300, admission: "local" }, "a clock step back: admitted");
  client.start = 3000; client.uniq = 1500;
  assert.deepEqual(admit(), { step: 2, status: 403, body: sessionRefusal(300) }, "the parent's p_uniqueid is later than the holder's");
  delete client.uniq;
  client.ppid = 1;
  assert.deepEqual(admit(), { step: 2, status: 403, body: sessionRefusal(300) }, "a holder that reaches no root");
  lib.procs.delete(300);
  assert.deepEqual(admit(), { step: 1, status: 403, body: PEER_UNREAD }, "no line");
  assert.equal(MAC_TCP_READER_MEASURED, true, "the Mac check measured the reader (board ab-v16.94.32): the port's gate is open on the Mac");
  assert.equal(macPortClosed("darwin"), false);
  assert.equal(macPortClosed("darwin", true), false);
  assert.equal(macPortClosed("darwin", false), true, "the test switch still closes the gate");
  assert.equal(macPortClosed("linux"), false);
  assert.equal(macPortClosed("linux", false), false);
});

test("the Mac's TCP peer reader takes each line's uid from the real uid of the processes that hold the socket, never from soi_stat.vst_uid (0 on the Mac); holders of different uids, or a holder whose uid cannot be read, give a uid of no user (board ab-v16.94.29)", () => {
  const lib = new FakeLib(), SERVICE = "127.0.0.1:7777", CLIENT = "127.0.0.1:50000", OTHER = "127.0.0.1:50001", NO_USER = -1;
  // The Mac's real case (Mac check group A, 2026-11-15): soi_stat.vst_uid reads 0 for each socket.
  const sock = (local: string, remote: string, handle: bigint) => sockBuf({ local, remote, handle, uid: 0 });
  lib.add({ pid: 1, ppid: 0, start: 1, argv: ["/sbin/launchd"], uid: 0, other: true });
  lib.add({ pid: 200, ppid: 1, start: 2000, argv: ["-zsh"] });
  const client = lib.add({ pid: 300, ppid: 200, start: 3000, argv: ["node", "mcp-client"], fds: new Map([[12, sock(CLIENT, SERVICE, 0xaa01n)]]) });
  lib.add({ pid: 999, ppid: 1, start: 900, argv: ["node", "agent-browser", "service"], fds: new Map([[30, sock(SERVICE, CLIENT, 0xbb02n)]]) });
  // Another user's process: PROC_PIDLISTFDS fails (xnu's CHECK_SAME_USER), so its socket gives no line.
  lib.add({ pid: 400, ppid: 1, start: 4000, argv: ["/usr/bin/x"], uid: 502, other: true, fds: new Map([[3, sock(OTHER, SERVICE, 0xcc03n)]]) });
  const reader = macTcpReader(new MacProcs(lib, { uid: UID, self: 999 }));
  const lines = (local: string) => reader.tcp()!.filter((l) => l.local === local);
  const uid = () => { const l = lines(CLIENT); assert.equal(l.length, 1, "exactly one line for the client's socket"); return l[0].uid; };
  const snapshot = McpSnapshot.read(walkReader(reader), [{ scope: "md-lead", roots: [{ pid: 200, start: 2000 }], mcp_token: null }]);
  const admit = () => admitConnection({ reader, snapshot, client: CLIENT, service: SERVICE, uid: UID });
  const ADMITTED = { scope: "md-lead", roots: [{ pid: 200, start: 2000 }], byCgroup: [], pid: 300, admission: "local" };
  const PEER403 = { step: 1, status: 403, body: PEER_UNREAD };

  // 1. One holder of the operator, and the socket's soi uid is 0: the line has the holder's real uid, and the admission admits it.
  assert.deepEqual(lines(CLIENT), [{ local: CLIENT, remote: SERVICE, uid: UID, inode: handleNumber(0xaa01n) }]);
  assert.deepEqual(lines(SERVICE), [{ local: SERVICE, remote: CLIENT, uid: UID, inode: handleNumber(0xbb02n) }], "the accepted socket: the service's own real uid");
  assert.deepEqual(admit(), ADMITTED, "the Mac's real case: soi uid 0, a holder of the operator");

  // 2. The soi uid is out of the decision, and the uid is the real uid: a soi uid of the operator and an effective uid of the
  //    operator do not admit a holder whose real uid is another user's.
  client.fds!.set(12, sockBuf({ local: CLIENT, remote: SERVICE, handle: 0xaa01n }));
  client.ruid = 502;
  assert.equal(uid(), 502, "the holder's real uid, not the soi uid and not the effective uid");
  assert.deepEqual(admit(), PEER403);
  delete client.ruid;
  client.fds!.set(12, sock(CLIENT, SERVICE, 0xaa01n));
  assert.deepEqual(admit(), ADMITTED);

  // 3. Two holders with different real uids, in both orders of the scan: the line's uid matches no user (fail closed).
  for (const pid of [250, 350]) {
    const second = lib.add({ pid, ppid: 200, start: pid * 10, argv: ["node", "helper"], ruid: 502, fds: new Map([[7, sock(CLIENT, SERVICE, 0xaa01n)]]) });
    assert.equal(uid(), NO_USER, `holders of different uids (the other holder's pid ${pid})`);
    assert.deepEqual(reader.holders(handleNumber(0xaa01n)), [Math.min(pid, 300), Math.max(pid, 300)], "both holders stay the socket's holders");
    assert.deepEqual(admit(), PEER403, `holders of different uids: the peer's 403 (pid ${pid})`);
    delete second.ruid;
    assert.equal(uid(), UID, "two holders of the operator: the operator's uid");
    lib.procs.delete(pid);
  }

  // 4. A holder whose uid cannot be read (PROC_PIDTBSDINFO fails): alone, or beside a holder of the operator in both orders.
  client.noBsd = true;
  assert.equal(uid(), NO_USER, "the one holder's uid cannot be read");
  assert.deepEqual(admit(), PEER403);
  delete client.noBsd;
  for (const pid of [250, 350]) {
    lib.add({ pid, ppid: 200, start: pid * 10, argv: ["node", "helper"], noBsd: true, fds: new Map([[7, sock(CLIENT, SERVICE, 0xaa01n)]]) });
    assert.equal(uid(), NO_USER, `a second holder whose uid cannot be read (pid ${pid})`);
    assert.deepEqual(admit(), PEER403);
    lib.procs.delete(pid);
  }
  assert.deepEqual(admit(), ADMITTED, "one holder of the operator again");

  // 5. A process whose fds the service cannot read (another user's) gives no line, so its connection gets the peer's 403.
  assert.deepEqual(lines(OTHER), [], "another user's socket has no line");
  assert.deepEqual(admitConnection({ reader, snapshot, client: OTHER, service: SERVICE, uid: UID }), PEER403);
});

// ------------------------------------------------------------------ part 2: the control door's admission

test("the control door's admission on the Mac (C12): the peer of the relay's Mac reader (LOCAL_PEERTOKEN) and its start time, launchctl's job pid, proc_pidinfo, KERN_PROCARGS2 and proc_pidpath; rules 1 to 4 as on Linux", async () => {
  const dir = tempDir("ab-mac-admission-");
  try {
    const file = join(dir, "daemon-command.json"), INTERP = "/Users/user/.local/share/uv/python/cpython-3.13/bin/python3.13", ARGS = ["/Users/user/agentwatch/bin/agentwatch", "--daemon"];
    writeFileSync(file, JSON.stringify({ v: 1, interpreter: INTERP, args: ARGS }), { mode: 0o600 });
    const SOCK = { _handle: { fd: 9 } } as unknown as Socket;
    type Opts = { procs?: Record<number, Proc>; peer?: RawPeer | null; main?: (number | null)[]; argv?: string[]; exe?: string; after?: Record<number, Proc>; form?: string; mac?: { failed: string } };
    const run = async (o: Opts = {}) => {
      let table = o.procs ?? { 4242: { ppid: 1, start: 100, state: "S", order: 100 }, 4300: { ppid: 4242, start: 200, state: "S", order: 200 } };
      const mains = [...(o.main ?? [4242, 4242])];
      const reader: PeerReader = {
        form: (o.form ?? "mac") as "mac", peer: () => (o.peer === undefined ? { pid: 4300, uid: process.getuid!(), pidfd: null, start: 200 } : o.peer),
        proc: (pid) => table[pid] ?? null, order: (pid) => (pid === 1 ? 1 : table[pid]?.order ?? null), cgroup: () => null, poll: () => -1, fdinfoPid: () => null, close: () => {},
      };
      const admit = daemonAdmission({
        reader, pidfd: { failed: "no pidfd on darwin" }, commandFile: file, platform: "darwin", selfPid: 999,
        mainPid: async () => { const m = mains.shift() ?? null; if (mains.length === 0 && o.after) table = o.after; return m; },
        mac: o.mac ?? { argv: (pid) => (table[pid] ? [Buffer.from("python3"), ...(o.argv ?? ARGS).map((a) => Buffer.from(a))] : null), exe: (pid) => (table[pid] ? Buffer.from(o.exe ?? INTERP) : null) },
      });
      return admit(SOCK);
    };
    assert.deepEqual(await run(), { ok: true, pid: 4300 }, "the job's direct child with the daemon's command");
    assert.deepEqual(await run({ peer: { pid: 4242, uid: process.getuid!(), pidfd: null, start: 100 } }), { ok: true, pid: 4242 }, "the job's pid itself");
    assert.deepEqual(await run({ main: [null] }), { ok: false, reason: REFUSED_NO_MAINPID }, "launchctl fails or the job is not loaded (m1)");
    assert.deepEqual(await run({ main: [0] }), { ok: false, reason: REFUSED_NO_MAINPID }, "the job does not run");
    assert.deepEqual(await run({ main: [4243] }), { ok: false, reason: refusedRule(1, "the service cannot read the start time of the MainPID") });
    assert.deepEqual(await run({ procs: { 4242: { ppid: 1, start: 100, state: "S", order: 100 }, 4300: { ppid: 4000, start: 200, state: "S", order: 200 } } }), { ok: false, reason: refusedRule(2, "its parent is not the MainPID of agentwatch's unit") });
    assert.deepEqual(await run({ peer: { pid: 999, uid: process.getuid!(), pidfd: null, start: 50 }, procs: { 4242: { ppid: 1, start: 100, state: "S", order: 100 }, 999: { ppid: 4242, start: 50, state: "S", order: 50 } } }), { ok: false, reason: refusedRule(2, "it is the service itself") });
    assert.deepEqual(await run({ argv: ["/Users/user/agentwatch/bin/agentwatch", "--hook"] }), { ok: false, reason: refusedRule(3, "its command line is not the daemon's command") });
    assert.deepEqual(await run({ exe: "/usr/bin/python3" }), { ok: false, reason: refusedRule(3, "its executable is not the interpreter of the daemon's command") });
    assert.deepEqual(await run({ peer: { pid: 4300, uid: process.getuid!(), pidfd: null, start: 199 } }), { ok: false, reason: refusedRule(4, "the service cannot read the peer and hold its pidfd") }, "a start time at the accept that is not the process's");
    assert.deepEqual(await run({ peer: { pid: 4300, uid: 0, pidfd: null, start: 200 } }), { ok: false, reason: refusedRule(4, "the service cannot read the peer and hold its pidfd") }, "another user");
    assert.deepEqual(await run({ main: [4242, 4250] }), { ok: false, reason: refusedRule(4, "the MainPID changed during the check") });
    assert.deepEqual(await run({ after: { 4242: { ppid: 1, start: 100, state: "S", order: 100 }, 4300: { ppid: 4242, start: 201, state: "S", order: 200 } } }), { ok: false, reason: refusedRule(4, "the peer changed during the check") });
    assert.deepEqual(await run({ after: { 4242: { ppid: 1, start: 101, state: "S", order: 100 }, 4300: { ppid: 4242, start: 200, state: "S", order: 200 } } }), { ok: false, reason: refusedRule(4, "the MainPID changed during the check") }, "the job's process is another one by its start time");
    assert.deepEqual(await run({ procs: { 4242: { ppid: 1, start: 100, state: "S", order: 100 }, 4300: { ppid: 4242, start: 200, state: "S" } } }), { ok: false, reason: refusedRule(4, "the peer changed during the check") }, "a Mac read with no order: refused (fail closed)");
    assert.deepEqual(await run({ form: "stat" }), { ok: false, reason: refusedCannotRead("the peer reader is not the Mac's") });
    assert.deepEqual(await run({ mac: { failed: "dlopen of libSystem failed: x" } }), { ok: false, reason: refusedCannotRead("dlopen of libSystem failed: x") });
    const linuxOnly = daemonAdmission({ reader: { failed: "x" }, pidfd: { failed: "x" }, mainPid: async () => 1, commandFile: file, platform: "win32" });
    assert.match((await linuxOnly(SOCK) as { reason: string }).reason, /not built for win32/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("board ab-v16.52: the control door's rule 4 on the Mac reads the peer by LOCAL_PEERTOKEN and its p_idversion, and orders it after its parent by p_uniqueid (launchd's is 1), with no clock", async () => {
  const dir = tempDir("ab-mac-token-");
  try {
    const file = join(dir, "daemon-command.json"), INTERP = "/Users/user/.local/share/uv/python/cpython-3.13/bin/python3.13", ARGS = ["/Users/user/agentwatch/bin/agentwatch", "--daemon"];
    writeFileSync(file, JSON.stringify({ v: 1, interpreter: INTERP, args: ARGS }), { mode: 0o600 });
    const SOCK = { _handle: { fd: 9 } } as unknown as Socket;
    const lib = new FakeLib();
    // launchd: another user's process; PROC_PIDTBSDINFO fails for it, PROC_PIDUNIQIDENTIFIERINFO does not (measured).
    lib.add({ pid: 1, ppid: 0, start: 0, argv: ["/sbin/launchd"], uid: 0, other: true, noBsd: true, uniq: 1, version: 629 });
    const job = lib.add({ pid: 4242, ppid: 1, start: 1_795_356_353_591_748, uniq: 13253533, version: 27796973, argv: ["python3", ...ARGS], path: INTERP });
    const child = lib.add({ pid: 4300, ppid: 4242, start: 1_795_584_963_344_866, uniq: 19849778, version: 41044391, argv: ["python3", ...ARGS], path: INTERP });
    const tok: { peer: number | null; afterToken?: () => void } = { peer: 4300 };
    const procs = new MacProcs(lib, { uid: UID, self: 999 });
    const admit = daemonAdmission({
      reader: new MacReader(macLibcOf(lib, tok)), pidfd: { failed: "no pidfd on darwin" }, commandFile: file, platform: "darwin", selfPid: 999, mainPid: async () => 4242,
      mac: { argv: (pid) => procs.procArgs(pid)?.argv ?? null, exe: (pid) => procs.exeBytes(pid) },
    });
    const UNREAD = { ok: false, reason: refusedRule(4, "the service cannot read the peer and hold its pidfd") };
    const CHANGED = { ok: false, reason: refusedRule(4, "the peer changed during the check") };
    assert.deepEqual(await admit(SOCK), { ok: true, pid: 4300 }, "the job's child, by its token");
    // The peer read (C11's, through the relay's reader).
    tok.peer = null;
    assert.deepEqual(await admit(SOCK), UNREAD, "the token's read fails (EINVAL: the connecter has gone)");
    tok.peer = 4300;
    tok.afterToken = () => { child.version = (child.version ?? 0) + 1; };
    assert.deepEqual(await admit(SOCK), UNREAD, "another process at the pid after the token's read: another p_idversion");
    delete tok.afterToken;
    // The order: p_uniqueid, not pbi_start.
    child.start = job.start - 60_000_000;
    assert.deepEqual(await admit(SOCK), { ok: true, pid: 4300 }, "the clock stepped back 60 s between the job's fork and the child's: admitted");
    child.start = 1_795_584_963_344_866;
    job.uniq = 19900000;
    assert.deepEqual(await admit(SOCK), CHANGED, "the job's pid came back (a p_uniqueid later than the child's), with an earlier pbi_start than the child's");
    job.uniq = 13253533;
    // The job itself: its parent launchd's order is read (p_uniqueid 1), not its start time.
    tok.peer = 4242;
    assert.deepEqual(await admit(SOCK), { ok: true, pid: 4242 }, "the job's pid itself, under launchd");
    lib.add({ pid: 5000, ppid: 1, start: 1_795_000_000_000_000, argv: ["/bin/zsh"], uniq: 19950000 });
    job.ppid = 5000;
    assert.deepEqual(await admit(SOCK), CHANGED, "a parent of the job whose p_uniqueid is later than the job's (its pid came back), with an earlier pbi_start");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------ part 1: the agent Chrome

const APP = "/Applications/Google Chrome.app";

/** A fake `open`: it adds the new Chrome as launchd's child (or does `what`), and records each call. */
function fakeMac(w: World, o: { what?: string[]; version?: string } = {}) {
  const calls: { bundle: string; args: string[] }[] = [], guards: string[] = [];
  const mac: MacStart = {
    app: (bin) => ({ binary: bin || CHROME_STABLE_BIN, bundle: APP, version: o.version ?? "156.0.8078.80", google: !bin }),
    open: async (bundle, args) => {
      calls.push({ bundle, args });
      const what = o.what?.shift();
      if (what === "fail") return 1;
      if (what !== "none") w.add({ argv: [CHROME_STABLE_BIN, ...args], ppid: 1 });
      return 0;
    },
    guard: async (bundle) => { guards.push(`begin ${bundle}`); return { finish: async (ms) => { guards.push(`finish ${ms}`); } }; },
  };
  return { mac, calls, guards };
}
const CONFIG = { enabled: true, chromeBin: "", chromeArgs: [], displaySize: "1280x900", lang: "en-US", timezone: "" };

test("the agent Chrome on the Mac: the operator's Google Chrome.app through open -n -g on the agent profile, its pid found and recorded, no Xvfb, no agent package; stop, adoption and a failed open", async () => {
  const w = new World();
  try {
    const f = fakeMac(w);
    let prepared = 0;
    const u = new ChromeUnit(w.deps(new FakeTools(), { mac: f.mac, prepare: { run: () => { prepared++; return "1"; }, lastFile: () => null } }));
    u.config = { ...CONFIG };
    assert.equal(await u.start(), true);
    assert.equal(f.calls.length, 1);
    const args = f.calls[0].args;
    assert.equal(f.calls[0].bundle, APP);
    assert.equal(args[0], `--user-data-dir=${w.paths.profile}`);
    for (const a of AGENT_ARGS) assert.ok(args.includes(a), a);
    assert.ok(args.includes("--disable-backgrounding-occluded-windows"));
    assert.ok(!args.some((a) => /^--(remote-debugging|enable-automation|headless|password-store|enable-unsafe-swiftshader)/.test(a)), "no Linux flag and no debugging flag");
    assert.deepEqual(f.guards, ["begin /Applications/Google Chrome.app", "finish 10000"], "the give-back guard before open, and its end after the start");
    assert.equal(w.named("Xvfb").length, 0, "no Xvfb on the Mac");
    assert.equal(prepared, 0, "no agent package is staged: nothing writes an external extensions file");
    const chrome = w.named("Google Chrome")[0];
    assert.deepEqual(u.chromeId(), { pid: chrome.pid, start: chrome.start });
    assert.ok(u.running());
    assert.equal(u.xDisplay(), null, "no X display");
    assert.deepEqual(u.macApp(), { binary: CHROME_STABLE_BIN, bundle: APP, version: "156.0.8078.80", google: true });
    assert.deepEqual(u.chromeFacts(), { kind: "google-chrome", version: "156.0.8078.80" });
    const r = readRecord(w.paths.unitFile);
    assert.ok(r.kind === "ok");
    assert.equal(r.record.display, null);
    assert.equal(r.record.chrome_pid, chrome.pid);
    assert.equal(r.record.chrome_bin, CHROME_STABLE_BIN);
    assert.ok(existsSync(join(w.paths.profile, "Default", "Preferences")), "the download folder's preferences, in the agent profile");
    // A new service adopts the recorded Chrome (no Xvfb needed); then the stop signals it.
    const u2 = new ChromeUnit(w.deps(new FakeTools(), { mac: fakeMac(w).mac }));
    assert.deepEqual(u2.adopt(), { adopted: true, wanted: true, unreadable: null });
    assert.equal(u2.chromePid(), chrome.pid);
    assert.equal(u2.macApp()?.bundle, APP);
    assert.equal(await u2.stop(), true);
    assert.ok(!w.alive(chrome.pid));
    assert.ok(w.signals.some(([pid, sig]) => Math.abs(pid) === chrome.pid && sig === "SIGTERM"));
    // open fails, or no Chrome comes up on the profile.
    const g = fakeMac(w, { what: ["fail", "none"] });
    const u3 = new ChromeUnit(w.deps(new FakeTools(), { mac: g.mac }));
    u3.config = { ...CONFIG };
    await assert.rejects(u3.start(), (e: Error) => e instanceof StartError && /open exited with 1/.test(e.message));
    const t0 = w.now;
    await assert.rejects(u3.start(), (e: Error) => e instanceof StartError && /did not come up on the agent profile/.test(e.message));
    assert.ok(w.now - t0 >= MAC_FIND_MS);
    assert.deepEqual(g.guards, ["begin /Applications/Google Chrome.app", "finish 0", "begin /Applications/Google Chrome.app", "finish 0"], "a failed start ends its guard at once");
  } finally { w.close(); }
});

test("the Mac's find of the new Chrome (review-145 N5): a root with --type= on the profile (a helper or crash handler that launchd adopted) is no second Chrome; a main process that does not run the app's binary fails the start", async () => {
  const w = new World();
  try {
    let add: (args: string[]) => void = () => {};
    const mac: MacStart = { ...fakeMac(w).mac, open: async (_b, args) => { add(args); return 0; } };
    add = (args) => {
      w.add({ argv: [CHROME_STABLE_BIN, ...args], ppid: 1 });
      w.add({ argv: [`${APP}/Contents/Frameworks/Google Chrome Framework.framework/Versions/156.0.8078.80/Helpers/chrome_crashpad_handler`, "--type=crashpad-handler", ...args.slice(0, 1)], ppid: 1 });
    };
    const u = new ChromeUnit(w.deps(new FakeTools(), { mac }));
    u.config = { ...CONFIG };
    assert.equal(await u.start(), true);
    assert.equal(u.chromePid(), w.named("Google Chrome")[0].pid, "the main process, not the crash handler");
    await u.stop();
    add = (args) => { w.add({ argv: [CHROME_STABLE_BIN, ...args], exe: "/Users/user/bin/not-chrome", ppid: 1 }); };
    const u2 = new ChromeUnit(w.deps(new FakeTools(), { mac }));
    u2.config = { ...CONFIG };
    await assert.rejects(u2.start(), (e: Error) => e instanceof StartError && /does not run \/Applications\/Google Chrome\.app$/.test(e.message));
    assert.equal(u2.chromePid(), null);
  } finally { w.close(); }
});

test("the Mac's app and its folders: never a default user-data folder (also through a link or another case), an app's binary only, the version on disk; open -n -g with an environment of its own", async () => {
  const home = tempDir("ab-mac-home-");
  try {
    const support = join(home, "Library", "Application Support");
    mkdirSync(join(support, "Google", "Chrome"), { recursive: true });
    symlinkSync(join(support, "Google", "Chrome"), join(home, "link"));
    assert.equal(defaultFolderOf(join(support, "Google", "Chrome"), home), join(support, "Google/Chrome"));
    assert.equal(defaultFolderOf(join(support, "Google", "Chrome", "Profile 1"), home), join(support, "Google/Chrome"), "inside one");
    assert.equal(defaultFolderOf(join(home, "link", "x"), home), join(support, "Google/Chrome"), "through a link");
    assert.equal(defaultFolderOf(join(support, "google", "chrome"), home), join(support, "Google/Chrome"), "another case");
    assert.equal(defaultFolderOf(join(support, "Chromium"), home), join(support, "Chromium"));
    assert.equal(defaultFolderOf(join(support, "Google", "Chrome Agent"), home), null, "a sibling with a longer name");
    assert.equal(defaultFolderOf(join(home, ".local", "share", "agentwatch-browser", "profile"), home), null);
    const m = macStart({ state: join(home, "state"), home, exists: (p) => p === CHROME_STABLE_BIN, version: () => "156.0.8078.80" });
    assert.deepEqual(m.app("", join(home, "state", "profile")), { binary: CHROME_STABLE_BIN, bundle: APP, version: "156.0.8078.80", google: true });
    assert.throws(() => m.app("", join(support, "Google", "Chrome")), /default user-data folder/);
    assert.throws(() => m.app("/usr/local/bin/chromium", join(home, "state", "profile")), /names an app's binary/);
    assert.throws(() => m.app("/Applications/Chromium.app/Contents/MacOS/Chromium", join(home, "state", "profile")), /not installed/);
    const none = macStart({ state: home, home, exists: () => false });
    assert.throws(() => none.app("", join(home, "p")), /Google Chrome is not installed/);
    const noVersion = macStart({ state: home, home, exists: () => true, version: () => null });
    assert.throws(() => noVersion.app("", join(home, "p")), /version .* cannot be read/);
    const out = join(home, "open-args.txt"), openBin = join(home, "open");
    writeFileSync(openBin, `#!/bin/sh\nprintf '%s\\n' "$@" > '${out}'\nenv >> '${out}'\n`);
    chmodSync(openBin, 0o700);
    process.env.AB_MAC_TEST_SECRET = "x";
    try { assert.equal(await macStart({ state: home, home, openBin }).open(APP, ["--user-data-dir=/p", "about:blank"]), 0); }
    finally { delete process.env.AB_MAC_TEST_SECRET; }
    const text = readFileSync(out, "utf8");
    assert.ok(text.startsWith(["-n", "-g", "-a", APP, "--args", "--user-data-dir=/p", "about:blank", ""].join("\n")), text);
    assert.ok(!text.includes("AB_MAC_TEST_SECRET"), "no variable of the service goes to open");
    assert.equal(await macStart({ state: home, home }).open(APP, []), null, "under node --test no real open runs");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("the versions of the agent Chrome and of the operator's running Chrome, from their helpers' framework folders", () => {
  const w = new World();
  try {
    const helper = (v: string, type: string) => `${APP}/Contents/Frameworks/Google Chrome Framework.framework/Versions/${v}/Helpers/Google Chrome Helper (${type}).app/Contents/MacOS/Google Chrome Helper (${type})`;
    const app = { binary: CHROME_STABLE_BIN, bundle: APP };
    const agent = w.add({ argv: [CHROME_STABLE_BIN, `--user-data-dir=${w.paths.profile}`], ppid: 1 });
    const operator = w.add({ argv: [CHROME_STABLE_BIN], ppid: 1 });
    assert.deepEqual(chromeVersions(w.procs, app, agent.pid, w.paths.profile), { agent: null, operator: null }, "no helper yet");
    w.add({ argv: [helper("156.0.8078.74", "Renderer"), "--type=renderer"], ppid: agent.pid });
    w.add({ argv: [helper("156.0.8078.80", "GPU"), "--type=gpu-process"], ppid: operator.pid });
    w.add({ argv: [helper("157.0.1.1", "Renderer"), "--type=renderer"], ppid: 1 });
    assert.deepEqual(chromeVersions(w.procs, app, agent.pid, w.paths.profile), { agent: "156.0.8078.74", operator: "156.0.8078.80" });
    w.end(operator.pid);
    const other = w.add({ argv: [CHROME_STABLE_BIN], ppid: 1, uid: w.uid + 1 });
    w.add({ argv: [helper("156.0.8078.99", "GPU"), "--type=gpu-process"], ppid: other.pid });
    assert.deepEqual(chromeVersions(w.procs, app, agent.pid, w.paths.profile), { agent: "156.0.8078.74", operator: null }, "another user's Chrome is not the operator's");
  } finally { w.close(); }
});

test("the give-back watcher runs as the service's child for the running agent Chrome: one for each Chrome, ended at its stop, not started again soon after it ended by itself", async () => {
  const dir = tempDir("ab-mac-watch-");
  const logs: string[] = [];
  let now = 0;
  const stay = new GiveBackWatcher({ bundle: () => APP, state: dir, bin: process.execPath, pre: ["-e", "setInterval(() => {}, 1000)", "--"], clock: () => now, log: (l) => logs.push(l) });
  const exits = (c: any) => new Promise<void>((r) => (c.exitCode !== null || c.signalCode !== null ? r() : c.once("exit", () => r())));
  try {
    stay.tick({ pid: 4000, start: 1 });
    const first = (stay as any).child;
    assert.ok(first?.pid, "it started");
    assert.deepEqual(first.spawnargs.slice(4, 8), ["-l", "JavaScript", "-e", first.spawnargs[7]]);
    assert.deepEqual(first.spawnargs.slice(-4), [APP, "4000", String(process.pid), dir], "the bundle, the agent Chrome's pid, the service's pid and the state folder");
    stay.tick({ pid: 4000, start: 1 });
    assert.equal((stay as any).child, first, "one watcher for one Chrome");
    stay.tick({ pid: 4001, start: 2 });
    await exits(first);
    const second = (stay as any).child;
    assert.notEqual(second, first, "a new Chrome gets a new watcher, and the old one ends");
    stay.tick(null);
    await exits(second);
    assert.equal(stay.running, false, "no Chrome: no watcher");
    const quick = new GiveBackWatcher({ bundle: () => APP, state: dir, bin: process.execPath, pre: ["-e", "process.exit(0)", "--"], clock: () => now, log: (l) => logs.push(l) });
    quick.tick({ pid: 5000, start: 1 });
    await exits((quick as any).child);
    await new Promise((r) => setImmediate(r));
    quick.tick({ pid: 5000, start: 1 });
    assert.equal(quick.running, false, "a watcher that ended while its Chrome runs is not started again at once");
    now += 10 * 60_000;
    quick.tick({ pid: 5000, start: 1 });
    const again = (quick as any).child;
    assert.ok(again, "after WATCH_RETRY_MS it starts again");
    await exits(again);
    quick.stop();
    const off = new GiveBackWatcher({ bundle: () => APP, state: dir, log: () => {} });
    off.tick({ pid: 6000, start: 1 });
    assert.equal(off.running, false, "under node --test no real osascript starts");
  } finally { stay.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("the version change on the Mac (review-145 B1): the agent Chrome starts again only when the operator's running Chrome runs a newer version and the version on disk is newer too, only while no agent's client is connected; an agent ahead never restarts; the restart sends ready", async () => {
  const w = new World();
  try {
    const f = fakeMac(w);
    let versions = { agent: "156.0.8078.74", operator: "156.0.8078.74" }, disk = "156.0.8078.80", clients = true;
    const ticks: unknown[] = [], events: Record<string, unknown>[] = [];
    const part = new UnitPart({
      paths: w.paths, procs: w.procs, tools: new FakeTools(), owner: new Owner(async () => ({ active: "active", sub: "running", mainPid: process.pid }), () => {}), log: (l) => w.logs.push(l),
      endpoint: () => ({ form: "mac" }), sessionsComplete: () => true, activity: { clients: () => clients },
      unit: w.deps(new FakeTools(), { mac: f.mac }),
      mac: { watcher: { tick: (c) => ticks.push(c), stop: () => ticks.push("stop") }, versions: () => versions, disk: () => disk, everyMs: 0 },
    });
    part.attach((ev) => events.push(ev));
    part.onConfig({ enabled: true, chrome_bin: "", chrome_args: [] });
    await part.unit.start();
    const first = part.unit.chromePid();
    const check = () => (part as any).macVersionCheck();
    await check();
    assert.equal(part.unit.chromePid(), first, "the same version: no restart");
    // The operator's Chrome waits for "Relaunch to update" (.74); the agent Chrome started at the version on disk (.80).
    clients = false;
    versions = { agent: "156.0.8078.80", operator: "156.0.8078.74" };
    for (let i = 0; i < 3; i++) await check();
    assert.equal(part.unit.chromePid(), first, "an agent Chrome ahead of the operator's never starts again: no loop");
    versions = { agent: "156.0.8078.9", operator: "156.0.8078.10" };
    disk = "156.0.8078.9";
    await check();
    assert.equal(part.unit.chromePid(), first, "the version on disk is the agent's: a new start would run the same version, so none comes");
    disk = "156.0.8078.80";
    versions = { agent: "156.0.8078.74", operator: "156.0.8078.80" };
    clients = true;
    await check();
    assert.equal(part.unit.chromePid(), first, "an agent's client is connected: it waits");
    // Review-147 note 4: no read of the disk while a client is connected, so the line promises no restart.
    assert.ok(w.logs.some((l) => /newer than the agent Chrome's 156\.0\.8078\.74; when no agent uses it, the service reads the version on disk of .+, and the agent Chrome starts again if that version is newer too$/.test(l)));
    clients = false;
    await check();
    assert.notEqual(part.unit.chromePid(), first, "the operator's relaunch to a newer version: a new agent Chrome");
    assert.ok(!w.alive(first!), "the old one stopped");
    assert.equal(f.calls.length, 2);
    assert.ok(events.some((e) => e.ev === "ready"), "ready goes out");
    assert.equal(part.mover.updateState(), null, "the Mac's app has no update state of the tools folder");
    assert.ok(!events.some((e) => e.ev === "stopped"), "no stopped event: the restart is like a move");
    // After the restart the agent Chrome runs the version on disk, as the operator's: no further restart.
    versions = { agent: "156.0.8078.80", operator: "156.0.8078.80" };
    const second = part.unit.chromePid();
    await check();
    assert.equal(part.unit.chromePid(), second);
    await part.stop();
    assert.ok(ticks.includes("stop"), "the part's stop ends the watcher");
  } finally { w.close(); }
});

test("the version check on Linux (review-145 N1): with no `mac` option it reads nothing, not even the Chrome's pid", async () => {
  const w = new World();
  try {
    const part = new UnitPart({
      paths: w.paths, procs: w.procs, tools: new FakeTools(), owner: new Owner(async () => ({ active: "active", sub: "running", mainPid: process.pid }), () => {}), log: () => {},
      endpoint: () => ({ form: "pidfd" }), sessionsComplete: () => true, unit: w.deps(new FakeTools()),
    });
    let reads = 0;
    const unit = part.unit as any;
    unit.chromePid = () => { reads++; return null; };
    unit.macApp = () => { reads++; return null; };
    await (part as any).macVersionCheck();
    assert.equal(reads, 0);
  } finally { w.close(); }
});

test("board ab-v16.94.35: the stop by use's line on the Mac names Chrome only (the Mac runs no Xvfb); on Linux it names Chrome and Xvfb, word for word as before", async () => {
  for (const mac of [true, false]) {
    const w = new World();
    try {
      const part = new UnitPart({
        paths: w.paths, procs: w.procs, tools: new FakeTools(), owner: new Owner(async () => ({ active: "active", sub: "running", mainPid: process.pid }), () => {}), log: (l) => w.logs.push(l),
        endpoint: () => ({ form: mac ? "mac" : "pidfd" }), sessionsComplete: () => true, clock: () => w.now,
        unit: w.deps(new FakeTools(), mac ? { mac: fakeMac(w).mac } : { displays: { first: 173, last: 175 } }),
        ...(mac ? { mac: { watcher: { tick: () => {}, stop: () => {} }, versions: () => ({ agent: null, operator: null }), disk: () => null } } : {}),
      });
      part.attach(() => {});
      part.onConfig({ enabled: true, chrome_bin: mac ? "" : "/usr/bin/chromium", chrome_args: [] });
      await part.unit.start();
      assert.ok(part.unit.running());
      assert.equal(w.named("Xvfb").length, mac ? 0 : 1, mac ? "no Xvfb on the Mac" : "an Xvfb on Linux");
      w.now += 10 * 60_000;
      await (part as any).idleCheck();
      assert.equal(part.unit.running(), false, "the stop by use ran");
      assert.deepEqual(w.logs.filter((l) => l.startsWith("unit: no agent used the agent browser")), [mac
        ? "unit: no agent used the agent browser for 10 min; stopping Chrome (the profile stays)"
        : "unit: no agent used the agent browser for 10 min; stopping Chrome and Xvfb (the profile stays)"]);
      await part.stop();
    } finally { w.close(); }
  }
});

// ------------------------------------------------------------------ board ab-xxh: the Mac's end of the agent Chrome

const END_WALL = Date.UTC(2026, 10, 26, 19, 46, 13);
/** A unit part on the Mac (or on Linux) for the tests of board ab-xxh: no loops run; a test calls the supervisor's check. */
function endPart(w: World, mac: boolean, o: { what?: string[]; watchMs?: number; superviseMs?: number } = {}) {
  const events: Record<string, any>[] = [];
  const f = fakeMac(w, o.what ? { what: o.what } : {});
  const downs = { n: 0 };
  const part = new UnitPart({
    paths: w.paths, procs: w.procs, tools: new FakeTools(), owner: new Owner(async () => ({ active: "active", sub: "running", mainPid: process.pid }), () => {}), log: (l) => w.logs.push(l),
    endpoint: () => ({ form: mac ? "mac" : "pidfd" }), sessionsComplete: () => true, clock: () => w.now, wall: () => END_WALL + w.now - 1_000_000, usePollMs: 2,
    linkDown: () => { downs.n++; },
    unit: w.deps(new FakeTools(), { nap: (ms) => w.sleep(ms), ...(mac ? { mac: f.mac } : { displays: { first: 173, last: 175 } }) }),
    ...(mac ? { mac: { watcher: { tick: () => {}, stop: () => {} }, versions: () => ({ agent: null, operator: null }), disk: () => null } } : {}),
    ...(o.watchMs !== undefined ? { watchMs: o.watchMs } : {}), ...(o.superviseMs !== undefined ? { superviseMs: o.superviseMs, firstCheckMs: 3_600_000 } : {}),
  });
  part.attach((ev) => events.push(ev));
  part.onConfig({ enabled: true, chrome_bin: mac ? "" : "/usr/bin/chromium", chrome_args: [] });
  const supervise = () => part.unit.superviseOnce((part as any).onUnitEvent);
  return { part, events, calls: f.calls, downs, supervise };
}

test("board ab-xxh: on the Mac the supervisor does not start again a wanted Chrome that ended with no stop of the service (the operator's quit or a crash; also within HEALTHY_MS of its start): `ended`, the record says wanted false, one line with Chrome's age, no failure and no backoff, and no run of such ends gives start_failed; on Linux the supervisor starts it again after the backoff, as before", async () => {
  // The Mac: the facts' end 161 s after the start, an end after HEALTHY_MS, then three ends soon after each start.
  const w = new World();
  try {
    const f = fakeMac(w);
    const u = new ChromeUnit(w.deps(new FakeTools(), { mac: f.mac }));
    u.config = { ...CONFIG };
    const events: UnitEvent[] = [];
    let n = 0;
    for (const lived of [160_000, HEALTHY_MS + 10_000, 1_000, 2_000, 3_000]) {
      await u.start(); // the next use (the part's start at a use calls this)
      n++;
      assert.equal(f.calls.length, n, "one open for each use");
      const pid = u.chromePid()!;
      w.now += lived;
      w.end(pid);
      const t0 = w.now;
      const seen: UnitEvent[] = [];
      await u.superviseOnce((e) => { seen.push(e); events.push(e); });
      assert.deepEqual(seen, [{ kind: "ended" }], "ended, and no ready: nothing starts again");
      assert.equal(w.now, t0, "no backoff");
      assert.equal(f.calls.length, n, "no open: the supervisor starts nothing");
      assert.equal(u.running(), false);
      assert.equal(u.wanted, false, "a stop by use: the unit no longer wants Chrome");
      const r = readRecord(w.paths.unitFile);
      assert.ok(r.kind === "ok" && r.record.wanted === false, "the record says wanted false");
      assert.equal((u as any).failures, 0, "no failure, also for an end soon after the start");
      assert.equal(w.logs.at(-1), `unit: Google Chrome (pid ${pid}) ended with no stop of the service after ${Math.round((lived + 1000) / 1000)} s; on the Mac it starts at the next use`);
      for (let i = 0; i < 3; i++) await u.superviseOnce(() => assert.fail("no event after the end"));
      assert.equal(w.now, t0, "no backoff at a later check either");
      assert.equal(f.calls.length, n, "no later check starts it");
    }
    assert.ok(!events.some((e) => e.kind === "start_failed"), "three ends in a row soon after their starts give no start_failed");
    assert.ok(!w.logs.some((l) => /failed starts in a row|starting it again in/.test(l)));
    // An adopted Chrome (no start time of this service): the line has no age.
    await u.start();
    const u2 = new ChromeUnit(w.deps(new FakeTools(), { mac: fakeMac(w).mac }));
    u2.config = { ...CONFIG };
    assert.equal(u2.adopt().adopted, true);
    const adopted = u2.chromePid()!;
    w.end(adopted);
    await u2.superviseOnce(() => {});
    assert.equal(w.logs.at(-1), `unit: Google Chrome (pid ${adopted}) ended with no stop of the service; on the Mac it starts at the next use`);
    assert.equal(u2.wanted, false);
  } finally { w.close(); }
  // Linux: as before, a wanted Chrome that is gone starts again after the backoff, and an early exit counts as a failure.
  const l = new World();
  try {
    const u = new ChromeUnit(l.deps(new FakeTools(), { displays: { first: 173, last: 175 } }));
    u.config = { ...CONFIG, chromeBin: "/usr/bin/chromium" };
    await u.start();
    const pid = u.chromePid()!;
    l.now += 160_000;
    l.end(pid);
    const t0 = l.now;
    const seen: UnitEvent[] = [];
    await u.superviseOnce((e) => seen.push(e));
    assert.deepEqual(seen, [{ kind: "gone" }, { kind: "ready" }], "gone, then ready after the start again");
    assert.ok(l.now - t0 >= 1000, "the backoff");
    assert.notEqual(u.chromePid(), pid);
    assert.equal(u.wanted, true);
    assert.equal((u as any).failures, 1, "an exit within HEALTHY_MS counts");
    assert.ok(l.logs.includes(`unit: Chromium (pid ${pid}) is gone; starting it again in 1 s`));
    assert.ok(!l.logs.some((x) => x.includes("ended with no stop of the service")), "no Mac line on Linux");
  } finally { l.close(); }
});

test("board ab-xxh: on the Mac the status after such an end is the status of a stop by use (aw-lead): state off with the off texts, chrome_pid null, last_stop idle with no by, one stopped idle event and no start_failed, the link down at once; off already before the supervisor's check; on Linux the status says starting while the supervisor starts Chrome again, and no stopped goes out", async () => {
  for (const mac of [true, false]) {
    const w = new World();
    try {
      const x = endPart(w, mac);
      // A stop of the fail-closed watch before: the end's status must not say failed closed.
      (x.part as any).lastStop = { reason: "receiver_missing", at: "2026-11-26T19:00:00Z", by: null };
      assert.equal(await x.part.wake(() => x.part.unit.running()), null, "a use starts Chrome");
      const pid = x.part.unit.chromePid()!;
      assert.equal(x.part.status().state, "ready");
      const downs = x.downs.n;
      w.now += 160_000;
      w.end(pid); // the operator quits the agent Chrome (Command-Q), or it crashes
      assert.equal(x.part.state(), mac ? "off" : "starting", mac ? "off at once, before the supervisor's check" : "Linux: starting, as before");
      const before = x.events.length;
      await x.supervise();
      const s = x.part.status();
      if (!mac) {
        assert.equal(s.state, "ready", "Linux: the supervisor started Chrome again");
        assert.notEqual(s.chrome_pid, pid);
        assert.ok(!x.events.slice(before).some((e) => e.ev === "stopped"), "Linux: no stopped");
        assert.equal((s.last_stop as any).reason, "receiver_missing", "Linux: last_stop stays");
        continue;
      }
      assert.deepEqual([s.state, s.agent_text, s.operator_text, s.chrome_pid, s.chrome_kind, s.chrome_version, s.extension_version],
        ["off", PartNs.STATE_TEXTS.off.agent_text, PartNs.STATE_TEXTS.off.operator_text, null, null, null, null], "the state and texts of a stop by use");
      assert.deepEqual(s.last_stop, { reason: "idle", at: new Date(END_WALL + w.now - 1_000_000).toISOString().replace(/\.\d{3}Z$/, "Z"), by: null }, "last_stop: idle with no by, as a stop by use");
      assert.deepEqual(x.events.slice(before), [{ t: "ev", ev: "stopped", reason: "idle" }], "one stopped with the reason idle, nothing else");
      assert.equal(x.downs.n, downs + 1, "the gone Chrome's link went down at the end");
      assert.equal(x.part.unit.wanted, false);
      assert.deepEqual(x.part.notes().operator, [], "no sentence of a failed start");
      for (let i = 0; i < 2; i++) await x.supervise();
      assert.equal(x.calls.length, 1, "nothing starts with no use");
      assert.equal(x.part.status().state, "off");
      assert.ok(!x.events.some((e) => e.ev === "stopped" && e.reason === "start_failed"));
    } finally { w.close(); }
  }
});

test("board ab-xxh: on the Mac the next use after such an end starts Chrome (the start at a use, with ready), also a use before the supervisor's check, whose start's line names the end; a request that waits while Chrome ends starts it once, and gets its answer at a second end", async () => {
  const w = new World();
  try {
    const x = endPart(w, true);
    const ready = () => x.part.unit.running();
    assert.equal(await x.part.wake(ready), null);
    let pid = x.part.unit.chromePid()!;
    // (1) After the supervisor's check: the next use starts Chrome, and ready carries its pid.
    w.now += 30_000;
    w.end(pid);
    await x.supervise();
    assert.equal(x.part.state(), "off");
    assert.equal(await x.part.wake(ready), null);
    assert.equal(x.calls.length, 2, "the use started Chrome");
    assert.equal(x.events.filter((e) => e.ev === "ready").at(-1)?.chrome_pid, x.part.unit.chromePid());
    assert.equal(x.part.status().state, "ready");
    // (2) Before the supervisor's check: the use does not wait for a start again that never comes; its start names the end.
    pid = x.part.unit.chromePid()!;
    const startedAt = (x.part.unit as any).chrome.startedAt as number;
    w.now += 45_000;
    w.end(pid);
    const downs = x.downs.n, at = w.now, mark = x.events.length;
    assert.equal(await x.part.wake(ready), null);
    assert.equal(x.calls.length, 3, "the use started Chrome at once");
    // Review M1 and M3: the use's start takes the end by the same rule as the supervisor's check: one stopped idle, then ready.
    assert.deepEqual(x.events.slice(mark).filter((e) => e.ev === "stopped" || e.ev === "ready").map((e) => `${e.ev} ${e.reason ?? e.chrome_pid}`), ["stopped idle", `ready ${x.part.unit.chromePid()}`]);
    assert.ok(w.logs.includes(`unit: Google Chrome (pid ${pid}) ended with no stop of the service after ${Math.round((at - startedAt) / 1000)} s; this start starts it again`), "the start's line names the end");
    assert.equal(x.downs.n, downs + 1, "the gone Chrome's link went down before the new Chrome starts");
    assert.equal(x.part.unit.wanted, true);
    await x.supervise();
    assert.equal(x.calls.length, 3, "the supervisor finds the new Chrome running");
    // (3) A request that waits (its check is not ready) while Chrome ends: it starts Chrome once; at a second end it gets its answer.
    let answered = false;
    const waits = x.part.wake(() => false).then((a) => { answered = true; return a; });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(answered, false, "it waits");
    w.end(x.part.unit.chromePid()!);
    for (let i = 0; i < 500 && x.calls.length < 4; i++) await new Promise((r) => setTimeout(r, 2));
    assert.equal(x.calls.length, 4, "the waiting request started Chrome again once");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(answered, false, "it waits on the new Chrome");
    w.end(x.part.unit.chromePid()!);
    assert.equal(await waits, null, "at the second end its caller's checks run again");
    assert.equal(x.calls.length, 4, "no second start in one wait");
    assert.ok(!x.events.some((e) => e.ev === "stopped" && e.reason === "start_failed"));
  } finally { w.close(); }
});

test("board ab-xxh (review C1): on the Mac an end that no stop caused ends a run of fail-closed stops: after it the next fail-closed stop of a Chrome that a use started sends its stopped again (the reviewer's sequence: receiver_missing, idle, receiver_missing)", async () => {
  const w = new World();
  try {
    const x = endPart(w, true);
    const ready = () => x.part.unit.running();
    const failClosed = () => (x.part as any).failClosed("receiver_missing");
    const stops = () => x.events.filter((e) => e.ev === "stopped").map((e) => e.reason);
    assert.equal(await x.part.wake(ready), null, "a use starts Chrome A");
    assert.equal(await failClosed(), true, "the watch stops A");
    assert.deepEqual(stops(), ["receiver_missing"]);
    w.now += PartNs.FAIL_HOLD_MS + 1000;
    assert.equal(await x.part.wake(ready), null, "after the hold-off a use starts Chrome B");
    w.end(x.part.unit.chromePid()!); // the operator quits B
    await x.supervise();
    assert.deepEqual(stops(), ["receiver_missing", "idle"]);
    assert.equal(await x.part.wake(ready), null, "a use starts Chrome C");
    assert.equal(await failClosed(), true, "the watch stops C");
    assert.deepEqual(stops(), ["receiver_missing", "idle", "receiver_missing"], "the daemon gets the fail-closed stop after the idle");
    assert.equal(x.part.status().state, "failed closed");
  } finally { w.close(); }
});

test("board ab-xxh (review I1): on the Mac a use's start that takes the end before the supervisor's check, and fails, leaves the unit off: the record and the flag say wanted false before the start, the use gets the failed start's 503, and no later check of the supervisor starts Chrome with no use", async () => {
  const w = new World();
  try {
    const x = endPart(w, true, { what: ["ok", "fail"] });
    const ready = () => x.part.unit.running();
    assert.equal(await x.part.wake(ready), null);
    w.now += 30_000;
    w.end(x.part.unit.chromePid()!); // the operator quits; the next use comes before the supervisor's check
    const failed = await x.part.wake(ready);
    assert.match(failed ?? "", /^The agent browser could not get ready: Google Chrome could not start: open exited with 1/);
    assert.equal(x.calls.length, 2);
    assert.equal(x.part.unit.wanted, false, "the unit no longer wants Chrome");
    const r = readRecord(w.paths.unitFile);
    assert.ok(r.kind === "ok" && r.record.wanted === false, "the record says wanted false");
    assert.equal(x.part.state(), "off", "off, as after a failed start at a use on main");
    for (let i = 0; i < 3; i++) await x.supervise();
    assert.equal(x.calls.length, 2, "no check of the supervisor opens Chrome with no use");
    assert.deepEqual(x.events.filter((e) => e.ev === "stopped").map((e) => e.reason), ["idle", "start_failed"]);
  } finally { w.close(); }
});

test("board ab-xxh (review M2): on the Mac an end that no stop caused starts the streak again, also when failed starts of the supervisor came before (a wanted record at the service's start whose Chrome is gone)", async () => {
  const w = new World();
  try {
    const f = fakeMac(w, { what: ["fail", "fail"] });
    const u = new ChromeUnit(w.deps(new FakeTools(), { mac: f.mac }));
    u.config = { ...CONFIG };
    (u as any).wantedFlag = true; // the record wanted Chrome, and the adoption found none
    const events: UnitEvent[] = [];
    await u.superviseOnce((e) => events.push(e));
    await u.superviseOnce((e) => events.push(e));
    assert.equal((u as any).failures, 2, "two failed starts of the supervisor");
    await u.superviseOnce((e) => events.push(e));
    assert.ok(u.running(), "the third start runs Chrome");
    w.now += 10_000;
    w.end(u.chromePid()!);
    await u.superviseOnce((e) => events.push(e));
    assert.deepEqual(events.map((e) => e.kind), ["ready", "ended"]);
    assert.deepEqual([(u as any).failures, (u as any).reported, (u as any).lastFailure], [0, false, ""], "the streak starts again at the end");
  } finally { w.close(); }
});

test("board ab-xxh (review M4): on the Mac the part's watch takes such an end within a second, after the owner rule, with no supervisor's check: the record says wanted false at once, stopped idle goes out, and a service that starts then wants no Chrome", async () => {
  const w = new World();
  const x = endPart(w, true, { watchMs: 5, superviseMs: 3_600_000 });
  try {
    await x.part.begin();
    assert.equal(await x.part.wake(() => x.part.unit.running()), null);
    const calls = x.calls.length;
    w.end(x.part.unit.chromePid()!);
    for (let i = 0; i < 400 && !x.events.some((e) => e.ev === "stopped"); i++) await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(x.events.filter((e) => e.ev === "stopped"), [{ t: "ev", ev: "stopped", reason: "idle" }], "the watch took the end");
    const r = readRecord(w.paths.unitFile);
    assert.ok(r.kind === "ok" && r.record.wanted === false, "the record says wanted false");
    assert.equal(x.part.unit.wanted, false);
    const u2 = new ChromeUnit(w.deps(new FakeTools(), { mac: fakeMac(w).mac }));
    assert.deepEqual(u2.adopt(), { adopted: false, wanted: false, unreadable: null }, "a new service wants no Chrome");
    assert.equal(x.calls.length, calls, "nothing opened Chrome");
  } finally { await x.part.stop(); w.close(); }
});

test("the Mac's versions are a.b.c.d and compare by their numbers (review-145 B1 and N8)", () => {
  assert.ok(macNewer("156.0.8078.100", "156.0.8078.99"), "by numbers, not by text");
  assert.ok(!macNewer("156.0.8078.74", "156.0.8078.80"));
  assert.ok(!macNewer("156.0.8078.80", "156.0.8078.80"));
  assert.ok(macNewer("157.0.1.1", "156.9.9999.9999"));
  assert.ok(!macNewer("157.0.1", "156.0.0.1"), "not a.b.c.d");
  assert.equal(appVersion("/Applications/Google Chrome.app", () => "156.0.8078.80\n"), "156.0.8078.80");
  assert.equal(appVersion("/Applications/Google Chrome.app", () => "156.0"), null, "C12's form only: a.b.c.d");
  assert.equal(appVersion("/Applications/Google Chrome.app", () => "156.0.8078.80.1"), null);
  assert.equal(appVersion("/Applications/Google Chrome.app", () => { throw new Error("no plutil"); }), null);
  let argv: string[] = [];
  appVersion("/Applications/Google Chrome.app", (a) => { argv = a; return "1.2.3.4"; });
  assert.deepEqual(argv, ["/usr/bin/plutil", "-extract", "CFBundleShortVersionString", "raw", "-o", "-", "/Applications/Google Chrome.app/Contents/Info.plist"]);
});

test("service stop --all on the Mac (review-145 B2): its process reads are libSystem's; a libSystem that does not load fails the command; the stop signals the agent Chrome, never the operator's", async () => {
  assert.ok(!((await stopAllProcs("linux")) instanceof MacProcs), "Linux reads /proc");
  const lib = new FakeLib();
  assert.ok((await stopAllProcs("darwin", async () => lib)) instanceof MacProcs);
  await assert.rejects(stopAllProcs("darwin", async () => ({ failed: "dlopen of libSystem failed: x" })), /cannot read the processes on the Mac \(dlopen of libSystem failed: x\), so it stops nothing/);
  const dir = tempDir("ab-mac-stopall-");
  try {
    const paths = unitPaths(join(dir, "state"), join(dir, "tools"));
    mkdirSync(paths.state, { recursive: true });
    lib.add({ pid: 1, ppid: 0, start: 1, argv: ["/sbin/launchd"], uid: 0, other: true });
    lib.add({ pid: 800, ppid: 1, start: 80, argv: [CHROME_STABLE_BIN, `--user-data-dir=${paths.profile}`, "--no-first-run"] });
    lib.add({ pid: 801, ppid: 800, start: 81, argv: [`${APP}/Contents/Frameworks/x/Helpers/h`, "--type=renderer", `--user-data-dir=${paths.profile}`] });
    lib.add({ pid: 900, ppid: 1, start: 90, argv: [CHROME_STABLE_BIN] });
    const signals: [number, string][] = [];
    let now = 0;
    const stopped = await stopAll({
      paths, procs: new MacProcs(lib, { uid: UID, self: 999 }), clock: () => now, sleep: async (ms) => { now += ms; },
      kill: (pid, sig) => { signals.push([pid, sig]); lib.procs.delete(pid); if (pid === 800) lib.procs.delete(801); },
    });
    assert.deepEqual(JSON.parse(JSON.stringify(stopped)), [["Chrome", 800]]);
    assert.deepEqual(signals, [[800, "SIGTERM"]], "only the agent Chrome's root; the operator's Chrome (900) is never signalled");
    assert.ok(lib.procs.has(900));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------ board ab-v16.94.19: the Load-unpacked folder, the watch's hold, the notes of review-145

test("the agent package's folder on the Mac (board ab-v16.94.19): written before each open, in <state>/agent-package (the pinned CRX unpacked); a write logs the folder; a failed write fails the start with no guard and no open", async () => {
  const w = new World();
  try {
    const order: string[] = [], f = fakeMac(w);
    let fail = false, writes = 0, left: string[] | undefined;
    const mac: MacStart = {
      ...f.mac,
      guard: async (b) => { order.push("guard"); return f.mac.guard(b); },
      open: async (b, a) => { order.push("open"); return f.mac.open(b, a); },
      agentPackage: () => {
        order.push("package");
        if (fail) throw Object.assign(new Error("/Users/user/state/agent-package: no space"), { code: "ENOSPC" });
        return { folder: "/Users/user/state/agent-package", version: AGENT_VERSION, written: ++writes === 1, ...(left ? { left } : {}) };
      },
    };
    const u = new ChromeUnit(w.deps(new FakeTools(), { mac }));
    u.config = { ...CONFIG };
    assert.equal(await u.start(), true);
    assert.deepEqual(order, ["package", "guard", "open"], "the folder first, while no agent Chrome runs");
    assert.ok(w.logs.includes(`unit: the agent package ${AGENT_VERSION} is now in /Users/user/state/agent-package; the agent Chrome loads it from there after the operator's one-time "Load unpacked" of that folder`));
    await u.stop();
    const logs = w.logs.length;
    assert.equal(await u.start(), true);
    assert.ok(!w.logs.slice(logs).some((l) => /agent package/.test(l)), "the same files: nothing written, no line");
    await u.stop();
    order.length = 0;
    fail = true;
    await assert.rejects(u.start(), (e: Error) => e instanceof StartError && e.message === "the agent package could not be written for Google Chrome: ENOSPC", "the code only, no path");
    assert.deepEqual(order, ["package"], "no guard and no open");
    // Review-147 note 3 (board ab-v16.94.21): a folder of the swap that could not be removed fails no start; a line names it.
    fail = false;
    left = ["/Users/user/state/.agent-package.0123456789abcdef.old (EBUSY)"];
    assert.equal(await u.start(), true);
    assert.ok(w.logs.includes("unit: a folder of the agent package's swap could not be removed: /Users/user/state/.agent-package.0123456789abcdef.old (EBUSY); the next start tries again"));
    await u.stop();
    // The real dep: the pinned CRX, unpacked into the state folder, with the receiver's ID.
    const real = macStart({ state: w.paths.state });
    assert.deepEqual(real.agentPackage!(), { folder: join(w.paths.state, "agent-package"), version: AGENT_VERSION, written: true });
    assert.equal(folderExtensionId(join(w.paths.state, "agent-package")), RECEIVER_ID);
    assert.equal(real.agentPackage!().written, false);
  } finally { w.close(); }
});

test("the fail-closed watch on the Mac (board ab-v16.94.19): a Chrome with no receiver yet waits up to 5 min for the operator's Load unpacked, and the log and the operator's text name the folder; once a receiver linked, the 60 s rule; with no `mac` the 60 s rule", async () => {
  const w = new World();
  try {
    let ready = false, confirmed = false;
    const events: Record<string, unknown>[] = [];
    const mk = (mac: boolean) => {
      const part = new UnitPart({
        paths: w.paths, procs: w.procs, tools: new FakeTools(), owner: new Owner(async () => ({ active: "active", sub: "running", mainPid: process.pid }), () => {}), log: (l) => w.logs.push(l),
        endpoint: () => ({ form: "mac" }), sessionsComplete: () => true, clock: () => w.now,
        link: { ready: () => ready, confirmed: () => confirmed, busy: () => false, scopesReady: () => false },
        unit: w.deps(new FakeTools(), { mac: fakeMac(w).mac }),
        ...(mac ? { mac: { watcher: { tick: () => {}, stop: () => {} }, versions: () => ({ agent: null, operator: null }), disk: () => null } } : {}),
      });
      part.attach((ev) => events.push(ev));
      part.onConfig({ enabled: true, chrome_bin: "", chrome_args: [] });
      return part;
    };
    assert.deepEqual([LOAD_HOLD_MS, LOAD_NOTE_MS], [300_000, 15_000]);
    const folder = join(w.paths.state, "agent-package");
    const loadText = (p: UnitPart) => p.notes().operator.find((t) => t.startsWith("The agent extension did not connect to the agent Chrome."));
    const part = mk(true);
    await part.unit.start();
    const pid = part.unit.chromePid();
    await part.watch.tick();
    w.now += 14_000;
    await part.watch.tick();
    assert.equal(loadText(part), undefined, "a loaded receiver links within a few seconds: no note yet");
    w.now += 1000;
    await part.watch.tick();
    assert.ok(w.logs.includes(`watch: no agent extension connected to Chrome pid ${pid} in 15 s; ${loadNote(w.paths.state)}; the watch waits up to 300 s for it`));
    assert.equal(loadText(part), `The agent extension did not connect to the agent Chrome. If it is not loaded there yet: in the agent Chrome open chrome://extensions, turn on Developer mode, click Load unpacked and choose the folder ${folder} (Command-Shift-G in that dialog takes a path), then click Details of the agent extension and turn on 'Allow in Incognito'.`);
    assert.equal(part.status().agent_text, "The agent browser is ready.", "the agent's text gets nothing (I2)");
    w.now += 50_000;
    await part.watch.tick();
    assert.equal(part.unit.chromePid(), pid, "past 60 s: the watch still waits for the load");
    w.now += 235_000;
    await part.watch.tick();
    assert.equal(part.unit.running(), false, "after 5 min with no receiver: stopped");
    assert.ok(events.some((e) => e.ev === "stopped" && e.reason === "receiver_missing"));
    assert.equal(part.state(), "failed closed");
    assert.ok(loadText(part), "the failed-closed state names the folder too");
    // Board ab-v16.94.33 (the Mac check B1.3: the stop came at 301 s, and the text said 60 s): the text names the 5 minutes.
    const P = PartNs as Record<string, any>;
    const sixty = P.STATE_TEXTS["failed closed"].operator_text as string;
    assert.match(sixty, /in 60 s/);
    assert.equal(part.status().operator_text, P.FAILED_CLOSED_FIRST_LINK_TEXT, "the text of a stop before the first link");
    assert.match(part.status().operator_text as string, /did not confirm the site lists in 5 minutes, the wait for a new agent Chrome's first link on this Mac/);
    assert.equal(part.status().agent_text, P.STATE_TEXTS["failed closed"].agent_text, "the agent's text stays (I2)");
    // A receiver links on the next Chrome, then goes: the 60 s rule from its last confirm.
    await part.unit.start();
    await part.watch.tick();
    ready = true; confirmed = true;
    await part.watch.tick();
    assert.equal(loadText(part), undefined);
    ready = false; confirmed = false;
    w.now += 61_000;
    await part.watch.tick();
    assert.equal(part.unit.running(), false, "a receiver that linked and went: 60 s");
    assert.equal(loadText(part), undefined, "that Chrome had a receiver: no note");
    assert.equal(part.status().operator_text, sixty, "after a link the 60 s text (board ab-v16.94.33)");
    // With no `mac` (Linux): 60 s and no note.
    const linux = mk(false);
    await linux.unit.start();
    await linux.watch.tick();
    w.now += 61_000;
    const logs = w.logs.length;
    await linux.watch.tick();
    assert.equal(linux.unit.running(), false);
    assert.equal(linux.status().operator_text, sixty, "Linux: the 60 s text (board ab-v16.94.33)");
    assert.ok(!w.logs.slice(logs).some((l) => /no agent extension connected/.test(l)));
    assert.equal(loadText(linux), undefined);
  } finally { w.close(); }
});

test("board ab-v16.116: a receiver that Chrome turned off in the agent profile: on the Mac the operator's text keeps C12's load sentence and adds RECEIVER_OFF_TEXT after it (the watch's 15 s note, the status read every 30 s, the watch's stop), and a send gets the Mac's off text; a new profile keeps today's text; on Linux no text names Load unpacked or Developer mode", async () => {
  const w = new World();
  try {
    let ready = false;
    const mk = (mac: boolean, onRead: () => void) => {
      const part = new UnitPart({
        paths: w.paths, procs: w.procs, tools: new FakeTools(), owner: new Owner(async () => ({ active: "active", sub: "running", mainPid: process.pid }), () => {}), log: (l) => w.logs.push(l),
        endpoint: () => ({ form: "mac" }), sessionsComplete: () => true, clock: () => w.now, useWaitMs: 0,
        link: { ready: () => ready, confirmed: () => ready, busy: () => false, scopesReady: () => false },
        offRead: (p) => { onRead(); return receiverOff(p); },
        unit: w.deps(new FakeTools(), { mac: fakeMac(w).mac }),
        ...(mac ? { mac: { watcher: { tick: () => {}, stop: () => {} }, versions: () => ({ agent: null, operator: null }), disk: () => null } } : {}),
      });
      part.onConfig({ enabled: true, chrome_bin: "", chrome_args: [] });
      return part;
    };
    const LOAD = `The agent extension did not connect to the agent Chrome. If it is not loaded there yet: ${loadNote(w.paths.state)}.`;
    assert.equal(RECEIVER_OFF_TEXT, "Chrome turned the agent extension off in the agent Chrome (Developer mode is off, or a Chrome update removed the extension). Do these Load unpacked steps again, and keep Developer mode on.");
    const secure = join(w.paths.profile, "Default", "Secure Preferences");
    // The stub of 2026-11-24 (temp files only): Chrome 158 kept this entry of the receiver, with no path.
    const stub = { extensions: { settings: { [RECEIVER_ID]: { content_settings: [], disable_reasons: [16777216] } } } };
    const offLines = () => w.logs.filter((l) => /turned the receiver off|is not turned off|holds no entry of the receiver|unknown whether Chrome turned/.test(l));
    let reads = 0;
    const part = mk(true, () => { reads++; });
    // A new profile: the unit's start writes only the service's own keys into Preferences, and no Secure Preferences
    // exists. Before the watch's 15 s note only the read right before the start (board ab-v16.118: no line for a result
    // that is not off).
    await part.unit.start();
    const pid = part.unit.chromePid();
    await part.watch.tick();
    w.now += 14_000;
    await part.watch.tick();
    assert.deepEqual([part.notes().operator, reads], [[], 1]);
    w.now += 1000;
    await part.watch.tick();
    assert.equal(reads, 2, "the watch's note reads");
    assert.deepEqual(offLines(), [`unit: at the watch's 15 s note the profile "profile" holds no entry of the receiver (Chrome pid ${pid})`]);
    assert.ok(w.logs.includes(`watch: no agent extension connected to Chrome pid ${pid} in 15 s; ${loadNote(w.paths.state)}; the watch waits up to 300 s for it`), "the watch's own line stays");
    assert.deepEqual(part.notes(), { agent: [], operator: [LOAD] }, "not off: today's text only");
    assert.equal(reads, 2, "the status read within 30 s of the last read reads nothing");
    // A use's wait that ends with no receiver reads (the same result: no new line).
    assert.equal(await part.wake(() => false), null);
    assert.deepEqual([reads, offLines().length], [3, 1]);
    // Chrome writes the stub some seconds later: the status read 30 s after the last read sees it, with one line.
    mkdirSync(join(w.paths.profile, "Default"), { recursive: true });
    writeFileSync(secure, JSON.stringify(stub));
    w.now += ACCESS_REREAD_MS - 1;
    assert.deepEqual(part.notes().operator, [LOAD]);
    w.now += 1;
    assert.deepEqual(part.notes(), { agent: [], operator: [LOAD, RECEIVER_OFF_TEXT] }, "the off sentence after C12's load sentence; the agent's text gets nothing (I2)");
    assert.deepEqual([reads, offLines().at(-1)], [4, `unit: at the status read Chrome has turned the receiver off in the profile "profile" (Chrome pid ${pid}): disable_reasons 16777216; its entry has no path`]);
    // A send's wait that ends with no receiver: the Mac's off text, and no new line for the same result.
    assert.equal(part.receiverOffText(), RECEIVER_OFF_SEND_TEXT.mac);
    assert.deepEqual([reads, offLines().length], [5, 2]);
    // The watch's stop after 5 minutes with no receiver reads once more; the failed-closed state keeps both sentences.
    w.now += 300_000;
    await part.watch.tick();
    assert.equal(part.unit.running(), false);
    assert.equal(part.state(), "failed closed");
    assert.equal(reads, 6, "the stop's read");
    assert.deepEqual(part.notes().operator, [LOAD, RECEIVER_OFF_TEXT]);
    assert.equal(reads, 6, "no read in the failed-closed state: the stop's read stays");
    assert.equal(part.status().operator_text, (PartNs as Record<string, any>).FAILED_CLOSED_FIRST_LINK_TEXT, "the state's text stays");
    // The operator loads the agent package again (Chrome's entry now has its path and no reason): the next Chrome's
    // note finds it not off, and its receiver links: no load sentence, no off sentence.
    writeFileSync(secure, JSON.stringify({ extensions: { settings: { [RECEIVER_ID]: { path: join(w.paths.state, "agent-package"), location: 4, disable_reasons: [] } } } }));
    await part.unit.start();
    const pid2 = part.unit.chromePid();
    await part.watch.tick();
    w.now += 15_000;
    await part.watch.tick();
    assert.deepEqual(part.notes().operator, [LOAD], "not off: today's text");
    assert.equal(offLines().at(-1), `unit: at the watch's 15 s note the receiver's entry in the profile "profile" is not turned off (Chrome pid ${pid2})`);
    assert.equal(part.receiverOffText(), null, "not off: the send keeps RECEIVER_MISSING_TEXT");
    ready = true;
    await part.watch.tick();
    assert.deepEqual(part.notes().operator, []);
    // A profile file that cannot be read: unknown, never off.
    ready = false;
    writeFileSync(secure, "{not json");
    assert.equal(part.receiverOffText(), null);
    assert.match(offLines().at(-1)!, /^unit: at the end of a send's wait with no receiver it is unknown whether Chrome turned the receiver off \(the profile "profile": Secure Preferences is not a JSON object\)$/);
    await part.stopBrowser(null);
    await part.stop();
    // Linux (no `mac`): Chrome's reason in Preferences (a packed CRX's entry with its path). No operator's sentence
    // names Load unpacked or Developer mode, the watch's stop does not read, and a send gets Linux's off text.
    rmSync(secure);
    writeFileSync(w.paths.preferences, JSON.stringify({ extensions: { settings: { [RECEIVER_ID]: { path: `${RECEIVER_ID}/0.1.0`, location: 1, disable_reasons: [1] } } } }));
    let linuxReads = 0;
    const linux = mk(false, () => { linuxReads++; });
    await linux.unit.start();
    const lpid = linux.unit.chromePid();
    await linux.watch.tick();
    w.now += 15_000;
    await linux.watch.tick();
    assert.equal(await linux.wake(() => false), null);
    assert.deepEqual([linux.notes().operator, linuxReads], [[], 1], "Linux: no note, and no read at the note or a use's wait (only the read right before the start, board ab-v16.118)");
    // A send's wait that ends while Chrome runs: Linux's off text, and the line names that Chrome.
    assert.equal(linux.receiverOffText(), RECEIVER_OFF_SEND_TEXT.linux);
    assert.equal(RECEIVER_OFF_SEND_TEXT.linux, "The agent extension of the agent browser is turned off in the agent Chrome.");
    assert.equal(offLines().at(-1), `unit: at the end of a send's wait with no receiver Chrome has turned the receiver off in the profile "profile" (Chrome pid ${lpid}): disable_reasons 1`);
    w.now += 46_000;
    await linux.watch.tick();
    assert.equal(linux.unit.running(), false, "the 60 s rule");
    assert.equal(linuxReads, 2, "Linux: no read at the watch's stop");
    // After the stop (no Chrome runs): the same text; its line names no pid.
    const texts = [...linux.notes().operator, linux.status().operator_text as string, linux.receiverOffText()!];
    assert.equal(texts.at(-1), RECEIVER_OFF_SEND_TEXT.linux);
    for (const t of texts) assert.ok(!/Load unpacked|Developer mode|developer mode/.test(t), t);
    assert.equal(offLines().at(-1), `unit: at the end of a send's wait with no receiver Chrome has turned the receiver off in the profile "profile": disable_reasons 1`);
    writeFileSync(w.paths.preferences, JSON.stringify({ extensions: { settings: { [RECEIVER_ID]: { path: `${RECEIVER_ID}/0.1.0`, location: 1, disable_reasons: [] } } } }));
    assert.equal(linux.receiverOffText(), null);
    await linux.stop();
  } finally { w.close(); }
});

test("board ab-v16.116, review M1, M2 and M4: on the Mac the latest off read decides the sentences, whichever Chrome it was for and also with no Chrome, until a receiver links again; a receiver that linked and then went off gets them at its send; the sentence after the load sentence follows the reason", async () => {
  const w = new World();
  try {
    let ready = false;
    const part = new UnitPart({
      paths: w.paths, procs: w.procs, tools: new FakeTools(), owner: new Owner(async () => ({ active: "active", sub: "running", mainPid: process.pid }), () => {}), log: (l) => w.logs.push(l),
      endpoint: () => ({ form: "mac" }), sessionsComplete: () => true, clock: () => w.now,
      link: { ready: () => ready, confirmed: () => ready, busy: () => false, scopesReady: () => false },
      unit: w.deps(new FakeTools(), { mac: fakeMac(w).mac }),
      mac: { watcher: { tick: () => {}, stop: () => {} }, versions: () => ({ agent: null, operator: null }), disk: () => null },
    });
    part.onConfig({ enabled: true, chrome_bin: "", chrome_args: [] });
    const LOAD = `The agent extension did not connect to the agent Chrome. If it is not loaded there yet: ${loadNote(w.paths.state)}.`;
    const secure = join(w.paths.profile, "Default", "Secure Preferences");
    const put = (e: object) => { mkdirSync(join(w.paths.profile, "Default"), { recursive: true }); writeFileSync(secure, JSON.stringify({ extensions: { settings: { [RECEIVER_ID]: e } } })); };
    const loaded = { path: join(w.paths.state, "agent-package"), location: 4 };
    // M4: the sentence after the load sentence follows the reason.
    const OTHER = "Chrome lists the agent extension as turned off in the agent Chrome (disable reason 1): in chrome://extensions turn it on; if Chrome does not list it, do these Load unpacked steps again.";
    assert.equal(receiverOffNote([16777216]), RECEIVER_OFF_TEXT);
    assert.equal(receiverOffNote([1, 16777216]), RECEIVER_OFF_TEXT, "the developer mode reason among others");
    assert.equal(receiverOffNote([1]), OTHER);
    assert.equal(receiverOffNote([1, 4096]), "Chrome lists the agent extension as turned off in the agent Chrome (disable reasons 1, 4096): in chrome://extensions turn it on; if Chrome does not list it, do these Load unpacked steps again.");
    // M1: a receiver links on the Chrome K1 (no load sentence: awaitsLoad is false after a link), then developer mode goes
    // off: Chrome disables the receiver at once (reason 16777216, the path stays), and its link drops.
    put(loaded);
    await part.unit.start();
    await part.watch.tick();
    ready = true;
    await part.watch.tick();
    assert.deepEqual(part.notes().operator, []);
    put({ ...loaded, disable_reasons: [16777216] });
    ready = false;
    await part.watch.tick();
    assert.deepEqual(part.notes().operator, [], "no read yet: the watch's note comes only for a Chrome with no link");
    // The send's wait ends with no receiver: its read says off, and the pane gives the steps that the send text names.
    assert.equal(part.receiverOffText(), RECEIVER_OFF_SEND_TEXT.mac);
    assert.deepEqual(part.notes(), { agent: [], operator: [LOAD, RECEIVER_OFF_TEXT] });
    // M4: another reason gives the general sentence.
    put({ ...loaded, disable_reasons: [1] });
    w.now += ACCESS_REREAD_MS;
    assert.deepEqual(part.notes().operator, [LOAD, OTHER], "the status read every 30 s while the latest read says off");
    // The operator turns it on again: the receiver links, and the link-up clears the latest read.
    put(loaded);
    ready = true;
    assert.deepEqual(part.notes().operator, []);
    ready = false;
    assert.deepEqual(part.notes().operator, [], "cleared: no sentence until a new read says off");
    // M2: the watch stops K1 (60 s after its last confirm) with the profile off: the stop's read. Then a send's read with
    // no Chrome, still off: the sentences stay. A not-off read takes them away.
    put({ ...loaded, disable_reasons: [16777216] });
    w.now += 61_000;
    await part.watch.tick();
    assert.equal(part.unit.running(), false);
    assert.equal(part.state(), "failed closed");
    assert.match(w.logs.at(-1) ?? "", /^unit: at the watch's stop Chrome has turned the receiver off in the profile "profile" \(Chrome pid \d+\): disable_reasons 16777216$/);
    assert.deepEqual(part.notes().operator, [LOAD, RECEIVER_OFF_TEXT], "the stop's read, with no Chrome and after a link on K1");
    assert.equal(part.receiverOffText(), RECEIVER_OFF_SEND_TEXT.mac);
    assert.equal(w.logs.at(-1), `unit: at the end of a send's wait with no receiver Chrome has turned the receiver off in the profile "profile": disable_reasons 16777216`);
    assert.deepEqual(part.notes().operator, [LOAD, RECEIVER_OFF_TEXT], "a later read for no Chrome that still says off keeps them");
    put(loaded);
    assert.equal(part.receiverOffText(), null);
    assert.deepEqual(part.notes().operator, [], "a not-off read takes them away");
    // The latest read decides also for the next Chrome: the stop's read of K1 says off, and the next Chrome K2 reads again
    // at its first status read.
    put({ ...loaded, disable_reasons: [16777216] });
    assert.equal(part.receiverOffText(), RECEIVER_OFF_SEND_TEXT.mac);
    await part.unit.start();
    await part.watch.tick();
    put(loaded);
    assert.deepEqual(part.notes().operator, [], "K2's first status read finds it on");
    await part.stopBrowser(null);
    await part.stop();
  } finally { w.close(); }
});

// Board ab-v16.118: C12's `receiver_off` (the event and the status field) and the Mac's log line of the guarded settings
// at a Chrome version change. A Mac part on the fake world, with its events; its wall clock starts at 2026-11-24 12:00 UTC.
const OFF_WALL = Date.UTC(2026, 10, 24, 12, 0, 0);
function offPart(w: World, o: { ready?: () => boolean; version?: string; offRead?: typeof receiverOff; guard?: () => void } = {}) {
  const events: Record<string, any>[] = [];
  const fm = fakeMac(w, o.version ? { version: o.version } : {}).mac;
  const mac: MacStart = o.guard ? { ...fm, guard: async (bundle) => { o.guard!(); return fm.guard(bundle); } } : fm;
  const part = new UnitPart({
    paths: w.paths, procs: w.procs, tools: new FakeTools(), owner: new Owner(async () => ({ active: "active", sub: "running", mainPid: process.pid }), () => {}), log: (l) => w.logs.push(l),
    endpoint: () => ({ form: "mac" }), sessionsComplete: () => true, clock: () => w.now, wall: () => OFF_WALL + w.now - 1_000_000, useWaitMs: 0,
    link: { ready: () => o.ready?.() ?? false, confirmed: () => o.ready?.() ?? false, busy: () => false, scopesReady: () => false },
    ...(o.offRead ? { offRead: o.offRead } : {}),
    unit: w.deps(new FakeTools(), { mac }),
    mac: { watcher: { tick: () => {}, stop: () => {} }, versions: () => ({ agent: null, operator: null }), disk: () => null },
    watchMs: 5, superviseMs: 3_600_000, firstCheckMs: 3_600_000,
  });
  part.attach((ev) => events.push(ev));
  part.onConfig({ enabled: true, chrome_bin: "", chrome_args: [] });
  return { part, events, offs: () => events.filter((e) => e.ev === "receiver_off") };
}
const offAt = (w: World) => new Date(OFF_WALL + w.now - 1_000_000).toISOString().replace(/\.\d{3}Z$/, "Z");

test("board ab-v16.118: on the Mac C12's receiver_off goes out once for each agent Chrome at its first off read (the watch's 15 s note here), not again at a later off read of that Chrome, again after a link-up or a not-off read, at a read with no Chrome only when the off state begins (review M1), never at an unknown read; a profile that is off before a start sends it at the read right before the start, with chrome_pid null; status gives receiver_off while the latest read says off, else null", async () => {
  const w = new World();
  try {
    let ready = false;
    const { part, offs } = offPart(w, { ready: () => ready });
    const LOAD = `The agent extension did not connect to the agent Chrome. If it is not loaded there yet: ${loadNote(w.paths.state)}.`;
    const secure = join(w.paths.profile, "Default", "Secure Preferences");
    const put = (e: object) => { mkdirSync(join(w.paths.profile, "Default"), { recursive: true }); writeFileSync(secure, JSON.stringify({ extensions: { settings: { [RECEIVER_ID]: e } } })); };
    // The stub of 2026-11-24 (temp files only), and a loaded receiver.
    const STUB = { content_settings: [], disable_reasons: [16777216] };
    const loaded = { path: join(w.paths.state, "agent-package"), location: 4 };
    const ev = (reasons: number[], chrome_pid: number | null) => ({ t: "ev", ev: "receiver_off", reason: reasons.includes(16777216) ? "developer_mode" : "other", reasons, chrome_pid });
    // A new profile: the read right before the start finds no entry of the receiver: no event, and receiver_off is null.
    await part.unit.start();
    const pid = part.unit.chromePid()!;
    assert.deepEqual([offs(), part.status().receiver_off], [[], null]);
    // Chrome writes the stub after its start: the watch's 15 s note reads it, and exactly one event goes out.
    put(STUB);
    await part.watch.tick();
    w.now += 15_000;
    await part.watch.tick();
    assert.deepEqual(offs(), [ev([16777216], pid)]);
    assert.deepEqual(Object.keys(offs()[0]).sort(), ["chrome_pid", "ev", "reason", "reasons", "t"], "the event's fields only");
    const at = offAt(w);
    assert.match(at, /^2026-11-24T12:00:\d\dZ$/, "last_stop's form: UTC, ISO 8601, whole seconds");
    assert.deepEqual(part.status().receiver_off, { reason: "developer_mode", reasons: [16777216], chrome_pid: pid, at });
    assert.equal(part.status().last_stop, null);
    // A second off read of the same Chrome (a send's wait), and the status read 30 s later with one more reason: no second
    // event; the field follows the latest off read.
    assert.equal(part.receiverOffText(), RECEIVER_OFF_SEND_TEXT.mac);
    put({ ...STUB, disable_reasons: [16777216, 1] });
    w.now += ACCESS_REREAD_MS;
    assert.deepEqual(part.notes().operator, [LOAD, RECEIVER_OFF_TEXT]);
    assert.equal(offs().length, 1, "one event for the Chrome");
    assert.deepEqual(part.status().receiver_off, { reason: "developer_mode", reasons: [16777216, 1], chrome_pid: pid, at: offAt(w) });
    // An unknown read sends nothing and changes neither the event's state nor the field.
    writeFileSync(secure, "{not json");
    assert.equal(part.receiverOffText(), null);
    assert.equal(offs().length, 1);
    assert.deepEqual((part.status().receiver_off as { reasons: number[] } | null)?.reasons, [16777216, 1]);
    put(STUB);
    assert.equal(part.receiverOffText(), RECEIVER_OFF_SEND_TEXT.mac);
    assert.equal(offs().length, 1, "after an unknown read the same Chrome's off read sends no second event");
    // A link-up ends the state: status gives null; the next off read of the same Chrome (here the status read after the
    // link went down: the load sentence applies) sends a new event; a send's read after it sends none.
    ready = true;
    assert.equal(part.status().receiver_off, null, "a link-up clears it");
    assert.equal(offs().length, 1);
    ready = false;
    assert.deepEqual(part.status().receiver_off, { reason: "developer_mode", reasons: [16777216], chrome_pid: pid, at: offAt(w) }, "the status read after the link-up");
    assert.equal(part.receiverOffText(), RECEIVER_OFF_SEND_TEXT.mac);
    assert.deepEqual(offs(), [ev([16777216], pid), ev([16777216], pid)]);
    // A read that says not off ends it too; a new off read after it sends a new event.
    put(loaded);
    assert.equal(part.receiverOffText(), null);
    assert.equal(part.status().receiver_off, null, "a not-off read clears it");
    put({ ...loaded, disable_reasons: [1] });
    assert.equal(part.receiverOffText(), RECEIVER_OFF_SEND_TEXT.mac);
    assert.deepEqual(offs().at(-1), ev([1], pid), "another reason: other");
    assert.equal(offs().length, 3);
    // No Chrome runs (review M1): while the off state goes on from K1's event, a read with no Chrome sends nothing; the
    // field follows it. After a clear, the off state begins at a read with no Chrome: one event (chrome_pid null), and
    // none at the next read.
    await part.stopBrowser(null);
    put(STUB);
    assert.equal(part.receiverOffText(), RECEIVER_OFF_SEND_TEXT.mac);
    assert.equal(offs().length, 3, "the off state goes on: no event at a read with no Chrome");
    assert.deepEqual(part.status().receiver_off, { reason: "developer_mode", reasons: [16777216], chrome_pid: null, at: offAt(w) });
    put(loaded);
    assert.equal(part.receiverOffText(), null);
    put(STUB);
    assert.equal(part.receiverOffText(), RECEIVER_OFF_SEND_TEXT.mac);
    assert.equal(part.receiverOffText(), RECEIVER_OFF_SEND_TEXT.mac);
    assert.deepEqual(offs().slice(3), [ev([16777216], null)], "the off state begins with no Chrome: one event");
    // The profile is off before the next start: the read right before it sends the event at once (chrome_pid null), with its
    // log line, and the operator's sentences show; the new Chrome's own reads (the status read, the 15 s note) send no second one.
    w.logs.length = 0;
    await part.unit.start();
    const pid2 = part.unit.chromePid()!;
    assert.notEqual(pid2, pid);
    assert.deepEqual(offs().slice(4), [ev([16777216], null)], "the event of the read right before the start");
    assert.ok(w.logs.includes(`unit: at the read before a start Chrome has turned the receiver off in the profile "profile": disable_reasons 16777216; its entry has no path`));
    assert.deepEqual(part.notes().operator, [LOAD, RECEIVER_OFF_TEXT], "the pane's sentences");
    assert.deepEqual(part.status().receiver_off, { reason: "developer_mode", reasons: [16777216], chrome_pid: pid2, at: offAt(w) }, "the new Chrome's status read");
    await part.watch.tick();
    w.now += 15_000;
    await part.watch.tick();
    assert.equal(part.receiverOffText(), RECEIVER_OFF_SEND_TEXT.mac);
    assert.equal(offs().length, 5, "one event for the Chrome of that start");
    // An unknown read never sends it: not before a start, not at the 15 s note, not at a send.
    put(loaded);
    assert.equal(part.receiverOffText(), null);
    await part.stopBrowser(null);
    writeFileSync(secure, "{not json");
    await part.unit.start();
    await part.watch.tick();
    w.now += 15_000;
    await part.watch.tick();
    assert.equal(part.receiverOffText(), null);
    assert.equal(offs().length, 5, "no event at an unknown read");
    assert.equal(part.status().receiver_off, null);
    assert.ok(w.logs.includes(`unit: at the read before a start it is unknown whether Chrome turned the receiver off (the profile "profile": Secure Preferences is not a JSON object)`));
    await part.stopBrowser(null);
    await part.stop();
  } finally { w.close(); }
});

test("board ab-v16.118: receiver_off's reasons are at most 8 integers, the first 8 of Chrome's values that are integers greater than 0; reason is developer_mode when any value is 16777216, also past the first 8 (review M6)", async () => {
  const w = new World();
  try {
    let reasons: number[] = [];
    const { part, offs } = offPart(w, { offRead: () => ({ off: true, reasons, noPath: true }) });
    reasons = [1, 2, 4, 8, 16, 32, 64, 128, 256, 16777216];
    await part.unit.start();
    const pid = part.unit.chromePid()!;
    assert.deepEqual(offs(), [{ t: "ev", ev: "receiver_off", reason: "developer_mode", reasons: [1, 2, 4, 8, 16, 32, 64, 128], chrome_pid: null }], "the first 8; 16777216 is the tenth, and reason comes from all of them");
    assert.deepEqual(part.status().receiver_off, { reason: "developer_mode", reasons: [1, 2, 4, 8, 16, 32, 64, 128], chrome_pid: pid, at: offAt(w) }, "the status read of the running Chrome");
    reasons = [1, 2, 4, 8, 16, 32, 64, 128, 256];
    w.now += ACCESS_REREAD_MS;
    assert.deepEqual(part.status().receiver_off, { reason: "other", reasons: [1, 2, 4, 8, 16, 32, 64, 128], chrome_pid: pid, at: offAt(w) }, "no 16777216: other");
    reasons = [-1, 1.5, 16777216, 3];
    assert.equal(part.receiverOffText(), RECEIVER_OFF_SEND_TEXT.mac);
    assert.deepEqual(part.status().receiver_off, { reason: "developer_mode", reasons: [16777216, 3], chrome_pid: pid, at: offAt(w) }, "integers greater than 0 only");
    await part.stopBrowser(null);
    await part.stop();
  } finally { w.close(); }
});

test("board ab-v16.118 (review I1.2): a send's read while a start runs, after the read right before that start (no Chrome runs yet), sends no event, and the Chrome of that start gets no second event at its status read or its 15 s note", async () => {
  const w = new World();
  try {
    let during: string | null | undefined;
    const box: { part?: UnitPart } = {};
    const { part, offs } = offPart(w, { guard: () => { during = box.part!.receiverOffText(); } });
    box.part = part;
    mkdirSync(join(w.paths.profile, "Default"), { recursive: true, mode: 0o700 });
    writeFileSync(join(w.paths.profile, "Default", "Secure Preferences"), JSON.stringify({ extensions: { settings: { [RECEIVER_ID]: { content_settings: [], disable_reasons: [16777216] } } } }));
    await part.unit.start();
    const pid = part.unit.chromePid()!;
    assert.equal(during, RECEIVER_OFF_SEND_TEXT.mac, "the send's read between the read right before the start and the Chrome says off");
    const one = [{ t: "ev", ev: "receiver_off", reason: "developer_mode", reasons: [16777216], chrome_pid: null }];
    assert.deepEqual(offs(), one);
    // The Chrome of that start: its status read and its 15 s note say off; no second event.
    assert.equal(part.notes().operator.at(-1), RECEIVER_OFF_TEXT);
    assert.deepEqual(part.status().receiver_off, { reason: "developer_mode", reasons: [16777216], chrome_pid: pid, at: offAt(w) });
    await part.watch.tick();
    w.now += 15_000;
    await part.watch.tick();
    w.now += ACCESS_REREAD_MS;
    part.status();
    assert.deepEqual(offs(), one, "one event for the Chrome of that start");
    await part.stopBrowser(null);
    await part.stop();
  } finally { w.close(); }
});

test("board ab-v16.118 (review I1.3): on the Mac the watch's stop read of a Chrome whose receiver linked and then went off sends that Chrome's first event, with its pid; when that Chrome already had its event, the stop read sends no second one", async () => {
  const w = new World();
  try {
    let ready = false;
    const { part, offs } = offPart(w, { ready: () => ready });
    const secure = join(w.paths.profile, "Default", "Secure Preferences");
    const put = (e: object) => { mkdirSync(join(w.paths.profile, "Default"), { recursive: true, mode: 0o700 }); writeFileSync(secure, JSON.stringify({ extensions: { settings: { [RECEIVER_ID]: e } } })); };
    const loaded = { path: join(w.paths.state, "agent-package"), location: 4 };
    const ev = (pid: number) => ({ t: "ev", ev: "receiver_off", reason: "developer_mode", reasons: [16777216], chrome_pid: pid });
    // A receiver links on K1; then developer mode goes off while K1 runs: no read comes before the watch's stop (the
    // load sentence does not apply after a link, and the latest read is not off).
    const linkThenOff = async () => {
      put(loaded);
      await part.unit.start();
      const pid = part.unit.chromePid()!;
      await part.watch.tick();
      ready = true;
      await part.watch.tick();
      put({ ...loaded, disable_reasons: [16777216] });
      ready = false;
      await part.watch.tick();
      return pid;
    };
    const pid1 = await linkThenOff();
    assert.equal(part.watch.awaitsLoad(), false);
    assert.deepEqual(offs(), []);
    w.now += 61_000;
    await part.watch.tick();
    assert.equal(part.unit.running(), false, "the 60 s rule after a link");
    assert.deepEqual(offs(), [ev(pid1)], "the stop read: K1's first event");
    // K2: the same, but a send's read sends K2's event while it runs; the stop read then sends none.
    const pid2 = await linkThenOff();
    assert.equal(part.receiverOffText(), RECEIVER_OFF_SEND_TEXT.mac);
    assert.deepEqual(offs(), [ev(pid1), ev(pid2)]);
    w.now += 61_000;
    await part.watch.tick();
    assert.equal(part.unit.running(), false);
    assert.ok(w.logs.some((l) => l.startsWith("unit: at the watch's stop Chrome has turned the receiver off")), "the stop read ran");
    assert.deepEqual(offs(), [ev(pid1), ev(pid2)], "no second event for K2");
    await part.stop();
  } finally { w.close(); }
});

test("board ab-v16.118 (review M4): on the Mac the unit's step right before a start comes after its write of Preferences and of the agent package's folder, and before the give-back guard and open", async () => {
  const w = new World();
  try {
    const order: string[] = [];
    let prefsWritten = false;
    const f = fakeMac(w);
    const mac: MacStart = {
      ...f.mac,
      agentPackage: () => { order.push("package"); return { folder: join(w.paths.state, "agent-package"), version: "0.3.15", written: false }; },
      guard: async (bundle) => { order.push("guard"); return f.mac.guard(bundle); },
      open: async (bundle, args) => { order.push("open"); return f.mac.open(bundle, args); },
    };
    const u = new ChromeUnit(w.deps(new FakeTools(), {
      mac,
      beforeChrome: (version) => {
        order.push(`step ${version}`);
        prefsWritten = JSON.parse(readFileSync(w.paths.preferences, "utf8")).extensions?.settings?.[RECEIVER_ID]?.incognito === true;
      },
    }));
    u.config = { ...CONFIG };
    assert.equal(await u.start(), true);
    assert.deepEqual(order, ["package", "step 156.0.8078.80", "guard", "open"]);
    assert.equal(prefsWritten, true, "after the write of Preferences");
    await u.stop();
  } finally { w.close(); }
});

test("board ab-v16.118 (review M5): the second line of a version change belongs to the Chrome of that start: when that Chrome stops before its 15 s, no line comes for it, and the next Chrome never logs it with its own pid", async () => {
  const w = new World();
  const b = offPart(w, { version: "158.0.8127.37" });
  try {
    const lastFile = join(w.paths.profile, "Last Version");
    const lines = () => w.logs.filter((l) => l.includes("the guarded settings at a Chrome version change"));
    const until = async (f: () => boolean) => { for (let i = 0; i < 2000 && !f(); i++) await new Promise((r) => setTimeout(r, 5)); assert.ok(f()); };
    await b.part.begin();
    mkdirSync(w.paths.profile, { recursive: true, mode: 0o700 });
    writeFileSync(lastFile, "157.0.8103.79\n");
    assert.deepEqual(await b.part.startBrowser(null), { data: {} });
    assert.equal(lines().length, 1, "the line before the start");
    // The loop ties the line to this Chrome; the Chrome stops before its 15 s.
    await until(() => b.part.watch.missingFor() !== null);
    await b.part.stopBrowser(null);
    w.now += 15_000;
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(lines().length, 1, "no line for the stopped Chrome");
    // Chrome wrote Last Version at that start: the next start is no version change, and its Chrome gets no line.
    writeFileSync(lastFile, "158.0.8127.37\n");
    assert.deepEqual(await b.part.startBrowser(null), { data: {} });
    await until(() => b.part.watch.missingFor() !== null);
    const mark = w.logs.length;
    w.now += 15_000;
    await until(() => w.logs.slice(mark).some((l) => l.startsWith("watch: no agent extension connected")));
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(lines().length, 1, "no line with the next Chrome's pid");
    await b.part.stopBrowser(null);
  } finally { await b.part.stop(); w.close(); }
});

test("board ab-v16.118: on the Mac a start whose Chrome version differs from the profile's Last Version logs the guarded settings of the two pref files before the start and again 15 s after it (at the watch's note, or from the part's loop when a receiver linked); the same version, or no Last Version, logs no line; the line names no path but the profile folder's name and no MAC value", async () => {
  const w = new World();
  try {
    const { part } = offPart(w, { version: "158.0.8127.37" });
    const secure = join(w.paths.profile, "Default", "Secure Preferences");
    const lastFile = join(w.paths.profile, "Last Version");
    const lines = () => w.logs.filter((l) => l.includes("the guarded settings at a Chrome version change"));
    // No Last Version (a new profile), then the same version as Last Version: no line.
    await part.unit.start();
    await part.stopBrowser(null);
    writeFileSync(lastFile, "158.0.8127.37\n");
    await part.unit.start();
    await part.watch.tick();
    w.now += 15_000;
    await part.watch.tick();
    assert.deepEqual(lines(), []);
    await part.stopBrowser(null);
    // Chrome 158 on disk, and the profile last ran 157 (made-up MAC values: they never reach the log).
    writeFileSync(lastFile, "157.0.8103.79\n");
    const protection = { macs: { extensions: { ui: { developer_mode: "MACVALUE0001" } } }, super_mac: "MACVALUE0002" };
    mkdirSync(join(w.paths.profile, "Default"), { recursive: true });
    writeFileSync(secure, JSON.stringify({ protection, extensions: { ui: { developer_mode: true }, settings: { [RECEIVER_ID]: { path: join(w.paths.state, "agent-package"), location: 4, disable_reasons: [] } } } }));
    await part.unit.start();
    const pid = part.unit.chromePid()!;
    const HEAD = `unit: the guarded settings at a Chrome version change (Chrome 158.0.8127.37, the profile "profile" last ran 157.0.8103.79)`;
    const PREFS = `Preferences: developer mode absent, preference_reset_time absent, the receiver's entry has no path and disable_reasons absent`;
    assert.deepEqual(lines(), [`${HEAD}, before the start: Secure Preferences: developer mode true, preference_reset_time absent, the receiver's entry has a path and disable_reasons []; ${PREFS}`]);
    // Chrome resets the guarded settings at that start (the 2026-11-24 case): the watch's 15 s note logs them again, once.
    writeFileSync(secure, JSON.stringify({ protection, prefs: { preference_reset_time: "13439996385877204" }, extensions: { settings: { [RECEIVER_ID]: { content_settings: [], disable_reasons: [16777216] } } } }));
    await part.watch.tick();
    w.now += 14_000;
    await part.watch.tick();
    assert.equal(lines().length, 1);
    w.now += 1000;
    await part.watch.tick();
    assert.deepEqual(lines().slice(1), [`${HEAD}, 15 s after the start (Chrome pid ${pid}): Secure Preferences: developer mode absent, preference_reset_time 13439996385877204 (2026-11-24T12:19:45Z), the receiver's entry has no path and disable_reasons [16777216]; ${PREFS}`]);
    w.now += 15_000;
    await part.watch.tick();
    assert.equal(lines().length, 2, "once for the start");
    for (const l of lines()) assert.ok(!l.includes(w.dir) && !l.includes("/") && !l.includes("MACVALUE"), l);
    await part.stopBrowser(null);
    await part.stop();
    // A receiver that links before the watch's note (the extension stayed on): the part's loop logs the line 15 s after the start.
    let ready = false;
    const b = offPart(w, { version: "158.0.8127.37", ready: () => ready });
    const mark = w.logs.length;
    try {
      await b.part.begin();
      writeFileSync(secure, JSON.stringify({ protection, extensions: { ui: { developer_mode: true }, settings: { [RECEIVER_ID]: { path: join(w.paths.state, "agent-package"), location: 4, disable_reasons: [] } } } }));
      assert.deepEqual(await b.part.startBrowser(null), { data: {} });
      ready = true;
      assert.equal(lines().length, 3, "the line before the start");
      const until = async (f: () => boolean) => { for (let i = 0; i < 2000 && !f(); i++) await new Promise((r) => setTimeout(r, 5)); assert.ok(f()); };
      // The loop sees the new Chrome first (its watch count, then the same loop step binds the line to it), then 15 s
      // pass on the part's clock.
      await until(() => b.part.watch.missingFor() !== null);
      assert.equal(lines().length, 3);
      w.now += 15_000;
      await until(() => lines().length === 4);
      assert.equal(lines()[3], `${HEAD}, 15 s after the start (Chrome pid ${b.part.unit.chromePid()}): Secure Preferences: developer mode true, preference_reset_time absent, the receiver's entry has a path and disable_reasons []; ${PREFS}`);
      assert.ok(!w.logs.slice(mark).some((l) => l.startsWith("watch: no agent extension connected")), "no watch note: the receiver linked");
      await b.part.stopBrowser(null);
    } finally { await b.part.stop(); }
  } finally { w.close(); }
});

test("board ab-v16.94.34: the Mac's first-link text names the incognito switch after the load, so one sitting does both; on the Mac a missing access with no entry of the receiver in either file (Chrome drops the service's write there) names the operator's 'Allow in Incognito' for the incognito access and the service's step for the access to local files (the daemon lead's correction), not 'Allow access to file URLs'; board ab-v16.105: the sentence says what needs each access on each system", async () => {
  const w = new World();
  try {
    const folder = join(w.paths.state, "agent-package");
    assert.equal(loadNote(w.paths.state), `in the agent Chrome open chrome://extensions, turn on Developer mode, click Load unpacked and choose the folder ${folder} (Command-Shift-G in that dialog takes a path), then click Details of the agent extension and turn on 'Allow in Incognito'`);
    const mk = (mac: boolean) => {
      const part = new UnitPart({
        paths: w.paths, procs: w.procs, tools: new FakeTools(), owner: new Owner(async () => ({ active: "active", sub: "running", mainPid: process.pid }), () => {}), log: (l) => w.logs.push(l),
        endpoint: () => ({ form: "mac" }), sessionsComplete: () => true, clock: () => w.now,
        link: { ready: () => true, confirmed: () => true, busy: () => false, scopesReady: () => false },
        unit: w.deps(new FakeTools(), { mac: fakeMac(w).mac }),
        ...(mac ? { mac: { watcher: { tick: () => {}, stop: () => {} }, versions: () => ({ agent: null, operator: null }), disk: () => null } } : {}),
      });
      part.onConfig({ enabled: true, chrome_bin: "", chrome_args: [] });
      return part;
    };
    // Board ab-v16.105: the sentence says what needs each access on each system (on the Mac neither PageFetch nor the
    // sign-in act runs yet).
    const needsOf = (mac: boolean) => mac
      ? "in the agent Chrome (PageFetch and the sign-in act need incognito access when they come to the Mac; a file input needs access to local files)."
      : "in the agent Chrome (PageFetch and the sign-in act need incognito access; a file input needs access to local files).";
    for (const mac of [true, false]) {
      const needs = needsOf(mac);
      const part = mk(mac);
      await part.unit.start();
      // The files of a Mac's first link: Chrome dropped the service's write of Preferences, and it writes Secure
      // Preferences some seconds after the load, so neither file holds the receiver's entry yet.
      writeFileSync(w.paths.preferences, JSON.stringify({ profile: { name: "Person 1" } }));
      (part as unknown as { checkAccess(when: string): void }).checkAccess("link-up");
      const step = mac
        ? "In the agent Chrome, open chrome://extensions, click Details of the agent extension and turn on 'Allow in Incognito'. The service's next start of the agent Chrome gives the access to local files: a stop and a start of the agent browser give it now."
        : "The service's next start of the agent Chrome gives this access: a stop and a start of the agent browser give it now.";
      assert.ok(part.notes().operator.includes(`The agent extension lacks incognito access and access to local files ${needs} ${step}`), `${mac ? "the Mac" : "Linux"}: ${part.notes().operator.join(" | ")}`);
      await part.unit.stop();
    }
  } finally { w.close(); }
});

test("review-145b N1 and N2: a chrome_bin app through a link runs (its executable is under the link's real path); the adoption from an unreadable record takes only a Chrome that runs the app's binary", async () => {
  const w = new World();
  try {
    const realApp = join(w.dir, "Real", "Chrome Link.app"), linkApp = join(w.dir, "Nix Apps", "Chrome Link.app");
    mkdirSync(join(realApp, "Contents", "MacOS"), { recursive: true });
    mkdirSync(join(w.dir, "Nix Apps"));
    symlinkSync(realApp, linkApp);
    const binary = join(linkApp, "Contents", "MacOS", "Chrome Link");
    const mac: MacStart = {
      ...fakeMac(w).mac,
      app: () => ({ binary, bundle: linkApp, version: "156.0.8078.80", google: false }),
      open: async (_b, args) => { w.add({ argv: [binary, ...args], exe: join(realApp, "Contents", "MacOS", "Chrome Link"), ppid: 1 }); return 0; },
    };
    const u = new ChromeUnit(w.deps(new FakeTools(), { mac }));
    u.config = { ...CONFIG, chromeBin: binary };
    assert.equal(await u.start(), true, "N1: the kernel's path of the executable is the real one");
    await u.stop();
    // N2: an unreadable record; the one Chrome root on the profile names the app's binary but runs another program.
    const fake = w.add({ argv: [CHROME_STABLE_BIN, `--user-data-dir=${w.paths.profile}`], exe: "/Users/user/bin/not-chrome", ppid: 1 });
    writeFileSync(w.paths.unitFile, "{");
    const u2 = new ChromeUnit(w.deps(new FakeTools(), { mac: fakeMac(w).mac }));
    assert.equal(u2.adopt().adopted, false);
    assert.equal(u2.chromePid(), null);
    assert.ok(w.logs.some((l) => /cannot be read .*; 1 Chrome of the unit run, not from an app, so nothing is adopted/.test(l)));
    w.end(fake.pid);
    const good = w.add({ argv: [CHROME_STABLE_BIN, `--user-data-dir=${w.paths.profile}`], ppid: 1 });
    const u3 = new ChromeUnit(w.deps(new FakeTools(), { mac: fakeMac(w).mac }));
    assert.equal(u3.adopt().adopted, true, "the app's own binary: adopted");
    assert.equal(u3.chromePid(), good.pid);
  } finally { w.close(); }
});

test("review-145b N4 and N5: the version on disk is read only with no agent's use, and a failed read is logged once; a version on disk that is not a.b.c.d names itself in the start's error", async () => {
  const w = new World();
  try {
    let clients = true, reads = 0, disk: string | null = null;
    const part = new UnitPart({
      paths: w.paths, procs: w.procs, tools: new FakeTools(), owner: new Owner(async () => ({ active: "active", sub: "running", mainPid: process.pid }), () => {}), log: (l) => w.logs.push(l),
      endpoint: () => ({ form: "mac" }), sessionsComplete: () => true, activity: { clients: () => clients },
      unit: w.deps(new FakeTools(), { mac: fakeMac(w).mac }),
      mac: { watcher: { tick: () => {}, stop: () => {} }, versions: () => ({ agent: "156.0.8078.74", operator: "156.0.8078.80" }), disk: () => { reads++; return disk; }, everyMs: 0 },
    });
    part.onConfig({ enabled: true, chrome_bin: "", chrome_args: [] });
    await part.unit.start();
    const first = part.unit.chromePid();
    const check = () => (part as any).macVersionCheck();
    await check();
    assert.equal(reads, 0, "an agent's client is connected: no read of the disk (plutil blocks up to 5 s)");
    clients = false;
    await check();
    await check();
    assert.equal(reads, 2);
    assert.equal(part.unit.chromePid(), first, "no version on disk: no restart");
    const unread = `unit: the operator's Chrome runs 156.0.8078.80, newer than the agent Chrome's 156.0.8078.74, but the version on disk of ${APP} cannot be read as a.b.c.d; the agent Chrome does not start again`;
    const waits = `unit: the operator's Chrome runs 156.0.8078.80, newer than the agent Chrome's 156.0.8078.74; when no agent uses it, the service reads the version on disk of ${APP}, and the agent Chrome starts again if that version is newer too`;
    assert.equal(w.logs.filter((l) => l === unread).length, 1, "one line, not one each 60 s");
    // Review-147 note 4 (board ab-v16.94.21): a client that comes and goes between the reads: before the fix the wait
    // line and the failed read's line came by turns, at each change. Now each comes once: the wait line before the first read.
    for (let i = 0; i < 3; i++) { clients = true; await check(); clients = false; await check(); }
    assert.equal(reads, 5);
    assert.deepEqual([w.logs.filter((l) => l === waits).length, w.logs.filter((l) => l === unread).length], [1, 1], "each line once");
    assert.ok(w.logs.indexOf(waits) < w.logs.indexOf(unread), "the wait line came before the first read");
    disk = "156.0.8078.80";
    await check();
    assert.notEqual(part.unit.chromePid(), first, "a newer version on disk: the restart");
    await part.stop();
  } finally { w.close(); }
  const home = tempDir("ab-mac-home-");
  try {
    const three = macStart({ state: home, home, exists: () => true, version: () => "156.0.8078" });
    assert.throws(() => three.app("", join(home, "p")), (e: Error) => e instanceof StartError && e.message === `the version of ${APP} is "156.0.8078", not of the form a.b.c.d (four numbers), so the agent browser cannot compare it`);
    assert.throws(() => macStart({ state: home, home, exists: () => true, version: () => null }).app("", join(home, "p")), /: the version of .* cannot be read$/);
    assert.equal(bundleVersion(APP, () => " 156.0.8078\n"), "156.0.8078");
    assert.equal(bundleVersion(APP, () => { throw new Error("no plutil"); }), null);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("review-145b N6: service stop --all on the Mac fails when proc_listallpids fails, in place of a stop of nothing; the unit's own reads still give no pids then", async () => {
  const lib = new FakeLib();
  lib.add({ pid: 800, ppid: 1, start: 80, argv: [CHROME_STABLE_BIN, "--user-data-dir=/p"] });
  lib.proc_listallpids = () => -1;
  const procs = await stopAllProcs("darwin", async () => lib);
  assert.throws(() => procs.pids(), /proc_listallpids failed/);
  const dir = tempDir("ab-mac-stopall-");
  try {
    const paths = unitPaths(join(dir, "state"), join(dir, "tools"));
    await assert.rejects(stopAll({ paths, procs, kill: () => assert.fail("no signal") }), /proc_listallpids failed: the processes cannot be listed/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.deepEqual(new MacProcs(lib, { uid: UID, self: 999 }).pids(), [], "the service's own reads: no pids, as before");
});

test("board ab-v16.52 (in place of review-145 N2 and review-147 note 2): the Mac's peer read takes no clock: a peer whose pbi_start is after the moment of the read (a step back of the clock) passes; another process at the token's pid after the token's read is refused by its p_idversion", () => {
  const lib = new FakeLib();
  const peer = lib.add({ pid: 4242, ppid: 1, start: (Date.now() + 600_000) * 1000, argv: ["node"], uniq: 19851225, version: 41047381 });
  const tok: { peer: number | null; afterToken?: () => void } = { peer: 4242 };
  const reader = new MacReader(macLibcOf(lib, tok));
  assert.deepEqual(reader.peer(3), { pid: 4242, uid: process.getuid!(), pidfd: null, start: peer.start }, "a start 10 min after the read (the clock stepped back): the peer");
  tok.afterToken = () => { peer.version = (peer.version ?? 0) + 1; };
  assert.equal(reader.peer(3)?.start, null, "another process at the pid after the token's read: no start time");
  assert.equal(readPeer(reader, 3, process.getuid!()), null, "the peer's 403");
  tok.peer = null;
  assert.equal(reader.peer(3), null, "the token's read fails (EINVAL): no peer");
});
