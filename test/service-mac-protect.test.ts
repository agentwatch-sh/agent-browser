// The Mac's protected start of the service's memory (board ab-v16.97.8, part 2; the stored sign-ins design, section 5.5;
// C12, the stored sign-ins: the protections), on fakes: this box runs no macOS call. A fake libSystem stands for
// ptrace, setrlimit and getrlimit, and a fake runner for codesign, csrutil and DevToolsSecurity, with the texts that the
// Mac memory probe read on the operator's Mac (2026-11-25). The store stays off on the Mac: main.ts only logs the result.

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  loadMacMemLib, MAC_CHECK_MS, MAC_START_MS, MAC_TOOLS, macProtectedStart, nonDumpableStart, protectionReason, PT_DENY_ATTACH, RLIMIT_CORE_MAC,
  runToolSync, type MacMemLib, type MacToolRun,
} from "../src/service/signins/protect.ts";
import { runClass, type ToolRun } from "../src/service/signins/mac-tools.ts";
import { MAC_PROTECTION_HOLDS, memoryStart, serviceFeatures } from "../src/service/main.ts";
import { tempDir } from "./temp-dirs.ts";

const NODE = "/opt/homebrew/Cellar/node/26.13.0/bin/node";
const run = (text: string, exit: number | null = 0, more: Partial<ToolRun> = {}): ToolRun => ({ exit, signal: null, timedOut: false, stopped: null, spawnError: null, stdout: text, stderr: "", ms: 9, ...more });
const TIMEOUT = run("", null, { signal: "SIGKILL", timedOut: true });
const NO_TOOL = run("", null, { spawnError: "ENOENT" });
const ENT_XML = (body: string) => `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n${body}</dict>\n</plist>\n`;
const GET_TASK_ALLOW = ENT_XML("\t<key>com.apple.security.get-task-allow</key>\n\t<true/>\n");
/** What the operator's Mac gave (the probe's run of 2026-11-25): an ad hoc Node with no entitlements, SIP enabled, DevToolsSecurity disabled. */
const MAC = {
  codesign: run(""),
  csrutil: run("System Integrity Protection status: enabled.\n"),
  dts: run("Developer mode is currently disabled.\n"),
};
const DTS_ON = run("Developer mode is currently enabled.\n");

/** A fake libSystem: each call is recorded; `ptrace` and `setrlimit` give their return, getrlimit reads what setrlimit set. */
function fakeLib(o: { ptrace?: number; setrlimit?: number; getrlimit?: number; keep?: [bigint, bigint]; errno?: number } = {}) {
  const calls: string[] = [];
  let core: [bigint, bigint] = [0x7fffffffffffffffn, 0x7fffffffffffffffn];
  const lib: MacMemLib = {
    ptrace: (req, pid, addr, data) => { calls.push(`ptrace ${req} ${pid} ${addr} ${data}`); return o.ptrace ?? 0; },
    setrlimit: (res, b) => {
      calls.push(`setrlimit ${res} ${b.length} ${b.readBigUInt64LE(0)} ${b.readBigUInt64LE(8)}`);
      if ((o.setrlimit ?? 0) === 0) core = o.keep ?? [b.readBigUInt64LE(0), b.readBigUInt64LE(8)];
      return o.setrlimit ?? 0;
    },
    getrlimit: (res, b) => { calls.push(`getrlimit ${res} ${b.length}`); b.writeBigUInt64LE(core[0], 0); b.writeBigUInt64LE(core[1], 8); return o.getrlimit ?? 0; },
    errno: () => o.errno ?? 1,
  };
  return { lib, calls, load: async () => lib };
}

/** A fake runner: each tool gives its runs in turn (the last one again after that); each call is recorded with its time limit. */
function fakeRun(runs: { codesign?: ToolRun[]; csrutil?: ToolRun[]; dts?: ToolRun[] } = {}) {
  const calls: { cmd: string; args: readonly string[]; ms: number }[] = [];
  const queue = { [MAC_TOOLS.codesign]: runs.codesign ?? [MAC.codesign], [MAC_TOOLS.csrutil]: runs.csrutil ?? [MAC.csrutil], [MAC_TOOLS.devToolsSecurity]: runs.dts ?? [MAC.dts] } as Record<string, ToolRun[]>;
  const fn: MacToolRun = (cmd, args, ms) => {
    calls.push({ cmd, args, ms });
    const q = queue[cmd];
    if (!q) return NO_TOOL;
    return q.length > 1 ? q.shift()! : q[0];
  };
  return { fn, calls, set: (cmd: string, r: ToolRun[]) => { queue[cmd] = r; } };
}

const start = (lib = fakeLib(), tools = fakeRun()) => macProtectedStart({ load: lib.load, run: tools.fn, execPath: NODE });

test("the Mac's protected start: ptrace(PT_DENY_ATTACH) and setrlimit(RLIMIT_CORE, 0) through libSystem first, then codesign, csrutil and DevToolsSecurity, each with a short time limit; all hold, so the reader says not dumpable", async () => {
  const lib = fakeLib(), tools = fakeRun();
  const m = await start(lib, tools);
  assert.equal(m.failed, null);
  assert.equal(PT_DENY_ATTACH, 31);
  assert.equal(RLIMIT_CORE_MAC, 4, "macOS's sys/resource.h");
  assert.deepEqual(lib.calls, [`ptrace 31 0 0 0`, `setrlimit 4 16 0 0`, `getrlimit 4 16`], "PT_DENY_ATTACH, then rlim_cur and rlim_max 0, read back");
  assert.deepEqual(tools.calls, [
    { cmd: "/usr/bin/codesign", args: ["-d", "--entitlements", "-", "--xml", NODE], ms: MAC_START_MS },
    { cmd: "/usr/bin/csrutil", args: ["status"], ms: MAC_START_MS },
    { cmd: "/usr/sbin/DevToolsSecurity", args: ["-status"], ms: MAC_START_MS },
  ]);
  assert.ok(MAC_START_MS <= 5000 && MAC_CHECK_MS <= 2000, "short time limits");
  // Each later check: one run of DevToolsSecurity, nothing else.
  assert.equal(m.dumpable(), false);
  assert.equal(m.dumpable(), false);
  assert.deepEqual(tools.calls.slice(3), [
    { cmd: "/usr/sbin/DevToolsSecurity", args: ["-status"], ms: MAC_CHECK_MS },
    { cmd: "/usr/sbin/DevToolsSecurity", args: ["-status"], ms: MAC_CHECK_MS },
  ]);
  assert.equal(lib.calls.length, 3, "no libSystem call at a later check");
  assert.equal(protectionReason(m.dumpable, () => true), null);
  // An entitlements plist with get-task-allow false, and other entitlements, holds too.
  const other = await start(fakeLib(), fakeRun({ codesign: [run(ENT_XML("\t<key>com.apple.security.get-task-allow</key>\n\t<false/>\n\t<key>com.apple.security.cs.allow-jit</key>\n\t<true/>\n"))] }));
  assert.equal(other.failed, null);
});

test("the Mac's protected start fails closed: each failed call or check gives the reader 'dumpable' for good and a reason that names the check; nothing after the first failure runs", async () => {
  const cases: { name: string; lib?: ReturnType<typeof fakeLib>; load?: () => Promise<{ failed: string }>; runs?: Parameters<typeof fakeRun>[0]; failed: string; libCalls?: number; toolCalls: number }[] = [
    { name: "node:ffi or libSystem does not load", load: async () => ({ failed: "node:ffi does not load (ERR_UNKNOWN_BUILTIN_MODULE)" }), failed: "node:ffi does not load (ERR_UNKNOWN_BUILTIN_MODULE)", toolCalls: 0 },
    { name: "ptrace fails", lib: fakeLib({ ptrace: -1, errno: 45 }), failed: "ptrace(PT_DENY_ATTACH) failed (errno 45)", libCalls: 1, toolCalls: 0 },
    { name: "setrlimit fails", lib: fakeLib({ setrlimit: -1, errno: 22 }), failed: "setrlimit(RLIMIT_CORE, 0) failed (errno 22)", libCalls: 2, toolCalls: 0 },
    { name: "getrlimit fails", lib: fakeLib({ getrlimit: -1, errno: 14 }), failed: "getrlimit(RLIMIT_CORE) failed (errno 14)", libCalls: 3, toolCalls: 0 },
    { name: "the limit stays above 0", lib: fakeLib({ keep: [0n, 1024n] }), failed: "RLIMIT_CORE is not 0 after setrlimit", libCalls: 3, toolCalls: 0 },
    { name: "get-task-allow true", runs: { codesign: [run(GET_TASK_ALLOW)] }, failed: "the service's Node has the get-task-allow entitlement", toolCalls: 1 },
    { name: "codesign times out", runs: { codesign: [TIMEOUT] }, failed: "the entitlements of the service's Node cannot be read (codesign: timeout)", toolCalls: 1 },
    { name: "codesign is missing", runs: { codesign: [NO_TOOL] }, failed: "the entitlements of the service's Node cannot be read (codesign: no tool)", toolCalls: 1 },
    { name: "codesign gives a text that is no XML plist", runs: { codesign: [run("bplist00\u0001")] }, failed: "the entitlements of the service's Node cannot be read (codesign: an unknown text)", toolCalls: 1 },
    { name: "SIP disabled", runs: { csrutil: [run("System Integrity Protection status: disabled.\n")] }, failed: "SIP is disabled", toolCalls: 2 },
    { name: "SIP in a custom configuration", runs: { csrutil: [run("System Integrity Protection status: unknown (Custom Configuration).\n")] }, failed: "SIP's state cannot be read (csrutil: an unknown text)", toolCalls: 2 },
    { name: "csrutil exits 1", runs: { csrutil: [run("", 1)] }, failed: "SIP's state cannot be read (csrutil: exit)", toolCalls: 2 },
    { name: "DevToolsSecurity enabled at the start", runs: { dts: [DTS_ON] }, failed: "DevToolsSecurity is enabled", toolCalls: 3 },
    { name: "DevToolsSecurity times out", runs: { dts: [TIMEOUT] }, failed: "DevToolsSecurity's state cannot be read (DevToolsSecurity: timeout)", toolCalls: 3 },
    { name: "DevToolsSecurity is missing", runs: { dts: [NO_TOOL] }, failed: "DevToolsSecurity's state cannot be read (DevToolsSecurity: no tool)", toolCalls: 3 },
    { name: "DevToolsSecurity is killed", runs: { dts: [run("", null, { signal: "SIGKILL" })] }, failed: "DevToolsSecurity's state cannot be read (DevToolsSecurity: killed)", toolCalls: 3 },
  ];
  for (const c of cases) {
    const lib = c.lib ?? fakeLib(), tools = fakeRun({ dts: [MAC.dts], ...c.runs });
    const m = await macProtectedStart({ load: c.load ?? lib.load, run: tools.fn, execPath: NODE });
    assert.equal(m.failed, c.failed, c.name);
    if (c.libCalls !== undefined) assert.equal(lib.calls.length, c.libCalls, `${c.name}: no libSystem call after the failure`);
    assert.equal(tools.calls.length, c.toolCalls, `${c.name}: no tool run after the failure`);
    // The later checks: 'dumpable' for good, with no tool run, also when the tools would all hold now.
    tools.set(MAC_TOOLS.devToolsSecurity, [MAC.dts]);
    assert.equal(m.dumpable(), true, c.name);
    assert.equal(m.dumpable(), true, c.name);
    assert.equal(tools.calls.length, c.toolCalls, `${c.name}: a later check runs no tool`);
    assert.equal(protectionReason(m.dumpable, () => true), "dumpable", `${c.name}: the reason of C12`);
  }
});

test("the Mac's later check reads DevToolsSecurity again: enabled later says dumpable, and stays so until the service starts again (a debugger may hold a task port of it since then); an unknown read says dumpable for that check only", async () => {
  const tools = fakeRun();
  const m = await start(fakeLib(), tools);
  assert.equal(m.failed, null);
  assert.equal(m.dumpable(), false, "disabled");
  // An unknown read (a time limit, a missing tool, an unknown text) fails closed for that check.
  for (const r of [TIMEOUT, NO_TOOL, run("something else\n"), run("Developer mode is currently disabled.\n", 1)]) {
    tools.set(MAC_TOOLS.devToolsSecurity, [r, MAC.dts]);
    assert.equal(m.dumpable(), true, `${runClass(r)}: dumpable`);
    assert.equal(m.dumpable(), false, `${runClass(r)}: the next read of disabled holds again`);
  }
  tools.set(MAC_TOOLS.devToolsSecurity, [DTS_ON, MAC.dts]);
  const before = tools.calls.length;
  assert.equal(m.dumpable(), true, "enabled while the service runs");
  assert.equal(protectionReason(m.dumpable, () => true), "dumpable");
  assert.equal(m.dumpable(), true, "disabled again: still dumpable until the next start");
  assert.equal(tools.calls.length, before + 1, "after a read of enabled no check runs the tool again");
});

test("the real runner of the Mac's tools: one synchronous run with a time limit and the run classes of the probe (ok, exit, timeout, no tool)", { timeout: 30_000 }, () => {
  const ok = runToolSync(process.execPath, ["-e", "process.stdout.write('ok'); process.stderr.write('e')"], 10_000);
  assert.deepEqual([runClass(ok), ok.stdout, ok.stderr, ok.exit, ok.signal], ["ok", "ok", "e", 0, null]);
  const exit = runToolSync(process.execPath, ["-e", "process.exit(3)"], 10_000);
  assert.deepEqual([runClass(exit), exit.exit], ["exit", 3]);
  const slow = runToolSync(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], 300);
  assert.equal(runClass(slow), "timeout");
  assert.ok(slow.ms < 10_000, "the time limit ends the run");
  const missing = runToolSync(join(tempDir("ab-mac-protect-"), "no-such-tool"), [], 1000);
  assert.equal(runClass(missing), "no tool");
});

test("the Mac's libSystem calls load only on the Mac", async () => {
  assert.deepEqual(await loadMacMemLib("linux"), { failed: "no ptrace PT_DENY_ATTACH on linux" });
  assert.deepEqual(await loadMacMemLib("win32"), { failed: "no ptrace PT_DENY_ATTACH on win32" });
});

test("main.ts: on the Mac the service runs the Mac's protected start before any door opens and logs its result in one line; the store stays off (no store part, no sign_ins); on Linux the non-dumpable start and its lines as before", async () => {
  const never = async (): Promise<never> => { throw new Error("the other system's start"); };
  // The Mac: all hold.
  let lines: string[] = [];
  let m = await memoryStart("darwin", (l) => lines.push(l), { linux: never, mac: () => start() });
  assert.equal(m, null, "no reader for the store: the store stays off on the Mac");
  assert.deepEqual(lines, [MAC_PROTECTION_HOLDS]);
  assert.equal(MAC_PROTECTION_HOLDS, "service: the Mac's memory protection holds (ptrace PT_DENY_ATTACH, RLIMIT_CORE 0, no get-task-allow, SIP enabled, DevToolsSecurity disabled); the stored sign-ins stay off on the Mac");
  // The Mac: one fails; the line names the failed check.
  lines = [];
  m = await memoryStart("darwin", (l) => lines.push(l), { linux: never, mac: () => start(fakeLib(), fakeRun({ dts: [DTS_ON] })) });
  assert.equal(m, null);
  assert.deepEqual(lines, ["service: the Mac's memory protection does not hold (DevToolsSecurity is enabled); the stored sign-ins stay off on the Mac"]);
  assert.deepEqual(serviceFeatures("darwin"), [], "the Mac's hello has no sign_ins");
  assert.deepEqual(serviceFeatures("darwin", true), []);
  // Linux: the reader goes to the store, and the lines are Linux's as before.
  lines = [];
  const held = await memoryStart("linux", (l) => lines.push(l), { linux: () => nonDumpableStart(async () => ({ prctl: () => 0 })), mac: never });
  assert.ok(held && held.failed === null && held.dumpable() === false);
  assert.deepEqual(lines, ["service: the process is not dumpable (prctl PR_SET_DUMPABLE 0)"]);
  lines = [];
  const off = await memoryStart("linux", (l) => lines.push(l), { linux: () => nonDumpableStart(async () => ({ failed: "node:ffi does not load (ERR_UNKNOWN_BUILTIN_MODULE)" })), mac: never });
  assert.ok(off && off.failed !== null && off.dumpable() === true);
  assert.deepEqual(lines, ["service: the process stays dumpable (node:ffi does not load (ERR_UNKNOWN_BUILTIN_MODULE)), so the stored sign-ins do not open"]);
  // Another system: nothing runs, no line.
  lines = [];
  assert.equal(await memoryStart("win32", (l) => lines.push(l), { linux: never, mac: never }), null);
  assert.deepEqual(lines, []);
});
