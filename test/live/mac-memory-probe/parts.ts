// The pure parts of the Mac memory probe (probe.ts; board ab-v16.97.8, part 1; section 5.5 and section 13 row 11 of
// docs/superpowers/specs/2026-11-10-stored-sign-in-credentials-design.md): the parsers of the read-only tools' outputs
// (DevToolsSecurity, csrutil, id -Gn, codesign, launchctl print), the classes of the readers' answers (vmmap, leaks,
// lldb), the names of kern_return_t and errno, the byte search of a memory graph for the marker, the guards, the parse
// of /proc/<pid>/maps for the Linux twin of the search, and the result: its shape, its check (no path, no secret) and its
// summary with the control. No ffi, no process and no file access, so that test/mac-memory-probe.test.ts runs them on
// Linux in `npm test`.
//
// The formats of Apple's tools here come from Apple's man pages and their usual output as known on the Linux server, not
// from a measure: the run on the Mac checks them. Each parser gives "unknown" or null for a text that it does not know,
// and each class keeps the words that it found (`notes`), never the tool's text.

import { MAC_SERVICE_LABEL } from "../../../src/service/mac.ts";
import { clean, scrub, type Meta, type Platform } from "../mac-peer-probe/parts.ts";

export { clean, scrub, type Meta, type Platform };

/** The probe's version: a change of the result's fields or of the probe's reads gives a new one. */
export const PROBE_VERSION = 1;
/** The time limit of the whole run. */
export const TIME_LIMIT_MS = 180_000;
/** The time limit of each reader of a target (a, b, c and d); the tool or the port reader is killed at it. */
export const TOOL_MS = 20_000;
/** The time limit of each read of Q1 and Q2 (DevToolsSecurity, id, csrutil, xcode-select, codesign -d, launchctl print). */
export const QUICK_MS = 10_000;
/** The time limit of the ad hoc signature of T2's copy of Node (codesign --sign hashes each page of the copy). */
export const SIGN_MS = 60_000;
/** The longest wait for a target's ready message. */
export const START_MS = 15_000;
/** The longest wait for a target's end after the probe asks it to end; then SIGKILL. */
export const END_WAIT_MS = 2_000;
/** The time that the run keeps for its cleanup: a read that would end later than TIME_LIMIT_MS - RESERVE_MS is skipped. */
export const RESERVE_MS = 10_000;
/** A target ends itself after this long (shorter than TIME_LIMIT_MS), also when the probe cannot end it. */
export const HELPER_LIMIT_MS = 170_000;
/** The marker's length in bytes (crypto.randomBytes); its hex form has twice as many characters. */
export const MARKER_BYTES = 32;
/** The off-heap copy of the marker: a Buffer.alloc of this size (a malloc block, far above V8's on-heap size for typed arrays), the marker repeated. */
export const BIG_MARKER_BYTES = 64 * 1024;
/** The most text of a tool that the probe keeps for its class, of stdout and of stderr each (the first bytes). */
export const TEXT_MAX = 64 * 1024;
/** The notes come from the first bytes of stdout and of stderr only: the refusals of the tools come first, before a report. */
export const NOTE_SCAN = 8 * 1024;
/** The free disk that the T2 copy and each leaks run need in the temp folder; with less, the step is skipped. */
export const DISK_MIN_BYTES = 1_500_000_000;
/** While leaks runs: its memory graphs together may grow to this size; above it the probe kills leaks ("graph too large"). */
export const GRAPH_MAX_BYTES = 1_000_000_000;
/** While leaks runs: the free disk may fall to this size; below it the probe kills leaks ("disk nearly full"). */
export const DISK_FLOOR_BYTES = 500_000_000;
/** The watch of a leaks run: how often the probe reads the graphs' size and the free disk. */
export const WATCH_MS = 250;
/** The Linux twin reads at most this much of a target's writable memory. */
export const TWIN_MAX_BYTES = 2 * 1024 ** 3;
/** The memory graph is read in chunks of this size for the marker's byte search. */
export const CHUNK_BYTES = 4 << 20;
/** The result's largest size, as JSON. */
export const RESULT_MAX_BYTES = 128 * 1024;

/** sys/ptrace.h: PT_DENY_ATTACH. */
export const PT_DENY_ATTACH = 31;
/**
 * Read d on T1 does not run: xnu's ptrace(PT_ATTACH) of a process with PT_DENY_ATTACH sends SIGSEGV to the attacher, so
 * lldb's debugserver would crash and macOS would write a crash report outside the probe's folder.
 */
export const T1_D_SKIP = "skipped: PT_DENY_ATTACH (xnu sends SIGSEGV to the attacher)";
/** linux/prctl.h: the Linux twin of T1 (the service's non-dumpable start). */
export const PR_GET_DUMPABLE = 3, PR_SET_DUMPABLE = 4;
/** The service's launchd job (src/service/mac.ts). */
export const SERVICE_LABEL = MAC_SERVICE_LABEL;

/** The targets, in their order, and what each is (the result's `how`). */
export const TARGETS = {
  T0: "the probe's own Node, plain",
  T1: "the probe's own Node; it first calls ptrace PT_DENY_ATTACH (31) through node:ffi (on Linux prctl PR_SET_DUMPABLE 0)",
  T2: "a copy of the probe's Node in the probe's temp folder, signed ad hoc with the hardened runtime and the entitlements allow-jit, allow-unsigned-executable-memory and disable-library-validation, with no get-task-allow",
} as const;
export type TargetName = keyof typeof TARGETS;

/** The entitlements that the probe reads of each Node (Q2) and of T2's copy, by their short names in the result. */
export const ENTITLEMENTS = {
  getTaskAllow: "com.apple.security.get-task-allow",
  debugger: "com.apple.security.cs.debugger",
  allowJit: "com.apple.security.cs.allow-jit",
  allowUnsignedExecutableMemory: "com.apple.security.cs.allow-unsigned-executable-memory",
  disableLibraryValidation: "com.apple.security.cs.disable-library-validation",
} as const;
export type EntitlementName = keyof typeof ENTITLEMENTS;
export type Entitlements = Record<EntitlementName, boolean | null>;
/** T2's entitlements: what Node needs under the hardened runtime (V8's JIT, a Homebrew Node's own dylibs), and no get-task-allow. */
export const T2_ENTITLEMENTS: readonly EntitlementName[] = ["allowJit", "allowUnsignedExecutableMemory", "disableLibraryValidation"];

/** The plist of `codesign --entitlements` for T2's copy. */
export function entitlementsPlist(names: readonly EntitlementName[] = T2_ENTITLEMENTS): string {
  const body = names.map((n) => `\t<key>${ENTITLEMENTS[n]}</key>\n\t<true/>\n`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n${body}</dict>\n</plist>\n`;
}

// ------------------------------------------------------------------ a tool's run

/**
 * One run of a tool: its exit, the signal that ended it, its time limit, the probe's own stop of it (the watch of a leaks
 * run: "graph too large", "disk nearly full"), a spawn error's code, and the first TEXT_MAX characters of its stdout and
 * of its stderr, each kept apart (its pid stays in the probe).
 */
export type ToolRun = {
  exit: number | null; signal: string | null; timedOut: boolean; stopped?: string | null; spawnError: string | null;
  stdout: string; stderr: string; ms: number; pid?: number | null;
};

/** The whole text of a run for a parser (stdout, then stderr). */
export const textOf = (r: ToolRun): string => (r.stdout && r.stderr ? `${r.stdout}\n${r.stderr}` : r.stdout || r.stderr);

/** The class of a short read (Q1, Q2): ok (exit 0), exit (another exit code), timeout, killed, no tool, spawn failed. */
export function runClass(r: ToolRun): string {
  if (r.spawnError) return r.spawnError === "ENOENT" ? "no tool" : "spawn failed";
  if (r.timedOut) return "timeout";
  if (r.stopped) return r.stopped;
  if (r.signal) return "killed";
  return r.exit === 0 ? "ok" : "exit";
}

/** A short read as JSON: its class and exit code, never its text. */
export const runJson = (r: ToolRun) => ({ class: runClass(r), exit: r.exit, ms: r.ms });

// ------------------------------------------------------------------ Q1: the environment

export type Tri = "enabled" | "disabled" | "unknown";

/** `DevToolsSecurity -status`: "Developer mode is currently enabled." or "... disabled.". */
export function parseDevToolsSecurity(r: ToolRun): Tri {
  if (runClass(r) !== "ok") return "unknown";
  if (/\bcurrently enabled\b/i.test(textOf(r))) return "enabled";
  if (/\bcurrently disabled\b/i.test(textOf(r))) return "disabled";
  return "unknown";
}

/** `csrutil status`: "System Integrity Protection status: enabled." or "disabled."; a custom configuration says "unknown (Custom Configuration)". */
export function parseCsrutil(r: ToolRun): Tri {
  if (runClass(r) !== "ok") return "unknown";
  const m = /Protection status:\s*(enabled|disabled)\b/i.exec(textOf(r));
  return m ? (m[1].toLowerCase() as Tri) : "unknown";
}

/** `id -Gn`: the user's group names, split by white space; whether one is `_developer`. Null when the read failed. */
export function parseDeveloperGroup(r: ToolRun): boolean | null {
  if (runClass(r) !== "ok") return null;
  return r.stdout.trim().split(/\s+/).includes("_developer");
}

/** `xcode-select -p`: exit 0 when a developer folder is set (its path is never read). Null when the tool did not run. */
export function parseDeveloperTools(r: ToolRun): boolean | null {
  const c = runClass(r);
  return c === "ok" ? true : c === "exit" ? false : c === "no tool" ? false : null;
}

// ------------------------------------------------------------------ Q2: the code signatures

export type SignatureKind = "none" | "ad hoc" | "Developer ID" | "Apple" | "other" | "unknown";
/** The flag names of a CodeDirectory line that the result keeps (osfmk/kern/cs_blobs.h); another name gives "other". */
export const CS_FLAG_NAMES = ["none", "host", "adhoc", "forced", "hard", "kill", "expires", "restrict", "enforcement", "library-validation", "runtime", "linker-signed"] as const;
/** cs_blobs.h: CS_ADHOC and CS_RUNTIME. */
export const CS_ADHOC = 0x2, CS_RUNTIME = 0x10000;

/**
 * `codesign -d --verbose=4 <file>` (codesign writes it on stderr): the kind of the signature, the hardened runtime flag
 * and the flag names of the CodeDirectory line (`flags=0x10000(runtime)`). The kind: "code object is not signed at all"
 * gives none; `Signature=adhoc` or the adhoc flag ad hoc; the first `Authority=` line Developer ID ("Developer ID
 * Application: ...") or Apple ("Software Signing", Apple's own CAs) or other; a `Platform identifier=` line with no
 * authority Apple. No identifier and no team id is kept.
 */
export function parseCodesign(r: ToolRun): { kind: SignatureKind; runtime: boolean | null; flags: string[] } {
  const text = textOf(r);
  if (/code object is not signed at all/i.test(text)) return { kind: "none", runtime: false, flags: [] };
  if (runClass(r) !== "ok") return { kind: "unknown", runtime: null, flags: [] };
  const cd = /^CodeDirectory\b.*?\bflags=0x([0-9a-fA-F]{1,8})\(([^)]*)\)/m.exec(text);
  const bits = cd ? parseInt(cd[1], 16) : null;
  const flags = cd ? [...new Set(cd[2].split(",").map((s) => s.trim()).filter(Boolean).map((s) => ((CS_FLAG_NAMES as readonly string[]).includes(s) ? s : "other")))] : [];
  const runtime = bits === null ? null : (bits & CS_RUNTIME) !== 0;
  const authority = /^Authority=(.*)$/m.exec(text)?.[1].trim() ?? null;
  let kind: SignatureKind = "unknown";
  if (/^Signature=adhoc\s*$/m.test(text) || (bits !== null && (bits & CS_ADHOC) !== 0)) kind = "ad hoc";
  else if (authority !== null) {
    if (/^Developer ID Application\b/.test(authority)) kind = "Developer ID";
    else if (/^(Software Signing|Apple Code Signing Certification Authority|Apple Mac OS Application Signing|Apple iPhone OS Application Signing)$/.test(authority)) kind = "Apple";
    else kind = "other";
  } else if (/^Platform identifier=\d+/m.test(text)) kind = "Apple";
  return { kind, runtime, flags };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * `codesign -d --entitlements - --xml <file>`: the entitlements' XML plist on stdout (empty when the file has none). Each
 * entitlement of ENTITLEMENTS: true when its key holds `<true/>`, false when it holds another value or is not there;
 * every one null when the read failed or its text is not an XML plist (an empty text with exit 0 is no entitlement).
 */
export function parseEntitlements(r: ToolRun): Entitlements {
  const none = (v: boolean | null) => Object.fromEntries(Object.keys(ENTITLEMENTS).map((k) => [k, v])) as Entitlements;
  if (runClass(r) !== "ok") return none(null);
  const text = r.stdout;
  const at = text.indexOf("<?xml") >= 0 ? text.indexOf("<?xml") : text.indexOf("<plist");
  if (at < 0) return /<|bplist|\[Dict\]/.test(text) ? none(null) : none(false);
  const xml = text.slice(at);
  if (!/<plist\b[\s\S]*<\/plist>/.test(xml)) return none(null);
  return Object.fromEntries(Object.entries(ENTITLEMENTS).map(([k, key]) => {
    const m = new RegExp(`<key>\\s*${escapeRe(key)}\\s*</key>\\s*<(true|false)\\s*/>`).exec(xml);
    return [k, m ? m[1] === "true" : false];
  })) as Entitlements;
}

const allEnt = (v: boolean | null) => Object.fromEntries(Object.keys(ENTITLEMENTS).map((k) => [k, v])) as Entitlements;

/** A Node's signature as JSON (Q2, and T2's copy): the kind, the hardened runtime, the flag names, the entitlements, and each read's class. */
export function signatureJson(display: ToolRun, ents: ToolRun): SignatureJson {
  const sig = parseCodesign(display);
  const e = sig.kind === "none" ? allEnt(false) : parseEntitlements(ents);
  return { kind: sig.kind, runtime: sig.runtime, flags: sig.flags, entitlements: e, reads: { display: runJson(display), entitlements: runJson(ents) } };
}
export type SignatureJson = {
  kind: SignatureKind; runtime: boolean | null; flags: string[]; entitlements: Entitlements;
  reads: { display: { class: string; exit?: number | null; ms?: number; why?: string }; entitlements: { class: string; exit?: number | null; ms?: number; why?: string } };
};
/** A signature that the probe did not read, and why (each value null). */
export const skippedSignature = (why: string): SignatureJson =>
  ({ kind: "unknown", runtime: null, flags: [], entitlements: allEnt(null), reads: { display: skipped(why), entitlements: skipped(why) } });

/** The folders of the home folder where a read can make macOS ask for access (TCC): a file there is never read. */
export const ASKING_FOLDERS = ["Desktop", "Documents", "Downloads", "Library/Mobile Documents"] as const;
export const ASKING = "skipped: a folder that can ask for access";
/** True when `path` is in one of ASKING_FOLDERS of `home`. */
export function inAskingFolder(path: string, home: string): boolean {
  const h = home.replace(/\/+$/, "");
  return h.length > 0 && ASKING_FOLDERS.some((f) => path === `${h}/${f}` || path.startsWith(`${h}/${f}/`));
}

/**
 * `launchctl print gui/<uid>/<label>`: whether the job is loaded (launchctl's "Could not find service" or exit 113: not
 * loaded), its top-level `state`, and its program: the top-level `program = <path>` line, else the first line of its
 * `arguments = {` block. The program's path stays in the probe; the result gets only its form.
 */
export function parseLaunchctlJob(r: ToolRun, target: string): { loaded: boolean | null; state: string | null; program: string | null } {
  const c = runClass(r);
  if (c !== "ok") return { loaded: c === "exit" && (r.exit === 113 || /could not find service/i.test(textOf(r))) ? false : null, state: null, program: null };
  const text = r.stdout;
  const lines = text.split("\n");
  if (lines[0]?.trimEnd() !== `${target} = {`) return { loaded: null, state: null, program: null };
  const st = /^\tstate = (.+)$/m.exec(text)?.[1].trim() ?? null;
  const state = st === null ? null : /^[a-z][a-z ]{0,23}$/.test(st) ? st : "other";
  let program = /^\tprogram = (.+)$/m.exec(text)?.[1].trim() ?? null;
  if (!program) {
    const i = lines.findIndex((l) => /^\targuments = \{\s*$/.test(l));
    const first = i >= 0 ? /^\t\t(.+)$/.exec(lines[i + 1] ?? "") : null;
    program = first ? first[1].trim() : null;
  }
  return { loaded: true, state, program: program || null };
}

/** The form of the program's path: absolute, relative, or none. */
export const programForm = (p: string | null): "absolute" | "relative" | "none" => (p === null ? "none" : p.startsWith("/") ? "absolute" : "relative");

// ------------------------------------------------------------------ Q3 a: kern_return_t

/** osfmk/mach/kern_return.h, 0 to 56 (not measured: the names of the header). */
export const KERN_RETURN = [
  "KERN_SUCCESS", "KERN_INVALID_ADDRESS", "KERN_PROTECTION_FAILURE", "KERN_NO_SPACE", "KERN_INVALID_ARGUMENT", "KERN_FAILURE",
  "KERN_RESOURCE_SHORTAGE", "KERN_NOT_RECEIVER", "KERN_NO_ACCESS", "KERN_MEMORY_FAILURE", "KERN_MEMORY_ERROR", "KERN_ALREADY_IN_SET",
  "KERN_NOT_IN_SET", "KERN_NAME_EXISTS", "KERN_ABORTED", "KERN_INVALID_NAME", "KERN_INVALID_TASK", "KERN_INVALID_RIGHT",
  "KERN_INVALID_VALUE", "KERN_UREFS_OVERFLOW", "KERN_INVALID_CAPABILITY", "KERN_RIGHT_EXISTS", "KERN_INVALID_HOST",
  "KERN_MEMORY_PRESENT", "KERN_MEMORY_DATA_MOVED", "KERN_MEMORY_RESTART_COPY", "KERN_INVALID_PROCESSOR_SET", "KERN_POLICY_LIMIT",
  "KERN_INVALID_POLICY", "KERN_INVALID_OBJECT", "KERN_ALREADY_WAITING", "KERN_DEFAULT_SET", "KERN_EXCEPTION_PROTECTED",
  "KERN_INVALID_LEDGER", "KERN_INVALID_MEMORY_CONTROL", "KERN_INVALID_SECURITY", "KERN_NOT_DEPRESSED", "KERN_TERMINATED",
  "KERN_LOCK_SET_DESTROYED", "KERN_LOCK_UNSTABLE", "KERN_LOCK_OWNED", "KERN_LOCK_OWNED_SELF", "KERN_SEMAPHORE_DESTROYED",
  "KERN_RPC_SERVER_TERMINATED", "KERN_RPC_TERMINATE_ORPHAN", "KERN_RPC_CONTINUE_ORPHAN", "KERN_NOT_SUPPORTED", "KERN_NODE_DOWN",
  "KERN_NOT_WAITING", "KERN_OPERATION_TIMED_OUT", "KERN_CODESIGN_ERROR", "KERN_POLICY_STATIC", "KERN_INSUFFICIENT_BUFFER_SIZE",
  "KERN_DENIED", "KERN_MISSING_KC", "KERN_INVALID_KC", "KERN_NOT_FOUND",
] as const;
export const krName = (kr: number): string => (Number.isInteger(kr) && kr >= 0 && kr < KERN_RETURN.length ? KERN_RETURN[kr] : "unknown");

/** macOS's errno values (sys/errno.h; 1 to 34 are the same on Linux), for the names of a BSD call's errno. */
export const ERRNO: Readonly<Record<number, string>> = {
  1: "EPERM", 2: "ENOENT", 3: "ESRCH", 4: "EINTR", 5: "EIO", 6: "ENXIO", 7: "E2BIG", 8: "ENOEXEC", 9: "EBADF", 10: "ECHILD",
  11: "EDEADLK", 12: "ENOMEM", 13: "EACCES", 14: "EFAULT", 15: "ENOTBLK", 16: "EBUSY", 17: "EEXIST", 18: "EXDEV", 19: "ENODEV",
  20: "ENOTDIR", 21: "EISDIR", 22: "EINVAL", 23: "ENFILE", 24: "EMFILE", 25: "ENOTTY", 26: "ETXTBSY", 27: "EFBIG", 28: "ENOSPC",
  29: "ESPIPE", 30: "EROFS", 31: "EMLINK", 32: "EPIPE", 33: "EDOM", 34: "ERANGE", 35: "EAGAIN", 45: "ENOTSUP", 78: "ENOSYS",
};
export const errnoName = (e: number | null): string => (e === null ? "unknown" : ERRNO[e] ?? "unknown");

/**
 * One call of the port reader (helper.ts, port): its return, the errno when it returned -1 (task_read_for_pid is a BSD
 * system call: -1 and errno; task_for_pid is a Mach trap: a kern_return_t), whether the kernel gave a port (a port name
 * that is not 0), and whether mach_port_deallocate freed it. A symbol that does not load gives its dlopen error's code.
 */
export type PortCall = { ret: number; errno: number | null; port: boolean; deallocated: boolean | null } | { symbol: "missing"; code: string };
/** The port reader's answer: where its own task port came from, and each call; or why it failed. */
export type PortAnswer = { self: string; taskForPid: PortCall | null; taskReadForPid: PortCall | null } | { failed: string };

/** A call as JSON: its return and its name (the errno's name for -1, else the kern_return_t's name). */
const portCallJson = (c: PortCall | null) => {
  if (c === null) return null;
  if ("symbol" in c) return { symbol: "missing", code: clean(c.code) };
  return { ret: c.ret, name: c.ret === -1 ? errnoName(c.errno) : krName(c.ret), errno: c.ret === -1 ? c.errno : null, port: c.port, deallocated: c.deallocated };
};

/** Read a as JSON: the port reader's class (ok, timeout, exited, ...), and each call's return with its name. */
export function portJson(cls: string, ms: number, a: PortAnswer | null) {
  if (a === null) return { class: cls, ms, self: null, taskForPid: null, taskReadForPid: null };
  if ("failed" in a) return { class: "failed", ms, why: clean(a.failed), self: null, taskForPid: null, taskReadForPid: null };
  return { class: cls, ms, self: clean(a.self), taskForPid: portCallJson(a.taskForPid), taskReadForPid: portCallJson(a.taskReadForPid) };
}

// ------------------------------------------------------------------ Q3 b, c, d: the readers' classes

/**
 * The words that a reader's first NOTE_SCAN characters can hold, each with its pattern (vmmap's and leaks' "Process N is
 * not debuggable. Due to security restrictions, ... can only show or save contents of readonly memory of restricted
 * processes.", their "cannot examine process N ... try running with `sudo`", lldb's "error: attach failed: Not allowed
 * to attach to process." and "lost connection", and lldb's "Process N stopped" and "Process N detached" of an attach).
 * The order is the priority of a refusal's class.
 */
export const NOTES: readonly (readonly [string, RegExp])[] = [
  ["password", /password|authoriz|Developer Tools Access/i],
  ["not allowed", /not allowed to attach/i],
  ["not debuggable", /not debuggable/i],
  ["restricted", /restricted process/i],
  ["no task port", /task_for_pid|task_read_for_pid|task for pid|unable to (?:get|obtain|acquire) (?:the )?task/i],
  ["cannot examine", /cannot examine/i],
  ["permission", /permission denied|operation not permitted|not permitted/i],
  ["sudo", /\bsudo\b/],
  ["already traced", /already being debugged|already traced/i],
  ["lost connection", /lost connection/i],
  ["attach failed", /attach failed/i],
  ["no process", /no such process|process \d+ does not exist|doesn't exist/i],
  ["usage", /^usage:|unrecognized option|unknown option|invalid option|illegal option/im],
  ["exited", /\bProcess \d+ exited\b/],
  ["stopped", /\bProcess \d+ stopped\b/],
  ["detached", /\bProcess \d+ detached\b/],
];
/** The notes that say a reader was refused or failed (the others say what an attach did). */
const REFUSALS = new Set(NOTES.map(([w]) => w).filter((w) => !["stopped", "detached"].includes(w)));

/** The notes of a text's first NOTE_SCAN characters. */
export function notesIn(text: string): string[] {
  const head = text.slice(0, NOTE_SCAN);
  return NOTES.filter(([, re]) => re.test(head)).map(([w]) => w);
}

/** The notes of a run: those of the head of its stdout and of the head of its stderr, each read apart, in the order of NOTES. */
export function notesOf(r: Pick<ToolRun, "stdout" | "stderr">): string[] {
  const found = new Set([...notesIn(r.stdout), ...notesIn(r.stderr)]);
  return NOTES.map(([w]) => w).filter((w) => found.has(w));
}

export type Reader = "vmmap" | "leaks" | "lldb";
export type ReaderClass = { class: string; notes: string[] };

/** leaks ended by itself: exit 0 (no leaks) or 1 (leaks found), no time limit, no signal, no stop of the probe. Only then is its graph whole. */
export const leaksEnded = (r: ToolRun): boolean => !r.spawnError && !r.timedOut && !r.stopped && !r.signal && (r.exit === 0 || r.exit === 1);

/**
 * A reader's class, from its exit, its time limit, the probe's stop and its notes (never its text):
 * - no tool, spawn failed, timeout, and the probe's own stop (graph too large, disk nearly full): the run itself.
 * - vmmap: ok (exit 0, no refusal), limited (exit 0 with a refusal note, for example "not debuggable": vmmap showed only
 *   what a restricted process allows), else the first refusal note, else killed or failed.
 * - leaks: graph (it ended by itself and its memory graph file was written: leaks exits 1 when it finds leaks), graph
 *   limited (the same, with "not debuggable" or "restricted"), partial graph (a file, but leaks did not end by itself
 *   with 0 or 1: the file is not searched), else the first refusal note, else killed or no graph.
 * - lldb: attached ("Process N stopped" or "detached", and no "attach failed"), else the first refusal note, else failed.
 */
export function readerClass(tool: Reader, r: ToolRun, graphBytes: number | null = null): ReaderClass {
  if (r.spawnError) return { class: r.spawnError === "ENOENT" ? "no tool" : "spawn failed", notes: [] };
  const notes = notesOf(r);
  if (r.timedOut) return { class: "timeout", notes };
  if (r.stopped) return { class: r.stopped, notes };
  const refusal = notes.find((w) => REFUSALS.has(w)) ?? null;
  const limited = notes.includes("not debuggable") || notes.includes("restricted");
  if (tool === "vmmap") {
    if (r.exit === 0) return { class: refusal ? "limited" : "ok", notes };
    return { class: refusal ?? (r.signal ? "killed" : "failed"), notes };
  }
  if (tool === "leaks") {
    if (graphBytes !== null && graphBytes > 0) return { class: !leaksEnded(r) ? "partial graph" : limited ? "graph limited" : "graph", notes };
    return { class: refusal ?? (r.signal ? "killed" : "no graph"), notes };
  }
  const attached = (notes.includes("stopped") || notes.includes("detached")) && !notes.includes("attach failed");
  if (attached) return { class: "attached", notes };
  return { class: refusal ?? (r.signal ? "killed" : "failed"), notes };
}

/** A reader's run as JSON: its class and notes, its exit code, the signal that ended it, its time. */
export const readerJson = (tool: Reader, r: ToolRun, graphBytes: number | null = null) => ({ ...readerClass(tool, r, graphBytes), exit: r.exit, signal: r.signal, ms: r.ms });

/** A read that did not run, and why ("skipped: ..." gives the text after the prefix). */
export const skipped = (why: string) => ({ class: "skipped", why: why.replace(/^skipped: /, "") });
/** The class of each read of a target that ended before it. */
export const TARGET_ENDED = { class: "target ended" } as const;

// ------------------------------------------------------------------ Q3 c: the marker's byte search

/**
 * A byte search of a stream for each needle (the marker's raw bytes and its hex form), chunk by chunk: each chunk is
 * searched with the last bytes of the one before (one byte fewer than the longest needle), so that a needle across two
 * chunks is found. Buffer.indexOf only: no regex over the file, and no copy of the file in memory.
 */
export class ByteSearch {
  readonly found: boolean[];
  private tail: Buffer = Buffer.alloc(0);
  private readonly keep: number;
  private readonly needles: readonly Buffer[];
  bytes = 0;
  constructor(needles: readonly Buffer[]) {
    this.needles = needles;
    this.found = needles.map(() => false);
    this.keep = Math.max(1, ...needles.map((n) => n.length)) - 1;
  }
  push(chunk: Buffer): void {
    this.bytes += chunk.length;
    const b = this.tail.length ? Buffer.concat([this.tail, chunk]) : chunk;
    this.needles.forEach((n, i) => { if (!this.found[i] && n.length > 0 && b.indexOf(n) >= 0) this.found[i] = true; });
    this.tail = this.keep > 0 ? Buffer.from(b.subarray(Math.max(0, b.length - this.keep))) : Buffer.alloc(0);
  }
  get any(): boolean { return this.found.some(Boolean); }
}

/** The search of a stream that `read` fills chunk by chunk into one Buffer of `chunkBytes` (it gives the count of bytes, 0 at the end). */
export function searchChunks(read: (into: Buffer) => number, needles: readonly Buffer[], chunkBytes = CHUNK_BYTES): { found: boolean[]; bytes: number } {
  const s = new ByteSearch(needles), buf = Buffer.alloc(chunkBytes);
  for (let n; (n = read(buf)) > 0;) s.push(buf.subarray(0, n));
  return { found: s.found, bytes: s.bytes };
}

// ------------------------------------------------------------------ the guards

export type Guards = { a: string; b: string; c: string; d: string };

/**
 * The guards of the reads, so that no dialog asks for a password or offers an install:
 * - a (task_for_pid in the port reader, the probe's own Node): when that Node has com.apple.security.cs.debugger (or
 *   its entitlements are not known), taskgated can ask for a password; then only with DevToolsSecurity enabled. With no
 *   debugger entitlement the kernel refuses or gives the port with no dialog.
 * - b and c (vmmap, leaks): only with developer tools present, in case either is an xcrun shim on this macOS that
 *   offers to install the tools.
 * - d (lldb): only when DevToolsSecurity is enabled, developer tools are present, and the user is in the group
 *   _developer; else lldb's debugserver can ask for a password (the Developer Tools Access dialog), or /usr/bin/lldb
 *   can offer to install the tools. On T1 d never runs (T1_D_SKIP).
 */
export function guardsOf(q1: { devToolsSecurity: Tri; developerTools: boolean | null; developerGroup: boolean | null }, probeNodeDebugger: boolean | null): Guards {
  const dts = q1.devToolsSecurity === "enabled", tools = q1.developerTools === true;
  const a = probeNodeDebugger === false || dts ? "run" : "skipped: it could ask for a password (the probe's Node can have the debugger entitlement, and DevToolsSecurity is not enabled)";
  const bc = tools ? "run" : "skipped: no developer tools (vmmap or leaks can be an xcrun shim)";
  const d = !dts ? "skipped: it would ask for a password (DevToolsSecurity is not enabled)"
    : !tools ? "skipped: no developer tools"
    : q1.developerGroup !== true ? "skipped: it could ask for a password (the user is not in the group _developer)"
    : "run";
  return { a, b: bc, c: bc, d };
}

// ------------------------------------------------------------------ the summary

type Classed = { class?: string } | null | undefined;
type ReadsLike = {
  a?: { taskForPid?: unknown; taskReadForPid?: unknown } | null;
  b?: Classed;
  c?: { class?: string; markerFound?: boolean | null } | null;
  cFull?: { class?: string; markerFound?: boolean | null } | null;
  d?: Classed;
};
/** A call gave a port: a port name that is not 0 (M2); null when the call did not run or did not load. */
const portGiven = (c: unknown): boolean | null => (c && typeof c === "object" && "port" in c ? (c as { port: boolean }).port === true : null);
/** The classes of vmmap and leaks that are a refusal that protects (the target is restricted). */
const PROTECTS_VM = new Set(["limited", "graph limited", "not debuggable", "restricted"]);

/**
 * One target's verdict, reader by reader, and `readable`:
 * - true when a reader got the target's memory or its task port: read a got a port (taskPort, readPort), vmmap ran
 *   with no restriction (class ok: it got the task read port), leaks wrote a whole graph with no restriction (class
 *   graph), leaks' graph held the marker, or lldb attached. `by` names those readers.
 * - false only for a refusal that protects: vmmap or leaks "limited", "graph limited", "not debuggable" or
 *   "restricted", or lldb "not allowed" (`refusedBy`), and no reader got the memory.
 * - null else: each other class (a timeout, a kill, a signal, the probe's stop, a usage error, a missing tool, the class
 *   "password", lldb "failed" or "lost connection", no graph, a partial graph, a skipped read, an ended target) says
 *   nothing about the protection. A port refused to the port reader is not a protection either: the probe's Node has
 *   no debugger entitlement, so the kernel refuses it for any target.
 * leaksMarker: true when a graph held the marker; false when a restricted graph ended whole with no marker; for a graph
 * with no restriction and no marker, cFull's definite answer (true or false) or null: a failed or skipped cFull never
 * falls back to c's false.
 */
export function verdictOf(reads: ReadsLike | null) {
  if (!reads) return null;
  const taskPort = portGiven(reads.a?.taskForPid), readPort = portGiven(reads.a?.taskReadForPid);
  const b = reads.b?.class ?? null, c = reads.c?.class ?? null, d = reads.d?.class ?? null;
  const vmmap = b === "ok" ? true : b !== null && PROTECTS_VM.has(b) ? false : null;
  const leaks = c === "graph" ? true : c !== null && PROTECTS_VM.has(c) ? false : null;
  const cm = reads.c?.markerFound, fm = reads.cFull?.markerFound;
  const leaksMarker = cm === true || fm === true ? true
    : c === "graph limited" && cm === false ? false
    : c === "graph" && cm === false ? (typeof fm === "boolean" ? fm : null)
    : null;
  const lldbAttached = d === "attached" ? true : d === "not allowed" ? false : null;
  const by = [["readPort", readPort], ["taskPort", taskPort], ["vmmap", vmmap], ["leaks", leaks], ["leaksMarker", leaksMarker], ["lldb", lldbAttached]]
    .filter(([, v]) => v === true).map(([k]) => k as string);
  const refusedBy = [["vmmap", vmmap], ["leaks", leaks], ["lldb", lldbAttached]].filter(([, v]) => v === false).map(([k]) => k as string);
  const readable = by.length ? true : refusedBy.length ? false : null;
  return { taskPort, readPort, vmmap: b, leaksGraph: c, leaksMarker, lldbAttached, readable, by, refusedBy, controlled: false };
}
export type Verdict = NonNullable<ReturnType<typeof verdictOf>>;

/**
 * The summary of the targets, with the control: T0 (no protection) must be readable true. When it is not (it did not
 * start, or no reader got its memory), each false of T1 and T2 becomes null (`controlled` true), and `control` is
 * "failed" with the reason; else `control` is "ok".
 */
export function summaryOf(verdicts: Readonly<Record<string, Verdict | null>>) {
  const t0 = verdicts.T0 ?? null;
  const why = t0 === null ? "T0 was not read" : t0.readable !== true ? "no reader got the memory of T0, the target with no protection" : null;
  const out: Record<string, unknown> = { control: why ? "failed" : "ok", controlWhy: why };
  for (const [name, v] of Object.entries(verdicts)) {
    out[name] = v && why && name !== "T0" && v.readable === false ? { ...v, readable: null, controlled: true } : v;
  }
  return out;
}

// ------------------------------------------------------------------ the Linux twin

/** One line of /proc/<pid>/maps: its start and end, its permissions and its path (empty for anonymous memory). */
export type MapRegion = { start: number; end: number; perms: string; path: string };

/** The regions of /proc/<pid>/maps (a small text); a line that does not parse is left out. */
export function parseMaps(text: string): MapRegion[] {
  const out: MapRegion[] = [];
  for (const line of text.split("\n")) {
    const m = /^([0-9a-f]+)-([0-9a-f]+) ([r-][w-][x-][ps]) [0-9a-f]+ [0-9a-f]+:[0-9a-f]+ [0-9]+\s*(.*)$/.exec(line);
    if (!m) continue;
    const start = parseInt(m[1], 16), end = parseInt(m[2], 16);
    if (Number.isSafeInteger(end) && end > start) out.push({ start, end, perms: m[3], path: m[4].trim() });
  }
  return out;
}

/** The regions where a marker of the target's own memory lives: readable and writable, anonymous, [heap], [stack] or [anon:...]. */
export const twinRegions = (regions: readonly MapRegion[]): MapRegion[] =>
  regions.filter((r) => r.perms.startsWith("rw") && (r.path === "" || r.path === "[heap]" || r.path === "[stack]" || r.path.startsWith("[anon:")));

// ------------------------------------------------------------------ the result

/** The top-level keys of every result, in their order. */
export const RESULT_KEYS = ["probe", "version", "commit", "dirty", "ok", "stage", "reason", "detail", "ms", "platform", "q1", "q2", "q3", "summary", "cleanup", "redacted"] as const;

/** The result, with its keys in a fixed order. `ok` is true only when every part ran and nothing of the probe stayed. */
export function resultOf(o: {
  meta: Meta; platform: Platform | null; ok: boolean; stage: string; reason: string | null; detail?: string | null; ms: number;
  q1: unknown; q2: unknown; q3: unknown; summary: unknown; cleanup: unknown;
}) {
  return {
    probe: "mac-memory-probe", version: o.meta.version, commit: o.meta.commit, dirty: o.meta.dirty,
    ok: o.ok, stage: o.stage, reason: o.reason, detail: o.detail ?? null, ms: o.ms,
    platform: o.platform, q1: o.q1 ?? null, q2: o.q2 ?? null, q3: o.q3 ?? null, summary: o.summary ?? null, cleanup: o.cleanup ?? null,
    /** The count of strings that the scrub changed (the probe sets it). */
    redacted: 0,
  };
}

const obj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The result's check (the rules of the peer probe's check, with this result's keys): the top-level keys of resultOf;
 * every value a finite number, a flag, null, or a string of at most 300 printable ASCII characters with no `/`, `\` or
 * `@` (so no path, URL or address) and no run of 41 or more letters and digits (no long id, no key, no marker: its hex
 * form is 64 characters); every key a short word; at most RESULT_MAX_BYTES. Null when it passes, else the place of the
 * first value that fails.
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
