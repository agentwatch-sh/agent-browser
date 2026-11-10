// Contract C12 (the control door between the service and the agentwatch daemon) and the format of the MCP's allow
// list (a part of C11), board task ab-v16.94.1: docs/contracts/C12.md and docs/contracts/mcp-allow-list.md are their
// masters, and test/vectors/control.json and test/vectors/mcp-allow-list.json their vectors. Stage 1a (board
// ab-v16.94.2) builds the service's control door: test/service-*.test.ts run the real service and its fake against the
// same vectors, and agentwatch's stage 2 (the daemon's client) tests against them too. The small reference rules below
// follow the text, so a vector that breaks a rule fails here first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
// A missing file reads as "", so each assertion fails on its own (tests first).
const readOr = (p: string) => { try { return read(p); } catch { return ""; } };
const C12 = readOr("docs/contracts/C12.md");
const ALLOW = readOr("docs/contracts/mcp-allow-list.md");
const control = JSON.parse(read("test/vectors/control.json"));
const allowV = JSON.parse(read("test/vectors/mcp-allow-list.json"));
const endpoint = JSON.parse(read("test/vectors/endpoint.json"));
const SCOPE = new RegExp(endpoint.scope.pattern);

const flat = (t: string) => t.replace(/\s+/g, " ");
const says = (text: string, s: string) => flat(text).includes(flat(s));
const isObj = (x: unknown): x is Record<string, any> => x !== null && typeof x === "object" && !Array.isArray(x);
const keysOf = (o: object) => Object.keys(o).sort();
// The part of a text from a bold heading to the next bold heading, or "" when it is missing.
function part(text: string, heading: string) {
  const start = text.indexOf(`**${heading}`);
  if (start < 0) return "";
  const next = text.indexOf("\n**", start + 1);
  return text.slice(start, next < 0 ? undefined : next);
}
// The rows of the Markdown table under a header line: each code span of the first cell -> the other cells.
function table(text: string, header: string) {
  const lines = text.split("\n");
  const at = lines.indexOf(header);
  assert.ok(at >= 0, `the table ${header}`);
  const rows = new Map<string, string[]>();
  for (const line of lines.slice(at + 2)) {
    if (!line.startsWith("| ")) break;
    const cells = line.slice(2, -2).split(" | ").map((c) => c.trim());
    // The names before the first " (": a note in parentheses names no row.
    for (const m of cells[0].split(" (")[0].matchAll(/`([^`]+)`/g)) rows.set(m[1], cells.slice(1));
  }
  return rows;
}
const spans = (cell: string) => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]);


// ---- C12: the reference of the door's rules, each rule from a sentence that C12 states ----

const KINDS = ["operator", "token", "daemon"];
const VIAS = ["web", "send", "cli", "config", "daemon"];
const ERRORS = ["unsupported", "bad request", "not the operator", "this prompt is gone", "no such session"];
/** agentwatch's user pattern (C12, provenance): a `user` that does not match is a bad request. */
const USER = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const LINE_KEYS = ["t", "v", "id", "op", "by"];
const strings = (x: unknown) => Array.isArray(x) && x.every((s) => typeof s === "string");
const text1 = (x: unknown) => typeof x === "string" && x.length > 0;
// The field rules of the shape step: each sentence of C12's part, and the check that it states. The test below asserts
// that the part holds exactly these bullets, so the reference takes no rule that C12 does not state.
const RULES = part(C12, "The field rules (the shape step).");
const PATTERN = /`(\^[^`]+\$)`/.exec(RULES)?.[1] ?? "^$";
const scope = (x: unknown) => typeof x === "string" && new RegExp(PATTERN).test(x);
const isRoot = (r: any) => isObj(r) && Number.isSafeInteger(r.pid) && r.pid >= 2 && Number.isSafeInteger(r.start) && r.start >= 0;
// A rule checks one field (f, its value), or the whole request against the fields of its row (whole).
type FieldRule = [string, (f: string, v: any) => boolean | null, ((req: any, fields: string[]) => boolean)?];
const FIELD_RULES: FieldRule[] = [
  ["A request carries each field of its row of the requests (for `config`, the four fields that it names). A request that omits one of them gets `bad request`. The shape step checks no field outside its row: a side ignores a field that it does not know, and `config` passes agentwatch's other `browser.*` keys as data.",
    () => null, (req, fields) => fields.every((f) => Object.hasOwn(req, f))],
  ["`scope` and `list` at the top level of a request, and `sessions[].scope`, match C11's scope pattern, `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`. `remote[].scope` and `remote[].list` are strings, and the shape step checks no pattern for them: `remote` stays empty until stage 5, which gives a remote scope a `<box>/` part (the self-contained design, section 9) and changes this rule first.",
    (f, v) => (f === "scope" || f === "list" ? scope(v) : null)],
  ["A root (`roots` of `set_sessions`) follows C11's root rule: an object with an integer `pid` from 2 to 2^53 - 1 and an integer `start` from 0 to 2^53 - 1. One root that breaks it makes the whole request a bad request (C11's line drops such an item; a snapshot of the daemon is never applied in part).", () => null],
  ["`sessions` is a list of objects with a `scope`, a `repo` (a string or `null`), `roots` (a list of roots), a `cgroup` (a string or `null`) and a `lifetime_id` (a string or `null`). `remote` is a list of objects with the strings `scope`, `box` and `list`. `box` is an object with the lists of strings `hosts` and `cookie_names`.",
    (f, v) => f === "sessions" ? Array.isArray(v) && v.every((s: any) => isObj(s) && scope(s.scope) && (s.repo === null || typeof s.repo === "string") && Array.isArray(s.roots) && s.roots.every(isRoot) && (s.cgroup === null || typeof s.cgroup === "string") && (s.lifetime_id === null || typeof s.lifetime_id === "string"))
      : f === "remote" ? Array.isArray(v) && v.every((x: any) => isObj(x) && typeof x.scope === "string" && typeof x.box === "string" && typeof x.list === "string")
      : f === "box" ? isObj(v) && strings(v.hosts) && strings(v.cookie_names) : null],
  ["`enabled` and `control` are booleans; `chrome_bin` is a string or `null`; `chrome_args` is a list of strings.",
    (f, v) => (f === "enabled" || f === "control" ? typeof v === "boolean" : f === "chrome_bin" ? v === null || typeof v === "string" : f === "chrome_args" ? strings(v) : null)],
  ["`add` and `remove` are lists of strings, and each entry is checked later by the host rules (`list_set`, below). `prompt` and `host` are strings of one character or more.",
    (f, v) => (f === "add" || f === "remove" ? strings(v) : f === "prompt" || f === "host" ? text1(v) : null)],
  ["`payload` is an object. The shape step checks no more of it: the C2 check comes after the kind check, so an `import` with a token's kind gets `not the operator`, whatever its payload.",
    (f, v) => (f === "payload" ? isObj(v) : null)],
];
const fieldFits = (f: string, v: unknown) => FIELD_RULES.every(([, check]) => check(f, v) !== false);
const requestFits = (req: any, fields: string[]) => FIELD_RULES.every(([, , whole]) => !whole || whole(req, fields));
// Each op of C12: its fields (from C12's table) and the kinds that it takes (null: any kind).
const OWN = ["daemon"], ACT = ["operator"], START = ["operator", "token"];
const OPS: Record<string, { fields: string[]; kinds: string[] | null }> = {
  config: { kinds: OWN, fields: ["enabled", "control", "chrome_bin", "chrome_args"] },
  set_sessions: { kinds: OWN, fields: ["sessions", "remote", "box"] },
  session_ended: { kinds: OWN, fields: ["scope"] },
  launch_check: { kinds: OWN, fields: ["scope"] },
  list_set: { kinds: ACT, fields: ["list", "add", "remove"] },
  prompt_allow: { kinds: ACT, fields: ["prompt", "host", "list"] },
  prompt_dismiss: { kinds: ACT, fields: ["prompt"] },
  import: { kinds: ACT, fields: ["payload"] },
  start: { kinds: START, fields: [] },
  stop: { kinds: START, fields: [] },
  status: { kinds: null, fields: [] },
  lists_get: { kinds: null, fields: [] },
  prompts_get: { kinds: null, fields: [] },
  endpoint: { kinds: null, fields: ["scope"] },
  sender: { kinds: null, fields: [] },
};
const byFits = (by: any) => isObj(by) && keysOf(by).join() === "kind,user,via" && KINDS.includes(by.kind) && typeof by.user === "string" && USER.test(by.user) && VIAS.includes(by.via);
type Prompt = { id: string; host: string; list: string };
// The service's error for a request, in C12's order (null: the service applies it). `scopes`: the scopes of the last
// set_sessions less the ones that ended since (for endpoint's `no such session`).
function serviceError(req: any, state: { prompts: Prompt[]; scopes?: Set<string> }): string | null {
  const o = OPS[req.op];
  if (!o) return "unsupported";
  if (!byFits(req.by) || !requestFits(req, o.fields) || !o.fields.every((f) => fieldFits(f, req[f]))) return "bad request";
  if (o.kinds !== null && !o.kinds.includes(req.by.kind)) return o.kinds === ACT ? "not the operator" : "bad request";
  const p = state.prompts.find((x) => x.id === req.prompt);
  if (req.op === "prompt_dismiss" && !p) return "this prompt is gone";
  if (req.op === "prompt_allow" && (!p || p.host !== req.host || p.list !== req.list)) return "this prompt is gone";
  if (req.op === "endpoint" && state.scopes && !state.scopes.has(req.scope)) return "no such session";
  return null;
}
/** C12's line rules for the bytes of one line (with its newline): true when the line closes the connection. */
function lineCloses(bytes: Buffer): boolean {
  const line = bytes.subarray(0, bytes.length - 1);
  if (bytes[bytes.length - 1] !== 10 || line.includes(10) || line.includes(13)) return true;
  if (line[0] === 0xef && line[1] === 0xbb && line[2] === 0xbf) return true;
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(line); } catch { return true; }
  let msg: unknown;
  try { msg = JSON.parse(text); } catch { return true; }
  return !isObj(msg) || (msg.t === "req" && typeof msg.id !== "string");
}
// Each event of C12 and its fields (stopped with the reason stop also has by).
const EVENTS: Record<string, string[]> = {
  ready: ["chrome_pid", "chrome_version", "extension_version", "endpoint"],
  prompt: ["id", "state", "host", "scope", "list", "from", "warnings"],
  stopped: ["reason"],
  chrome: ["version", "update"],
  error: ["op", "user", "domain", "counts"],
};
const sayAll = (text: string, list: string[], what = "C12") => { for (const s of list) assert.ok(says(text, s), `${what} says: ${s}`); };

test("C12's master is this file (board ab-v16.94.1): new, two parties, its source, the stages, and no use before stage 1", () => {
  assert.ok(C12.startsWith("# C12. The control door (agent-browser's service <-> the agentwatch daemon)\n"), "the heading");
  sayAll(C12, [
    "This file is the master for C12. C12 is new in board task ab-v16.94.1, stage 0 of the self-contained agent browser.",
    "It binds this repository (the service, `agent-browser service`) and agentwatch (its daemon), and no other.",
    "Its source is the design `docs/superpowers/specs/2026-11-09-self-contained-agent-browser-design.md`, section 7.1: the daemon lead's proposal and review (R1, R7, m1, C4, C7 and C8), the operator's answers of 2026-11-10 (its section 19), and the daemon lead's answers to stage 0's choices (2026-11-10).",
    "The vectors: `test/vectors/control.json`.",
    "| The door, its admission, the hello, the service's answers and its events | agent-browser's service | stage 1 (boards ab-v16.94.2 to ab-v16.94.5), off by default |",
    "| The client, its check of the service, the provenance and the requests | the agentwatch daemon | stage 2, off by default |",
    "Nothing uses C12 before stage 1. The old daemon path stays the default, and it does not change, until stage 3 turns the switch on for a box (with the operator's approval).",
    "The switch moves the parties of C4 and C10 from the daemon to the service on that box; C12 is how the daemon then talks to the service.",
  ]);
});

test("C12 states the door: compact UTF-8 lines, the daemon's own size check (413), and the log rule", () => {
  sayAll(part(C12, "The door."), [
    "A Unix socket with mode 0600, `control.sock`, in the service's run folder (mode 0700): `$XDG_RUNTIME_DIR/agent-browser/` on Linux, `~/.cache/agent-browser/run/` on the Mac. A path is at most 103 bytes. The door has no TCP port.",
    "One JSON object per line, in compact UTF-8 with a newline at its end: no ASCII escapes of characters that UTF-8 can hold (with them a valid C2 payload can grow to three times its size).",
    "A line is at most `CONTROL_MAX_LINE = 33619968` bytes (the 33,554,432 bytes of a C2 payload and 64 KiB more).",
    "The daemon measures each line before it sends it. When a line is longer than `CONTROL_MAX_LINE`, the daemon does not send it, and it answers its own caller with a 413. So the service never has to close the control connection for a line's size. A side that still reads a longer line closes the connection.",
    "The daemon sends the requests. The service sends the answers and the events. The service sends no request.",
    "No side logs page content, a cookie, a URL path or a payload in any log line. A line that a side refuses for its size or its shape is never logged.",
  ]);
  assert.equal(control.constants.CONTROL_MAX_LINE, 33554432 + 65536, "the C2 limit and 64 KiB");
  for (const v of [...control.requests, ...control.badRequests]) {
    const line = JSON.stringify(v.req);
    assert.ok(!/\\u[0-9a-fA-F]{4}/.test(line), `${v.note}: compact UTF-8, no ASCII escape`);
    assert.ok(Buffer.byteLength(line) + 1 <= control.constants.CONTROL_MAX_LINE, v.note);
  }
});

test("C12 states who connects (R1, m1): the MainPID and its pidfd, the parent, argv[1:] and the exe from agentwatch's file, the same process, a refused peer, and the daemon's check of the service", () => {
  const who = part(C12, "Who connects: only the agentwatch daemon process itself (the daemon lead's R1).");
  sayAll(who, [
    "At each accept the service reads the peer (`SO_PEERCRED` and `SO_PEERPIDFD` on Linux) and admits it only when all of these hold:",
    "1. The service gets the MainPID of agentwatch's unit from the user's systemd at this accept, and it holds a pidfd of the MainPID itself. A daemon restart changes the MainPID.",
    "2. The peer is the MainPID itself, or a direct child of it: the peer's parent pid is the MainPID, and the parent's start time (field 22 of `/proc/<ppid>/stat`) equals the MainPID's start time, read in the same check.",
    "(If agentwatch's unit makes the daemon itself its MainPID, the child case goes, and this file changes first.)",
    "3. The peer is the daemon's command. The service reads the expected command from a file that agentwatch's daemon writes at its start, before it connects, so an agentwatch update needs no restart of the service.",
    "It compares the peer's command line (`/proc/<pid>/cmdline`) from argv[1] on: argv[0] is the interpreter's path in uv's cache, which changes with the script's dependencies (agentwatch runs a uv script).",
    "It also checks the peer's executable (`/proc/<pid>/exe`) against the interpreter that the file names.",
    "4. The peer is the same process during the whole check: the service holds its pidfd, and the peer's start time is the same before and after the reads, and not earlier than its parent's (start times count in clock ticks, so a child can start in its parent's tick). Its parent pid is the same before and after the reads. After the checks the service reads the MainPID again, and it must be the same.",
    "The service checks at most 4 connections at a time. A connection over that limit gets the refused line with its reason (`The control door checks 4 other connections now, so it refuses this one: connect again.`), and the service closes it.",
    "A process of agentwatch's cgroup is not enough. A child that the daemon forks and that connects itself has the daemon, not the MainPID, as its parent, and it is refused. The daemon never passes its connection to another process.",
    "The service's own pid never passes. No agent-browser CLI command is a control client.",
    "A peer that fails a rule of 1 to 4 gets one line `{\"t\":\"refused\",\"reason\":\"<text>\"}` that names the rule, and the service closes the connection and logs the reason.",
    "When the check cannot run, the door refuses (the daemon lead's m1). If the systemd query fails, or the daemon runs with no systemd user unit, the service sends the same line with the reason, closes the connection, and logs the reason.",
    "The daemon shows that line in `agentwatch health`. The service never admits by a weaker rule.",
    "The daemon checks the service too. Before it sends its hello, the daemon admits the peer of `control.sock` only when that peer is the MainPID of `agent-browser.service`, by a pidfd and its start time.",
    "Else it closes the connection and sends nothing: a process of the same user that replaced `control.sock` would otherwise get sign-in payloads and list acts.",
    "On the Mac the service reads `LOCAL_PEERPID`, gets the job's pid from `launchctl print gui/<uid>/<agentwatch's label>` (its `pid` line) at each accept, reads the parent and the start time with `proc_pidinfo` and the command line with `sysctl` (`KERN_PROCARGS2`), and applies the same rules (stage 4; not run on the Mac yet).",
  ]);
  assert.ok(!says(who, "which the service's unit file names"), "the expected command comes from agentwatch's file, not from the unit file");
  for (const r of control.refused) {
    assert.deepEqual(keysOf(r.line), ["reason", "t"], r.note);
    assert.equal(r.line.t, "refused", r.note);
    assert.ok(typeof r.line.reason === "string" && r.line.reason.length > 0, r.note);
  }
  assert.ok(control.refused.some((r: any) => /rule [1-4]/.test(r.line.reason)), "a refused line that names a failed rule (D3)");
});

test("C12 states the hello (C7): its two shapes, v 1, the commit for the pin only, the side check, a new v, additive features, fake, --hello, and no request before the hellos", () => {
  sayAll(part(C12, "The hello (the daemon lead's C7)."), [
    "After the admission each side sends its hello as its first line:",
    "The service: `{\"t\":\"hello\",\"v\":1,\"side\":\"service\",\"version\":\"<agent-browser version>\",\"commit\":\"<commit or null>\",\"features\":[...]}`.",
    "The daemon: `{\"t\":\"hello\",\"v\":1,\"side\":\"daemon\",\"version\":\"<agentwatch version>\",\"features\":[...]}`.",
    "`v` is the version of this door's lines: 1. `version` is the side's package version.",
    "The service's `commit` is the 40-hex commit of agent-browser that it runs, or `null` when it cannot tell; the daemon compares it with its pin (the design, section 7.3). The `commit` is for the pin check only, never for trust.",
    "The daemon refuses a hello whose `side` is not `\"service\"`, and the service refuses a hello whose `side` is not `\"daemon\"`: each closes the connection.",
    "A side that reads a hello whose `v` is not 1 closes the connection and sends no request and no answer; the daemon shows it in `agentwatch health`. A new `v` is a new door, not an additive change.",
    "Fields and features are only added, never changed: a side ignores a field and a feature that it does not know.",
    "A request for an op that the service does not have gets `{\"t\":\"res\",\"id\":\"<id>\",\"ok\":false,\"error\":\"unsupported\"}`. So an older service and a newer daemon (or the reverse) degrade, with no lock-step bump.",
    "Feature names: `fake` (the hello of `agent-browser service --fake`, a scripted state with no Chrome, for agentwatch's hermetic tests). A stage that adds an op or a field adds its feature name to this list first.",
    "`agent-browser service --hello` prints the service's hello as one line and exits, with no service running.",
    "The daemon sends no request before it has read the service's hello, and the service answers no request before it has read the daemon's hello.",
  ]);
  const FEATURES = ["fake"];
  const sides = new Set<string>();
  for (const { note, line, newer } of control.hellos) {
    assert.equal(line.t, "hello", note);
    assert.equal(line.v, 1, note);
    assert.ok(["service", "daemon"].includes(line.side), note);
    sides.add(line.side);
    assert.ok(typeof line.version === "string" && line.version.length > 0, note);
    assert.ok(strings(line.features), note);
    const want = line.side === "service" ? ["commit", "features", "side", "t", "v", "version"] : ["features", "side", "t", "v", "version"];
    if (newer) {
      for (const k of want) assert.ok(Object.hasOwn(line, k), `${note}: ${k}`);
      assert.ok(keysOf(line).some((k) => !want.includes(k)) && line.features.some((f: string) => !FEATURES.includes(f)), `${note}: a field and a feature that a reader ignores`);
    } else {
      assert.deepEqual(keysOf(line), want, note);
      for (const f of line.features) assert.ok(FEATURES.includes(f), `${note}: a feature of C12: ${f}`);
    }
    if (line.side === "service") assert.ok(line.commit === null || /^[0-9a-f]{40}$/.test(line.commit), `${note}: the commit`);
  }
  assert.deepEqual([...sides].sort(), ["daemon", "service"], "both sides");
  assert.ok(control.hellos.some((h: any) => h.line.features.includes("fake")), "the hello of --fake");
  // A reader closes at a hello of the wrong side or another v (D2, F9).
  const closes = (reader: string, line: any) => line.v !== 1 || line.side !== (reader === "daemon" ? "service" : "daemon");
  for (const h of control.badHellos) assert.equal(closes(h.reader, h.line), h.closes, h.note);
  assert.ok(control.badHellos.some((h: any) => h.reader === "daemon" && h.line.side !== "service" && h.line.v === 1), "the daemon reads a hello that is not the service's");
  assert.ok(control.badHellos.some((h: any) => h.reader === "service" && h.line.side !== "daemon" && h.line.v === 1), "the service reads a hello that is not the daemon's");
  assert.ok(control.badHellos.some((h: any) => h.line.v !== 1), "a hello with another v");
  for (const { line } of control.hellos) assert.equal(closes(line.side === "service" ? "daemon" : "service", line), false, "a good hello does not close");
});

test("C12 states the lines, the line keys, an unknown ev, the field rules (exactly), and provenance (R7) with the order of the service's checks", () => {
  sayAll(part(C12, "The lines."), [
    "A request: `{\"t\":\"req\",\"id\":\"<id>\",\"op\":\"<op>\",\"by\":{\"kind\":\"<kind>\",\"user\":\"<user>\",\"via\":\"<via>\"},...}`, with the op's fields at the top level, as in C4. `id` is a string, unique on its connection.",
    "An answer: `{\"t\":\"res\",\"id\":\"<id>\",\"ok\":true,\"data\":{...}}` or `{\"t\":\"res\",\"id\":\"<id>\",\"ok\":false,\"error\":\"<text>\"}`. The service answers each request once.",
    "An event: `{\"t\":\"ev\",\"ev\":\"<event>\",...}`, with the event's fields at the top level.",
    "No op field uses a line key: `t`, `v`, `id`, `op` or `by`.",
    "A line that is not a JSON object, or a request with no string `id`, closes the connection.",
    "A request with an op that the service does not have gets `unsupported` (the hello, above).",
    "A request whose `by` breaks the shape of provenance (below), or whose fields break the field rules (below), gets `{\"t\":\"res\",\"id\":\"<id>\",\"ok\":false,\"error\":\"bad request\"}`.",
    "A line is strict UTF-8, with no byte order mark and no CR: a line that is not valid UTF-8 (for example the bytes `ED A0 80` of a lone surrogate), a line that starts with a byte order mark (`EF BB BF`), and a line that holds a CR (byte `0D`, for example a line that ends in CR LF) break the compact-line rule, and each closes the connection.",
    "Bytes after the last newline are not a line: a side does not answer them. At the end of the stream it drops them and closes the connection. Many lines can come in one read: a side takes each of them, in order.",
    "A side ignores a line whose `t` it does not know: a newer side can add a kind of line. The daemon ignores an event whose `ev` it does not know, as it ignores a field that it does not know: a newer service can add an event.",
  ]);
  // The field rules: the part holds exactly the reference's bullets, so the reference takes its rules only from C12.
  assert.ok(says(RULES, "The service checks each field of a request with these rules, and with no other rule, before it checks the kind:"), "the field rules' lead sentence");
  const bullets = RULES.split("\n- ").slice(1).map((b) => flat(b).trim());
  assert.deepEqual(bullets, FIELD_RULES.map(([s]) => flat(s)), "the field rules are exactly the reference's");
  assert.equal(PATTERN, endpoint.scope.pattern, "C12's scope pattern is C11's");
  // No op field is a line key (D1).
  for (const [op, o] of Object.entries(OPS)) for (const f of o.fields) assert.ok(!LINE_KEYS.includes(f), `${op}: ${f} is no line key`);
  sayAll(part(C12, "Provenance (the daemon lead's R7)."), [
    "Each request carries one shape of provenance: `\"by\":{\"kind\":\"operator\"|\"token\"|\"daemon\",\"user\":\"<user>\",\"via\":\"web\"|\"send\"|\"cli\"|\"config\"|\"daemon\"}`.",
    "`kind: operator` only when the gateway's field is present with `\"login\":\"password\"`: the gateway adds `\"operator\":{\"user\":...,\"login\":\"password\"}` to the daemon's op only after its password-login check.",
    "The daemon refuses a list change, an allow, a dismissal or an import without it. A caller with the API token (an agent, or `agentwatch browser ...` in a terminal) never produces it. Stage 2 tests that an `operator` key in an HTTP body never gives `kind: operator`.",
    "`kind: token` for a start, a stop or a read with the API token (for a start and a stop, today's rule).",
    "`kind: daemon` for the daemon's own requests: `config`, `set_sessions`, `session_ended`, `launch_check`, and the daemon's own reads.",
    "`browser.control` is a key of agentwatch's config file, so it comes in `config` with `kind: daemon` and `via: config`. The daemon's other own requests have `via: daemon`.",
    "`user` is the agentwatch user: the login's user for `operator`, the token's user for `token`, and the daemon's own user for `daemon`. It matches agentwatch's user pattern, `^[A-Za-z_][A-Za-z0-9_.-]{0,63}$`; a `user` that does not match breaks the shape of provenance (so no log line gets a newline or a control character from it).",
    "`via` is where the act came from: `web` (the web viewer), `send` (the operator extension's send, C9), `cli` (the agentwatch CLI), `config` (the config file), `daemon` (the daemon itself).",
    "The service checks a request in this order: its op (`unsupported`); the shape of its `by` and its fields (`bad request`); then its kind.",
    "The service applies an operator act (`list_set`, `prompt_allow`, `prompt_dismiss`, `import`) only with `kind: operator`; any other kind gets `{\"t\":\"res\",\"id\":\"<id>\",\"ok\":false,\"error\":\"not the operator\"}`.",
    "It applies `start` and `stop` only with `kind: operator` or `kind: token`, and the daemon's own requests (`config`, `set_sessions`, `session_ended`, `launch_check`) only with `kind: daemon`; another kind gets `bad request`. The reads (`status`, `lists_get`, `prompts_get`, `endpoint`, `sender`) take any kind.",
    "The service does not check `via`: it logs it.",
    "The service takes provenance only from the control door, never from a client request (C11), and it logs each act with its provenance.",
  ]);
});

test("C12's table of requests names exactly the ops of the reference, with their fields, and states each row", () => {
  const rows = table(C12, "| Op | Fields | What the service does, and its answer's `data` |");
  assert.deepEqual([...rows.keys()].sort(), Object.keys(OPS).sort(), "the ops");
  for (const [op, cells] of rows) {
    const named = spans(cells[0]).filter((s) => /^[a-z_]+$/.test(s));
    for (const f of OPS[op].fields) assert.ok(named.includes(f), `${op}: the field ${f}`);
    if (OPS[op].fields.length === 0) assert.equal(cells[0], "none", `${op}: no field`);
  }
  assert.deepEqual(spans(rows.get("list_set")![0]), ["list", "add", "remove"], "list_set: add and remove, no whole list");
  assert.equal(rows.get("set_sessions")![0], "`sessions` (`[{\"scope\",\"repo\",\"roots\":[{\"pid\",\"start\"}],\"cgroup\",\"lifetime_id\"}]`), `remote` (`[{\"scope\",\"box\",\"list\"}]`, empty until stage 5), `box` (`{\"hosts\",\"cookie_names\"}`)", "the shape of sessions (with each session's lifetime id: D11), remote and box");
  sayAll(C12, [
    "Applies agentwatch's `browser.*` config keys, as data. The daemon sends it at each connect and at each change. `chrome_bin` keeps the way back to Chromium with `--load-extension`; `control: false` makes the endpoint and the MCP path answer their 503 (C11, from stage 3); `enabled: false` stops the browser.",
    "A complete snapshot. The service builds the scopes, the list of each scope (by repo), the `set_scopes` object (C4) and the model's roots. No scope object goes out before the first complete snapshot (the daemon lead's C4).",
    "Ends the scope: closes its tabs (`end_scope`, the receiver's sweep), drops its roots, closes its MCP connections and ends its MCP sessions (C11), removes its list copy, and records the ended scope.",
    "Today's `launch_refusal`.",
    "`data`: `{\"refusal\":\"<text>\"}` while an ended scope of that name is held in memory only, else `{\"refusal\":null}`. The daemon asks before each launch. If the service does not answer in 2 s, the daemon refuses only a name that ended since its own start, with a text that says to try again.",
    "Adds the entries of `add` to one list and removes those of `remove`, as the gateway's list route does today: it never replaces the whole list, so an allow between the daemon's read and its `list_set` stays.",
    "Checks each entry of `add` with the host rules, writes the list file, and the next `set_scopes` carries it.",
    "`data`: `{\"allow\":[\"<entry>\"],\"refused\":[{\"entry\":\"<entry>\",\"reason\":\"<text>\"}]}`, with the list's entries after the change.",
    "Adds the prompt's host to the prompt's list, as a `list_set` with that one host, and answers as `list_set` does.",
    "`host` and `list` are what the operator saw: when they are not the prompt's host and list now, or the service does not know the prompt, the answer is the error `this prompt is gone`.",
    "Dismisses the prompt. The service owns the prompts and their dismissals. A prompt that the service does not know gets the error `this prompt is gone`.",
    "Checks the payload (C2), drops the box's own sign-in cookies (the hosts and names of `set_sessions`), sends `import` to the receiver (C4), and answers the counts of C4's `import`. Nothing is written to disk.",
    "Starts or stops Chrome and Xvfb. Today's rule stays (the API token may start and stop) until the operator answers Q5 (board item ab-6ng).",
    "the state (`off`, `starting`, `ready` or `failed closed`), with an agent's text and an operator's text for each state (I2: no agent's text names a stop or a start)",
    "Chrome's kind, version, pid and update state, and the extension's version; the endpoint's state (the peer check's form, or why it cannot run); the MCP's state; the sessions and lists that the service has; the last stop with its reason and time; the open prompts; the update state.",
    "| `lists_get`, `prompts_get` | none | The lists and the old single list (read only); the open prompts, each with its recipients. |",
    "The endpoint's URL for the scope (for `agentwatch browser endpoint` and `env`). A scope that the service does not have (no session of the last `set_sessions` has it, or it ended) gets the error `no such session`, not a URL.",
    "The sender's ID, its version and its package (C1, C9).",
    "Stage 1a (board ab-v16.94.2) fixes the keys of the `data` of `status`, `lists_get`, `prompts_get`, `endpoint` and `sender` in the part \"The data of the reads\", below, with the daemon lead's review. They include:",
    "It keeps each session's `lifetime_id` (agentwatch's id of that run of the session) for the recipients of a prompt.",
    "the agent's text and the operator's text of a state as two separate keys, because the gateway gives the operator's text only to a password login;",
    "each prompt's recipients, the session name and the lifetime id of each session that the block stopped, because the daemon sends them the allow notice (today's gateway does, at an allow);",
    "the MCP's state, for `agentwatch health`.",
    "The design's table names the prompt's field `id`; here it is `prompt`, because `id` is the request's id.",
    "The design's table names a field `providers` for `list_set` too. No list has providers: the operator chose the allow prompt, not a list of sign-in providers (board item ab-pbk). So `list_set` has no such field, and a later rule can add it as an additive field.",
    "The design's `list_set` names the whole list (`allow`); here it adds and removes (the daemon lead's change of 2026-11-10).",
  ]);
  for (const e of ERRORS) assert.ok(C12.includes("`" + e + "`") || C12.includes(`"error":"${e}"`), `C12 names the error ${e}`);
});

const has0 = (f: (v: any) => boolean) => [...control.requests, ...control.badRequests].some(f);
test("each request vector fits C12, gets its answer, and each bad request vector gets the error of C12's order", () => {
  const ids = new Set<string>();
  const ops = new Set<string>();
  // The scopes of the last set_sessions that applied, less the ones that ended since (for endpoint, A1).
  let scopes = new Set<string>();
  for (const { note, req, res } of [...control.requests, ...control.badRequests]) {
    assert.equal(req.t, "req", note);
    assert.ok(typeof req.id === "string" && !ids.has(req.id), `${note}: a unique id`);
    ids.add(req.id);
    assert.equal(res.t, "res", note);
    assert.equal(res.id, req.id, note);
    if (res.ok) {
      assert.deepEqual(keysOf(res), ["data", "id", "ok", "t"], note);
      assert.ok(isObj(res.data), `${note}: data is an object`);
    } else {
      assert.deepEqual(keysOf(res), ["error", "id", "ok", "t"], note);
      assert.ok(ERRORS.includes(res.error), `${note}: an error of C12`);
    }
    assert.equal(serviceError(req, { ...control.state, scopes }), res.ok ? null : res.error, note);
    if (res.ok && req.op === "set_sessions") scopes = new Set(req.sessions.map((x: any) => x.scope));
    if (res.ok && req.op === "session_ended") scopes.delete(req.scope);
  }
  // A1: endpoint for a scope that the service does not have, and for a scope that ended: no such session.
  assert.ok(has0((v) => v.req.op === "endpoint" && v.req.scope === "web-3" && v.res.error === "no such session"), "endpoint: a scope never named");
  assert.ok(has0((v) => v.req.op === "endpoint" && control.requests.some((r: any) => r.req.op === "session_ended" && r.req.scope === v.req.scope) && v.res.error === "no such session"), "endpoint: a scope that ended");
  // N8: a user that breaks the pattern is a bad request.
  assert.ok(has0((v) => typeof v.req.by?.user === "string" && !USER.test(v.req.by.user) && /\n/.test(v.req.by.user) && v.res.error === "bad request"), "a user with a newline");
  for (const { req, res } of control.requests) {
    ops.add(req.op);
    if (req.op === "list_set" || req.op === "prompt_allow") assert.ok(strings(res.data.allow) && Array.isArray(res.data.refused), `${req.id}: allow and refused`);
  }
  for (const op of ["config", "set_sessions", "session_ended", "launch_check", "list_set", "prompt_allow", "prompt_dismiss", "import", "start", "stop"]) assert.ok(ops.has(op), `a vector for ${op}`);
  const has = (f: (v: any) => boolean) => [...control.requests, ...control.badRequests].some(f);
  assert.ok(has((v) => v.req.op === "config" && v.req.by.via === "config" && v.req.control === false), "browser.control in config, via config");
  assert.ok(has((v) => v.req.op === "set_sessions" && v.req.sessions.length > 1 && v.req.remote.length === 0), "a complete snapshot, no remote scope before stage 5");
  assert.ok(has((v) => v.req.op === "import" && v.req.by.kind === "operator" && v.req.by.via === "send"), "an import from the send");
  assert.ok(has((v) => v.req.op === "start" && v.req.by.kind === "token" && v.res.ok), "a start with the token: today's rule");
  assert.ok(has((v) => v.req.op === "stop" && v.req.by.kind === "token" && v.res.ok), "a stop with the token: today's rule until Q5");
  for (const op of ["list_set", "prompt_allow", "import"]) assert.ok(has((v) => v.req.op === op && v.req.by?.kind !== "operator" && v.res.error === "not the operator"), `${op} by another kind`);
  for (const e of ERRORS) assert.ok(has((v) => v.res.error === e), `a vector of ${e}`);
  assert.ok(has((v) => v.req.op === "launch_check" && typeof v.res.data?.refusal === "string") && has((v) => v.req.op === "launch_check" && v.res.data?.refusal === null), "launch_check: a refusal and none");
  // D9: the host or the list that the operator saw is not the prompt's now.
  for (const f of ["host", "list"]) assert.ok(has((v) => v.req.op === "prompt_allow" && control.state.prompts.some((p: any) => p.id === v.req.prompt && p[f] !== v.req[f]) && v.res.error === "this prompt is gone"), `prompt_allow: another ${f}`);
  // F8: list_set adds and removes; the old form with the whole list is a bad request.
  assert.ok(has((v) => v.req.op === "list_set" && Object.hasOwn(v.req, "allow") && !Object.hasOwn(v.req, "add") && v.res.error === "bad request"), "list_set: the old whole-list form");
  // B3: each field rule has a bad vector.
  assert.ok(has((v) => v.req.op === "session_ended" && !scope(v.req.scope) && v.res.error === "bad request"), "a scope that breaks the pattern");
  assert.ok(has((v) => v.req.op === "set_sessions" && v.req.sessions.some((s: any) => s.roots.some((r: any) => !isRoot(r))) && v.res.error === "bad request"), "a root that breaks C11's root rule");
  assert.ok(has((v) => v.req.op === "config" && !strings(v.req.chrome_args) && v.res.error === "bad request"), "chrome_args that is not a list of strings");
  assert.ok(has((v) => v.req.op === "import" && v.req.by.kind === "token" && isObj(v.req.payload) && v.res.error === "not the operator"), "an import's payload is only checked as an object before the kind");
});

test("C12's event table names exactly the events of the reference, each event vector has their fields only, with no URL path, page or cookie, and an unknown ev is ignored", () => {
  const rows = table(C12, "| Event | Fields |");
  assert.deepEqual([...rows.keys()].sort(), Object.keys(EVENTS).sort());
  for (const [ev, cells] of rows) for (const f of EVENTS[ev]) assert.ok(spans(cells[0]).includes(f), `${ev}: the field ${f}`);
  const seen = new Set<string>();
  for (const { note, ev } of control.events) {
    assert.equal(ev.t, "ev", note);
    const fields = EVENTS[ev.ev];
    assert.ok(fields, `${note}: an event of C12`);
    seen.add(ev.ev);
    const want = ["ev", "t", ...fields, ...(ev.ev === "stopped" && ev.reason === "stop" ? ["by"] : [])].sort();
    assert.deepEqual(keysOf(ev), want, note);
    if (ev.ev === "stopped") assert.ok(["receiver_missing", "sessions_unread", "start_failed", "stop"].includes(ev.reason), note);
    if (ev.by !== undefined) assert.ok(byFits(ev.by), `${note}: the stop's provenance`);
    if (ev.ev === "prompt") assert.ok(["open", "changed", "closed"].includes(ev.state) && strings(ev.warnings), note);
    if (ev.ev === "ready") assert.ok(isObj(ev.endpoint) && (["pidfd", "stat", "mac"].includes(ev.endpoint.form) ? keysOf(ev.endpoint).join() === "form" : ev.endpoint.form === null && typeof ev.endpoint.reason === "string"), note);
    assert.ok(!/"(url|path|page|cookie|cookies)"/.test(JSON.stringify(ev)), `${note}: no URL, path, page or cookie`);
  }
  assert.deepEqual([...seen].sort(), Object.keys(EVENTS).sort(), "every event has a vector");
  for (const reason of ["receiver_missing", "sessions_unread", "start_failed", "stop"]) assert.ok(control.events.some((v: any) => v.ev.ev === "stopped" && v.ev.reason === reason), `stopped: ${reason}`);
  // F9: an event that the daemon does not know is ignored.
  assert.ok(control.newerEvents.length > 0, "a vector of an unknown ev");
  for (const v of control.newerEvents) assert.equal(!Object.hasOwn(EVENTS, v.ev.ev), v.ignored, `${v.note}: the daemon ignores an ev that it does not know`);
  sayAll(C12, [
    "`reason`: `receiver_missing`, `sessions_unread`, `start_failed` or `stop`; for `stop`, `by` (the stop's provenance). The daemon sees each fail-closed stop (the daemon lead's C4).",
    "`id`, `state` (`open`, `changed` or `closed`), `host`, `scope`, `list`, `from`, `warnings`; no URL path; the per-host limit of once in 10 s stays",
    "`op`, `user`, `domain`, `counts`; never a page, a cookie or a URL path",
  ]);
});

test("C12 states what happens when the daemon drops, and the vectors' part", () => {
  sayAll(part(C12, "When the daemon drops (a daemon restart or stop)."), [
    "The service goes on. Chrome, the endpoint and the last `set_sessions` stay, and the walk refuses each root that is gone.",
    "The event stream keeps no event for a later reader.",
    "At each connect the daemon reads `status`, which gives the state, the last stop with its reason and time, the open prompts and the update state, so the daemon still sees a `stopped` event that it missed.",
    "The next complete `set_sessions` is the truth again.",
  ]);
  assert.ok(says(part(C12, "The vectors."), "`test/vectors/control.json` holds lines of each kind"), "C12 names its vectors");
});

// ---- Stage 1a (board ab-v16.94.2): the expected command, the data of the reads, the ops of stage 1a, the command, the fake ----

test("C12 names the path and the format of the daemon's expected command (rule 3's file): agentwatch writes it, the service reads it at each accept", () => {
  assert.ok(says(part(C12, "Who connects"), "The part \"The daemon's expected command\", below, names the file's path and its format."), "rule 3 points to the part");
  sayAll(part(C12, "The daemon's expected command (rule 3's file; board ab-v16.94.2)."), [
    "agentwatch's daemon writes this file at its start, before it connects. The service reads it at each accept, so a new file takes effect at the next connection, with no restart of the service.",
    "The path: `$XDG_CONFIG_HOME/agent-browser/daemon-command.json`, or `~/.config/agent-browser/daemon-command.json` when `XDG_CONFIG_HOME` is not set, on Linux and on the Mac. agentwatch's unit passes `--daemon-command <file>` and `--daemon-unit <unit>` explicitly (the command, below): a systemd user unit's environment can lack the user's `XDG_CONFIG_HOME`.",
    "The format: one JSON object in UTF-8, `{\"v\":1,\"interpreter\":\"<path>\",\"args\":[\"<argument>\",...]}`. `v` is 1.",
    "`interpreter` is the absolute, resolved path (`realpath`) of the daemon's interpreter, because `/proc/<pid>/exe` resolves links: a path through a link never matches.",
    "`args` is the daemon's command line from argv[1] on, one string for each argument, in order. The daemon takes `args` from `/proc/self/cmdline`, not from Python's `sys.argv` (which drops the interpreter's flags; `-m` changes argv[0]). The service ignores a key that it does not know.",
    "When the interpreter is replaced on disk, `/proc/<pid>/exe` ends with ` (deleted)`: the door then refuses the daemon (rule 3) until the daemon restarts and writes the file again.",
    "The service opens it once, with no link followed (`O_NOFOLLOW`), and checks the open file (`fstat`), so the file that it checks is the file that it reads.",
    "The check: the target of the peer's `/proc/<pid>/exe` equals `interpreter`, and the peer's `/proc/<pid>/cmdline` from argv[1] on equals `args`, with the same count and each argument the same.",
    "The file is a regular file, not a link, owned by the service's user, and not writable by its group or by others (agentwatch writes it with mode 0600).",
    "A file that is missing, that breaks one of these rules, or whose content breaks the format fails rule 3 at each connection: the refused line names rule 3 and the reason.",
  ]);
  // The example in the text has the format: v 1, an absolute interpreter, args a list of strings, and no box path.
  const m = /`(\{"v":1,"interpreter":"\/[^`]+\})`/.exec(part(C12, "The daemon's expected command"));
  assert.ok(m, "an example of the file");
  const ex = JSON.parse(m![1]);
  assert.deepEqual(keysOf(ex), ["args", "interpreter", "v"]);
  assert.ok(ex.interpreter.startsWith("/") && strings(ex.args) && ex.args.length > 0);
  assert.ok(!/\/home\//.test(m![1]), "no box path in the example");
});

// The keys of the data of each read, from C12's table (stage 1a): a key with an object or a list of objects in braces names
// its inner keys too.
const READS: Record<string, string[]> = {
  status: ["agent_text", "chrome_kind", "chrome_pid", "chrome_version", "endpoint", "extension_version", "last_stop", "lists", "mcp", "operator_text", "prompts", "sessions", "state", "update"],
  lists_get: ["lists", "old_allow"],
  prompts_get: ["prompts"],
  endpoint: ["url"],
  sender: ["id", "package", "version"],
};
const PROMPT_KEYS = ["from", "host", "id", "list", "recipients", "repo", "scopes", "warnings"];
const LIST_KEYS = ["allow", "error", "name", "repo", "sessions"];

test("C12 fixes the keys of the data of the reads (D11): the agent's text and the operator's text as two keys, each prompt's recipients with the session name and the lifetime id, and a transport-neutral MCP state", () => {
  const rows = table(C12, "| Read | Its answer's `data` |");
  assert.deepEqual([...rows.keys()].sort(), Object.keys(READS).sort(), "the five reads");
  // The top-level keys of each row's shape, in the order of the text.
  const top = (shape: string) => [...shape.slice(1, -1).matchAll(/"([a-z_]+)"(:(\[\{[^\]]*\]|\{[^}]*\}))?/g)].map((x) => x[1]);
  for (const [op, [cell]] of rows) assert.deepEqual(top(spans(cell)[0]).sort(), READS[op], `${op}: its keys`);
  assert.equal(spans(rows.get("prompts_get")![0])[0], "{\"prompts\":[{\"id\",\"host\",\"list\",\"repo\",\"scopes\",\"from\",\"warnings\",\"recipients\":[{\"session\",\"lifetime_id\"}]}]}");
  assert.equal(spans(rows.get("lists_get")![0])[0], "{\"lists\":[{\"name\",\"repo\",\"allow\",\"sessions\",\"error\"}],\"old_allow\"}");
  assert.equal(spans(rows.get("sender")![0])[0], "{\"id\",\"version\",\"package\":{\"name\",\"sha256\",\"base64\"}}");
  sayAll(part(C12, "The data of the reads (stage 1a)."), [
    "`state` is `off`, `starting`, `ready` or `failed closed`. `agent_text` is the state's text for an agent, and `operator_text` is the state's text for the operator: two keys, so the gateway drops `operator_text` for a caller with no password login. No `agent_text` names a stop or a start (I2).",
    "`chrome_kind`, `chrome_version` and `chrome_pid` are Chrome's kind, version and pid, and `extension_version` is the agent extension's version. Each one is `null` while the service does not have that fact (no Chrome runs).",
    "`update` is Chrome's update state, as the `update` of the `chrome` event, or `null`: it is the update state of the requests' table and of a daemon's connect.",
    "`endpoint` is the endpoint's state, as in the `ready` event: `{\"form\":\"<form>\"}` or `{\"form\":null,\"reason\":\"<text>\"}`.",
    "`mcp` is the MCP's state, for `agentwatch health`: `{\"state\":\"<state>\",\"address\":<text or null>}`. `state` is `none` while the service has no MCP (before stage 1d), and then `address` is `null`. Stage 1d names the other states and fixes the form of `address`, an opaque text that the daemon shows as it is. This file fixes no transport of the MCP.",
    "`sessions` holds each session of the last `set_sessions`, as `{\"scope\",\"repo\",\"list\"}`: `list` is the name of the scope's list, or `null` while the scope has no list. `lists` holds the names of the lists that the service has.",
    "`last_stop` is `null`, or `{\"reason\",\"at\",\"by\"}`: the reason of the last `stopped` event, its time in UTC (ISO 8601, for example `2026-11-10T06:30:00Z`), and its `by` (`null` for a reason other than `stop`).",
    "Each prompt has its `id`, `host` and `list`, the list's `repo` (or `null`), the `scopes` that its blocks came from, its `from` host (or `null`), its `warnings`, and its `recipients`: the session name (`session`) and the lifetime id (`lifetime_id`) of each session that a block of the prompt stopped, from that session's `lifetime_id` in `set_sessions`. The daemon sends each recipient the allow notice. No log line holds a lifetime id.",
    "`lists_get`: each list with its `name`, its `repo` (or `null`), its entries (`allow`, as `list_set` names them), the scopes that use it (`sessions`), and its read error (`error`, `\"\"` when it has none); `old_allow` is the old single list, read only (`[]` when it cannot be read).",
    "`endpoint`: `url` is the endpoint's URL for the scope, as a client gives it to Playwright (C11).",
    "`sender`: `id` is the sender's extension ID, `version` its version, and `package` the sender package (C1): its file `name`, its `sha256` (64 hex digits) and its bytes in `base64`.",
  ]);
  // The status row of the requests' table keeps the MCP's state with no port number or URL form (the lead's transport rule).
  assert.ok(!/"port"|mcp_port|http:\/\/127/.test(part(C12, "The data of the reads")), "no MCP port or URL in the data's keys");
});

test("the read vectors (q1 to q5) have exactly the keys of C12's data, and status keeps the agent's and the operator's texts apart", () => {
  const reads = control.requests.filter((v: any) => Object.hasOwn(READS, v.req.op));
  assert.deepEqual(reads.map((v: any) => v.req.op).sort(), Object.keys(READS).sort(), "one vector for each read");
  for (const { note, req, res } of reads) {
    assert.ok(res.ok, note);
    assert.deepEqual(keysOf(res.data), READS[req.op], note);
  }
  const data = (op: string) => reads.find((v: any) => v.req.op === op).res.data;
  const status = data("status");
  assert.ok(["off", "starting", "ready", "failed closed"].includes(status.state));
  assert.ok(text1(status.agent_text) && text1(status.operator_text), "two texts");
  assert.doesNotMatch(status.agent_text, /\b(stop|start|restart)/i, "I2: the agent's text names no stop and no start");
  assert.deepEqual(status.mcp, { state: "none", address: null }, "the MCP's state before stage 1d (the only vector of mcp now)");
  assert.deepEqual(keysOf(status.endpoint), ["form"]);
  for (const s of status.sessions) assert.deepEqual(keysOf(s), ["list", "repo", "scope"]);
  assert.ok(strings(status.lists));
  assert.equal(status.last_stop, null);
  for (const p of [...status.prompts, ...data("prompts_get").prompts]) {
    assert.deepEqual(keysOf(p), PROMPT_KEYS);
    assert.ok(p.recipients.length > 0, "a prompt names its recipients");
    for (const r of p.recipients) assert.deepEqual(keysOf(r), ["lifetime_id", "session"]);
  }
  assert.deepEqual(status.prompts, data("prompts_get").prompts, "status gives the open prompts as prompts_get does");
  // Each recipient is a session of the snapshot, with its lifetime id from set_sessions (D11).
  const snap = control.requests.find((v: any) => v.req.op === "set_sessions").req.sessions;
  for (const p of status.prompts) for (const r of p.recipients) assert.ok(snap.some((s: any) => s.scope === r.session && s.lifetime_id === r.lifetime_id), `${p.id}: ${r.session}`);
  for (const l of data("lists_get").lists) assert.deepEqual(keysOf(l), LIST_KEYS);
  assert.ok(Array.isArray(data("lists_get").old_allow));
  const ep = reads.find((v: any) => v.req.op === "endpoint");
  assert.equal(ep.res.data.url, `ws+unix://${control.state.agent_door}:/devtools/browser/${ep.req.scope}`);
  const sender = data("sender");
  assert.match(sender.id, /^[a-p]{32}$/);
  assert.deepEqual(keysOf(sender.package), ["base64", "name", "sha256"]);
  assert.equal(createHash("sha256").update(Buffer.from(sender.package.base64, "base64")).digest("hex"), sender.package.sha256, "the package's sha256");
  // A set_sessions whose session has no lifetime_id is a bad request (b18).
  assert.ok(control.badRequests.some((v: any) => v.req.op === "set_sessions" && v.req.sessions.some((s: any) => !Object.hasOwn(s, "lifetime_id")) && v.res.error === "bad request"), "a session with no lifetime_id");
});

test("C12 states the ops of stage 1a: the five ops that it has, unsupported for each other op until its stage, and no Chrome, no list and no MCP", () => {
  sayAll(part(C12, "The ops of stage 1a."), [
    "Stage 1a's service (board ab-v16.94.2) has the ops `config`, `set_sessions`, `session_ended`, `status` and `endpoint`.",
    "It answers each other op of the requests' table `unsupported`, as the hello says for an op that a service does not have, until a later stage adds that op: `start` and `stop` come with the Chrome unit (stage 1b part 1, board ab-v16.94.3), and `sender` with the agent package (stage 1b part 2, board ab-v16.94.9); `launch_check`, `list_set`, `prompt_allow`, `prompt_dismiss`, `import`, `lists_get` and `prompts_get` come with the lists, the scopes, the prompts and the sign-ins (stage 1c, board ab-v16.94.4).",
    "These stages add no feature name: the daemon's client (stage 2) needs every op of stage 1, and stage 2 comes after stage 1.",
    "Stage 1a has no Chrome, no list and no MCP. `config` and `set_sessions` keep their data in memory. `session_ended` drops the scope's session and records the ended scope in memory.",
    "Its `status` gives the state `off`, `null` for each fact of Chrome and the extension, the `mcp` state `none`, no list and no prompt. Its event stream sends no event, because each event comes from Chrome or a later stage.",
    "`agent-browser service --fake` (below) has every op of the requests' table.",
  ]);
  // Each op of the requests' table is in stage 1a's list or in a later stage's list, once.
  const p = part(C12, "The ops of stage 1a.");
  const first = p.slice(0, p.indexOf("It answers"));
  const later = p.slice(p.indexOf("It answers"), p.indexOf("These stages"));
  const named = [...spans(first), ...spans(later)].filter((s) => Object.hasOwn(OPS, s));
  assert.deepEqual([...named].sort(), Object.keys(OPS).sort(), "every op once");
});

test("C12 states the ops of stage 1b part 1 (board ab-v16.94.3): start and stop, their answers after the work, the owner rule's error, the events of the Chrome unit, the values of Chrome's facts, and the command's new flags", () => {
  sayAll(part(C12, "The ops of stage 1b part 1 (board ab-v16.94.3)."), [
    "Stage 1b part 1 adds the Chrome unit to the service (the design, sections 5.1, 5.6 and 13.2) and the ops `start` and `stop`: the service no longer answers them `unsupported`. Each other op that stage 1a answers `unsupported` stays so until its stage.",
    "`start` starts Chrome and Xvfb and answers when they run, with `data` `{}`, or with the start's error text (for example a refused switch of `chrome_args`, or that Google Chrome is being installed into the tools folder). `stop` stops them and answers when they are gone, with `data` `{}`.",
    "A `start` or a `stop` while the service does not own the Chrome unit (the design, section 13.2) gets the error `the agent-browser service does not own the agent browser now`, and the service changes nothing.",
    "A `start` and a `stop` answer when their work ends, so their answer can come after the answer of a later request and after their events: the daemon matches each answer by its `id`. A daemon that half-closes the connection after a request still gets that answer; the service closes the connection after its last answer.",
    "`ready` comes when Chrome and Xvfb run after a `start`, a restart by the service's supervisor, an adoption at the service's start, or a Chrome move. Stage 1b part 1 has no native link and no agent package (stage 1b part 2), so `extension_version` is `null`, and with no receiver the fail-closed watch stops Chrome 60 s after the last confirm on it, with the `stopped` reason `receiver_missing`.",
    "`chrome` comes when the version or the update state of the running Chrome changes.",
    "`stopped` comes at a `stop` that stopped a running Chrome (with the stop's `by`), at a stop of the fail-closed watch (`receiver_missing` or `sessions_unread`), and once after three failed starts of the supervisor in a row (`start_failed`). A `config` with `enabled: false` stops Chrome with no event.",
    "`state` is `ready` while Chrome and Xvfb run; `starting` during a start, while the supervisor starts a wanted Chrome again, and while a wanted Chrome waits for the first `config`; `failed closed` after a stop of the fail-closed watch; else `off`.",
    "`chrome_kind` is `google-chrome` (Google Chrome stable from the tools folder, when `chrome_bin` is empty or `null`) or `chromium` (the Chromium of `chrome_bin`): the kinds of the unit record.",
    "`chrome_version` is the version of the tools folder's copy, in the form of Google's index (`a.b.c.d-r`, for example `157.0.7000.1-1`), or `null` when the service does not know it (a Chromium of `chrome_bin`). The `ready` and `chrome` events carry the same value.",
    "`update` is `null` while no Google Chrome of the tools folder runs; else `current`, `waiting` (a newer copy waits for the idle hour and for the clients to leave), `moving` (a move or the probation of its new copy runs), or `failed` (the last move failed, and the last good copy runs).",
  ]);
  sayAll(part(C12, "The command (stage 1b part 1)."), [
    "`agent-browser service` takes three more flags: `--browser-state <folder>`, the state folder of the agent browser (its profile, `unit.json` and the X auth file), by default today's folder `~/.local/share/agentwatch-browser/`; `--tools-dir <folder>`, the tools folder of Google Chrome, by default today's `~/.local/share/agentwatch-tools/`; and `--service-unit <unit>`, the service's own unit, whose state decides the owner (the design, section 13.2), by default `agent-browser.service`.",
    "The service owns the Chrome unit only while its own unit is `active`, `activating` or `deactivating` and the unit's MainPID is the service. When it does not own at its start, it closes its control door and exits with status 1. When it finds later that it no longer owns, it stops its owner parts and exits with status 1. Chrome and Xvfb stay, for the next owner.",
    "`agent-browser service stop --all [--browser-state <folder>]` stops the Chrome unit with no service running (the uninstall, and the Mac's open point 3 of the design's section 17): each Chrome on the profile and the unit's Xvfb, of this user only. It writes no file.",
    "`--test` serves the real service for the live harness only: the service owns with no systemd unit, the MainPID of rule 1 is the service's parent (the harness), and it needs `--test-display`. It is refused when a folder is missing or is a default folder. Its test-only `--test-chrome-source` names a local folder and a test key in place of Google's index. agentwatch never passes these flags.",
  ]);
  // The vectors use the values that this part fixes.
  assert.equal(control.state.chrome.kind, "google-chrome");
  assert.match(control.state.chrome.version, /^\d+(\.\d+){3}-\d+$/);
  for (const v of control.events.filter((e: any) => e.ev.ev === "ready")) assert.equal(v.ev.chrome_version, control.state.chrome.version);
  for (const v of control.events.filter((e: any) => e.ev.ev === "chrome")) assert.ok(["current", "waiting", "moving", "failed", null].includes(v.ev.update) && v.ev.version === control.state.chrome.version);
  assert.ok(["current", "waiting", "moving", "failed", null].includes(control.state.update));
});

test("C12 states the command of stage 1a and the fake service (the daemon lead's C10): the flags, the fake's admission, its own rules and its events from standard input", () => {
  sayAll(part(C12, "The command (stage 1a)."), [
    "agentwatch's unit runs `agent-browser service --agent-door <address> [--control-door <path>] [--daemon-unit <unit>] [--daemon-command <file>]`. Nothing starts it before stage 2, and no install step of this repository writes a unit for it.",
    "`--agent-door` (required): the agent door's address, which the daemon gives (today's endpoint path during the move: the design, section 13). In stage 1a it is the path of a Unix socket, and the agent door is today's endpoint with today's peer check (C11).",
    "`--control-door`: the path of `control.sock`. The default is `control.sock` in the run folder (the door, above).",
    "`--daemon-unit`: agentwatch's unit, whose MainPID rule 1 reads. The default is `agentwatch.service`.",
    "`--daemon-command`: the file of the daemon's expected command. The default is its path above.",
    "`--hello` prints the hello and exits (the hello, above). `--fake` serves the fake (below).",
    "The service runs until `SIGTERM` or `SIGINT`, and then it removes its sockets.",
  ]);
  sayAll(part(C12, "The fake service (`--fake`; the daemon lead's C10)."), [
    "`agent-browser service --fake --control-door <path>` serves the control door for agentwatch's hermetic tests, with the scripted state of the vectors (the `state` of `test/vectors/control.json`) and no Chrome. Its code is `src/service/fake.ts`.",
    "Its hello has `\"commit\":null` and the feature `fake`. It has every op of the requests' table, and it gives each request vector its answer when the vectors run in their order on one connection.",
    "It admits each connection that reaches its socket: the socket has mode 0600 in a folder of mode 0700, and the fake holds no list, no sign-in, no Chrome and no data of the user. It never listens in the service's run folder: the folder of the default `control.sock`, and on Linux also `/run/user/<uid>/agent-browser/` (the default when `XDG_RUNTIME_DIR` is not set). It compares the real folder of its socket (after links, before and after it makes the folder) with each of them, so it never takes the place of the service. With `--refuse`, each connection gets the refused line of rule 2 of the vectors, and the fake closes it.",
    "Its own rules where the vectors stop: it starts in the state `ready`. A `start` in the state `off` sends the vectors' first `ready` event, and a `stop` in the state `ready` sends `stopped` with the reason `stop` and the stop's `by`. An allow or a dismissal closes the prompt, with a `prompt` event in the state `closed`. `session_ended` holds the ended scope until the next `set_sessions`. `endpoint` gives the URL of the address of `--agent-door` (no agent door listens), else of the vectors' address.",
    "Each line on its standard input that is an event of the event table, with exactly its fields, goes to each connection that has sent its hello. The fake drops each other line. So a test sends the events that it needs.",
    "After its socket listens, the fake prints one line on its standard output, `{\"t\":\"listening\"}`, so that a test waits for that line.",
  ]);
  assert.ok(says(part(C12, "The vectors."), "Its `state` is the service's state for these lines and the fake's state at its start; the reads (`q1` to `q5`) give the keys of the data of the reads. Its `badLines` are lines as bytes (in hex) that close the connection: a byte order mark, a CR, and bytes that are not UTF-8."));
  // The vectors' state holds the prompts of the reference (id, host, list) and the fake's other facts.
  for (const p of control.state.prompts) assert.deepEqual(keysOf(p), PROMPT_KEYS, p.id);
  assert.equal(control.state.state, "ready", "the fake starts ready");
  assert.deepEqual(control.state.mcp, { state: "none", address: null });
});

test("C12 states the recipients' lifetime ids (B4): the run that the block stopped, a new run with a new set_sessions, null passes through, and no feature name for lifetime_id", () => {
  sayAll(part(C12, "The data of the reads (stage 1a)."), [
    "A recipient's `lifetime_id` is the one of the run that the block stopped: the session's `lifetime_id` in the `set_sessions` in force when the block happened, not a later one. A new run of a session comes with a new `set_sessions` that carries its new `lifetime_id`. A session whose `lifetime_id` is `null` is still a recipient, with `\"lifetime_id\":null`.",
  ]);
  sayAll(part(C12, "The ops of stage 1a."), [
    "The field `lifetime_id` of `set_sessions` (stage 1a) comes with no feature name either, although the hello says that a stage that adds a field adds its feature name first: the daemon's client (stage 2) comes after stage 1, so no daemon talks to a service without it.",
  ]);
  // A vector of a recipient whose lifetime id is null: its session has null in set_sessions.
  const snap = control.requests.find((v: any) => v.req.op === "set_sessions").req.sessions;
  const nulls = control.state.prompts.flatMap((p: any) => p.recipients).filter((r: any) => r.lifetime_id === null);
  assert.ok(nulls.length > 0, "a recipient with a null lifetime id");
  for (const r of nulls) assert.ok(snap.some((s: any) => s.scope === r.session && s.lifetime_id === null), r.session);
  assert.ok(!/MCP port/.test(C12), "no MCP port in C12 (B3)");
});

test("the line rules' vectors (badLines, B1): a byte order mark, a CR and bytes that are not UTF-8 each close the connection, by the reference of C12's line rules", () => {
  assert.ok(Array.isArray(control.badLines) && control.badLines.length >= 3);
  for (const v of control.badLines) {
    const bytes = Buffer.from(v.hex, "hex");
    assert.equal(lineCloses(bytes), v.closes, v.note);
    assert.equal(v.closes, true, v.note);
  }
  const lines = control.badLines.map((v: any) => Buffer.from(v.hex, "hex"));
  assert.ok(lines.some((b: Buffer) => b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf), "a BOM line");
  assert.ok(lines.some((b: Buffer) => b.includes(13)), "a CR LF line");
  assert.ok(lines.some((b: Buffer) => b.includes(Buffer.from([0xed, 0xa0, 0x80]))), "a lone surrogate's bytes");
  // Without its BOM, its CR or its bad bytes each line is a good request: only the rule closes it.
  const req = Buffer.from(JSON.stringify(control.requests.find((v: any) => v.req.op === "status").req) + "\n");
  assert.equal(lineCloses(req), false);
});

// ---- The MCP's allow list: the reference of the format ----

const NEVER = ["core-install", "storage", "devtools", "testing", "config"];
const UNSAFE = "browser_run_code_unsafe";
// A property that names a file or a path: a string (or a list of strings) whose name or description says so.
const speaksOfFile = (k: string, p: any) => isObj(p) && (p.type === "string" || (p.type === "array" && p.items?.type === "string")) && /file|path|folder|directory/i.test(`${k} ${p.description ?? ""}`);
function brokenRules(list: any, pinned: { name: string; inputSchema: any }[], pin: string) {
  const out = new Set<string>();
  if (list.package !== "@playwright/mcp" || list.version !== pin) out.add("version is the pin");
  if (list.capabilities.some((c: string) => NEVER.includes(c))) out.add("no core-install, storage, devtools, testing or config");
  const names = pinned.map((t) => t.name);
  for (const n of names) if (Object.hasOwn(list.tools, n) === Object.hasOwn(list.refused, n)) out.add("each tool in tools or refused, once");
  for (const n of [...Object.keys(list.tools), ...Object.keys(list.refused)]) if (!names.includes(n)) out.add("each tool in tools or refused, once");
  if (!Object.hasOwn(list.refused, UNSAFE) || Object.hasOwn(list.tools, UNSAFE)) out.add("browser_run_code_unsafe in refused");
  for (const [n, r] of Object.entries<any>(list.tools)) {
    const p = pinned.find((t) => t.name === n);
    if (p && JSON.stringify(r.schema) !== JSON.stringify(p.inputSchema)) out.add("each schema equals the pinned schema");
    const props = r.schema?.properties ?? {};
    if (r.keys.some((k: string) => !Object.hasOwn(props, k))) out.add("keys are properties of the schema");
    if (r.paths.some((k: string) => !r.keys.includes(k))) out.add("paths are keys");
    for (const k of r.keys) if (speaksOfFile(k, props[k]) && !r.paths.includes(k)) out.add("a file or path key is in paths");
  }
  return [...out].sort();
}
function callAnswer(list: any, call: { name: string; arguments: Record<string, unknown> }, folder: string, realpath: Record<string, string> = {}) {
  const r = Object.hasOwn(list.tools, call.name) ? list.tools[call.name] : null;
  if (!r) return { code: -32601, message: `Not available in the agent browser: ${call.name}` };
  for (const k of Object.keys(call.arguments ?? {})) if (!r.keys.includes(k)) return { code: -32602, message: `Not available in the agent browser: the argument ${k} of ${call.name}` };
  for (const k of r.paths) {
    if (!Object.hasOwn(call.arguments, k)) continue;
    for (const p of ([] as unknown[]).concat(call.arguments[k])) {
      if (!String(realpath[String(p)] ?? "").startsWith(folder)) return { code: -32602, message: `Not available in the agent browser: ${k} must name a file in the session's folder ${folder}` };
    }
  }
  return "pass";
}

test("the allow list's format: the master file, why, the file's fields, what the service does and the test of stage 1d", () => {
  assert.ok(ALLOW.startsWith("# The MCP's allow list (a part of C11)\n"), "the heading");
  for (const s of [
    "This file is the master for the format of the MCP's allow list. It is a part of C11 (`docs/contracts/C11.md`, the MCP inside the service).",
    "Its source is the design `docs/superpowers/specs/2026-11-09-self-contained-agent-browser-design.md`, section 8.2, and the operator's answer Q4 of 2026-11-10 (the standard Playwright MCP, pinned, under the allow list; the design's section 19).",
    "Stage 1d (board ab-v16.94.5) writes the first list for the pinned version of `@playwright/mcp`, and its test.",
    "Stage 1d's first list holds the 24 tools of M3's part C (the self-contained design, section 8.2), and no `browser_run_code_unsafe`. Stage 0 adds no package. The vectors of the format: `test/vectors/mcp-allow-list.json`.",
    "each tool of the pinned version's `tools/list` is in `tools` or in `refused`, once;",
    "`browser_run_code_unsafe` is in `refused`;",
    "The service serves only the tools and the argument keys that the list names, not every tool except some. So a new tool or a new argument in a newer `@playwright/mcp` reaches no client until a review adds it to the list.",
    "One JSON file for the one pinned version of `@playwright/mcp`, in this repository.",
    "`package` is `@playwright/mcp`. `version` is the exact pinned version, the same as the pin in `package.json`.",
    "`capabilities` names the MCP's capabilities that the service turns on, explicitly: the ones that give the tools of `tools`. It never names `core-install`, `storage`, `devtools`, `testing` or `config`.",
    "`tools` maps each allowed tool to its rule. `keys` lists each argument key that the service passes. `paths` lists each key of `keys` that names a file or a path. `schema` is the tool's input schema in the pinned version's `tools/list`, as it is.",
    "`refused` maps each other tool of the pinned version's `tools/list` to the reason why the service never serves it.",
    "`browser_run_code_unsafe` is always in `refused`: it runs a client's JavaScript in the MCP server's process, which inside the service holds the lists, the native link and the control door's state.",
    "Each tool of the pinned version's `tools/list` is in `tools` or in `refused`, and in only one of them.",
    "`tools/list`: the service drops each tool that `tools` does not name.",
    "`tools/call` of a tool that `tools` does not name: the service refuses it before the call reaches the MCP's code, with the JSON-RPC error `-32601` and the message `Not available in the agent browser: <tool>`.",
    "`tools/call` with an argument key that the tool's `keys` does not name: the service refuses it before the call reaches the MCP's code, with the JSON-RPC error `-32602` and the message `Not available in the agent browser: the argument <key> of <tool>`.",
    "An argument whose key is in the tool's `paths`: the service refuses it when the path is outside the scope's folder, `<state>/mcp/<scope>/`, after `realpath` (C11), with the JSON-RPC error `-32602` and the message `Not available in the agent browser: <key> must name a file in the session's folder <folder>`.",
    "The MCP answers `initialize` and `tools/list` with no CDP connection (the design, section 18), so the test needs no Chrome. It fails when any of these is false:",
    "each `schema` equals that tool's input schema in the pinned version, so any change of a tool fails the test, and each bump of the pin needs a new review of the list;",
    "each key of `keys` is a property of its tool's `schema`, and each key of `paths` is a key of `keys`;",
    "each string property whose schema speaks of a file or a path (its name or its description) is in `paths`, or is left out of `keys`;",
    "`capabilities` names none of `core-install`, `storage`, `devtools`, `testing` and `config`.",
  ]) assert.ok(says(ALLOW, s), `the allow list's format says: ${s}`);
  // The file's example shape in the text is the vector's list shape.
  const m = /```json\s*(\{.*?\})\s*```/s.exec(ALLOW);
  assert.ok(m, "the text shows the file's fields");
  assert.deepEqual(keysOf(JSON.parse(m![1])), keysOf(allowV.list), "the same fields as the example list");
});

test("each allow list vector follows the format: the example breaks no rule, each bad list breaks exactly its rule, each call gets the format's answer", () => {
  assert.deepEqual(brokenRules(allowV.list, allowV.pinnedTools, allowV.pin), [], "the example list");
  assert.ok(Object.hasOwn(allowV.list.refused, UNSAFE));
  const rules = new Set<string>();
  for (const b of allowV.badLists) {
    assert.deepEqual(brokenRules(b.list, allowV.pinnedTools, allowV.pin), [b.breaks], b.note);
    rules.add(b.breaks);
  }
  assert.equal(rules.size, 8, "each rule of the format's test has a bad list (the rule \"once\" has two: a tool in neither and a tool in both)");
  const answers = new Set<string>();
  for (const c of allowV.calls) {
    assert.deepEqual(callAnswer(allowV.list, c.call, allowV.folder, c.realpath), c.answer, c.note);
    answers.add(c.answer === "pass" ? "pass" : String(c.answer.code));
  }
  assert.deepEqual([...answers].sort(), ["-32601", "-32602", "pass"]);
  assert.ok(allowV.calls.some((c: any) => c.call.name === UNSAFE && c.answer.code === -32601), "the unsafe tool is refused");
  assert.ok(allowV.calls.some((c: any) => c.realpath && Object.entries(c.realpath).some(([a, b]) => a.startsWith(allowV.folder) && !String(b).startsWith(allowV.folder)) && c.answer !== "pass"), "a link that leaves the folder");
  assert.ok(allowV.calls.some((c: any) => c.realpath && Object.values(c.realpath).some((b) => String(b).startsWith(allowV.folder.slice(0, -1)) && !String(b).startsWith(allowV.folder)) && c.answer !== "pass"), "a folder with the same start");
});
