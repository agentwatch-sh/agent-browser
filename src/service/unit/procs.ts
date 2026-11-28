// The reads of /proc that the Chrome unit needs (board ab-v16.94.3; the reads of agentwatch's daemon/browser/unit.py and
// stop_unit.py). A process is known by its pid AND its start time (field 22 of /proc/<pid>/stat, in clock ticks since the
// boot), so a reused pid is never taken for the unit's process. Each read takes `root` (a test gives a fake /proc).

import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { basename, join } from "node:path";

export type Stat = { state: string; ppid: number; pgrp: number; start: number };

/** The kernel's flag of a process in its exit (include/linux/sched.h). */
const PF_EXITING = 0x4;

export class Procs {
  readonly root: string;
  readonly uid: number;
  readonly self: number;
  constructor(o: { root?: string; uid?: number; self?: number } = {}) {
    this.root = o.root ?? "/proc";
    this.uid = o.uid ?? process.getuid?.() ?? -1;
    this.self = o.self ?? process.pid;
  }

  /** The fields of /proc/<pid>/stat after the name, or null when the pid is gone or a zombie. */
  stat(pid: number): Stat | null {
    let raw: string;
    try { raw = readFileSync(join(this.root, String(pid), "stat"), "latin1"); } catch { return null; }
    const close = raw.lastIndexOf(")");
    if (close < 0) return null;
    const f = raw.slice(close + 1).trim().split(/\s+/);
    if (f.length < 20 || ["Z", "X", "x"].includes(f[0])) return null;
    const ppid = Number(f[1]), pgrp = Number(f[2]), start = Number(f[19]);
    if (![ppid, pgrp, start].every(Number.isSafeInteger)) return null;
    return { state: f[0], ppid, pgrp, start };
  }

  alive(pid: number): boolean { return this.stat(pid) !== null; }

  /**
   * True when `pid` is in its exit (board ab-4wh.26): the kernel's flags of the process, field 9 of /proc/<pid>/stat, hold
   * PF_EXITING. The kernel sets it first in its exit; from then on the process runs no code of its own. Its memory goes
   * after the flag, and then its cmdline reads empty and its exe link is gone (ENOENT), while its stat still says R until
   * it is a zombie (measured on the Linux server, 2026-11-27). False when the stat cannot be read.
   */
  exiting(pid: number): boolean {
    let raw: string;
    try { raw = readFileSync(join(this.root, String(pid), "stat"), "latin1"); } catch { return false; }
    const close = raw.lastIndexOf(")");
    if (close < 0) return false;
    const flags = Number(raw.slice(close + 1).trim().split(/\s+/)[6]);
    return Number.isSafeInteger(flags) && (flags & PF_EXITING) !== 0;
  }

  /** The arguments of /proc/<pid>/cmdline (the empty part after the last NUL dropped), or [] when it cannot be read. */
  cmdline(pid: number): string[] {
    let raw: Buffer;
    try { raw = readFileSync(join(this.root, String(pid), "cmdline")); } catch { return []; }
    if (raw.length === 0) return [];
    const body = raw[raw.length - 1] === 0 ? raw.subarray(0, -1) : raw;
    return body.toString("utf8").split("\0");
  }

  /** The real uid of `pid` (the first number of its Uid: line), or null. */
  realUid(pid: number): number | null {
    let text: string;
    try { text = readFileSync(join(this.root, String(pid), "status"), "latin1"); } catch { return null; }
    const m = /^Uid:\s+(\d+)/m.exec(text);
    return m ? Number(m[1]) : null;
  }

  /** True when `pid` runs as this user. */
  mine(pid: number): boolean { return this.realUid(pid) === this.uid; }

  /** The target of /proc/<pid>/exe, or null when it cannot be read. */
  exe(pid: number): string | null {
    try { return readlinkSync(join(this.root, String(pid), "exe")); } catch { return null; }
  }

  /** True when the base name of argv[0] or of the exe link of `pid` is `name`. */
  programIs(pid: number, name: string): boolean {
    const argv = this.cmdline(pid);
    if (argv.length && basename(argv[0]) === name) return true;
    const exe = this.exe(pid);
    return exe !== null && basename(exe) === name;
  }

  /** True when `pid` is alive, this user's, and each marker is a whole argument of its command line. */
  holds(pid: number, markers: readonly string[]): boolean {
    if (!markers.length || !this.alive(pid) || !this.mine(pid)) return false;
    const args = new Set(this.cmdline(pid));
    return markers.every((m) => args.has(m));
  }

  /** The pids of /proc, from 2 up, without this process. */
  pids(): number[] {
    let names: string[];
    try { names = readdirSync(this.root); } catch { return []; }
    return names.filter((n) => /^[0-9]+$/.test(n)).map(Number).filter((p) => p > 1 && p !== this.self).sort((a, b) => a - b);
  }

  /** The kernel's boot id (a count kept on disk is void after a reboot), or null. */
  bootId(): string | null {
    try { return readFileSync(join(this.root, "sys", "kernel", "random", "boot_id"), "latin1").trim() || null; } catch { return null; }
  }

  /** A file under /proc/sys (for example kernel/unprivileged_userns_clone), trimmed, or null. */
  sys(rel: string): string | null {
    try { return readFileSync(join(this.root, "sys", rel), "latin1").trim(); } catch { return null; }
  }

  /**
   * The live-service read of `service stop --blanket` (board ab-4wh.17): why a read of /proc/<pid> failed for another
   * reason than the pid's end, or null. Each other read gives null (or []) for every error; this one tells a pid that is
   * gone (ENOENT, ESRCH) from a read that is refused (any other code: hidepid=1 and systemd's ProtectProc=noaccess give
   * EPERM for a process that cannot be traced, such as the non-dumpable service; a security module gives EACCES), so
   * that the command fails safe.
   */
  readFault(pid: number): string | null {
    for (const file of ["stat", "status", "cmdline"]) {
      try { readFileSync(join(this.root, String(pid), file)); }
      catch (e) {
        const code = (e as NodeJS.ErrnoException).code ?? "an error";
        if (code !== "ENOENT" && code !== "ESRCH") return `${file}: ${code}`;
      }
    }
    return null;
  }

  /**
   * Why this /proc can hide a process of this user (board ab-4wh.17), or null: a proc mount at /proc in
   * /proc/self/mountinfo with the option hidepid (other than 0 or off: hidepid=1 refuses the reads of a process that
   * cannot be traced, such as the non-dumpable service, and hidepid=2 and 4 do not list it) or subset=pid (it hides only
   * the entries that are not a process's, but the command fails safe on it too), or a mountinfo that cannot be read. A
   * proc mount at another path (board ab-4wh.21) plays no part: the reads go to /proc, and since Linux 5.8 each proc
   * mount has its own options (before 5.8 the mounts of one pid namespace share them, so /proc shows them too).
   */
  procMountFault(): string | null {
    let text: string;
    try { text = readFileSync(join(this.root, "self", "mountinfo"), "latin1"); } catch (e) { return `/proc/self/mountinfo cannot be read (${(e as NodeJS.ErrnoException).code ?? "an error"})`; }
    for (const line of text.split("\n")) {
      const sep = line.indexOf(" - ");
      // Field 5 is the mount point; the file system type follows the separator.
      if (sep < 0 || line.slice(0, sep).split(" ")[4] !== "/proc" || line.slice(sep + 3).split(" ")[0] !== "proc") continue;
      const hide = /(?:^|[\s,])hidepid=([^,\s]+)/.exec(line)?.[1];
      if (hide !== undefined && hide !== "0" && hide !== "off") return `/proc is mounted with hidepid=${hide}`;
      if (/(?:^|[\s,])subset=pid(?:[,\s]|$)/.test(line)) return "/proc is mounted with subset=pid";
    }
    return null;
  }

  /** /proc/net/unix, for the abstract X sockets (an X server can hold its display there only). */
  netUnix(): string {
    try { return readFileSync(join(this.root, "net", "unix"), "latin1"); } catch { return ""; }
  }
}
