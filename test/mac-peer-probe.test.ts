// The Mac peer probe (test/live/mac-peer-probe/; board ab-v16.52, part 1): its pure parts (parts.ts) with made-up kernel
// structs (the field reads of xucred, audit_token_t, proc_bsdinfo, proc_bsdshortinfo, proc_uniqidentifierinfo,
// rusage_info_v2 and mach_timebase_info; the facts of a process; the walk's order checks; the reads of Q1 and Q2; the
// result's shape, check and scrub), and on Linux one run of the probe itself, its Linux twin (SO_PEERCRED), with its
// cleanup. The Mac's own answers come only from the run on the Mac.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { tempDir, done } from "./temp-dirs.ts";
import {
  CASES, RESULT_KEYS, TIME_LIMIT_MS, absNs, cString, checkResult, edgesOf, factsJson, factsOf, order, parseRusageStart, parseShortBsd, parseTimebase,
  parseToken, parseUcred, parseUniq, parseXucred, q2Of, readOut, resultOf, roleOf, scrub, uniqRole, walkSummary,
  type Facts, type Got, type Meta, type RawRead,
} from "./live/mac-peer-probe/parts.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PROBE = fileURLToPath(new URL("./live/mac-peer-probe/probe.ts", import.meta.url));
const META: Meta = { version: 1, commit: "0123456789abcdef0123456789abcdef01234567", dirty: false };
const UID = 501;
type MacRead = Extract<RawRead, { form: "mac" }>;

// ------------------------------------------------------------------ made-up structs

type Bsd = { pid: number; ppid: number; uid: number; comm: string; sec: number; usec: number; status?: number };
const bsdBuf = (o: Bsd) => {
  const b = Buffer.alloc(136);
  b.writeUInt32LE(o.status ?? 2, 4); b.writeUInt32LE(o.pid, 12); b.writeUInt32LE(o.ppid, 16); b.writeUInt32LE(o.uid, 20); b.writeUInt32LE(o.uid, 28);
  b.write(o.comm, 48, "latin1");
  b.writeBigUInt64LE(BigInt(o.sec), 120); b.writeBigUInt64LE(BigInt(o.usec), 128);
  return b;
};
const shortBuf = (o: { pid: number; ppid: number; uid: number; comm: string; status?: number }) => {
  const b = Buffer.alloc(64);
  b.writeUInt32LE(o.pid, 0); b.writeUInt32LE(o.ppid, 4); b.writeUInt32LE(o.status ?? 2, 12); b.write(o.comm, 16, "latin1");
  b.writeUInt32LE(o.uid, 36); b.writeUInt32LE(o.uid, 44);
  return b;
};
const uniqBuf = (uniqueid: bigint, puniqueid: bigint, version: number) => {
  const b = Buffer.alloc(56);
  b.fill(0xab, 0, 16); // the executable's UUID: never read
  b.writeBigUInt64LE(uniqueid, 16); b.writeBigUInt64LE(puniqueid, 24); b.writeInt32LE(version, 32);
  return b;
};
const rusageBuf = (abs: bigint) => { const b = Buffer.alloc(160); b.writeBigUInt64LE(abs, 80); b.writeBigUInt64LE(abs + 5n, 88); return b; };
const tokenBuf = (v: number[]) => { const b = Buffer.alloc(32); v.forEach((x, i) => b.writeUInt32LE(x, i * 4)); return b; };
const xucredBuf = (uid: number, ngroups = 3) => { const b = Buffer.alloc(76); b.writeUInt32LE(0, 0); b.writeUInt32LE(uid, 4); b.writeInt16LE(ngroups, 8); b.writeUInt32LE(20, 12); return b; };
const pidBuf = (pid: number) => { const b = Buffer.alloc(4); b.writeInt32LE(pid, 0); return b; };
const ok = (b: Buffer): Got => ({ b });
const EPERM: Got = { err: "errno 1" };

/** A process of the user, with every read: its wall start (s), its abstime start and its unique id. */
const proc = (pid: number, ppid: number, comm: string, sec: number, abs: bigint, uniq: bigint, puniq: bigint, uid = UID): Facts =>
  factsOf(pid, { bsd: ok(bsdBuf({ pid, ppid, uid, comm, sec, usec: 250 })), short: ok(shortBuf({ pid, ppid, uid, comm })), uniq: ok(uniqBuf(uniq, puniq, 7000 + pid)), rusage: ok(rusageBuf(abs)) });
/** launchd as a normal user reads it: PROC_PIDTBSDINFO and proc_pid_rusage refused (EPERM), the short info and the unique id given. */
const LAUNCHD = factsOf(1, { bsd: EPERM, short: ok(shortBuf({ pid: 1, ppid: 0, uid: 0, comm: "launchd" })), uniq: ok(uniqBuf(1n, 0n, 1)), rusage: EPERM });

// ------------------------------------------------------------------ the structs

test("the C strings: up to the first NUL, at most the field's length, every byte outside [A-Za-z0-9._+ -] as ?, empty as null", () => {
  const b = Buffer.alloc(32);
  b.write("tmux", 0, "latin1");
  assert.equal(cString(b, 0, 16), "tmux");
  b.write("a/b\u00e9c\nd", 16, "latin1");
  assert.equal(cString(b, 16, 16), "a?b?c?d");
  assert.equal(cString(Buffer.alloc(16), 0, 16), null);
  assert.equal(cString(Buffer.from("0123456789abcdefXYZ", "latin1"), 0, 16), "0123456789abcdef");
});

test("xucred, Linux's ucred and the audit token: each field at its documented place", () => {
  assert.deepEqual(parseXucred(xucredBuf(501, 12)), { version: 0, uid: 501, ngroups: 12 });
  assert.equal(parseXucred(Buffer.alloc(8)), null);
  const u = Buffer.alloc(12); u.writeInt32LE(4242, 0); u.writeUInt32LE(1001, 4); u.writeUInt32LE(1001, 8);
  assert.deepEqual(parseUcred(u), { pid: 4242, uid: 1001 });
  assert.equal(parseUcred(Buffer.alloc(8)), null);
  // val[0] auid, val[1] euid, val[2] egid, val[3] ruid, val[4] rgid, val[5] pid, val[6] asid, val[7] pid version.
  assert.deepEqual(parseToken(tokenBuf([501, 502, 20, 503, 21, 4242, 100007, 9911])), { auid: 501, euid: 502, egid: 20, ruid: 503, rgid: 21, pid: 4242, asid: 100007, pidVersion: 9911 });
  assert.equal(parseToken(Buffer.alloc(28)), null);
});

test("proc_bsdshortinfo, proc_uniqidentifierinfo, rusage_info_v2's start and the timebase", () => {
  assert.deepEqual(parseShortBsd(shortBuf({ pid: 1, ppid: 0, uid: 0, comm: "launchd", status: 2 })), { pid: 1, ppid: 0, status: 2, name: "launchd", uid: 0, ruid: 0 });
  assert.equal(parseShortBsd(Buffer.alloc(60)), null);
  assert.deepEqual(parseUniq(uniqBuf(123456n, 120000n, -5)), { uniqueid: 123456n, puniqueid: 120000n, pidVersion: -5 });
  assert.equal(parseUniq(Buffer.alloc(36)), null);
  assert.equal(parseRusageStart(rusageBuf(987654321012n)), 987654321012n);
  assert.equal(parseRusageStart(Buffer.alloc(87)), null);
  const tb = Buffer.alloc(8); tb.writeUInt32LE(125, 0); tb.writeUInt32LE(3, 4);
  assert.deepEqual(parseTimebase(tb), { numer: 125, denom: 3 });
  assert.equal(parseTimebase(Buffer.alloc(8)), null, "a denom of 0 is no timebase");
  assert.equal(absNs(24_000_000n, { numer: 125, denom: 3 }), 1_000_000_000n, "24 MHz ticks: one second");
  assert.equal(absNs(5n, { numer: 1, denom: 1 }), 5n);
});

// ------------------------------------------------------------------ a process's facts

test("the facts of a process: pbi_start in µs, pbi_comm, the abstime start, the unique ids; every read ok", () => {
  const f = proc(4242, 4000, "node", 1_790_000_000, 5_000_000n, 900n, 800n);
  assert.deepEqual(f, {
    pid: 4242, ppid: 4000, name: "node", uid: UID, zombie: false, startUs: 1_790_000_000_000_250, startAbs: 5_000_000n, uniqueid: 900n, puniqueid: 800n,
    pidVersion: 11242, reads: { bsd: "ok", short: "ok", uniq: "ok", rusage: "ok" },
  });
  const z = factsOf(7, { bsd: ok(bsdBuf({ pid: 7, ppid: 1, uid: UID, comm: "zz", sec: 1, usec: 0, status: 5 })), short: EPERM, uniq: EPERM, rusage: EPERM });
  assert.equal(z.zombie, true, "SZOMB (5)");
  assert.deepEqual(z.reads, { bsd: "ok", short: "errno 1", uniq: "errno 1", rusage: "errno 1" });
});

test("launchd as a normal user reads it: the name, ppid and uid from the short info, no start by either clock", () => {
  assert.deepEqual(LAUNCHD, {
    pid: 1, ppid: 0, name: "launchd", uid: 0, zombie: false, startUs: null, startAbs: null, uniqueid: 1n, puniqueid: 0n, pidVersion: 1,
    reads: { bsd: "errno 1", short: "ok", uniq: "ok", rusage: "errno 1" },
  });
});

test("a struct whose own pid is not the pid asked counts as a wrong layout: its fields are not used", () => {
  const f = factsOf(10, { bsd: ok(bsdBuf({ pid: 11, ppid: 1, uid: UID, comm: "x", sec: 1, usec: 0 })), short: ok(shortBuf({ pid: 12, ppid: 1, uid: UID, comm: "y" })), uniq: EPERM, rusage: EPERM });
  assert.deepEqual([f.ppid, f.name, f.uid, f.startUs, f.zombie], [null, null, null, null, null]);
  assert.deepEqual(f.reads, { bsd: "pid differs", short: "pid differs", uniq: "errno 1", rusage: "errno 1" });
  const short = factsOf(10, { bsd: ok(Buffer.alloc(100)), short: { err: "0 bytes" }, uniq: ok(Buffer.alloc(10)), rusage: ok(Buffer.alloc(10)) });
  assert.deepEqual(short.reads, { bsd: "no parse", short: "0 bytes", uniq: "no parse", rusage: "no parse" });
});

test("the facts as JSON: 64-bit values as decimal strings, the age by each clock, and their difference", () => {
  const f = proc(4242, 4000, "node", 1000, 24_000_000n * 100n, 18446744073709551615n, 5n);
  // The wall clock says 3600 s since the start; mach_absolute_time says 3000 s (600 s of sleep or of clock steps).
  const j = factsJson(f, { abs: 24_000_000n * 3100n, wallUs: 4600 * 1e6 + 250 }, { numer: 125, denom: 3 });
  assert.equal(j.startAbs, "2400000000");
  assert.equal(j.uniqueid, "18446744073709551615");
  assert.equal(j.ageWallMs, 3_600_000);
  assert.equal(j.ageAbsMs, 3_000_000);
  assert.equal(j.wallMinusAbsMs, 600_000);
  const n = factsJson(LAUNCHD, { abs: null, wallUs: 1 }, null);
  assert.deepEqual([n.startUs, n.startAbs, n.ageWallMs, n.ageAbsMs, n.wallMinusAbsMs, n.uniqueid], [null, null, null, null, null, "1"]);
  assert.equal(checkResult(resultOf({ meta: META, platform: null, ok: true, stage: "done", reason: null, ms: 1, ownUid: UID, q1: null, q2: null, q3: { procs: [j, n] }, q4: null, cleanup: null })), null);
});

// ------------------------------------------------------------------ the walk

/** probe (node) <- zsh <- claude <- zsh (the pane) <- tmux (the server) <- launchd, each started after its parent by each clock. */
const CHAIN: Facts[] = [
  proc(5005, 5004, "node", 5000, 5000n, 105n, 104n),
  proc(5004, 5003, "zsh", 4000, 4000n, 104n, 103n),
  proc(5003, 5002, "claude", 3000, 3000n, 103n, 102n),
  proc(5002, 5001, "zsh", 2000, 2000n, 102n, 101n),
  proc(5001, 1, "tmux", 1000, 1000n, 101n, 1n),
  LAUNCHD,
];

test("the order of two starts: after, the same, before, or null when one is not known", () => {
  assert.equal(order(2, 1), "after");
  assert.equal(order(1, 1), "same");
  assert.equal(order(1, 2), "before");
  assert.equal(order(2n, 1n), "after");
  assert.equal(order(null, 1), null);
  assert.equal(order(1n, null), null);
});

test("the walk's edges and summary: each clock in order, the unique ids chained, the tmux server under launchd, the pane", () => {
  const edges = edgesOf(CHAIN);
  assert.equal(edges.length, 5);
  assert.deepEqual(edges[0], { child: 5005, parent: 5004, ppidIsParent: true, wall: "after", abs: "after", uniqueid: "after", puniqueidIsParent: true });
  assert.deepEqual(edges[4], { child: 5001, parent: 1, ppidIsParent: true, wall: null, abs: null, uniqueid: "after", puniqueidIsParent: true }, "launchd has no start for a normal user");
  assert.deepEqual(walkSummary(CHAIN, edges), {
    hops: 5, reachedLaunchd: true, ppidChained: true,
    wall: { known: 4, of: 5, ordered: true, before: [] },
    abs: { known: 4, of: 5, ordered: true, before: [] },
    uniqueid: { known: 5, of: 5, ordered: true, before: [] },
    puniqueid: { known: 5, of: 5, chained: true },
    tmux: { index: 4, pid: 5001, parentIsLaunchd: true },
    pane: { index: 3, pid: 5002, name: "zsh" },
  });
});

test("a step back of the wall clock between the pane's fork and the agent's: the agent looks older by pbi_start, not by the abstime or the unique id", () => {
  const chain = [...CHAIN];
  chain[2] = proc(5003, 5002, "claude", 1500, 3000n, 103n, 102n); // the wall clock went back 500 s before this fork
  const s = walkSummary(chain, edgesOf(chain));
  assert.deepEqual(s.wall, { known: 4, of: 5, ordered: false, before: [5003] });
  assert.equal(s.abs.ordered, true);
  assert.equal(s.uniqueid.ordered, true);
});

test("a re-parented process and a reused pid: ppid, p_puniqueid and the unique id order show them", () => {
  // The agent's job left its shell: launchd is its parent now, and its p_puniqueid still names the shell (or not).
  const orphan = [proc(6000, 1, "node", 6000, 6000n, 600n, 104n), LAUNCHD];
  const s = walkSummary(orphan, edgesOf(orphan));
  assert.equal(s.puniqueid.chained, false);
  assert.equal(s.tmux, null);
  assert.equal(s.pane, null);
  assert.equal(s.hops, 1);
  // A parent whose pid came back after the child's start: a later unique id than the child's.
  const reused = [proc(7001, 7000, "node", 7000, 7000n, 700n, 650n), proc(7000, 1, "zsh", 7500, 7500n, 750n, 1n), LAUNCHD];
  const r = walkSummary(reused, edgesOf(reused));
  assert.deepEqual([r.wall.ordered, r.abs.ordered, r.uniqueid.ordered, r.puniqueid.chained], [false, false, false, false]);
  assert.deepEqual(r.uniqueid.before, [7001]);
  // The same unique id twice is no order (strict).
  const same = [proc(8001, 8000, "a", 1, 1n, 5n, 5n), proc(8000, 1, "b", 1, 1n, 5n, 1n)];
  assert.deepEqual(walkSummary(same, edgesOf(same)).uniqueid, { known: 1, of: 1, ordered: false, before: [8001] });
  assert.deepEqual(walkSummary(same, edgesOf(same)).wall.ordered, true, "the same start by the wall clock counts as in order");
  assert.equal(walkSummary([], []).reachedLaunchd, false);
});

// ------------------------------------------------------------------ the reads

const KNOWN = { probe: 900, connecter: 4242, grandchild: 4250 };

test("the roles of pids and of unique ids", () => {
  assert.equal(roleOf(4242, KNOWN), "connecter");
  assert.equal(roleOf(900, KNOWN), "probe");
  assert.equal(roleOf(1, KNOWN), "launchd");
  assert.equal(roleOf(0, KNOWN), "none");
  assert.equal(roleOf(77, KNOWN), "other");
  assert.equal(uniqRole(104n, { connecter: 104n, launchd: 1n }), "connecter");
  assert.equal(uniqRole(1n, { connecter: 104n, launchd: 1n }), "launchd");
  assert.equal(uniqRole(9n, { connecter: null, launchd: 1n }), "other");
  assert.equal(uniqRole(null, { launchd: 1n }), null);
});

test("a read on the Mac: LOCAL_PEERPID's role, cr_uid against the probe's, the token's pid and pid version against the kernel's", () => {
  const raw: MacRead = {
    form: "mac", peerPid: ok(pidBuf(4250)), cred: ok(xucredBuf(UID)), token: ok(tokenBuf([UID, UID, 20, UID, 20, 4250, 100007, 11250])),
    tokenProc: ok(uniqBuf(300n, 299n, 11250)), relay: { pid: 4250, uid: UID },
  };
  assert.deepEqual(readOut("afterSend", raw, KNOWN, UID), {
    at: "afterSend",
    peerPid: { pid: 4250, is: "grandchild" },
    cred: { uid: UID, own: true, version: 0, ngroups: 3 },
    token: { pid: 4250, is: "grandchild", samePidAsPeerPid: true, pidVersion: 11250, procPidVersion: 11250, versionMatches: true, euidOwn: true, ruidOwn: true },
    relay: { pid: 4250, is: "grandchild", uidOwn: true },
  });
  const other = readOut("afterExit", { ...raw, peerPid: ok(pidBuf(4242)), cred: ok(xucredBuf(0)), token: ok(tokenBuf([0, 0, 0, 0, 0, 4243, 0, 5])), tokenProc: ok(uniqBuf(1n, 1n, 6)) }, KNOWN, UID);
  assert.deepEqual(other.peerPid, { pid: 4242, is: "connecter" });
  assert.equal((other.cred as { own: boolean }).own, false);
  assert.deepEqual(other.token, { pid: 4243, is: "other", samePidAsPeerPid: false, pidVersion: 5, procPidVersion: 6, versionMatches: false, euidOwn: false, ruidOwn: false });
  // The connecter has exited: the token names no process (ESRCH), and the relay's own read still has LOCAL_PEERPID.
  const gone = readOut("afterExit", { ...raw, peerPid: ok(pidBuf(4242)), token: { err: "errno 3" }, tokenProc: null, relay: null }, KNOWN, UID);
  assert.deepEqual([gone.token, gone.relay], [{ error: "errno 3" }, null]);
  const failed = readOut("accept", { form: "mac", peerPid: { err: "errno 57" }, cred: { err: "errno 57" }, token: { err: "errno 57" }, tokenProc: null, relay: null }, KNOWN, UID);
  assert.deepEqual([failed.peerPid, failed.cred, failed.token], [{ error: "errno 57" }, { error: "errno 57" }, { error: "errno 57" }]);
  const noVersion = readOut("accept", { ...raw, tokenProc: EPERM }, KNOWN, UID);
  assert.deepEqual([(noVersion.token as { procPidVersion: unknown }).procPidVersion, (noVersion.token as { versionMatches: unknown }).versionMatches], [null, null]);
});

test("a read on Linux: SO_PEERCRED's pid and uid, no token", () => {
  const u = Buffer.alloc(12); u.writeInt32LE(4242, 0); u.writeUInt32LE(1001, 4);
  assert.deepEqual(readOut("afterSend", { form: "linux", ucred: ok(u), relay: { pid: 4242, uid: 1001 } }, KNOWN, 1001), {
    at: "afterSend", peerPid: { pid: 4242, is: "connecter" }, cred: { uid: 1001, own: true }, token: null, relay: { pid: 4242, is: "connecter", uidOwn: true },
  });
  assert.deepEqual(readOut("accept", { form: "linux", ucred: { err: "errno 9" }, relay: null }, KNOWN, 1001).peerPid, { error: "errno 9" });
});

test("Q2's summary counts the tokens, the same pids and the pid versions over every case's reads", () => {
  const raw = (pid: number, tpid: number, ver: number, kver: number): MacRead => ({
    form: "mac", peerPid: ok(pidBuf(pid)), cred: ok(xucredBuf(UID)), token: ok(tokenBuf([UID, UID, 20, UID, 20, tpid, 1, ver])), tokenProc: ok(uniqBuf(1n, 1n, kver)), relay: null,
  });
  const cases = {
    a: { reads: [readOut("accept", raw(4242, 4242, 7, 7), KNOWN, UID)] },
    b: { reads: [readOut("accept", raw(4242, 4242, 7, 7), KNOWN, UID), readOut("afterExit", { ...raw(4242, 0, 0, 0), token: { err: "errno 3" }, tokenProc: null }, KNOWN, UID), readOut("afterSend", raw(4250, 4250, 9, 8), KNOWN, UID)] },
    c: {},
  };
  assert.deepEqual(q2Of(cases), {
    fields: "val[5] the pid, val[7] the pid version (libbsm audit_token_to_pid and audit_token_to_pidversion)",
    reads: 4, tokens: 3, samePid: 3, versionKnown: 3, versionMatches: 2, errors: [{ case: "b", at: "afterExit", error: "errno 3" }],
  });
});

// ------------------------------------------------------------------ the result

const full = () => {
  const now = { abs: 6000n, wallUs: 6000 * 1e6 };
  const chain = CHAIN.map((f) => factsJson(f, now, { numer: 1, denom: 1 }));
  const edges = edgesOf(CHAIN);
  const r = readOut("accept", { form: "mac", peerPid: ok(pidBuf(4242)), cred: ok(xucredBuf(UID)), token: ok(tokenBuf([UID, UID, 20, UID, 20, 4242, 1, 7])), tokenProc: ok(uniqBuf(1n, 1n, 7)), relay: { pid: 4242, uid: UID } }, KNOWN, UID);
  const cases = Object.fromEntries(Object.entries(CASES).map(([k, how]) => [k, { how, pids: { connecter: 4242 }, reads: [r], stopped: null }]));
  return resultOf({
    meta: META, platform: { os: "darwin", arch: "arm64", node: "26.12.0", release: "25.1.0" }, ok: true, stage: "done", reason: null, ms: 1500, ownUid: UID,
    q1: { reader: "LOCAL_PEERPID, LOCAL_PEERCRED and LOCAL_PEERTOKEN (getsockopt through node:ffi)", cases },
    q2: q2Of(cases),
    q3: { ffi: { loaded: true, symbols: { getsockopt: "ok", mach_absolute_time: "ok", __error: "ok" } }, selfTest: { ok: true, form: "mac" }, clock: { timebase: { numer: 125, denom: 3 }, abs: "6000", absMs: 0, wallUs: 6e9 }, procs: CHAIN.map((f) => factsJson(f, now, { numer: 1, denom: 1 })) },
    q4: { chain, edges, summary: walkSummary(CHAIN, edges) },
    cleanup: { helpers: 7, leftAtCaseEnds: 0, leftAtEnd: 0, killedAtEnd: 0, folderRemoved: true },
  });
};

test("the result: its keys in their order, and a full Mac result passes its check", () => {
  const r = full();
  assert.deepEqual(Object.keys(r), [...RESULT_KEYS]);
  assert.equal(r.redacted, 0);
  assert.equal(r.probe, "mac-peer-probe");
  assert.equal(checkResult(r), null);
  assert.equal(TIME_LIMIT_MS, 30_000);
});

test("the result's check refuses a path, an address, a long id, a bad number, a bad key, a missing key and a result that is too big", () => {
  const at = (mutate: (r: any) => void) => { const r: any = full(); mutate(r); return checkResult(r); };
  assert.equal(at((r) => { r.q4.chain[1].name = "a/b"; }), "q4.chain[1].name");
  assert.equal(at((r) => { r.reason = "see C:\\x"; }), "reason");
  assert.equal(at((r) => { r.detail = "user@example"; }), "detail");
  assert.equal(at((r) => { r.detail = "k".repeat(41); }), "detail");
  assert.equal(at((r) => { r.detail = "k".repeat(40); }), null, "a commit's 40 hex digits pass");
  assert.equal(at((r) => { r.detail = "\u00e9"; }), "detail");
  assert.equal(at((r) => { r.ms = Number.NaN; }), "ms");
  assert.equal(at((r) => { r.q3.x = () => 1; }), "q3.x");
  assert.equal(at((r) => { r.q3["a-b"] = 1; }), "q3.<key>");
  assert.equal(at((r) => { delete r.cleanup; }), "<keys>");
  assert.equal(at((r) => { r.ok = "yes"; }), "ok");
  assert.equal(at((r) => { r.q3.procs = Array.from({ length: 2000 }, () => r.q4.chain[0]); }), "<size>");
  assert.equal(checkResult([1]), "<root>");
  for (const how of Object.values(CASES)) assert.doesNotMatch(how, /[/\\@]/);
});

test("the scrub takes the home folder, the login name and the temp folders out of every string, and counts the strings", () => {
  const r: any = full();
  r.detail = "at /srv/hm-someone/x and /var/folders/q/T/ab-pp-1";
  r.q4.chain[0].name = "someone";
  const s = scrub(r, ["/srv/hm-someone", "someone", "/var/folders/q/T", "", "ab"]);
  assert.equal(s.value.detail, "at <redacted>/x and <redacted>/ab-pp-1");
  assert.equal((s.value as any).q4.chain[0].name, "<redacted>");
  assert.equal(s.count, 2);
  assert.deepEqual(Object.keys(s.value), [...RESULT_KEYS]);
  assert.equal(s.value.ms, 1500);
  assert.equal(scrub({ a: "probe" }, ["ab"]).count, 0, "a word of fewer than 3 characters is left out");
});

// ------------------------------------------------------------------ the probe's Linux run

const run = (args: string[], env: NodeJS.ProcessEnv) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
  execFile(process.execPath, [PROBE, ...args], { cwd: ROOT, env, timeout: 60_000 }, (e, stdout, stderr) => resolve({ code: e ? ((e as { code?: number }).code ?? 1) : 0, stdout, stderr }));
});

test("the probe on Linux: its Linux twin of Q1 (SO_PEERCRED names the connecter at every read), the relay's self-test and check, ok false: not the Mac; it leaves no helper and no folder", { skip: process.platform !== "linux" }, async () => {
  const tmp = tempDir("ab-ppt-");
  try {
    const r = await run([], { ...process.env, TMPDIR: tmp });
    assert.equal(r.code, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(j), [...RESULT_KEYS]);
    assert.equal(checkResult(j), null);
    assert.deepEqual([j.ok, j.stage, j.platform.os], [false, "done", "linux"]);
    assert.match(j.reason, /^not the Mac \(linux\): Q1 ran as its Linux twin \(SO_PEERCRED\)/);
    assert.match(j.commit, /^([0-9a-f]{40}|unknown)$/);
    assert.deepEqual(Object.keys(j.q1.cases), ["a", "b", "c", "d"]);
    const ats = Object.fromEntries(Object.entries(j.q1.cases).map(([k, c]: [string, any]) => [k, c.reads.map((x: any) => x.at)]));
    assert.deepEqual(ats, { a: ["accept"], b: ["accept", "afterFork", "afterExit", "afterSend"], c: ["accept", "afterPass", "afterSend"], d: ["accept", "afterSpawn", "afterSend"] });
    for (const [k, c] of Object.entries(j.q1.cases) as [string, any][]) {
      assert.equal(c.stopped, null, `case ${k}`);
      for (const x of c.reads) {
        assert.deepEqual(x.peerPid, { pid: c.pids.connecter, is: "connecter" }, `case ${k} ${x.at}`);
        assert.deepEqual(x.cred, { uid: process.getuid!(), own: true });
        assert.equal(x.token, null);
      }
    }
    assert.deepEqual(Object.keys(j.q1.cases.b.pids), ["connecter", "grandchild"]);
    assert.deepEqual(Object.keys(j.q1.cases.c.pids), ["connecter", "receiver"]);
    assert.deepEqual(Object.keys(j.q1.cases.d.pids), ["connecter", "sender"]);
    assert.equal(j.q1.cases.b.reparent.before.ppidIs, "connecter");
    assert.notEqual(j.q1.cases.b.reparent.after.ppidIs, "connecter");
    assert.deepEqual(j.q1.cases.a.relayCheck, { ran: true, reader: "pidfd", root: "probe", hops: 1, peerRead: true, walkMet: true, admitted: true });
    assert.deepEqual(j.q3.selfTest, { ok: true, form: "pidfd" });
    assert.equal(j.q3.ffi.symbols.getsockopt, "ok");
    assert.deepEqual([j.q2, j.q4], [null, null]);
    assert.deepEqual(j.cleanup, { helpers: 7, leftAtCaseEnds: 0, leftAtEnd: 0, killedAtEnd: 0, folderRemoved: true });
    assert.ok(!r.stdout.includes(tmp) && !r.stdout.includes(homedir()), "no path of the box in the output");
    // Nothing of the probe stays: its folder in TMPDIR, and each helper's pid.
    assert.deepEqual(readdirSync(tmp), []);
    for (const c of Object.values(j.q1.cases) as any[]) for (const pid of Object.values(c.pids) as number[]) assert.equal(existsSync(`/proc/${pid}`), false, `pid ${pid} is gone`);
    assert.ok(j.ms < 15_000, `${j.ms} ms`);
  } finally { rmSync(tmp, { recursive: true, force: true }); done(tmp); }
});

test("the probe takes no argument: exit 2, and the JSON says why", async () => {
  const r = await run(["--x"], process.env);
  assert.equal(r.code, 2);
  const j = JSON.parse(r.stdout);
  assert.deepEqual([j.ok, j.stage, j.reason], [false, "args", "the probe takes no argument"]);
  assert.match(r.stderr, /usage: node test\/live\/mac-peer-probe\/probe\.ts/);
});
