// The parsers of the Mac's read-only tools that the Mac's protected start reads (protect.ts; board ab-v16.97.8, part 2):
// a tool's run and its class, `DevToolsSecurity -status`, `csrutil status`, and the entitlements of `codesign -d
// --entitlements - --xml`. They came here from the Mac memory probe's parts.ts (part 1), which imports them, so that the
// probe and the service read each text in the same way. The Mac run of the probe (2026-11-25, at aacd9bd) read each of
// these three texts with them (classes ok; DevToolsSecurity disabled, SIP enabled, no get-task-allow). Each parser gives
// "unknown" or null for a text that it does not know.

/**
 * One run of a tool: its exit, the signal that ended it, its time limit, the probe's own stop of it (the watch of a leaks
 * run: "graph too large", "disk nearly full"), a spawn error's code, and the first characters of its stdout and of its
 * stderr, each kept apart (its pid stays in the caller).
 */
export type ToolRun = {
  exit: number | null; signal: string | null; timedOut: boolean; stopped?: string | null; spawnError: string | null;
  stdout: string; stderr: string; ms: number; pid?: number | null;
};

/** The whole text of a run for a parser (stdout, then stderr). */
export const textOf = (r: ToolRun): string => (r.stdout && r.stderr ? `${r.stdout}\n${r.stderr}` : r.stdout || r.stderr);

/** The class of a short read: ok (exit 0), exit (another exit code), timeout, killed, no tool, spawn failed. */
export function runClass(r: ToolRun): string {
  if (r.spawnError) return r.spawnError === "ENOENT" ? "no tool" : "spawn failed";
  if (r.timedOut) return "timeout";
  if (r.stopped) return r.stopped;
  if (r.signal) return "killed";
  return r.exit === 0 ? "ok" : "exit";
}

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

/** The entitlements that the probe reads of each Node (and the service's start reads of its own), by their short names. */
export const ENTITLEMENTS = {
  getTaskAllow: "com.apple.security.get-task-allow",
  debugger: "com.apple.security.cs.debugger",
  allowJit: "com.apple.security.cs.allow-jit",
  allowUnsignedExecutableMemory: "com.apple.security.cs.allow-unsigned-executable-memory",
  disableLibraryValidation: "com.apple.security.cs.disable-library-validation",
} as const;
export type EntitlementName = keyof typeof ENTITLEMENTS;
export type Entitlements = Record<EntitlementName, boolean | null>;

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
