// The Mac memory probe (test/live/mac-memory-probe/; board ab-v16.97.8, part 1): its pure parts (parts.ts) with made-up
// outputs of Apple's tools (DevToolsSecurity, csrutil, id, xcode-select, codesign, launchctl print, vmmap, leaks, lldb),
// the kern_return_t and errno names, the marker's byte search, the guards, the folders that ask for access, the summary
// with its control, the parse of /proc/<pid>/maps and the result's shape and check; and on Linux two runs of the probe
// itself: its dry run (T0 and T1 start and end, the Linux twin of the marker search, the tool runner's check, the
// cleanup) and the Mac's flow with stand-in tools (the test seam AB_MEMORY_PROBE_STANDIN: the cFull path, a graph of
// another name, a graph too large, a refusal on stderr, the skip of d on T1, the summary and its control).
//
// The tools' outputs here are NOT measured: they are written from Apple's man pages and the tools' usual output as known
// on the Linux server. The Mac run checks them; its JSON keeps each class's notes and exit codes for that.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir, done } from "./temp-dirs.ts";
import {
  ASKING, BIG_MARKER_BYTES, ByteSearch, DISK_MIN_BYTES, ENTITLEMENTS, GRAPH_MAX_BYTES, KERN_RETURN, MARKER_BYTES, NOTE_SCAN, RESULT_KEYS,
  T1_D_SKIP, T2_ENTITLEMENTS, TARGETS, TIME_LIMIT_MS, TOOL_MS,
  checkResult, entitlementsPlist, errnoName, guardsOf, inAskingFolder, krName, leaksEnded, notesIn, notesOf, parseCodesign, parseCsrutil,
  parseDeveloperGroup, parseDeveloperTools, parseDevToolsSecurity, parseEntitlements, parseLaunchctlJob, parseMaps, portJson, programForm,
  readerClass, readerJson, resultOf, runClass, scrub, searchChunks, signatureJson, skipped, skippedSignature, summaryOf, twinRegions,
  verdictOf, type Meta, type ToolRun,
} from "./live/mac-memory-probe/parts.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PROBE = fileURLToPath(new URL("./live/mac-memory-probe/probe.ts", import.meta.url));
const META: Meta = { version: 1, commit: "0123456789abcdef0123456789abcdef01234567", dirty: false };

/** A made-up run of a tool: `text` on its stdout (more.stderr for its stderr). */
const run = (text: string, exit: number | null = 0, more: Partial<ToolRun> = {}): ToolRun => ({ exit, signal: null, timedOut: false, stopped: null, spawnError: null, stdout: text, stderr: "", ms: 12, ...more });
/** A made-up run with `text` on its stderr only. */
const runErr = (text: string, exit: number | null = 0, more: Partial<ToolRun> = {}): ToolRun => run("", exit, { stderr: text, ...more });
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
  assert.deepEqual(parseCodesign(runErr(CD_HOMEBREW)), { kind: "ad hoc", runtime: false, flags: ["adhoc", "linker-signed"] }, "codesign -d writes on stderr");
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
  // The entitlements come from stdout only: the "Executable=" line of stderr is no plist.
  assert.deepEqual(Object.values(parseEntitlements(run(ENT_XML([[ENTITLEMENTS.allowJit, "<true/>"]]).replace(/^Executable=.*\n/, ""), 0, { stderr: "Executable=/x/node\n" }))), [false, false, true, false, false]);
  assert.deepEqual(skippedSignature(ASKING), {
    kind: "unknown", runtime: null, flags: [], entitlements: { getTaskAllow: null, debugger: null, allowJit: null, allowUnsignedExecutableMemory: null, disableLibraryValidation: null },
    reads: { display: { class: "skipped", why: "a folder that can ask for access" }, entitlements: { class: "skipped", why: "a folder that can ask for access" } },
  });
});

test("the folders that can make macOS ask for access (TCC): Desktop, Documents, Downloads, iCloud Drive; never read", () => {
  const h = "/srv/hm-someone";
  for (const p of ["/Desktop/node", "/Documents/x/bin/node", "/Downloads/node-v26/bin/node", "/Library/Mobile Documents/x/node", "/Desktop"]) assert.equal(inAskingFolder(h + p, h), true, p);
  for (const p of ["/opt/homebrew/bin/node", `${h}/.nvm/versions/node/v26.1.0/bin/node`, `${h}/DesktopX/node`, `${h}/Library/Application Support/node`]) assert.equal(inAskingFolder(p, h), false, p);
  assert.equal(inAskingFolder(`${h}/Downloads/node`, `${h}/`), true, "a home with a trailing slash");
  assert.equal(inAskingFolder("/Downloads/node", ""), false, "no home: no rule");
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
  assert.deepEqual([errnoName(1), errnoName(3), errnoName(13), errnoName(45), errnoName(999), errnoName(null)], ["EPERM", "ESRCH", "EACCES", "ENOTSUP", "unknown", "unknown"]);
  // task_for_pid: a Mach trap, a kern_return_t; task_read_for_pid: a BSD system call, -1 and errno (M1).
  assert.deepEqual(portJson("ok", 30, { self: "mach_task_self_", taskForPid: { ret: 5, errno: null, port: false, deallocated: null }, taskReadForPid: { ret: -1, errno: 1, port: false, deallocated: null } }), {
    class: "ok", ms: 30, self: "mach_task_self_",
    taskForPid: { ret: 5, name: "KERN_FAILURE", errno: null, port: false, deallocated: null },
    taskReadForPid: { ret: -1, name: "EPERM", errno: 1, port: false, deallocated: null },
  });
  assert.deepEqual(portJson("ok", 1, { self: "x", taskForPid: { ret: 0, errno: null, port: true, deallocated: true }, taskReadForPid: null }).taskForPid, { ret: 0, name: "KERN_SUCCESS", errno: null, port: true, deallocated: true });
  assert.deepEqual(portJson("ok", 1, { self: "task_self_trap", taskForPid: { ret: 0, errno: null, port: true, deallocated: true }, taskReadForPid: { symbol: "missing", code: "ERR_FFI_CALL_FAILED" } }).taskReadForPid, { symbol: "missing", code: "ERR_FFI_CALL_FAILED" }, "the dlopen error's code (M3)");
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
  // The re-check's N1: exit 0 with a refusal note that does not protect is that note's class, never "limited".
  assert.deepEqual(readerClass("vmmap", run(VMMAP_OK, 0, { stderr: "vmmap: Operation not permitted\n" })), { class: "permission", notes: ["permission"] });
  assert.deepEqual(readerClass("vmmap", run(CANNOT("vmmap"), 0)), { class: "cannot examine", notes: ["cannot examine", "sudo"] });
  assert.deepEqual(readerClass("vmmap", run("", 0)), { class: "no output", notes: [] }, "exit 0 with no output is no read");
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
  // The re-check's N2: a whole graph with a refusal note that does not protect is neither readable nor refused.
  assert.deepEqual(readerClass("leaks", run(CANNOT("leaks"), 1), 4_000_000), { class: "graph with a refusal note", notes: ["cannot examine", "sudo"] });
  assert.deepEqual(readerClass("leaks", run(leaksReport, 1), 0), { class: "no graph", notes: [] }, "an empty file is no graph");
  assert.deepEqual(readerClass("leaks", run("leaks: unrecognized option '--fullContent'\nUsage: leaks [options] pid\n", 64), null), { class: "usage", notes: ["usage"] });
  // A graph of a leaks run that did not end by itself with 0 or 1 is partial: it is never searched as a whole one.
  assert.deepEqual(readerClass("leaks", run(leaksReport, null, { signal: "SIGKILL" }), 5_000_000), { class: "partial graph", notes: [] });
  assert.deepEqual(readerClass("leaks", run(leaksReport, 2), 5_000_000), { class: "partial graph", notes: [] });
  assert.deepEqual(readerClass("leaks", run("", null, { signal: "SIGKILL", stopped: "graph too large" }), GRAPH_MAX_BYTES + 1), { class: "graph too large", notes: [] });
  assert.deepEqual(readerClass("leaks", run("", null, { signal: "SIGKILL", timedOut: true }), 5_000_000), { class: "timeout", notes: [] });
  assert.deepEqual([leaksEnded(run("", 0)), leaksEnded(run("", 1)), leaksEnded(run("", 2)), leaksEnded(run("", null, { signal: "SIGKILL" })), leaksEnded(run("", 1, { stopped: "disk nearly full" })), leaksEnded(TIMEOUT)], [true, true, false, false, false, false]);

  assert.deepEqual(readerClass("lldb", run(LLDB_OK)), { class: "attached", notes: ["stopped", "detached"] });
  assert.deepEqual(readerClass("lldb", run(LLDB_NOT_ALLOWED, 1)), { class: "not allowed", notes: ["not allowed", "attach failed"] });
  assert.deepEqual(readerClass("lldb", run("(lldb) process attach --pid 4242\nerror: attach failed: lost connection\n", 1)), { class: "lost connection", notes: ["lost connection", "attach failed"] });
  assert.deepEqual(readerClass("lldb", run("error: attach failed: Developer Tools Access needs to take control of another process; a password\n", 1)).class, "password");
  assert.deepEqual(readerClass("lldb", run("Process 4242 stopped\nerror: attach failed: unable to attach\n", 1)).class, "attach failed", "an attach that failed is no attach");
  assert.deepEqual(readerClass("lldb", run("(lldb) process attach --pid 4242\n", null, { timedOut: true, signal: "SIGKILL" })), { class: "timeout", notes: [] });
  assert.deepEqual(readerClass("lldb", run("", 1)), { class: "failed", notes: [] });
});

test("the notes come from the first NOTE_SCAN characters of stdout and of stderr, each read apart (a leaks report holds the target's own strings later)", () => {
  assert.deepEqual(notesIn(`${"x".repeat(NOTE_SCAN)}permission denied`), []);
  assert.deepEqual(notesIn(`${"x".repeat(NOTE_SCAN - 20)}permission denied`), ["permission"]);
  assert.deepEqual(notesIn("ROOT CYCLE: <node> and leaks for root"), [], "no word of a leaks report counts");
  // M5: a long report on stdout never hides a refusal on stderr.
  const r = run("y".repeat(3 * NOTE_SCAN), 0, { stderr: NOT_DEBUGGABLE("vmmap") });
  assert.deepEqual(notesOf(r), ["not debuggable", "restricted"]);
  assert.deepEqual(readerClass("vmmap", r).class, "limited");
  assert.deepEqual(notesOf(run(LLDB_OK, 1, { stderr: "error: attach failed: lost connection\n" })), ["lost connection", "attach failed", "stopped", "detached"], "in the order of NOTES");
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

test("the guards: a without the debugger entitlement or with DevToolsSecurity; b and c with developer tools; d with DevToolsSecurity, developer tools and the group _developer", () => {
  const on = { devToolsSecurity: "enabled" as const, developerTools: true, developerGroup: true };
  assert.deepEqual(guardsOf(on, true), { a: "run", b: "run", c: "run", d: "run" });
  assert.deepEqual(guardsOf({ ...on, developerTools: false }, true), {
    a: "run", b: "skipped: no developer tools (vmmap or leaks can be an xcrun shim)", c: "skipped: no developer tools (vmmap or leaks can be an xcrun shim)", d: "skipped: no developer tools",
  });
  assert.equal(guardsOf({ ...on, developerGroup: false }, true).d, "skipped: it could ask for a password (the user is not in the group _developer)");
  assert.equal(guardsOf({ ...on, developerGroup: null }, true).d, "skipped: it could ask for a password (the user is not in the group _developer)");
  const off = guardsOf({ ...on, devToolsSecurity: "disabled" }, false);
  assert.deepEqual([off.a, off.d], ["run", "skipped: it would ask for a password (DevToolsSecurity is not enabled)"]);
  assert.match(guardsOf({ ...on, devToolsSecurity: "disabled" }, true).a, /^skipped: it could ask for a password/);
  assert.match(guardsOf({ ...on, devToolsSecurity: "unknown" }, null).a, /^skipped: /, "entitlements not known");
  assert.match(guardsOf({ devToolsSecurity: "unknown", developerTools: null, developerGroup: null }, false).d, /^skipped: it would ask for a password/);
  assert.equal(guardsOf({ ...on, developerTools: null }, false).b, "skipped: no developer tools (vmmap or leaks can be an xcrun shim)", "not known is not present");
  // C2: d never runs on T1.
  assert.equal(T1_D_SKIP, "skipped: PT_DENY_ATTACH (xnu sends SIGSEGV to the attacher)");
  assert.deepEqual(skipped(T1_D_SKIP), { class: "skipped", why: "PT_DENY_ATTACH (xnu sends SIGSEGV to the attacher)" });
});

/** read a's calls as the probe's JSON gives them. */
const call = (ret: number, port = ret === 0, errno: number | null = null) => ({ ret, name: "x", errno, port, deallocated: port ? true : null });

test("C1: a target is readable when any reader got its memory or its task port, by each reader", () => {
  assert.equal(verdictOf(null), null);
  // The review's scenario: T1 with task_for_pid 5, task_read_for_pid -1, vmmap ok, a whole graph with no restriction and
  // no marker, cFull skipped, lldb lost connection: readable true by vmmap and leaks (they got the task read port).
  const t1 = verdictOf({ a: { taskForPid: call(5), taskReadForPid: call(-1, false, 1) }, b: { class: "ok" }, c: { class: "graph", markerFound: false }, cFull: { class: "skipped" }, d: { class: "lost connection" } })!;
  assert.deepEqual(t1, { taskPort: false, readPort: false, vmmap: "ok", leaksGraph: "graph", leaksMarker: null, lldbAttached: null, readable: true, by: ["vmmap", "leaks"], refusedBy: [], controlled: false });
  // Each reader alone gives true.
  assert.deepEqual(verdictOf({ a: { taskForPid: call(0), taskReadForPid: call(0) } })!.by, ["readPort", "taskPort"]);
  assert.deepEqual(verdictOf({ c: { class: "graph limited", markerFound: true } })!.by, ["leaksMarker"], "the marker in a restricted graph still counts");
  assert.deepEqual(verdictOf({ d: { class: "attached" } })!.by, ["lldb"]);
  assert.deepEqual(verdictOf({ c: { class: "graph", markerFound: false }, cFull: { class: "graph", markerFound: true } })!.by, ["leaks", "leaksMarker"]);
  // M2: kr 0 with no port name is no port.
  assert.deepEqual([verdictOf({ a: { taskForPid: call(0, false), taskReadForPid: null } })!.taskPort, verdictOf({ a: { taskForPid: call(0, false), taskReadForPid: null } })!.readable], [false, null]);
});

test("C1: false only for a refusal that protects; every other class is null (M8: password)", () => {
  const prot = verdictOf({ a: { taskForPid: call(5), taskReadForPid: call(-1, false, 1) }, b: { class: "limited" }, c: { class: "graph limited", markerFound: false }, cFull: { class: "graph limited", markerFound: false }, d: { class: "not allowed" } })!;
  assert.deepEqual([prot.readable, prot.refusedBy, prot.leaksMarker, prot.lldbAttached], [false, ["vmmap", "leaks", "lldb"], false, false]);
  for (const cls of ["not debuggable", "restricted", "limited"]) assert.equal(verdictOf({ b: { class: cls } })!.readable, false, `vmmap ${cls}`);
  for (const cls of ["not debuggable", "restricted", "graph limited"]) assert.equal(verdictOf({ c: { class: cls, markerFound: null } })!.readable, false, `leaks ${cls}`);
  assert.equal(verdictOf({ d: { class: "not allowed" } })!.readable, false);
  const NULLS = ["timeout", "killed", "graph too large", "disk nearly full", "usage", "no tool", "spawn failed", "password", "failed", "lost connection", "attach failed",
    "no graph", "partial graph", "cannot examine", "no task port", "permission", "skipped", "target ended", "no output", "graph with a refusal note"];
  for (const cls of NULLS) {
    assert.equal(verdictOf({ b: { class: cls } })!.readable, null, `vmmap ${cls}`);
    assert.equal(verdictOf({ c: { class: cls, markerFound: null } })!.readable, null, `leaks ${cls}`);
    assert.equal(verdictOf({ d: { class: cls } })!.readable, null, `lldb ${cls}`);
  }
  assert.equal(verdictOf({ a: { taskForPid: call(5), taskReadForPid: call(-1, false, 1) } })!.readable, null, "a refused port is no protection: the probe's Node has no debugger entitlement");
  // The re-check's N1 scenario: T1, vmmap exit 0 with "Operation not permitted", no port, leaks timed out, d skipped: not known, never false.
  const n1 = verdictOf({ a: { taskForPid: call(5), taskReadForPid: call(-1, false, 1) }, b: readerClass("vmmap", run(VMMAP_OK, 0, { stderr: "vmmap: Operation not permitted\n" })), c: { class: "timeout", markerFound: null }, cFull: null, d: { class: "skipped" } })!;
  assert.deepEqual([n1.readable, n1.refusedBy, n1.by], [null, [], []]);
  // N2: a whole graph with a refusal note that does not protect: its marker still counts, its "no marker" never does.
  assert.equal(verdictOf({ c: { class: "graph with a refusal note", markerFound: true } })!.readable, true);
  assert.equal(verdictOf({ c: { class: "graph with a refusal note", markerFound: false }, cFull: { class: "graph with a refusal note", markerFound: false } })!.leaksMarker, null);
  // leaksMarker: a graph with no restriction and no marker needs cFull's definite answer.
  assert.equal(verdictOf({ c: { class: "graph", markerFound: false } })!.leaksMarker, null);
  assert.equal(verdictOf({ c: { class: "graph", markerFound: false }, cFull: { class: "usage", markerFound: null } })!.leaksMarker, null, "a failed cFull never falls back to c's false");
  assert.equal(verdictOf({ c: { class: "graph", markerFound: false }, cFull: { class: "graph", markerFound: false } })!.leaksMarker, false);
  assert.equal(verdictOf({ c: { class: "partial graph", markerFound: null } })!.leaksMarker, null);
});

test("C1: the control: when T0 is not readable, each false of T1 and T2 becomes null", () => {
  const t0 = verdictOf({ b: { class: "ok" } })!, refused = verdictOf({ b: { class: "limited" }, d: { class: "not allowed" } })!;
  const ok = summaryOf({ T0: t0, T1: refused, T2: refused }) as any;
  assert.deepEqual([ok.control, ok.controlWhy, ok.T1.readable, ok.T2.readable, ok.T1.controlled], ["ok", null, false, false, false]);
  const lost = summaryOf({ T0: verdictOf({ b: { class: "timeout" } }), T1: refused, T2: verdictOf({ d: { class: "attached" } }) }) as any;
  assert.deepEqual([lost.control, lost.T1.readable, lost.T1.controlled, lost.T1.refusedBy, lost.T2.readable, lost.T2.controlled], ["failed", null, true, ["vmmap", "lldb"], true, false]);
  assert.match(lost.controlWhy, /^no reader got the memory of T0/);
  const none = summaryOf({ T1: refused }) as any;
  assert.deepEqual([none.control, none.controlWhy, none.T1.readable], ["failed", "T0 was not read", null]);
  assert.equal(checkText(lost), null);
});

test("the Linux twin: the parse of /proc/<pid>/maps and the regions where a target's own data lives", () => {
  const maps = [
    "55d4a0000000-55d4a2000000 r--p 00000000 08:01 1234 /usr/bin/node",
    "55d4a8000000-55d4a8100000 rw-p 02000000 08:01 1234 /usr/bin/node",
    "55d4aa000000-55d4ab000000 rw-p 00000000 00:00 0                          [heap]",
    "7f0000000000-7f0000100000 rw-p 00000000 00:00 0 ",
    "7f0000100000-7f0000200000 ---p 00000000 00:00 0 ",
    "7f0000200000-7f0000300000 rw-s 00000000 00:05 77 /dev/zero (deleted)",
    "7f0000300000-7f0000400000 rw-p 00000000 00:00 0 [anon:v8]",
    "7ffd00000000-7ffd00021000 rw-p 00000000 00:00 0                          [stack]",
    "ffffffffff600000-ffffffffff601000 --xp 00000000 00:00 0                  [vsyscall]",
    "not a line",
  ].join("\n");
  const r = parseMaps(maps);
  assert.equal(r.length, 8, "not a line, and [vsyscall] (above 2^53: no safe number) are left out");
  assert.deepEqual(r[2], { start: 0x55d4aa000000, end: 0x55d4ab000000, perms: "rw-p", path: "[heap]" });
  assert.deepEqual(twinRegions(r).map((x) => x.path), ["[heap]", "", "[anon:v8]", "[stack]"]);
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
    assert.match(j.reason, /^not the Mac \(linux\): the dry run started and ended T0 and T1 .*the Linux twin of the marker search/);
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
    // I4: the Linux twin of the marker search. The marker is in the live Node target, and the search finds it; T1 (not dumpable) refuses.
    const twin = j.q3.linuxTwin;
    if (twin.ptraceScope === null || twin.ptraceScope <= 1) {
      assert.deepEqual([twin.T0.read, twin.T0.markerFound, twin.T0.forms], ["ok", true, { raw: true, hex: true }], JSON.stringify(twin.T0));
      assert.ok(twin.T0.readMB > 0 && twin.T0.regionsFailed === 0);
    }
    assert.deepEqual(twin.T1, { read: "refused", code: "EACCES" });
    assert.deepEqual(j.cleanup, { targets: 2, helpers: 2, tools: 3, killedAtStop: 0, leftAtEnd: 0, folderRemoved: true }, "the runner check's three tools");
    assert.ok(!r.stdout.includes(tmp) && !r.stdout.includes(homedir()), "no path of the box in the output");
    assert.ok(!/[0-9a-f]{64}/.test(r.stdout) && !/[0-9a-f]{64}/.test(r.stderr), "no marker in the output");
    assert.deepEqual(readdirSync(tmp), [], "the probe's folder is gone");
    assert.ok(j.ms < 15_000, `${j.ms} ms`);
  } finally { rmSync(tmp, { recursive: true, force: true }); done(tmp); }
});

/** The stand-in tools of the Mac's flow (sh scripts); each leaks call does the next step of LEAKS_STEPS, by a count in the state folder. */
function standins(bin: string): void {
  const tool = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, name), 0o700); };
  tool("DevToolsSecurity", `echo "Developer mode is currently enabled."`);
  tool("id", `echo "staff everyone _developer"`);
  tool("csrutil", `echo "System Integrity Protection status: enabled."`);
  tool("xcode-select", `echo /Library/Developer/CommandLineTools`);
  tool("launchctl", `echo "Could not find service \\"com.agentwatch.agent-browser\\" in domain for user gui: 501" >&2; exit 113`);
  tool("codesign", [
    `case "$*" in`,
    `  *--sign*) exit 0 ;;`,
    `  *--entitlements*) printf '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>' ;;`,
    `  *) printf 'Identifier=node\\nCodeDirectory v=20400 size=1 flags=0x20002(adhoc,linker-signed) hashes=1+0 location=embedded\\nSignature=adhoc\\n' >&2 ;;`,
    `esac`,
  ].join("\n"));
  // vmmap: a long report on stdout, the refusal on stderr (M5).
  tool("vmmap", `head -c 20000 /dev/zero | tr '\\0' 'y'; echo "Process 1 is not debuggable. Due to security restrictions, vmmap can only show or save contents of readonly memory of restricted processes." >&2`);
  tool("lldb", `echo "$4" >> "$STANDIN_STATE/lldb.pids"; echo "Process $4 stopped"; echo "Process $4 detached"`);
  tool("leaks", [
    `f="\${1#--outputGraph=}"`,
    `n=$(cat "$STANDIN_STATE/leaks.count" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$STANDIN_STATE/leaks.count"`,
    `case $n in`,
    // T0 c: a whole graph with no marker, and a second graph of another name (M11); exit 1 (leaks found).
    `  1) head -c 2000000 /dev/zero > "$f"; head -c 1000 /dev/zero > "$(dirname "$f")/other.memgraph"; exit 1 ;;`,
    // T0 cFull: a whole graph with no marker: a definite false.
    `  2) head -c 3000000 /dev/zero > "$f"; exit 0 ;;`,
    // T1 c: a sparse graph above GRAPH_MAX_BYTES, then a wait: the watch kills the group (the sh and its sleep).
    `  3) echo $$ > "$STANDIN_STATE/leaks.pid"; truncate -s 1100M "$f"; sleep 30 & echo $! > "$STANDIN_STATE/sleep.pid"; wait; exit 0 ;;`,
    // T2 c: a refusal on stderr and no graph.
    `  *) echo "leaks cannot examine process 1 (node) for unknown reasons, even though it appears to exist; try running with \`sudo\`." >&2; exit 1 ;;`,
    `esac`,
  ].join("\n"));
}

test("the Mac's flow with stand-in tools (the test seam, Linux only): cFull, a graph of another name, a graph too large, a refusal on stderr, no d on T1, the summary and its control; nothing stays", { skip: process.platform !== "linux" }, async () => {
  const tmp = tempDir("ab-mps-"), bin = tempDir("ab-mps-bin-"), state = tempDir("ab-mps-state-");
  try {
    standins(bin);
    const r = await probe([], { ...process.env, TMPDIR: tmp, AB_MEMORY_PROBE_STANDIN: bin, STANDIN_STATE: state });
    assert.equal(r.code, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(checkResult(j), null);
    assert.deepEqual([j.ok, j.stage, j.q3.standin], [false, "done", true]);
    assert.match(j.reason, /^stand-in tools on Linux \(the test seam\)/);
    assert.deepEqual([j.q1.devToolsSecurity, j.q1.developerGroup, j.q1.sip, j.q1.developerTools], ["enabled", true, "enabled", true]);
    assert.deepEqual([j.q2.probeNode.kind, j.q2.probeNode.entitlements.debugger, j.q2.service.job], ["ad hoc", false, "not loaded"]);
    assert.deepEqual(j.q3.guards, { a: "run", b: "run", c: "run", d: "run" });
    const [t0, t1, t2] = ["T0", "T1", "T2"].map((k) => j.q3.targets[k]);
    // T0: c is a whole graph with no marker (and the graph of another name goes too), so cFull runs and gives a definite false.
    assert.deepEqual([t0.reads.b.class, t0.reads.b.notes], ["limited", ["not debuggable", "restricted"]], "the refusal on stderr (M5)");
    assert.deepEqual([t0.reads.c.class, t0.reads.c.markerFound, t0.reads.c.otherGraphs, t0.reads.c.graphRemoved], ["graph", false, 1, true]);
    assert.deepEqual([t0.reads.cFull.class, t0.reads.cFull.markerFound, t0.reads.cFull.graphRemoved], ["graph", false, true]);
    assert.equal(t0.reads.d.class, "attached");
    assert.equal(t0.reads.a.class, "failed", "the port reader is the Mac's only");
    // T1: the watch kills leaks above GRAPH_MAX_BYTES; the partial graph is not searched and goes; no cFull; no d (C2).
    assert.deepEqual([t1.reads.c.class, t1.reads.c.markerFound, t1.reads.c.graphRemoved, t1.reads.cFull], ["graph too large", null, true, null]);
    assert.deepEqual(t1.reads.d, { class: "skipped", why: T1_D_SKIP.replace(/^skipped: /, "") });
    for (const f of ["leaks.pid", "sleep.pid"]) assert.equal(existsSync(`/proc/${readFileSync(join(state, f), "latin1").trim()}`), false, `the ${f} process is gone`);
    const lldbPids = readFileSync(join(state, "lldb.pids"), "latin1").trim().split("\n").map(Number);
    assert.ok(!lldbPids.includes(t1.pid), "lldb never ran on T1");
    // T2: the copy, its ad hoc sign and its start; leaks refused on stderr.
    assert.deepEqual([t2.prepare.copy, t2.prepare.sign.class, t2.start], ["ok", "ok", "ok"]);
    assert.ok(t2.prepare.freeGB >= DISK_MIN_BYTES / 1e9);
    assert.deepEqual([t2.reads.c.class, t2.reads.c.markerFound, t2.reads.d.class], ["cannot examine", null, "attached"]);
    // The summary: T0 the control, by leaks and lldb; T1 refused by vmmap ("limited"), with the control passed.
    assert.deepEqual([j.summary.control, j.summary.controlWhy], ["ok", null]);
    assert.deepEqual([j.summary.T0.readable, j.summary.T0.by, j.summary.T0.leaksMarker], [true, ["leaks", "lldb"], false]);
    assert.deepEqual([j.summary.T1.readable, j.summary.T1.refusedBy, j.summary.T1.leaksMarker], [false, ["vmmap"], null]);
    assert.deepEqual([j.summary.T2.readable, j.summary.T2.by], [true, ["lldb"]]);
    assert.deepEqual([j.cleanup.leftAtEnd, j.cleanup.folderRemoved, j.cleanup.targets], [0, true, 3]);
    assert.deepEqual(readdirSync(tmp), [], "the probe's folder (the copy of Node, the graphs) is gone");
    assert.ok(!r.stdout.includes(tmp) && !r.stdout.includes(bin) && !r.stdout.includes(state) && !r.stdout.includes(homedir()), "no path in the output");
    assert.ok(BIG_MARKER_BYTES === 65536);
  } finally {
    for (const d of [tmp, bin, state]) { rmSync(d, { recursive: true, force: true }); done(d); }
  }
});

test("the probe takes no argument: exit 2, and the JSON says why", async () => {
  const r = await probe(["--x"], process.env);
  assert.equal(r.code, 2);
  const j = JSON.parse(r.stdout);
  assert.deepEqual([j.ok, j.stage, j.reason], [false, "args", "the probe takes no argument"]);
  assert.match(r.stderr, /usage: node test\/live\/mac-memory-probe\/probe\.ts/);
});
