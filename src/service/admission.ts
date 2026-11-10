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
// a weaker rule. The Mac (stage 4) is not built: there the door refuses each connection.
//
// node:ffi is experimental in Node 26: only `agent-browser service` loads it, here (pidfd_open) and in the relay's
// self-test (the peer reader), each by a dynamic import at the service's start.

import { execFile } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { Socket } from "node:net";
import type { Admit } from "./control.ts";
import { readPeer, type PeerReader } from "../relay/peer.ts";

/** The refused line's reason when the MainPID cannot be read (m1): the vectors' text. */
export const REFUSED_NO_MAINPID = "The control door cannot read the MainPID of agentwatch's unit, so it admits no connection.";
export const refusedRule = (n: 1 | 2 | 3 | 4, why: string) => `The control door admits only the agentwatch daemon process: rule ${n} failed (${why}).`;
export const refusedCannotRead = (why: string) => `The control door cannot read the program that connects (${why}), so it admits no connection.`;

const WHY = {
  noPidfd: "the service cannot hold a pidfd of the MainPID",
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

/** Read the file at an accept: a regular file (not a link) of the service's user that its group and others cannot write. */
export function readExpectedCommand(path: string, uid: number): ExpectedCommand | string {
  let st;
  try { st = lstatSync(path); } catch (e) { return `cannot be read (${(e as { code?: string }).code ?? "error"})`; }
  if (!st.isFile()) return "is not a regular file";
  if (st.uid !== uid) return "is not owned by the service's user";
  if ((st.mode & 0o022) !== 0) return "is writable by its group or by others";
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch (e) { return `cannot be read (${(e as { code?: string }).code ?? "error"})`; }
  return parseExpectedCommand(text);
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
  /** The path of the expected command's file. */
  commandFile: string;
  uid?: number;
  selfPid?: number;
  platform?: NodeJS.Platform;
};

type Verdict = { ok: true; pid: number } | { ok: false; reason: string };

/** The admission of C12 for the control door: it reads the peer at the accept, then checks rules 1 to 4. */
export function daemonAdmission(d: AdmissionDeps): Admit {
  const uid = d.uid ?? process.getuid!();
  const self = d.selfPid ?? process.pid;
  const platform = d.platform ?? process.platform;
  return async (socket: Socket): Promise<Verdict> => {
    if (platform !== "linux") return { ok: false, reason: refusedCannotRead(`the control door's check is not built for ${platform} yet (stage 4)`) };
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
      if (peer.pid === self) return { ok: false, reason: refusedRule(2, WHY.self) };
      if (peer.pid !== main) {
        if (before.ppid !== main) return { ok: false, reason: refusedRule(2, WHY.parent) };
        const parent = reader.proc(before.ppid);
        if (!parent || parent.start !== mainProc.start) return { ok: false, reason: refusedRule(2, WHY.parentStart) };
      }
      // Rule 3: the file of this accept; the executable and argv[1:]. A read that fails because the peer is gone is rule 4.
      const expected = readExpectedCommand(d.commandFile, uid);
      if (typeof expected === "string") return { ok: false, reason: refusedRule(3, WHY.file(expected)) };
      const exe = readExe(peer.pid), argv = readCmdline(peer.pid);
      if (exe === null || argv === null) return { ok: false, reason: peerAlive() ? refusedRule(3, WHY.command) : refusedRule(4, WHY.peer) };
      if (!same(exe, expected.interpreter)) return { ok: false, reason: refusedRule(3, WHY.exe) };
      const args = argv.slice(1);
      if (args.length !== expected.args.length || args.some((a, i) => !same(a, expected.args[i]))) return { ok: false, reason: refusedRule(3, WHY.command) };
      // Rule 4: the MainPID again, then the same peer (its pidfd, its start time, not earlier than its parent's) and the same MainPID's process.
      const again = await d.mainPid();
      if (again !== main) return { ok: false, reason: refusedRule(4, WHY.mainPid) };
      const after = reader.proc(peer.pid);
      const parentStart = peer.pid === main ? reader.proc(before.ppid)?.start ?? null : mainProc.start;
      if (!after || after.start !== before.start || after.state === "Z" || !peerAlive() || parentStart === null || before.start < parentStart) return { ok: false, reason: refusedRule(4, WHY.peer) };
      if (reader.poll(mainFd) !== 0 || reader.fdinfoPid(mainFd) !== main) return { ok: false, reason: refusedRule(4, WHY.mainPid) };
      return { ok: true, pid: peer.pid };
    } finally {
      if (mainFd >= 0) reader.close(mainFd);
      peer.release(reader);
    }
  };
}
