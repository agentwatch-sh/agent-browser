// A fake world for the tests of the service's Chrome unit (board ab-v16.94.3): a fake /proc in a temp folder (stat,
// cmdline, status and exe of each process), a fake X root (/tmp/.X11-unix), a spawn that makes fake processes, a kill
// that ends them, and a virtual clock. The unit's real code reads these files (src/service/unit/procs.ts), so a test
// sees exactly what the unit would read on a box. No real Xvfb, Chrome or signal ever comes from it.

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { realDisplayFs } from "../src/service/unit/display.ts";
import type { ChromeCopy, ChromeTools, DebEntry } from "../src/service/unit/google-chrome.ts";
import { unitPaths, type UnitPaths } from "../src/service/unit/paths.ts";
import { Procs } from "../src/service/unit/procs.ts";
import type { Spawned, UnitDeps } from "../src/service/unit/unit.ts";
import { pickVersion } from "../src/service/unit/versions.ts";

export type FakeProc = { pid: number; ppid: number; pgrp: number; start: number; argv: string[]; exe: string; uid: number; env?: Record<string, string>; stubborn?: boolean; display?: number };

export class World {
  readonly dir: string;
  readonly proc: string;
  readonly xRoot: string;
  readonly paths: UnitPaths;
  readonly procs: Procs;
  readonly uid = process.getuid!();
  readonly self = 1_000_000;
  now = 1_000_000;
  private nextPid = 5000;
  private nextStart = 100;
  readonly live = new Map<number, FakeProc>();
  readonly spawned: FakeProc[] = [];
  readonly signals: [number, string][] = [];
  readonly logs: string[] = [];
  netUnix = "";
  /** What the next spawns of a program do: "exit" (gone at once), "nosocket" (Xvfb opens no display). */
  behave: Record<string, string[]> = {};
  /** The programs that ignore SIGTERM. */
  stubborn = new Set<string>();
  programs: Record<string, string | null> = { Xvfb: "/usr/bin/Xvfb", chromium: "/usr/bin/chromium", "/usr/bin/chromium": "/usr/bin/chromium" };

  constructor() {
    this.dir = mkdtempSync(join(tmpdir(), "ab-unit-"));
    this.proc = join(this.dir, "proc");
    this.xRoot = join(this.dir, "x");
    mkdirSync(join(this.proc, "sys", "kernel", "random"), { recursive: true });
    writeFileSync(join(this.proc, "sys", "kernel", "random", "boot_id"), "boot-1\n");
    mkdirSync(join(this.xRoot, ".X11-unix"), { recursive: true });
    mkdirSync(join(this.dir, "state"), { mode: 0o700 });
    this.paths = unitPaths(join(this.dir, "state"), join(this.dir, "tools"));
    this.procs = new Procs({ root: this.proc, uid: this.uid, self: this.self });
  }

  close(): void { rmSync(this.dir, { recursive: true, force: true }); }

  /** Add a process to the fake /proc. */
  add(p: Partial<FakeProc> & { argv: string[] }): FakeProc {
    const pid = p.pid ?? this.nextPid++;
    const full: FakeProc = { pid, ppid: p.ppid ?? 1, pgrp: p.pgrp ?? pid, start: p.start ?? this.nextStart++, argv: p.argv, exe: p.exe ?? p.argv[0], uid: p.uid ?? this.uid, stubborn: p.stubborn, env: p.env, display: p.display };
    const d = join(this.proc, String(pid));
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "stat"), `${pid} (${basename(full.argv[0]).slice(0, 15)}) S ${full.ppid} ${full.pgrp} ${full.pgrp} 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 ${full.start} 0 0\n`);
    writeFileSync(join(d, "cmdline"), Buffer.from(full.argv.join("\0") + "\0"));
    writeFileSync(join(d, "status"), `Name:\t${basename(full.argv[0])}\nUid:\t${full.uid}\t${full.uid}\t${full.uid}\t${full.uid}\n`);
    try { symlinkSync(full.exe, join(d, "exe")); } catch {}
    this.live.set(pid, full);
    return full;
  }

  /** A process ends (its /proc entry goes, and an Xvfb's socket). */
  end(pid: number): void {
    const p = this.live.get(pid);
    this.live.delete(pid);
    rmSync(join(this.proc, String(pid)), { recursive: true, force: true });
    if (p?.display !== undefined) rmSync(join(this.xRoot, ".X11-unix", `X${p.display}`), { force: true });
  }

  alive(pid: number): boolean { return this.live.has(pid); }

  /** The unit's dependencies on this world (merge `extra`). */
  deps(tools: ChromeTools, extra: Partial<UnitDeps> = {}): UnitDeps {
    return {
      paths: this.paths, procs: this.procs, tools, xRoot: this.xRoot,
      displayFs: realDisplayFs(() => this.netUnix), which: (n) => (Object.hasOwn(this.programs, n) ? this.programs[n] : null),
      spawn: (argv, env) => this.spawn(argv, env), kill: (pid, sig) => this.kill(pid, sig),
      clock: () => this.now, wall: () => 1_762_750_000_000 + this.now, sleep: (ms) => this.sleep(ms),
      log: (l) => this.logs.push(l), env: { PATH: "/usr/bin:/bin", HOME: "/home/ann", LANG: "C.UTF-8", XDG_RUNTIME_DIR: "/run/user/1000", AGENTWATCH_TOKEN: "secret-token", SSH_AUTH_SOCK: "/x" },
      random: (n) => Buffer.alloc(n, this.spawned.length + 1),
      ...extra,
    };
  }

  async sleep(ms: number): Promise<void> { this.now += ms; await new Promise((r) => setImmediate(r)); }

  spawn(argv: string[], env: Record<string, string>): Spawned {
    const name = basename(argv[0]);
    const what = this.behave[name]?.shift();
    const display = name === "Xvfb" ? Number(argv[1].slice(1)) : undefined;
    const p = this.add({ argv, ppid: this.self, env, stubborn: this.stubborn.has(name), display });
    this.spawned.push(p);
    if (what === "exit") this.end(p.pid);
    else if (name === "Xvfb" && what !== "nosocket") writeFileSync(join(this.xRoot, ".X11-unix", `X${display}`), "");
    return { pid: p.pid, exited: () => !this.live.has(p.pid), code: () => (this.live.has(p.pid) ? null : 1) };
  }

  kill(pid: number, sig: string): void {
    this.signals.push([pid, sig]);
    const target = Math.abs(pid);
    const p = this.live.get(target);
    if (!p) { const e = new Error("ESRCH") as NodeJS.ErrnoException; e.code = "ESRCH"; throw e; }
    if (sig === "SIGTERM" && p.stubborn) return;
    this.end(target);
    // A group signal ends the leader's children too (Chrome's own processes).
    if (pid < 0) for (const c of [...this.live.values()]) if (c.pgrp === target) this.end(c.pid);
  }

  /** The processes that a program name (base name of argv[0]) has now. */
  named(name: string): FakeProc[] { return [...this.live.values()].filter((p) => basename(p.argv[0]) === name); }
  socket(display: number): boolean { return existsSync(join(this.xRoot, ".X11-unix", `X${display}`)); }
}

/** A fake tools folder: the installed versions, an install that the test settles, and the calls. */
export class FakeTools implements ChromeTools {
  versions: string[] = [];
  why: string | null = null;
  entry: DebEntry = { version: "158.0.7100.1-1", filename: "pool/main/g/google-chrome-stable/google-chrome-stable_158.0.7100.1-1_amd64.deb", sha256: "a".repeat(64), size: 1 };
  calls: string[] = [];
  /** The pending install: a test settles it (resolve adds `entry`, reject fails it). */
  pending: { resolve: () => void; reject: (e: Error) => void } | null = null;
  autoInstall = false;
  pruned: ReadonlySet<string>[] = [];
  root = "/tools/google-chrome";
  copy(v: string): ChromeCopy { return { version: v, root: `${this.root}/${v}`, binary: `${this.root}/${v}/opt/google/chrome/chrome` }; }
  unsupported() { return this.why; }
  newest(skip: ReadonlySet<string> = new Set(), upto: string | null = null) { const v = pickVersion(this.versions, skip, upto); return v ? this.copy(v) : null; }
  async latestEntry() { this.calls.push("latest"); return this.entry; }
  ensure(entry?: DebEntry): Promise<ChromeCopy> {
    this.calls.push(`ensure ${entry?.version ?? "latest"}`);
    const e = entry ?? this.entry;
    if (this.autoInstall) { if (!this.versions.includes(e.version)) this.versions.push(e.version); return Promise.resolve(this.copy(e.version)); }
    return new Promise((resolve, reject) => {
      this.pending = { resolve: () => { this.versions.push(e.version); resolve(this.copy(e.version)); }, reject };
    });
  }
  async prune(keep: ReadonlySet<string>) { this.pruned.push(keep); return []; }
}
