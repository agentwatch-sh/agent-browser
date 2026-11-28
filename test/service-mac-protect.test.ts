// The Mac's protected start of the service's memory (board ab-v16.97.8, part 2; the stored sign-ins design, section 5.5;
// C12, the stored sign-ins: the protections), on fakes: this box runs no macOS call. A fake libSystem stands for
// ptrace, setrlimit and getrlimit, and a fake runner for codesign, csrutil, DevToolsSecurity and security, with the texts
// that the Mac memory probe read on the operator's Mac (2026-11-25) and the right that the Mac sign-in window probe read
// there (2026-11-27). Board ab-v16.97.15 (part 2): the taskport right in the start, the background reader with its age
// bound and its latch, and the store on the Mac (main.ts gives the start's reader to the store).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  loadMacMemLib, MAC_CHECK_MS, MAC_READ_EVERY_MS, MAC_READING_MAX_AGE_MS, MAC_START_MS, MAC_TOOLS, macProtectedStart, MacProtectionReader, nonDumpableStart, protectionReason,
  PT_DENY_ATTACH, RLIMIT_CORE_MAC, runToolAsync, runToolSync, TASKPORT_TIMEOUT_MAX, taskportHolds, taskportSharedS, type MacMemLib, type MacToolRun, type MacToolRunAsync,
} from "../src/service/signins/protect.ts";
import { parseCsrutil, parseTaskport, runClass, type ToolRun } from "../src/service/signins/mac-tools.ts";
import { MAC_START_BEGINS, MAC_START_HOLDS, memoryStart, serviceFeatures, signInsOption } from "../src/service/main.ts";
import { tempDir } from "./temp-dirs.ts";

const NODE = "/opt/homebrew/Cellar/node/26.13.0/bin/node";
const run = (text: string, exit: number | null = 0, more: Partial<ToolRun> = {}): ToolRun => ({ exit, signal: null, timedOut: false, stopped: null, spawnError: null, stdout: text, stderr: "", ms: 9, ...more });
const TIMEOUT = run("", null, { signal: "SIGKILL", timedOut: true });
const NO_TOOL = run("", null, { spawnError: "ENOENT" });
const ENT_XML = (body: string) => `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n${body}</dict>\n</plist>\n`;
const GET_TASK_ALLOW = ENT_XML("\t<key>com.apple.security.get-task-allow</key>\n\t<true/>\n");
/** The taskport right as a plist: the fields of the right that the Mac sign-in window probe read (2026-11-27), or another form. */
const RIGHT = (body = "<key>authenticate-user</key><true/><key>class</key><string>user</string><key>group</key><string>_developer</string><key>shared</key><true/><key>timeout</key><integer>36000</integer>") =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>${body}<key>comment</key><string>Used by task_for_pid(...).</string></dict>\n</plist>\n`;
/** What the operator's Mac gave (the probes' runs of 2026-11-25 and 2026-11-27): an ad hoc Node with no entitlements, SIP enabled, DevToolsSecurity disabled, the right's default. */
const MAC = {
  codesign: run(""),
  csrutil: run("System Integrity Protection status: enabled.\n"),
  dts: run("Developer mode is currently disabled.\n"),
  taskport: run(RIGHT(), 0, { stderr: "YES (0)\n" }),
};
const DTS_ON = run("Developer mode is currently enabled.\n");
const TP_ARGS = ["authorizationdb", "read", "system.privilege.taskport"];

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
function fakeRun(runs: { codesign?: ToolRun[]; csrutil?: ToolRun[]; dts?: ToolRun[]; taskport?: ToolRun[] } = {}) {
  const calls: { cmd: string; args: readonly string[]; ms: number }[] = [];
  const queue = { [MAC_TOOLS.codesign]: runs.codesign ?? [MAC.codesign], [MAC_TOOLS.csrutil]: runs.csrutil ?? [MAC.csrutil], [MAC_TOOLS.devToolsSecurity]: runs.dts ?? [MAC.dts], [MAC_TOOLS.security]: runs.taskport ?? [MAC.taskport] } as Record<string, ToolRun[]>;
  const fn: MacToolRun = (cmd, args, ms) => {
    calls.push({ cmd, args, ms });
    const q = queue[cmd];
    if (!q) return NO_TOOL;
    return q.length > 1 ? q.shift()! : q[0];
  };
  return { fn, calls, set: (cmd: string, r: ToolRun[]) => { queue[cmd] = r; } };
}

/**
 * A fake asynchronous runner for the background reader: each tool's answers in turn (the last one again), each after
 * `delay` ms (null: never), with the calls recorded.
 */
function fakeAsync(runs: { dts?: ToolRun[]; taskport?: ToolRun[] } = {}, delay: number | null = 0) {
  const calls: { cmd: string; args: readonly string[]; ms: number }[] = [];
  const queue = { [MAC_TOOLS.devToolsSecurity]: runs.dts ?? [MAC.dts], [MAC_TOOLS.security]: runs.taskport ?? [MAC.taskport] } as Record<string, ToolRun[]>;
  const fn: MacToolRunAsync = (cmd, args, ms) => {
    calls.push({ cmd, args, ms });
    const q = queue[cmd];
    const r = !q ? NO_TOOL : q.length > 1 ? q.shift()! : q[0];
    return delay === null ? new Promise<ToolRun>(() => {}) : new Promise((res) => setTimeout(() => res(r), delay));
  };
  return { fn, calls, set: (cmd: string, r: ToolRun[]) => { queue[cmd] = r; } };
}
/** A clock that a test moves. */
const clock = (t = 1_000_000) => ({ now: () => t, add: (ms: number) => { t += ms; } });

const start = (lib = fakeLib(), tools = fakeRun(), reader: NonNullable<Parameters<typeof macProtectedStart>[0]>["reader"] = { run: fakeAsync().fn }) => macProtectedStart({ load: lib.load, run: tools.fn, execPath: NODE, reader });

test("the Mac's protected start: ptrace(PT_DENY_ATTACH) and setrlimit(RLIMIT_CORE, 0) through libSystem first, then codesign, csrutil, DevToolsSecurity and the taskport right (board ab-v16.97.15), each with a short time limit; all hold, so the reader says not dumpable, and a later check runs no tool", async () => {
  const lib = fakeLib(), tools = fakeRun(), bg = fakeAsync();
  const m = await start(lib, tools, { run: bg.fn });
  try {
    assert.equal(m.failed, null);
    assert.equal(PT_DENY_ATTACH, 31);
    assert.equal(RLIMIT_CORE_MAC, 4, "macOS's sys/resource.h");
    assert.deepEqual(lib.calls, [`ptrace 31 0 0 0`, `setrlimit 4 16 0 0`, `getrlimit 4 16`], "PT_DENY_ATTACH, then rlim_cur and rlim_max 0, read back");
    assert.deepEqual(tools.calls, [
      { cmd: "/usr/bin/codesign", args: ["-d", "--entitlements", "-", "--xml", NODE], ms: MAC_START_MS },
      { cmd: "/usr/bin/csrutil", args: ["status"], ms: MAC_START_MS },
      { cmd: "/usr/sbin/DevToolsSecurity", args: ["-status"], ms: MAC_START_MS },
      { cmd: "/usr/bin/security", args: TP_ARGS, ms: MAC_START_MS },
    ]);
    assert.ok(MAC_START_MS <= 5000 && MAC_CHECK_MS <= 2000, "short time limits");
    // Each later check reads the cached reading: no tool runs, synchronously or not (today a check ran DevToolsSecurity).
    assert.equal(m.dumpable(), false);
    assert.equal(m.dumpable(), false);
    assert.equal(tools.calls.length, 4, "no synchronous run after the start");
    assert.equal(bg.calls.length, 0, "no read at a check: only the reader's timer and a fresh read run the tools");
    assert.equal(lib.calls.length, 3, "no libSystem call at a later check");
    assert.equal(protectionReason(m.dumpable, () => true), null);
    assert.equal(m.mac.taskportSharedS(), 36000, "the right's shared timeout for C12's taskport_shared_s");
    // An entitlements plist with get-task-allow false, and other entitlements, holds too.
    const other = await start(fakeLib(), fakeRun({ codesign: [run(ENT_XML("\t<key>com.apple.security.get-task-allow</key>\n\t<false/>\n\t<key>com.apple.security.cs.allow-jit</key>\n\t<true/>\n"))] }));
    other.mac.stop();
    assert.equal(other.failed, null);
  } finally { m.mac.stop(); }
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
    // Board ab-v16.97.15: the taskport right (the Mac design note, section 6.1). Each form that does not hold fails the start.
    { name: "the right is shared with no timeout", runs: { taskport: [run(RIGHT("<key>class</key><string>user</string><key>authenticate-user</key><true/><key>shared</key><true/>"))] }, failed: "the taskport right does not hold (a password once, shared with no timeout)", toolCalls: 4 },
    { name: "the right's shared timeout is above TASKPORT_TIMEOUT_MAX", runs: { taskport: [run(RIGHT("<key>class</key><string>user</string><key>authenticate-user</key><true/><key>shared</key><true/><key>timeout</key><integer>36001</integer>"))] }, failed: "the taskport right does not hold (a password once, shared for its timeout)", toolCalls: 4 },
    { name: "a group member with no password", runs: { taskport: [run(RIGHT("<key>class</key><string>user</string><key>group</key><string>_developer</string><key>authenticate-user</key><false/>"))] }, failed: "the taskport right does not hold (a group member with no password)", toolCalls: 4 },
    { name: "allow", runs: { taskport: [run(RIGHT("<key>class</key><string>allow</string>"))] }, failed: "the taskport right does not hold (allow: no password)", toolCalls: 4 },
    { name: "a rule", runs: { taskport: [run(RIGHT("<key>class</key><string>rule</string><key>rule</key><array><string>is-developer</string></array>"))] }, failed: "the taskport right does not hold (a rule)", toolCalls: 4 },
    { name: "another form", runs: { taskport: [run(RIGHT("<key>class</key><string>evaluate-mechanisms</string>"))] }, failed: "the taskport right does not hold (another form)", toolCalls: 4 },
    { name: "no right", runs: { taskport: [run("", 1, { stderr: "NO (-60005)\n" })] }, failed: "the taskport right does not hold (no right)", toolCalls: 4 },
    // The review's M2: forms that the read does not state in full.
    { name: "no shared key", runs: { taskport: [run(RIGHT("<key>class</key><string>user</string><key>authenticate-user</key><true/>"))] }, failed: "the taskport right does not hold (another form)", toolCalls: 4 },
    { name: "a shared timeout below 0", runs: { taskport: [run(RIGHT("<key>class</key><string>user</string><key>authenticate-user</key><true/><key>shared</key><true/><key>timeout</key><integer>-5</integer>"))] }, failed: "the taskport right does not hold (another form)", toolCalls: 4 },
    // Board ab-v16.97.17.
    { name: "no authenticate-user key", runs: { taskport: [run(RIGHT("<key>class</key><string>user</string><key>group</key><string>_developer</string><key>shared</key><true/><key>timeout</key><integer>36000</integer>"))] }, failed: "the taskport right does not hold (another form)", toolCalls: 4 },
    { name: "a timeout below 0, not shared", runs: { taskport: [run(RIGHT("<key>class</key><string>user</string><key>authenticate-user</key><true/><key>shared</key><false/><key>timeout</key><integer>-5</integer>"))] }, failed: "the taskport right does not hold (another form)", toolCalls: 4 },
    { name: "a parsed dict with no class", runs: { taskport: [run(RIGHT("<key>authenticate-user</key><true/><key>shared</key><false/>"))] }, failed: "the taskport right does not hold (another form)", toolCalls: 4 },
    { name: "security times out", runs: { taskport: [TIMEOUT] }, failed: "the taskport right cannot be read (security: timeout)", toolCalls: 4 },
    { name: "security gives an unknown text", runs: { taskport: [run("YES (0)\n")] }, failed: "the taskport right cannot be read (security: an unknown text)", toolCalls: 4 },
    { name: "security is missing", runs: { taskport: [NO_TOOL] }, failed: "the taskport right cannot be read (security: no tool)", toolCalls: 4 },
  ];
  for (const c of cases) {
    const lib = c.lib ?? fakeLib(), tools = fakeRun({ dts: [MAC.dts], ...c.runs }), bg = fakeAsync();
    const m = await macProtectedStart({ load: c.load ?? lib.load, run: tools.fn, execPath: NODE, reader: { run: bg.fn } });
    assert.equal(bg.calls.length, 0, `${c.name}: no background reader`);
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

test("board ab-v16.97.15: a check of the protection runs no tool: with a reader whose tools answer after 1.4 s, dumpable() and the store's status answer at once; the timer's reads run DevToolsSecurity and security asynchronously, each with MAC_CHECK_MS", async () => {
  const bg = fakeAsync({}, 1400);
  const m = await start(fakeLib(), fakeRun(), { run: bg.fn, everyMs: 50 });
  try {
    await new Promise((r) => setTimeout(r, 120));
    assert.ok(bg.calls.length >= 2, "the timer started reads");
    const t0 = performance.now();
    for (let i = 0; i < 100; i++) assert.equal(m.dumpable(), false);
    const ms = performance.now() - t0;
    assert.ok(ms < 50, `100 checks in ${ms.toFixed(1)} ms (today each check ran DevToolsSecurity with spawnSync, up to 1.5 s)`);
    assert.deepEqual(bg.calls.slice(0, 2), [
      { cmd: "/usr/sbin/DevToolsSecurity", args: ["-status"], ms: MAC_CHECK_MS },
      { cmd: "/usr/bin/security", args: TP_ARGS, ms: MAC_CHECK_MS },
    ]);
    assert.equal(MAC_READ_EVERY_MS, 10_000);
    assert.equal(MAC_READING_MAX_AGE_MS, 25_000);
    assert.equal(MAC_CHECK_MS, 1500);
  } finally { m.mac.stop(); }
});

test("board ab-v16.97.15: the background reader: a read of enabled, or a form of the right that does not hold, latches dumpable until the service starts again and tells the watchers; a read that fails or comes late does not hold until the next read that holds, with no latch", async () => {
  // A read of DevToolsSecurity enabled: the latch, also after a read of disabled.
  const lines: string[] = [];
  const bg = fakeAsync();
  const r = new MacProtectionReader({ run: bg.fn, log: (l) => lines.push(l), sharedS: 36000 });
  let lost = 0;
  r.onLost(() => lost++);
  await r.fresh();
  assert.equal(r.dumpable(), false, "disabled and the default right: holds");
  assert.equal(lost, 0);
  bg.set(MAC_TOOLS.devToolsSecurity, [DTS_ON]);
  await r.fresh();
  assert.equal(r.dumpable(), true, "enabled");
  assert.equal(lost, 1, "the watchers hear of it at once");
  bg.set(MAC_TOOLS.devToolsSecurity, [MAC.dts]);
  await r.fresh();
  assert.equal(r.dumpable(), true, "disabled again: still dumpable until the service starts again");
  assert.deepEqual(lines, ["service: the Mac's protection does not hold until the service starts again (DevToolsSecurity is enabled); the stored sign-ins lock"]);
  // A weak form of the right: the latch too.
  for (const [body, meaning] of [
    ["<key>class</key><string>user</string><key>authenticate-user</key><true/><key>shared</key><true/>", "a password once, shared with no timeout"],
    ["<key>class</key><string>user</string><key>authenticate-user</key><false/>", "a group member with no password"],
    ["<key>class</key><string>allow</string>", "allow: no password"],
  ] as const) {
    const b2 = fakeAsync(), seen: string[] = [];
    const r2 = new MacProtectionReader({ run: b2.fn, log: (l) => seen.push(l), sharedS: 36000 });
    b2.set(MAC_TOOLS.security, [run(RIGHT(body))]);
    await r2.fresh();
    b2.set(MAC_TOOLS.security, [MAC.taskport]);
    await r2.fresh();
    assert.equal(r2.dumpable(), true, `${meaning}: latched`);
    assert.deepEqual(seen, [`service: the Mac's protection does not hold until the service starts again (the taskport right does not hold (${meaning})); the stored sign-ins lock`]);
  }
  // A read that fails or comes late: dumpable for that reading only; the next read that holds clears it; no latch.
  const failing: [string, { dts?: ToolRun[]; taskport?: ToolRun[] }, string][] = [
    ["DevToolsSecurity times out", { dts: [TIMEOUT] }, "DevToolsSecurity's state cannot be read (DevToolsSecurity: timeout)"],
    ["DevToolsSecurity gives an unknown text", { dts: [run("something else\n")] }, "DevToolsSecurity's state cannot be read (DevToolsSecurity: an unknown text)"],
    ["security times out", { taskport: [TIMEOUT] }, "the taskport right cannot be read (security: timeout)"],
    ["security is missing", { taskport: [NO_TOOL] }, "the taskport right cannot be read (security: no tool)"],
  ];
  for (const [what, runs, why] of failing) {
    const b3 = fakeAsync(runs), seen: string[] = [];
    const r3 = new MacProtectionReader({ run: b3.fn, log: (l) => seen.push(l), sharedS: 36000 });
    let n = 0;
    r3.onLost(() => n++);
    await r3.fresh();
    assert.equal(r3.dumpable(), true, `${what}: dumpable`);
    assert.equal(n, 1, `${what}: the watchers hear of it`);
    await r3.fresh();
    assert.equal(n, 2, `${what}: each reading that does not hold tells them`);
    b3.set(MAC_TOOLS.devToolsSecurity, [MAC.dts]);
    b3.set(MAC_TOOLS.security, [MAC.taskport]);
    await r3.fresh();
    assert.equal(r3.dumpable(), false, `${what}: the next read that holds clears it`);
    assert.equal(r3.taskportSharedS(), 36000);
    assert.deepEqual(seen, [`service: the Mac's protection does not hold for now (${why}); the stored sign-ins lock`, "service: the Mac's protection holds again"], `${what}: one line each way`);
  }
});

test("board ab-v16.97.15: a reader that is stuck: its reading grows older than MAC_READING_MAX_AGE_MS, so dumpable holds and the watchers hear of it once; a read that ends after a newer read changes nothing", async () => {
  const c = clock();
  const stuck = fakeAsync({}, null);
  const lines: string[] = [];
  const r = new MacProtectionReader({ run: stuck.fn, now: c.now, log: (l) => lines.push(l), sharedS: 36000 });
  let lost = 0;
  r.onLost(() => lost++);
  assert.equal(r.dumpable(), false, "the start's reading");
  c.add(MAC_READING_MAX_AGE_MS);
  r.tick();
  assert.equal(r.dumpable(), false, "25 s old: holds");
  assert.equal(lost, 0);
  c.add(1);
  assert.equal(r.dumpable(), true, "older than 25 s: dumpable");
  r.tick();
  r.tick();
  assert.equal(lost, 1, "one tell for a reading that grew too old");
  assert.deepEqual(lines, ["service: the Mac's protection does not hold for now (its last read is older than 25 s); the stored sign-ins lock"]);
  assert.equal(stuck.calls.length, 6, "each tick starts a read of both tools");
});

/** A runner whose first DevToolsSecurity run answers only at release (a slow read); every other run answers at once. */
function slowFirst(later: ToolRun = MAC.dts) {
  let release: ((x: ToolRun) => void) | null = null;
  let first = true;
  const run: MacToolRunAsync = (cmd) => {
    if (cmd === MAC_TOOLS.devToolsSecurity && first) { first = false; return new Promise((res) => { release = res; }); }
    return Promise.resolve(cmd === MAC_TOOLS.devToolsSecurity ? later : MAC.taskport);
  };
  return { run, release: (x: ToolRun) => release!(x) };
}
const turns = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

test("the review's C1 (board ab-v16.97.15): a read of enabled that ends after a later read of disabled still latches, logs once and tells the watchers; the later read keeps the reading; a fresh read waits for each read that runs", async () => {
  // The reviewer's order: the timer's read 1 sees enabled but ends slowly; read 2 sees disabled and ends first.
  const s1 = slowFirst(), lines: string[] = [];
  const r = new MacProtectionReader({ run: s1.run, log: (l) => lines.push(l), sharedS: 36000 });
  let lost = 0;
  r.onLost(() => lost++);
  r.tick();
  r.tick();
  await turns();
  assert.equal(r.dumpable(), false, "read 2 (disabled) ended first");
  assert.equal(lost, 0);
  s1.release(DTS_ON);
  await turns();
  assert.equal(r.dumpable(), true, "read 1's enabled latches, whatever its order (on 0c3b9e4: dropped, no latch)");
  assert.equal(lost, 1, "the watchers hear of it: an open store locks");
  assert.deepEqual(lines, ["service: the Mac's protection does not hold until the service starts again (DevToolsSecurity is enabled); the stored sign-ins lock"]);
  await r.fresh();
  assert.equal(r.dumpable(), true, "a later read of disabled: still latched");
  assert.equal(lines.length, 1, "one log line");
  // A fresh read (an unlock's) waits for a slow read that started before it: it ends only after that read, and then the
  // latch holds (on 0c3b9e4 the fresh read ended first with dumpable false).
  const s2 = slowFirst();
  const r2 = new MacProtectionReader({ run: s2.run, sharedS: 36000 });
  r2.tick();
  let done = false;
  const f = r2.fresh().then(() => { done = true; });
  await turns();
  assert.equal(done, false, "the fresh read waits for the read that runs");
  s2.release(DTS_ON);
  await f;
  assert.equal(r2.dumpable(), true, "the unlock's check after its fresh read sees the latch");
});

test("the re-check's I1 (board ab-v16.97.15): an age timer that fires early by the reader's clock sets itself again, so the watchers hear of the age bound with no tick", async () => {
  const stuck = fakeAsync({}, null);
  let lag = 0;
  const r = new MacProtectionReader({ run: stuck.fn, now: () => Date.now() - lag, everyMs: 60_000, maxAgeMs: 150, sharedS: 36000 }).start();
  // From now on the reader's clock reads 5 ms behind the timers, so the age timer's first fire comes "early".
  lag = 5;
  let lost = 0;
  r.onLost(() => lost++);
  try {
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(r.dumpable(), true);
    assert.equal(lost, 1, "the watchers heard of it (on 7a95b2f: only at the next tick, 60 s later)");
    assert.equal(stuck.calls.length, 0, "no tick ran");
  } finally { r.stop(); }
});

test("the review's M1 (board ab-v16.97.15): the age bound tells the watchers when the reading passes 25 s, not at the next tick: with a stuck reader, an age bound of 150 ms and a period of 60 s, the watchers hear of it within about 150 ms", async () => {
  const stuck = fakeAsync({}, null);
  const lines: string[] = [];
  const r = new MacProtectionReader({ run: stuck.fn, everyMs: 60_000, maxAgeMs: 150, log: (l) => lines.push(l), sharedS: 36000 }).start();
  let lost = 0;
  r.onLost(() => lost++);
  try {
    await new Promise((res) => setTimeout(res, 100));
    assert.equal(lost, 0, "100 ms: the reading holds");
    await new Promise((res) => setTimeout(res, 200));
    assert.equal(r.dumpable(), true);
    assert.equal(lost, 1, "the watchers heard of it at the age bound (on 0c3b9e4: only at the next tick, 60 s later)");
    assert.equal(stuck.calls.length, 0, "no tick ran");
    assert.deepEqual(lines, ["service: the Mac's protection does not hold for now (its last read is older than 0 s); the stored sign-ins lock"]);
  } finally { r.stop(); }
  // A read that holds moves the age timer: a reader whose reads answer at once keeps holding past the bound.
  const ok = fakeAsync();
  const r2 = new MacProtectionReader({ run: ok.fn, everyMs: 50, maxAgeMs: 150, sharedS: 36000 }).start();
  let lost2 = 0;
  r2.onLost(() => lost2++);
  try {
    await new Promise((res) => setTimeout(res, 400));
    assert.equal(lost2, 0, "each read that holds sets the age timer again");
    assert.equal(r2.dumpable(), false);
  } finally { r2.stop(); }
});

test("board ab-v16.97.15: what each form of the taskport right means for the protection (the Mac design note, 6.1), and the shared timeout for the status", () => {
  const p = (body: string) => parseTaskport(run(RIGHT(body)));
  assert.equal(TASKPORT_TIMEOUT_MAX, 36000, "the default that the probe's Mac run read on 2026-11-27");
  assert.equal(taskportHolds(parseTaskport(MAC.taskport)), "holds", "the default: a password once, shared for 36000 s");
  assert.equal(taskportSharedS(parseTaskport(MAC.taskport)), 36000);
  assert.equal(taskportHolds(p("<key>class</key><string>user</string><key>authenticate-user</key><true/><key>shared</key><false/>")), "holds", "a password at each request");
  assert.equal(taskportSharedS(p("<key>class</key><string>user</string><key>authenticate-user</key><true/><key>shared</key><false/>")), null, "not shared");
  assert.equal(taskportHolds(p("<key>class</key><string>user</string><key>authenticate-user</key><true/><key>shared</key><true/><key>timeout</key><integer>0</integer>")), "holds", "shared for 0 s: a password at each request");
  assert.equal(taskportHolds(p("<key>class</key><string>deny</string>")), "holds", "deny");
  assert.equal(taskportHolds(p("<key>class</key><string>user</string><key>authenticate-user</key><true/><key>shared</key><true/><key>timeout</key><integer>600</integer>")), "holds", "a shorter timeout");
  assert.equal(taskportSharedS(p("<key>class</key><string>user</string><key>shared</key><true/><key>timeout</key><integer>600</integer>")), 600);
  for (const [body, meaning] of [
    ["<key>class</key><string>user</string><key>authenticate-user</key><true/><key>shared</key><true/><key>timeout</key><integer>36001</integer>", "a password once, shared for its timeout"],
    ["<key>class</key><string>user</string><key>authenticate-user</key><true/><key>shared</key><true/>", "a password once, shared with no timeout"],
    ["<key>class</key><string>user</string><key>authenticate-user</key><false/>", "a group member with no password"],
    ["<key>class</key><string>allow</string>", "allow: no password"],
    ["<key>class</key><string>rule</string><key>rule</key><string>allow</string>", "allow: no password"],
    ["<key>class</key><string>rule</string><key>rule</key><array><string>is-developer</string></array>", "a rule"],
    ["<key>class</key><string>evaluate-mechanisms</string>", "another form"],
  ] as const) {
    const t = p(body);
    assert.equal(t.meaning, meaning);
    assert.equal(taskportHolds(t), "weak", `${meaning}: does not hold, a latch`);
  }
  assert.equal(taskportHolds(parseTaskport(run("", 1, { stderr: "NO (-60005)\n" }))), "weak", "no right: a latch");
  // The review's M2: a form that the read does not state in full fails closed (on 0c3b9e4 both held).
  for (const [body, what] of [
    ["<key>class</key><string>user</string><key>authenticate-user</key><true/><key>group</key><string>_developer</string>", "no shared key"],
    ["<key>class</key><string>user</string><key>authenticate-user</key><true/><key>shared</key><true/><key>timeout</key><integer>-1</integer>", "a shared timeout below 0"],
  ] as const) {
    const t = p(body);
    assert.equal(t.meaning, "another form", what);
    assert.equal(taskportHolds(t), "weak", `${what}: does not hold, a latch`);
    assert.equal(taskportSharedS(t), null, `${what}: no shared timeout`);
  }
  // Board ab-v16.97.17: on a8ab172 the first four held, and the last two read as "unknown" (no latch).
  for (const [body, what] of [
    ["<key>class</key><string>user</string><key>group</key><string>_developer</string><key>shared</key><true/><key>timeout</key><integer>36000</integer>", "no authenticate-user key, the default's other fields"],
    ["<key>class</key><string>user</string><key>shared</key><false/>", "no authenticate-user key, not shared"],
    ["<key>class</key><string>user</string><key>authenticate-user</key><string>true</string><key>shared</key><true/><key>timeout</key><integer>600</integer>", "an authenticate-user that is not a flag"],
    ["<key>class</key><string>user</string><key>authenticate-user</key><true/><key>shared</key><false/><key>timeout</key><integer>-5</integer>", "a timeout below 0, not shared"],
    ["<key>authenticate-user</key><true/><key>shared</key><true/><key>timeout</key><integer>600</integer>", "no class key"],
    ["<key>class</key><integer>1</integer><key>authenticate-user</key><true/><key>shared</key><false/>", "a class that is no string"],
  ] as const) {
    const t = p(body);
    assert.equal(t.meaning, "another form", what);
    assert.equal(taskportHolds(t), "weak", `${what}: does not hold, a latch`);
  }
  // The review's M3: a shared timeout of 0 is 0 (on 0c3b9e4: null); a shared right with no timeout has none.
  assert.equal(taskportSharedS(p("<key>class</key><string>user</string><key>shared</key><true/><key>timeout</key><integer>0</integer>")), 0);
  assert.equal(taskportSharedS(p("<key>class</key><string>user</string><key>shared</key><true/>")), null);
  assert.equal(taskportHolds(parseTaskport(TIMEOUT)), "unknown", "a read that came late says nothing");
  assert.equal(taskportHolds(parseTaskport(run("YES (0)"))), "unknown");
  assert.equal(taskportSharedS(parseTaskport(TIMEOUT)), null);
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

test("board ab-v16.97.15: the background reader's real runner: one asynchronous run with a time limit (SIGKILL) and the same run classes; the event loop runs while it waits", { timeout: 30_000 }, async () => {
  const ok = await runToolAsync(process.execPath, ["-e", "process.stdout.write('ok'); process.stderr.write('e')"], 10_000);
  assert.deepEqual([runClass(ok), ok.stdout, ok.stderr, ok.exit, ok.signal], ["ok", "ok", "e", 0, null]);
  const exit = await runToolAsync(process.execPath, ["-e", "process.exit(3)"], 10_000);
  assert.deepEqual([runClass(exit), exit.exit], ["exit", 3]);
  let ticks = 0;
  const timer = setInterval(() => ticks++, 20);
  const slow = await runToolAsync(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], 400);
  clearInterval(timer);
  assert.equal(runClass(slow), "timeout");
  assert.ok(slow.ms < 5_000, "the time limit ends the run");
  assert.ok(ticks >= 5, `the event loop ran while the tool ran (${ticks} ticks)`);
  const missing = await runToolAsync(join(tempDir("ab-mac-protect-"), "no-such-tool"), [], 1000);
  assert.equal(runClass(missing), "no tool");
});

test("the Mac's libSystem calls load only on the Mac", async () => {
  assert.deepEqual(await loadMacMemLib("linux"), { failed: "no ptrace PT_DENY_ATTACH on linux" });
  assert.deepEqual(await loadMacMemLib("win32"), { failed: "no ptrace PT_DENY_ATTACH on win32" });
});

test("main.ts (board ab-v16.97.15): on the Mac the service logs a line before the Mac's protected start, runs it before any door opens, logs its result in one line, and gives its reader to the store (the hello has sign_ins); on Linux the non-dumpable start and its lines as before", async () => {
  const never = async (): Promise<never> => { throw new Error("the other system's start"); };
  // The Mac: all hold. The line "begins" comes before the ptrace call (review M5: a service that a debugger traces exits
  // at that call, so the line leaves a trace), and the result's line after it.
  let lines: string[] = [];
  const lib = fakeLib(), ptrace = lib.lib.ptrace;
  lib.lib.ptrace = (...a) => { lines.push("(the ptrace call)"); return ptrace(...a); };
  let m = await memoryStart("darwin", (l) => lines.push(l), { linux: never, mac: () => start(lib) });
  assert.ok(m !== null && m.failed === null && m.dumpable() === false && m.mac !== undefined, "the store gets the Mac's reader (today: null, no store on the Mac)");
  m.mac!.stop();
  assert.deepEqual(lines, [MAC_START_BEGINS, "(the ptrace call)", MAC_START_HOLDS]);
  assert.equal(MAC_START_BEGINS, "service: the Mac's protected start begins");
  assert.equal(MAC_START_HOLDS, "service: the Mac's protected start holds (ptrace PT_DENY_ATTACH, RLIMIT_CORE 0, no get-task-allow, SIP enabled, DevToolsSecurity disabled, the taskport right holds); its background reader reads DevToolsSecurity and the taskport right every 10 s");
  // The store's option on the Mac: the reason, the fresh read, the watchers and the Mac keys of the status.
  const opt = signInsOption(m);
  assert.deepEqual(Object.keys(opt).sort(), ["fresh", "mac", "protections", "watchProtections"]);
  assert.notEqual(opt.protections(), "dumpable", "the Mac's reader holds (this test process holds no SIGUSR1 listener, so the signal's reason can come)");
  assert.equal(opt.mac!.taskportSharedS(), 36000);
  // The Mac: one fails; the line names the failed check, and the store gets a reader that always says dumpable.
  lines = [];
  m = await memoryStart("darwin", (l) => lines.push(l), { linux: never, mac: () => start(fakeLib(), fakeRun({ dts: [DTS_ON] })) });
  assert.ok(m !== null && m.failed === "DevToolsSecurity is enabled" && m.dumpable() === true);
  assert.equal(protectionReason(m.dumpable, () => true), "dumpable");
  assert.deepEqual(lines, [MAC_START_BEGINS, "service: the Mac's protected start does not hold (DevToolsSecurity is enabled), so the stored sign-ins do not open"]);
  lines = [];
  m = await memoryStart("darwin", (l) => lines.push(l), { linux: never, mac: () => start(fakeLib(), fakeRun({ taskport: [run(RIGHT("<key>class</key><string>allow</string>"))] })) });
  assert.ok(m !== null && m.dumpable() === true);
  assert.deepEqual(lines, [MAC_START_BEGINS, "service: the Mac's protected start does not hold (the taskport right does not hold (allow: no password)), so the stored sign-ins do not open"]);
  assert.deepEqual(serviceFeatures("darwin"), ["sign_ins"], "the Mac's hello has sign_ins (today: none)");
  assert.deepEqual(serviceFeatures("darwin", true), ["sign_ins"], "no card_pay on the Mac");
  assert.deepEqual(serviceFeatures("linux"), ["sign_ins"]);
  assert.deepEqual(serviceFeatures("linux", true), ["sign_ins", "card_pay"]);
  assert.deepEqual(serviceFeatures("win32"), []);
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

// Review M6: serviceMain calls memoryStart, once, before any door opens. The closest seam: serviceMain's source (a run of
// serviceMain on the Mac needs launchd and macOS). The process test of test/service-signins.test.ts shows the order of
// the lines in a real run on Linux, through the same call.
test("serviceMain calls memoryStart once, for this system, before the MCP port, the control door and the agent door open; nothing else calls a start of the memory's protection", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "src", "service", "main.ts"), "utf8");
  const body = src.slice(src.indexOf("export async function serviceMain("));
  const call = "const memory = await memoryStart(process.platform, log);";
  assert.equal(body.split(call).length, 2, "one call in serviceMain");
  const at = body.indexOf(call);
  // The MCP port (launchd's or systemd's socket), then startService (the control door and the agent door).
  for (const door of ["launchdMcpListen(", "mcpListen(", "startService("]) {
    assert.ok(body.indexOf(door) > at, `memoryStart comes before ${door}`);
  }
  assert.equal(src.split("nonDumpableStart(").length - 1, 1, "main.ts calls nonDumpableStart only in memoryStart's default");
  assert.equal(src.split("macProtectedStart(").length - 1, 1, "main.ts calls macProtectedStart only in memoryStart's default");
});

// Review M1: SIP counts as enabled only with the text "status: enabled." (macOS 10.15 and older say "enabled (Custom
// Configuration)." when a part such as Debugging Restrictions is off).
test("csrutil: only \"status: enabled.\" is enabled; \"enabled (Custom Configuration)\" is unknown, and the start fails closed on it", async () => {
  assert.equal(parseCsrutil(run("System Integrity Protection status: enabled.\n")), "enabled");
  assert.equal(parseCsrutil(run("System Integrity Protection status: disabled.\n")), "disabled");
  const custom = run("System Integrity Protection status: enabled (Custom Configuration).\n\nConfiguration:\n\tApple Internal: disabled\n\tDebugging Restrictions: disabled\n");
  assert.equal(parseCsrutil(custom), "unknown");
  assert.equal(parseCsrutil(run("System Integrity Protection status: unknown (Custom Configuration).\n")), "unknown");
  assert.equal(parseCsrutil(run("System Integrity Protection status: enabled")), "unknown", "no full stop: an unknown text");
  const m = await start(fakeLib(), fakeRun({ csrutil: [custom] }));
  assert.equal(m.failed, "SIP's state cannot be read (csrutil: an unknown text)");
  assert.equal(m.dumpable(), true);
});

// Review M2: a throw of node:ffi (a later Node's change of its API) fails closed with its reason; it never stops the start.
test("the Mac's protected start fails closed when a libSystem call or the load throws: the reason names it, and nothing after it runs", async () => {
  const cases: { name: string; lib: () => MacMemLib | Promise<never>; failed: RegExp }[] = [
    { name: "the load throws", lib: () => Promise.reject(new TypeError("dlopen is not a function")), failed: /^libSystem does not load \(dlopen is not a function\)$/ },
    { name: "ptrace throws", lib: () => ({ ...fakeLib().lib, ptrace: () => { throw new TypeError("bad argument 3"); } }), failed: /^a libSystem call threw \(bad argument 3\)$/ },
    { name: "setrlimit throws", lib: () => ({ ...fakeLib().lib, setrlimit: () => { throw new TypeError("no buffer type"); } }), failed: /^a libSystem call threw \(no buffer type\)$/ },
    { name: "getrlimit throws", lib: () => ({ ...fakeLib().lib, getrlimit: () => { throw new Error("x"); } }), failed: /^a libSystem call threw \(x\)$/ },
    { name: "errno throws after a failed ptrace", lib: () => ({ ...fakeLib({ ptrace: -1 }).lib, errno: () => { throw new Error("no getInt32"); } }), failed: /^a libSystem call threw \(no getInt32\)$/ },
  ];
  for (const c of cases) {
    const tools = fakeRun();
    const m = await macProtectedStart({ load: async () => c.lib(), run: tools.fn, execPath: NODE });
    assert.match(m.failed ?? "", c.failed, c.name);
    assert.equal(tools.calls.length, 0, `${c.name}: no tool runs`);
    assert.equal(m.dumpable(), true, c.name);
    assert.equal(protectionReason(m.dumpable, () => true), "dumpable", c.name);
  }
});

// Review M6: the real dlopen declaration, pinned: a wrong type (for example "int32" for ptrace's addr) fails here.
test("loadMacMemLib: node:ffi's dlopen of /usr/lib/libSystem.B.dylib with the declarations of ptrace, setrlimit, getrlimit and __error, exactly; errno reads an int32 at __error's pointer", async () => {
  const seen: { path?: string; decls?: unknown; ints: [unknown, number][]; calls: unknown[][] } = { ints: [], calls: [] };
  const ffi = {
    dlopen: (path: string, decls: unknown) => {
      seen.path = path; seen.decls = decls;
      return { functions: {
        ptrace: (...a: unknown[]) => { seen.calls.push(["ptrace", ...a]); return 0; },
        setrlimit: (...a: unknown[]) => { seen.calls.push(["setrlimit", ...a]); return 0; },
        getrlimit: (...a: unknown[]) => { seen.calls.push(["getrlimit", ...a]); return 0; },
        __error: () => 0x7000n,
      } };
    },
    getInt32: (p: unknown, off: number) => { seen.ints.push([p, off]); return 45; },
  };
  const lib = await loadMacMemLib("darwin", async () => ({ ffi }));
  assert.ok(!("failed" in lib));
  assert.equal(seen.path, "/usr/lib/libSystem.B.dylib");
  assert.deepEqual(seen.decls, {
    ptrace: { return: "int32", arguments: ["int32", "int32", "pointer", "int32"] },
    setrlimit: { return: "int32", arguments: ["int32", "buffer"] },
    getrlimit: { return: "int32", arguments: ["int32", "buffer"] },
    __error: { return: "pointer", arguments: [] },
  });
  const l = lib as MacMemLib;
  assert.equal(l.ptrace(PT_DENY_ATTACH, 0, 0n, 0), 0);
  assert.equal(l.errno(), 45);
  assert.deepEqual(seen.ints, [[0x7000n, 0]]);
  assert.deepEqual(seen.calls, [["ptrace", 31, 0, 0n, 0]]);
  // A dlopen that throws, and an ffi that does not load, give failed; Linux never loads it.
  assert.match(((await loadMacMemLib("darwin", async () => ({ ffi: { dlopen: () => { throw new Error("image not found"); } } }))) as { failed: string }).failed, /^dlopen of libSystem failed: image not found$/);
  assert.deepEqual(await loadMacMemLib("darwin", async () => ({ failed: "node:ffi does not load (ERR_UNKNOWN_BUILTIN_MODULE)" })), { failed: "node:ffi does not load (ERR_UNKNOWN_BUILTIN_MODULE)" });
  assert.deepEqual(await loadMacMemLib("linux", async () => ({ ffi })), { failed: "no ptrace PT_DENY_ATTACH on linux" });
});
