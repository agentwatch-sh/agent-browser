// The reads of /proc that the Chrome unit needs (board ab-v16.94.3; the reads of agentwatch's daemon/browser/unit.py and
// stop_unit.py). A process is known by its pid AND its start time (field 22 of /proc/<pid>/stat, in clock ticks since the
// boot), so a reused pid is never taken for the unit's process. Each read takes `root` (a test gives a fake /proc).

import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { basename, join } from "node:path";

export type Stat = { state: string; ppid: number; pgrp: number; start: number };

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

  /** /proc/net/unix, for the abstract X sockets (an X server can hold its display there only). */
  netUnix(): string {
    try { return readFileSync(join(this.root, "net", "unix"), "latin1"); } catch { return ""; }
  }
}
