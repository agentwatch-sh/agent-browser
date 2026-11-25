// The Mac memory probe (test/live/mac-memory-probe/; board ab-v16.97.8, part 1): its pure parts (parts.ts) with made-up
// outputs of Apple's tools (DevToolsSecurity, csrutil, id, xcode-select, codesign, launchctl print, vmmap, leaks, lldb),
// the kern_return_t names, the marker's byte search, the guards, the summary and the result's shape and check; and on
// Linux one run of the probe itself (its dry run: T0 and T1 start and end, the tool runner's check, the cleanup).
//
// The tools' outputs here are NOT measured: they are written from Apple's man pages and the tools' usual output as known
// on the Linux server. The Mac run checks them; its JSON keeps each class's notes and exit codes for that.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { tempDir, done } from "./temp-dirs.ts";
import {
  ByteSearch, ENTITLEMENTS, KERN_RETURN, MARKER_BYTES, NOTE_SCAN, RESULT_KEYS, T2_ENTITLEMENTS, TARGETS, TIME_LIMIT_MS, TOOL_MS,
  checkResult, entitlementsPlist, guardsOf, krName, notesOf, parseCodesign, parseCsrutil, parseDeveloperGroup, parseDeveloperTools,
  parseDevToolsSecurity, parseEntitlements, parseLaunchctlJob, portJson, programForm, readerClass, readerJson, resultOf, runClass, scrub,
  searchChunks, signatureJson, summaryOf, type Meta, type ToolRun,
} from "./live/mac-memory-probe/parts.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PROBE = fileURLToPath(new URL("./live/mac-memory-probe/probe.ts", import.meta.url));
const META: Meta = { version: 1, commit: "0123456789abcdef0123456789abcdef01234567", dirty: false };

/** A made-up run of a tool. */
const run = (text: string, exit: number | null = 0, more: Partial<ToolRun> = {}): ToolRun => ({ exit, signal: null, timedOut: false, spawnError: null, text, ms: 12, ...more });
const TIMEOUT = run("", null, { signal: "SIGKILL", timedOut: true });
const NO_TOOL = run("", null, { spawnError: "ENOENT" });

// ------------------------------------------------------------------ Q1

test("the short reads' classes: ok, exit, timeout, killed, no tool, spawn failed", () => {
  assert.equal(runClass(run("x")), "ok");
  assert.equal(runClass(run("x", 2)), "exit");
  assert.equal(runClass(TIMEOUT), "timeout");
  assert.equal(runClass(run("", null, { signal: "SIGSEGV" })), "killed");
  assert.equal(runClass(NO_TOOL), "no tool");
  assert.equal(runClass(run("", null, { spawnError: "EACCES" })), "spawn failed");
});

test("Q1: DevToolsSecurity -status, csrutil status, id -Gn and xcode-select -p", () => {
  assert.equal(parseDevToolsSecurity(run("Developer mode is currently enabled.\n")), "enabled");
  assert.equal(parseDevToolsSecurity(run("Developer mode is currently disabled.\n")), "disabled");
  assert.equal(parseDevToolsSecurity(run("something else\n")), "unknown");
  assert.equal(parseDevToolsSecurity(run("Developer mode is currently enabled.\n", 1)), "unknown", "a failed read decides nothing");
  assert.equal(parseDevToolsSecurity(TIMEOUT), "unknown");

  assert.equal(parseCsrutil(run("System Integrity Protection status: enabled.\n")), "enabled");
  assert.equal(parseCsrutil(run("System Integrity Protection status: disabled.\n")), "disabled");
  assert.equal(parseCsrutil(run("System Integrity Protection status: unknown (Custom Configuration).\n\nConfiguration:\n\tApple Internal: disabled\n\tDebugging Restrictions: enabled\n")), "unknown");
  assert.equal(parseCsrutil(NO_TOOL), "unknown");

  assert.equal(parseDeveloperGroup(run("staff everyone localaccounts _appserverusr admin _developer _lpadmin\n")), true);
  assert.equal(parseDeveloperGroup(run("staff everyone localaccounts admin\n")), false);
  assert.equal(parseDeveloperGroup(run("staff _developers\n")), false, "only the whole name");
  assert.equal(parseDeveloperGroup(run("", 1)), null);

  assert.equal(parseDeveloperTools(run("/Library/Developer/CommandLineTools\n")), true);
  assert.equal(parseDeveloperTools(run("xcode-select: error: unable to get active developer directory\n", 2)), false);
  assert.equal(parseDeveloperTools(NO_TOOL), false);
  assert.equal(parseDeveloperTools(TIMEOUT), null);
});

// ------------------------------------------------------------------ Q2

const CD_HOMEBREW = [
  "Executable=/opt/homebrew/Cellar/node/26.1.0/bin/node",
  "Identifier=node",
  "Format=Mach-O thin (arm64)",
  "CodeDirectory v=20400 size=812345 flags=0x20002(adhoc,linker-signed) hashes=25381+0 location=embedded",
  "Hash type=sha256 size=32",
  "CDHash=0123456789abcdef0123456789abcdef01234567",
  "Signature=adhoc",
  "Info.plist=not bound",
  "TeamIdentifier=not set",
  "Sealed Resources=none",
  "Internal requirements=none",
].join("\n");
const CD_OFFICIAL = [
  "Executable=/usr/local/bin/node",
  "Identifier=node",
  "Format=Mach-O universal (x86_64 arm64)",
  "CodeDirectory v=20500 size=815000 flags=0x10000(runtime) hashes=25400+7 location=embedded",
  "Signature size=8980",
  "Authority=Developer ID Application: Some Foundation (ABCDE12345)",
  "Authority=Developer ID Certification Authority",
  "Authority=Apple Root CA",
  "Timestamp=Oct 14, 2026 at 07:11:00",
  "TeamIdentifier=ABCDE12345",
  "Runtime Version=15.0.0",
].join("\n");
const CD_APPLE = [
  "Executable=/usr/bin/env",
  "Identifier=com.apple.env",
  "CodeDirectory v=20400 size=400 flags=0x0(none) hashes=7+7 location=embedded",
  "Platform identifier=15",
  "Authority=Software Signing",
  "Authority=Apple Code Signing Certification Authority",
  "Authority=Apple Root CA",
].join("\n");
const ENT_XML = (pairs: [string, string][]) =>
  `Executable=/x/node\n<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>${pairs.map(([k, v]) => `<key>${k}</key>${v}`).join("")}</dict></plist>\n`;

test("Q2: codesign -d --verbose=4: the kind, the hardened runtime and the flag names; no identifier and no team id", () => {
  assert.deepEqual(parseCodesign(run(CD_HOMEBREW)), { kind: "ad hoc", runtime: false, flags: ["adhoc", "linker-signed"] });
  assert.deepEqual(parseCodesign(run(CD_OFFICIAL)), { kind: "Developer ID", runtime: true, flags: ["runtime"] });
  assert.deepEqual(parseCodesign(run(CD_APPLE)), { kind: "Apple", runtime: false, flags: ["none"] });
  assert.deepEqual(parseCodesign(run(CD_APPLE.replace(/^Authority=.*\n?/gm, ""))), { kind: "Apple", runtime: false, flags: ["none"] }, "a platform binary with no authority line");
  assert.deepEqual(parseCodesign(run("/x/node: code object is not signed at all\n", 1)), { kind: "none", runtime: false, flags: [] });
  assert.deepEqual(parseCodesign(run("error: something\n", 1)), { kind: "unknown", runtime: null, flags: [] });
  assert.deepEqual(parseCodesign(run(CD_OFFICIAL.replace("Developer ID Application: Some Foundation", "Apple Development: someone"))), { kind: "other", runtime: true, flags: ["runtime"] });
  assert.deepEqual(parseCodesign(run(CD_OFFICIAL.replace("flags=0x10000(runtime)", "flags=0x12000(runtime,newflag)"))).flags, ["runtime", "other"]);
  assert.equal(parseCodesign(run("Identifier=node\n")).runtime, null, "no CodeDirectory line: the flag is not known");
  const keys = JSON.stringify(parseCodesign(run(CD_OFFICIAL)));
  assert.ok(!keys.includes("ABCDE12345") && !keys.includes("node"), "no team id and no identifier");
});

test("Q2: codesign -d --entitlements - --xml: true, false or absent for each; empty is none; another form is not known", () => {
  const e = parseEntitlements(run(ENT_XML([
    [ENTITLEMENTS.allowJit, "<true/>"], [ENTITLEMENTS.allowUnsignedExecutableMemory, "<true/>"], [ENTITLEMENTS.debugger, "<true/>"],
    [ENTITLEMENTS.disableLibraryValidation, "<false/>"], ["com.apple.security.cs.allow-dyld-environment-variables", "<true/>"],
  ])));
  assert.deepEqual(e, { getTaskAllow: false, debugger: true, allowJit: true, allowUnsignedExecutableMemory: true, disableLibraryValidation: false });
  const spaced = parseEntitlements(run(`<?xml version="1.0"?>\n<plist version="1.0">\n<dict>\n\t<key>${ENTITLEMENTS.getTaskAllow}</key>\n\t<true/>\n</dict>\n</plist>\n`));
  assert.equal(spaced.getTaskAllow, true);
  assert.deepEqual(Object.values(parseEntitlements(run("Executable=/x/node\n"))), [false, false, false, false, false], "no entitlements");
  assert.deepEqual(Object.values(parseEntitlements(run("bplist00\u0001\u0002"))), [null, null, null, null, null]);
  assert.deepEqual(Object.values(parseEntitlements(run("[Dict]\n\t[Key] com.apple.security.cs.allow-jit\n"))), [null, null, null, null, null]);
  assert.deepEqual(Object.values(parseEntitlements(run(ENT_XML([]), 1))), [null, null, null, null, null], "a failed read");
  assert.equal(parseEntitlements(run(`<plist><dict><key>${ENTITLEMENTS.allowJit}</key><true/>`)).allowJit, null, "a cut plist");
  // T2's plist, as codesign would print it back.
  const plist = entitlementsPlist();
  assert.ok(!plist.includes(ENTITLEMENTS.getTaskAllow) && !plist.includes(ENTITLEMENTS.debugger));
  assert.deepEqual(parseEntitlements(run(plist)), { getTaskAllow: false, debugger: false, allowJit: true, allowUnsignedExecutableMemory: true, disableLibraryValidation: true });
  assert.deepEqual(T2_ENTITLEMENTS, ["allowJit", "allowUnsignedExecutableMemory", "disableLibraryValidation"]);
  // An unsigned file has no entitlements, whatever the second read says.
  const none = signatureJson(run("/x: code object is not signed at all\n", 1), run("/x: code object is not signed at all\n", 1));
  assert.deepEqual([none.kind, none.runtime, Object.values(none.entitlements)], ["none", false, [false, false, false, false, false]]);
  assert.deepEqual(none.reads, { display: { class: "exit", exit: 1, ms: 12 }, entitlements: { class: "exit", exit: 1, ms: 12 } });
});

test("Q2: launchctl print of the service's job: loaded, its state and its program (the path stays in the probe)", () => {
  const t = "gui/501/com.agentwatch.agent-browser";
  const job = (body: string) => `${t} = {\n\tactive count = 1\n\tpath = /srv/hm-someone/Library/LaunchAgents/com.agentwatch.agent-browser.plist\n\ttype = LaunchAgent\n${body}\tendpoints = {\n\t\tstate = active\n\t}\n}\n`;
  const args = "\targuments = {\n\t\t/opt/homebrew/bin/node\n\t\t/srv/hm-someone/agent-browser/bin/agent-browser.js\n\t\tservice\n\t}\n";
  assert.deepEqual(parseLaunchctlJob(run(job(`\tstate = running\n\n\tprogram = /opt/homebrew/bin/node\n${args}\tpid = 4242\n`)), t), { loaded: true, state: "running", program: "/opt/homebrew/bin/node" });
  assert.deepEqual(parseLaunchctlJob(run(job(`\tstate = not running\n${args}`)), t), { loaded: true, state: "not running", program: "/opt/homebrew/bin/node" }, "no program line: the first argument");
  assert.deepEqual(parseLaunchctlJob(run(job("\tstate = waiting\n")), t), { loaded: true, state: "waiting", program: null });
  assert.deepEqual(parseLaunchctlJob(run(job("\tstate = Odd_State!\n")), t).state, "other");
  assert.deepEqual(parseLaunchctlJob(run(`Could not find service "com.agentwatch.agent-browser" in domain for user gui: 501\n`, 113), t), { loaded: false, state: null, program: null });
  assert.deepEqual(parseLaunchctlJob(run("Bad request.\n", 5), t), { loaded: null, state: null, program: null });
  assert.deepEqual(parseLaunchctlJob(run(job("\tstate = running\n").replace(t, "gui/501/com.other")), t), { loaded: null, state: null, program: null }, "another job's output");
  assert.deepEqual(parseLaunchctlJob(TIMEOUT, t).loaded, null);
  assert.deepEqual([programForm("/opt/homebrew/bin/node"), programForm("node"), programForm(null)], ["absolute", "relative", "none"]);
});

// ------------------------------------------------------------------ Q3 a

test("kern_return_t names (osfmk/mach/kern_return.h) and read a as JSON", () => {
  assert.equal(KERN_RETURN.length, 57);
  assert.deepEqual([krName(0), krName(5), krName(46), krName(53), krName(56)], ["KERN_SUCCESS", "KERN_FAILURE", "KERN_NOT_SUPPORTED", "KERN_DENIED", "KERN_NOT_FOUND"]);
  assert.deepEqual([krName(57), krName(-1), krName(1.5)], ["unknown", "unknown", "unknown"]);
  assert.deepEqual(portJson("ok", 30, { self: "mach_task_self_", taskForPid: { kr: 5, port: false, deallocated: null }, taskReadForPid: { kr: 0, port: true, deallocated: true } }), {
    class: "ok", ms: 30, self: "mach_task_self_",
    taskForPid: { kr: 5, name: "KERN_FAILURE", port: false, deallocated: null },
    taskReadForPid: { kr: 0, name: "KERN_SUCCESS", port: true, deallocated: true },
  });
  assert.deepEqual(portJson("ok", 1, { self: "task_self_trap", taskForPid: { kr: 0, port: true, deallocated: true }, taskReadForPid: { symbol: "missing" } }).taskReadForPid, { symbol: "missing" });
  assert.deepEqual(portJson("ok", 1, { failed: "no task port of its own" }), { class: "failed", ms: 1, why: "no task port of its own", self: null, taskForPid: null, taskReadForPid: null });
  assert.deepEqual(portJson("timeout", TOOL_MS, null), { class: "timeout", ms: TOOL_MS, self: null, taskForPid: null, taskReadForPid: null });
});

// ------------------------------------------------------------------ Q3 b, c, d

const NOT_DEBUGGABLE = (tool: string) => `${tool}[999]: Process 4242 is not debuggable. Due to security restrictions, ${tool} can only show or save contents of readonly memory of restricted processes.\n\n`;
const CANNOT = (tool: string) => `${tool} cannot examine process 4242 (node) for unknown reasons, even though it appears to exist; try running with \`sudo\`.\n`;
const VMMAP_OK = "Process:         node [4242]\nPath:            /x/node\nCode Type:       ARM64\n----\n\nReadOnly portion of Libraries: Total=500.0M resident=100.0M(20%)\nWritable regions: Total=1.0G written=50.0M(5%) resident=60.0M(6%)\n";
const LLDB_OK = "(lldb) process attach --pid 4242\nProcess 4242 stopped\n* thread #1, queue = 'com.apple.main-thread', stop reason = signal SIGSTOP\n    frame #0: 0x000000018c1b2f2c libsystem_kernel.dylib`kevent + 8\n(lldb) process status\nProcess 4242 stopped\n(lldb) detach\nProcess 4242 detached\n";
const LLDB_NOT_ALLOWED = "(lldb) process attach --pid 4242\nerror: attach failed: Not allowed to attach to process.  Look in the console messages (Console.app), near the debugserver entries, when the attach failed.  The subsystem that denied the attach permission will likely have logged an informative message about why it was denied.\n";

test("the readers' classes: vmmap ok, limited and refused; never the tool's text", () => {
  assert.deepEqual(readerClass("vmmap", run(VMMAP_OK)), { class: "ok", notes: [] });
  assert.deepEqual(readerClass("vmmap", run(NOT_DEBUGGABLE("vmmap") + VMMAP_OK)), { class: "limited", notes: ["not debuggable", "restricted"] });
  assert.deepEqual(readerClass("vmmap", run(CANNOT("vmmap"), 1)), { class: "cannot examine", notes: ["cannot examine", "sudo"] });
  assert.deepEqual(readerClass("vmmap", run("vmmap: task_for_pid(4242) failed: (os/kern) failure\n", 1)), { class: "no task port", notes: ["no task port"] });
  assert.deepEqual(readerClass("vmmap", run("", 1)), { class: "failed", notes: [] });
  assert.deepEqual(readerClass("vmmap", run("", null, { signal: "SIGSEGV" })), { class: "killed", notes: [] });
  assert.deepEqual(readerClass("vmmap", TIMEOUT), { class: "timeout", notes: [] });
  assert.deepEqual(readerClass("vmmap", NO_TOOL), { class: "no tool", notes: [] });
  const j = readerJson("vmmap", run(NOT_DEBUGGABLE("vmmap") + VMMAP_OK));
  assert.deepEqual(j, { class: "limited", notes: ["not debuggable", "restricted"], exit: 0, signal: null, ms: 12 });
  assert.equal(checkText(j), null, "no path of the text");
});

test("the readers' classes: leaks by its memory graph file (it exits 1 when it finds leaks), lldb by its attach", () => {
  const leaksReport = "Process:         node [4242]\nleaks Report Version: 4.0\nProcess 4242: 52112 nodes malloced for 7023 KB\nProcess 4242: 2 leaks for 96 total leaked bytes.\n";
  assert.deepEqual(readerClass("leaks", run(leaksReport, 1), 12_000_000), { class: "graph", notes: [] }, "exit 1 with leaks, and a graph");
  assert.deepEqual(readerClass("leaks", run(leaksReport, 0), 12_000_000), { class: "graph", notes: [] });
  assert.deepEqual(readerClass("leaks", run(NOT_DEBUGGABLE("leaks") + leaksReport, 1), 3_000_000), { class: "graph limited", notes: ["not debuggable", "restricted"] });
  assert.deepEqual(readerClass("leaks", run(CANNOT("leaks"), 1), null), { class: "cannot examine", notes: ["cannot examine", "sudo"] });
  assert.deepEqual(readerClass("leaks", run(leaksReport, 1), 0), { class: "no graph", notes: [] }, "an empty file is no graph");
  assert.deepEqual(readerClass("leaks", run("leaks: unrecognized option '--fullContent'\nUsage: leaks [options] pid\n", 64), null), { class: "usage", notes: ["usage"] });

  assert.deepEqual(readerClass("lldb", run(LLDB_OK)), { class: "attached", notes: ["stopped", "detached"] });
  assert.deepEqual(readerClass("lldb", run(LLDB_NOT_ALLOWED, 1)), { class: "not allowed", notes: ["not allowed", "attach failed"] });
  assert.deepEqual(readerClass("lldb", run("(lldb) process attach --pid 4242\nerror: attach failed: lost connection\n", 1)), { class: "lost connection", notes: ["lost connection", "attach failed"] });
  assert.deepEqual(readerClass("lldb", run("error: attach failed: Developer Tools Access needs to take control of another process; a password\n", 1)).class, "password");
  assert.deepEqual(readerClass("lldb", run("Process 4242 stopped\nerror: attach failed: unable to attach\n", 1)).class, "attach failed", "an attach that failed is no attach");
  assert.deepEqual(readerClass("lldb", run("(lldb) process attach --pid 4242\n", null, { timedOut: true, signal: "SIGKILL" })), { class: "timeout", notes: [] });
  assert.deepEqual(readerClass("lldb", run("", 1)), { class: "failed", notes: [] });
});

test("the notes come from the first NOTE_SCAN characters only (a leaks report holds the target's own strings later)", () => {
  assert.deepEqual(notesOf(`${"x".repeat(NOTE_SCAN)}permission denied`), []);
  assert.deepEqual(notesOf(`${"x".repeat(NOTE_SCAN - 20)}permission denied`), ["permission"]);
  assert.deepEqual(notesOf("ROOT CYCLE: <node> and leaks for root"), [], "no word of a leaks report counts");
});

// ------------------------------------------------------------------ Q3 c: the byte search

test("the marker's byte search: the raw bytes and the hex form, also across two chunks, never a regex", () => {
  const marker = Buffer.from("00112233445566778899aabbccddeeff00112233445566778899aabbccddee42", "hex");
  assert.equal(marker.length, MARKER_BYTES);
  const hex = Buffer.from(marker.toString("hex"), "latin1");
  const noise = (n: number) => Buffer.alloc(n, 0x5a);
  /** A stream of `parts` read in chunks of `size`. */
  const reader = (parts: Buffer[]) => { const all = Buffer.concat(parts); let at = 0; return (into: Buffer) => { const n = all.copy(into, 0, at, Math.min(all.length, at + into.length)); at += n; return n; }; };
  for (const size of [7, 31, 32, 33, 63, 64, 65, 1000]) {
    for (const split of [0, 1, 16, 31].filter((x) => x < size)) {
      const r = searchChunks(reader([noise(size - split), marker, noise(100)]), [marker, hex], size);
      assert.deepEqual(r.found, [true, false], `raw, chunk ${size}, offset ${split}`);
      const h = searchChunks(reader([noise(size * 3 - split), hex, noise(5)]), [marker, hex], size);
      assert.deepEqual(h.found, [false, true], `hex, chunk ${size}, offset ${split}`);
    }
  }
  assert.deepEqual(searchChunks(reader([noise(5000)]), [marker, hex], 64), { found: [false, false], bytes: 5000 });
  assert.deepEqual(searchChunks(reader([]), [marker, hex], 64), { found: [false, false], bytes: 0 });
  const half = searchChunks(reader([noise(10), marker.subarray(0, 31), noise(10)]), [marker], 16);
  assert.deepEqual(half.found, [false], "31 of 32 bytes is no marker");
  const s = new ByteSearch([marker]);
  s.push(marker.subarray(0, 10)); s.push(marker.subarray(10, 20)); s.push(marker.subarray(20));
  assert.equal(s.any, true, "a marker in three pieces");
});

// ------------------------------------------------------------------ the guards and the summary

test("the guards of reads a and d: no lldb without DevToolsSecurity enabled and developer tools; no task_for_pid by a debugger-entitled Node without DevToolsSecurity", () => {
  assert.deepEqual(guardsOf({ devToolsSecurity: "enabled", developerTools: true }, true), { a: "run", d: "run" });
  assert.deepEqual(guardsOf({ devToolsSecurity: "enabled", developerTools: false }, true), { a: "run", d: "skipped: no developer tools" });
  const off = guardsOf({ devToolsSecurity: "disabled", developerTools: true }, false);
  assert.deepEqual(off, { a: "run", d: "skipped: it would ask for a password (DevToolsSecurity is not enabled)" });
  assert.match(guardsOf({ devToolsSecurity: "disabled", developerTools: true }, true).a, /^skipped: it could ask for a password/);
  assert.match(guardsOf({ devToolsSecurity: "unknown", developerTools: true }, null).a, /^skipped: /, "entitlements not known");
  assert.match(guardsOf({ devToolsSecurity: "unknown", developerTools: null }, false).d, /^skipped: it would ask for a password/);
});

test("the summary of a target: a task port, the marker in a memory graph or an attach makes it readable", () => {
  const port = (kr: number) => ({ kr, name: krName(kr), port: kr === 0, deallocated: kr === 0 ? true : null });
  assert.equal(summaryOf(null), null);
  assert.deepEqual(summaryOf({ a: { taskForPid: port(5), taskReadForPid: port(5) }, b: { class: "limited" }, c: { class: "graph limited", markerFound: false }, cFull: { class: "graph limited", markerFound: false }, d: { class: "not allowed" } }), {
    taskPort: false, readPort: false, vmmap: "limited", leaksGraph: "graph limited", leaksMarker: false, lldbAttached: false, readable: false,
  });
  assert.deepEqual(summaryOf({ a: { taskForPid: port(5), taskReadForPid: port(0) }, b: { class: "ok" }, c: { class: "graph", markerFound: true }, d: { class: "attached" } }), {
    taskPort: false, readPort: true, vmmap: "ok", leaksGraph: "graph", leaksMarker: true, lldbAttached: true, readable: true,
  });
  assert.deepEqual(summaryOf({ a: { class: "skipped" } as never, b: { class: "ok" }, c: { class: "graph", markerFound: false }, cFull: { class: "graph", markerFound: true }, d: { class: "skipped" } }), {
    taskPort: null, readPort: null, vmmap: "ok", leaksGraph: "graph", leaksMarker: true, lldbAttached: null, readable: true,
  }, "cFull's marker counts; a skipped read is not known");
  assert.equal(summaryOf({ a: { taskForPid: port(5), taskReadForPid: { symbol: "missing" } }, c: { class: "no graph", markerFound: null }, d: { class: "skipped" } })!.readable, null);
  for (const d of ["timeout", "killed", "no tool"]) assert.equal(summaryOf({ d: { class: d } })!.lldbAttached, null, `lldb ${d}: not known`);
  for (const d of ["not allowed", "lost connection", "failed"]) assert.equal(summaryOf({ d: { class: d } })!.lldbAttached, false, `lldb ${d}`);
});

// ------------------------------------------------------------------ the result

const checkText = (v: unknown) => checkResult({ ...resultOf({ meta: META, platform: null, ok: false, stage: "x", reason: null, ms: 1, q1: v, q2: null, q3: null, summary: null, cleanup: null }) });

test("the result: its keys in order, and the check refuses a path, an address, a marker, a long key and a big result", () => {
  const r = resultOf({ meta: META, platform: { os: "darwin", arch: "arm64", node: "26.13.0", release: "27.0.0" }, ok: true, stage: "done", reason: null, ms: 1500, q1: {}, q2: {}, q3: { targets: TARGETS }, summary: {}, cleanup: {} });
  assert.deepEqual(Object.keys(r), [...RESULT_KEYS]);
  assert.equal(checkResult(r), null);
  assert.equal(checkResult({ ...r, extra: 1 }), "<keys>");
  assert.equal(checkResult({ ...r, ok: "yes" }), "ok");
  assert.equal(checkText({ a: "/srv/hm-someone/x" }), "q1.a");
  assert.equal(checkText({ a: "C:\\x" }), "q1.a");
  assert.equal(checkText({ a: "someone@example" }), "q1.a");
  assert.equal(checkText({ a: "00112233445566778899aabbccddeeff00112233445566778899aabbccddee42" }), "q1.a", "a marker's hex form");
  assert.equal(checkText({ a: "0123456789abcdef0123456789abcdef01234567" }), null, "a commit's 40 characters pass");
  assert.equal(checkText({ a: Infinity }), "q1.a");
  assert.equal(checkText({ "a-b": 1 }), "q1.<key>");
  assert.equal(checkText({ a: "x".repeat(301) }), "q1.a");
  assert.equal(checkText({ a: Array.from({ length: 2000 }, () => "a word ".repeat(12)) }), "<size>");
  for (const t of Object.values(TARGETS)) assert.equal(checkText({ t }), null, t);
  const s = scrub({ ...r, detail: "at /srv/hm-someone/x and someone" }, ["/srv/hm-someone", "someone"]);
  assert.equal(s.value.detail, "at <redacted>/x and <redacted>");
  assert.ok(TIME_LIMIT_MS >= 6 * TOOL_MS, "the run's time limit holds the reads of the targets");
});

// ------------------------------------------------------------------ the probe's Linux run

const probe = (args: string[], env: NodeJS.ProcessEnv) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
  execFile(process.execPath, [PROBE, ...args], { cwd: ROOT, env, timeout: 60_000 }, (e, stdout, stderr) => resolve({ code: e ? ((e as { code?: number }).code ?? 1) : 0, stdout, stderr }));
});

test("the probe on Linux: T0 and T1 start and end (T1 with prctl PR_SET_DUMPABLE 0), the tool runner's check, ok false: not the Mac; it leaves no target and no folder", { skip: process.platform !== "linux" }, async () => {
  const tmp = tempDir("ab-mpt-");
  try {
    const r = await probe([], { ...process.env, TMPDIR: tmp });
    assert.equal(r.code, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(j), [...RESULT_KEYS]);
    assert.equal(checkResult(j), null);
    assert.deepEqual([j.probe, j.version, j.ok, j.stage, j.platform.os], ["mac-memory-probe", 1, false, "done", "linux"]);
    assert.match(j.reason, /^not the Mac \(linux\): the dry run started and ended T0 and T1/);
    assert.match(j.commit, /^([0-9a-f]{40}|unknown)$/);
    assert.deepEqual([j.q1.devToolsSecurity, j.q1.sip, j.q1.reads, j.q2, j.summary], [null, null, null, null, null]);
    assert.equal(j.q1.node, process.versions.node);
    assert.deepEqual(Object.keys(j.q3.targets), ["T0", "T1", "T2"]);
    for (const k of ["T0", "T1"]) {
      const t = j.q3.targets[k];
      assert.deepEqual([t.started, t.start, t.markerBytes, t.reads, t.aliveAfterReads, t.stopped], [true, "ok", MARKER_BYTES, null, true, "ended"], k);
      assert.ok(Number.isInteger(t.pid) && t.pid > 1);
      assert.equal(existsSync(`/proc/${t.pid}`), false, `${k}'s pid ${t.pid} is gone`);
    }
    assert.equal(j.q3.targets.T0.deny, null);
    assert.deepEqual(j.q3.targets.T1.deny, { call: "prctl PR_SET_DUMPABLE 0", ret: 0, errno: 0, after: 0 }, "T1 is not dumpable after its call");
    assert.deepEqual([j.q3.targets.T2.started, j.q3.targets.T2.start], [false, "skipped: not the Mac"]);
    assert.deepEqual(j.q3.runnerCheck, { ok: "ok", okText: true, timeout: "timeout", timeoutGone: true, missing: "no tool", left: 0 });
    assert.deepEqual(j.cleanup, { targets: 2, helpers: 2, tools: 3, killedAtStop: 0, leftAtEnd: 0, folderRemoved: true }, "the runner check's three tools");
    assert.ok(!r.stdout.includes(tmp) && !r.stdout.includes(homedir()), "no path of the box in the output");
    assert.ok(!/[0-9a-f]{64}/.test(r.stdout) && !/[0-9a-f]{64}/.test(r.stderr), "no marker in the output");
    assert.deepEqual(readdirSync(tmp), [], "the probe's folder is gone");
    assert.ok(j.ms < 15_000, `${j.ms} ms`);
  } finally { rmSync(tmp, { recursive: true, force: true }); done(tmp); }
});

test("the probe takes no argument: exit 2, and the JSON says why", async () => {
  const r = await probe(["--x"], process.env);
  assert.equal(r.code, 2);
  const j = JSON.parse(r.stdout);
  assert.deepEqual([j.ok, j.stage, j.reason], [false, "args", "the probe takes no argument"]);
  assert.match(r.stderr, /usage: node test\/live\/mac-memory-probe\/probe\.ts/);
});
