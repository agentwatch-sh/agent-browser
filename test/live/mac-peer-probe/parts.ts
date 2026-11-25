// The pure parts of the Mac peer probe (probe.ts; board ab-v16.52, part 1; the T4 row of section 12 of
// docs/superpowers/specs/2026-11-05-peer-admission-design.md): the field reads of the kernel's structs (xucred,
// audit_token_t, proc_bsdinfo, proc_bsdshortinfo, proc_uniqidentifierinfo, rusage_info_v2, mach_timebase_info and
// Linux's ucred), the roles of the pids, the walk's order checks, and the result: its shape, its check (no path, no
// secret) and its scrub. No ffi, no process and no file access, so that test/mac-peer-probe.test.ts runs them on Linux
// in `npm test`.
//
// Each layout is from Apple's headers and the xnu source (apple-oss-distributions/xnu: bsd/sys/un.h, bsd/sys/ucred.h,
// bsd/sys/proc_info.h, bsd/sys/resource.h, osfmk/mach/mach_time.h; the audit token's fields as libbsm's
// audit_token_to_pid and audit_token_to_pidversion read them, and as xnu's set_security_token_task_internal fills them)
// for 64-bit macOS. The probe's run on the Mac checks each layout against the pids that it knows: the struct's own pid
// field (a read gives "pid differs" when it is not the pid asked), the token's pid against LOCAL_PEERPID, and val[7]
// against proc_uniqidentifierinfo's p_idversion of the same pid (layoutVersionMatches); and the two start clocks of each
// process of the run against each other (clocksAgree).

import { PROC_BSDINFO_SIZE, PROC_PIDTBSDINFO, SZOMB, parseBsdInfo } from "../../../src/service/mac.ts";
import { clean } from "../mac-input-probe/parts.ts";

export { PROC_BSDINFO_SIZE, PROC_PIDTBSDINFO, clean };

/** The probe's version: a change of the result's fields or of the probe's cases gives a new one. */
export const PROBE_VERSION = 2;
/** The time limit of the whole run; each helper process ends itself after HELPER_LIMIT_MS (helper.ts). */
export const TIME_LIMIT_MS = 30_000;
/** The longest wait for one step of a case (a connect, a helper's start, a byte, an exit). */
export const STEP_MS = 5_000;
/** The longest wait for a case's helpers to end by themselves at the case's end, before the probe kills the rest. */
export const END_WAIT_MS = 2_000;
/** The walk stops after this many parents (the relay's own limit is 32: MAX_HOPS of src/relay/peer.ts). */
export const MAX_WALK = 64;
/** A socket path on the Mac holds at most 103 bytes (sockaddr_un's sun_path is 104 with its NUL). */
export const MAX_SOCKET_PATH = 103;
/** The result's largest size, as JSON. */
export const RESULT_MAX_BYTES = 256 * 1024;

// bsd/sys/un.h (SOL_LOCAL and the LOCAL_ options); bsd/sys/ucred.h (struct xucred: 4 + 4 + 2 + 2 of padding + 16 * 4).
export const SOL_LOCAL = 0, LOCAL_PEERCRED = 1, LOCAL_PEERPID = 2, LOCAL_PEERTOKEN = 6;
export const XUCRED_SIZE = 76, AUDIT_TOKEN_SIZE = 32;
// Linux: SOL_SOCKET, SO_PEERCRED and struct ucred (pid, uid, gid).
export const SOL_SOCKET_LINUX = 1, SO_PEERCRED_LINUX = 17, UCRED_SIZE_LINUX = 12;
// bsd/sys/proc_info.h: the flavors and sizes beside PROC_PIDTBSDINFO (3, 136 bytes).
export const PROC_PIDT_SHORTBSDINFO = 13, PROC_SHORTBSDINFO_SIZE = 64;
export const PROC_PIDUNIQIDENTIFIERINFO = 17, PROC_UNIQIDENTIFIERINFO_SIZE = 56;
// bsd/sys/resource.h: rusage_info_v2 (160 bytes); ri_proc_start_abstime is at the same place in every version (v0 on).
export const RUSAGE_INFO_V2 = 2, RUSAGE_INFO_V2_SIZE = 160, RI_PROC_START_ABSTIME = 80;
/** MAXCOMLEN: pbi_comm and pbsi_comm hold at most 16 bytes. */
export const MAXCOMLEN = 16;

// ------------------------------------------------------------------ the calls' answers and the structs

/** A call's answer: its bytes (as long as the kernel's answer), or why it failed ("errno 1", "no symbol", "0 bytes"). */
export type Got = { b: Buffer } | { err: string };
export const gotErr = (g: Got | null): string => (g === null ? "not read" : "err" in g ? g.err : "no parse");

/** A C string of at most `length` bytes at `offset`: the bytes up to the first NUL, with every byte outside [A-Za-z0-9._+ -] as `?`; null when empty. */
export function cString(b: Buffer, offset: number, length: number): string | null {
  const raw = b.subarray(offset, offset + length);
  const end = raw.indexOf(0);
  const s = raw.subarray(0, end < 0 ? raw.length : end).toString("latin1");
  return s ? s.replace(/[^A-Za-z0-9._+ -]/g, "?") : null;
}

/** struct xucred: cr_version (0), cr_uid (4), cr_ngroups (8, a short); the groups are not read. */
export function parseXucred(b: Buffer): { version: number; uid: number; ngroups: number } | null {
  if (b.length < 12) return null;
  return { version: b.readUInt32LE(0), uid: b.readUInt32LE(4), ngroups: b.readInt16LE(8) };
}

/** Linux's struct ucred: pid (0), uid (4). */
export function parseUcred(b: Buffer): { pid: number; uid: number } | null {
  if (b.length < UCRED_SIZE_LINUX) return null;
  return { pid: b.readInt32LE(0), uid: b.readUInt32LE(4) };
}

/** audit_token_t, val[0..7]: auid, euid, egid, ruid, rgid, pid (val[5]), asid, pid version (val[7]). */
export type Token = { auid: number; euid: number; egid: number; ruid: number; rgid: number; pid: number; asid: number; pidVersion: number };
export function parseToken(b: Buffer): Token | null {
  if (b.length < AUDIT_TOKEN_SIZE) return null;
  const v = (i: number) => b.readUInt32LE(i * 4);
  return { auid: v(0), euid: v(1), egid: v(2), ruid: v(3), rgid: v(4), pid: v(5), asid: v(6), pidVersion: v(7) };
}

/** struct proc_bsdshortinfo: pbsi_pid (0), pbsi_ppid (4), pbsi_status (12), pbsi_comm (16, 16 bytes), pbsi_uid (36), pbsi_ruid (44). */
export function parseShortBsd(b: Buffer): { pid: number; ppid: number; status: number; name: string | null; uid: number; ruid: number } | null {
  if (b.length < PROC_SHORTBSDINFO_SIZE) return null;
  return { pid: b.readUInt32LE(0), ppid: b.readUInt32LE(4), status: b.readUInt32LE(12), name: cString(b, 16, MAXCOMLEN), uid: b.readUInt32LE(36), ruid: b.readUInt32LE(44) };
}

/** struct proc_uniqidentifierinfo: p_uniqueid (16), p_puniqueid (24), p_idversion (32); the executable's UUID (0) is not read. */
export function parseUniq(b: Buffer): { uniqueid: bigint; puniqueid: bigint; pidVersion: number } | null {
  if (b.length < 40) return null;
  return { uniqueid: b.readBigUInt64LE(16), puniqueid: b.readBigUInt64LE(24), pidVersion: b.readInt32LE(32) };
}

/** rusage_info_v2's ri_proc_start_abstime (80): mach_absolute_time at the fork. */
export function parseRusageStart(b: Buffer): bigint | null {
  return b.length >= RI_PROC_START_ABSTIME + 8 ? b.readBigUInt64LE(RI_PROC_START_ABSTIME) : null;
}

/** struct mach_timebase_info: numer (0), denom (4); ns = ticks * numer / denom. */
export type Timebase = { numer: number; denom: number };
export function parseTimebase(b: Buffer): Timebase | null {
  if (b.length < 8) return null;
  const numer = b.readUInt32LE(0), denom = b.readUInt32LE(4);
  return numer > 0 && denom > 0 ? { numer, denom } : null;
}
export const absNs = (ticks: bigint, tb: Timebase): bigint => (ticks * BigInt(tb.numer)) / BigInt(tb.denom);

// ------------------------------------------------------------------ a process's facts

/** What the probe reads of one process on the Mac: PROC_PIDTBSDINFO, PROC_PIDT_SHORTBSDINFO, PROC_PIDUNIQIDENTIFIERINFO and proc_pid_rusage. */
export type Gots = { bsd: Got; short: Got; uniq: Got; rusage: Got };

export type Facts = {
  pid: number;
  ppid: number | null;
  name: string | null;
  uid: number | null;
  zombie: boolean | null;
  /** pbi_start_tvsec * 1000000 + pbi_start_tvusec: the wall clock at the fork, in µs (C10's `start` on the Mac). */
  startUs: number | null;
  /** ri_proc_start_abstime, in mach_absolute_time ticks. */
  startAbs: bigint | null;
  uniqueid: bigint | null;
  puniqueid: bigint | null;
  pidVersion: number | null;
  /** Each read: "ok", or why it failed; "pid differs" when the struct's own pid field is not the pid asked (a wrong layout). */
  reads: { bsd: string; short: string; uniq: string; rusage: string };
};

/** The facts of `pid` from the four answers (pure). The name is pbi_comm, else pbsi_comm (PROC_PIDT_SHORTBSDINFO needs no permission). */
export function factsOf(pid: number, g: Gots): Facts {
  const bsdB = "b" in g.bsd ? g.bsd.b : null, shortB = "b" in g.short ? g.short.b : null;
  const bsdOk = bsdB !== null && bsdB.length >= PROC_BSDINFO_SIZE && bsdB.readUInt32LE(12) === pid;
  const bsd = bsdOk ? parseBsdInfo(bsdB) : null;
  const shortP = shortB ? parseShortBsd(shortB) : null;
  const short = shortP && shortP.pid === pid ? shortP : null;
  const uniq = "b" in g.uniq ? parseUniq(g.uniq.b) : null;
  const abs = "b" in g.rusage ? parseRusageStart(g.rusage.b) : null;
  const code = (got: Got, ok: boolean, layout: boolean) => ("err" in got ? got.err : !layout ? "pid differs" : ok ? "ok" : "no parse");
  return {
    pid,
    ppid: bsd?.ppid ?? short?.ppid ?? null,
    name: (bsd && bsdB ? cString(bsdB, 48, MAXCOMLEN) : null) ?? short?.name ?? null,
    uid: bsd?.uid ?? short?.uid ?? null,
    zombie: bsd ? bsd.status === SZOMB : short ? short.status === SZOMB : null,
    startUs: bsd?.start ?? null,
    startAbs: abs,
    uniqueid: uniq?.uniqueid ?? null,
    puniqueid: uniq?.puniqueid ?? null,
    pidVersion: uniq?.pidVersion ?? null,
    reads: {
      bsd: code(g.bsd, bsd !== null, bsdB === null || bsdB.length < PROC_BSDINFO_SIZE || bsdB.readUInt32LE(12) === pid),
      short: code(g.short, short !== null, shortP === null || shortP.pid === pid),
      uniq: code(g.uniq, uniq !== null, true),
      rusage: code(g.rusage, abs !== null, true),
    },
  };
}

/** The moment of a walk: mach_absolute_time and the wall clock (µs), read one after the other. */
export type Now = { abs: bigint | null; wallUs: number };

const str = (v: bigint | null) => (v === null ? null : v.toString());

/**
 * A process's facts as JSON: the 64-bit kernel values as decimal strings; its age by each clock in ms (null when a value
 * is missing), and their difference: the time the Mac slept (mach_absolute_time stops in sleep) plus every step of the
 * wall clock since the process started.
 */
export function factsJson(f: Facts, now: Now | null, tb: Timebase | null) {
  const ageWallMs = now && f.startUs !== null ? Math.round((now.wallUs - f.startUs) / 1000) : null;
  const ageAbsMs = now && now.abs !== null && tb && f.startAbs !== null ? Number(absNs(now.abs - f.startAbs, tb) / 1_000_000n) : null;
  return {
    pid: f.pid, ppid: f.ppid, name: f.name, uid: f.uid, zombie: f.zombie,
    startUs: f.startUs, startAbs: str(f.startAbs), uniqueid: str(f.uniqueid), puniqueid: str(f.puniqueid), pidVersion: f.pidVersion,
    ageWallMs, ageAbsMs, wallMinusAbsMs: ageWallMs !== null && ageAbsMs !== null ? ageWallMs - ageAbsMs : null,
    reads: { ...f.reads },
  };
}

/** The bound of clocksAgree: a process of the run has the same age by each clock, within this much. */
export const CLOCK_AGREE_MS = 1000;
type Ages = { ageWallMs: number | null; ageAbsMs: number | null; wallMinusAbsMs: number | null };

/**
 * A process that started during the run (the probe or a helper: younger than TIME_LIMIT_MS) has the same age by each
 * clock: by pbi_start (offsets 120 and 128) and by ri_proc_start_abstime (offset 80). True when both ages are in
 * [-CLOCK_AGREE_MS, TIME_LIMIT_MS] and they differ by at most CLOCK_AGREE_MS; false else (a wrong offset, a wrong
 * timebase, or a step of the clock or a sleep during the run); null when an age is not known.
 */
export function clocksAgree(a: Ages): boolean | null {
  if (a.ageWallMs === null || a.ageAbsMs === null || a.wallMinusAbsMs === null) return null;
  const young = (ms: number) => ms >= -CLOCK_AGREE_MS && ms <= TIME_LIMIT_MS;
  return young(a.ageWallMs) && young(a.ageAbsMs) && Math.abs(a.wallMinusAbsMs) <= CLOCK_AGREE_MS;
}

/** The summary of clocksAgree over the rows of q3.procs. */
export function clockSummary(rows: readonly { clocksAgree: boolean | null }[]) {
  return {
    boundMs: CLOCK_AGREE_MS,
    rows: rows.length,
    agree: rows.filter((r) => r.clocksAgree === true).length,
    disagree: rows.filter((r) => r.clocksAgree === false).length,
    unknown: rows.filter((r) => r.clocksAgree === null).length,
  };
}

// ------------------------------------------------------------------ the walk

/** A child's start against its parent's: after, the same, before, or null when one of them is not known. */
export type Order = "after" | "same" | "before" | null;
export function order<T extends number | bigint>(child: T | null, parent: T | null): Order {
  if (child === null || parent === null) return null;
  return child > parent ? "after" : child === parent ? "same" : "before";
}

export type Edge = {
  child: number; parent: number;
  /** By pbi_start (the wall clock), by ri_proc_start_abstime, and by p_uniqueid. */
  wall: Order; abs: Order; uniqueid: Order;
  /** The child's p_puniqueid is the parent's p_uniqueid. */
  puniqueidIsParent: boolean | null;
};

/** The edges of a chain (the probe's process first, launchd last), each child with its parent (the chain follows ppid, so each parent is its child's ppid). */
export function edgesOf(chain: readonly Facts[]): Edge[] {
  return chain.slice(0, -1).map((c, i) => {
    const p = chain[i + 1];
    return {
      child: c.pid, parent: p.pid,
      wall: order(c.startUs, p.startUs), abs: order(c.startAbs, p.startAbs), uniqueid: order(c.uniqueid, p.uniqueid),
      puniqueidIsParent: c.puniqueid !== null && p.uniqueid !== null ? c.puniqueid === p.uniqueid : null,
    };
  });
}

/** One clock's verdict over the edges: how many it knows, and the children that start before their parents by it. */
function verdict(edges: readonly Edge[], k: "wall" | "abs" | "uniqueid", strict: boolean) {
  const known = edges.filter((e) => e[k] !== null);
  const bad = known.filter((e) => e[k] === "before" || (strict && e[k] === "same")).map((e) => e.child);
  return { known: known.length, of: edges.length, ordered: known.length ? bad.length === 0 : null, before: bad };
}

/**
 * The walk's summary: whether it reached launchd (pid 1); per clock, whether each child starts at or after its parent
 * (p_uniqueid strictly after); whether each p_puniqueid is its parent's p_uniqueid; the first tmux in the chain (the
 * tmux server: a pane's process is its child) and whether its parent is launchd; the pane's process (the tmux server's
 * child in the chain).
 */
export function walkSummary(chain: readonly Facts[], edges: readonly Edge[]) {
  const t = chain.findIndex((f, i) => i > 0 && f.name !== null && /^tmux/.test(f.name));
  const chained = edges.filter((e) => e.puniqueidIsParent !== null);
  return {
    hops: Math.max(0, chain.length - 1),
    reachedLaunchd: chain.length > 0 && chain[chain.length - 1].pid === 1,
    wall: verdict(edges, "wall", false),
    abs: verdict(edges, "abs", false),
    uniqueid: verdict(edges, "uniqueid", true),
    puniqueid: { known: chained.length, of: edges.length, chained: chained.length ? chained.every((e) => e.puniqueidIsParent) : null },
    tmux: t < 0 ? null : { index: t, pid: chain[t].pid, parentIsLaunchd: chain[t].ppid === 1 },
    pane: t > 0 ? { index: t - 1, pid: chain[t - 1].pid, name: chain[t - 1].name } : null,
  };
}

// ------------------------------------------------------------------ the reads of Q1 and Q2

/** The processes of a case by their role (connecter, grandchild, receiver, sender, probe). */
export type Known = Readonly<Record<string, number>>;

/** The role of a pid: one that the case knows, launchd (1), none (0) or other. */
export function roleOf(pid: number, known: Known): string {
  if (pid === 0) return "none";
  for (const [role, p] of Object.entries(known)) if (p === pid) return role;
  return pid === 1 ? "launchd" : "other";
}

/** The role of a p_uniqueid among the known processes' p_uniqueid, or other (null: not known). */
export function uniqRole(u: bigint | null, uniqs: Readonly<Record<string, bigint | null>>): string | null {
  if (u === null) return null;
  for (const [role, v] of Object.entries(uniqs)) if (v !== null && v === u) return role;
  return "other";
}

/** One read of an accepted socket: the Mac's three options (and the p_idversion of the token's pid, read right after), or Linux's SO_PEERCRED; and the relay's own read (MacReader.cred, LinuxReader.cred). */
export type RawRead =
  | { form: "mac"; peerPid: Got; cred: Got; token: Got; tokenProc: Got | null; relay: { pid: number; uid: number } | null }
  | { form: "linux"; ucred: Got; relay: { pid: number; uid: number } | null };

/** The p_idversion of each role's process as the probe read it at that process's start (the connecter right after its spawn, before its connect; a helper at its ready file, before its byte). */
export type Started = Readonly<Record<string, number | null>>;

/**
 * A read as JSON: each pid with its role, each uid against the probe's own, and the token:
 * - layoutVersionMatches: val[7] is the p_idversion that PROC_PIDUNIQIDENTIFIERINFO gives for the token's pid right after
 *   the read (pidVersionNow). It reads one live process twice, so it checks the layout of val[7], not a reuse.
 * - sameProcessAsStarted: the token names a known role, and val[7] is the p_idversion that the probe read of that role's
 *   process at its start (startPidVersion). A pid that came back between that start and the read gives false.
 */
export function readOut(at: string, raw: RawRead, known: Known, ownUid: number, started: Started = {}) {
  const relay = raw.relay ? { pid: raw.relay.pid, is: roleOf(raw.relay.pid, known), uidOwn: raw.relay.uid === ownUid } : null;
  if (raw.form === "linux") {
    const u = "b" in raw.ucred ? parseUcred(raw.ucred.b) : null;
    const why = gotErr(raw.ucred);
    return { at, peerPid: u ? { pid: u.pid, is: roleOf(u.pid, known) } : { error: why }, cred: u ? { uid: u.uid, own: u.uid === ownUid } : { error: why }, token: null, relay };
  }
  const pid = "b" in raw.peerPid && raw.peerPid.b.length >= 4 ? raw.peerPid.b.readInt32LE(0) : null;
  const cred = "b" in raw.cred ? parseXucred(raw.cred.b) : null;
  const tok = "b" in raw.token ? parseToken(raw.token.b) : null;
  const ver = raw.tokenProc && "b" in raw.tokenProc ? parseUniq(raw.tokenProc.b)?.pidVersion ?? null : null;
  const role = tok ? roleOf(tok.pid, known) : null;
  const start = role !== null && Object.hasOwn(started, role) ? started[role] : null;
  return {
    at,
    peerPid: pid !== null ? { pid, is: roleOf(pid, known) } : { error: gotErr(raw.peerPid) },
    cred: cred ? { uid: cred.uid, own: cred.uid === ownUid, version: cred.version, ngroups: cred.ngroups } : { error: gotErr(raw.cred) },
    token: tok
      ? {
        pid: tok.pid, is: role!, samePidAsPeerPid: pid === tok.pid, pidVersion: tok.pidVersion,
        pidVersionNow: ver, layoutVersionMatches: ver === null ? null : ver === tok.pidVersion,
        startPidVersion: start, sameProcessAsStarted: start === null ? null : start === tok.pidVersion,
        euidOwn: tok.euid === ownUid, ruidOwn: tok.ruid === ownUid,
      }
      : { error: gotErr(raw.token) },
    relay,
  };
}
export type ReadOut = ReturnType<typeof readOut>;

/**
 * Q2's summary over every read of Q1: how many tokens read and gave LOCAL_PEERPID's pid; the layout check of val[7]
 * (layoutVersionMatches); the compare with each role's start (sameProcessAsStarted); and for each case, whether the token
 * at the accept names the connecter as the probe read it after its spawn (acceptNamesConnecter: its pid and its
 * p_idversion; null when that read gave no token or no start).
 */
export function q2Of(cases: Readonly<Record<string, { reads?: readonly ReadOut[] }>>) {
  let reads = 0, tokens = 0, samePid = 0, layoutKnown = 0, layoutMatches = 0, startKnown = 0, sameProcess = 0;
  const errors: { case: string; at: string; error: string }[] = [];
  const acceptNamesConnecter: Record<string, boolean | null> = {};
  for (const [k, c] of Object.entries(cases)) {
    acceptNamesConnecter[k] = null;
    for (const r of c.reads ?? []) {
      reads++;
      const t = r.token;
      if (t === null) continue;
      if ("error" in t && t.error !== undefined) { errors.push({ case: k, at: r.at, error: t.error }); continue; }
      tokens++;
      if (t.samePidAsPeerPid) samePid++;
      if (t.layoutVersionMatches != null) { layoutKnown++; if (t.layoutVersionMatches) layoutMatches++; }
      if (t.sameProcessAsStarted != null) { startKnown++; if (t.sameProcessAsStarted) sameProcess++; }
      if (r.at === "accept") acceptNamesConnecter[k] = t.is !== "connecter" ? false : t.sameProcessAsStarted ?? null;
    }
  }
  return {
    fields: "val[5] the pid, val[7] the pid version (libbsm audit_token_to_pid and audit_token_to_pidversion)",
    reads, tokens, samePid, layoutKnown, layoutMatches, startKnown, sameProcess, acceptNamesConnecter, errors,
  };
}

// ------------------------------------------------------------------ the result

export type Meta = { version: number; commit: string; dirty: boolean | null };
export type Platform = { os: string; arch: string; node: string; release: string };

/** The cases of Q1, in their order, and what each does (the result's `how`). */
export const CASES = {
  a: "a child process connects",
  b: "a child connects, then starts a grandchild with the socket as its fd 3 (node's spawn: libuv's posix_spawn or fork and exec), then exits; the grandchild, an orphan now, writes one byte",
  c: "a child connects and passes the socket to its own child, the receiver, over Node's IPC channel (send with the socket: libuv's sendmsg with SCM_RIGHTS, no helper program); Node closes the child's copy after the receiver's ACK; the receiver writes one byte",
  d: "a child connects and starts a sender with the socket as its stdout (fd 1); the sender writes one byte; the child stays",
} as const;
export type CaseName = keyof typeof CASES;

/**
 * The calls on the socket of each case's new holder before the read between the accept and the byte (the result's
 * `holderCalls`; from the Node and libuv source, not measured). In the xnu source none of these calls sets last_pid.
 */
export const HOLDER_CALLS: Record<CaseName, string | null> = {
  a: null,
  b: "before afterFork the grandchild makes no call on its fd 3 (the start of Node reads fds 0 to 2 only)",
  c: "before afterPass the receiver's libuv calls getsockname and getsockopt SO_TYPE on the socket (uv__handle_type) and on the Mac setsockopt SO_OOBINLINE (uv__stream_open); the child's copy closes at the receiver's NODE_HANDLE_ACK",
  d: "before afterSpawn the start of the sender's Node calls fstat, fcntl F_GETFL and uv_guess_handle (getsockopt SO_TYPE, getsockname) on its fd 1, the socket; the child keeps its copy",
};

/** The result, with its keys in a fixed order. `ok` is true only when every part ran and nothing of the probe stayed. */
export function resultOf(o: {
  meta: Meta; platform: Platform | null; ok: boolean; stage: string; reason: string | null; detail?: string | null; ms: number;
  ownUid: number | null; q1: unknown; q2: unknown; q3: unknown; q4: unknown; cleanup: unknown;
}) {
  return {
    probe: "mac-peer-probe", version: o.meta.version, commit: o.meta.commit, dirty: o.meta.dirty,
    ok: o.ok, stage: o.stage, reason: o.reason, detail: o.detail ?? null, ms: o.ms,
    platform: o.platform, ownUid: o.ownUid,
    q1: o.q1 ?? null, q2: o.q2 ?? null, q3: o.q3 ?? null, q4: o.q4 ?? null, cleanup: o.cleanup ?? null,
    /** The count of strings that the scrub changed (the probe sets it). */
    redacted: 0,
  };
}

const obj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** The top-level keys of every result, in their order. */
export const RESULT_KEYS = ["probe", "version", "commit", "dirty", "ok", "stage", "reason", "detail", "ms", "platform", "ownUid", "q1", "q2", "q3", "q4", "cleanup", "redacted"] as const;

/**
 * The result's check: the top-level keys of resultOf; every value a finite number, a flag, null, or a string of at most
 * 300 printable ASCII characters with no `/`, `\` or `@` (so no path, URL or address) and no run of 41 or more letters
 * and digits (no long id, no key); every key a short word; at most RESULT_MAX_BYTES. Null when it passes, else the place
 * of the first value that fails.
 */
export function checkResult(result: unknown): string | null {
  const walk = (v: unknown, at: string): string | null => {
    if (v === null || typeof v === "boolean") return null;
    if (typeof v === "number") return Number.isFinite(v) ? null : at;
    if (typeof v === "string") return /^[\x20-\x7e]{0,300}$/.test(v) && !/[/\\@]/.test(v) && !/[A-Za-z0-9_+=-]{41,}/.test(v) ? null : at;
    if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) { const bad = walk(v[i], `${at}[${i}]`); if (bad) return bad; } return null; }
    if (obj(v)) {
      for (const [k, x] of Object.entries(v)) {
        if (!/^[A-Za-z0-9_]{1,32}$/.test(k)) return `${at}.<key>`;
        const bad = walk(x, at ? `${at}.${k}` : k);
        if (bad) return bad;
      }
      return null;
    }
    return at || "<root>";
  };
  if (!obj(result)) return "<root>";
  const keys = Object.keys(result);
  if (keys.length !== RESULT_KEYS.length || keys.some((k, i) => k !== RESULT_KEYS[i])) return "<keys>";
  if (typeof result.ok !== "boolean") return "ok";
  const bad = walk(result, "");
  if (bad) return bad;
  return Buffer.byteLength(JSON.stringify(result)) <= RESULT_MAX_BYTES ? null : "<size>";
}

/**
 * The scrub: each string value with every `words` item (the home folder, the login name, the temp folders; items of
 * fewer than 3 characters are left out) as `<redacted>`, and the count of the strings that changed. Keys and numbers do
 * not change.
 */
export function scrub<T>(value: T, words: readonly string[]): { value: T; count: number } {
  const ws = [...new Set(words.filter((w) => typeof w === "string" && w.length >= 3))].sort((a, b) => b.length - a.length);
  let count = 0;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      let s = v;
      for (const w of ws) s = s.split(w).join("<redacted>");
      if (s !== v) count++;
      return s;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (obj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return { value: walk(value) as T, count };
}
