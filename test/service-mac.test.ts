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
import { loadNote, UnitPart } from "../src/service/unit/part.ts";
import { ChromeUnit, MAC_FIND_MS, StartError } from "../src/service/unit/unit.ts";
import { readRecord } from "../src/service/unit/record.ts";
import { MacReader, PEER_UNREAD, readPeer, sessionRefusal, type PeerReader, type Proc, type RawPeer } from "../src/relay/peer.ts";
import { FakeTools, World } from "./fake-unit-world.ts";
import { tempDir } from "./temp-dirs.ts";

const UID = 501;

// ------------------------------------------------------------------ a fake libSystem

/** `uid` is the effective uid and `ruid` the real one (`uid` by default); `noBsd`: PROC_PIDTBSDINFO fails (a process that ends between the reads). */
type FP = { pid: number; ppid: number; start: number; argv: string[]; uid?: number; ruid?: number; noBsd?: boolean; pgid?: number; zombie?: boolean; path?: string; other?: boolean; fds?: Map<number, Buffer> };

/** struct proc_bsdinfo with the fields that the service reads; `start` in µs. */
function bsdBuf(p: FP): Buffer {
  const b = Buffer.alloc(PROC_BSDINFO_SIZE);
  b.writeUInt32LE(p.zombie ? 5 : 2, 4); b.writeUInt32LE(p.pid, 12); b.writeUInt32LE(p.ppid, 16);
  b.writeUInt32LE(p.uid ?? UID, 20); b.writeUInt32LE(p.ruid ?? p.uid ?? UID, 28); b.writeUInt32LE(p.pgid ?? p.pid, 100);
  b.writeBigUInt64LE(BigInt(Math.floor(p.start / 1e6)), 120); b.writeBigUInt64LE(BigInt(p.start % 1e6), 128);
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
  assert.deepEqual(p.proc(701), { ppid: 1, start: 6, state: "Z" }, "the walk sees the zombie state");
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

test("the control door's admission on the Mac (C12): LOCAL_PEERPID's peer and its start time, launchctl's job pid, proc_pidinfo, KERN_PROCARGS2 and proc_pidpath; rules 1 to 4 as on Linux", async () => {
  const dir = tempDir("ab-mac-admission-");
  try {
    const file = join(dir, "daemon-command.json"), INTERP = "/Users/user/.local/share/uv/python/cpython-3.13/bin/python3.13", ARGS = ["/Users/user/agentwatch/bin/agentwatch", "--daemon"];
    writeFileSync(file, JSON.stringify({ v: 1, interpreter: INTERP, args: ARGS }), { mode: 0o600 });
    const SOCK = { _handle: { fd: 9 } } as unknown as Socket;
    type Opts = { procs?: Record<number, Proc>; peer?: RawPeer | null; main?: (number | null)[]; argv?: string[]; exe?: string; after?: Record<number, Proc>; form?: string; mac?: { failed: string } };
    const run = async (o: Opts = {}) => {
      let table = o.procs ?? { 4242: { ppid: 1, start: 100, state: "S" }, 4300: { ppid: 4242, start: 200, state: "S" } };
      const mains = [...(o.main ?? [4242, 4242])];
      const reader: PeerReader = {
        form: (o.form ?? "mac") as "mac", peer: () => (o.peer === undefined ? { pid: 4300, uid: process.getuid!(), pidfd: null, start: 200 } : o.peer),
        proc: (pid) => table[pid] ?? null, cgroup: () => null, poll: () => -1, fdinfoPid: () => null, close: () => {},
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
    assert.deepEqual(await run({ procs: { 4242: { ppid: 1, start: 100, state: "S" }, 4300: { ppid: 4000, start: 200, state: "S" } } }), { ok: false, reason: refusedRule(2, "its parent is not the MainPID of agentwatch's unit") });
    assert.deepEqual(await run({ peer: { pid: 999, uid: process.getuid!(), pidfd: null, start: 50 }, procs: { 4242: { ppid: 1, start: 100, state: "S" }, 999: { ppid: 4242, start: 50, state: "S" } } }), { ok: false, reason: refusedRule(2, "it is the service itself") });
    assert.deepEqual(await run({ argv: ["/Users/user/agentwatch/bin/agentwatch", "--hook"] }), { ok: false, reason: refusedRule(3, "its command line is not the daemon's command") });
    assert.deepEqual(await run({ exe: "/usr/bin/python3" }), { ok: false, reason: refusedRule(3, "its executable is not the interpreter of the daemon's command") });
    assert.deepEqual(await run({ peer: { pid: 4300, uid: process.getuid!(), pidfd: null, start: 199 } }), { ok: false, reason: refusedRule(4, "the service cannot read the peer and hold its pidfd") }, "a start time at the accept that is not the process's");
    assert.deepEqual(await run({ peer: { pid: 4300, uid: 0, pidfd: null, start: 200 } }), { ok: false, reason: refusedRule(4, "the service cannot read the peer and hold its pidfd") }, "another user");
    assert.deepEqual(await run({ main: [4242, 4250] }), { ok: false, reason: refusedRule(4, "the MainPID changed during the check") });
    assert.deepEqual(await run({ after: { 4242: { ppid: 1, start: 100, state: "S" }, 4300: { ppid: 4242, start: 201, state: "S" } } }), { ok: false, reason: refusedRule(4, "the peer changed during the check") });
    assert.deepEqual(await run({ after: { 4242: { ppid: 1, start: 101, state: "S" }, 4300: { ppid: 4242, start: 200, state: "S" } } }), { ok: false, reason: refusedRule(4, "the MainPID changed during the check") }, "the job's process is another one by its start time");
    assert.deepEqual(await run({ form: "stat" }), { ok: false, reason: refusedCannotRead("the peer reader is not the Mac's") });
    assert.deepEqual(await run({ mac: { failed: "dlopen of libSystem failed: x" } }), { ok: false, reason: refusedCannotRead("dlopen of libSystem failed: x") });
    const linuxOnly = daemonAdmission({ reader: { failed: "x" }, pidfd: { failed: "x" }, mainPid: async () => 1, commandFile: file, platform: "win32" });
    assert.match((await linuxOnly(SOCK) as { reason: string }).reason, /not built for win32/);
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

test("board ab-v16.94.34: the Mac's first-link text names the incognito switch after the load, so one sitting does both; on the Mac a missing access with no entry of the receiver in either file (Chrome drops the service's write there) names the operator's switches, not a stop and a start", async () => {
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
    const needs = "in the agent Chrome (PageFetch and the sign-in act need incognito access; a file input needs access to local files).";
    for (const mac of [true, false]) {
      const part = mk(mac);
      await part.unit.start();
      // The files of a Mac's first link: Chrome dropped the service's write of Preferences, and it writes Secure
      // Preferences some seconds after the load, so neither file holds the receiver's entry yet.
      writeFileSync(w.paths.preferences, JSON.stringify({ profile: { name: "Person 1" } }));
      (part as unknown as { checkAccess(when: string): void }).checkAccess("link-up");
      const step = mac
        ? "In the agent Chrome, open chrome://extensions, click Details of the agent extension and turn on 'Allow in Incognito' and 'Allow access to file URLs'."
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

test("review-145 N2: the Mac's peer reader refuses a peer whose start time is later than the moment before its LOCAL_PEERPID read (the connecter's pid was reused)", () => {
  let start = 5_000_000;
  const libc = {
    getsockopt: (_fd: number, _level: number, name: number, value: Buffer) => { if (name === 2) value.writeInt32LE(4242, 0); else value.writeUInt32LE(UID, 4); return 0; },
    poll: () => 0, close: () => 0, errno: () => 0,
    proc_pidinfo: (pid: number, _flavor: number, _arg: bigint, buf: Buffer) => { bsdBuf({ pid, ppid: 1, start, argv: [] }).copy(buf); return PROC_BSDINFO_SIZE; },
  };
  const reader = new MacReader(libc, () => 6_000_000);
  assert.deepEqual(reader.peer(3), { pid: 4242, uid: UID, pidfd: null, start: 5_000_000 });
  start = 6_000_000;
  assert.equal(reader.peer(3)?.start, 6_000_000, "the same moment counts as before");
  start = 6_000_001;
  assert.deepEqual(reader.peer(3), { pid: 4242, uid: UID, pidfd: null, start: null }, "a start after the read: no start time, so the peer's 403");
  assert.equal(readPeer(reader, 3, UID), null);
  const clock = new MacReader(libc);
  start = (Date.now() - 1000) * 1000;
  assert.equal(clock.peer(3)?.start, start, "the real clock: a process of a second ago passes");
  start = (Date.now() + 60_000) * 1000;
  assert.equal(clock.peer(3)?.start, null);
});

test("review-147 note 2 (board ab-v16.94.21; C11 and C12 state it): both times of the Mac's peer read are the wall clock's, so after a step back of the clock by D a peer that started less than D before the step has no start time, until the clock passes its start time again", () => {
  const start = 5_900_000; // µs: the peer started 0.1 s before the step
  const libc = {
    getsockopt: (_fd: number, _level: number, name: number, value: Buffer) => { if (name === 2) value.writeInt32LE(4242, 0); else value.writeUInt32LE(UID, 4); return 0; },
    poll: () => 0, close: () => 0, errno: () => 0,
    proc_pidinfo: (pid: number, _flavor: number, _arg: bigint, buf: Buffer) => { bsdBuf({ pid, ppid: 1, start, argv: [] }).copy(buf); return PROC_BSDINFO_SIZE; },
  };
  let now = 6_000_000;
  const reader = new MacReader(libc, () => now);
  assert.equal(reader.peer(3)?.start, start, "before the step");
  now -= 1_000_000; // the clock steps back 1 s
  assert.equal(reader.peer(3)?.start, null, "after the step: the peer's 403 (Mac check 16(c))");
  now = start;
  assert.equal(reader.peer(3)?.start, start, "once the clock passes its start time again");
});
