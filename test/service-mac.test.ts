// The service on the Mac (board ab-v16.94.6; the self-contained design, section 10; C11 and C12, the Mac), on fakes: this
// box runs no macOS call. A fake libSystem gives the kernel's bytes in Apple's struct layouts (src/service/mac.ts), a
// stand-in launchctl prints a job, the unit's fake world (fake-unit-world.ts) stands for the process table, and a fake
// `open` adds the new Chrome as launchd's child. No test starts `open`, osascript, plutil or a Chrome.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
import { chromeVersions, defaultFolderOf, GiveBackWatcher, macStart, type MacStart } from "../src/service/unit/mac-chrome.ts";
import { Owner, type UnitState } from "../src/service/unit/owner.ts";
import { UnitPart } from "../src/service/unit/part.ts";
import { ChromeUnit, MAC_FIND_MS, StartError } from "../src/service/unit/unit.ts";
import { readRecord } from "../src/service/unit/record.ts";
import { PEER_UNREAD, sessionRefusal, type PeerReader, type Proc, type RawPeer } from "../src/relay/peer.ts";
import { FakeTools, World } from "./fake-unit-world.ts";

const UID = 501;

// ------------------------------------------------------------------ a fake libSystem

type FP = { pid: number; ppid: number; start: number; argv: string[]; uid?: number; pgid?: number; zombie?: boolean; path?: string; other?: boolean; fds?: Map<number, Buffer> };

/** struct proc_bsdinfo with the fields that the service reads; `start` in µs. */
function bsdBuf(p: FP): Buffer {
  const b = Buffer.alloc(PROC_BSDINFO_SIZE);
  b.writeUInt32LE(p.zombie ? 5 : 2, 4); b.writeUInt32LE(p.pid, 12); b.writeUInt32LE(p.ppid, 16);
  b.writeUInt32LE(p.uid ?? UID, 20); b.writeUInt32LE(p.uid ?? UID, 28); b.writeUInt32LE(p.pgid ?? p.pid, 100);
  b.writeBigUInt64LE(BigInt(Math.floor(p.start / 1e6)), 120); b.writeBigUInt64LE(BigInt(p.start % 1e6), 128);
  return b;
}
/** KERN_PROCARGS2: argc, the exec path, its NUL padding, the arguments, then the environment. */
function procArgs(p: FP): Buffer {
  const argc = Buffer.alloc(4); argc.writeInt32LE(p.argv.length);
  return Buffer.concat([argc, Buffer.from(`${p.path ?? p.argv[0]}\0\0\0\0`), ...p.argv.map((a) => Buffer.from(`${a}\0`)), Buffer.from("HOME=/Users/ann\0\0")]);
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
    if (flavor === 3) { bsdBuf(p).copy(buf); return PROC_BSDINFO_SIZE; }
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
  const args = parseProcArgs2(procArgs({ pid: 1, ppid: 0, start: 1, argv: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "--user-data-dir=/Users/ann/My Profile", ""] }))!;
  assert.deepEqual(args.argv.map(String), ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "--user-data-dir=/Users/ann/My Profile", ""], "each argument whole, with its spaces, and an empty one");
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
  const dir = mkdtempSync(join(tmpdir(), "ab-mac-launchctl-"));
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
  lib.add({ pid: 700, ppid: 1, start: 5_000_000, pgid: 700, argv: [CHROME_STABLE_BIN, "--user-data-dir=/Users/ann/agent state/profile"] });
  lib.add({ pid: 701, ppid: 1, start: 6, argv: ["/bin/zsh"], zombie: true });
  lib.add({ pid: 702, ppid: 1, start: 7, argv: ["/usr/bin/other"], uid: 0, other: true });
  lib.add({ pid: 999, ppid: 1, start: 8, argv: ["node"] });
  const p = new MacProcs(lib, { uid: UID, self: 999 });
  assert.deepEqual(p.stat(700), { state: "S", ppid: 1, pgrp: 700, start: 5_000_000 });
  assert.equal(p.stat(701), null, "a zombie is gone, as on Linux");
  assert.deepEqual(p.proc(701), { ppid: 1, start: 6, state: "Z" }, "the walk sees the zombie state");
  assert.deepEqual(p.cmdline(700), [CHROME_STABLE_BIN, "--user-data-dir=/Users/ann/agent state/profile"]);
  assert.ok(p.holds(700, ["--user-data-dir=/Users/ann/agent state/profile"]), "a marker with a space is one whole argument");
  assert.ok(!p.holds(700, ["--user-data-dir=/Users/ann/agent"]));
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

test("the Mac's TCP peer reader under the MCP admission (steps 1 and 2): the client's socket by the full tuple with its maker's uid, its holders, the walk to the session's root; the port stays closed until the Mac check", () => {
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
  client.fds!.set(12, sockBuf({ local: CLIENT, remote: SERVICE, handle: 0xaa01n, uid: 0 }));
  assert.deepEqual(admit(), { step: 1, status: 403, body: PEER_UNREAD }, "a socket that another user made");
  client.fds!.set(12, sockBuf({ local: CLIENT, remote: SERVICE, handle: 0xaa01n }));
  client.ppid = 1;
  assert.deepEqual(admit(), { step: 2, status: 403, body: sessionRefusal(300) }, "a holder that reaches no root");
  lib.procs.delete(300);
  assert.deepEqual(admit(), { step: 1, status: 403, body: PEER_UNREAD }, "no line");
  assert.equal(MAC_TCP_READER_MEASURED, false, "the reader is built, not measured: the port stays closed on the Mac");
  assert.equal(macPortClosed("darwin"), true);
  assert.equal(macPortClosed("darwin", true), false);
  assert.equal(macPortClosed("linux"), false);
});

// ------------------------------------------------------------------ part 2: the control door's admission

test("the control door's admission on the Mac (C12): LOCAL_PEERPID's peer and its start time, launchctl's job pid, proc_pidinfo, KERN_PROCARGS2 and proc_pidpath; rules 1 to 4 as on Linux", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-mac-admission-"));
  try {
    const file = join(dir, "daemon-command.json"), INTERP = "/Users/ann/.local/share/uv/python/cpython-3.13/bin/python3.13", ARGS = ["/Users/ann/agentwatch/bin/agentwatch", "--daemon"];
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
    assert.deepEqual(await run({ argv: ["/Users/ann/agentwatch/bin/agentwatch", "--hook"] }), { ok: false, reason: refusedRule(3, "its command line is not the daemon's command") });
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

test("the Mac's app and its folders: never a default user-data folder (also through a link or another case), an app's binary only, the version on disk", () => {
  const home = mkdtempSync(join(tmpdir(), "ab-mac-home-"));
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
  const dir = mkdtempSync(join(tmpdir(), "ab-mac-watch-"));
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

test("the version change on the Mac: the agent Chrome starts again when the operator's running Chrome runs another version, only while no agent's client is connected; the restart sends ready", async () => {
  const w = new World();
  try {
    const f = fakeMac(w);
    let versions = { agent: "156.0.8078.74", operator: "156.0.8078.74" }, clients = true;
    const ticks: unknown[] = [], events: Record<string, unknown>[] = [];
    const part = new UnitPart({
      paths: w.paths, procs: w.procs, tools: new FakeTools(), owner: new Owner(async () => ({ active: "active", sub: "running", mainPid: process.pid }), () => {}), log: (l) => w.logs.push(l),
      endpoint: () => ({ form: "mac" }), sessionsComplete: () => true, activity: { clients: () => clients },
      unit: w.deps(new FakeTools(), { mac: f.mac }),
      mac: { watcher: { tick: (c) => ticks.push(c), stop: () => ticks.push("stop") }, versions: () => versions, everyMs: 0 },
    });
    part.attach((ev) => events.push(ev));
    part.onConfig({ enabled: true, chrome_bin: "", chrome_args: [] });
    await part.unit.start();
    const first = part.unit.chromePid();
    const check = () => (part as any).macVersionCheck();
    await check();
    assert.equal(part.unit.chromePid(), first, "the same version: no restart");
    versions = { agent: "156.0.8078.74", operator: "156.0.8078.80" };
    await check();
    assert.equal(part.unit.chromePid(), first, "an agent's client is connected: it waits");
    assert.ok(w.logs.some((l) => /starts again when no agent uses it/.test(l)));
    clients = false;
    await check();
    assert.notEqual(part.unit.chromePid(), first, "a new agent Chrome");
    assert.ok(!w.alive(first!), "the old one stopped");
    assert.equal(f.calls.length, 2);
    assert.ok(events.some((e) => e.ev === "ready"), "ready goes out");
    assert.ok(!events.some((e) => e.ev === "stopped"), "no stopped event: the restart is like a move");
    await part.stop();
    assert.ok(ticks.includes("stop"), "the part's stop ends the watcher");
  } finally { w.close(); }
});
