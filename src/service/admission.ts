// The control door's admission on Linux (contract C12, "Who connects: only the agentwatch daemon process itself" and
// "The daemon's expected command"; the daemon lead's R1 and m1; board ab-v16.94.2). At each accept the service reads
// the peer (SO_PEERCRED and SO_PEERPIDFD, through the relay's peer reader) and admits it only when all of these hold:
//
//   1. the MainPID of agentwatch's unit comes from the user's systemd at this accept, and the service holds a pidfd
//      of it (pidfd_open);
//   2. the peer is the MainPID, or a direct child of it whose parent has the MainPID's start time; never the
//      service's own pid;
//   3. the peer's /proc/<pid>/exe is the file's interpreter, and its /proc/<pid>/cmdline from argv[1] on is the file's
//      args (the file: agentwatch's install writes it; the service reads it at each accept);
//   4. the peer is the same process during the whole check (its pidfd, its start time before and after, not earlier
//      than its parent's), and the MainPID read again after the checks is the same (and its pidfd still names it).
//
// A peer that fails a rule gets C12's refused line, which names the rule. When the check cannot run (no systemd
// answer, no unit, no peer reader, no pidfd_open, a kernel with no SO_PEERPIDFD) the door refuses: it never admits by
// a weaker rule.
//
// The Mac (board ab-v16.94.6; C12, "On the Mac"; not run on a Mac yet): the peer comes from LOCAL_PEERTOKEN and
// LOCAL_PEERCRED with its start time at the accept, when the p_idversion of its pid is the token's pid version (the
// relay's Mac reader; board ab-v16.52), the MainPID from `launchctl print gui/<uid>/<agentwatch's label>` (its `pid`
// line), the parent and the start times from proc_pidinfo, the command line from sysctl's KERN_PROCARGS2 and the
// executable from proc_pidpath (src/service/mac.ts). The Mac has no pidfd: rule 1 reads the MainPID's start time, and
// rule 4 reads the peer's and the MainPID's start times again after the checks, and orders the peer after its parent by
// p_uniqueid, not by the start times (board ab-v16.52). No clock takes part.
//
// The carrier of the agent door (stage 5 T4, board ab-v16.94.7.5; C11, "The remote MCP path (stage 5)"): the same rules 1
// to 4 with the gateway's job in place of agentwatch's unit and the gateway's command file in place of the daemon's
// (carrierAdmission), and their own refusal texts. A peer that fails the carrier rule is no carrier: it stays local.
//
// node:ffi is experimental in Node 26: only `agent-browser service` loads it, here (pidfd_open) and in the relay's
// self-test (the peer reader), each by a dynamic import at the service's start.

import { execFile } from "node:child_process";
import { closeSync, constants, fstatSync, openSync, readFileSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { Socket } from "node:net";
import type { Admit } from "./control.ts";
import { readPeer, type PeerReader } from "../relay/peer.ts";

/** The refused line's reason when the MainPID cannot be read (m1): the vectors' text. */
export const REFUSED_NO_MAINPID = "The control door cannot read the MainPID of agentwatch's unit, so it admits no connection.";
export const refusedRule = (n: 1 | 2 | 3 | 4, why: string) => `The control door admits only the agentwatch daemon process: rule ${n} failed (${why}).`;
export const refusedCannotRead = (why: string) => `The control door cannot read the program that connects (${why}), so it admits no connection.`;

/** The carrier rule's own texts (C11, the remote MCP path): why a peer of the agent door is no carrier. */
export const CARRIER_NO_PID = "The agent door cannot read the pid of the gateway's job, so it has no carrier.";
export const carrierRefused = (n: 1 | 2 | 3 | 4, why: string) => `The agent door's carrier is only the gateway's process: rule ${n} failed (${why}).`;
export const carrierCannotRead = (why: string) => `The agent door cannot read the program that connects (${why}), so it has no carrier.`;

/** The texts of one admission: the control door's (the daemon) or the agent door's carrier (the gateway). */
type Texts = {
  noMain: string;
  rule: (n: 1 | 2 | 3 | 4, why: string) => string;
  cannotRead: (why: string) => string;
  door: string;
  why: {
    noPidfd: string; noMainProc: string; self: string; parent: string; parentStart: string; command: string; exe: string;
    peer: string; peerRead: string; mainPid: string; file: (why: string) => string;
  };
};

const WHY: Texts["why"] = {
  noPidfd: "the service cannot hold a pidfd of the MainPID",
  noMainProc: "the service cannot read the start time of the MainPID",
  self: "it is the service itself",
  parent: "its parent is not the MainPID of agentwatch's unit",
  parentStart: "its parent's start time is not the MainPID's",
  command: "its command line is not the daemon's command",
  exe: "its executable is not the interpreter of the daemon's command",
  peer: "the peer changed during the check",
  peerRead: "the service cannot read the peer and hold its pidfd",
  mainPid: "the MainPID changed during the check",
  file: (why: string) => `the file of the daemon's expected command ${why}`,
};
const DAEMON_TEXTS: Texts = { noMain: REFUSED_NO_MAINPID, rule: refusedRule, cannotRead: refusedCannotRead, door: "the control door's check", why: WHY };
/** The carrier's reasons (C11, the remote MCP path): the gateway's job and its command file. */
export const CARRIER_WHY: Texts["why"] = {
  noPidfd: "the service cannot hold a pidfd of the gateway job's pid",
  noMainProc: "the service cannot read the start time of the gateway job's pid",
  self: "it is the service itself",
  parent: "its parent is not the gateway job's pid",
  parentStart: "its parent's start time is not the gateway job's",
  command: "its command line is not the gateway's command",
  exe: "its executable is not the interpreter of the gateway's command",
  peer: "the peer changed during the check",
  peerRead: "the service cannot read the peer and hold its pidfd",
  mainPid: "the gateway job's pid changed during the check",
  file: (why: string) => `the file of the gateway's command ${why}`,
};
const CARRIER_TEXTS: Texts = { noMain: CARRIER_NO_PID, rule: carrierRefused, cannotRead: carrierCannotRead, door: "the carrier rule", why: CARRIER_WHY };

// ------------------------------------------------------------------ the daemon's expected command (rule 3's file)

/** The file's content: the resolved interpreter and the daemon's command line from argv[1] on. */
export type ExpectedCommand = { interpreter: string; args: string[] };

/** The default path (C12): $XDG_CONFIG_HOME/agent-browser/daemon-command.json, with ~/.config when it is not set. */
export function defaultDaemonCommandFile(env: Record<string, string | undefined> = process.env, home = homedir()): string {
  const base = env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : join(home, ".config");
  return join(base, "agent-browser", "daemon-command.json");
}

/** C12's format: {"v":1,"interpreter":"<absolute path>","args":["<argument>",...]}; a key it does not know is ignored. The error text, else the command. */
export function parseExpectedCommand(text: string): ExpectedCommand | string {
  let o: unknown;
  try { o = JSON.parse(text); } catch { return "is not JSON"; }
  if (o === null || typeof o !== "object" || Array.isArray(o)) return "is not a JSON object";
  const f = o as Record<string, unknown>;
  if (f.v !== 1) return "breaks the format: v is not 1";
  if (typeof f.interpreter !== "string" || !isAbsolute(f.interpreter)) return "breaks the format: interpreter is not an absolute path";
  if (!Array.isArray(f.args) || !f.args.every((a) => typeof a === "string")) return "breaks the format: args is not a list of strings";
  return { interpreter: f.interpreter, args: [...f.args] };
}

/**
 * Read the file at an accept: a regular file (not a link) of the service's user that its group and others cannot
 * write. One open, with no link followed (O_NOFOLLOW) and no wait for a writer of a FIFO (O_NONBLOCK), and fstat on
 * the same fd: the file that the service checks is the file that it reads.
 */
export function readExpectedCommand(path: string, uid: number): ExpectedCommand | string {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (e) {
    const code = (e as { code?: string }).code;
    return code === "ELOOP" ? "is not a regular file (it is a link)" : `cannot be read (${code ?? "error"})`;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return "is not a regular file";
    if (st.uid !== uid) return "is not owned by the service's user";
    if ((st.mode & 0o022) !== 0) return "is writable by its group or by others";
    let text: string;
    try { text = readFileSync(fd, "utf8"); } catch (e) { return `cannot be read (${(e as { code?: string }).code ?? "error"})`; }
    return parseExpectedCommand(text);
  } finally { closeSync(fd); }
}

// ------------------------------------------------------------------ the MainPID (rule 1)

/**
 * The MainPID of agentwatch's unit from the user's systemd: `systemctl --user show --property=MainPID --value <unit>`.
 * A pid, 0 for a unit with no process (or no such unit), null when the query fails or gives no number in time.
 */
export function systemdMainPid(unit: string, o: { systemctl?: string; timeoutMs?: number } = {}): Promise<number | null> {
  return new Promise((resolve) => {
    execFile(o.systemctl ?? "/usr/bin/systemctl", ["--user", "show", "--property=MainPID", "--value", unit], { timeout: o.timeoutMs ?? 2000, killSignal: "SIGKILL", encoding: "utf8" }, (e, stdout) => {
      const s = String(stdout ?? "").trim();
      resolve(!e && /^\d+$/.test(s) && Number.isSafeInteger(Number(s)) ? Number(s) : null);
    });
  });
}

/** pidfd_open(2) through node:ffi (glibc 2.36 and later): a pidfd, or -1. */
export async function loadPidfdOpen(): Promise<{ open: (pid: number) => number } | { failed: string }> {
  if (process.platform !== "linux") return { failed: `no pidfd on ${process.platform}` };
  let ffi: any;
  try { const mod: any = await import("node:ffi"); ffi = mod.default ?? mod; }
  catch (e) { return { failed: `node:ffi does not load (${(e as { code?: string }).code ?? (e as Error).message})` }; }
  try {
    const { functions: f } = ffi.dlopen("libc.so.6", { pidfd_open: { return: "int32", arguments: ["int32", "uint32"] } });
    return { open: (pid: number) => f.pidfd_open(pid, 0) };
  } catch (e) { return { failed: `pidfd_open does not load: ${(e as Error).message}` }; }
}

// ------------------------------------------------------------------ the check

/** /proc/<pid>/cmdline as the bytes of each argument, or null. The file ends with a NUL; an empty argument stays. */
export function readCmdline(pid: number): Buffer[] | null {
  let raw: Buffer;
  try { raw = readFileSync(`/proc/${pid}/cmdline`); } catch { return null; }
  if (raw.length === 0) return null;
  const body = raw[raw.length - 1] === 0 ? raw.subarray(0, -1) : raw;
  const out: Buffer[] = [];
  for (let at = 0; ;) {
    const nul = body.indexOf(0, at);
    if (nul < 0) { out.push(body.subarray(at)); return out; }
    out.push(body.subarray(at, nul)); at = nul + 1;
  }
}
/** The bytes of the target of /proc/<pid>/exe (a resolved path), or null. */
export function readExe(pid: number): Buffer | null {
  try { return readlinkSync(`/proc/${pid}/exe`, { encoding: "buffer" }); } catch { return null; }
}
/** The same bytes as the UTF-8 of `text`: the file's strings against the kernel's bytes, with no lossy decoding. */
const same = (bytes: Buffer, text: string) => bytes.equals(Buffer.from(text, "utf8"));

export type AdmissionDeps = {
  /** The relay's peer reader from its self-test, or why it failed. */
  reader: PeerReader | { failed: string };
  pidfd: { open: (pid: number) => number } | { failed: string };
  mainPid: () => Promise<number | null>;
  /** The Mac's reads of a process (src/service/mac.ts, MacProcs): KERN_PROCARGS2's argv and proc_pidpath's executable, or why they failed. */
  mac?: { argv(pid: number): Buffer[] | null; exe(pid: number): Buffer | null } | { failed: string };
  /** The path of the expected command's file. */
  commandFile: string;
  uid?: number;
  selfPid?: number;
  platform?: NodeJS.Platform;
};

export type Verdict = { ok: true; pid: number } | { ok: false; reason: string };

/** The admission of C12 for the control door: it reads the peer at the accept, then checks rules 1 to 4. */
export function daemonAdmission(d: AdmissionDeps): Admit { return peerAdmission(d, DAEMON_TEXTS); }

/**
 * The carrier rule of the agent door (stage 5 T4; C11, the remote MCP path): rules 1 to 4 with the gateway's job (its pid
 * from `mainPid`) and the gateway's command file (`commandFile`, in the form of the daemon's expected command), with the
 * carrier's own texts. A peer that passes is the carrier; every other peer stays local.
 */
export function carrierAdmission(d: AdmissionDeps): (socket: Socket) => Promise<Verdict> { return peerAdmission(d, CARRIER_TEXTS); }

function peerAdmission(d: AdmissionDeps, T: Texts): (socket: Socket) => Promise<Verdict> {
  const uid = d.uid ?? process.getuid!();
  const self = d.selfPid ?? process.pid;
  const platform = d.platform ?? process.platform;
  const WHY = T.why, refusedRule = T.rule, refusedCannotRead = T.cannotRead, REFUSED_NO_MAINPID = T.noMain;
  return async (socket: Socket): Promise<Verdict> => {
    if (platform === "darwin") return admitMac(d, socket, uid, self, T);
    if (platform !== "linux") return { ok: false, reason: refusedCannotRead(`${T.door} is not built for ${platform} yet (stage 4)`) };
    if ("failed" in d.reader) return { ok: false, reason: refusedCannotRead(d.reader.failed) };
    if ("failed" in d.pidfd) return { ok: false, reason: refusedCannotRead(d.pidfd.failed) };
    const reader = d.reader, pidfd = d.pidfd;
    if (reader.form !== "pidfd") return { ok: false, reason: refusedCannotRead("this kernel gives no pidfd of a peer (SO_PEERPIDFD)") };
    // The peer at the accept: SO_PEERCRED and SO_PEERPIDFD, before the service reads any byte.
    const fd = (socket as unknown as { _handle?: { fd?: unknown } })._handle?.fd;
    const peer = typeof fd === "number" && fd >= 0 ? readPeer(reader, fd, uid) : null;
    if (!peer || peer.pidfd === null) { peer?.release(reader); return { ok: false, reason: refusedRule(4, WHY.peerRead) }; }
    const before = reader.proc(peer.pid);
    let mainFd = -1;
    try {
      if (!before) return { ok: false, reason: refusedRule(4, WHY.peerRead) };
      const peerAlive = () => reader.poll(peer.pidfd!) === 0 && reader.fdinfoPid(peer.pidfd!) === peer.pid;
      // Rule 1: the MainPID at this accept, and a pidfd of it.
      const main = await d.mainPid();
      if (main === null || main <= 0) return { ok: false, reason: REFUSED_NO_MAINPID };
      mainFd = pidfd.open(main);
      const mainProc = mainFd >= 0 ? reader.proc(main) : null;
      if (mainFd < 0 || !mainProc || reader.fdinfoPid(mainFd) !== main) return { ok: false, reason: refusedRule(1, WHY.noPidfd) };
      // Rule 2: the MainPID itself, or its direct child (the parent's start time is the MainPID's); never the service.
      // Rule 3: the file of this accept; the executable and argv[1:]. A read that fails because the peer is gone is rule 4.
      const refused = rules2and3(d, T, {
        peer: peer.pid, ppid: before.ppid, main, mainStart: mainProc.start, self, uid, parentStart: (pid) => reader.proc(pid)?.start ?? null,
        exe: readExe(peer.pid), argv: readCmdline(peer.pid), gone: () => !peerAlive(),
      });
      if (refused) return refused;
      // Rule 4: the MainPID again, then the same peer (its pidfd, its start time, not earlier than its parent's) and the same MainPID's process.
      const again = await d.mainPid();
      if (again !== main) return { ok: false, reason: refusedRule(4, WHY.mainPid) };
      const after = reader.proc(peer.pid);
      const parentStart = peer.pid === main ? reader.proc(before.ppid)?.start ?? null : mainProc.start;
      if (!after || after.start !== before.start || after.ppid !== before.ppid || after.state === "Z" || !peerAlive() || parentStart === null || before.start < parentStart) return { ok: false, reason: refusedRule(4, WHY.peer) };
      if (reader.poll(mainFd) !== 0 || reader.fdinfoPid(mainFd) !== main) return { ok: false, reason: refusedRule(4, WHY.mainPid) };
      return { ok: true, pid: peer.pid };
    } finally {
      if (mainFd >= 0) reader.close(mainFd);
      peer.release(reader);
    }
  };
}

/** Rules 2 and 3, the same on Linux and the Mac: the MainPID or its direct child (the parent's start time is the MainPID's), never the service; the file's interpreter and args. */
function rules2and3(d: AdmissionDeps, T: Texts, o: { peer: number; ppid: number; main: number; mainStart: number; self: number; uid: number; parentStart: (pid: number) => number | null; exe: Buffer | null; argv: Buffer[] | null; gone: () => boolean }): Verdict | null {
  const WHY = T.why, refusedRule = T.rule;
  if (o.peer === o.self) return { ok: false, reason: refusedRule(2, WHY.self) };
  if (o.peer !== o.main) {
    if (o.ppid !== o.main) return { ok: false, reason: refusedRule(2, WHY.parent) };
    if (o.parentStart(o.ppid) !== o.mainStart) return { ok: false, reason: refusedRule(2, WHY.parentStart) };
  }
  const expected = readExpectedCommand(d.commandFile, o.uid);
  if (typeof expected === "string") return { ok: false, reason: refusedRule(3, WHY.file(expected)) };
  if (o.exe === null || o.argv === null) return { ok: false, reason: o.gone() ? refusedRule(4, WHY.peer) : refusedRule(3, WHY.command) };
  if (!same(o.exe, expected.interpreter)) return { ok: false, reason: refusedRule(3, WHY.exe) };
  const args = o.argv.slice(1);
  if (args.length !== expected.args.length || args.some((a, i) => !same(a, expected.args[i]))) return { ok: false, reason: refusedRule(3, WHY.command) };
  return null;
}

/**
 * The Mac's admission (C12, "On the Mac"): the peer of LOCAL_PEERTOKEN with its start time at the accept (the relay's
 * reader: the p_idversion of the token's pid is the token's pid version); rule 1 the job's pid from launchctl and its
 * start time (proc_pidinfo); rules 2 and 3 as on Linux, with KERN_PROCARGS2 and proc_pidpath; rule 4 the peer's start
 * time and parent again (the same as at the accept, no zombie), the peer after its parent by p_uniqueid (board
 * ab-v16.52), and the job's pid and its start time again.
 */
async function admitMac(d: AdmissionDeps, socket: Socket, uid: number, self: number, T: Texts): Promise<Verdict> {
  const WHY = T.why, refusedRule = T.rule, refusedCannotRead = T.cannotRead, REFUSED_NO_MAINPID = T.noMain;
  if ("failed" in d.reader) return { ok: false, reason: refusedCannotRead(d.reader.failed) };
  if (!d.mac || "failed" in d.mac) return { ok: false, reason: refusedCannotRead(d.mac ? d.mac.failed : "no reader of a process's command line") };
  const reader = d.reader, mac = d.mac;
  if (reader.form !== "mac") return { ok: false, reason: refusedCannotRead("the peer reader is not the Mac's") };
  const fd = (socket as unknown as { _handle?: { fd?: unknown } })._handle?.fd;
  const peer = typeof fd === "number" && fd >= 0 ? readPeer(reader, fd, uid) : null;
  const before = peer ? reader.proc(peer.pid) : null;
  if (!peer || peer.start === null || !before || before.start !== peer.start || before.state === "Z") return { ok: false, reason: refusedRule(4, WHY.peerRead) };
  const sameProc = (pid: number, start: number, ppid?: number) => { const p = reader.proc(pid); return p !== null && p.start === start && p.state !== "Z" && (ppid === undefined || p.ppid === ppid); };
  // Rule 1: the job's pid at this accept, and its start time (the Mac has no pidfd).
  const main = await d.mainPid();
  if (main === null || main <= 0) return { ok: false, reason: REFUSED_NO_MAINPID };
  const mainProc = reader.proc(main);
  if (!mainProc || mainProc.state === "Z") return { ok: false, reason: refusedRule(1, WHY.noMainProc) };
  const refused = rules2and3(d, T, {
    peer: peer.pid, ppid: before.ppid, main, mainStart: mainProc.start, self, uid, parentStart: (pid) => reader.proc(pid)?.start ?? null,
    exe: mac.exe(peer.pid), argv: mac.argv(peer.pid), gone: () => !sameProc(peer.pid, before.start, before.ppid),
  });
  if (refused) return refused;
  // Rule 4: the job's pid again, then the same peer (its start time and parent, not earlier than its parent's) and the same job's process.
  if ((await d.mainPid()) !== main) return { ok: false, reason: refusedRule(4, WHY.mainPid) };
  // The order is p_uniqueid (board ab-v16.52): the parent's must be earlier than the peer's, whatever the clock did.
  // The job's own pid has launchd (pid 1) as its parent, whose PROC_PIDTBSDINFO another user cannot read (xnu's
  // CHECK_SAME_USER); its p_uniqueid can be read (`order`), and it is 1 (measured), so launchd is earlier than every
  // peer. A read with no order (a reader that is not the Mac's) fails closed.
  const parentOrder = peer.pid === main ? reader.order?.(before.ppid) ?? null : mainProc.order ?? null;
  const ordered = parentOrder !== null && before.order !== undefined && parentOrder <= before.order;
  if (!sameProc(peer.pid, before.start, before.ppid) || !ordered) return { ok: false, reason: refusedRule(4, WHY.peer) };
  if (!sameProc(main, mainProc.start)) return { ok: false, reason: refusedRule(4, WHY.mainPid) };
  return { ok: true, pid: peer.pid };
}
