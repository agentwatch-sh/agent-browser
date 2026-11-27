// The parsers of the Mac's read-only tools that the Mac's protected start reads (protect.ts; board ab-v16.97.8, part 2):
// a tool's run and its class, `DevToolsSecurity -status`, `csrutil status`, and the entitlements of `codesign -d
// --entitlements - --xml`. They came here from the Mac memory probe's parts.ts (part 1), which imports them, so that the
// probe and the service read each text in the same way. The Mac run of the probe (2026-11-25, at aacd9bd) read each of
// these three texts with them (classes ok; DevToolsSecurity disabled, SIP enabled, no get-task-allow). Each parser gives
// "unknown" or null for a text that it does not know.
//
// The taskport right (board ab-v16.97.15, part 2; the Mac design note docs/superpowers/specs/
// 2026-11-26-stored-sign-ins-mac-design.md, section 6.1): the parser of `security authorizationdb read
// system.privilege.taskport` and its meaning came here from the Mac sign-in window probe's parts.ts (board ab-v16.97.14,
// part 1), which exports them again. The probe's Mac run (2026-11-27) read the right with them: class `user`, group
// `_developer`, `authenticate-user` true, `shared` true, `timeout` 36000: "a password once, shared for its timeout".

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

/**
 * `csrutil status`: "System Integrity Protection status: enabled." or "disabled."; a custom configuration says "unknown
 * (Custom Configuration)." (macOS 10.15 and older: "enabled (Custom Configuration).", with a part such as Debugging
 * Restrictions off), and that is "unknown" too: only the word and its full stop count (board ab-v16.97.8, part 2, review M1).
 */
export function parseCsrutil(r: ToolRun): Tri {
  if (runClass(r) !== "ok") return "unknown";
  const m = /Protection status:\s*(enabled|disabled)\./i.exec(textOf(r));
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

// ------------------------------------------------------------------ the taskport right

/** `security`, by its absolute path (as the probe runs it). */
export const SECURITY = "/usr/bin/security";
/** The right that taskgated asks authd about for task_for_pid (the stored sign-ins design, section 5.5). */
export const TASKPORT_RIGHT = "system.privilege.taskport";

/** A value of a plist: a string, a number, a flag, a list of strings, or "dict" / "data" / "date" for the others. */
export type PlistValue = string | number | boolean | string[] | { kind: "dict" | "data" | "date" | "array" };

/**
 * The top-level dict of an XML plist, by its keys: each value as PlistValue. Null when the text holds no plist dict, or
 * its tags do not pair. Only the keys of the top-level dict count; a nested dict is { kind: "dict" }, and an array of
 * anything but strings is { kind: "array" }.
 */
export function plistDict(text: string): Record<string, PlistValue> | null {
  const at = text.indexOf("<plist");
  if (at < 0) return null;
  const body = /<plist\b[^>]*>\s*<dict>([\s\S]*)<\/dict>\s*<\/plist>/.exec(text.slice(at));
  if (!body) return null;
  type Tok = { t: "open" | "close" | "empty"; name: string } | { t: "text"; text: string };
  const toks: Tok[] = [];
  const re = /<(\/?)([A-Za-z]+)[^>]*?(\/?)>|([^<]+)/g;
  for (let m: RegExpExecArray | null; (m = re.exec(body[1])) !== null;) {
    if (m[4] !== undefined) { if (m[4].trim()) toks.push({ t: "text", text: m[4] }); continue; }
    toks.push({ t: m[1] ? "close" : m[3] ? "empty" : "open", name: m[2] });
  }
  const out: Record<string, PlistValue> = {};
  let i = 0;
  const textAt = (j: number) => { const k = toks[j]; return k && k.t === "text" ? k.text : ""; };
  /** The index after the element that opens at `j` (its matching close), or -1. */
  const skip = (j: number): number => {
    const first = toks[j] as { t: string; name: string };
    let depth = 0;
    for (let k = j; k < toks.length; k++) {
      const x = toks[k];
      if (x.t === "open" && x.name === first.name) depth++;
      else if (x.t === "close" && x.name === first.name && --depth === 0) return k + 1;
    }
    return -1;
  };
  while (i < toks.length) {
    const k = toks[i];
    if (!(k.t === "open" && k.name === "key")) return null;
    const key = unescapeXml(textAt(i + 1).trim());
    i += textAt(i + 1) ? 2 : 1;
    const c = toks[i];
    if (!(c && c.t === "close" && c.name === "key")) return null;
    const v = toks[++i];
    if (!v || v.t === "text" || v.t === "close") return null;
    if (v.t === "empty") {
      out[key] = v.name === "true" ? true : v.name === "false" ? false : v.name === "string" ? "" : v.name === "integer" || v.name === "real" ? 0
        : { kind: (["dict", "data", "date", "array"].includes(v.name) ? v.name : "data") as "dict" | "data" | "date" | "array" };
      i++;
      continue;
    }
    const after = skip(i);
    if (after < 0) return null;
    const inner = toks.slice(i + 1, after - 1);
    if (v.name === "string") out[key] = unescapeXml(inner.length === 1 && inner[0].t === "text" ? inner[0].text : "");
    else if (v.name === "integer" || v.name === "real") out[key] = Number(inner.length === 1 && inner[0].t === "text" ? inner[0].text.trim() : NaN);
    else if (v.name === "array") {
      const strings: string[] = [];
      let plain = true;
      for (let j = 0; j < inner.length;) {
        const x = inner[j];
        if (x.t === "open" && x.name === "string" && inner[j + 1]?.t === "text" && inner[j + 2]?.t === "close") { strings.push(unescapeXml((inner[j + 1] as { text: string }).text)); j += 3; }
        else if (x.t === "empty" && x.name === "string") { strings.push(""); j++; }
        else { plain = false; break; }
      }
      out[key] = plain ? strings : { kind: "array" };
    } else out[key] = { kind: (["dict", "data", "date"].includes(v.name) ? v.name : "data") as "dict" | "data" | "date" };
    i = after;
  }
  return out;
}

const unescapeXml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** The rule names that the result keeps by name (authd's own rules); another name is "other". */
export const KNOWN_RULES = ["allow", "deny", "authenticate", "authenticate-admin", "authenticate-admin-nonshared", "authenticate-developer", "authenticate-session-owner",
  "authenticate-session-owner-or-admin", "is-admin", "is-developer", "is-root", "is-session-owner", "default", "entitled", "entitled-admin", "kcunlock", "root-or-entitled-admin"] as const;
/** The group names that the result keeps by name (system groups); another group is "other". */
export const KNOWN_GROUPS = ["_developer", "admin", "staff", "wheel"] as const;

/** What the taskport right means for a debugger of the same user (the design note's D4 a). */
export type TaskportMeaning =
  | "no right" | "allow: no password" | "deny" | "a group member with no password" | "a password once, shared for its timeout"
  | "a password once, shared with no timeout" | "a password at each request" | "a rule" | "another form" | "unknown";

/**
 * `security authorizationdb read system.privilege.taskport`: the plist of the right on stdout ("YES (0)" on stderr).
 * The classes and the fields that the design reads (no comment, no date, no path, no name but the known ones), and what
 * they mean for a debugger of the same user. authd's semantics (from Apple's authorization.plist comments and
 * `man security`, not measured): class `user` with `authenticate-user` asks the user's password; `shared` puts the
 * credential into the session's cache, so another process of the session gets the right with no new prompt until
 * `timeout` seconds pass (no `timeout`: no limit in the session); class `user` with `authenticate-user` false lets a
 * member of `group` in with no password; class `rule` defers to the named rules.
 */
export function parseTaskport(r: ToolRun): { read: string; exit: number | null; right: Record<string, unknown> | null; meaning: TaskportMeaning } {
  const read = runClass(r);
  if (read !== "ok") {
    const none = /NO \(-60005\)|does not exist|no such right/i.test(textOf(r));
    return { read, exit: r.exit, right: null, meaning: none ? "no right" : "unknown" };
  }
  const d = plistDict(r.stdout);
  if (!d) return { read: "an unknown text", exit: r.exit, right: null, meaning: "unknown" };
  const str = (k: string) => (typeof d[k] === "string" ? (d[k] as string) : null);
  const bool = (k: string) => (typeof d[k] === "boolean" ? (d[k] as boolean) : null);
  const num = (k: string) => (typeof d[k] === "number" && Number.isFinite(d[k]) ? (d[k] as number) : null);
  const cls = str("class");
  const klass = cls === null ? null : ["user", "rule", "allow", "deny", "evaluate-mechanisms"].includes(cls) ? cls : "other";
  const ruleRaw = d.rule;
  const rules = typeof ruleRaw === "string" ? [ruleRaw] : Array.isArray(ruleRaw) ? ruleRaw : [];
  const rule = rules.map((x) => ((KNOWN_RULES as readonly string[]).includes(x) ? x : "other"));
  const g = str("group");
  const group = g === null ? null : (KNOWN_GROUPS as readonly string[]).includes(g) ? g : "other";
  const right = {
    class: klass, rule: rule.length ? rule : null, group, authenticateUser: bool("authenticate-user"), shared: bool("shared"), timeout: num("timeout"),
    allowRoot: bool("allow-root"), sessionOwner: bool("session-owner"), tries: num("tries"), kOfN: num("k-of-n"), version: num("version"),
    mechanisms: Array.isArray(d.mechanisms) ? (d.mechanisms as string[]).length : null,
  };
  return { read, exit: r.exit, right, meaning: taskportMeaning(right) };
}

/** The meaning of a parsed right (parseTaskport). */
export function taskportMeaning(x: { class: string | null; rule: string[] | null; authenticateUser: boolean | null; shared: boolean | null; timeout: number | null }): TaskportMeaning {
  if (x.class === "allow") return "allow: no password";
  if (x.class === "deny") return "deny";
  if (x.class === "rule") return x.rule && x.rule.length === 1 && x.rule[0] === "allow" ? "allow: no password" : "a rule";
  if (x.class !== "user") return x.class === null ? "unknown" : "another form";
  if (x.authenticateUser === false) return "a group member with no password";
  if (x.shared === true) return x.timeout === null ? "a password once, shared with no timeout" : x.timeout > 0 ? "a password once, shared for its timeout" : "a password at each request";
  return "a password at each request";
}
